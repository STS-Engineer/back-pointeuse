const Zkteco = require('zkteco-js');
const moment = require('moment-timezone');

class ZktecoService {
    constructor(ip = '41.224.4.231', port = 4370, timeout = 5200, inport = 5000) {
        this.ip = ip;
        this.port = port;
        this.timeout = timeout;
        this.inport = inport;
        this.device = null;
        this.isConnected = false;
        this.users = [];
        this.attendanceLogs = [];
        this.processedData = [];
        
        // Liste réelle des employés avec leurs correspondances
        this.realEmployees = [
            { uid: 1,  name: 'Fethi Chaouachi',           matricule: '1',  pointeuseUserId: '40001' },
            { uid: 2,  name: 'Hela ELghoul',              matricule: '2',  pointeuseUserId: '40002' },
            { uid: 3,  name: 'Aziza Hamrouni',            matricule: '3',  pointeuseUserId: '40003' },
            { uid: 5,  name: 'Hamdi Fhal',                matricule: '5',  pointeuseUserId: '40005' },
            { uid: 6,  name: 'Nizar Gharsalli',           matricule: '6',  pointeuseUserId: '40006' },
            { uid: 12, name: 'Mohamed Firas Bellotef',    matricule: '12', pointeuseUserId: '40012' },
            { uid: 13, name: 'Fatma Guermassi',           matricule: '13', pointeuseUserId: '40013' },
            { uid: 15, name: 'Souhail Yaakoubi',          matricule: '15', pointeuseUserId: '40015' },
            { uid: 16, name: 'Taha Khiari',               matricule: '16', pointeuseUserId: '40016' },
            { uid: 17, name: 'Ahmed Ayadi',               matricule: '17', pointeuseUserId: '40017' },
            { uid: 18, name: 'Amira Aydi',                matricule: '18', pointeuseUserId: '40018' },
            { uid: 19, name: 'Motaz Farwa',               matricule: '19', pointeuseUserId: '40019' },
            { uid: 20, name: 'Chaima Ben Yahia',          matricule: '20', pointeuseUserId: '40020' },
            { uid: 21, name: 'Hedi Daizi',                matricule: '21', pointeuseUserId: '40021' },
            { uid: 24, name: 'Hadil Sakouhi',             matricule: '24', pointeuseUserId: '40024' },
            { uid: 26, name: 'Leila Mokni',               matricule: '26', pointeuseUserId: '40026' },
            { uid: 28, name: 'Mohamed Rzig',              matricule: '28', pointeuseUserId: '40028' },
            { uid: 29, name: 'Chiraz Ben Abbes',          matricule: '29', pointeuseUserId: '40029' },
            { uid: 30, name: 'Yassine Chtiti',            matricule: '30', pointeuseUserId: '40030' },
            { uid: 33, name: 'Manel Saad',                matricule: '33', pointeuseUserId: '40033' },
            // uid 34 Wala Ferchichi — REMOVED (left company)
            { uid: 35, name: 'Mohamed Laith Ben Mabrouk', matricule: '35', pointeuseUserId: '40035' },
            { uid: 36, name: 'Mohamed Baraketi',          matricule: '36', pointeuseUserId: '40036' },
            { uid: 37, name: 'Sirine Khalfallah',         matricule: '37', pointeuseUserId: '40037' },
            { uid: 39, name: 'Oumaya Bouni',              matricule: '39', pointeuseUserId: '40039' },
            { uid: 40, name: 'Maher Elhaj',               matricule: '40', pointeuseUserId: '40040' },
            { uid: 41, name: 'Moemen Ltifi',              matricule: '41', pointeuseUserId: '40041' },
            // uid 42 Majed Messai — REMOVED (left company)
            { uid: 43, name: 'Mohamed Baazaoui',          matricule: '43', pointeuseUserId: '40043' },
            // uid 44 Sami Benromdhan — REMOVED (left company)
            { uid: 45, name: 'Wassim Belhadjsalah',       matricule: '45', pointeuseUserId: '40045' },
            { uid: 46, name: 'Emna Baroumi',              matricule: '46', pointeuseUserId: '40046' },
            { uid: 47, name: 'Rami Mejri',                matricule: '47', pointeuseUserId: '40047' },
            { uid: 48, name: 'Hayfa Rahji',               matricule: '48', pointeuseUserId: '40048' },
            // uid 49 Jihen Ben Yahmed — REMOVED (left company)
            { uid: 50, name: 'Elyes Khelili',             matricule: '50', pointeuseUserId: '40050' },
            { uid: 51, name: 'Nour Sellami',              matricule: '51', pointeuseUserId: '40051' },
            { uid: 52, name: 'Mohamed Mohsen Khefacha',   matricule: '52', pointeuseUserId: '40052' },
            { uid: 53, name: 'Ranine Nouira',             matricule: '53', pointeuseUserId: '40053' },
            { uid: 54, name: 'Rihem Arfaoui',             matricule: '54', pointeuseUserId: '40054' },
            { uid: 55, name: 'Ons Ghariani',              matricule: '55', pointeuseUserId: '40055' },
            { uid: 56, name: 'SIHEM DJERIDI',             matricule: '56', pointeuseUserId: '40056' },
            // NEW EMPLOYEES
            { uid: 57, name: 'Marwa Saoudi',              matricule: '57', pointeuseUserId: '40057' },
            { uid: 58, name: 'Sondes Rahmouni',           matricule: '58', pointeuseUserId: '40058' },
            { uid: 59, name: 'Haythem Debbich',           matricule: '59', pointeuseUserId: '40059' },
            { uid: 60, name: 'Eya Grati',                 matricule: '60', pointeuseUserId: '40060' },
        ];
        
        // Maps pour recherche rapide
        this.matriculeMap = {};
        this.pointeuseUserIdMap = {};
        this.uidMap = {};
        
        this.realEmployees.forEach(emp => {
            this.matriculeMap[emp.matricule] = emp;
            this.pointeuseUserIdMap[emp.pointeuseUserId] = emp;
            this.uidMap[emp.uid] = emp;
        });
        
        // Système de correspondance multi-critères
        this.idMappingStrategies = [
            (logUserId) => {
                const exactMatch = this.realEmployees.find(emp => 
                    emp.matricule === logUserId ||
                    emp.pointeuseUserId === logUserId ||
                    `400${emp.matricule}` === logUserId ||
                    `400${emp.matricule.padStart(3, '0')}` === logUserId
                );
                return exactMatch;
            },
            (logUserId) => {
                if (logUserId && logUserId.startsWith('400')) {
                    const matricule = logUserId.substring(3);
                    return this.realEmployees.find(emp => 
                        emp.matricule === matricule ||
                        emp.matricule === matricule.replace(/^0+/, '')
                    );
                }
                return null;
            },
            (logUserId) => {
                const numId = parseInt(logUserId);
                if (!isNaN(numId) && numId > 0) {
                    return this.realEmployees.find(emp => 
                        emp.uid === numId ||
                        parseInt(emp.matricule) === numId
                    );
                }
                return null;
            }
        ];
        
        console.log(`🚀 ZktecoService initialized — device: ${this.ip}:${this.port}`);
    }

    extractUserId(log) {
        const possibleFields = [
            'enrollNumber',
            'PIN',
            'user_id',
            'userId',
            'userid',
            'uid'
        ];
        for (const field of possibleFields) {
            if (log[field] !== undefined && log[field] !== null && log[field] !== '') {
                return log[field].toString().trim();
            }
        }
        return '0';
    }

    findEmployeeByLogUserId(logUserId) {
        if (!logUserId || logUserId === '0' || logUserId === '') return null;
        for (const strategy of this.idMappingStrategies) {
            const employee = strategy(logUserId);
            if (employee) return employee;
        }
        return null;
    }

    async initialize() {
        try {
            console.log(`🔌 Connecting to ZKTeco at ${this.ip}:${this.port}...`);
            this.device = new Zkteco(this.ip, this.port, this.timeout, this.inport);
            await this.device.createSocket();
            this.isConnected = true;
            console.log('✅ Connected to ZKTeco device');
            return true;
        } catch (error) {
            // ✅ FIX 1 — capture any error type, not just Error instances
            const errMsg1 = error?.message || error?.toString() || JSON.stringify(error) || 'unknown';
            console.error('❌ Cannot reach ZKTeco device:', errMsg1);
            console.error('   Make sure port forwarding is configured on your router');
            console.error(`   Device: ${this.ip}:${this.port}`);
            this.isConnected = false;
            throw error; // ← fail honestly, no fake data
        }
    }

    async fetchAllData() {
        try {
            if (!this.isConnected || !this.device) {
                await this.initialize();
            }

            console.log('📥 Fetching users from device...');
            const usersResponse = await this.device.getUsers();
            const rawUsers = Array.isArray(usersResponse) ? usersResponse :
                            (usersResponse.data || []);
            console.log(`👥 Raw users from device: ${rawUsers.length}`);

            // Map users using real employee list
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
                    pointeuseUserId: emp.pointeuseUserId,
                    name: emp.name,
                    cardno: deviceUser?.cardno || `EMP${emp.matricule.padStart(3, '0')}`,
                    role: deviceUser?.role || 0,
                    password: '',
                    deviceData: deviceUser || null
                };
            });
            console.log(`✅ ${this.users.length} users loaded`);

            console.log('📥 Fetching attendance logs...');
            const attendanceResponse = await this.device.getAttendances();
            const rawLogs = Array.isArray(attendanceResponse) ? attendanceResponse :
                           (attendanceResponse.data || attendanceResponse || []);
            console.log(`📝 Raw logs from device: ${rawLogs.length}`);

            // Parse logs
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
                                'MM/DD/YYYY HH:mm:ss'
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
                } catch (error) {
                    console.warn('⚠️ Date parsing error:', recordTime, error.message);
                    logTime = new Date();
                }

                const userId = this.extractUserId(log);
                let state = log.state || 0;
                if (state === 4) state = 1;

                return {
                    uid: userId,
                    userid: userId,
                    pointeuseUserId: log.user_id || log.userId || log.userid || '0',
                    timestamp: logTime,
                    state: state,
                    type: log.verify_type || log.type || 0,
                    rawLog: log
                };
            }).filter(log => log.timestamp && !isNaN(log.timestamp.getTime()));

            console.log(`✅ ${this.attendanceLogs.length} attendance logs loaded`);

            this.debugIdMapping();
            this.processDataWithIntelligentLogic();

            return {
                success: true,
                usersCount: this.users.length,
                logsCount: this.attendanceLogs.length,
                processedCount: this.processedData.length,
                isRealData: true,
                message: 'Données réelles récupérées avec succès'
            };

        } catch (error) {
            // ✅ FIX 2 — capture any error type, not just Error instances
            const errMsg = error?.message || error?.toString() || JSON.stringify(error) || 'unknown';
            console.error('❌ Error fetching data from ZKTeco:', errMsg);
            throw new Error(`ZKTeco unreachable: ${errMsg}. Check port forwarding on router (port 4370 → 10.10.205.10).`);
        }
    }

    debugIdMapping() {
        console.log('\n🔍 DEBUG ID MAPPING');
        const uniqueLogIds = new Set();
        this.attendanceLogs.forEach(log => {
            if (log.uid !== '0') uniqueLogIds.add(log.uid);
        });

        let matched = 0, unmatched = 0;
        uniqueLogIds.forEach(id => {
            const emp = this.findEmployeeByLogUserId(id);
            if (emp) matched++;
            else unmatched++;
        });

        console.log(`📈 ID matching: ${matched} matched, ${unmatched} unmatched out of ${uniqueLogIds.size} unique IDs`);
        console.log('====================================\n');
    }

    processDataWithIntelligentLogic() {
        console.log('\n=== PROCESSING ATTENDANCE DATA ===');

        const userMap = {};
        this.users.forEach(user => {
            if (user && user.uid) {
                userMap[user.uid] = {
                    uid: user.uid,
                    userId: user.userid,
                    pointeuseUserId: user.pointeuseUserId,
                    name: user.name,
                    cardNo: user.cardno
                };
            }
        });

        const logsByUserAndDate = {};

        const sortedLogs = [...this.attendanceLogs].sort((a, b) =>
            a.timestamp.getTime() - b.timestamp.getTime()
        );

        sortedLogs.forEach(log => {
            if (!log || !log.uid || log.uid === '0' || !log.timestamp) return;

            const logUserId = log.uid.toString();
            const employee = this.findEmployeeByLogUserId(logUserId);
            if (!employee) return;

            const user = userMap[employee.uid];
            if (!user) return;

            const date = new Date(log.timestamp);
            const dateKey = date.toISOString().split('T')[0];
            const hour = date.getHours();
            const minute = date.getMinutes();
            const dayOfWeek = date.getDay();

            if (dayOfWeek === 0 || dayOfWeek === 6) return;

            const userDateKey = `${user.uid}-${dateKey}`;

            if (!logsByUserAndDate[userDateKey]) {
                logsByUserAndDate[userDateKey] = {
                    uid: user.uid,
                    userId: user.userId,
                    pointeuseUserId: user.pointeuseUserId,
                    name: user.name,
                    cardNo: user.cardNo,
                    date: dateKey,
                    dayName: this.getDayName(dayOfWeek),
                    entries: [],
                    hoursWorked: 0,
                    arrivalTime: null,
                    departureTime: null,
                    status: 'Absent',
                    logUserId: logUserId
                };
            }

            logsByUserAndDate[userDateKey].entries.push({
                timestamp: log.timestamp,
                time: `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`,
                hour,
                minute,
                originalType: log.type,
                type: log.type,
                logUserId: logUserId
            });
        });

        this.processedData = Object.values(logsByUserAndDate).map(record => {
            record.entries.sort((a, b) => {
                if (a.hour !== b.hour) return a.hour - b.hour;
                return a.minute - b.minute;
            });

            if (record.entries.length === 0) return record;

            // First punch = arrival
            const firstEntry = record.entries[0];
            record.arrivalTime = firstEntry.time;
            firstEntry.type = 0;
            firstEntry.typeLabel = 'Arrivée';

            const arrivalTotalMinutes = firstEntry.hour * 60 + firstEntry.minute;
            if (arrivalTotalMinutes < 8 * 60) {
                record.status = "À l'heure";
            } else if (arrivalTotalMinutes <= 9 * 60) {
                record.status = 'Présent';
            } else {
                record.status = 'En retard';
            }

            // Last punch = departure (if more than one)
            if (record.entries.length > 1) {
                const lastEntry = record.entries[record.entries.length - 1];
                record.departureTime = lastEntry.time;
                lastEntry.type = 1;
                lastEntry.typeLabel = 'Départ';

                for (let i = 1; i < record.entries.length - 1; i++) {
                    record.entries[i].type = 2;
                    record.entries[i].typeLabel = 'Passage';
                }

                const arrivalParts = record.arrivalTime.split(':');
                const departureParts = record.departureTime.split(':');
                const arrivalMins = parseInt(arrivalParts[0]) * 60 + parseInt(arrivalParts[1]);
                const departureMins = parseInt(departureParts[0]) * 60 + parseInt(departureParts[1]);

                let totalMinutes = departureMins - arrivalMins;
                if (totalMinutes > 240) totalMinutes -= 60; // lunch break
                totalMinutes = Math.max(0, totalMinutes);
                record.hoursWorked = (totalMinutes / 60).toFixed(2);

            } else {
                // Only one punch — still arriving
                const today = new Date().toISOString().split('T')[0];
                if (record.date === today) record.status = 'En cours';
                record.hoursWorked = '0.00';
            }

            return record;
        });

        this.processedData.sort((a, b) => {
            if (a.date !== b.date) return b.date.localeCompare(a.date);
            return a.name.localeCompare(b.name);
        });

        console.log(`✅ Processing done: ${this.processedData.length} records`);

        // Print daily summary
        this.printDailySummary();

        console.log('====================================\n');
    }

    printDailySummary() {
        console.log('\n=== RÉSUMÉ QUOTIDIEN DES POINTAGES ===');

        const byDate = {};
        this.processedData.forEach(record => {
            if (!byDate[record.date]) byDate[record.date] = [];
            byDate[record.date].push(record);
        });

        const sortedDates = Object.keys(byDate).sort().reverse().slice(0, 5);

        sortedDates.forEach(date => {
            console.log(`\n📅 ${date} (${this.getDayName(new Date(date).getDay())}):`);
            const records = byDate[date];
            let presentCount = 0, absentCount = 0;

            records.forEach(record => {
                if (record.status !== 'Absent') {
                    presentCount++;
                    const entriesSummary = record.entries.map(e =>
                        `${e.time}(${e.typeLabel?.charAt(0) || '?'})`
                    ).join(' → ');
                    console.log(`  ✓ ${record.name}: ${record.arrivalTime || '-'} → ${record.departureTime || '-'} | ${entriesSummary} | ${record.hoursWorked}h`);
                } else {
                    absentCount++;
                }
            });

            console.log(`  📊 Présents: ${presentCount}, Absents: ${absentCount}, Total: ${records.length}`);
        });

        console.log('\n📈 STATISTIQUES GLOBALES:');
        console.log(`  Total employés: ${this.users.length}`);
        console.log(`  Enregistrements traités: ${this.processedData.length}`);
        console.log(`  Taux de couverture: ${((this.processedData.length / this.users.length) * 100).toFixed(1)}%`);
        console.log(`  Présences: ${this.processedData.filter(r => r.status !== 'Absent').length}`);
        console.log(`  Absences: ${this.processedData.filter(r => r.status === 'Absent').length}`);
        console.log('\n=== FIN DU RÉSUMÉ ===\n');
    }

    processData() {
        return this.processDataWithIntelligentLogic();
    }

    getDayName(dayIndex) {
        const days = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];
        return days[dayIndex];
    }

    getUsers() { return this.users; }
    getAttendanceLogs() { return this.attendanceLogs; }
    getProcessedData() { return this.processedData; }
    getEmployeeData(uid) {
        return this.processedData.filter(r => r.uid.toString() === uid.toString());
    }
    getDataByDate(date) {
        return this.processedData.filter(r => r.date === date);
    }
    getEmployeeDayData(uid, date) {
        return this.processedData.find(r =>
            r.uid.toString() === uid.toString() && r.date === date
        );
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
        this.attendanceLogs.forEach(log => {
            if (log.uid !== '0') uniqueLogIds.add(log.uid);
        });
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
                ((matched / uniqueLogIds.size) * 100).toFixed(1) + '%' : '0%'
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
            idMatching: this.getMatchingStats()
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
                    late: 0, inProgress: 0, totalHours: 0, averageHours: 0
                };
            }
            if (record.status === 'Présent' || record.status === "À l'heure") {
                stats.byDay[record.date].present++; stats.byDay[record.date].absent--;
            } else if (record.status === 'En retard') {
                stats.byDay[record.date].late++; stats.byDay[record.date].absent--;
            } else if (record.status === 'En cours') {
                stats.byDay[record.date].inProgress++; stats.byDay[record.date].absent--;
            }
            if (parseFloat(record.hoursWorked) > 0) {
                stats.byDay[record.date].totalHours += parseFloat(record.hoursWorked);
            }
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
                    (empWithHours.reduce((s, r) => s + parseFloat(r.hoursWorked), 0) / empWithHours.length).toFixed(2) : 0
            };
        });

        return stats;
    }

    async testConnection() {
        try {
            await this.initialize();
            return {
                success: true,
                message: 'Connection successful',
                isConnected: this.isConnected,
                ip: this.ip,
                port: this.port
            };
        } catch (error) {
            return {
                success: false,
                message: 'Connection failed — check port forwarding',
                error: error.message,
                isConnected: false,
                ip: this.ip,
                port: this.port
            };
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
