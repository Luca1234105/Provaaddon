const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 7860; 

// Serve i file statici (risolve "Cannot GET /")
app.use(express.static('public')); 
app.use(cors());
app.use(express.json());

// Funzione di autenticazione e recupero dati da Stremio
async function getStremioData(email, password) {
    if (!email || !password) {
        throw new Error("Email o Password mancanti.");
    }

    const STREMIO_API_BASE = 'https://api.strem.io/';
    const LOGIN_API_URL = `${STREMIO_API_BASE}api/login`;
    const ADDONS_GET_URL = `${STREMIO_API_BASE}api/addonCollectionGet`;

    // --- PASSO 1: LOGIN con Payload Corretto ---
    try {
        const loginResponse = await fetch(LOGIN_API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                "type": "Login", 
                "email": email,
                "password": password,
                "facebook": false 
            })
        });
        
        const loginData = await loginResponse.json(); 

        if (loginData.error || !loginData.result || !loginData.result.authKey) {
            throw new Error(loginData.error ? loginData.error.message : 'Credenziali non valide');
        }

        const authKey = loginData.result.authKey;

        // --- PASSO 2: RECUPERO GLI ADDON ---
        const addonsResponse = await fetch(ADDONS_GET_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                "type": "AddonCollectionGet",
                "authKey": authKey,
                "update": true
            })
        });

        const addonsData = await addonsResponse.json();

        if (addonsData.error || !addonsData.result) {
            throw new Error(addonsData.error ? addonsData.error.message : 'Impossibile recuperare gli addon.');
        }

        const finalAddons = addonsData.result.addons || [];
        console.log(`[Stremio API] Trovati ${finalAddons.length} addon.`);
        return { addons: finalAddons, authKey: authKey };

    } catch (err) {
        console.error('Errore durante l\'autenticazione/recupero:', err.message);
        throw err;
    }
}


// --- ENDPOINT PER IL LOGIN (USATO DAL FRONTEND) ---
app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const data = await getStremioData(email, password);
        res.status(200).json(data);
    } catch (error) {
        res.status(401).json({
            error: "Login fallito",
            message: error.message
        });
    }
});


// --- ENDPOINT PER IL SALVATAGGIO (USATO DAL FRONTEND) ---
app.post('/api/set-addons', async (req, res) => {
    const { authKey, addons } = req.body; 

    if (!authKey || !addons || !Array.isArray(addons)) {
        return res.status(400).json({ error: 'Dati mancanti o non validi.' });
    }

    const STREMIO_API_BASE = 'https://api.strem.io/';
    const ADDONS_SET_URL = `${STREMIO_API_BASE}api/addonCollectionSet`; // Endpoint corretto per salvare

    try {
        const setResponse = await fetch(ADDONS_SET_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                "type": "AddonCollectionSet",
                "authKey": authKey,
                "addons": addons // Inviamo la lista riordinata
            })
        });

        const setData = await setResponse.json();

        if (setData.error) {
            throw new Error(setData.error ? setData.error.message : 'Errore durante il salvataggio.');
        }

        console.log(`[Stremio API] Ordine addon salvato per l'utente.`);
        res.status(200).json({ success: true, message: "Ordine salvato con successo." });

    } catch (error) {
        console.error('Errore nel salvataggio addon:', error.message);
        res.status(500).json({ error: 'Errore interno del server durante il salvataggio.' });
    }
});


// --- AVVIO DEL SERVER ---
app.listen(PORT, () => {
    console.log(`Server avviato correttamente sulla porta ${PORT}`);
});