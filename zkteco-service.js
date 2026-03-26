const Zkteco = require('zkteco-js');
const moment = require('moment-timezone');

function toDateKey(d) {
    return new Date(d).toISOString().split('T')[0];
}

function toTimeHHMM(d) {
    const dt = new Date(d);
    return `${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;
}

class ZktecoService {
    constructor(ip = '10.10.205.10', port = 4370, timeout = 5200, inport = 5000) {
        this.ip = ip;
        this.port = port;
        this.timeout = timeout;
        this.inport = inport;
        this.device = null;
        this.isConnected = false;
        this.isSyncing = false;
        this.lastSyncAt = null;
        this.lastSyncSuccess = false;
        console.log(`🚀 ZktecoService initialized — device: ${this.ip}:${this.port}`);
    }

    // ── Connect to device ─────────────────────────────────────
    async connect() {
        try {
            console.log(`🔌 Connecting to ZKTeco at ${this.ip}:${this.port}...`);
            this.device = new Zkteco(this.ip, this.port, this.timeout, this.inport);
            await this.device.createSocket();
            this.isConnected = true;
            console.log('✅ Connected to ZKTeco device');
            return true;
        } catch (error) {
            this.isConnected = false;
            this.device = null;
            throw error;
        }
    }

    // ── Disconnect from device ────────────────────────────────
    async disconnect() {
        if (this.device) {
            try {
                await this.device.disconnect();
            } catch (e) {
                // ignore disconnect errors
            }
        }
        this.isConnected = false;
        this.device = null;
        console.log('🔌 Disconnected from ZKTeco device');
    }

    // ── Load active employees from HR DB ─────────────────────
    async loadEmployeesFromHRDB() {
        console.log('👥 Loading active employees from HR DB...');
        const { rows } = await global.hrPool.query(`
            SELECT id, matricule, nom, prenom
            FROM public.employees
            WHERE statut = 'actif'
            ORDER BY id ASC
        `);

        const employees = rows.map(row => ({
            uid: row.id,
            name: `${row.prenom} ${row.nom}`.trim(),
            matricule: String(row.matricule),
            pointeuseUserId: `400${String(row.matricule).padStart(2, '0')}`,
        }));

        console.log(`✅ ${employees.length} active employees loaded from HR DB`);
        return employees;
    }

    // ── Sync employees to Attendance DB ──────────────────────
    async syncEmployeesToAttendanceDB(employees) {
        const client = await global.attendancePool.connect();
        try {
            await client.query('BEGIN');
            for (const emp of employees) {
                await client.query(`
                    INSERT INTO public.employees
                        (uid, matricule, pointeuse_user_id, full_name, card_no, updated_at)
                    VALUES ($1, $2, $3, $4, $5, NOW())
                    ON CONFLICT (uid) DO UPDATE SET
                        matricule         = EXCLUDED.matricule,
                        pointeuse_user_id = EXCLUDED.pointeuse_user_id,
                        full_name         = EXCLUDED.full_name,
                        updated_at        = NOW()
                `, [
                    emp.uid,
                    emp.matricule,
                    emp.pointeuseUserId,
                    emp.name,
                    `EMP${String(emp.matricule).padStart(3, '0')}`,
                ]);
            }
            await client.query('COMMIT');
            console.log(`✅ ${employees.length} employees synced to Attendance DB`);
        } catch (e) {
            await client.query('ROLLBACK');
            throw e;
        } finally {
            client.release();
        }
    }

    // ── Parse raw logs from device ────────────────────────────
    parseRawLogs(rawLogs) {
        return rawLogs.map(log => {
            let logTime;
            const recordTime = log.record_time || log.timestamp;
            try {
                if (recordTime) {
                    if (typeof recordTime === 'string') {
                        const formats = [
                            'ddd MMM DD YYYY HH:mm:ss [GMT]ZZ',
                            'YYYY-MM-DD HH:mm:ss',
                            'DD/MM/YYYY HH:mm:ss',
                            'MM/DD/YYYY HH:mm:ss',
                        ];
                        let parsedDate = null;
                        for (const format of formats) {
                            parsedDate = moment.tz(recordTime, format, 'Africa/Tunis');
                            if (parsedDate.isValid()) break;
                        }
                        logTime = parsedDate?.isValid() ? parsedDate.toDate() : new Date(recordTime);
                    } else if (typeof recordTime === 'number') {
                        logTime = new Date(recordTime * 1000);
                    } else if (recordTime instanceof Date) {
                        logTime = recordTime;
                    }
                }
                if (!logTime || isNaN(logTime.getTime())) logTime = new Date();
            } catch (e) {
                logTime = new Date();
            }

            // Extract user ID from log
            const possibleFields = ['enrollNumber', 'PIN', 'user_id', 'userId', 'userid', 'uid'];
            let userId = '0';
            for (const field of possibleFields) {
                if (log[field] !== undefined && log[field] !== null && log[field] !== '') {
                    userId = log[field].toString().trim();
                    break;
                }
            }

            let state = log.state || 0;
            if (state === 4) state = 1;

            return {
                uid: userId,
                userid: userId,
                pointeuseUserId: log.user_id || log.userId || log.userid || '0',
                timestamp: logTime,
                state,
                type: log.verify_type || log.type || 0,
                rawLog: log,
            };
        }).filter(log => log.timestamp && !isNaN(log.timestamp.getTime()));
    }

    // ── Save raw logs to DB ───────────────────────────────────
    async insertRawLogs(parsedLogs) {
        const client = await global.attendancePool.connect();
        let inserted = 0;
        try {
            await client.query('BEGIN');
            for (const l of parsedLogs) {
                const result = await client.query(`
                    INSERT INTO public.attendance_logs_raw
                        (uid, userid, pointeuse_user_id, ts, state, verify_type, raw_log)
                    VALUES ($1,$2,$3,$4,$5,$6,$7)
                    ON CONFLICT DO NOTHING
                    RETURNING id
                `, [
                    String(l.uid),
                    String(l.userid),
                    l.pointeuseUserId ? String(l.pointeuseUserId) : null,
                    l.timestamp,
                    l.state ?? 0,
                    l.type ?? 0,
                    l.rawLog ? l.rawLog : null,
                ]);
                if (result.rowCount > 0) inserted++;
            }
            await client.query('COMMIT');
            console.log(`✅ ${inserted} new raw logs saved to DB (${parsedLogs.length} total processed)`);
            return inserted;
        } catch (e) {
            await client.query('ROLLBACK');
            throw e;
        } finally {
            client.release();
        }
    }

    // ── Recompute daily records from raw logs ─────────────────
    async recomputeDailyFromRaw(daysBack = 30) {
        const client = await global.attendancePool.connect();
        try {
            const since = new Date();
            since.setDate(since.getDate() - daysBack);

            // Get raw logs
            const { rows: rawRows } = await client.query(`
                SELECT uid, ts, verify_type
                FROM public.attendance_logs_raw
                WHERE ts >= $1
                ORDER BY ts ASC
            `, [since]);

            // Get employees
            const { rows: empRows } = await client.query(`
                SELECT uid, matricule, pointeuse_user_id, full_name, card_no
                FROM public.employees
            `);

            // Build lookup maps
            const byPointeuse = new Map();
            const byMatricule = new Map();
            const byUid = new Map();
            for (const e of empRows) {
                byPointeuse.set(String(e.pointeuse_user_id), e);
                byMatricule.set(String(e.matricule), e);
                byUid.set(String(e.uid), e);
            }

            // Group logs by employee + date
            const groups = new Map();
            for (const r of rawRows) {
                const logUserId = String(r.uid);

                // Find employee
                const emp = byPointeuse.get(logUserId) ||
                    byMatricule.get(logUserId) ||
                    byUid.get(logUserId) ||
                    (() => {
                        if (logUserId.startsWith('400')) {
                            const mat = logUserId.substring(3).replace(/^0+/, '');
                            return byMatricule.get(mat);
                        }
                        return null;
                    })();

                if (!emp) continue;

                const dateKey = toDateKey(r.ts);
                const dayOfWeek = new Date(dateKey).getDay();
                if (dayOfWeek === 0 || dayOfWeek === 6) continue; // skip weekends

                const key = `${emp.uid}-${dateKey}`;
                if (!groups.has(key)) {
                    groups.set(key, {
                        uid: emp.uid,
                        userId: String(emp.matricule),
                        pointeuseUserId: String(emp.pointeuse_user_id),
                        name: emp.full_name,
                        cardNo: emp.card_no,
                        date: dateKey,
                        entries: [],
                    });
                }

                const dt = new Date(r.ts);
                groups.get(key).entries.push({
                    timestamp: dt,
                    time: toTimeHHMM(dt),
                    hour: dt.getHours(),
                    minute: dt.getMinutes(),
                    type: r.verify_type,
                });
            }

            // Compute daily records
            const dayNames = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];
            const today = new Date().toISOString().split('T')[0];
            const dailyRecords = [];

            for (const g of groups.values()) {
                g.entries.sort((a, b) => a.hour !== b.hour ? a.hour - b.hour : a.minute - b.minute);

                const record = {
                    uid: g.uid,
                    userId: g.userId,
                    pointeuseUserId: g.pointeuseUserId,
                    name: g.name,
                    cardNo: g.cardNo,
                    workDate: g.date,
                    dayName: dayNames[new Date(g.date).getDay()],
                    arrivalTime: null,
                    departureTime: null,
                    hoursWorked: '0.00',
                    status: 'Absent',
                    entries: g.entries,
                    logUserId: g.pointeuseUserId,
                };

                if (g.entries.length > 0) {
                    // First entry = arrival
                    const first = g.entries[0];
                    record.arrivalTime = first.time;
                    first.type = 0;
                    first.typeLabel = 'Arrivée';

                    const arrivalMinutes = first.hour * 60 + first.minute;
                    if (arrivalMinutes < 8 * 60) record.status = "À l'heure";
                    else if (arrivalMinutes <= 9 * 60) record.status = 'Présent';
                    else record.status = 'En retard';

                    if (g.entries.length > 1) {
                        // Last entry = departure
                        const last = g.entries[g.entries.length - 1];
                        record.departureTime = last.time;
                        last.type = 1;
                        last.typeLabel = 'Départ';

                        // Middle entries = passages
                        for (let i = 1; i < g.entries.length - 1; i++) {
                            g.entries[i].type = 2;
                            g.entries[i].typeLabel = 'Passage';
                        }

                        // Calculate hours worked
                        const [ah, am] = record.arrivalTime.split(':').map(Number);
                        const [dh, dm] = record.departureTime.split(':').map(Number);
                        let totalMinutes = (dh * 60 + dm) - (ah * 60 + am);
                        if (totalMinutes > 240) totalMinutes -= 60; // subtract lunch break
                        totalMinutes = Math.max(0, totalMinutes);
                        record.hoursWorked = (totalMinutes / 60).toFixed(2);
                    } else {
                        // Only one entry — still here today
                        if (record.workDate === today) {
                            record.status = 'En cours';
                        }
                    }
                }

                dailyRecords.push(record);
            }

            // Upsert daily records
            await client.query('BEGIN');
            for (const r of dailyRecords) {
                await client.query(`
                    INSERT INTO public.attendance_daily
                        (uid, user_id, pointeuse_user_id, full_name, card_no, work_date, day_name,
                         arrival_time, departure_time, hours_worked, status, entries, log_user_id, last_update)
                    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, NOW())
                    ON CONFLICT (uid, work_date) DO UPDATE SET
                        user_id           = EXCLUDED.user_id,
                        pointeuse_user_id = EXCLUDED.pointeuse_user_id,
                        full_name         = EXCLUDED.full_name,
                        card_no           = EXCLUDED.card_no,
                        day_name          = EXCLUDED.day_name,
                        arrival_time      = EXCLUDED.arrival_time,
                        departure_time    = EXCLUDED.departure_time,
                        hours_worked      = EXCLUDED.hours_worked,
                        status            = EXCLUDED.status,
                        entries           = EXCLUDED.entries,
                        log_user_id       = EXCLUDED.log_user_id,
                        last_update       = NOW()
                `, [
                    r.uid, r.userId, r.pointeuseUserId, r.name, r.cardNo,
                    r.workDate, r.dayName, r.arrivalTime, r.departureTime,
                    r.hoursWorked, r.status, JSON.stringify(r.entries), r.logUserId,
                ]);
            }
            await client.query('COMMIT');
            console.log(`✅ ${dailyRecords.length} daily records upserted`);
            return dailyRecords.length;

        } catch (e) {
            await client.query('ROLLBACK');
            throw e;
        } finally {
            client.release();
        }
    }

    // ── Main sync: device → DB ────────────────────────────────
    // This is the ONLY function that touches the device
    // Called by the background job in server.js
    async runSync() {
        if (this.isSyncing) {
            console.log('⏭️ Sync already running, skipping');
            return { success: false, message: 'Already syncing' };
        }

        this.isSyncing = true;
        const startedAt = new Date();

        // Log sync start
        const syncRun = await global.attendancePool.query(`
            INSERT INTO public.sync_runs (started_at, success, message)
            VALUES (NOW(), false, 'running')
            RETURNING id
        `);
        const syncRunId = syncRun.rows[0].id;

        try {
            // 1. Sync employees from HR DB
            const employees = await this.loadEmployeesFromHRDB();
            await this.syncEmployeesToAttendanceDB(employees);

            // 2. Connect to device
            await this.connect();

            // 3. Fetch raw logs from device
            console.log('📥 Fetching attendance logs from device...');
            const attendanceResponse = await this.device.getAttendances();
            const rawLogs = Array.isArray(attendanceResponse)
                ? attendanceResponse
                : (attendanceResponse.data || attendanceResponse || []);
            console.log(`📝 ${rawLogs.length} raw logs from device`);

            // 4. Parse and save raw logs
            const parsedLogs = this.parseRawLogs(rawLogs);
            const newLogsCount = await this.insertRawLogs(parsedLogs);

            // 5. Recompute daily records (last 30 days)
            const recomputedCount = await this.recomputeDailyFromRaw(30);

            // 6. Update sync run record
            await global.attendancePool.query(`
                UPDATE public.sync_runs
                SET finished_at = NOW(),
                    success = true,
                    message = $1,
                    details = $2
                WHERE id = $3
            `, [
                'Sync successful',
                JSON.stringify({
                    rawLogsFromDevice: rawLogs.length,
                    newLogsInserted: newLogsCount,
                    dailyRecordsRecomputed: recomputedCount,
                    employees: employees.length,
                }),
                syncRunId,
            ]);

            this.lastSyncAt = new Date();
            this.lastSyncSuccess = true;

            console.log(`✅ Sync completed in ${Date.now() - startedAt.getTime()}ms`);
            return {
                success: true,
                rawLogsFromDevice: rawLogs.length,
                newLogsInserted: newLogsCount,
                dailyRecordsRecomputed: recomputedCount,
            };

        } catch (error) {
            console.error('❌ Sync failed:', error.message);
            this.lastSyncSuccess = false;

            // Update sync run as failed
            await global.attendancePool.query(`
                UPDATE public.sync_runs
                SET finished_at = NOW(),
                    success = false,
                    message = $1
                WHERE id = $2
            `, [error.message, syncRunId]);

            throw error;
        } finally {
            this.isSyncing = false;
            await this.disconnect();
        }
    }

    // ── Get sync status ───────────────────────────────────────
    getStatus() {
        return {
            isConnected: this.isConnected,
            isSyncing: this.isSyncing,
            lastSyncAt: this.lastSyncAt,
            lastSyncSuccess: this.lastSyncSuccess,
            deviceIp: this.ip,
            devicePort: this.port,
        };
    }
}

module.exports = ZktecoService;
