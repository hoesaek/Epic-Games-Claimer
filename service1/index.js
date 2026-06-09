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
    console.log("🚀 [SERVICE 1] Démarrage du navigateur Chrome dans la session VNC...");
    const browser = await chromium.launch({
        executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
        headless: false, // Affiché dans l'interface VNC
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-blink-features=AutomationControlled',
            '--proxy-server=direct://',
            '--proxy-bypass-list=*',
            '--start-maximized'
        ]
    });

    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });

    const page = await context.newPage();

    try {
        await page.goto('https://www.epicgames.com/id/login?redirectUrl=https%3A%2F%2Fstore.epicgames.com%2Ffr%2F', { waitUntil: 'domcontentloaded', timeout: 60000 });
        
        console.log("\n=======================================================");
        console.log("🌐 Page de connexion Epic Games ouverte !");
        console.log("👉 ACTION REQUISE : Le conteneur Docker tourne.");
        console.log("👉 Allez sur l'interface VNC : http://[IP_DE_VOTRE_SERVEUR]:6080/vnc.html");
        console.log("   Connectez-vous manuellement dans le navigateur affiché.");
        console.log("=======================================================\n");

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
