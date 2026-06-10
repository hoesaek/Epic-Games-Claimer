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
    logSSE(`\n[INFO] Démarrage de la routine...`);
    let browser = null;

    try {
        logSSE("[DEBUG] Lecture du fichier de session...");
        const rawFile = await fs.readFile(SESSION_FILE, 'utf-8');
        const sessionData = decryptData(JSON.parse(rawFile));
        logSSE("[INFO] Session déchiffrée avec succès.");

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

        // Vérifier si la session est valide en visitant la page de compte
        logSSE("[DEBUG] Test d'accès sécurisé pour vérifier la session...");
        await page.goto('https://www.epicgames.com/account/personal', { waitUntil: 'domcontentloaded' });
        
        // Si les cookies sont invalides, Epic redirige automatiquement vers /id/login
        await page.waitForTimeout(5000);
        if (page.url().includes('/id/login')) {
            throw new Error("SESSION_EXPIRED");
        }

        logSSE("[DEBUG] Session confirmée. Retour à la boutique...");
        await page.goto('https://store.epicgames.com/fr/');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(3000);

        // Extraction du nom d'utilisateur
        const username = await page.evaluate(() => {
            try {
                const profile = localStorage.getItem('mfe-profile-cache');
                if (profile) return JSON.parse(profile).displayName;
            } catch(e) {}
            return 'Connecté';
        }).catch(() => 'Connecté');
        
        await fs.writeFile('/app/shared/user.json', JSON.stringify({ username }));
        logSSE(`[INFO] Session valide (Utilisateur: ${username}). Lancement de la récupération...`);

        const urls = [];

        if (claimAll) {
            logSSE("[INFO] Navigation silencieuse vers la collection Free-To-Play...");
            await page.goto('https://store.epicgames.com/fr/collection/free-to-play');
            await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
            
            logSSE("[DEBUG] Scroll pour charger plus de jeux...");
            for(let i=0; i<15; i++) {
                await page.mouse.wheel(0, 2000);
                await page.waitForTimeout(500);
            }
            
            // Extraction globale sans sélecteurs CSS stricts qui cassent tout le temps
            const allLinks = await page.evaluate(() => {
                return Array.from(document.querySelectorAll('a'))
                    .filter(a => a.href && a.href.includes('/p/'))
                    .map(a => a.href);
            });
            const uniqueUrls = [...new Set(allLinks)];
            urls.push(...uniqueUrls);
            logSSE(`[INFO] ${urls.length} jeux/extensions trouvés dans la section Free-To-Play.`);
        } else {
            logSSE("[INFO] Navigation silencieuse vers Epic Games (Jeux de la semaine)...");
            await page.goto('https://store.epicgames.com/fr/free-games');
            await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});

            logSSE("[DEBUG] Extraction des liens de la page principale...");
            // Extraction robuste par Javascript
            const allLinks = await page.evaluate(() => {
                return Array.from(document.querySelectorAll('a'))
                    .filter(a => a.href && a.href.includes('/p/'))
                    .map(a => a.href);
            });
            const uniqueUrls = [...new Set(allLinks)];
            urls.push(...uniqueUrls);
            logSSE(`[DEBUG] ${uniqueUrls.length} liens uniques trouvés.`);
        }

        for (const url of urls) {
            logSSE(`[DEBUG] Chargement de la page (URL: ${url})...`);
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
            logSSE(`[INFO] --- Analyse du jeu : ${title} ---`);
            const coverUrl = await page.locator('meta[property="og:image"]').getAttribute('content').catch(() => null);

            const purchaseBtn = page.locator('button[data-testid="purchase-cta-button"]').first();
            await purchaseBtn.waitFor({ timeout: 10000 }).catch(() => {});
            
            let btnText = '';
            try {
                btnText = await purchaseBtn.innerText();
                btnText = btnText ? btnText.toLowerCase() : '';
            } catch (e) {
                logSSE(`[DEBUG] Impossible de lire le texte du bouton : ${e.message}`);
            }
            logSSE(`[DEBUG] Texte du bouton d'achat : "${btnText}"`);
            
            if (btnText.includes('in library') || btnText.includes('dans la bibliothèque')) {
                logSSE('[INFO] Déjà possédé. (Passé)');
                await saveToHistory({ title, url, coverUrl, date: new Date().toISOString(), status: 'Existant' });
                continue;
            } else if (btnText.includes('requires base game') || btnText.includes('jeu de base requis')) {
                logSSE('[WARNING] DLC bloqué sans jeu de base. (Passé)');
                continue;
            } else if (btnText.includes('bientôt') || btnText.includes('soon')) {
                logSSE('[INFO] Jeu bientôt disponible. (Ignoré)');
                continue;
            } else if (!btnText) {
                logSSE('[WARNING] Bouton d\'obtention introuvable.');
                continue;
            } else if (!btnText.includes('obtenir') && !btnText.includes('get')) {
                logSSE(`[INFO] Jeu payant ou invalide (Bouton: "${btnText}"). (Ignoré)`);
                continue;
            }

            logSSE(`[DEBUG] Tentative de clic sur le bouton d'obtention...`);

            await purchaseBtn.click({ delay: 100 });

            // Gestion de l'Age Gate (18+) qui peut apparaître juste après avoir cliqué sur "Obtenir"
            try {
                const ageGateBtn = page.locator('button').filter({ hasText: /^(continue|continuer)$/i }).first();
                await ageGateBtn.waitFor({ state: 'visible', timeout: 4000 });
                logSSE(`[DEBUG] Avertissement d'âge (18+) détecté. Validation...`);
                await ageGateBtn.click();
            } catch (e) {}

            try {
                logSSE(`[DEBUG] Clic sur Accepter (EULA) si présent...`);
                const agreeBox = page.locator('input#agree');
                await agreeBox.waitFor({ timeout: 3000 });
                await agreeBox.check();
                await page.locator('button:has-text("Accept"), button:has-text("Accepter")').click();
            } catch (e) {}

            logSSE(`[DEBUG] Attente de la modale de confirmation de commande (iframe)...`);
            await page.waitForSelector('#webPurchaseContainer iframe', { timeout: 20000 });
            const iframe = page.frameLocator('#webPurchaseContainer iframe');
            
            await page.waitForTimeout(4000); // Laisse le temps à l'application React interne de s'afficher

            // Gestion de la case à cocher (EU Refund Agreement) DANS l'iframe
            try {
                const euCheckbox = iframe.locator('.payment-checkbox, input[type="checkbox"]').first();
                if (await euCheckbox.count() > 0) {
                    logSSE(`[DEBUG] Checkbox EU détectée dans l'iframe, on la coche.`);
                    await euCheckbox.click({ force: true });
                    await page.waitForTimeout(500);
                }
            } catch(e) {}
            
            try {
                const btnTexts = await iframe.locator('button').evaluateAll(btns => btns.map(b => b.innerText.trim()).filter(t => t).join(' | '));
                logSSE(`[DEBUG] Boutons détectés dans l'iframe : [${btnTexts}]`);
            } catch(e) {}

            const confirmBtn = iframe.locator('button').filter({ hasText: /(place order|confirmer|passer|add to library|ajouter|confirm|get)/i }).first();
            const fallbackBtn = iframe.locator('button.payment-btn').first();

            try {
                await confirmBtn.waitFor({ state: 'visible', timeout: 15000 });
                await confirmBtn.click({ delay: 150 });
            } catch (e) {
                logSSE(`[WARNING] Bouton par texte introuvable. Essai du bouton fallback (payment-btn)...`);
                await fallbackBtn.waitFor({ state: 'visible', timeout: 15000 });
                await fallbackBtn.click({ delay: 150 });
            }

            try {
                logSSE(`[DEBUG] Attente du message de succès ou de la fermeture de la modale...`);
                await Promise.race([
                    page.locator('text=Thanks, text=Merci').waitFor({ state: 'attached', timeout: 30000 }),
                    page.waitForSelector('#webPurchaseContainer iframe', { state: 'hidden', timeout: 30000 })
                ]);
                logSSE(`[SUCCESS] Jeu récupéré avec succès : ${title}`);
                await saveToHistory({ title, url, coverUrl, date: new Date().toISOString(), status: 'Nouveau' });
            } catch (e) {
                logSSE(`[ERROR] Échec de validation du paiement gratuit.`);
            }
        }

        // Rafraîchir et sauvegarder les cookies pour prolonger la session infiniment !
        try {
            logSSE("[DEBUG] Sauvegarde et rafraîchissement des cookies...");
            const newCookies = await context.cookies();
            const newLs = await page.evaluate(() => Object.assign({}, window.localStorage));
            const encryptedSession = encryptData({ cookies: newCookies, localStorage: newLs });
            await fs.writeFile(SESSION_FILE, JSON.stringify(encryptedSession));
            logSSE("[INFO] Session rafraîchie et prolongée avec succès.");
        } catch (e) {
            logSSE("[WARNING] Impossible de prolonger la session.");
        }

        logSSE("[INFO] Fin de la routine.");

    } catch (error) {
        if (error.code === 'ENOENT') {
            logSSE("[ERROR] Fichier session.enc introuvable.");
        } else if (error.message === "SESSION_EXPIRED") {
            logSSE("[ERROR] Session Epic Games expirée !");
        } else {
            logSSE("[ERROR] Erreur d'exécution : " + error.message);
        }
    } finally {
        logSSE("[DEBUG] Fermeture du navigateur...");
        if (browser) await browser.close();
    }
}

// Planification CRON
logSSE("[INFO] Démon de récupération actif (CRON prévu tous les jeudis).");
cron.schedule('0 20 * * 4', () => claimFreeGames(false));

// Lancement au démarrage
async function initDaemon() {
    try {
        await fs.access(SESSION_FILE);
        logSSE("[INFO] Vérification initiale au démarrage...");
        await claimFreeGames(false);
    } catch (e) {
        logSSE("[INFO] Aucune session existante au démarrage. En attente du Service 1.");
    }
}
initDaemon();
