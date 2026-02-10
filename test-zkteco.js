const Zkteco = require("zkteco-js");

async function testZkteco() {
    console.log('=== TEST DE ZKTECO-JS ===');
    console.log('IP: 10.10.205.10');
    console.log('Port: 4370');
    console.log('==========================\n');
    
    const device = new Zkteco({
        ip: '10.10.205.10',
        port: 4370,
        timeout: 10000,
        connectionType: 'tcp'
    });
    
    try {
        console.log('1. Connexion à l\'appareil...');
        await device.connect();
        console.log('   ✅ Connecté');
        
        console.log('2. Informations de l\'appareil...');
        try {
            const deviceInfo = await device.getDeviceInfo();
            console.log('   ✅ Informations obtenues:');
            console.log(`      Nom: ${deviceInfo.deviceName || 'N/A'}`);
            console.log(`      Série: ${deviceInfo.serialNumber || 'N/A'}`);
            console.log(`      Plateforme: ${deviceInfo.platform || 'N/A'}`);
        } catch (infoError) {
            console.log(`   ℹ️ Infos non disponibles: ${infoError.message}`);
        }
        
        console.log('3. Récupération des utilisateurs...');
        const users = await device.getUsers();
        console.log(`   ✅ ${users.length} utilisateurs trouvés`);
        
        if (users.length > 0) {
            console.log('\n   Exemples d\'utilisateurs:');
            users.slice(0, 5).forEach((user, i) => {
                console.log(`   ${i+1}. ${user.name || 'Sans nom'} (UID: ${user.uid}, ID: ${user.userid})`);
            });
        }
        
        console.log('\n4. Récupération des pointages...');
        const attendances = await device.getAttendances();
        console.log(`   ✅ ${attendances.length} pointages trouvés`);
        
        if (attendances.length > 0) {
            console.log('\n   Exemples de pointages:');
            attendances.slice(0, 5).forEach((att, i) => {
                const date = att.attTime ? new Date(att.attTime).toLocaleString('fr-FR') : 'Date inconnue';
                console.log(`   ${i+1}. UID:${att.uid} - ${date} - Type:${att.verifyType || 'N/A'}`);
            });
            
            // Dates
            const dates = attendances.map(a => a.attTime ? new Date(a.attTime).toLocaleDateString('fr-FR') : null).filter(d => d);
            const uniqueDates = [...new Set(dates)];
            console.log(`\n   📅 Période: ${uniqueDates.length} jours différents`);
            if (uniqueDates.length > 0) {
                console.log(`      Du: ${uniqueDates[uniqueDates.length - 1]}`);
                console.log(`      Au: ${uniqueDates[0]}`);
            }
        }
        
        console.log('\n5. Déconnexion...');
        await device.disconnect();
        console.log('   ✅ Déconnecté');
        
        console.log('\n' + '='.repeat(40));
        console.log('✅ TEST RÉUSSI !');
        console.log('='.repeat(40));
        console.log(`Utilisateurs: ${users.length}`);
        console.log(`Pointages: ${attendances.length}`);
        
        return { success: true, users, attendances };
        
    } catch (error) {
        console.error('\n❌ ERREUR:', error.message);
        
        if (error.code) {
            console.log(`Code d'erreur: ${error.code}`);
        }
        
        console.log('\n🔧 Suggestions:');
        console.log('1. Vérifiez que la pointeuse est allumée');
        console.log('2. Vérifiez l\'adresse IP et le port');
        console.log('3. Essayez avec le logiciel ZKTeco officiel');
        console.log('4. Vérifiez le pare-feu Windows');
        
        return { success: false, error: error.message };
    }
}

// Exécuter le test
testZkteco().then(result => {
    if (!result.success) {
        console.log('\n⚠️ Le système utilisera des données fictives');
    }
}).catch(console.error);