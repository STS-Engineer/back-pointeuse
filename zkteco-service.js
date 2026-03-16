const Zkteco = require('zkteco-js');
const moment = require('moment-timezone');

// Pools are set as globals by server.js before this file is used
// global.attendancePool → attendance DB
// global.hrPool         → HR DB (rh_application)

function toDateKey(d) {
    return new Date(d).toISOString().split('T')[0];
}

function toTimeHHMM(d) {
    const dt = new Date(d);
    return `${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;
}

function ensureDateObject(date) {
    if (!date) return null;
    if (date instanceof Date) return date;
    if (typeof date === 'string' || typeof date === 'number') {
        const d = new Date(date);
        return isNaN(d.getTime()) ? null : d;
    }
    return date;
}

class ZktecoService {
    constructor(ip = '10.10.205.10', port = 4370, timeout = 5200, inport = 5000) {
        this.ip = ip;
        this.port = port;
        this.timeout = timeout;
        this.inport = inport;
        this.device = null;
        this.isConnected = false;
        this.users = [];
        this.attendanceLogs = [];
        this.processedData = [];
        this.realEmployees = []; // loaded from HR DB — no more hardcoded list

        // Lookup maps
        this.matriculeMap = {};
        this.pointeuseUserIdMap = {};
        this.uidMap = {};

        console.log(`🚀 ZktecoService initialized — device: ${this.ip}:${this.port}`);
    }

    // ── Load active employees from HR DB ─────────────────────
    async loadEmployeesFromHRDB() {
        console.log('👥 Loading active employees from HR database...');
        try {
            const { rows } = await global.hrPool.query(`
                SELECT id, matricule, nom, prenom, statut
                FROM public.employees
                WHERE statut = 'actif'
                ORDER BY id ASC
            `);

            this.realEmployees = rows.map(row => ({
                uid: row.id,
                name: `${row.prenom} ${row.nom}`.trim(),
                matricule: String(row.matricule),
                pointeuseUserId: `400${String(row.matricule).padStart(2, '0')}`,
            }));

            // Rebuild lookup maps
            this.matriculeMap = {};
            this.pointeuseUserIdMap = {};
            this.uidMap = {};
            this.realEmployees.forEach(emp => {
                this.matriculeMap[emp.matricule] = emp;
                this.pointeuseUserIdMap[emp.pointeuseUserId] = emp;
                this.uidMap[emp.uid] = emp;
            });

            console.log(`✅ ${this.realEmployees.length} active employees loaded from HR DB`);
            await this.syncEmployeesToAttendanceDB();
        } catch (error) {
            console.error('❌ Failed to load employees from HR DB:', error.message);
            this.realEmployees = [];
        }
    }

    // ── Mirror employees into Attendance DB ──────────────────
    async syncEmployeesToAttendanceDB() {
        const client = await global.attendancePool.connect();
        try {
            await client.query('BEGIN');
            for (const emp of this.realEmployees) {
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
            console.log(`✅ ${this.realEmployees.length} employees synced to Attendance DB`);
        } catch (e) {
            await client.query('ROLLBACK');
            console.error('❌ Failed to sync employees to Attendance DB:', e.message);
        } finally {
            client.release();
        }
    }

    // ── Employee lookup strategies (unchanged) ────────────────
    extractUserId(log) {
        const possibleFields = ['enrollNumber', 'PIN', 'user_id', 'userId', 'userid', 'uid'];
        for (const field of possibleFields) {
            if (log[field] !== undefined && log[field] !== null && log[field] !== '') {
                return log[field].toString().trim();
            }
        }
        return '0';
    }

    findEmployeeByLogUserId(logUserId) {
        if (!logUserId || logUserId === '0' || logUserId === '') return null;

        const strategies = [
            (id) => this.realEmployees.find(emp =>
                emp.matricule === id ||
                emp.pointeuseUserId === id ||
                `400${emp.matricule}` === id ||
                `400${emp.matricule.padStart(3, '0')}` === id
            ),
            (id) => {
                if (id && id.startsWith('400')) {
                    const matricule = id.substring(3);
                    return this.realEmployees.find(emp =>
                        emp.matricule === matricule ||
                        emp.matricule === matricule.replace(/^0+/, '')
                    );
                }
                return null;
            },
            (id) => {
                const numId = parseInt(id);
                if (!isNaN(numId) && numId > 0) {
                    return this.realEmployees.find(emp =>
                        emp.uid === numId ||
                        parseInt(emp.matricule) === numId
                    );
                }
                return null;
            },
        ];

        for (const strategy of strategies) {
            const employee = strategy(logUserId);
            if (employee) return employee;
        }
        return null;
    }

    // ── Connect to ZKTeco device ──────────────────────────────
    async initialize() {
        try {
            console.log(`🔌 Connecting to ZKTeco at ${this.ip}:${this.port}...`);
            this.device = new Zkteco(this.ip, this.port, this.timeout, this.inport);
            await this.device.createSocket();
            this.isConnected = true;
            console.log('✅ Connected to ZKTeco device');
            return true;
        } catch (error) {
            const errMsg = error?.message || error?.toString() || 'unknown';
            console.error('❌ Cannot reach ZKTeco device:', errMsg);
            this.isConnected = false;
            throw error;
        }
    }

    // ── Main sync: device → DB ────────────────────────────────
    async fetchAllData() {
        // 1. Always reload fresh employee list from HR DB
        await this.loadEmployeesFromHRDB();

        // 2. Connect to device
        if (!this.isConnected || !this.device) {
            try {
                await this.initialize();
            } catch (error) {
                console.error('❌ Device connection failed, will use cached data');
                await this.loadProcessedDataFromDB();
                await this.loadUsersFromDB();
                return {
                    success: false,
                    usersCount: this.users.length,
                    logsCount: this.attendanceLogs.length,
                    processedCount: this.processedData.length,
                    isRealData: false,
                    message: 'Device unreachable, serving cached data'
                };
            }
        }

        // 3. Fetch raw users from device
        console.log('📥 Fetching users from device...');
        const usersResponse = await this.device.getUsers();
        const rawUsers = Array.isArray(usersResponse) ? usersResponse : (usersResponse.data || []);
        console.log(`👥 Raw users from device: ${rawUsers.length}`);

        // 4. Build users list from HR employees
        this.users = this.realEmployees.map(emp => {
            const deviceUser = rawUsers.find(u => {
                const userId = u.userId || u.userid || u.user_id || '';
                return userId === emp.pointeuseUserId ||
                       userId === emp.matricule ||
                       userId === `400${emp.matricule.padStart(2, '0')}`;
            });
            return {
                uid: emp.uid,
                userid: emp.matricule,
                userId: emp.matricule,
                pointeuseUserId: emp.pointeuseUserId,
                name: emp.name,
                cardno: deviceUser?.cardno || `EMP${emp.matricule.padStart(3, '0')}`,
                role: deviceUser?.role || 0,
                password: '',
                deviceData: deviceUser || null,
            };
        });
        console.log(`✅ ${this.users.length} users loaded`);

        // 5. Fetch attendance logs from device
        console.log('📥 Fetching attendance logs from device...');
        const attendanceResponse = await this.device.getAttendances();
        const rawLogs = Array.isArray(attendanceResponse) ? attendanceResponse :
                       (attendanceResponse.data || attendanceResponse || []);
        console.log(`📝 Raw logs from device: ${rawLogs.length}`);

        // 6. Parse logs
        this.attendanceLogs = rawLogs.map(log => {
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

            const userId = this.extractUserId(log);
            let state = log.state || 0;
            if (state === 4) state = 1;

            return {
                uid: userId,
                userid: userId,
                userId: userId,
                pointeuseUserId: log.user_id || log.userId || log.userid || '0',
                timestamp: logTime,
                state,
                type: log.verify_type || log.type || 0,
                rawLog: log,
            };
        }).filter(log => log.timestamp && !isNaN(log.timestamp.getTime()));

        console.log(`✅ ${this.attendanceLogs.length} attendance logs parsed`);

        // 7. Save raw logs to DB
        await this.insertRawLogs(this.attendanceLogs);

        // 8. Recompute daily records from DB
        const recomputeDays = parseInt(process.env.RECOMPUTE_DAYS || '7');
        await this.recomputeDailyFromRaw(recomputeDays);

        // 9. Reload final data from DB into memory
        await this.loadProcessedDataFromDB();
        await this.loadUsersFromDB();

        this.debugIdMapping();

        return {
            success: true,
            usersCount: this.users.length,
            logsCount: this.attendanceLogs.length,
            processedCount: this.processedData.length,
            isRealData: true,
            message: 'Données réelles récupérées et sauvegardées avec succès',
        };
    }

    // ── Save raw logs to attendance_logs_raw ──────────────────
    async insertRawLogs(rawLogs) {
        const client = await global.attendancePool.connect();
        try {
            await client.query('BEGIN');
            const sql = `
                INSERT INTO public.attendance_logs_raw
                    (uid, userid, pointeuse_user_id, ts, state, verify_type, raw_log)
                VALUES ($1,$2,$3,$4,$5,$6,$7)
                ON CONFLICT DO NOTHING
            `;
            for (const l of rawLogs) {
                await client.query(sql, [
                    String(l.uid),
                    String(l.userid),
                    l.pointeuseUserId ? String(l.pointeuseUserId) : null,
                    l.timestamp,
                    l.state ?? 0,
                    l.type ?? 0,
                    l.rawLog ? l.rawLog : null,
                ]);
            }
            await client.query('COMMIT');
            console.log(`✅ ${rawLogs.length} raw logs saved to DB`);
        } catch (e) {
            await client.query('ROLLBACK');
            console.error('❌ Failed to save raw logs:', e.message);
        } finally {
            client.release();
        }
    }

    // ── Recompute daily records from raw logs ─────────────────
    async recomputeDailyFromRaw(daysBack = 7) {
        const client = await global.attendancePool.connect();
        try {
            const since = new Date();
            since.setDate(since.getDate() - daysBack);

            const { rows } = await client.query(`
                SELECT uid, ts, verify_type
                FROM public.attendance_logs_raw
                WHERE ts >= $1
                ORDER BY ts ASC
            `, [since]);

            const empRes = await client.query(`
                SELECT uid, matricule, pointeuse_user_id, full_name, card_no
                FROM public.employees
            `);

            const byPointeuse = new Map();
            const byMatricule = new Map();
            const byUid       = new Map();
            for (const e of empRes.rows) {
                byPointeuse.set(String(e.pointeuse_user_id), e);
                byMatricule.set(String(e.matricule), e);
                byUid.set(String(e.uid), e);
            }

            const groups = new Map();
            for (const r of rows) {
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

                const dateKey = toDateKey(r.ts);
                const dayOfWeek = new Date(dateKey).getDay();
                if (dayOfWeek === 0 || dayOfWeek === 6) continue;

                const key = `${emp.uid}-${dateKey}`;
                if (!groups.has(key)) {
                    groups.set(key, {
                        uid: emp.uid,
                        userId: String(emp.matricule),
                        userid: String(emp.matricule),
                        pointeuseUserId: String(emp.pointeuse_user_id),
                        name: emp.full_name,
                        cardNo: emp.card_no,
                        date: dateKey,
                        entries: [],
                    });
                }

                const g = groups.get(key);
                const dt = new Date(r.ts);
                g.entries.push({
                    timestamp: dt,
                    time: toTimeHHMM(dt),
                    hour: dt.getHours(),
                    minute: dt.getMinutes(),
                    originalType: r.verify_type,
                    type: r.verify_type,
                });
            }

            const dayNames = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];
            const dailyRecords = [];

            for (const g of groups.values()) {
                g.entries.sort((a, b) => a.hour !== b.hour ? a.hour - b.hour : a.minute - b.minute);

                const record = {
                    uid: g.uid,
                    userId: g.userId,
                    userid: g.userid,
                    pointeuseUserId: g.pointeuseUserId,
                    name: g.name,
                    cardNo: g.cardNo,
                    workDate: g.date,
                    date: g.date,
                    dayName: dayNames[new Date(g.date).getDay()],
                    arrivalTime: null,
                    departureTime: null,
                    hoursWorked: '0.00',
                    status: 'Absent',
                    entries: g.entries,
                    logUserId: g.pointeuseUserId,
                };

                if (g.entries.length > 0) {
                    const first = g.entries[0];
                    record.arrivalTime = first.time;
                    first.type = 0;
                    first.typeLabel = 'Arrivée';

                    const arrivalMinutes = first.hour * 60 + first.minute;
                    if (arrivalMinutes < 8 * 60)       record.status = "À l'heure";
                    else if (arrivalMinutes <= 9 * 60) record.status = 'Présent';
                    else                               record.status = 'En retard';

                    if (g.entries.length > 1) {
                        const last = g.entries[g.entries.length - 1];
                        record.departureTime = last.time;
                        last.type = 1;
                        last.typeLabel = 'Départ';

                        for (let i = 1; i < g.entries.length - 1; i++) {
                            g.entries[i].type = 2;
                            g.entries[i].typeLabel = 'Passage';
                        }

                        const [ah, am] = record.arrivalTime.split(':').map(Number);
                        const [dh, dm] = record.departureTime.split(':').map(Number);
                        let totalMinutes = (dh * 60 + dm) - (ah * 60 + am);
                        if (totalMinutes > 240) totalMinutes -= 60;
                        totalMinutes = Math.max(0, totalMinutes);
                        record.hoursWorked = (totalMinutes / 60).toFixed(2);
                    } else {
                        const today = new Date().toISOString().split('T')[0];
                        if (record.workDate === today) record.status = 'En cours';
                    }
                }

                dailyRecords.push(record);
            }

            await client.query('BEGIN');
            const upsert = `
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
            `;

            for (const r of dailyRecords) {
                await client.query(upsert, [
                    r.uid, r.userId, r.pointeuseUserId, r.name, r.cardNo,
                    r.workDate, r.dayName, r.arrivalTime, r.departureTime,
                    r.hoursWorked, r.status, JSON.stringify(r.entries), r.logUserId,
                ]);
            }

            await client.query('COMMIT');
            console.log(`✅ ${dailyRecords.length} daily records upserted to DB`);

        } catch (e) {
            await client.query('ROLLBACK');
            console.error('❌ recomputeDailyFromRaw failed:', e.message);
            throw e;
        } finally {
            client.release();
        }
    }

    // ── Load processed data FROM DB into memory ───────────────
    async loadProcessedDataFromDB() {
        try {
            const { rows } = await global.attendancePool.query(`
                SELECT
                    uid,
                    user_id            AS "userId",
                    pointeuse_user_id  AS "pointeuseUserId",
                    full_name          AS name,
                    card_no            AS "cardNo",
                    work_date::text    AS date,
                    day_name           AS "dayName",
                    to_char(arrival_time,   'HH24:MI') AS "arrivalTime",
                    to_char(departure_time, 'HH24:MI') AS "departureTime",
                    hours_worked::text AS "hoursWorked",
                    status,
                    entries,
                    log_user_id        AS "logUserId"
                FROM public.attendance_daily
                ORDER BY work_date DESC, full_name ASC
            `);

            this.processedData = rows.map(row => ({
                ...row,
                userid: row.userId,
                workDate: row.date,
                entries: Array.isArray(row.entries)
                    ? row.entries.map(e => ({ ...e, timestamp: ensureDateObject(e.timestamp) }))
                    : (row.entries ? JSON.parse(row.entries).map(e => ({ ...e, timestamp: ensureDateObject(e.timestamp) })) : []),
            }));

            console.log(`✅ ${this.processedData.length} records loaded from Attendance DB`);
        } catch (e) {
            console.error('❌ Failed to load processed data from DB:', e.message);
            this.processedData = [];
        }
    }

    // ── Load users FROM Attendance DB into memory ─────────────
    async loadUsersFromDB() {
        try {
            const { rows } = await global.attendancePool.query(`
                SELECT
                    uid,
                    matricule          AS userid,
                    pointeuse_user_id  AS "pointeuseUserId",
                    full_name          AS name,
                    card_no            AS cardno,
                    role,
                    password,
                    device_data        AS "deviceData"
                FROM public.employees
                ORDER BY uid ASC
            `);

            this.users = rows.map(row => ({
                ...row,
                userId: row.userid,
                cardno: row.cardno || `EMP${String(row.uid).padStart(3, '0')}`,
                role: row.role || 0,
                password: row.password || '',
                deviceData: row.deviceData || null,
            }));

            console.log(`✅ ${this.users.length} users loaded from Attendance DB`);
        } catch (e) {
            console.error('❌ Failed to load users from DB:', e.message);
            this.users = [];
        }
    }

    // ── Debug ID mapping ──────────────────────────────────────
    debugIdMapping() {
        console.log('\n🔍 DEBUG ID MAPPING');
        const uniqueLogIds = new Set();
        this.attendanceLogs.forEach(log => { if (log.uid !== '0') uniqueLogIds.add(log.uid); });
        let matched = 0, unmatched = 0;
        uniqueLogIds.forEach(id => {
            if (this.findEmployeeByLogUserId(id)) matched++;
            else unmatched++;
        });
        console.log(`📈 ID matching: ${matched} matched, ${unmatched} unmatched out of ${uniqueLogIds.size} unique IDs`);
        console.log('====================================\n');
    }

    // ── Getters with backward compatibility ──────────────────
    getUsers() {
        return this.users.map(user => ({
            ...user,
            userid: user.userid || user.userId,
            timestamp: user.timestamp ? ensureDateObject(user.timestamp) : user.timestamp
        }));
    }

    getAttendanceLogs() {
        return this.attendanceLogs.map(log => ({
            ...log,
            userid: log.userid || log.userId,
            timestamp: ensureDateObject(log.timestamp)
        }));
    }

    getProcessedData() {
        return this.processedData.map(record => ({
            ...record,
            userid: record.userid || record.userId,
            date: record.date || record.workDate,
            entries: record.entries ? record.entries.map(e => ({
                ...e,
                timestamp: ensureDateObject(e.timestamp)
            })) : [],
            timestamp: record.timestamp ? ensureDateObject(record.timestamp) : record.timestamp
        }));
    }

    getEmployeeData(uid) {
        return this.getProcessedData().filter(r => r.uid.toString() === uid.toString());
    }

    getDataByDate(date) {
        return this.getProcessedData().filter(r => r.date === date);
    }

    getEmployeeDayData(uid, date) {
        return this.getProcessedData().find(r =>
            r.uid.toString() === uid.toString() && r.date === date
        );
    }

    getDayName(dayIndex) {
        const days = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];
        return days[dayIndex];
    }

    getSummary() {
        const today = new Date().toISOString().split('T')[0];
        const todayData = this.getDataByDate(today);
        const presentToday = todayData.filter(r => r.status !== 'Absent').length;
        return {
            totalUsers: this.users.length,
            totalLogs: this.attendanceLogs.length,
            totalDays: new Set(this.processedData.map(d => d.date)).size,
            totalRecords: this.processedData.length,
            presentToday,
            absentToday: this.users.length - presentToday,
            lastUpdate: new Date().toISOString(),
            isConnected: this.isConnected,
            isRealData: this.isConnected,
            deviceIp: this.ip,
            realUsersCount: this.realEmployees.length,
        };
    }

    getMatchingStats() {
        const uniqueLogIds = new Set();
        this.attendanceLogs.forEach(log => { if (log.uid !== '0') uniqueLogIds.add(log.uid); });
        let matched = 0, unmatched = 0;
        uniqueLogIds.forEach(id => {
            if (this.findEmployeeByLogUserId(id)) matched++;
            else unmatched++;
        });
        return {
            uniqueLogIds: uniqueLogIds.size,
            matched,
            unmatched,
            matchRate: uniqueLogIds.size > 0 ?
                ((matched / uniqueLogIds.size) * 100).toFixed(1) + '%' : '0%',
        };
    }

    getDetailedStats() {
        const today = new Date().toISOString().split('T')[0];
        const todayData = this.getDataByDate(today);
        const stats = {
            totalEmployees: this.realEmployees.length,
            presentToday: 0,
            absentToday: this.realEmployees.length,
            lateToday: 0,
            inProgressToday: 0,
            averageHours: 0,
            byDay: {},
            byEmployee: {},
            idMatching: this.getMatchingStats(),
        };

        todayData.forEach(record => {
            if (record.status === 'Présent' || record.status === "À l'heure") {
                stats.presentToday++; stats.absentToday--;
            } else if (record.status === 'En retard') {
                stats.lateToday++; stats.absentToday--;
            } else if (record.status === 'En cours') {
                stats.inProgressToday++; stats.absentToday--;
            }
        });

        const recordsWithHours = this.processedData.filter(r => parseFloat(r.hoursWorked) > 0);
        if (recordsWithHours.length > 0) {
            const totalHours = recordsWithHours.reduce((s, r) => s + parseFloat(r.hoursWorked), 0);
            stats.averageHours = (totalHours / recordsWithHours.length).toFixed(2);
        }

        this.processedData.forEach(record => {
            if (!stats.byDay[record.date]) {
                stats.byDay[record.date] = {
                    date: record.date, dayName: record.dayName,
                    present: 0, absent: this.realEmployees.length,
                    late: 0, inProgress: 0, totalHours: 0,
                };
            }
            const day = stats.byDay[record.date];
            if (record.status === 'Présent' || record.status === "À l'heure") {
                day.present++; day.absent--;
            } else if (record.status === 'En retard') {
                day.late++; day.absent--;
            } else if (record.status === 'En cours') {
                day.inProgress++; day.absent--;
            }
            if (parseFloat(record.hoursWorked) > 0) day.totalHours += parseFloat(record.hoursWorked);
        });

        this.realEmployees.forEach(emp => {
            const empData = this.processedData.filter(r => r.uid === emp.uid);
            const empWithHours = empData.filter(r => parseFloat(r.hoursWorked) > 0);
            stats.byEmployee[emp.uid] = {
                uid: emp.uid, name: emp.name,
                matricule: emp.matricule, pointeuseUserId: emp.pointeuseUserId,
                totalDays: empData.length,
                presentDays: empData.filter(r => r.status === 'Présent' || r.status === "À l'heure").length,
                lateDays: empData.filter(r => r.status === 'En retard').length,
                inProgressDays: empData.filter(r => r.status === 'En cours').length,
                totalHours: empWithHours.reduce((s, r) => s + parseFloat(r.hoursWorked), 0).toFixed(2),
                averageHours: empWithHours.length > 0 ?
                    (empWithHours.reduce((s, r) => s + parseFloat(r.hoursWorked), 0) / empWithHours.length).toFixed(2) : 0,
            };
        });

        return stats;
    }

    async testConnection() {
        try {
            await this.initialize();
            return { success: true, message: 'Connection successful', isConnected: this.isConnected, ip: this.ip, port: this.port };
        } catch (error) {
            return { success: false, message: 'Connection failed — check port forwarding', error: error.message, isConnected: false, ip: this.ip, port: this.port };
        }
    }

    async disconnect() {
        if (this.isConnected && this.device) {
            try {
                await this.device.disconnect();
                this.isConnected = false;
                console.log('✅ Disconnected from ZKTeco');
                return { success: true };
            } catch (error) {
                console.error('❌ Disconnect error:', error.message);
                return { success: false, error: error.message };
            }
        }
        return { success: true, message: 'Not connected' };
    }
}

module.exports = ZktecoService;
