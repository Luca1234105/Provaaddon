const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const fs = require('fs').promises;

const app = express();
const PORT = process.env.PORT || 7860; 
const LOG_FILE = 'activity.log.json'; 

// Chiave segreta caricata da Hugging Face Secrets
const MONITOR_KEY_SECRET = process.env.MONITOR_KEY;

// Configurazione server
app.use(express.static('public')); 
app.use(cors());
app.use(express.json());

// --- Funzioni di Log su File (Persistenza) ---

async function readLogs() {
    try {
        const data = await fs.readFile(LOG_FILE, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') {
            return [];
        }
        console.error("Errore lettura log:", error);
        return [];
    }
}

async function writeLog(entry) {
    const logs = await readLogs();
    logs.unshift({ timestamp: new Date().toISOString(), ...entry });
    const recentLogs = logs.slice(0, 50); // Mantiene solo gli ultimi 50
    await fs.writeFile(LOG_FILE, JSON.stringify(recentLogs, null, 2), 'utf8');
}


// --- FUNZIONE CENTRALE PER RECUPERARE DATI STREMIO ---
async function getStremioData(email, password) {
    if (!email || !password) {
        throw new Error("Email o Password mancanti.");
    }
    
    const STREMIO_API_BASE = 'https://api.strem.io/';
    const LOGIN_API_URL = `${STREMIO_API_BASE}api/login`;
    const ADDONS_GET_URL = `${STREMIO_API_BASE}api/addonCollectionGet`;

    try {
        // 1. LOGIN
        const loginResponse = await fetch(LOGIN_API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ "type": "Login", "email": email, "password": password, "facebook": false })
        });
        
        const loginData = await loginResponse.json(); 

        if (loginData.error || !loginData.result || !loginData.result.authKey) {
            throw new Error(loginData.error ? loginData.error.message : 'Credenziali non valide o accesso negato da Stremio.');
        }

        const authKey = loginData.result.authKey;

        // 2. RECUPERO ADDONS
        const addonsResponse = await fetch(ADDONS_GET_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ "type": "AddonCollectionGet", "authKey": authKey, "update": true })
        });
        const addonsData = await addonsResponse.json();

        if (addonsData.error || !addonsData.result) {
            throw new Error(addonsData.error ? addonsData.error.message : 'Impossibile recuperare gli addon.');
        }

        const finalAddons = addonsData.result.addons || [];
        return { addons: finalAddons, authKey: authKey };

    } catch (err) {
        throw err;
    }
}


// ------------------------------------------
// 1. ENDPOINT STANDARD LOGIN
// ------------------------------------------
app.post('/api/login', async (req, res) => {
    const email = req.body.email;
    try {
        const { password } = req.body;
        const data = await getStremioData(email, password);
        await writeLog({ type: 'login_success', email: email, message: 'Login utente riuscito.' });
        res.json(data);
    } catch (err) {
        await writeLog({ type: 'login_fail', email: email, message: err.message });
        res.status(401).json({ message: err.message });
    }
});


// ------------------------------------------
// 2. ENDPOINT ADMIN/MONITORAGGIO (INVARIATO)
// ------------------------------------------
app.post('/api/admin/monitor', async (req, res) => {
    const { adminKey, targetEmail } = req.body;

    if (!MONITOR_KEY_SECRET || adminKey !== MONITOR_KEY_SECRET) {
        await writeLog({ type: 'admin_monitor_fail', email: targetEmail, message: 'Tentativo di monitoraggio fallito: Chiave Admin non corretta.' });
        return res.status(401).json({ error: { message: "Chiave di monitoraggio non corretta." } });
    }

    if (!targetEmail) {
        await writeLog({ type: 'admin_monitor_fail', message: 'Tentativo di monitoraggio fallito: Email utente mancante.' });
        return res.status(400).json({ error: { message: "È necessaria l'email dell'utente da monitorare." } });
    }
    
    try {
        await writeLog({ type: 'admin_monitor_attempt', email: targetEmail, message: `Admin tenta il monitoraggio di ${targetEmail}. (Fallito per sicurezza Stremio)` });
        
        return res.status(403).json({ 
            error: { 
                message: `Impossibile accedere ai dati di ${targetEmail}. Per motivi di sicurezza Stremio richiede la password/AuthKey.` 
            } 
        });

    } catch (err) {
        await writeLog({ type: 'admin_monitor_error', email: targetEmail, message: err.message });
        res.status(500).json({ error: { message: "Errore interno durante il monitoraggio." } });
    }
});


// ------------------------------------------
// 3. ENDPOINT DI SALVATAGGIO (CORRETTO)
// ------------------------------------------
app.post('/api/set-addons', async (req, res) => {
    const STREMIO_API_BASE = 'https://api.strem.io/';
    const ADDONS_SET_URL = `${STREMIO_API_BASE}api/addonCollectionSet`;

    try {
        const { authKey, addons, email } = req.body;

        if (!authKey || !addons) {
            await writeLog({ type: 'addon_save_fail', email: email || 'sconosciuto', message: 'Salvataggio addon fallito: Chiave Auth o lista addon mancante.' });
            return res.status(400).json({ error: true, message: "Chiave di autenticazione o lista addon mancante." });
        }

        // --- CLONE PROFONDO E PULIZIA ---
        const addonsToSave = addons.map(addon => {
            const cleanAddon = JSON.parse(JSON.stringify(addon));
            
            // Rimuoviamo i campi temporanei Vue.js
            if (cleanAddon.isEditing) delete cleanAddon.isEditing;
            if (cleanAddon.newLocalName) delete cleanAddon.newLocalName;
            if (cleanAddon.manifest) {
                delete cleanAddon.manifest.newLocalName;
                delete cleanAddon.manifest.isEditing;
            }

            // Applica il nome modificato
            cleanAddon.manifest.name = addon.manifest.name;
            
            // Se manca l'ID nel manifesto (per nuovi addon), lo generiamo
            if (!cleanAddon.manifest.id) {
                 cleanAddon.manifest.id = `external-${Math.random().toString(36).substring(2, 9)}`;
            }

            return cleanAddon; 
        });
        // ---------------------------------------------------------------------

        const setResponse = await fetch(ADDONS_SET_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                "type": "AddonCollectionSet", 
                "authKey": authKey, 
                "addons": addonsToSave 
            })
        });

        const setData = await setResponse.json();

        if (setData.error) {
            await writeLog({ type: 'addon_save_fail', email: email || 'sconosciuto', message: `Salvataggio addon fallito: ${setData.error.message}` });
            throw new Error(setData.error.message || 'Errore Stremio durante il salvataggio degli addon.');
        }
        await writeLog({ type: 'addon_save_success', email: email || 'sconosciuto', message: `Addon salvati con successo. Numero: ${addons.length}` });
        res.json({ success: true, message: "Addon salvati con successo." });

    } catch (err) {
        res.status(500).json({ error: true, message: err.message });
    }
});


// --- NUOVO ENDPOINT: RECUPERA MANIFESTO (PER L'AGGIUNTA DI ADDON) ---
app.post('/api/fetch-manifest', async (req, res) => {
    const { manifestUrl } = req.body;

    if (!manifestUrl || !manifestUrl.startsWith('http')) {
        return res.status(400).json({ error: { message: "URL manifesto non valido." } });
    }

    try {
        const manifestResponse = await fetch(manifestUrl);
        
        // Verifica se il server ha restituito HTML (il problema del blocco)
        if (!manifestResponse.ok) {
            const errorText = await manifestResponse.text();
             if (errorText.trim().startsWith('<!DOCTYPE html>')) {
                throw new Error("Blocco di sicurezza: Il server ha restituito una pagina HTML anziché JSON.");
            }
            throw new Error(`Impossibile raggiungere il manifesto: Status ${manifestResponse.status}.`);
        }
        
        const manifest = await manifestResponse.json();

        if (!manifest.id || !manifest.version) {
            throw new Error("Manifesto non valido: mancano ID o Versione.");
        }
        
        res.json(manifest);
    } catch (err) {
        console.error('Errore nel recupero manifesto:', err.message);
        res.status(500).json({ error: { message: "Errore nel recupero del manifesto: " + err.message } });
    }
});


// ------------------------------------------
// 4. ENDPOINT PER I LOG (SICURO)
// ------------------------------------------
app.get('/api/logs', async (req, res) => {
    const adminKey = req.headers['x-admin-key'];

    if (!MONITOR_KEY_SECRET || adminKey !== MONITOR_KEY_SECRET) {
        return res.status(401).json({ error: { message: "Accesso ai log negato. Chiave Admin richiesta." } });
    }

    try {
        const logs = await readLogs();
        res.json(logs);
    } catch (error) {
        res.status(500).json({ error: { message: "Impossibile recuperare i log." } });
    }
});


// --- AVVIO DEL SERVER ---
app.listen(PORT, () => {
    console.log(`Server avviato correttamente sulla porta ${PORT}`);
});
