const express = require('express');
const router = express.Router();
const ZktecoService = require('../zkteco-service');

const zktecoService = new ZktecoService('10.10.205.10');

let initializationPromise = null;

const initializeService = async () => {
    if (!initializationPromise) {
        initializationPromise = (async () => {
            console.log('=== Initialisation du service dans les routes ===');
            try {
                await zktecoService.initialize();
                console.log('✅ Service initialisé dans les routes');
                
                setTimeout(async () => {
                    try {
                        const result = await zktecoService.fetchAllData();
                        console.log('✅ Données initiales chargées');
                        console.log(`  Utilisateurs: ${result.usersCount}`);
                        console.log(`  Logs: ${result.logsCount}`);
                        console.log(`  Données traitées: ${result.processedCount}`);
                    } catch (error) {
                        console.error('❌ Erreur lors du chargement initial des données:', error.message);
                    }
                }, 2000);
                
                return true;
            } catch (error) {
                console.error('❌ Erreur d\'initialisation dans les routes:', error.message);
                initializationPromise = null;
                throw error;
            }
        })();
    }
    return initializationPromise;
};

const ensureInitialized = async (req, res, next) => {
    try {
        await initializeService();
        next();
    } catch (error) {
        res.status(500).json({
            success: false,
            error: 'Service non initialisé: ' + error.message
        });
    }
};

// Routes de base
router.get('/test', (req, res) => {
    res.json({
        success: true,
        message: 'API fonctionnelle',
        timestamp: new Date().toISOString(),
        serviceInitialized: initializationPromise !== null,
        version: '2.0.0'
    });
});

router.get('/cors-test', (req, res) => {
    res.json({
        success: true,
        message: 'CORS test réussi',
        timestamp: new Date().toISOString(),
        origin: req.headers.origin,
        headers: req.headers,
        cors: {
            enabled: true,
            allowedMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
            allowedHeaders: ['Content-Type', 'Authorization', 'Accept'],
            credentials: true
        }
    });
});

router.get('/health', async (req, res) => {
    try {
        const isInitialized = initializationPromise !== null;
        const summary = zktecoService.getSummary ? zktecoService.getSummary() : {};
        
        res.json({
            success: true,
            status: 'healthy',
            timestamp: new Date().toISOString(),
            service: {
                initialized: isInitialized,
                connected: zktecoService.isConnected || false,
                realData: summary.isRealData || false
            },
            data: {
                users: summary.totalUsers || 0,
                logs: summary.totalLogs || 0,
                records: summary.totalRecords || 0,
                lastUpdate: summary.lastUpdate || new Date().toISOString()
            },
            system: {
                uptime: process.uptime(),
                memory: process.memoryUsage(),
                node: process.version
            }
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message,
            status: 'unhealthy'
        });
    }
});

// Routes principales
router.get('/users', ensureInitialized, async (req, res) => {
    try {
        const users = zktecoService.getUsers();
        res.json({
            success: true,
            count: users.length,
            users: users,
            metadata: {
                realData: zktecoService.isConnected,
                lastUpdate: new Date().toISOString()
            }
        });
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: error.message,
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    }
});

router.get('/logs', ensureInitialized, async (req, res) => {
    try {
        const logs = zktecoService.getAttendanceLogs();
        const limit = parseInt(req.query.limit) || 100;
        const offset = parseInt(req.query.offset) || 0;
        const paginatedLogs = logs.slice(offset, offset + limit);
        
        res.json({
            success: true,
            count: logs.length,
            pagination: {
                limit,
                offset,
                total: logs.length,
                hasMore: offset + limit < logs.length
            },
            logs: paginatedLogs,
            metadata: {
                realData: zktecoService.isConnected,
                lastUpdate: new Date().toISOString()
            }
        });
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: error.message,
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    }
});

router.get('/attendance', ensureInitialized, async (req, res) => {
    try {
        const data = zktecoService.getProcessedData();
        const limit = parseInt(req.query.limit) || 100;
        const offset = parseInt(req.query.offset) || 0;
        const paginatedData = data.slice(offset, offset + limit);
        
        res.json({
            success: true,
            count: data.length,
            pagination: {
                limit,
                offset,
                total: data.length,
                hasMore: offset + limit < data.length
            },
            data: paginatedData,
            metadata: {
                realData: zktecoService.isConnected,
                lastUpdate: new Date().toISOString(),
                summary: zktecoService.getSummary ? zktecoService.getSummary() : {}
            }
        });
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: error.message,
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    }
});

router.post('/refresh', ensureInitialized, async (req, res) => {
    try {
        console.log('🔄 Rafraîchissement des données demandé...');
        const result = await zktecoService.fetchAllData();
        const data = zktecoService.getProcessedData();
        const summary = zktecoService.getSummary();
        
        res.json({
            success: true,
            message: 'Données rafraîchies avec succès',
            result: result,
            summary: summary,
            data: {
                count: data.length,
                sample: data.slice(0, 5)
            },
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: error.message,
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    }
});

router.get('/summary', ensureInitialized, async (req, res) => {
    try {
        const summary = zktecoService.getSummary();
        const detailed = req.query.detailed === 'true';
        
        if (detailed && zktecoService.getDetailedStats) {
            const stats = zktecoService.getDetailedStats();
            res.json({ 
                success: true, 
                summary: summary,
                detailedStats: stats 
            });
        } else {
            res.json({ 
                success: true, 
                summary: summary 
            });
        }
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

router.get('/today', ensureInitialized, async (req, res) => {
    try {
        const today = new Date().toISOString().split('T')[0];
        const data = zktecoService.getDataByDate(today);
        const employees = zktecoService.getUsers();
        
        // Calculer les statistiques
        const stats = {
            total: employees.length,
            present: data.filter(r => r.status === 'Présent' || r.status === 'À l\'heure').length,
            late: data.filter(r => r.status === 'En retard').length,
            inProgress: data.filter(r => r.status === 'En cours').length,
            absent: employees.length - data.length,
            averageHours: 0
        };
        
        const withHours = data.filter(r => r.hoursWorked && parseFloat(r.hoursWorked) > 0);
        if (withHours.length > 0) {
            stats.averageHours = (withHours.reduce((sum, r) => sum + parseFloat(r.hoursWorked), 0) / withHours.length).toFixed(2);
        }
        
        res.json({
            success: true,
            date: today,
            dayName: zktecoService.getDayName(new Date().getDay()),
            stats: stats,
            count: data.length,
            totalEmployees: employees.length,
            data: data
        });
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

router.get('/by-date/:date', ensureInitialized, async (req, res) => {
    try {
        const { date } = req.params;
        const data = zktecoService.getDataByDate(date);
        const employees = zktecoService.getUsers();
        
        // Créer une liste complète avec tous les employés
        const employeeMap = new Map();
        employees.forEach(emp => {
            employeeMap.set(emp.uid, {
                uid: emp.uid,
                userId: emp.userid,
                pointeuseUserId: emp.pointeuseUserId,
                name: emp.name,
                cardNo: emp.cardno,
                date: date,
                dayName: zktecoService.getDayName(new Date(date).getDay()),
                arrivalTime: null,
                departureTime: null,
                hoursWorked: '0.00',
                entries: [],
                status: 'Absent'
            });
        });
        
        // Remplacer par les données réelles si elles existent
        data.forEach(record => {
            employeeMap.set(record.uid, record);
        });
        
        const completeData = Array.from(employeeMap.values()).sort((a, b) => a.name.localeCompare(b.name));
        
        // Statistiques
        const stats = {
            total: employees.length,
            present: completeData.filter(r => r.status === 'Présent' || r.status === 'À l\'heure').length,
            late: completeData.filter(r => r.status === 'En retard').length,
            inProgress: completeData.filter(r => r.status === 'En cours').length,
            absent: completeData.filter(r => r.status === 'Absent').length,
            averageHours: 0
        };
        
        const withHours = completeData.filter(r => r.hoursWorked && parseFloat(r.hoursWorked) > 0);
        if (withHours.length > 0) {
            stats.averageHours = (withHours.reduce((sum, r) => sum + parseFloat(r.hoursWorked), 0) / withHours.length).toFixed(2);
        }
        
        res.json({
            success: true,
            date: date,
            dayName: zktecoService.getDayName(new Date(date).getDay()),
            stats: stats,
            totalEmployees: employees.length,
            data: completeData
        });
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

router.get('/by-employee/:uid', ensureInitialized, async (req, res) => {
    try {
        const { uid } = req.params;
        const data = zktecoService.getEmployeeData(uid);
        const user = zktecoService.getUsers().find(u => u.uid.toString() === uid.toString());
        
        if (!user) {
            return res.status(404).json({
                success: false,
                error: 'Employé non trouvé'
            });
        }
        
        // Calculer les statistiques de l'employé
        const stats = {
            totalDays: data.length,
            presentDays: data.filter(r => r.status === 'Présent' || r.status === 'À l\'heure').length,
            lateDays: data.filter(r => r.status === 'En retard').length,
            inProgressDays: data.filter(r => r.status === 'En cours').length,
            absentDays: 0,
            totalHours: 0,
            averageHours: 0,
            earliestDate: data.length > 0 ? data[data.length - 1].date : null,
            latestDate: data.length > 0 ? data[0].date : null
        };
        
        const daysWithHours = data.filter(r => r.hoursWorked && parseFloat(r.hoursWorked) > 0);
        if (daysWithHours.length > 0) {
            stats.totalHours = daysWithHours.reduce((sum, r) => sum + parseFloat(r.hoursWorked), 0).toFixed(2);
            stats.averageHours = (stats.totalHours / daysWithHours.length).toFixed(2);
        }
        
        res.json({
            success: true,
            employee: {
                uid: user.uid,
                userId: user.userid,
                pointeuseUserId: user.pointeuseUserId,
                name: user.name,
                cardNo: user.cardno
            },
            stats: stats,
            count: data.length,
            data: data
        });
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

router.get('/by-employee/:uid/date/:date', ensureInitialized, async (req, res) => {
    try {
        const { uid, date } = req.params;
        const data = zktecoService.getEmployeeDayData(uid, date);
        const user = zktecoService.getUsers().find(u => u.uid.toString() === uid.toString());
        
        if (!user) {
            return res.status(404).json({
                success: false,
                error: 'Employé non trouvé'
            });
        }
        
        if (!data) {
            return res.json({
                success: true,
                employee: {
                    uid: user.uid,
                    userId: user.userid,
                    pointeuseUserId: user.pointeuseUserId,
                    name: user.name,
                    cardNo: user.cardno
                },
                date: date,
                data: {
                    uid: user.uid,
                    userId: user.userid,
                    pointeuseUserId: user.pointeuseUserId,
                    name: user.name,
                    cardNo: user.cardno,
                    date: date,
                    dayName: zktecoService.getDayName(new Date(date).getDay()),
                    arrivalTime: null,
                    departureTime: null,
                    hoursWorked: '0.00',
                    entries: [],
                    status: 'Absent'
                }
            });
        }
        
        res.json({
            success: true,
            employee: {
                uid: user.uid,
                userId: user.userid,
                pointeuseUserId: user.pointeuseUserId,
                name: user.name,
                cardNo: user.cardno
            },
            date: date,
            data: data
        });
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

router.get('/available-dates', ensureInitialized, async (req, res) => {
    try {
        const data = zktecoService.getProcessedData();
        const dates = [...new Set(data.map(r => r.date))].sort().reverse();
        
        const datesWithStats = dates.map(date => {
            const dayData = zktecoService.getDataByDate(date);
            const employees = zktecoService.getUsers();
            
            return {
                date: date,
                dayName: zktecoService.getDayName(new Date(date).getDay()),
                totalEmployees: employees.length,
                present: dayData.filter(r => r.status === 'Présent' || r.status === 'À l\'heure').length,
                late: dayData.filter(r => r.status === 'En retard').length,
                inProgress: dayData.filter(r => r.status === 'En cours').length,
                absent: employees.length - dayData.length,
                totalHours: dayData.reduce((sum, r) => sum + (parseFloat(r.hoursWorked) || 0), 0).toFixed(2)
            };
        });
        
        res.json({
            success: true,
            count: dates.length,
            dates: datesWithStats
        });
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

router.get('/report/:startDate/:endDate', ensureInitialized, async (req, res) => {
    try {
        const { startDate, endDate } = req.params;
        const data = zktecoService.getProcessedData();
        
        const filteredData = data.filter(r => r.date >= startDate && r.date <= endDate);
        
        // Statistiques globales de la période
        const stats = {
            period: { start: startDate, end: endDate },
            totalDays: new Set(filteredData.map(r => r.date)).size,
            totalRecords: filteredData.length,
            byDay: {},
            byEmployee: {}
        };
        
        // Stats par jour
        filteredData.forEach(record => {
            if (!stats.byDay[record.date]) {
                stats.byDay[record.date] = {
                    date: record.date,
                    dayName: record.dayName,
                    present: 0,
                    late: 0,
                    inProgress: 0,
                    totalHours: 0
                };
            }
            
            if (record.status === 'Présent' || record.status === 'À l\'heure') {
                stats.byDay[record.date].present++;
            } else if (record.status === 'En retard') {
                stats.byDay[record.date].late++;
            } else if (record.status === 'En cours') {
                stats.byDay[record.date].inProgress++;
            }
            
            if (record.hoursWorked && parseFloat(record.hoursWorked) > 0) {
                stats.byDay[record.date].totalHours += parseFloat(record.hoursWorked);
            }
        });
        
        // Stats par employé
        zktecoService.getUsers().forEach(user => {
            const empData = filteredData.filter(r => r.uid === user.uid);
            const empWithHours = empData.filter(r => r.hoursWorked && parseFloat(r.hoursWorked) > 0);
            
            stats.byEmployee[user.uid] = {
                uid: user.uid,
                name: user.name,
                matricule: user.userid,
                totalDays: empData.length,
                presentDays: empData.filter(r => r.status === 'Présent' || r.status === 'À l\'heure').length,
                lateDays: empData.filter(r => r.status === 'En retard').length,
                inProgressDays: empData.filter(r => r.status === 'En cours').length,
                totalHours: empWithHours.reduce((sum, r) => sum + parseFloat(r.hoursWorked), 0).toFixed(2),
                averageHours: empWithHours.length > 0 ? 
                    (empWithHours.reduce((sum, r) => sum + parseFloat(r.hoursWorked), 0) / empWithHours.length).toFixed(2) : 0
            };
        });
        
        res.json({
            success: true,
            stats: stats,
            data: filteredData
        });
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// Routes de débogage
router.get('/debug/mapping', ensureInitialized, async (req, res) => {
    try {
        const users = zktecoService.getUsers();
        const logs = zktecoService.getAttendanceLogs();
        const processed = zktecoService.getProcessedData();
        
        // Analyser les 20 premiers logs
        const sampleLogs = logs.slice(0, 20).map(log => {
            // Chercher par UID
            let matchedUser = users.find(u => u.uid === log.uid);
            
            // Si non trouvé, chercher par matricule (userid)
            if (!matchedUser && log.userid) {
                matchedUser = users.find(u => u.userid === log.userid);
            }
            
            // Si toujours non trouvé, chercher par pointeuseUserId
            if (!matchedUser && log.pointeuseUserId) {
                matchedUser = users.find(u => u.pointeuseUserId === log.pointeuseUserId);
            }
            
            return {
                log: {
                    uid: log.uid,
                    userid: log.userid,
                    pointeuseUserId: log.pointeuseUserId,
                    timestamp: log.timestamp ? log.timestamp.toISOString() : 'null',
                    type: log.type
                },
                matchedUser: matchedUser ? {
                    uid: matchedUser.uid,
                    userid: matchedUser.userid,
                    pointeuseUserId: matchedUser.pointeuseUserId,
                    name: matchedUser.name
                } : null
            };
        });
        
        // Statistiques de correspondance
        const matchedCount = sampleLogs.filter(item => item.matchedUser).length;
        const unmatchedCount = sampleLogs.filter(item => !item.matchedUser).length;
        
        // Liste des UIDs uniques dans les logs
        const logUIDs = [...new Set(logs.map(l => l.uid))].slice(0, 20);
        const userUIDs = [...new Set(users.map(u => u.uid))].slice(0, 20);
        
        res.json({
            success: true,
            stats: {
                users: users.length,
                logs: logs.length,
                processed: processed.length,
                sampleSize: sampleLogs.length,
                matched: matchedCount,
                unmatched: unmatchedCount,
                matchRate: ((matchedCount / sampleLogs.length) * 100).toFixed(2) + '%'
            },
            logUIDs: logUIDs,
            userUIDs: userUIDs,
            sampleLogs: sampleLogs,
            usersSample: users.slice(0, 5),
            logsSample: logs.slice(0, 5),
            processedSample: processed.slice(0, 5),
            realEmployees: zktecoService.realEmployees ? zktecoService.realEmployees.slice(0, 5) : []
        });
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: error.message,
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    }
});

router.get('/debug/users-raw', ensureInitialized, async (req, res) => {
    try {
        const users = zktecoService.getUsers();
        res.json({
            success: true,
            rawData: users,
            type: typeof users,
            isArray: Array.isArray(users),
            length: Array.isArray(users) ? users.length : 'N/A',
            sample: users.slice(0, 3)
        });
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

router.get('/debug/logs-raw', ensureInitialized, async (req, res) => {
    try {
        const logs = zktecoService.getAttendanceLogs();
        res.json({
            success: true,
            rawData: logs,
            type: typeof logs,
            isArray: Array.isArray(logs),
            length: Array.isArray(logs) ? logs.length : 'N/A',
            sample: logs.slice(0, 3)
        });
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

router.get('/test-connection', async (req, res) => {
    try {
        const result = await zktecoService.testConnection();
        res.json(result);
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

router.get('/real-employees', async (req, res) => {
    try {
        if (zktecoService.realEmployees) {
            res.json({
                success: true,
                count: zktecoService.realEmployees.length,
                employees: zktecoService.realEmployees
            });
        } else {
            const users = zktecoService.getUsers();
            res.json({
                success: true,
                count: users.length,
                employees: users.map(user => ({
                    uid: user.uid,
                    name: user.name,
                    matricule: user.userid,
                    pointeuseUserId: user.pointeuseUserId
                }))
            });
        }
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

router.get('/debug/test-correspondance', ensureInitialized, async (req, res) => {
    try {
        const logs = zktecoService.getAttendanceLogs();
        const users = zktecoService.getUsers();
        
        // Prendre 20 logs et tester la correspondance
        const testResults = [];
        const logSample = logs.slice(0, 20);
        
        logSample.forEach(log => {
            const logUserId = log.uid.toString();
            const logPointeuseUserId = log.pointeuseUserId;
            
            // Chercher par pointeuseUserId
            let matchedUser = users.find(u => u.pointeuseUserId === logPointeuseUserId);
            
            // Si non trouvé, chercher par userid
            if (!matchedUser) {
                matchedUser = users.find(u => u.userid === logUserId);
            }
            
            // Si toujours non trouvé, chercher dans realEmployees
            if (!matchedUser && zktecoService.realEmployees) {
                const realEmp = zktecoService.realEmployees.find(e => 
                    e.pointeuseUserId === logPointeuseUserId || 
                    e.pointeuseUserId === logUserId ||
                    e.matricule === logUserId
                );
                
                if (realEmp) {
                    matchedUser = users.find(u => u.uid === realEmp.uid);
                }
            }
            
            testResults.push({
                log: {
                    uid: logUserId,
                    pointeuseUserId: logPointeuseUserId,
                    timestamp: log.timestamp,
                    type: log.type
                },
                matched: matchedUser ? {
                    uid: matchedUser.uid,
                    name: matchedUser.name,
                    matricule: matchedUser.userid,
                    pointeuseUserId: matchedUser.pointeuseUserId
                } : null,
                matchType: matchedUser ? 'SUCCESS' : 'FAILED'
            });
        });
        
        const successCount = testResults.filter(r => r.matchType === 'SUCCESS').length;
        const failCount = testResults.filter(r => r.matchType === 'FAILED').length;
        
        res.json({
            success: true,
            stats: {
                totalLogs: logs.length,
                sampleSize: logSample.length,
                successCount: successCount,
                failCount: failCount,
                successRate: `${((successCount / logSample.length) * 100).toFixed(1)}%`
            },
            testResults: testResults,
            allPointeuseUserIds: [...new Set(logs.map(l => l.pointeuseUserId).filter(id => id && id !== '0'))].sort(),
            realEmployees: zktecoService.realEmployees ? zktecoService.realEmployees.map(emp => ({
                name: emp.name,
                matricule: emp.matricule,
                pointeuseUserId: emp.pointeuseUserId
            })) : []
        });
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

router.get('/debug/raw-attendances', ensureInitialized, async (req, res) => {
    try {
        console.log('🔍 Test direct de getAttendances()...');
        
        // Accéder directement au device
        const device = zktecoService.device;
        if (!device) {
            return res.status(500).json({
                success: false,
                error: 'Device non initialisé'
            });
        }
        
        // Essayer différentes méthodes
        const methods = ['getAttendances', 'getAttLogs', 'getAttendanceLogs'];
        let result = null;
        let methodUsed = '';
        
        for (const method of methods) {
            if (device[method] && typeof device[method] === 'function') {
                try {
                    console.log(`🔄 Essai de la méthode: ${method}`);
                    result = await device[method]();
                    methodUsed = method;
                    console.log(`✅ Méthode ${method} réussie`);
                    break;
                } catch (error) {
                    console.log(`❌ Méthode ${method} échouée:`, error.message);
                }
            }
        }
        
        if (!result) {
            return res.status(500).json({
                success: false,
                error: 'Aucune méthode getAttendances ne fonctionne'
            });
        }
        
        // Analyser la structure des données
        const rawData = result.data || result;
        console.log(`📊 Nombre de logs bruts: ${Array.isArray(rawData) ? rawData.length : 'N/A'}`);
        
        if (Array.isArray(rawData) && rawData.length > 0) {
            console.log('🔍 Structure du premier log:');
            const firstLog = rawData[0];
            
            // Afficher toutes les clés
            console.log('🔑 Clés disponibles:', Object.keys(firstLog));
            
            // Afficher les valeurs
            Object.keys(firstLog).forEach(key => {
                console.log(`  ${key}: ${JSON.stringify(firstLog[key])} (type: ${typeof firstLog[key]})`);
            });
        }
        
        res.json({
            success: true,
            methodUsed: methodUsed,
            resultStructure: {
                hasDataProperty: result.data !== undefined,
                dataIsArray: Array.isArray(result.data),
                dataLength: Array.isArray(result.data) ? result.data.length : 'N/A',
                rawKeys: Object.keys(result)
            },
            sampleLog: Array.isArray(rawData) && rawData.length > 0 ? rawData[0] : null,
            totalLogs: Array.isArray(rawData) ? rawData.length : 0
        });
    } catch (error) {
        console.error('❌ Erreur dans debug/raw-attendances:', error);
        res.status(500).json({
            success: false,
            error: error.message,
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    }
});

router.get('/debug/force-match/:matricule', ensureInitialized, async (req, res) => {
    try {
        const { matricule } = req.params;
        
        // Chercher l'employé
        const employee = zktecoService.realEmployees.find(emp => emp.matricule === matricule);
        if (!employee) {
            return res.status(404).json({ 
                success: false, 
                error: 'Employé non trouvé' 
            });
        }
        
        // Chercher les logs pour cette matricule
        const logs = zktecoService.getAttendanceLogs();
        const userLogs = logs.filter(log => 
            log.userid === matricule || 
            log.uid.toString() === matricule ||
            log.pointeuseUserId === employee.pointeuseUserId ||
            (log.pointeuseUserId && log.pointeuseUserId.includes(matricule))
        );
        
        // Créer manuellement les données traitées
        const processedLogs = userLogs.reduce((acc, log) => {
            const date = new Date(log.timestamp);
            const dateKey = date.toISOString().split('T')[0];
            const key = `${employee.uid}-${dateKey}`;
            
            if (!acc[key]) {
                acc[key] = {
                    uid: employee.uid,
                    userId: employee.matricule,
                    pointeuseUserId: employee.pointeuseUserId,
                    name: employee.name,
                    cardNo: `EMP${employee.matricule.padStart(3, '0')}`,
                    date: dateKey,
                    dayName: zktecoService.getDayName(date.getDay()),
                    entries: [],
                    hoursWorked: 0,
                    arrivalTime: null,
                    departureTime: null,
                    status: 'Absent'
                };
            }
            
            const hour = date.getHours();
            const minute = date.getMinutes();
            
            acc[key].entries.push({
                timestamp: log.timestamp,
                time: `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`,
                hour,
                minute,
                type: log.type
            });
            
            return acc;
        }, {});
        
        // Traiter chaque jour
        const processedData = Object.values(processedLogs).map(record => {
            record.entries.sort((a, b) => {
                if (a.hour !== b.hour) return a.hour - b.hour;
                return a.minute - b.minute;
            });

            const arrivalEntries = record.entries.filter(e => e.type === 0);
            const departureEntries = record.entries.filter(e => e.type === 1);
            
            if (arrivalEntries.length > 0) {
                record.arrivalTime = arrivalEntries[0].time;
                record.status = arrivalEntries[0].hour > 9 ? 'En retard' : 'Présent';
            }
            
            if (departureEntries.length > 0) {
                const lastDeparture = departureEntries[departureEntries.length - 1];
                record.departureTime = lastDeparture.time;
            }

            if (record.arrivalTime && record.departureTime) {
                const arrivalParts = record.arrivalTime.split(':');
                const departureParts = record.departureTime.split(':');
                
                const arrivalTotalMinutes = parseInt(arrivalParts[0]) * 60 + parseInt(arrivalParts[1]);
                const departureTotalMinutes = parseInt(departureParts[0]) * 60 + parseInt(departureParts[1]);
                
                let totalMinutes = departureTotalMinutes - arrivalTotalMinutes;
                
                if (totalMinutes > 240) {
                    totalMinutes -= 60;
                }
                
                record.hoursWorked = (totalMinutes / 60).toFixed(2);
            }

            return record;
        });
        
        res.json({
            success: true,
            employee: employee,
            logsCount: userLogs.length,
            processedCount: processedData.length,
            logs: userLogs.slice(0, 10),
            processedData: processedData
        });
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// Route pour réinitialiser le service
router.post('/reset', async (req, res) => {
    try {
        console.log('🔄 Réinitialisation du service demandée...');
        
        if (initializationPromise) {
            initializationPromise = null;
        }
        
        if (zktecoService.disconnect) {
            await zktecoService.disconnect();
        }
        
        // Réinitialiser les données
        zktecoService.users = [];
        zktecoService.attendanceLogs = [];
        zktecoService.processedData = [];
        zktecoService.device = null;
        zktecoService.isConnected = false;
        
        // Réinitialiser
        await initializeService();
        
        res.json({
            success: true,
            message: 'Service réinitialisé avec succès',
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

module.exports = router;