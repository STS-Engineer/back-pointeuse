require('dotenv').config();
const moment = require('moment-timezone');
const ZktecoService = require('./zkteco-service');
const { Pool } = require('pg');

const TZ = 'Africa/Tunis';

// ── DB pool ─────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.ATTENDANCE_DB_URL,
  ssl: { rejectUnauthorized: false },
});

// ✅ FIX (threshold unification): single constant used everywhere.
// Previously sync.js used hardcoded 8*60 / 9*60 bands to assign status,
// while report.js used 8*60+30. Now both files agree on 8:30.
const LATE_THRESHOLD_MINUTES = 8 * 60 + 30; // 08:30

function toDateKey(d) {
  return moment(d).tz(TZ).format('YYYY-MM-DD');
}

function toTimeHHMM(d) {
  return moment(d).tz(TZ).format('HH:mm');
}

function normalizeExistingEntries(entries) {
  if (!entries) return [];
  if (Array.isArray(entries)) return entries;
  try {
    return typeof entries === 'string' ? JSON.parse(entries) : [];
  } catch {
    return [];
  }
}

// ✅ FIX (threshold unification): determine status using LATE_THRESHOLD_MINUTES (08:30)
// instead of the old hardcoded < 8*60 / <= 9*60 bands.
// Rules:
//   arrival < 08:30  → "À l'heure"
//   arrival = 08:30  → "À l'heure"  (exactly on time is not late)
//   arrival > 08:30  → "En retard"
// (The "Présent" band that existed between 08:00 and 09:00 is removed;
//  it was inconsistent with report.js which only distinguishes on-time vs late.)
function computeArrivalStatus(arrivalMinutes, isToday, hasDeparture) {
  if (isToday && !hasDeparture) return 'En cours';
  if (arrivalMinutes <= LATE_THRESHOLD_MINUTES) return "À l'heure";
  return 'En retard';
}

function scoreDailyRecord(r) {
  let score = 0;
  if (r.arrivalTime) score += 10;
  if (r.departureTime) score += 20;
  const hours = parseFloat(r.hoursWorked || '0');
  if (hours > 0) score += Math.min(hours, 12);
  if (Array.isArray(r.entries)) score += r.entries.length * 2;
  if (r.status === "À l'heure") score += 5;
  if (r.status === 'Présent') score += 5;   // keep for backwards-compat with old rows
  if (r.status === 'En retard') score += 4;
  if (r.status === 'En cours') score += 1;
  return score;
}

function shouldReplaceDaily(existing, incoming) {
  const oldEntries = normalizeExistingEntries(existing.entries);
  const newEntries = Array.isArray(incoming.entries) ? incoming.entries : [];
  if (existing.departure_time && !incoming.departureTime) return false;
  if (oldEntries.length > newEntries.length) return false;
  const oldRecord = {
    arrivalTime: existing.arrival_time,
    departureTime: existing.departure_time,
    hoursWorked: existing.hours_worked,
    status: existing.status,
    entries: oldEntries,
  };
  return scoreDailyRecord(incoming) > scoreDailyRecord(oldRecord);
}

async function ensureManualCorrectionColumns(client) {
  await client.query(`
    ALTER TABLE attendance_daily
      ADD COLUMN IF NOT EXISTS manually_corrected BOOLEAN NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS correction_comment TEXT,
      ADD COLUMN IF NOT EXISTS corrected_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS corrected_by TEXT
  `);
}

async function insertRawLogs(rawLogs) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const sql = `
      INSERT INTO attendance_logs_raw (uid, userid, pointeuse_user_id, ts, state, verify_type, raw_log)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (uid, ts, verify_type) DO NOTHING
    `;
    let inserted = 0;
    for (const l of rawLogs) {
      // NOTE: the -1h offset below compensates for the Azure VM clock being 1 hour
      // ahead of Africa/Tunis local time. If the VM timezone is ever corrected,
      // remove this offset and re-verify punch times in the dashboard before deploying.
      const res = await client.query(sql, [
        String(l.uid),
        String(l.userid),
        l.pointeuseUserId ? String(l.pointeuseUserId) : null,
        new Date(new Date(l.timestamp).getTime() - 60 * 60 * 1000),
        l.state ?? 0,
        l.type ?? 0,
        l.rawLog ? l.rawLog : null,
      ]);
      inserted += res.rowCount || 0;
    }
    await client.query('COMMIT');
    return { inserted, attempted: rawLogs.length };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function recomputeDailyFromRaw(daysBack = 21) {
  const client = await pool.connect();
  try {
    await ensureManualCorrectionColumns(client);

    const since = new Date();
    since.setDate(since.getDate() - daysBack);

    const { rows } = await client.query(
      `SELECT uid, ts, verify_type FROM attendance_logs_raw WHERE ts >= $1 ORDER BY ts ASC`,
      [since]
    );

    const empRes = await client.query(
      `SELECT uid, matricule, pointeuse_user_id, full_name, card_no FROM employees`
    );
    const byPointeuse = new Map();
    const byMatricule = new Map();
    const byUid = new Map();
    for (const e of empRes.rows) {
      byPointeuse.set(String(e.pointeuse_user_id), e);
      byMatricule.set(String(e.matricule), e);
      byUid.set(String(e.uid), e);
    }

    const groups = new Map();
    for (const r of rows) {
      const logUserId = String(r.uid);
      const emp = byPointeuse.get(logUserId) || byMatricule.get(logUserId) || byUid.get(logUserId);
      if (!emp) continue;

      const dateKey = toDateKey(r.ts);
      const key = `${emp.uid}-${dateKey}`;
      if (!groups.has(key)) {
        groups.set(key, {
          uid: emp.uid,
          userId: String(emp.matricule),
          pointeuseUserId: String(emp.pointeuse_user_id),
          fullName: emp.full_name,
          cardNo: emp.card_no,
          date: dateKey,
          entries: [],
        });
      }
      const g = groups.get(key);
      const dt = moment(r.ts).tz(TZ);
      g.entries.push({
        timestamp: dt.toISOString(),
        time: toTimeHHMM(r.ts),
        hour: dt.hour(),
        minute: dt.minute(),
        originalType: r.verify_type,
        type: r.verify_type,
      });
    }

    const dayNames = ['Dimanche','Lundi','Mardi','Mercredi','Jeudi','Vendredi','Samedi'];
    const dailyRecords = [];
    const todayStr = moment().tz(TZ).format('YYYY-MM-DD');

    for (const g of groups.values()) {
      g.entries.sort((a, b) => a.hour !== b.hour ? a.hour - b.hour : a.minute - b.minute);

      const record = {
        uid: g.uid,
        userId: g.userId,
        pointeuseUserId: g.pointeuseUserId,
        name: g.fullName,
        cardNo: g.cardNo,
        workDate: g.date,
        dayName: dayNames[new Date(g.date).getDay()],
        arrivalTime: null,
        departureTime: null,
        hoursWorked: '0.00',
        status: 'Absent',
        entries: [],
        logUserId: g.pointeuseUserId,
      };

      if (g.entries.length > 0) {
        const first = g.entries[0];
        record.arrivalTime = first.time;
        first.type = 0;
        first.typeLabel = 'Arrivée';

        const arrivalMinutes = first.hour * 60 + first.minute;
        const isToday = g.date === todayStr;
        const hasDeparture = g.entries.length > 1;

        // ✅ FIX (threshold unification): use shared helper instead of hardcoded bands
        record.status = computeArrivalStatus(arrivalMinutes, isToday, hasDeparture);

        if (hasDeparture) {
          const last = g.entries[g.entries.length - 1];
          record.departureTime = last.time;
          last.type = 1;
          last.typeLabel = 'Départ';
          for (let i = 1; i < g.entries.length - 1; i++) {
            g.entries[i].type = 2;
            g.entries[i].typeLabel = 'Passage';
          }

          // Hours worked: arrival → departure minus 1h lunch if span > 4h.
          // Note: this is the simplified hours calculation used when writing to
          // attendance_daily. The /api/report endpoint recomputes hours more
          // accurately using computePhysicalPresentMinutes() (which uses all
          // punches as alternating in/out pairs). The value stored here is used
          // by the dashboard display; payslip generation should use /api/report.
          const [ah, am] = record.arrivalTime.split(':').map(Number);
          const [dh, dm] = record.departureTime.split(':').map(Number);
          let totalMinutes = (dh * 60 + dm) - (ah * 60 + am);
          if (totalMinutes > 240) totalMinutes -= 60;
          totalMinutes = Math.max(0, totalMinutes);
          record.hoursWorked = (totalMinutes / 60).toFixed(2);
        } else {
          record.hoursWorked = '0.00';
        }
      }

      record.entries = g.entries;
      dailyRecords.push(record);
    }

    await client.query('BEGIN');
    const upsert = `
      INSERT INTO attendance_daily
        (uid, user_id, pointeuse_user_id, full_name, card_no, work_date, day_name,
         arrival_time, departure_time, hours_worked, status, entries, log_user_id, last_update)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now())
      ON CONFLICT (uid, work_date) DO UPDATE SET
        user_id = EXCLUDED.user_id,
        pointeuse_user_id = EXCLUDED.pointeuse_user_id,
        full_name = EXCLUDED.full_name,
        card_no = EXCLUDED.card_no,
        day_name = EXCLUDED.day_name,
        arrival_time = EXCLUDED.arrival_time,
        departure_time = EXCLUDED.departure_time,
        hours_worked = EXCLUDED.hours_worked,
        status = EXCLUDED.status,
        entries = EXCLUDED.entries,
        log_user_id = EXCLUDED.log_user_id,
        last_update = now()
    `;

    let dailyWritten = 0;
    let dailySkippedAsWorse = 0;

    for (const r of dailyRecords) {
      const existingRes = await client.query(
        `SELECT arrival_time, departure_time, hours_worked, status, entries, COALESCE(manually_corrected, false) AS manually_corrected
         FROM attendance_daily WHERE uid = $1 AND work_date = $2`,
        [r.uid, r.workDate]
      );
      if (existingRes.rows.length > 0 && existingRes.rows[0].manually_corrected) {
        dailySkippedAsWorse++;
        continue;
      }
      if (existingRes.rows.length > 0 && !shouldReplaceDaily(existingRes.rows[0], r)) {
        dailySkippedAsWorse++;
        continue;
      }
      await client.query(upsert, [
        r.uid, r.userId, r.pointeuseUserId, r.name, r.cardNo,
        r.workDate, r.dayName, r.arrivalTime, r.departureTime,
        r.hoursWorked, r.status, JSON.stringify(r.entries), r.logUserId,
      ]);
      dailyWritten++;
    }

    await client.query('COMMIT');
    return { daysBack, dailyComputed: dailyRecords.length, dailyWritten, dailySkippedAsWorse };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function runOnce() {
  const zktecoService = new ZktecoService(
    process.env.ZK_IP,
    Number(process.env.ZK_PORT || 4370),
    Number(process.env.ZK_TIMEOUT || 5200),
    Number(process.env.ZK_INPORT || 5000),
  );

  console.log('🔌 Fetching from ZKTeco machine...');
  await zktecoService.initialize();
  await zktecoService.fetchAllData();

  const logs = zktecoService.getAttendanceLogs();
  console.log(`📥 Raw logs fetched: ${logs.length}`);

  const inserted = await insertRawLogs(logs);
  console.log('✅ Raw logs inserted:', inserted);

  const recomputeDays = Number(process.env.RECOMPUTE_DAYS || 7);
  const daily = await recomputeDailyFromRaw(recomputeDays);
  console.log('✅ Daily recomputed:', daily);

  if (zktecoService.disconnect) await zktecoService.disconnect();
}

module.exports = { runOnce };
