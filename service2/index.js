import { chromium } from 'playwright-core';
import fs from 'fs/promises';
import crypto from 'crypto';
import cron from 'node-cron';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

// ==============================================================================
// SERVICE 2 : DÉMON DE RÉCUPÉRATION + DASHBOARD WEB
// ==============================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSION_FILE = '/app/shared/session.enc';
const HISTORY_FILE = '/app/shared/history.json';
const SECRET_KEY = process.env.SESSION_SECRET_KEY;

if (!SECRET_KEY || SECRET_KEY.length !== 32) {
    console.error("❌ ERREUR: SESSION_SECRET_KEY manquante ou invalide.");
    process.exit(1);
}

// --- Serveur Web (Express) ---
const app = express();
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/history', async (req, res) => {
    try {
        const data = await fs.readFile(HISTORY_FILE, 'utf-8');
        res.json(JSON.parse(data));
    } catch (e) {
        res.json([]); // Renvoie un tableau vide si le fichier n'existe pas encore
    }
});

app.post('/api/claim', async (req, res) => {
    console.log("⚡ Déclenchement manuel de la vérification demandé via l'API.");
    // Run in background so request doesn't timeout
    claimFreeGames(false).catch(e => console.error(e));
    res.json({ success: true, message: "Vérification lancée en arrière-plan !" });
});

app.post('/api/claim-all', async (req, res) => {
    console.log("⚡ Déclenchement manuel (TOUT GRATUIT) demandé via l'API.");
    claimFreeGames(true).catch(e => console.error(e));
    res.json({ success: true, message: "Vérification massive lancée en arrière-plan !" });
});

app.get('/api/user', async (req, res) => {
    try {
        const data = await fs.readFile('/app/shared/user.json', 'utf-8');
        res.json(JSON.parse(data));
    } catch (e) {
        res.json({ username: "En attente de connexion..." });
    }
});

let logClients = [];
function logSSE(msg) {
    const time = new Date().toLocaleTimeString('fr-FR');
    const formatted = `[${time}] ${msg}`;
    console.log(msg); // Affichage console standard
    logClients.forEach(c => c.write(`data: ${JSON.stringify({ msg: formatted })}\n\n`));
}

app.get('/api/logs/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    logClients.push(res);
    req.on('close', () => { logClients = logClients.filter(c => c !== res); });
});

app.listen(8080, () => {
    console.log("🌐 Dashboard Web accessible sur le port 8080");
});

// --- Utilitaires ---
function decryptData(encryptedData) {
    const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(SECRET_KEY), Buffer.from(encryptedData.iv, 'hex'));
    let decrypted = decipher.update(encryptedData.data, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return JSON.parse(decrypted);
}

function encryptData(data) {
    const text = JSON.stringify(data);
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(SECRET_KEY), iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return { iv: iv.toString('hex'), data: encrypted };
}

async function saveToHistory(game) {
    try {
        const raw = await fs.readFile(HISTORY_FILE, 'utf-8').catch(() => '[]');
        const history = JSON.parse(raw);
        // Eviter les doublons
        if (!history.find(g => g.url === game.url)) {
            history.unshift(game); // Ajoute au début
            await fs.writeFile(HISTORY_FILE, JSON.stringify(history, null, 2));
        }
    } catch (e) {
        console.error("Erreur sauvegarde historique:", e);
    }
}

// --- Routine Principale ---
async function claimFreeGames(claimAll = false) {
    logSSE(`\n[${new Date().toLocaleString()}] 🎮 Démarrage de la routine...`);
    let browser = null;

    try {
        const rawFile = await fs.readFile(SESSION_FILE, 'utf-8');
        const sessionData = decryptData(JSON.parse(rawFile));
        logSSE("🔓 Session déchiffrée avec succès.");

        browser = await chromium.launch({
            executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
            headless: true,
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox', 
                '--disable-blink-features=AutomationControlled',
                '--proxy-server=direct://',
                '--proxy-bypass-list=*'
            ]
        });

        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            locale: 'fr-FR',
            timezoneId: 'Europe/Paris'
        });

        if (sessionData.cookies) await context.addCookies(sessionData.cookies);

        const page = await context.newPage();
        await page.addInitScript((ls) => {
            for (const [k, v] of Object.entries(ls)) window.localStorage.setItem(k, v);
        }, sessionData.localStorage || {});

        // Vérifier si la session est valide
        await page.goto('https://store.epicgames.com/fr/free-games');
        
        let isLoggedIn = false;
        try {
            await page.waitForSelector('egs-navigation', { state: 'attached', timeout: 15000 });
            // Epic met un peu de temps à injecter l'état de connexion via JS
            for(let i=0; i<10; i++) {
                const val = await page.locator('egs-navigation').getAttribute('isloggedin').catch(()=>null);
                if (val === 'true') { 
                    isLoggedIn = true; 
                    break; 
                }
                await page.waitForTimeout(2000);
            }
        } catch (e) {}

        if (!isLoggedIn) throw new Error("SESSION_EXPIRED");

        // Extraction du nom d'utilisateur
        const username = await page.evaluate(() => {
            try {
                const profile = localStorage.getItem('mfe-profile-cache');
                if (profile) return JSON.parse(profile).displayName;
            } catch(e) {}
            return 'Connecté';
        }).catch(() => 'Connecté');
        
        await fs.writeFile('/app/shared/user.json', JSON.stringify({ username }));
        logSSE(`✅ Session valide (Utilisateur: ${username}). Lancement de la récupération...`);

        const urls = [];

        if (claimAll) {
            logSSE("🌐 Navigation silencieuse vers la collection Free-To-Play...");
            await page.goto('https://store.epicgames.com/fr/collection/free-to-play');
            await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
            
            logSSE("Scroll pour charger plus de jeux...");
            for(let i=0; i<15; i++) {
                await page.mouse.wheel(0, 2000);
                await page.waitForTimeout(500);
            }
            
            const game_loc = page.locator('a[role="link"]:has(span:text-is("Gratuit")), a[role="link"]:has(span:text-is("Free"))');
            const count = await game_loc.count();
            for (let i = 0; i < count; i++) {
                const href = await game_loc.nth(i).getAttribute('href');
                if (href) urls.push(`https://store.epicgames.com${href}`);
            }
            logSSE(`🔍 ${urls.length} jeux/extensions trouvés dans la section Free-To-Play.`);
        } else {
            logSSE("🌐 Navigation silencieuse vers Epic Games (Jeux de la semaine)...");
            await page.goto('https://store.epicgames.com/fr/free-games');
            await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});

            const game_loc = page.locator('a[role="link"]:has(span:text-matches("(?i)gratuit|free|100", "i"))');
            await game_loc.last().waitFor({ timeout: 10000 }).catch(() => logSSE('⚠ Aucun jeu gratuit trouvé sur la page via le texte.'));
            
            const count = await game_loc.count();
            for (let i = 0; i < count; i++) {
                const href = await game_loc.nth(i).getAttribute('href');
                if (href && href.includes('/p/')) urls.push(`https://store.epicgames.com${href}`);
            }
        }

        for (const url of urls) {
            logSSE(`▶ Traitement : ${url.split('/').pop()}`);
            await page.goto(url);
            await page.waitForLoadState('domcontentloaded');

            try {
                const continueBtn = page.locator('button:has-text("Continue"), button:has-text("Continuer")').first();
                if (await continueBtn.count() > 0) {
                    await continueBtn.click();
                    await page.waitForTimeout(2000);
                }
            } catch (e) {}

            // Extraction des infos pour le Dashboard Web
            const title = await page.locator('h1').first().innerText().catch(() => 'Jeu Inconnu');
            const coverUrl = await page.locator('meta[property="og:image"]').getAttribute('content').catch(() => null);

            const purchaseBtn = page.locator('button[data-testid="purchase-cta-button"]').first();
            await purchaseBtn.waitFor({ timeout: 10000 }).catch(() => {});
            
            const btnText = (await purchaseBtn.innerText()).toLowerCase().catch(() => '');
            
            if (btnText.includes('in library') || btnText.includes('dans la bibliothèque')) {
                logSSE('✔ Déjà possédé.');
                await saveToHistory({ title, url, coverUrl, date: new Date().toISOString(), status: 'Existant' });
                continue;
            } else if (btnText.includes('requires base game') || btnText.includes('jeu de base requis')) {
                logSSE('⚠ DLC bloqué sans jeu de base.');
                continue;
            } else if (btnText.includes('bientôt') || btnText.includes('soon')) {
                logSSE('⏳ Jeu bientôt disponible (Ignoré).');
                continue;
            } else if (!btnText) {
                logSSE('⚠ Bouton d\'obtention introuvable.');
                continue;
            }

            await purchaseBtn.click({ delay: 100 });

            try {
                const agreeBox = page.locator('input#agree');
                await agreeBox.waitFor({ timeout: 5000 });
                await agreeBox.check();
                await page.locator('button:has-text("Accept"), button:has-text("Accepter")').click();
            } catch (e) {}

            await page.waitForSelector('#webPurchaseContainer iframe', { timeout: 20000 });
            const iframe = page.frameLocator('#webPurchaseContainer iframe');
            await iframe.locator('button:has-text("Place Order"), button:has-text("Confirmer la commande")').click({ delay: 150 });

            try {
                await Promise.race([
                    page.locator('text=Thanks, text=Merci').waitFor({ state: 'attached', timeout: 30000 }),
                    page.waitForSelector('#webPurchaseContainer iframe', { state: 'hidden', timeout: 30000 })
                ]);
                logSSE(`🎉 Jeu récupéré avec succès : ${title}`);
                await saveToHistory({ title, url, coverUrl, date: new Date().toISOString(), status: 'Nouveau' });
            } catch (e) {
                logSSE(`❌ Échec de validation.`);
            }
        }

        // Rafraîchir et sauvegarder les cookies pour prolonger la session infiniment !
        try {
            const newCookies = await context.cookies();
            const newLs = await page.evaluate(() => Object.assign({}, window.localStorage));
            const encryptedSession = encryptData({ cookies: newCookies, localStorage: newLs });
            await fs.writeFile(SESSION_FILE, JSON.stringify(encryptedSession));
            logSSE("🔄 Session rafraîchie et prolongée avec succès.");
        } catch (e) {
            logSSE("⚠ Impossible de prolonger la session.");
        }

        logSSE("✅ Fin de la routine.");

    } catch (error) {
        if (error.code === 'ENOENT') {
            logSSE("❌ ERREUR : Fichier session.enc introuvable.");
        } else if (error.message === "SESSION_EXPIRED") {
            logSSE("❌ ERREUR : Session Epic Games expirée !");
        } else {
            logSSE("❌ Erreur d'exécution :", error.message);
        }
    } finally {
        if (browser) await browser.close();
    }
}

// Planification CRON
logSSE("🛡️ [SERVICE 2] Démon de récupération actif.");
cron.schedule('0 20 * * 4', () => claimFreeGames(false));

// Lancement au démarrage
async function initDaemon() {
    try {
        await fs.access(SESSION_FILE);
        logSSE("🔄 Vérification initiale au démarrage...");
        await claimFreeGames(false);
    } catch (e) {
        logSSE("ℹ️ Aucune session existante au démarrage. En attente du Service 1.");
    }
}
initDaemon();
