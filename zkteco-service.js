const Zkteco = require('zkteco-js');
const moment = require('moment-timezone');

class ZktecoService {
    constructor(ip, port = 4370, timeout = 5200, inport = 5000) {
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
            { uid: 1, name: 'Fethi Chaouachi', matricule: '1', pointeuseUserId: '40001' },
            { uid: 2, name: 'Hela ELghoul', matricule: '2', pointeuseUserId: '40002' },
            { uid: 3, name: 'Aziza Hamrouni', matricule: '3', pointeuseUserId: '40003' },
            { uid: 5, name: 'Hamdi Fhal', matricule: '5', pointeuseUserId: '40005' },
            { uid: 6, name: 'Nizar Gharsalli', matricule: '6', pointeuseUserId: '40006' },
            { uid: 12, name: 'Mohamed Firas Bellotef', matricule: '12', pointeuseUserId: '40012' },
            { uid: 13, name: 'Fatma Guermassi', matricule: '13', pointeuseUserId: '40013' },
            { uid: 15, name: 'Souhail Yaakoubi', matricule: '15', pointeuseUserId: '40015' },
            { uid: 16, name: 'Taha Khiari', matricule: '16', pointeuseUserId: '40016' },
            { uid: 17, name: 'Ahmed Ayadi', matricule: '17', pointeuseUserId: '40017' },
            { uid: 18, name: 'Amira Aydi', matricule: '18', pointeuseUserId: '40018' },
            { uid: 19, name: 'Motaz Farwa', matricule: '19', pointeuseUserId: '40019' },
            { uid: 20, name: 'Chaima Ben Yahia', matricule: '20', pointeuseUserId: '40020' },
            { uid: 21, name: 'Hedi Daizi', matricule: '21', pointeuseUserId: '40021' },
            { uid: 24, name: 'Hadil Sakouhi', matricule: '24', pointeuseUserId: '40024' },
            { uid: 26, name: 'Leila Mokni', matricule: '26', pointeuseUserId: '40026' },
            { uid: 28, name: 'Mohamed Rzig', matricule: '28', pointeuseUserId: '40028' },
            { uid: 29, name: 'Chiraz Ben Abbes', matricule: '29', pointeuseUserId: '40029' },
            { uid: 30, name: 'Yassine Chtiti', matricule: '30', pointeuseUserId: '40030' },
            { uid: 33, name: 'Manel Saad', matricule: '33', pointeuseUserId: '40033' },
            { uid: 34, name: 'Wala Ferchichi', matricule: '34', pointeuseUserId: '40034' },
            { uid: 35, name: 'Mohamed Laith Ben Mabrouk', matricule: '35', pointeuseUserId: '40035' },
            { uid: 36, name: 'Mohamed Baraketi', matricule: '36', pointeuseUserId: '40036' },
            { uid: 37, name: 'Sirine Khalfallah', matricule: '37', pointeuseUserId: '40037' },
            { uid: 39, name: 'Oumaya Bouni', matricule: '39', pointeuseUserId: '40039' },
            { uid: 40, name: 'Maher Elhaj', matricule: '40', pointeuseUserId: '40040' },
            { uid: 41, name: 'Moemen Ltifi', matricule: '41', pointeuseUserId: '40041' },
            { uid: 42, name: 'Majed Messai', matricule: '42', pointeuseUserId: '40042' },
            { uid: 43, name: 'Mohamed Baazaoui', matricule: '43', pointeuseUserId: '40043' },
            { uid: 44, name: 'Sami Benromdhan', matricule: '44', pointeuseUserId: '40044' },
            { uid: 45, name: 'Wassim Belhadjsalah', matricule: '45', pointeuseUserId: '40045' },
            { uid: 46, name: 'Emna Baroumi', matricule: '46', pointeuseUserId: '40046' },
            { uid: 47, name: 'Rami Mejri', matricule: '47', pointeuseUserId: '40047' },
            { uid: 48, name: 'Hayfa Rahji', matricule: '48', pointeuseUserId: '40048' },
            { uid: 49, name: 'Jihen Ben Yahmed', matricule: '49', pointeuseUserId: '40049' },
            { uid: 50, name: 'Elyes Khelili', matricule: '50', pointeuseUserId: '40050' },
            { uid: 51, name: 'Nour Sellami', matricule: '51', pointeuseUserId: '40051' },
            { uid: 52, name: 'Mohamed Mohsen Khefacha', matricule: '52', pointeuseUserId: '40052' },
            { uid: 53, name: 'Ranine Nouira', matricule: '53', pointeuseUserId: '40053' },
            { uid: 54, name: 'Rihem Arfaoui', matricule: '54', pointeuseUserId: '40054' },
            { uid: 55, name: 'Ons Ghariani', matricule: '55', pointeuseUserId: '40055' },
            { uid: 56, name: 'SIHEM DJERIDI', matricule: '56', pointeuseUserId: '40056' }
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
            // Stratégie 1: Correspondance exacte
            (logUserId) => {
                // Chercher dans tous les formats
                const exactMatch = this.realEmployees.find(emp => 
                    emp.matricule === logUserId ||
                    emp.pointeuseUserId === logUserId ||
                    `400${emp.matricule}` === logUserId ||
                    `400${emp.matricule.padStart(3, '0')}` === logUserId
                );
                return exactMatch;
            },
            
            // Stratégie 2: Extraire le matricule depuis pointeuseUserId
            (logUserId) => {
                // Si logUserId commence par 400
                if (logUserId && logUserId.startsWith('400')) {
                    const matricule = logUserId.substring(3);
                    return this.realEmployees.find(emp => 
                        emp.matricule === matricule ||
                        emp.matricule === matricule.replace(/^0+/, '')
                    );
                }
                return null;
            },
            
            // Stratégie 3: Chercher par UID numérique
            (logUserId) => {
                // Convertir en nombre si possible
                const numId = parseInt(logUserId);
                if (!isNaN(numId) && numId > 0) {
                    // Chercher dans UID ou matricule
                    return this.realEmployees.find(emp => 
                        emp.uid === numId ||
                        parseInt(emp.matricule) === numId
                    );
                }
                return null;
            }
        ];
        
        console.log(`🚀 Initialized ZktecoService with ${this.realEmployees.length} employees`);
    }

    // Fonction utilitaire pour extraire l'ID proprement
    extractUserId(log) {
        // Priorité des champs (selon documentation ZKTeco)
        const possibleFields = [
            'enrollNumber',    // Souvent l'ID d'enregistrement
            'PIN',             // Code PIN/ID numérique
            'user_id',         // Champ commun
            'userId',          // Autre variante
            'userid',          // Autre variante
            'uid'              // Index interne
        ];
        
        // Chercher la première valeur non-nulle
        for (const field of possibleFields) {
            if (log[field] !== undefined && log[field] !== null && log[field] !== '') {
                return log[field].toString().trim();
            }
        }
        
        return '0';
    }

    // Méthode pour trouver l'employé correspondant
    findEmployeeByLogUserId(logUserId) {
        if (!logUserId || logUserId === '0' || logUserId === '') return null;
        
        // Essayer chaque stratégie
        for (const strategy of this.idMappingStrategies) {
            const employee = strategy(logUserId);
            if (employee) {
                return employee;
            }
        }
        
        return null;
    }

    async initialize() {
        try {
            console.log(`🔌 Connexion à la pointeuse ${this.ip}:${this.port}...`);
            
            this.device = new Zkteco(this.ip, this.port, this.timeout, this.inport);
            
            await this.device.createSocket();
            this.isConnected = true;
            
            console.log('✅ Connecté à la pointeuse ZKTeco');
            return true;
        } catch (error) {
            console.error('❌ Erreur de connexion à la pointeuse:', error.message);
            this.isConnected = false;
            console.log('🎲 Génération de données fictives...');
            this.generateMockData();
            return true;
        }
    }

    async fetchAllData() {
        try {
            if (!this.isConnected && !this.device) {
                await this.initialize();
            }

            if (this.isConnected && this.device) {
                console.log('📥 Récupération des utilisateurs...');
                
                const usersResponse = await this.device.getUsers();
                console.log('✅ Réponse getUsers reçue');
                
                const rawUsers = Array.isArray(usersResponse) ? usersResponse : 
                                (usersResponse.data || []);
                
                console.log(`👥 Utilisateurs bruts de la pointeuse: ${rawUsers.length}`);
                
                if (rawUsers.length > 0) {
                    console.log('📋 Exemple utilisateur brut:', JSON.stringify(rawUsers[0], null, 2));
                }
                
                // Créer nos utilisateurs avec correspondance
                this.users = this.realEmployees.map(emp => {
                    // Chercher l'utilisateur correspondant dans la pointeuse
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
                
                console.log(`✅ ${this.users.length} utilisateurs récupérés`);

                console.log('📥 Récupération des logs de présence...');
                const attendanceResponse = await this.device.getAttendances();
                
                console.log('📊 Informations sur la réponse getAttendances:');
                console.log(`  Type: ${typeof attendanceResponse}`);
                console.log(`  Est tableau: ${Array.isArray(attendanceResponse)}`);
                console.log(`  A data property: ${attendanceResponse && attendanceResponse.data !== undefined}`);
                
                const rawLogs = Array.isArray(attendanceResponse) ? attendanceResponse : 
                               (attendanceResponse.data || attendanceResponse || []);
                
                console.log(`📝 Logs bruts de la pointeuse: ${rawLogs.length}`);
                
                if (rawLogs.length > 0) {
                    console.log('📋 Exemple log brut (premier):', JSON.stringify(rawLogs[0], null, 2));
                    console.log('📋 Exemple log brut (dernier):', JSON.stringify(rawLogs[rawLogs.length - 1], null, 2));
                    
                    // Analyser les 5 premiers logs
                    console.log('🔍 Analyse des premiers logs:');
                    rawLogs.slice(0, 5).forEach((log, i) => {
                        console.log(`Log ${i + 1}:`);
                        console.log(`  Clés: ${Object.keys(log).join(', ')}`);
                        console.log(`  user_id: ${log.user_id}`);
                        console.log(`  userId: ${log.userId}`);
                        console.log(`  userid: ${log.userid}`);
                        console.log(`  uid: ${log.uid}`);
                        console.log(`  record_time: ${log.record_time}`);
                        console.log(`  type: ${log.type}`);
                        console.log(`  state: ${log.state}`);
                    });
                }
                
                // Convertir les logs avec traitement sécurisé
                this.attendanceLogs = rawLogs.map(log => {
                    let logTime;
                    const recordTime = log.record_time || log.timestamp;
                    
                    try {
                        if (recordTime) {
                            if (typeof recordTime === 'string') {
                                // Essayer différents formats de date
                                const formats = [
                                    'ddd MMM DD YYYY HH:mm:ss [GMT]ZZ',
                                    'YYYY-MM-DD HH:mm:ss',
                                    'DD/MM/YYYY HH:mm:ss',
                                    'MM/DD/YYYY HH:mm:ss'
                                ];
                                
                                let parsedDate = null;
                                for (const format of formats) {
                                    parsedDate = moment.tz(recordTime, format, 'Africa/Tunis');
                                    if (parsedDate.isValid()) {
                                        break;
                                    }
                                }
                                
                                if (parsedDate && parsedDate.isValid()) {
                                    logTime = parsedDate.toDate();
                                } else {
                                    // Essayer avec Date natif
                                    logTime = new Date(recordTime);
                                }
                            } else if (typeof recordTime === 'number') {
                                logTime = new Date(recordTime * 1000);
                            } else if (recordTime instanceof Date) {
                                logTime = recordTime;
                            }
                        }
                        
                        if (!logTime || isNaN(logTime.getTime())) {
                            logTime = new Date();
                        }
                    } catch (error) {
                        console.warn('⚠️ Erreur parsing date:', recordTime, error.message);
                        logTime = new Date();
                    }
                    
                    // Extraire le user_id SANS MODIFICATION
                    const userId = this.extractUserId(log);
                    
                    // Déterminer le statut
                    let state = log.state || 0;
                    if (state === 4) state = 1;
                    
                    return {
                        uid: userId,
                        userid: userId, // Conserver l'ID original
                        pointeuseUserId: log.user_id || log.userId || log.userid || '0',
                        timestamp: logTime,
                        state: state,
                        type: log.verify_type || log.type || 0,
                        rawLog: log
                    };
                }).filter(log => log.timestamp && !isNaN(log.timestamp.getTime()));
                
                console.log(`✅ ${this.attendanceLogs.length} logs de présence récupérés`);
                
                // Debug des correspondances d'ID
                this.debugIdMapping();
            }

            // Traiter les données AVEC LOGIQUE INTELLIGENTE
            this.processDataWithIntelligentLogic();
            
            return {
                success: true,
                usersCount: this.users.length,
                logsCount: this.attendanceLogs.length,
                processedCount: this.processedData.length,
                isRealData: this.isConnected,
                message: this.isConnected ? 'Données réelles' : 'Données fictives'
            };
        } catch (error) {
            console.error('❌ Erreur lors de la récupération des données:', error);
            console.error('Stack:', error.stack);
            
            if (this.users.length === 0) {
                this.generateMockData();
            }
            
            return {
                success: false,
                error: error.message,
                usersCount: this.users.length,
                logsCount: this.attendanceLogs.length,
                processedCount: this.processedData.length,
                isRealData: false,
                message: 'Utilisation de données fictives suite à une erreur'
            };
        }
    }

    // Debug des correspondances d'ID
    debugIdMapping() {
        console.log('\n🔍 DEBUG ID MAPPING');
        
        // Tester avec différents formats d'ID
        const testIds = [
            '1', '01', '001',
            '40001', '4001',
            '12', '012',
            '40012', '400012',
            '56', '056',
            '40056', '400056'
        ];
        
        console.log('🧪 Tests de correspondance:');
        testIds.forEach(testId => {
            const emp = this.findEmployeeByLogUserId(testId);
            console.log(`  ${testId.padStart(10)} → ${emp ? '✅ ' + emp.name : '❌ NON TROUVÉ'}`);
        });
        
        // Analyser les IDs réels des logs
        const uniqueLogIds = new Set();
        this.attendanceLogs.forEach(log => {
            const id = log.uid;
            if (id !== '0') uniqueLogIds.add(id);
        });
        
        console.log(`\n📊 IDs uniques dans les logs (${uniqueLogIds.size}):`);
        const sortedIds = Array.from(uniqueLogIds).sort((a, b) => {
            // Trier numériquement si possible
            const numA = parseInt(a);
            const numB = parseInt(b);
            if (!isNaN(numA) && !isNaN(numB)) {
                return numA - numB;
            }
            return a.localeCompare(b);
        });
        
        let matchedCount = 0;
        let unmatchedCount = 0;
        
        sortedIds.slice(0, 30).forEach(id => {
            const emp = this.findEmployeeByLogUserId(id);
            if (emp) {
                console.log(`  ✅ ${id.padStart(10)} → ${emp.name}`);
                matchedCount++;
            } else {
                console.log(`  ❌ ${id.padStart(10)} → Inconnu`);
                unmatchedCount++;
            }
        });
        
        if (sortedIds.length > 30) {
            console.log(`  ... et ${sortedIds.length - 30} autres IDs`);
        }
        
        console.log(`\n📈 Résumé correspondances:`);
        console.log(`  Total IDs: ${sortedIds.length}`);
        console.log(`  Correspondances trouvées: ${matchedCount}`);
        console.log(`  Non trouvés: ${unmatchedCount}`);
        console.log(`  Taux de match: ${((matchedCount / sortedIds.length) * 100).toFixed(1)}%`);
        
        console.log('\n====================================\n');
    }

    generateMockData() {
        console.log('🎲 Génération de données fictives réalistes...');
        
        this.users = this.realEmployees.map(emp => ({
            uid: emp.uid,
            userid: emp.matricule,
            pointeuseUserId: emp.pointeuseUserId,
            name: emp.name,
            cardno: `EMP${emp.matricule.padStart(3, '0')}`,
            role: 0,
            password: '',
            deviceData: null
        }));

        this.attendanceLogs = [];
        const today = new Date();
        
        // Générer des données pour les 30 derniers jours
        for (let dayOffset = 0; dayOffset < 30; dayOffset++) {
            const date = new Date(today);
            date.setDate(date.getDate() - dayOffset);
            
            const dayOfWeek = date.getDay();
            if (dayOfWeek === 0 || dayOfWeek === 6) continue; // Sauter week-end
            
            this.realEmployees.forEach(emp => {
                if (Math.random() < 0.85) { // 85% de présence
                    // Utiliser l'ID de la pointeuse (400XX) pour les logs fictifs
                    const logUserId = emp.pointeuseUserId;
                    
                    // Arrivée (type 0) - entre 7h et 9h
                    const arrivalHour = 7 + Math.floor(Math.random() * 2);
                    const arrivalMinute = Math.floor(Math.random() * 60);
                    
                    this.attendanceLogs.push({
                        uid: logUserId,
                        userid: logUserId,
                        pointeuseUserId: logUserId,
                        timestamp: new Date(date.getFullYear(), date.getMonth(), date.getDate(), arrivalHour, arrivalMinute),
                        state: 1,
                        type: 0 // Arrivée
                    });
                    
                    // Départ (type 1) - entre 16h et 18h
                    const departureHour = 16 + Math.floor(Math.random() * 3);
                    const departureMinute = Math.floor(Math.random() * 60);
                    
                    this.attendanceLogs.push({
                        uid: logUserId,
                        userid: logUserId,
                        pointeuseUserId: logUserId,
                        timestamp: new Date(date.getFullYear(), date.getMonth(), date.getDate(), departureHour, departureMinute),
                        state: 1,
                        type: 1 // Départ
                    });
                }
            });
        }

        console.log(`✅ Données fictives générées: ${this.users.length} utilisateurs, ${this.attendanceLogs.length} logs`);
    }

    // Traitement avec logique intelligente
    processDataWithIntelligentLogic() {
        console.log('\n=== TRAITEMENT INTELLIGENT DES DONNÉES ===');
        console.log('📊 Logique: Premier pointage = Arrivée, Dernier pointage = Départ');
        
        // Créer des maps pour la correspondance
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
        
        console.log(`👥 Utilisateurs mappés: ${Object.keys(userMap).length}`);
        
        // Regrouper les logs par utilisateur et date
        const logsByUserAndDate = {};
        let totalLogsProcessed = 0;
        let totalUsersProcessed = 0;
        
        // Trier tous les logs par timestamp (chronologique)
        const sortedLogs = [...this.attendanceLogs].sort((a, b) => 
            a.timestamp.getTime() - b.timestamp.getTime()
        );
        
        sortedLogs.forEach(log => {
            if (!log || !log.uid || log.uid === '0' || !log.timestamp) {
                return;
            }

            const logUserId = log.uid.toString();
            
            // Trouver l'employé avec le système flexible
            const employee = this.findEmployeeByLogUserId(logUserId);
            
            if (!employee) {
                return;
            }
            
            const userUid = employee.uid;
            const user = userMap[userUid];
            
            if (!user) {
                return;
            }
            
            // Traiter la date
            const date = new Date(log.timestamp);
            const dateKey = date.toISOString().split('T')[0];
            const hour = date.getHours();
            const minute = date.getMinutes();
            const dayOfWeek = date.getDay();
            
            if (dayOfWeek === 0 || dayOfWeek === 6) return; // Sauter week-end
            
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
                    logUserId: logUserId // Stocker l'ID original du log
                };
                totalUsersProcessed++;
            }
            
            // Ajouter l'entrée
            logsByUserAndDate[userDateKey].entries.push({
                timestamp: log.timestamp,
                time: `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`,
                hour,
                minute,
                originalType: log.type, // Type original de la pointeuse
                type: log.type, // Sera modifié selon la logique intelligente
                logUserId: logUserId // ID original du log
            });
            
            totalLogsProcessed++;
        });

        console.log(`\n📊 Statistiques de regroupement:`);
        console.log(`  Logs traités: ${totalLogsProcessed}`);
        console.log(`  Enregistrements créés: ${Object.keys(logsByUserAndDate).length}`);
        console.log(`  Utilisateurs avec logs: ${totalUsersProcessed}`);
        
        // Appliquer la logique intelligente à chaque enregistrement
        this.processedData = Object.values(logsByUserAndDate).map(record => {
            // Trier les entrées par heure (du plus tôt au plus tard)
            record.entries.sort((a, b) => {
                if (a.hour !== b.hour) return a.hour - b.hour;
                return a.minute - b.minute;
            });

            // LOGIQUE INTELLIGENTE :
            // 1. Premier pointage de la journée = ARRIVÉE (type 0)
            // 2. Dernier pointage de la journée = DÉPART (type 1)
            // 3. Pointages intermédiaires = PASSAGES (type 2)
            
            if (record.entries.length === 0) {
                return record;
            }
            
            // Marquer le premier pointage comme arrivée
            const firstEntry = record.entries[0];
            record.arrivalTime = firstEntry.time;
            firstEntry.type = 0; // Arrivée
            firstEntry.typeLabel = 'Arrivée';
            
            // Calculer le statut basé sur l'heure d'arrivée
            const arrivalTotalMinutes = firstEntry.hour * 60 + firstEntry.minute;
            
            if (arrivalTotalMinutes < 8 * 60) { // Avant 8h
                record.status = 'À l\'heure';
            } else if (arrivalTotalMinutes <= 9 * 60) { // Avant 9h
                record.status = 'Présent';
            } else {
                record.status = 'En retard';
            }
            
            // Si plus d'un pointage, marquer le dernier comme départ
            if (record.entries.length > 1) {
                const lastEntry = record.entries[record.entries.length - 1];
                record.departureTime = lastEntry.time;
                lastEntry.type = 1; // Départ
                lastEntry.typeLabel = 'Départ';
                
                // Marquer les pointages intermédiaires comme passages
                for (let i = 1; i < record.entries.length - 1; i++) {
                    record.entries[i].type = 2; // Passage
                    record.entries[i].typeLabel = 'Passage';
                }
                
                // Calculer les heures travaillées
                const arrivalParts = record.arrivalTime.split(':');
                const departureParts = record.departureTime.split(':');
                
                const arrivalTotalMinutes = parseInt(arrivalParts[0]) * 60 + parseInt(arrivalParts[1]);
                const departureTotalMinutes = parseInt(departureParts[0]) * 60 + parseInt(departureParts[1]);
                
                let totalMinutes = departureTotalMinutes - arrivalTotalMinutes;
                
                // Soustraction de la pause déjeuner (1h) si plus de 4 heures travaillées
                if (totalMinutes > 240) {
                    totalMinutes -= 60;
                }
                
                totalMinutes = Math.max(0, totalMinutes);
                record.hoursWorked = (totalMinutes / 60).toFixed(2);
                
            } else {
                // Un seul pointage = juste une arrivée
                const today = new Date().toISOString().split('T')[0];
                if (record.date === today) {
                    record.status = 'En cours';
                }
                record.hoursWorked = '0.00';
            }
            
            // Journaliser le traitement (mode détaillé uniquement pour debug)
            if (record.entries.length > 0) {
                console.log(`\n📝 ${record.name} - ${record.date}:`);
                console.log(`  ${record.entries.length} pointage(s) détecté(s)`);
                record.entries.forEach((entry, i) => {
                    const position = i === 0 ? 'Premier' : 
                                   i === record.entries.length - 1 ? 'Dernier' : 'Intermédiaire';
                    const originalType = entry.originalType !== undefined ? `(type original: ${entry.originalType})` : '';
                    console.log(`  ${i+1}. ${entry.time} - ${position} → ${entry.typeLabel} ${originalType}`);
                });
                console.log(`  Résultat: ${record.arrivalTime} → ${record.departureTime || 'Pas de départ'} (${record.status})`);
                console.log(`  ID log: ${record.logUserId} → Employé: ${record.userId}`);
            }
            
            return record;
        });

        // Trier les données
        this.processedData.sort((a, b) => {
            if (a.date !== b.date) return b.date.localeCompare(a.date);
            return a.name.localeCompare(b.name);
        });

        console.log(`\n✅ Traitement terminé: ${this.processedData.length} enregistrements`);
        
        // Afficher un résumé quotidien
        this.printDailySummary();
        
        console.log('\n====================================\n');
    }

    // Méthode pour afficher un résumé quotidien
    printDailySummary() {
        console.log('\n=== RÉSUMÉ QUOTIDIEN DES POINTAGES ===');
        
        // Grouper par date
        const byDate = {};
        this.processedData.forEach(record => {
            if (!byDate[record.date]) {
                byDate[record.date] = [];
            }
            byDate[record.date].push(record);
        });
        
        // Trier les dates (plus récentes d'abord)
        const sortedDates = Object.keys(byDate).sort().reverse().slice(0, 5); // 5 derniers jours
        
        sortedDates.forEach(date => {
            console.log(`\n📅 ${date} (${this.getDayName(new Date(date).getDay())}):`);
            const records = byDate[date];
            let presentCount = 0;
            let absentCount = 0;
            
            records.forEach(record => {
                const status = record.status;
                if (status !== 'Absent') {
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
        
        // Statistiques globales
        const totalPresent = this.processedData.filter(r => r.status !== 'Absent').length;
        const totalAbsent = this.processedData.filter(r => r.status === 'Absent').length;
        const totalEmployees = this.users.length;
        const coverageRate = ((this.processedData.length / totalEmployees) * 100).toFixed(1);
        
        console.log('\n📈 STATISTIQUES GLOBALES:');
        console.log(`  Total employés: ${totalEmployees}`);
        console.log(`  Enregistrements traités: ${this.processedData.length}`);
        console.log(`  Taux de couverture: ${coverageRate}%`);
        console.log(`  Présences détectées: ${totalPresent}`);
        console.log(`  Absences: ${totalAbsent}`);
        
        console.log('\n=== FIN DU RÉSUMÉ ===\n');
    }

    // Ancienne méthode processData() - conservée pour compatibilité
    processData() {
        return this.processDataWithIntelligentLogic();
    }

    getDayName(dayIndex) {
        const days = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];
        return days[dayIndex];
    }

    getUsers() {
        return this.users;
    }

    getAttendanceLogs() {
        return this.attendanceLogs;
    }

    getProcessedData() {
        return this.processedData;
    }

    getEmployeeData(uid) {
        return this.processedData.filter(record => record.uid.toString() === uid.toString());
    }

    getDataByDate(date) {
        return this.processedData.filter(record => record.date === date);
    }

    getEmployeeDayData(uid, date) {
        return this.processedData.find(record => 
            record.uid.toString() === uid.toString() && record.date === date
        );
    }

    getSummary() {
        const workDays = this.processedData.filter(record => {
            const date = new Date(record.date);
            const dayOfWeek = date.getDay();
            return dayOfWeek !== 0 && dayOfWeek !== 6;
        });

        // Calculer les présences/absences
        const today = new Date().toISOString().split('T')[0];
        const todayData = this.getDataByDate(today);
        const presentToday = todayData.filter(r => r.status !== 'Absent').length;
        const absentToday = this.users.length - presentToday;

        return {
            totalUsers: this.users.length,
            totalLogs: this.attendanceLogs.length,
            totalDays: new Set(workDays.map(d => d.date)).size,
            totalRecords: this.processedData.length,
            presentToday: presentToday,
            absentToday: absentToday,
            lastUpdate: new Date().toISOString(),
            isConnected: this.isConnected,
            isRealData: this.isConnected,
            realUsersCount: this.realEmployees.length,
            matchedData: this.processedData.length > 0,
            idMatchingStats: this.getMatchingStats()
        };
    }

    getMatchingStats() {
        const uniqueLogIds = new Set();
        this.attendanceLogs.forEach(log => {
            const id = log.uid;
            if (id !== '0') uniqueLogIds.add(id);
        });
        
        let matched = 0;
        let unmatched = 0;
        
        uniqueLogIds.forEach(id => {
            const emp = this.findEmployeeByLogUserId(id);
            if (emp) matched++;
            else unmatched++;
        });
        
        return {
            uniqueLogIds: uniqueLogIds.size,
            matched: matched,
            unmatched: unmatched,
            matchRate: uniqueLogIds.size > 0 ? ((matched / uniqueLogIds.size) * 100).toFixed(1) + '%' : '0%'
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
            if (record.status === 'Présent' || record.status === 'À l\'heure') {
                stats.presentToday++;
                stats.absentToday--;
            } else if (record.status === 'En retard') {
                stats.lateToday++;
                stats.absentToday--;
            } else if (record.status === 'En cours') {
                stats.inProgressToday++;
                stats.absentToday--;
            }
        });

        const recordsWithHours = this.processedData.filter(r => r.hoursWorked && parseFloat(r.hoursWorked) > 0);
        if (recordsWithHours.length > 0) {
            const totalHours = recordsWithHours.reduce((sum, r) => sum + parseFloat(r.hoursWorked), 0);
            stats.averageHours = (totalHours / recordsWithHours.length).toFixed(2);
        }

        this.processedData.forEach(record => {
            if (!stats.byDay[record.date]) {
                stats.byDay[record.date] = {
                    date: record.date,
                    dayName: record.dayName,
                    present: 0,
                    absent: this.realEmployees.length,
                    late: 0,
                    inProgress: 0,
                    totalHours: 0,
                    averageHours: 0
                };
            }
            
            if (record.status === 'Présent' || record.status === 'À l\'heure') {
                stats.byDay[record.date].present++;
                stats.byDay[record.date].absent--;
            } else if (record.status === 'En retard') {
                stats.byDay[record.date].late++;
                stats.byDay[record.date].absent--;
            } else if (record.status === 'En cours') {
                stats.byDay[record.date].inProgress++;
                stats.byDay[record.date].absent--;
            }
            
            if (record.hoursWorked && parseFloat(record.hoursWorked) > 0) {
                stats.byDay[record.date].totalHours += parseFloat(record.hoursWorked);
            }
        });

        Object.keys(stats.byDay).forEach(date => {
            const dayStats = stats.byDay[date];
            const totalPresent = dayStats.present + dayStats.late;
            if (totalPresent > 0) {
                dayStats.averageHours = (dayStats.totalHours / totalPresent).toFixed(2);
            }
        });

        this.realEmployees.forEach(emp => {
            const empData = this.processedData.filter(r => r.uid === emp.uid);
            const empWithHours = empData.filter(r => r.hoursWorked && parseFloat(r.hoursWorked) > 0);
            
            stats.byEmployee[emp.uid] = {
                uid: emp.uid,
                name: emp.name,
                matricule: emp.matricule,
                pointeuseUserId: emp.pointeuseUserId,
                totalDays: empData.length,
                presentDays: empData.filter(r => r.status === 'Présent' || r.status === 'À l\'heure').length,
                lateDays: empData.filter(r => r.status === 'En retard').length,
                inProgressDays: empData.filter(r => r.status === 'En cours').length,
                totalHours: empWithHours.reduce((sum, r) => sum + parseFloat(r.hoursWorked), 0).toFixed(2),
                averageHours: empWithHours.length > 0 ? 
                    (empWithHours.reduce((sum, r) => sum + parseFloat(r.hoursWorked), 0) / empWithHours.length).toFixed(2) : 0
            };
        });

        return stats;
    }

    async testConnection() {
        try {
            await this.initialize();
            return {
                success: true,
                message: 'Connexion testée avec succès',
                isConnected: this.isConnected,
                ip: this.ip,
                port: this.port
            };
        } catch (error) {
            return {
                success: false,
                message: 'Échec de la connexion',
                error: error.message,
                isConnected: false
            };
        }
    }

    async disconnect() {
        if (this.isConnected && this.device) {
            try {
                await this.device.disconnect();
                this.isConnected = false;
                console.log('✅ Déconnecté de la pointeuse');
                return { success: true, message: 'Déconnecté avec succès' };
            } catch (error) {
                console.error('❌ Erreur lors de la déconnexion:', error.message);
                return { success: false, error: error.message };
            }
        }
        return { success: true, message: 'Non connecté' };
    }
}

module.exports = ZktecoService;