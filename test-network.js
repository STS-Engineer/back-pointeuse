const dns = require('dns');
const net = require('net');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

async function testNetwork() {
    const deviceIP = '10.10.205.10';
    
    console.log('=== Diagnostic Réseau pour la Pointeuse ===');
    console.log(`Adresse de la pointeuse: ${deviceIP}`);
    console.log('='.repeat(50));
    
    // Test 1: Résolution DNS (non nécessaire pour IP)
    console.log('\n1. Vérification de l\'adresse IP...');
    console.log(`   Adresse IP: ${deviceIP} (adresse directe, pas de DNS nécessaire)`);
    
    // Test 2: Ping
    console.log('\n2. Test de ping...');
    try {
        const { stdout, stderr } = await execPromise(`ping -n 4 ${deviceIP}`);
        if (stdout.includes('TTL=') || stdout.includes('temps=')) {
            console.log('   ✓ Ping réussi - la pointeuse répond');
            
            // Extraire le temps de réponse
            const timeMatch = stdout.match(/temps[=:]\s*(\d+)ms/) || stdout.match(/TTL[=:]\s*\d+.*temps[=:]\s*(\d+)ms/);
            if (timeMatch) {
                console.log(`   Temps de réponse: ${timeMatch[1]}ms`);
            }
        } else {
            console.log('   ✗ Ping échoué - pas de réponse');
        }
    } catch (error) {
        console.log('   ✗ Ping échoué:', error.message);
    }
    
    // Test 3: Ports ZKTeco
    console.log('\n3. Test des ports ZKTeco...');
    const ports = [
        { port: 4370, description: 'Port par défaut ZKTeco' },
        { port: 5050, description: 'Port alternatif 1' },
        { port: 5000, description: 'Port alternatif 2' },
        { port: 80, description: 'Port HTTP' },
        { port: 443, description: 'Port HTTPS' }
    ];
    
    for (const { port, description } of ports) {
        await testPort(deviceIP, port, description);
    }
    
    // Test 4: Informations réseau locales
    console.log('\n4. Informations réseau locales...');
    try {
        const { stdout } = await execPromise('ipconfig');
        const lines = stdout.split('\n');
        let foundInfo = false;
        
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (line.includes('Adresse IPv4') || line.includes('IPv4 Address')) {
                console.log(`   ${line.trim()}`);
                if (i + 1 < lines.length) {
                    const nextLine = lines[i + 1].trim();
                    if (nextLine.includes(':')) {
                        console.log(`   ${nextLine}`);
                        foundInfo = true;
                    }
                }
            }
        }
        
        if (!foundInfo) {
            console.log('   ℹ️ Exécutez "ipconfig" dans cmd pour voir vos infos réseau');
        }
    } catch (error) {
        console.log('   ℹ️ Impossible d\'obtenir les infos réseau');
    }
    
    console.log('\n5. Recommandations:');
    console.log('='.repeat(50));
    console.log('Si la pointeuse ne répond pas:');
    console.log('  1. Vérifiez l\'alimentation de la pointeuse');
    console.log('  2. Vérifiez le câble réseau');
    console.log('  3. Redémarrez la pointeuse');
    console.log('  4. Vérifiez l\'adresse IP sur l\'écran de la pointeuse');
    console.log('  5. Essayez de vous connecter avec le logiciel ZKTeco officiel');
    
    console.log('\nSi les ports ne répondent pas:');
    console.log('  1. Vérifiez les paramètres réseau de la pointeuse');
    console.log('  2. Vérifiez le pare-feu Windows');
    console.log('  3. Essayez de désactiver temporairement l\'antivirus');
    
    console.log('\nPour vérifier l\'IP sur la pointeuse:');
    console.log('  Menu → Communication → TCP/IP');
    console.log('  Notez l\'adresse IP et le Masque de sous-réseau');
}

async function testPort(ip, port, description) {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        const timeout = 3000;
        
        socket.setTimeout(timeout);
        
        socket.on('connect', () => {
            console.log(`   ✓ Port ${port} (${description}): OUVERT`);
            socket.destroy();
            resolve(true);
        });
        
        socket.on('timeout', () => {
            console.log(`   ✗ Port ${port} (${description}): TIMEOUT`);
            socket.destroy();
            resolve(false);
        });
        
        socket.on('error', (err) => {
            if (err.code === 'ECONNREFUSED') {
                console.log(`   ✗ Port ${port} (${description}): FERMÉ`);
            } else if (err.code === 'ENETUNREACH') {
                console.log(`   ✗ Port ${port} (${description}): RÉSEAU INACCESSIBLE`);
            } else {
                console.log(`   ✗ Port ${port} (${description}): ${err.code || 'ERREUR'}`);
            }
            socket.destroy();
            resolve(false);
        });
        
        socket.connect(port, ip);
    });
}

// Exécuter le test
testNetwork().catch(console.error);