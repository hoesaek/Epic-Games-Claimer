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

function imageSSE(base64Str) {
    logClients.forEach(c => c.write(`data: ${JSON.stringify({ image: base64Str })}\n\n`));
}

let isProcessing = false;
let browserPage = null;

async function startLiveView(page) {
    browserPage = page;
    while (isProcessing && browserPage && !browserPage.isClosed()) {
        try {
            const buffer = await browserPage.screenshot({ type: 'jpeg', quality: 40 });
            imageSSE(buffer.toString('base64'));
        } catch(e) {}
        await new Promise(r => setTimeout(r, 1000)); // 1 FPS
    }
    imageSSE(''); // Cache le viewer quand fini
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
            locale: 'en-US', // Enforce english to match Vogler's locators
            timezoneId: 'America/New_York'
        });

        if (sessionData.cookies) {
            let cookies = sessionData.cookies.filter(c => !['OptanonAlertBoxClosed', 'HasAcceptedAgeGates'].includes(c.name));
            // Cookies magiques pour outrepasser les bannières et les vérifications d'âge (18+)
            cookies.push({ name: 'OptanonAlertBoxClosed', value: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(), domain: '.epicgames.com', path: '/' });
            cookies.push({ name: 'HasAcceptedAgeGates', value: 'USK:9007199254740991,general:18,EPIC SUGGESTED RATING:18', domain: 'store.epicgames.com', path: '/' });
            await context.addCookies(cookies);
        }

        const page = await context.newPage();
        
        // Démarrer le stream vidéo Live View !
        isProcessing = true;
        startLiveView(page);

        await page.addInitScript((ls) => {
            for (const [k, v] of Object.entries(ls)) window.localStorage.setItem(k, v);
        }, sessionData.localStorage || {});

        // Vérifier si la session est valide en visitant la page de compte
        logSSE("[DEBUG] Test d'accès sécurisé pour vérifier la session...");
        await page.goto('https://www.epicgames.com/account/personal?lang=en-US', { waitUntil: 'domcontentloaded' });
        
        // Si les cookies sont invalides, Epic redirige automatiquement vers /id/login
        await page.waitForTimeout(5000);
        if (page.url().includes('/id/login')) {
            throw new Error("SESSION_EXPIRED");
        }

        logSSE("[DEBUG] Session confirmée. Retour à la boutique...");
        await page.goto('https://store.epicgames.com/en-US/');
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
            await page.goto('https://store.epicgames.com/en-US/collection/free-to-play');
            await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
            
            logSSE("[DEBUG] Scroll pour charger plus de jeux...");
            for(let i=0; i<15; i++) {
                await page.mouse.wheel(0, 2000);
                await page.waitForTimeout(500);
            }
            
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
            await page.goto('https://store.epicgames.com/en-US/free-games');
            await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});

            logSSE("[DEBUG] Recherche des jeux 'Free Now'...");
            const game_loc = page.locator('a:has(span:text-is("Free Now"))');
            await game_loc.last().waitFor().catch(() => logSSE("[WARNING] Aucun jeu gratuit disponible ou timeout."));
            
            try {
                const handles = await game_loc.elementHandles();
                const urlSlugs = await Promise.all(handles.map(a => a.getAttribute('href')));
                const uniqueUrls = [...new Set(urlSlugs.map(s => 'https://store.epicgames.com' + s))];
                urls.push(...uniqueUrls);
                logSSE(`[DEBUG] ${uniqueUrls.length} jeux gratuits trouvés.`);
            } catch(e) {}
        }

        for (const url of urls) {
            logSSE(`[DEBUG] Chargement de la page (URL: ${url})...`);
            await page.goto(url);

            const purchaseBtn = page.locator('button[data-testid="purchase-cta-button"] >> :has-text("e"), :has-text("i")').first();
            await purchaseBtn.waitFor().catch(() => {});
            let btnText = '';
            try { btnText = (await purchaseBtn.innerText()).toLowerCase(); } catch (e) {}
            logSSE(`[DEBUG] Texte du bouton d'achat : "${btnText}"`);

            // Age Gate 18+ handling from Vogler
            if (await page.locator('button:has-text("Continue")').count() > 0) {
                logSSE(`[DEBUG] Avertissement d'âge (18+) détecté. Validation...`);
                if (await page.locator('[data-testid="AgeSelect"]').count()) {
                    await page.locator('#month_toggle').click();
                    await page.locator('#month_menu li:has-text("01")').click();
                    await page.locator('#day_toggle').click();
                    await page.locator('#day_menu li:has-text("01")').click();
                    await page.locator('#year_toggle').click();
                    await page.locator('#year_menu li:has-text("1987")').click();
                }
                await page.click('button:has-text("Continue")', { delay: 111 });
                await page.waitForTimeout(2000);
            }

            const title = await page.locator('h1').first().innerText().catch(() => 'Jeu Inconnu');
            logSSE(`[INFO] --- Analyse du jeu : ${title} ---`);
            const coverUrl = await page.locator('meta[property="og:image"]').getAttribute('content').catch(() => null);

            if (btnText === 'in library') {
                logSSE('[INFO] Déjà possédé. (Passé)');
                await saveToHistory({ title, url, coverUrl, date: new Date().toISOString(), status: 'Existant' });
            } else if (btnText === 'requires base game') {
                logSSE('[WARNING] DLC bloqué sans jeu de base. (Passé)');
            } else if (!btnText) {
                logSSE('[WARNING] Bouton d\'obtention introuvable.');
            } else {
                logSSE(`[DEBUG] Tentative de clic sur le bouton d'obtention...`);
                await purchaseBtn.click({ delay: 11 });

                // Handle random modals
                page.click('button:has-text("Continue")').catch(() => {});
                page.click('button:has-text("Yes, buy now")').catch(() => {});

                // Accept EULA if needed
                page.locator(':has-text("end user license agreement")').waitFor().then(async () => {
                    logSSE(`[DEBUG] Clic sur Accepter (EULA)...`);
                    await page.locator('input#agree').check();
                    await page.locator('button:has-text("Accept")').click();
                }).catch(() => {});

                logSSE(`[DEBUG] Attente de la modale de confirmation de commande (iframe)...`);
                await page.waitForSelector('#webPurchaseContainer iframe');
                const iframe = page.frameLocator('#webPurchaseContainer iframe');
                
                // Laisse le temps à l'application React interne de s'afficher
                await page.waitForTimeout(4000);

                if (await iframe.locator(':has-text("unavailable in your region")').count() > 0) {
                    logSSE('[ERROR] Produit indisponible dans votre région.');
                    continue;
                }
                
                // Détection de Captcha Epic Games
                iframe.locator('#h_captcha_challenge_checkout_free_prod iframe').waitFor({ timeout: 5000 }).then(() => {
                    logSSE(`[ERROR] 🛑 CAPTCHA détecté ! Epic Games bloque car trop de tentatives. Changez d'IP ou réessayez demain.`);
                }).catch(() => {});

                try {
                    const euCheckbox = iframe.locator('.payment-checkbox, input[type="checkbox"]').first();
                    if (await euCheckbox.count() > 0) {
                        logSSE(`[DEBUG] Checkbox EU détectée dans l'iframe, on la coche.`);
                        await euCheckbox.check({ force: true }).catch(() => {});
                        await page.waitForTimeout(500);
                    }
                } catch(e) {}

                try {
                    const checkoutBtn = iframe.locator('button.payment-btn:not(:has(.payment-loading--loading)), button').filter({ hasText: /(Place Order|Add to library)/i }).locator(':not(:has(.payment-loading--loading))').first();
                    await checkoutBtn.waitFor({ state: 'visible', timeout: 15000 });
                    await checkoutBtn.click({ delay: 11 });
                    logSSE(`[DEBUG] Bouton de validation de commande cliqué.`);
                } catch(e) {
                    logSSE(`[ERROR] Impossible de cliquer sur le bouton de validation de commande.`);
                }

                // EU Accept Button
                const btnAgree = iframe.locator('button:has-text("I Accept")');
                btnAgree.waitFor().then(async () => {
                    await page.waitForTimeout(1000); // Petit délai pour laisser l'animation Epic se terminer
                    logSSE(`[DEBUG] Bouton I Accept (EU) détecté, clic...`);
                    return btnAgree.click({ delay: 50 });
                }).catch(() => {});

                try {
                    await page.locator('text=Thanks for your order!').waitFor({ state: 'attached', timeout: 30000 });
                    logSSE(`[SUCCESS] Jeu récupéré avec succès : ${title}`);
                    await saveToHistory({ title, url, coverUrl, date: new Date().toISOString(), status: 'Nouveau' });
                } catch (e) {
                    logSSE(`[ERROR] Échec de validation du paiement gratuit.`);
                    
                    // DEBUGGING: Capture d'écran et lecture des erreurs
                    try {
                        await page.screenshot({ path: '/app/shared/debug_error_payment.png', fullPage: true });
                        logSSE(`[INFO] 📸 Capture d'écran de l'erreur sauvegardée dans session_data/debug_error_payment.png`);
                    } catch(err) {}

                    try {
                        const errText = await iframe.locator('.payment-alert, .payment__errors').first().innerText({ timeout: 2000 });
                        if (errText) logSSE(`[ERROR] Message d'erreur Epic Games : "${errText}"`);
                    } catch(err) {}
                }
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
        isProcessing = false; // Arrête le stream Live View
        browserPage = null;
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
