import { chromium } from 'playwright-core';
import fs from 'fs/promises';
import crypto from 'crypto';

// ==============================================================================
// SERVICE 1 : AUTHENTIFICATION & CHIFFREMENT
// ==============================================================================

const SESSION_FILE = '/app/shared/session.enc'; // Fichier dans le volume partagé
const SECRET_KEY = process.env.SESSION_SECRET_KEY; // Clé depuis le .env

if (!SECRET_KEY || SECRET_KEY.length !== 32) {
    console.error("❌ ERREUR: SESSION_SECRET_KEY manquante ou invalide (doit faire 32 caractères).");
    process.exit(1);
}

// --- Utilitaire de chiffrement ---
function encryptData(text) {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(SECRET_KEY), iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return { iv: iv.toString('hex'), data: encrypted };
}

async function login() {
    console.log("🚀 [SERVICE 1] Démarrage du navigateur (Port de debug 9222)...");

    // Lancement de Chromium. Dans Docker, afficher une fenêtre native est complexe.
    // L'astuce "DevOps" : on lance en Headless mais avec un port de debug distant !
    const browser = await chromium.launch({
        executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
        headless: true, // Doit être true dans Docker sans X11
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-blink-features=AutomationControlled',
            '--remote-debugging-address=0.0.0.0', // Permet la connexion distante
            '--remote-debugging-port=9222',
            '--remote-allow-origins=*'
        ]
    });

    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });

    const page = await context.newPage();

    try {
        console.log("\n=======================================================");
        console.log("🌐 URL Epic Games ouverte !");
        console.log("👉 ACTION REQUISE : Le conteneur Docker tourne.");
        console.log("👉 Si vous n'avez pas de redirection d'affichage X11 :");
        console.log("   Ouvrez votre navigateur local et allez sur : http://[IP_DE_VOTRE_SERVEUR]:9222");
        console.log("   Vous pourrez interagir avec la page Epic Games depuis là !");
        console.log("=======================================================\n");

        await page.goto('https://www.epicgames.com/id/login?redirectUrl=https%3A%2F%2Fstore.epicgames.com%2Ffr%2F');

        // On attend la réussite de la connexion (changement d'URL)
        await page.waitForURL('**store.epicgames.com/**', { timeout: 0 });
        console.log("✅ Connexion détectée ! Capture de la session dans 5s...");
        await page.waitForTimeout(5000);

        // Aspiration des données sensibles
        const cookies = await context.cookies();
        const localStorageData = await page.evaluate(() => JSON.stringify(window.localStorage));

        const sessionPayload = JSON.stringify({
            timestamp: new Date().toISOString(),
            cookies,
            localStorage: JSON.parse(localStorageData || '{}')
        });

        // Chiffrement de la session
        const encryptedSession = encryptData(sessionPayload);
        await fs.writeFile(SESSION_FILE, JSON.stringify(encryptedSession));

        console.log(`🔐 Session chiffrée avec succès et sauvegardée dans le volume partagé (${SESSION_FILE}).`);

    } catch (error) {
        console.error("❌ Erreur :", error);
    } finally {
        await browser.close();
        console.log("🛑 Service 1 terminé.");
    }
}

login();
