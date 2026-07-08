// Writes a manual arrival/departure correction into attendance_daily.
//
// This intentionally duplicates the write logic used by the existing
// POST /attendance/correct route (routes/attendance.js) instead of importing
// from it, so the already-shipped HR endpoint is never touched by this new
// feature. Keep the two in sync if the attendance_daily schema changes.

let manualCorrectionColumnsEnsured = false;

async function ensureManualCorrectionColumns(db) {
    if (manualCorrectionColumnsEnsured) return;
    await db.query(`
        ALTER TABLE public.attendance_daily
            ADD COLUMN IF NOT EXISTS manually_corrected BOOLEAN NOT NULL DEFAULT false,
            ADD COLUMN IF NOT EXISTS correction_comment TEXT,
            ADD COLUMN IF NOT EXISTS corrected_at TIMESTAMPTZ,
            ADD COLUMN IF NOT EXISTS corrected_by TEXT
    `);
    manualCorrectionColumnsEnsured = true;
}

function toMinutesFromTime(value) {
    if (!value) return null;
    const match = String(value).match(/^(\d{1,2}):(\d{2})/);
    if (!match) return null;
    return parseInt(match[1], 10) * 60 + parseInt(match[2], 10);
}

function formatTimeHHMM(value) {
    if (!value) return null;
    return String(value).slice(0, 5);
}

function isLate(arrivalTime) {
    const minutes = toMinutesFromTime(arrivalTime);
    if (minutes === null) return false;
    return minutes > 8 * 60 + 5; // 08:05 cutoff, matches routes/attendance.js
}

/**
 * @param {import('pg').Pool} pool
 * @param {{uid: number, matricule: string, pointeuseUserId: string|null, fullName: string, cardNo: string|null,
 *          date: string, arrivalTime: string|null, departureTime: string|null, comment: string|null, correctedBy: string}} params
 */
async function applyManualCorrection(pool, {
    uid, matricule, pointeuseUserId, fullName, cardNo,
    date, arrivalTime, departureTime, comment, correctedBy,
}) {
    const client = await pool.connect();
    try {
        await ensureManualCorrectionColumns(client);

        const existingRes = await client.query(`
            SELECT arrival_time, departure_time
            FROM public.attendance_daily
            WHERE uid = $1 AND work_date = $2
        `, [uid, date]);
        const existing = existingRes.rows[0] || {};

        const finalArrival = arrivalTime || formatTimeHHMM(existing.arrival_time);
        const finalDeparture = departureTime || formatTimeHHMM(existing.departure_time);
        if (!finalArrival && !finalDeparture) {
            throw new Error('At least one of arrivalTime/departureTime is required');
        }

        const entries = [];
        const [year, month, day] = String(date).split('-').map(Number);
        const dayName = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'][new Date(year, month - 1, day).getDay()];

        if (finalArrival) {
            const [h, m] = finalArrival.split(':').map(Number);
            entries.push({ timestamp: `${date}T${finalArrival}:00+01:00`, time: finalArrival, hour: h, minute: m, originalType: 0, type: 0, typeLabel: 'Arrivée', manual: true });
        }
        if (finalDeparture) {
            const [h, m] = finalDeparture.split(':').map(Number);
            entries.push({ timestamp: `${date}T${finalDeparture}:00+01:00`, time: finalDeparture, hour: h, minute: m, originalType: 1, type: 1, typeLabel: 'Départ', manual: true });
        }
        entries.sort((a, b) => (a.hour * 60 + a.minute) - (b.hour * 60 + b.minute));
        if (entries[0]) { entries[0].type = 0; entries[0].typeLabel = 'Arrivée'; }
        if (entries.length > 1) { entries[entries.length - 1].type = 1; entries[entries.length - 1].typeLabel = 'Départ'; }

        let hoursWorked = '0.00';
        let status = 'Absent';
        if (finalArrival && finalDeparture) {
            let totalMinutes = toMinutesFromTime(finalDeparture) - toMinutesFromTime(finalArrival);
            if (totalMinutes > 240) totalMinutes -= 60;
            totalMinutes = Math.max(0, totalMinutes);
            hoursWorked = (totalMinutes / 60).toFixed(2);
            status = isLate(finalArrival) ? 'En retard' : "À l'heure";
        } else if (finalArrival && !finalDeparture) {
            status = 'Présent (départ manquant)';
        } else if (!finalArrival && finalDeparture) {
            status = 'Arrivée manquante';
        }

        const { rows } = await client.query(`
            INSERT INTO public.attendance_daily
                (uid, user_id, pointeuse_user_id, full_name, card_no, work_date, day_name,
                 arrival_time, departure_time, hours_worked, status, entries, log_user_id, last_update,
                 manually_corrected, correction_comment, corrected_at, corrected_by)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,now(),true,$14,now(),$15)
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
                last_update = now(),
                manually_corrected = true,
                correction_comment = EXCLUDED.correction_comment,
                corrected_at = now(),
                corrected_by = EXCLUDED.corrected_by
            RETURNING uid, work_date::text AS date, status, hours_worked::text AS "hoursWorked"
        `, [
            uid,
            String(matricule || ''),
            pointeuseUserId ? String(pointeuseUserId) : null,
            fullName,
            cardNo,
            date,
            dayName,
            finalArrival,
            finalDeparture,
            hoursWorked,
            status,
            JSON.stringify(entries),
            pointeuseUserId ? String(pointeuseUserId) : String(uid),
            comment || null,
            correctedBy || 'missing-point-workflow',
        ]);

        return rows[0];
    } finally {
        client.release();
    }
}

module.exports = { applyManualCorrection };
