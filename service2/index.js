import { chromium } from 'playwright-core';
import fs from 'fs/promises';
import crypto from 'crypto';
import cron from 'node-cron';

// ==============================================================================
// SERVICE 2 : DÉMON DE RÉCUPÉRATION (BACKGROUND SERVER)
// ==============================================================================

const SESSION_FILE = '/app/shared/session.enc';
const SECRET_KEY = process.env.SESSION_SECRET_KEY;

if (!SECRET_KEY || SECRET_KEY.length !== 32) {
    console.error("❌ ERREUR: SESSION_SECRET_KEY manquante ou invalide.");
    process.exit(1);
}

// --- Utilitaire de déchiffrement ---
function decryptData(encryptedData) {
    const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(SECRET_KEY), Buffer.from(encryptedData.iv, 'hex'));
    let decrypted = decipher.update(encryptedData.data, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return JSON.parse(decrypted);
}

async function claimFreeGames() {
    console.log(`\n[${new Date().toLocaleString()}] 🎮 Démarrage de la routine...`);
    let browser = null;

    try {
        // 1. Lecture et déchiffrement de la session
        const rawFile = await fs.readFile(SESSION_FILE, 'utf-8');
        const sessionData = decryptData(JSON.parse(rawFile));
        console.log("🔓 Session déchiffrée avec succès.");

        // 2. Lancement Headless (Playwright-core + Chromium Alpine)
        browser = await chromium.launch({
            executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled']
        });

        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            locale: 'fr-FR',
            timezoneId: 'Europe/Paris'
        });

        // 3. Injection Session
        if (sessionData.cookies) await context.addCookies(sessionData.cookies);

        const page = await context.newPage();
        await page.addInitScript((ls) => {
            for (const [k, v] of Object.entries(ls)) window.localStorage.setItem(k, v);
        }, sessionData.localStorage || {});

        // 4. Navigation
        console.log("🌐 Navigation silencieuse vers Epic Games...");
        await page.goto('https://store.epicgames.com/fr/free-games');
        await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});

        // 5. Check Expiration
        const isLoggedIn = await page.locator('egs-navigation').getAttribute('isloggedin').catch(() => 'false');
        if (isLoggedIn !== 'true') throw new Error("SESSION_EXPIRED");
        
        console.log("✅ Session valide. Lancement de l'algorithme de récupération...");

        // 6. Récupération
        const game_loc = page.locator('a:has(span:text-is("Free Now")), a:has(span:text-is("Gratuit maintenant"))');
        await game_loc.last().waitFor({ timeout: 10000 }).catch(() => console.log('⚠ Aucun jeu trouvé.'));
        
        const count = await game_loc.count();
        const urls = [];
        for (let i = 0; i < count; i++) {
            const href = await game_loc.nth(i).getAttribute('href');
            if (href) urls.push(`https://store.epicgames.com${href}`);
        }

        for (const url of urls) {
            console.log(`▶ Traitement : ${url.split('/').pop()}`);
            await page.goto(url);
            await page.waitForLoadState('domcontentloaded');

            try {
                const continueBtn = page.locator('button:has-text("Continue"), button:has-text("Continuer")').first();
                if (await continueBtn.count() > 0) {
                    await continueBtn.click();
                    await page.waitForTimeout(2000);
                }
            } catch (e) {}

            const purchaseBtn = page.locator('button[data-testid="purchase-cta-button"]').first();
            await purchaseBtn.waitFor({ timeout: 10000 }).catch(() => {});
            
            const btnText = (await purchaseBtn.innerText()).toLowerCase();
            if (btnText.includes('in library') || btnText.includes('dans la bibliothèque')) {
                console.log('✔ Déjà possédé.');
                continue;
            } else if (btnText.includes('requires base game')) {
                console.log('⚠ DLC bloqué sans jeu de base.');
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
                console.log(`🎉 Jeu récupéré avec succès !`);
            } catch (e) {
                console.log(`❌ Échec de validation.`);
            }
        }
        console.log("✅ Fin de la routine.");

    } catch (error) {
        if (error.code === 'ENOENT') {
            console.error("❌ ERREUR : Fichier session.enc introuvable.");
            console.error("👉 Lancez le Service 1 (docker compose run --rm service1-login) pour vous connecter.");
        } else if (error.message === "SESSION_EXPIRED") {
            console.error("❌ ERREUR : Session Epic Games expirée !");
            console.error("👉 Relancez le Service 1 pour rafraîchir vos cookies.");
        } else {
            console.error("❌ Erreur d'exécution :", error.message);
        }
    } finally {
        if (browser) await browser.close();
    }
}

// Planification CRON
console.log("🛡️ [SERVICE 2] Démon de récupération actif.");
console.log("🕒 Routine planifiée tous les jeudis à 20h00.");

cron.schedule('0 20 * * 4', claimFreeGames);

// Lancement immédiat au démarrage
claimFreeGames();
