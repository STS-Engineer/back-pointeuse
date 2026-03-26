const Zkteco = require('zkteco-js');
const moment = require('moment-timezone');

function toDateKey(d) {
    return moment(d).tz('Africa/Tunis').format('YYYY-MM-DD');
}

function toTimeHHMM(d) {
    return moment(d).tz('Africa/Tunis').format('HH:mm');
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

    async recomputeDailyFromRaw(daysBack = 30) {
        const client = await global.attendancePool.connect();
        try {
            const since = moment().tz('Africa/Tunis').subtract(daysBack, 'days').toDate();

            const { rows: rawRows } = await client.query(`
                SELECT uid, ts, state, verify_type
                FROM public.attendance_logs_raw
                WHERE ts >= $1
                ORDER BY ts ASC
            `, [since]);

            const { rows: empRows } = await client.query(`
                SELECT uid, matricule, pointeuse_user_id, full_name, card_no
                FROM public.employees
            `);

            const byPointeuse = new Map();
            const byMatricule = new Map();
            const byUid = new Map();

            for (const e of empRows) {
                byPointeuse.set(String(e.pointeuse_user_id), e);
                byMatricule.set(String(e.matricule), e);
                byUid.set(String(e.uid), e);
            }

            const groups = new Map();

            for (const r of rawRows) {
                const logUserId = String(r.uid);

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

                const m = moment(r.ts).tz('Africa/Tunis');
                const dateKey = m.format('YYYY-MM-DD');
                const dayOfWeek = m.day();

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

                groups.get(key).entries.push({
                    timestamp: m.toISOString(),
                    time: m.format('HH:mm'),
                    hour: Number(m.format('H')),
                    minute: Number(m.format('m')),
                    state: r.state ?? null,
                    originalType: r.verify_type,
                    type: r.verify_type,
                });
            }

            const dayNames = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];
            const today = moment().tz('Africa/Tunis').format('YYYY-MM-DD');
            const dailyRecords = [];

            for (const g of groups.values()) {
                g.entries.sort((a, b) => {
                    const aMinutes = a.hour * 60 + a.minute;
                    const bMinutes = b.hour * 60 + b.minute;
                    return aMinutes - bMinutes;
                });

                const record = {
                    uid: g.uid,
                    userId: g.userId,
                    pointeuseUserId: g.pointeuseUserId,
                    name: g.name,
                    cardNo: g.cardNo,
                    workDate: g.date,
                    dayName: dayNames[moment.tz(g.date, 'YYYY-MM-DD', 'Africa/Tunis').day()],
                    arrivalTime: null,
                    departureTime: null,
                    hoursWorked: '0.00',
                    status: 'Absent',
                    entries: g.entries,
                    logUserId: g.pointeuseUserId,
                };

                if (g.entries.length > 0) {
                    const arrivals = g.entries.filter(e => e.state === 0);
                    const departures = g.entries.filter(e => e.state === 1);

                    const firstArrival = arrivals.length > 0 ? arrivals[0] : g.entries[0];
                    const lastDeparture = departures.length > 0 ? departures[departures.length - 1] : null;

                    if (firstArrival) {
                        record.arrivalTime = firstArrival.time;
                        firstArrival.type = 0;
                        firstArrival.typeLabel = 'Arrivée';

                        const arrivalMinutes = firstArrival.hour * 60 + firstArrival.minute;
                        if (arrivalMinutes < 8 * 60) record.status = "À l'heure";
                        else if (arrivalMinutes <= 9 * 60) record.status = 'Présent';
                        else record.status = 'En retard';
                    }

                    if (lastDeparture && (!firstArrival || lastDeparture.time !== firstArrival.time)) {
                        record.departureTime = lastDeparture.time;
                        lastDeparture.type = 1;
                        lastDeparture.typeLabel = 'Départ';
                    }

                    for (const entry of g.entries) {
                        const isArrival = firstArrival && entry.timestamp === firstArrival.timestamp && entry.time === firstArrival.time;
                        const isDeparture = lastDeparture && entry.timestamp === lastDeparture.timestamp && entry.time === lastDeparture.time;

                        if (!isArrival && !isDeparture) {
                            entry.type = 2;
                            entry.typeLabel = 'Passage';
                        }
                    }

                    if (record.arrivalTime && record.departureTime) {
                        const [ah, am] = record.arrivalTime.split(':').map(Number);
                        const [dh, dm] = record.departureTime.split(':').map(Number);

                        let totalMinutes = (dh * 60 + dm) - (ah * 60 + am);

                        if (totalMinutes < 0) {
                            totalMinutes += 24 * 60;
                        }

                        if (totalMinutes > 240) {
                            totalMinutes -= 60; // lunch break
                        }

                        totalMinutes = Math.max(0, totalMinutes);
                        record.hoursWorked = (totalMinutes / 60).toFixed(2);
                    } else if (record.arrivalTime && record.workDate === today) {
                        record.status = 'En cours';
                    }
                }

                dailyRecords.push(record);
            }

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

    async runSync() {
        if (this.isSyncing) {
            console.log('⏭️ Sync already running, skipping');
            return { success: false, message: 'Already syncing' };
        }

        this.isSyncing = true;
        const startedAt = new Date();

        const syncRun = await global.attendancePool.query(`
            INSERT INTO public.sync_runs (started_at, success, message)
            VALUES (NOW(), false, 'running')
            RETURNING id
        `);
        const syncRunId = syncRun.rows[0].id;

        try {
            const employees = await this.loadEmployeesFromHRDB();
            await this.syncEmployeesToAttendanceDB(employees);

            await this.connect();

            console.log('📥 Fetching attendance logs from device...');
            const attendanceResponse = await this.device.getAttendances();
            const rawLogs = Array.isArray(attendanceResponse)
                ? attendanceResponse
                : (attendanceResponse.data || attendanceResponse || []);
            console.log(`📝 ${rawLogs.length} raw logs from device`);

            const parsedLogs = this.parseRawLogs(rawLogs);
            const newLogsCount = await this.insertRawLogs(parsedLogs);

            const recomputedCount = await this.recomputeDailyFromRaw(30);

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
