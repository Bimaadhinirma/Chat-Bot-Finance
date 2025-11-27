const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const financeManager = require('./financeManager');
const businessManager = require('./businessManager');
const { aiDecideAction, aiDecideBusinessAction, explainFeature } = require('./aiParser');
const BackupManager = require('./backupManager');
const chartGenerator = require('./chartGenerator');
const excelExporter = require('./excelExporter');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// Chat history storage per user (max 10 messages)
const chatHistory = new Map();

function addToChatHistory(userId, message, role = 'user') {
    if (!chatHistory.has(userId)) {
        chatHistory.set(userId, []);
    }
    const history = chatHistory.get(userId);
    history.push({ role, message, timestamp: new Date() });
    
    // Keep only last 10 messages
    if (history.length > 10) {
        history.shift();
    }
}

function getChatHistory(userId, limit = 5) {
    if (!chatHistory.has(userId)) {
        return [];
    }
    const history = chatHistory.get(userId);
    return history.slice(-limit);
}

// Initialize WhatsApp client
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu'
        ]
    }
});

// QR Code event
client.on('qr', (qr) => {
    console.log('\n📱 Scan QR Code ini dengan WhatsApp Anda:\n');
    qrcode.generate(qr, { small: true });
    console.log('\n');
});

// Ready event
client.on('ready', () => {
    console.log('✅ Bot WhatsApp Keuangan siap digunakan!');
    console.log('📊 Mulai chat dengan bot untuk mencatat keuangan Anda\n');
    
    // Initialize backup manager and schedule auto backup
    const backupManager = new BackupManager(client);
    backupManager.scheduleAutoBackup();
    
    // Store backup manager in client for later use
    client.backupManager = backupManager;
});

// Authentication failure
client.on('auth_failure', (msg) => {
    console.error('❌ Authentication failed:', msg);
});

// Disconnected
client.on('disconnected', (reason) => {
    console.log('⚠️ Client disconnected:', reason);
});

// Format currency
function formatCurrency(amount) {
    return new Intl.NumberFormat('id-ID', {
        style: 'currency',
        currency: 'IDR',
        minimumFractionDigits: 0
    }).format(amount);
}

// Format date
function formatDate(dateString) {
    const date = new Date(dateString);
    return date.toLocaleString('id-ID', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
}

// Business Mode Handlers
async function handleCreateBusiness(msg, params = null) {
    const userId = msg.from;
    const text = msg.body.trim();
    
    let businessName, description;
    
    // If params provided by AI, use them directly
    if (params && params.name) {
        businessName = params.name;
        description = params.description || '';
    } else {
        // Parse business creation request from text
        // Format: "saya ada bisnis bernama Huiz bisnis ini untuk sekarang jalan di bidang Pembuatan Buket Bunga Custom"
        const match = text.match(/bisnis\s+(?:bernama|nama)\s+([^\s]+)(?:\s+.*?bidang\s+(.+))?/i);
        
        if (!match) {
            await msg.reply('❌ Format tidak valid. Contoh:\n"saya ada bisnis bernama Huiz bisnis ini untuk sekarang jalan di bidang Pembuatan Buket Bunga Custom"');
            return;
        }
        
        businessName = match[1];
        description = match[2] || '';
    }
    
    // Ask for username and password
    await msg.reply(`🏢 *Buat Bisnis: ${businessName}*\n\nSilakan kirim username dan password dengan format:\nusername: [username]\npassword: [password]`);
    
    // Store in temporary state (you'll need to handle this in the next message)
    if (!client.businessCreationState) {
        client.businessCreationState = new Map();
    }
    client.businessCreationState.set(userId, { 
        stage: 'waiting_credentials',
        businessName: businessName,
        description: description
    });
}

async function handleEnterBusinessMode(msg) {
    const userId = msg.from;
    
    // Get user's businesses
    const businesses = await businessManager.getBusinessesByUser(userId);
    
    if (businesses.length === 0) {
        await msg.reply('❌ Anda belum memiliki bisnis. Buat bisnis dulu dengan:\n"saya ada bisnis bernama [nama] bisnis ini untuk sekarang jalan di bidang [bidang]"');
        return;
    }
    
    // Ask for business name
    let response = '🏢 *Pilih Bisnis*\n\nBisnis Anda:\n';
    businesses.forEach((b, i) => {
        response += `${i + 1}. ${b.name}\n`;
    });
    response += '\nSilakan kirim nama bisnis yang ingin digunakan.';
    response += '\n\nJika ingin login ke bisnis milik orang lain, kirim nama bisnis tersebut (anda akan diminta username & password).';
    
    await msg.reply(response);
    
    // Store state
    if (!client.businessLoginState) {
        client.businessLoginState = new Map();
    }
    client.businessLoginState.set(userId, { stage: 'waiting_business_name' });
}

async function handleBusinessMode(msg, activeSession) {
    const userId = msg.from;
    const text = msg.body.trim().toLowerCase();
    
    // Check for exit command first (before AI)
    if (text === 'keluar' || text === 'exit') {
        await businessManager.endBusinessSession(userId);
        await msg.reply('✅ Keluar dari mode bisnis.');
        return;
    }
    
    // Get business context
    const businessId = activeSession.business_id;
    const businessName = activeSession.business_name;

    // Quick parse: handle freeform "update <product>, bahan: ..." before calling AI
    try {
        const parsedUpdate = parseCatalogUpdateText(msg.body);
        if (parsedUpdate && parsedUpdate.bahanText) {
            const providedName = parsedUpdate.productName;
            // find catalog by name
            const catalog = await businessManager.getCatalogByName(businessId, providedName);
            if (!catalog) {
                // try fuzzy lookup among catalogs
                const catalogs = await businessManager.getCatalogs(businessId);
                const best = catalogs.find(c => normalizeName(c.name) === normalizeName(providedName)) || catalogs.find(c => normalizeName(c.name).includes(normalizeName(providedName))) || null;
                if (!best) {
                    // let AI handle or reply
                    // continue to AI decision
                } else {
                    // set catalog as found
                    // proceed to update using best
                    const materialsText = parsedUpdate.bahanText;
                    const availableMaterials = await businessManager.getMaterials(businessId);
                    const normalizedMaterialsText = normalizeName(materialsText);
                    const found = [];
                    const foundMaterialTokens = new Set();
                    for (const m of availableMaterials) {
                        const mn = normalizeName(m.name);
                        if (normalizedMaterialsText.includes(mn)) {
                            // attempt to find quantity near material name
                            const tokenRegex = mn.split(' ').map(t => t.trim()).filter(Boolean).join('\\\\s+');
                            const reAfter = new RegExp(tokenRegex + '\\s*(\\d+)', 'i');
                            const reBefore = new RegExp('(\\\\d+)\\s*' + tokenRegex, 'i');
                            let qty = 1;
                            const matchAfter = materialsText.match(reAfter);
                            const matchBefore = materialsText.match(reBefore);
                            if (matchAfter && matchAfter[1]) qty = Number(matchAfter[1]);
                            else if (matchBefore && matchBefore[1]) qty = Number(matchBefore[1]);

                            found.push({ name: m.name, quantity: qty, unit_price: m.unit_price, pack_price: m.pack_price, per_pack: m.per_pack });
                            mn.split(' ').forEach(t => t && foundMaterialTokens.add(t));
                        }
                    }

                    // Collect not-found tokens to store as unknown parts
                    const stopwords = new Set(['k','rb','ribu','per','pack','pcs','kg','g','unit','buah','pc','katalog','harga','jual']);
                    const captionTokens = normalizedMaterialsText.split(' ').filter(Boolean);
                    const productNameTokens = normalizeName(providedName).split(' ').filter(Boolean);
                    const notFoundSet = new Set();
                    for (const tok of captionTokens) {
                        if (!tok) continue;
                        if (productNameTokens.includes(tok)) continue;
                        if (stopwords.has(tok)) continue;
                        if (/^\d+$/.test(tok)) continue;
                        if (foundMaterialTokens.has(tok)) continue;
                        notFoundSet.add(tok);
                    }

                    const notFound = Array.from(notFoundSet);
                    const productionMaterials = [];
                    for (const f of found) {
                        productionMaterials.push({ name: f.name, quantity: f.quantity, matchedName: f.name, unit_price: f.unit_price || null, found: true });
                    }
                    for (const nf of notFound) {
                        productionMaterials.push({ name: nf, quantity: null, matchedName: null, unit_price: null, found: false });
                    }

                    let productionCost = null;
                    if (found.length > 0) {
                        const calcInput = found.map(f => ({ unit_price: f.unit_price, quantity: f.quantity }));
                        productionCost = businessManager.calculateCost(calcInput);
                    }

                    // Update catalog (include price if parsed)
                    try {
                        const updates = { production_cost: productionCost, production_materials: productionMaterials };
                        if (parsedUpdate.price !== undefined && parsedUpdate.price !== null) updates.price = parsedUpdate.price;
                        const ok = await businessManager.updateCatalog(best.id, updates);
                        if (ok) {
                            let reply = `✅ Komposisi katalog *${best.name}* diperbarui.`;
                            if (productionCost !== null) reply += `\n💵 Total estimasi biaya: ${formatCurrency(productionCost)}`;
                            if (updates.price !== undefined) reply += `\n💰 Harga jual diupdate: ${formatCurrency(updates.price)}`;
                            await msg.reply(reply);
                            return; // handled — don't call AI
                        }
                    } catch (err) {
                        console.error('Error updating catalog from freeform update:', err);
                    }
                }
            } else {
                // catalog exists directly
                const materialsText = parsedUpdate.bahanText;
                const availableMaterials = await businessManager.getMaterials(businessId);
                const normalizedMaterialsText = normalizeName(materialsText);
                const found = [];
                const foundMaterialTokens = new Set();
                for (const m of availableMaterials) {
                    const mn = normalizeName(m.name);
                    if (normalizedMaterialsText.includes(mn)) {
                        const tokenRegex = mn.split(' ').map(t => t.trim()).filter(Boolean).join('\\\\s+');
                        const reAfter = new RegExp(tokenRegex + '\\s*(\\d+)', 'i');
                        const reBefore = new RegExp('(\\\\d+)\\s*' + tokenRegex, 'i');
                        let qty = 1;
                        const matchAfter = materialsText.match(reAfter);
                        const matchBefore = materialsText.match(reBefore);
                        if (matchAfter && matchAfter[1]) qty = Number(matchAfter[1]);
                        else if (matchBefore && matchBefore[1]) qty = Number(matchBefore[1]);

                        found.push({ name: m.name, quantity: qty, unit_price: m.unit_price, pack_price: m.pack_price, per_pack: m.per_pack });
                        mn.split(' ').forEach(t => t && foundMaterialTokens.add(t));
                    }
                }

                const stopwords = new Set(['k','rb','ribu','per','pack','pcs','kg','g','unit','buah','pc','katalog','harga','jual']);
                const captionTokens = normalizedMaterialsText.split(' ').filter(Boolean);
                const productNameTokens = normalizeName(providedName).split(' ').filter(Boolean);
                const notFoundSet = new Set();
                for (const tok of captionTokens) {
                    if (!tok) continue;
                    if (productNameTokens.includes(tok)) continue;
                    if (stopwords.has(tok)) continue;
                    if (/^\d+$/.test(tok)) continue;
                    if (foundMaterialTokens.has(tok)) continue;
                    notFoundSet.add(tok);
                }

                const notFound = Array.from(notFoundSet);
                const productionMaterials = [];
                for (const f of found) {
                    productionMaterials.push({ name: f.name, quantity: f.quantity, matchedName: f.name, unit_price: f.unit_price || null, found: true });
                }
                for (const nf of notFound) {
                    productionMaterials.push({ name: nf, quantity: null, matchedName: null, unit_price: null, found: false });
                }

                let productionCost = null;
                if (found.length > 0) {
                    const calcInput = found.map(f => ({ unit_price: f.unit_price, quantity: f.quantity }));
                    productionCost = businessManager.calculateCost(calcInput);
                }

                try {
                    const updates = { production_cost: productionCost, production_materials: productionMaterials };
                    if (parsedUpdate.price !== undefined && parsedUpdate.price !== null) updates.price = parsedUpdate.price;
                    const ok = await businessManager.updateCatalog(catalog.id, updates);
                    if (ok) {
                        let reply = `✅ Komposisi katalog *${catalog.name}* diperbarui.`;
                        if (productionCost !== null) reply += `\n💵 Total estimasi biaya: ${formatCurrency(productionCost)}`;
                        if (updates.price !== undefined) reply += `\n💰 Harga jual diupdate: ${formatCurrency(updates.price)}`;
                        await msg.reply(reply);
                        return; // handled — don't call AI
                    }
                } catch (err) {
                    console.error('Error updating catalog from freeform update:', err);
                }
            }
        }
    } catch (err) {
        console.error('Freeform catalog update parse error:', err);
    }

    // Quick parse: add empty bouquet price via freeform before AI
    try {
        const addEmptyMatch = msg.body.trim().match(/(?:tambahkan|tambah)\s+harga\s+buket\s+kosong(?:\s+ukuran\s*([A-Za-z0-9\-]+))?(?:.*?harga\s*([0-9\.,\s]*(?:k|rb|ribu|jt|juta)?))/i);
        if (addEmptyMatch) {
            const size = (addEmptyMatch[1] || 'standard').trim();
            const priceRaw = addEmptyMatch[2];
            const price = parseAmount(priceRaw || '0');

            if (!price || isNaN(price) || price <= 0) {
                await msg.reply('❌ Harga tidak valid. Contoh: "tambahkan harga buket kosong ukuran XL harga 55k"');
                return;
            }

            try {
                await businessManager.addEmptyBouquet(businessId, size, price);
                await msg.reply(`✅ Harga buket kosong ukuran *${size}* ditambahkan: ${formatCurrency(price)}`);
            } catch (err) {
                if (err && err.message === 'EMPTY_BOUQUET_ALREADY_EXISTS') {
                    // update existing
                    const existing = await businessManager.getEmptyBouquetBySize(businessId, size);
                    if (existing) {
                        await businessManager.updateEmptyBouquet(existing.id, { price });
                        await msg.reply(`✅ Harga buket kosong ukuran *${size}* diupdate menjadi ${formatCurrency(price)}`);
                    } else {
                        await msg.reply('❌ Gagal menambahkan harga buket kosong.');
                    }
                } else {
                    console.error('addEmptyBouquet error:', err);
                    await msg.reply('❌ Gagal menambahkan harga buket kosong.');
                }
            }

            return; // handled before AI
        }
    } catch (err) {
        console.error('Freeform add empty bouquet parse error:', err);
    }

    // Quick parse: list empty bouquets (user asks "harga buket kosong", "daftar buket kosong")
    try {
        const listEmptyMatch = msg.body.trim().match(/(?:harga|daftar|list)\s+(?:buket\s+)?kosong|harga\s+buket\s+kosong/i);
        if (listEmptyMatch) {
            const emptyBouquets = await businessManager.getEmptyBouquets(businessId);
            if (!emptyBouquets || emptyBouquets.length === 0) {
                await msg.reply('📋 Belum ada data *harga buket kosong*. Tambahkan dengan: "tambahkan harga buket kosong ukuran [SIZE] harga [PRICE]"');
                return;
            }

            let resp = `📋 *Harga Buket Kosong - ${businessName}*\n\n`;
            emptyBouquets.forEach((eb, i) => {
                resp += `${i + 1}. *${eb.size}* — ${formatCurrency(eb.price)}\n`;
            });

            resp += `\nGunakan: "<jumlah> tangkai <bunga> + ukuran <SIZE>" untuk menghitung estimasi harga.`;
            await msg.reply(resp);
            return; // handled before AI
        }
    } catch (err) {
        console.error('List empty bouquets parse error:', err);
    }

    // Quick parse: bouquet price calculation — support multiple items in one message
    try {
        // detect explicit size override anywhere in the message (e.g. '+ ukuran XL')
        let sizeOverrideMatch = msg.body.match(/\+?\s*ukuran\s*([A-Za-z0-9\-]+)/i);
        let sizeOverride = sizeOverrideMatch ? sizeOverrideMatch[1].trim() : null;

        // remove the size token so it doesn't interfere with splitting items
        let bodyForParse = msg.body.replace(/\+?\s*ukuran\s*[A-Za-z0-9\-]+/i, '').trim();

        // split by commas, semicolons or newlines to find multiple items
        const parts = bodyForParse.split(/[,;\n]+/).map(p => p.trim()).filter(Boolean);

        // item regex: optional number + optional 'tangkai' + flower name
        const itemRegex = /(?:(\d+)\s*(?:tangkai)?\s*)?(?:bunga\s+)?(.+)/i;
        const items = [];
        for (const p of parts) {
            const m = p.match(itemRegex);
            if (m) {
                const qty = m[1] ? Number(m[1]) : null;
                let name = (m[2] || '').replace(/(berapa|harga|\?|\.)/ig, '').trim();
                if (qty && name) items.push({ stems: qty, flower: name });
            }
        }

        // If nothing parsed as list, try the old single-line pattern
        if (items.length === 0) {
            const singleMatch = msg.body.trim().match(/(\d+)\s*tangkai\s+(?:bunga\s+)?([^\+\?\n]+?)(?:\s*\+\s*ukuran\s*([A-Za-z0-9\-]+))?\s*\??$/i);
            if (singleMatch) {
                const stems = Number(singleMatch[1]);
                const flowerRaw = (singleMatch[2] || '').trim();
                const sizeOver = singleMatch[3] ? singleMatch[3].trim() : null;
                const flowerName = flowerRaw.replace(/(berapa|harga|\?|\.)/ig, '').trim();
                items.push({ stems, flower: flowerName });
                if (!sizeOverride && sizeOver) sizeOverride = sizeOver;
            }
        }

        if (items.length > 0) {
            // Compute totals: total stems, flower cost per item (prefer catalog then materials)
            const catalogs = await businessManager.getCatalogs(businessId);
            const materials = await businessManager.getMaterials(businessId);
            const empties = await businessManager.getEmptyBouquets(businessId);

            let totalStems = 0;
            let totalFlowerCost = 0;
            const breakdown = [];
            const missing = [];

            for (const it of items) {
                totalStems += Number(it.stems || 0);
                const norm = normalizeName(it.flower);
                // try catalog matching
                let matchedCat = catalogs.find(c => normalizeName(c.name) === norm) || catalogs.find(c => normalizeName(c.name).includes(norm));
                if (!matchedCat) {
                    const targetTokens = new Set(norm.split(' ').filter(Boolean));
                    let best = null; let bestScore = 0;
                    for (const c of catalogs) {
                        const ctokens = normalizeName(c.name).split(' ').filter(Boolean);
                        let score = 0;
                        for (const t of ctokens) if (targetTokens.has(t)) score++;
                        if (score > bestScore) { bestScore = score; best = c; }
                    }
                    if (bestScore > 0) matchedCat = best;
                }

                let unit = null;
                let cost = null;
                let source = null;

                if (matchedCat && matchedCat.price) {
                    unit = Number(matchedCat.price) || 0;
                    cost = Math.round(unit * it.stems);
                    source = `katalog:${matchedCat.name}`;
                } else {
                    const mat = findMaterialByName(materials, it.flower);
                    if (mat) {
                        unit = (mat.unit_price === null || mat.unit_price === undefined) ? (mat.pack_price && mat.per_pack ? Number(mat.pack_price)/Number(mat.per_pack) : 0) : Number(mat.unit_price);
                        cost = Math.round((unit || 0) * it.stems);
                        source = `bahan:${mat.name}`;
                    }
                }

                if (cost === null || isNaN(cost)) {
                    missing.push(it.flower);
                    breakdown.push({ name: it.flower, stems: it.stems, unit: null, cost: null, source: null });
                } else {
                    totalFlowerCost += Number(cost);
                    breakdown.push({ name: it.flower, stems: it.stems, unit: unit, cost: cost, source: source });
                }
            }

            // Determine chosen size based on totalStems
            const capacities = { 'S': 6, 'M': 12, 'L': 18, 'XL': 24 };
            let chosenSize = null;
            if (sizeOverride) {
                const eb = empties.find(e => normalizeName(e.size) === normalizeName(sizeOverride) || (e.size||'').toString().toUpperCase() === sizeOverride.toUpperCase());
                if (eb) chosenSize = { size: eb.size, price: eb.price, capacity: capacities[(eb.size||'').toUpperCase()] || null };
            }

            if (!chosenSize) {
                const candidates = empties.map(e => ({ size: e.size, price: e.price, capacity: capacities[(e.size||'').toUpperCase()] || null })).filter(Boolean);
                const withCaps = candidates.filter(s => s.capacity && !isNaN(s.capacity)).sort((a,b)=>a.capacity-b.capacity);
                if (withCaps.length > 0) {
                    chosenSize = withCaps.find(s => s.capacity >= totalStems) || withCaps[withCaps.length-1];
                } else if (candidates.length > 0) {
                    chosenSize = candidates.slice().sort((a,b)=>a.price-b.price)[0];
                }
            }

            const emptyPrice = chosenSize ? Number(chosenSize.price) : null;
            const total = (Number(totalFlowerCost) || 0) + (Number(emptyPrice) || 0);

            // Build reply
            let reply = `💐 *Perhitungan Buket (Gabungan)*\n\n`;
            reply += `• Total tangkai: *${totalStems}*\n`;
            reply += `\n*Rincian bunga:*\n`;
            for (const b of breakdown) {
                if (b.cost !== null) {
                    reply += `• ${b.stems} × ${b.name}: ${formatCurrency(b.cost)} (${b.unit ? `${formatCurrency(b.unit)}/tangkai` : '-'} via ${b.source})\n`;
                } else {
                    reply += `• ${b.stems} × ${b.name}: — (harga per-tangkai tidak ditemukan)\n`;
                }
            }

            if (chosenSize) {
                reply += `\n💳 *Harga buket kosong (${chosenSize.size}):* ${formatCurrency(chosenSize.price)} ${chosenSize.capacity ? `(muat ~${chosenSize.capacity} tangkai)` : ''}\n`;
            } else if (empties.length > 0) {
                reply += `\n💳 *Harga buket kosong:*\n`;
                empties.forEach(e => reply += `• ${e.size}: ${formatCurrency(e.price)}\n`);
            } else {
                reply += `\n💳 *Harga buket kosong:* — (tidak ada data)\n`;
            }

            reply += `\n💐 *Total biaya bunga:* ${totalFlowerCost ? formatCurrency(totalFlowerCost) : '—'}\n`;
            reply += `\n🧾 *Total estimasi (bunga + buket kosong):* ${formatCurrency(total)}\n`;

            if (missing.length > 0) {
                reply += `\n⚠️ Beberapa bunga tidak dapat dihitung karena tidak ada harga per-tangkai: ${[...new Set(missing)].join(', ')}. Tambahkan bahan atau katalog dengan harga per-tangkai agar perhitungan lengkap.`;
            }

            reply += `\n\n✳️ Jika Anda ingin override ukuran, tambahkan \"+ ukuran XL\" di akhir pesan.`;

            await msg.reply(reply);
            return; // handled before AI
        }
    } catch (err) {
        console.error('Bouquet price parse error (multi):', err);
    }
    
    // Quick handling: if user asked "katalog <nama>", show that specific catalog
    try {
        const katalogMatch = msg.body.trim().match(/^katalog\s+(.+)/i);
        if (katalogMatch) {
            const requestedName = katalogMatch[1].trim();
            await handleShowCatalogs(msg, businessId, businessName, requestedName);
            return;
        }
    } catch (err) {
        // ignore and continue to other handlers
    }
    // Special handling for catalog with image: trigger if caption mentions 'katalog' or matches "<name> <price>" pattern
    if (msg.hasMedia) {
        const caption = text || '';
        const captionLooksLikeProduct = /(.+?)\s+(\d+[krb]*)/i.test(caption);
        if (caption.toLowerCase().includes('katalog') || captionLooksLikeProduct) {
            await handleAddCatalog(msg, businessId);
            return;
        }
    }
    
    // Get business stats for context
    const stats = await businessManager.getBusinessStats(businessId);
    const businessContext = {
        businessName: businessName,
        materialsCount: stats.materialsCount,
        catalogsCount: stats.catalogsCount
    };
    
    // Use AI to decide action
    const history = getChatHistory(userId, 5);
    console.log(`📨 Business message from ${userId}: ${text}`);
    
    const decision = await aiDecideBusinessAction(msg.body.trim(), history, businessContext);
    
    if (!decision) {
        console.log('⚠️ Business mode: AI returned null - no response sent');
        return;
    }
    
    console.log(`🤖 Business AI Action: ${decision.action}`);
    console.log(`📋 Reasoning: ${decision.reasoning}`);
    
    // Execute action based on AI decision
    try {
        if (decision.action === 'add_material') {
            const { name, unitPrice, packPrice, perPack } = decision.params;

            try {
                const existing = await businessManager.getMaterialByName(businessId, name);
                if (existing) {
                    const updates = {};
                    if (unitPrice !== undefined) updates.unit_price = unitPrice;
                    if (packPrice !== undefined) updates.pack_price = packPrice || null;
                    if (perPack !== undefined) updates.per_pack = perPack || null;

                    if (Object.keys(updates).length === 0) {
                        await msg.reply(`⚠️ Tidak ada perubahan untuk bahan *${name}*.`);
                    } else {
                        await businessManager.updateMaterial(businessId, name, updates);
                        let response = `✅ Bahan *${name}* diperbarui:`;
                        if (updates.unit_price !== undefined) response += `\n• Per unit: ${formatCurrency(updates.unit_price)}`;
                        if (updates.pack_price !== undefined) response += `\n• Per pack: ${updates.pack_price ? formatCurrency(updates.pack_price) : 'dihapus'}`;
                        await msg.reply(response);
                        addToChatHistory(userId, response, 'bot');
                    }
                } else {
                    await businessManager.addMaterial(businessId, name, unitPrice, packPrice || null, perPack || null);
                    let response = `✅ Bahan *${name}* ditambahkan:`;
                    if (unitPrice !== undefined) response += `\n• Per unit: ${formatCurrency(unitPrice)}`;
                    if (packPrice) response += `\n• Per pack: ${formatCurrency(packPrice)}`;
                    await msg.reply(response);
                    addToChatHistory(userId, response, 'bot');
                }
            } catch (error) {
                console.error('add_material error:', error);
                await msg.reply('❌ Gagal menambahkan atau memperbarui bahan.');
            }
        }
        else if (decision.action === 'exit' || decision.action === 'keluar') {
            try {
                await businessManager.endBusinessSession(userId);
                await msg.reply('✅ Keluar dari mode bisnis.');
                addToChatHistory(userId, 'Keluar dari mode bisnis.', 'bot');
            } catch (err) {
                console.error('exit business action error:', err);
                await msg.reply('❌ Gagal keluar dari mode bisnis.');
            }
        }
        else if (decision.action === 'list_materials') {
            await handleListMaterials(msg, businessId, businessName);
        }
        else if (decision.action === 'list_price_tiers') {
            await handleListPriceTiers(msg, businessId, businessName);
        }
        else if (decision.action === 'add_price_tier') {
            const { price } = decision.params;
            // Detect if the user likely intended to add a catalog item: "<name> <price>" (e.g. "bunga matahari 12k")
            try {
                let productName = null;
                const tokens = text.split(/\s+/);
                for (let i = 0; i < tokens.length; i++) {
                    const tok = tokens[i];
                    const parsed = parseAmount(tok);
                    if (!isNaN(parsed) && parsed === price) {
                        // product name is the tokens before this token
                        productName = tokens.slice(0, i).join(' ').trim();
                        break;
                    }
                }

                    if (productName && productName.length > 0) {
                    // Create catalog item automatically (no image)
                    await businessManager.addCatalog(businessId, productName, price, null, null);
                    await msg.reply(`✅ Katalog *${productName}* ditambahkan dengan harga ${formatCurrency(price)}.`);
                    addToChatHistory(userId, `Katalog ${productName} ditambahkan`, 'bot');
                } else {
                    // Fallback: treat as price tier
                    await businessManager.addPriceTier(businessId, price);
                    await msg.reply(`✅ Harga jual ${formatCurrency(price)} berhasil ditambahkan.`);
                    addToChatHistory(userId, `Harga jual ${price} ditambahkan`, 'bot');
                }
            } catch (error) {
                if (error && error.message === 'PRICE_ALREADY_EXISTS') {
                    await msg.reply(`⚠️ Harga jual ${formatCurrency(price)} sudah ada.`);
                } else if (error && error.message === 'MATERIAL_ALREADY_EXISTS') {
                    await msg.reply('⚠️ Item sudah ada.');
                } else {
                    console.error('❌ add_price_tier error:', error);
                    await msg.reply('❌ Gagal menambahkan harga jual atau katalog.');
                }
            }
        }
        else if (decision.action === 'calculate_cost') {
            // decision.params should contain requestedMaterials: [{name, quantity}, ...]
            const requestedMaterials = decision.params?.materials || [];
            const availableMaterials = await businessManager.getMaterials(businessId);
            const usedMaterials = [];
            const notFoundMaterials = [];
            let totalCost = 0;

            // compute costs, handle pack_price/per_pack fallback
            requestedMaterials.forEach(rm => {
                const material = findMaterialByName(availableMaterials, rm.name);
                if (material) {
                    let unitPrice = material.unit_price;
                    // derive unit price from pack if unit missing and per_pack present
                    if ((unitPrice === null || unitPrice === undefined) && material.pack_price && material.per_pack) {
                        unitPrice = Number(material.pack_price) / Number(material.per_pack);
                    }

                    const qty = Number(rm.quantity) || 0;
                    const cost = (unitPrice ? Number(unitPrice) : 0) * qty;
                    usedMaterials.push({
                        name: material.name,
                        requestedName: rm.name,
                        quantity: qty,
                        unitPrice: unitPrice || null,
                        packPrice: material.pack_price || null,
                        perPack: material.per_pack || null,
                        cost: cost
                    });
                    totalCost += cost;
                } else {
                    notFoundMaterials.push(rm.name);
                }
            });
            
            if (usedMaterials.length === 0) {
                let reply = '❌ Tidak ditemukan bahan yang valid dalam pesan Anda.';
                if (notFoundMaterials.length > 0) reply += `\nBahan yang tidak dikenali: ${notFoundMaterials.join(', ')}`;
                await msg.reply(reply);
                return;
            }
            
            // Build response with detailed breakdown
            let response = '💰 *Perhitungan Biaya*\n\n';
            response += '📋 *Bahan yang digunakan:*\n';
            usedMaterials.forEach(m => {
                const displayName = m.name || m.requestedName;
                const unitText = m.unitPrice ? formatCurrency(m.unitPrice) : (m.packPrice ? `${formatCurrency(m.packPrice)} per ${m.perPack || '?'} pack` : 'harga tidak tersedia');
                response += `• ${displayName}: ${m.quantity} × ${unitText} = ${formatCurrency(m.cost)}\n`;
            });
            response += `\n💵 *Total Cost: ${formatCurrency(totalCost)}*\n\n`;

            // Suggest price and nearest price tier
            const suggestedPrice = await businessManager.suggestSellingPrice(businessId, totalCost);
            const priceTiers = await businessManager.getPriceTiers(businessId);
            let nearestTier = null;
            if (priceTiers && priceTiers.length > 0) {
                // Prefer the nearest tier that is >= totalCost (don't pick tiers below cost)
                const tiersAboveOrEqual = priceTiers.filter(pt => Number(pt.price) >= totalCost).map(pt => Number(pt.price));
                if (tiersAboveOrEqual.length > 0) {
                    // choose smallest tier >= totalCost
                    tiersAboveOrEqual.sort((a, b) => a - b);
                    nearestTier = tiersAboveOrEqual[0];
                } else {
                    // No tier above or equal to total cost
                    nearestTier = null;
                }
            }

            response += `💡 *Saran Harga Jual (AI): ${formatCurrency(suggestedPrice)}*\n`;
            response += `   (Estimasi Profit: ${formatCurrency(suggestedPrice - totalCost)})\n`;
            if (nearestTier) {
                response += `🏷️ *Harga Jual Terdekat (>= biaya):* ${formatCurrency(nearestTier)}\n`;
                response += `   (Profit jika pilih tier terdekat: ${formatCurrency(nearestTier - totalCost)})\n`;
            } else if (priceTiers.length === 0) {
                response += `🏷️ Tidak ada harga jual terkonfigurasi untuk bisnis ini.\n`;
            } else {
                // There are tiers but none above cost
                const highest = priceTiers[priceTiers.length - 1].price;
                response += `🏷️ Tidak ada harga jual terdekat yang >= total cost. Harga tertinggi saat ini ${formatCurrency(highest)} (masih di bawah cost).\n`;
                response += `   Pertimbangkan menggunakan saran AI ${formatCurrency(suggestedPrice)} atau tambahkan tier yang lebih tinggi.\n`;
            }

            response += `\n✳️ Catatan: Harga jual terdekat yang ditampilkan hanya memilih tier yang tidak membuat profit negatif (>= total cost). AI tetap dapat menyarankan harga di luar daftar jika diperlukan.`;
            if (notFoundMaterials.length > 0) {
                response += `\n\n⚠️ Bahan tidak dikenali: ${notFoundMaterials.join(', ')}. Pastikan bahan sudah ditambahkan ke daftar bahan bisnis Anda.`;
            }
            
            await msg.reply(response);
            addToChatHistory(userId, response, 'bot');
        }
        else if (decision.action === 'calculate_bouquet') {
            const stems = Number(decision.params?.stems) || 0;
            const flower = (decision.params?.flower || '').toString();
            const size = decision.params?.size || null;

            try {
                let flowerCost = 0;
                let usedCatalog = false;
                if (stems > 0 && flower) {
                    // Prefer catalog price if available
                    try {
                        const catalogs = await businessManager.getCatalogs(businessId);
                        const normFlower = normalizeName(flower);
                        let matchedCat = catalogs.find(c => normalizeName(c.name) === normFlower) || catalogs.find(c => normalizeName(c.name).includes(normFlower));
                        if (!matchedCat) {
                            const targetTokens = new Set(normFlower.split(' ').filter(Boolean));
                            let best = null; let bestScore = 0;
                            for (const c of catalogs) {
                                const ctokens = normalizeName(c.name).split(' ').filter(Boolean);
                                let score = 0;
                                for (const t of ctokens) if (targetTokens.has(t)) score++;
                                if (score > bestScore) { bestScore = score; best = c; }
                            }
                            if (bestScore > 0) matchedCat = best;
                        }

                        if (matchedCat && matchedCat.price) {
                            const unit = Number(matchedCat.price) || 0;
                            flowerCost = unit * stems;
                            usedCatalog = true;
                        }
                    } catch (err) {
                        console.error('catalog lookup error in calculate_bouquet:', err);
                    }

                    if (!usedCatalog) {
                        const materials = await businessManager.getMaterials(businessId);
                        const mat = findMaterialByName(materials, flower);
                        if (mat) {
                            const unit = (mat.unit_price === null || mat.unit_price === undefined) ? (mat.pack_price && mat.per_pack ? Number(mat.pack_price) / Number(mat.per_pack) : 0) : Number(mat.unit_price);
                            flowerCost = unit * stems;
                        }
                    }
                }

                let chosenSize = size;
                let emptyPrice = null;

                if (chosenSize) {
                    const eb = await businessManager.getEmptyBouquetBySize(businessId, chosenSize);
                    if (eb) emptyPrice = eb.price;
                } else {
                    const empties = await businessManager.getEmptyBouquets(businessId);
                    const capacities = { 'S': 6, 'M': 12, 'L': 18, 'XL': 24 };
                    let candidate = null;
                    for (const e of empties) {
                        const cap = capacities[(e.size || '').toString().toUpperCase()] || null;
                        if (cap && cap >= stems) {
                            if (!candidate || (capacities[(e.size||'').toUpperCase()] < capacities[(candidate.size||'').toUpperCase()])) candidate = e;
                        }
                    }
                    if (!candidate && empties.length > 0) {
                        candidate = empties.reduce((a, b) => {
                            const ca = capacities[(a.size||'').toUpperCase()] || 0;
                            const cb = capacities[(b.size||'').toUpperCase()] || 0;
                            return cb > ca ? b : a;
                        });
                    }
                    if (candidate) {
                        chosenSize = candidate.size;
                        emptyPrice = candidate.price;
                    }
                }

                const total = (Number(flowerCost) || 0) + (Number(emptyPrice) || 0);
                let text = `✅ Estimasi untuk ${stems} tangkai${flower ? ' ' + flower : ''}:\n`;
                if (usedCatalog) {
                    text += `• Bunga: ${flowerCost ? formatCurrency(flowerCost) : '—'} (dihitung dari harga katalog)\n`;
                } else {
                    text += `• Bunga: ${flowerCost ? formatCurrency(flowerCost) : '— (bahan tidak ditemukan)'}\n`;
                }
                text += `• Buket kosong (${chosenSize || '—'}): ${emptyPrice ? formatCurrency(emptyPrice) : '— (tidak ada data)'}\n`;
                text += `• Total estimasi: ${formatCurrency(total)}`;

                await msg.reply(text);
                addToChatHistory(userId, text, 'bot');
            } catch (err) {
                console.error('calculate_bouquet decision handler error:', err);
                await msg.reply('❌ Gagal menghitung estimasi buket.');
            }
        }
        else if (decision.action === 'add_catalog') {
            // AI requested to add or update a catalog. Support both: update existing or create new.
            const { name, price, materials: aiMaterials, productionCost } = decision.params || {};
            if (!name) {
                await msg.reply('❌ Nama katalog tidak diberikan. Sertakan nama katalog pada perintah.');
                return;
            }

            try {
                const existing = await businessManager.getCatalogByName(businessId, name);

                // Build productionMaterials from provided materials list if present
                let productionMaterials = null;
                let computedProductionCost = productionCost !== undefined ? productionCost : null;
                if (Array.isArray(aiMaterials) && aiMaterials.length > 0) {
                    const availableMaterials = await businessManager.getMaterials(businessId);
                    const calcInput = [];
                    productionMaterials = [];

                    for (const m of aiMaterials) {
                        const requestedName = m.name || m.material || m.item || '';
                        const qty = Number(m.quantity || m.qty || m.count || 0) || 1;
                        const mat = findMaterialByName(availableMaterials, requestedName);
                        if (mat) {
                            // derive unit price if missing
                            let unit = mat.unit_price;
                            if ((unit === null || unit === undefined) && mat.pack_price && mat.per_pack) {
                                unit = Number(mat.pack_price) / Number(mat.per_pack);
                            }
                            calcInput.push({ unit_price: unit || 0, quantity: qty });
                            productionMaterials.push({ name: requestedName, quantity: qty, matchedName: mat.name, unit_price: mat.unit_price || null, found: true });
                        } else {
                            productionMaterials.push({ name: requestedName, quantity: qty, matchedName: null, unit_price: null, found: false });
                        }
                    }

                    if (calcInput.length > 0 && computedProductionCost === null) {
                        computedProductionCost = businessManager.calculateCost(calcInput);
                    }
                }

                if (existing) {
                    const updates = {};
                    if (price !== undefined) updates.price = price;
                    if (computedProductionCost !== null) updates.production_cost = computedProductionCost;
                    if (productionMaterials !== null) updates.production_materials = productionMaterials;

                    if (Object.keys(updates).length === 0) {
                        await msg.reply('⚠️ Tidak ada data untuk diupdate pada katalog. Sertakan `price` atau `materials`.');
                        return;
                    }

                    const ok = await businessManager.updateCatalog(existing.id, updates);
                    if (ok) {
                        let reply = `✅ Katalog *${existing.name}* diperbarui.`;
                        if (computedProductionCost !== null) reply += `\n💵 Estimasi Biaya Produksi: ${formatCurrency(computedProductionCost)}`;
                        if (price !== undefined) reply += `\n💰 Harga jual: ${formatCurrency(price)}`;
                        await msg.reply(reply);
                        addToChatHistory(userId, reply, 'bot');
                    } else {
                        await msg.reply('❌ Gagal memperbarui katalog.');
                    }
                } else {
                    // Creating new catalog: require price (because DB schema requires price NOT NULL)
                    if (price === undefined || price === null) {
                        await msg.reply('❗ Untuk menambahkan katalog baru, mohon sertakan harga jual. Contoh: "daun v2 6000" atau kirim "tambahkan katalog daun v2 6000"');
                        return;
                    }

                    // No image here; create catalog record without image
                    await businessManager.addCatalog(businessId, name, price, null, computedProductionCost, productionMaterials);
                    let reply = `✅ Katalog *${name}* ditambahkan dengan harga ${formatCurrency(price)}`;
                    if (computedProductionCost !== null) reply += `\n💵 Estimasi Biaya Produksi: ${formatCurrency(computedProductionCost)}`;
                    await msg.reply(reply);
                    addToChatHistory(userId, reply, 'bot');
                }
            } catch (err) {
                console.error('add_catalog error (business):', err);
                await msg.reply('❌ Gagal menambahkan atau memperbarui katalog.');
            }
        }
        else if (decision.action === 'add_empty_bouquet') {
            const { size, price } = decision.params || {};
            if (!size || !price) {
                await msg.reply('❌ Untuk menambahkan harga buket kosong, sertakan `size` dan `price`. Contoh: "tambahkan harga buket kosong ukuran XL harga 55k"');
                return;
            }

            try {
                await businessManager.addEmptyBouquet(businessId, size, price);
                await msg.reply(`✅ Harga buket kosong ukuran *${size}* ditambahkan: ${formatCurrency(price)}`);
            } catch (err) {
                if (err && err.message === 'EMPTY_BOUQUET_ALREADY_EXISTS') {
                    const existing = await businessManager.getEmptyBouquetBySize(businessId, size);
                    if (existing) {
                        await businessManager.updateEmptyBouquet(existing.id, { price });
                        await msg.reply(`✅ Harga buket kosong ukuran *${size}* diupdate menjadi ${formatCurrency(price)}`);
                    } else {
                        await msg.reply('❌ Gagal menambahkan harga buket kosong.');
                    }
                } else {
                    console.error('add_empty_bouquet decision handler error:', err);
                    await msg.reply('❌ Gagal menambahkan harga buket kosong.');
                }
            }
        }
        else if (decision.action === 'show_catalogs') {
            const requestedName = decision.params?.name || null;
            await handleShowCatalogs(msg, businessId, businessName, requestedName);
        }
        else if (decision.action === 'edit_material') {
            const { name } = decision.params || {};
            const updates = {};
            if (decision.params.unitPrice !== undefined) updates.unit_price = decision.params.unitPrice;
            if (decision.params.packPrice !== undefined) updates.pack_price = decision.params.packPrice;
            if (decision.params.perPack !== undefined) updates.per_pack = decision.params.perPack;

            if (!name) {
                await msg.reply('❌ Nama bahan tidak diberikan untuk edit.');
                return;
            }

            try {
                const ok = await businessManager.updateMaterial(businessId, name, updates);
                if (ok) {
                    await msg.reply(`✅ Bahan *${name}* berhasil diupdate.`);
                } else {
                    await msg.reply(`⚠️ Tidak ada perubahan atau bahan *${name}* tidak ditemukan.`);
                }
            } catch (err) {
                console.error('edit_material error:', err);
                await msg.reply('❌ Gagal mengupdate bahan.');
            }
        }
        else if (decision.action === 'delete_material') {
            const name = decision.params?.name;
            try {
                if (name) {
                    const ok = await businessManager.deleteMaterialByName(businessId, name);
                    if (ok) await msg.reply(`✅ Bahan *${name}* dihapus.`);
                    else await msg.reply(`⚠️ Bahan *${name}* tidak ditemukan.`);
                } else {
                    // delete all
                    await businessManager.deleteAllMaterials(businessId);
                    await msg.reply('✅ Semua bahan telah dihapus.');
                }
            } catch (err) {
                console.error('delete_material error:', err);
                await msg.reply('❌ Gagal menghapus bahan.');
            }
        }
        else if (decision.action === 'add_expense') {
            let { description, amount } = decision.params;
            
            // If amount is 0, try to get from materials
            if (amount === 0) {
                const materials = await businessManager.getMaterials(businessId);
                for (const m of materials) {
                    if (description.toLowerCase().includes(m.name.toLowerCase())) {
                        if (m.pack_price && (description.includes('pack') || description.includes('gulung'))) {
                            amount = m.pack_price;
                            break;
                        }
                    }
                }
            }
            
            if (amount === 0) {
                await msg.reply('❌ Tidak dapat menentukan jumlah. Silakan sertakan harga atau pastikan bahan sudah terdaftar dengan harga pack.');
                return;
            }
            
            try {
                await businessManager.addExpense(businessId, description, amount);
                await msg.reply(`✅ Pengeluaran dicatat:\n${description}\n💰 ${formatCurrency(amount)}\n\n_Status: Belum dicatat ke Excel_`);
            } catch (error) {
                await msg.reply('❌ Gagal mencatat pengeluaran.');
            }
        }
        else if (decision.action === 'edit_catalog') {
            const { id, name, price, newName, production_cost, production_materials } = decision.params || {};
            try {
                let ok = false;
                const updates = {};
                if (newName !== undefined || name !== undefined) updates.name = newName || name;
                if (price !== undefined) updates.price = price;
                if (production_cost !== undefined) updates.production_cost = production_cost;
                if (production_materials !== undefined) updates.production_materials = production_materials;

                if (Object.keys(updates).length === 0) {
                    await msg.reply('⚠️ Tidak ada data untuk diupdate. Sertakan field seperti `price`, `production_cost`, atau `production_materials`.');
                    return;
                }

                if (id) {
                    ok = await businessManager.updateCatalog(id, updates);
                } else if (name) {
                    const cat = await businessManager.getCatalogByName(businessId, name);
                    if (cat) ok = await businessManager.updateCatalog(cat.id, updates);
                }

                if (ok) await msg.reply('✅ Katalog berhasil diupdate.');
                else await msg.reply('⚠️ Katalog tidak ditemukan atau tidak ada perubahan.');
            } catch (err) {
                console.error('edit_catalog error:', err);
                await msg.reply('❌ Gagal mengupdate katalog.');
            }
        }
        else if (decision.action === 'delete_catalog') {
            try {
                if (decision.params?.id) {
                    await businessManager.deleteCatalog(decision.params.id);
                    await msg.reply('✅ Katalog berhasil dihapus.');
                } else if (decision.params?.name) {
                    const requestedName = decision.params.name;
                    const cat = await businessManager.getCatalogByName(businessId, requestedName);
                    if (cat) {
                        await businessManager.deleteCatalog(cat.id);
                        await msg.reply(`✅ Katalog *${cat.name}* dihapus.`);
                    } else {
                        // Try fuzzy lookup among catalogs
                        const catalogs = await businessManager.getCatalogs(businessId);
                        const target = normalizeName(requestedName);
                        const targetTokens = new Set(target.split(' ').filter(Boolean));
                        let best = null; let bestScore = 0;
                        const scored = [];
                        for (const c of catalogs) {
                            const cn = normalizeName(c.name);
                            const ctokens = cn.split(' ').filter(Boolean);
                            let score = 0;
                            for (const t of ctokens) if (targetTokens.has(t)) score++;
                            if (score > 0) scored.push({ catalog: c, score });
                            if (score > bestScore) { bestScore = score; best = c; }
                        }

                        if (best && (normalizeName(best.name).includes(target) || target.includes(normalizeName(best.name)) || bestScore >= 2)) {
                            // strong match — perform delete
                            await businessManager.deleteCatalog(best.id);
                            await msg.reply(`✅ Katalog *${best.name}* (cocok dengan "${requestedName}") telah dihapus.`);
                        } else if (scored.length > 0) {
                            // suggest candidates
                            scored.sort((a, b) => b.score - a.score);
                            const options = scored.slice(0, 5).map((s, i) => `${i + 1}. ${s.catalog.name}`).join('\n');
                            let reply = `⚠️ Katalog "${requestedName}" tidak ditemukan secara tepat. Mungkin Anda maksud salah satu dari berikut:\n${options}\n\nBalas dengan ` + "'hapus katalog <nama>'" + ` atau kirim 'hapus katalog nomor' (mis. 'hapus katalog 1').`;
                            await msg.reply(reply);
                        } else {
                            await msg.reply('⚠️ Katalog tidak ditemukan. Periksa kembali ejaan atau tampilkan daftar katalog untuk melihat nama yang tersedia.');
                        }
                    }
                } else {
                    await msg.reply('❌ Harap sebutkan nama atau id katalog yang ingin dihapus, atau gunakan "hapus semua katalog".');
                }
            } catch (err) {
                console.error('delete_catalog error:', err);
                await msg.reply('❌ Gagal menghapus katalog.');
            }
        }
        else if (decision.action === 'delete_all_catalogs') {
            try {
                await businessManager.deleteAllCatalogs(businessId);
                await msg.reply('✅ Semua katalog telah dihapus.');
            } catch (err) {
                console.error('delete_all_catalogs error:', err);
                await msg.reply('❌ Gagal menghapus semua katalog.');
            }
        }
        else if (decision.action === 'delete_all_price_tiers') {
            try {
                await businessManager.deleteAllPriceTiers(businessId);
                await msg.reply('✅ Semua harga jual telah dihapus.');
            } catch (err) {
                console.error('delete_all_price_tiers error:', err);
                await msg.reply('❌ Gagal menghapus harga jual.');
            }
        }
        else if (decision.action === 'show_examples') {
            const examples = `Contoh input untuk bahan/katalog:\n• 1 pack kawat bulu 14k\n• 1 unit kawat bulu 500 perak\n• tambahkan katalog bunga mawar 12k (kirim foto + caption)\n• tambahkan bahan kawat bulu 1 unit 500\n\nContoh hapus/edit:\n• hapus pack kawat bulu\n• hapus unit kawat bulu\n• edit unit kawat bulu jadi 600 perak\n• hapus semua bahan\n• hapus semua katalog`;
            await msg.reply(examples);
        }
        else if (decision.action === 'show_expenses') {
            await handleShowExpenses(msg, businessId, businessName);
        }
        else if (decision.action === 'mark_expense_recorded') {
            const { number } = decision.params;
            const unrecordedExpenses = await businessManager.getExpenses(businessId, false);
            
            if (number < 1 || number > unrecordedExpenses.length) {
                await msg.reply(`❌ Nomor tidak valid. Ada ${unrecordedExpenses.length} pengeluaran yang belum dicatat.`);
                return;
            }
            
            const expense = unrecordedExpenses[number - 1];
            
            try {
                await businessManager.markExpenseAsRecorded(expense.id);
                await msg.reply(`✅ Pengeluaran "${expense.description}" sudah ditandai sebagai tercatat.`);
            } catch (error) {
                await msg.reply('❌ Gagal menandai pengeluaran.');
            }
        }
        else if (decision.action === 'add_income') {
            const { description, amount } = decision.params;
            
            try {
                await businessManager.addIncome(businessId, description, amount);
                await msg.reply(`✅ Pemasukan dicatat:\n${description}\n💰 ${formatCurrency(amount)}`);
            } catch (error) {
                await msg.reply('❌ Gagal mencatat pemasukan.');
            }
        }
        else if (decision.action === 'show_stats') {
            await handleBusinessStats(msg, businessId, businessName);
        }
        else if (decision.action === 'help') {
            await handleBusinessHelp(msg, businessName);
        }
        else if (decision.action === 'multi_command') {
            const commands = decision.params?.commands || [];
            const results = [];

            for (const cmd of commands) {
                try {
                    if (cmd.type === 'add_material') {
                        try {
                            const existing = await businessManager.getMaterialByName(businessId, cmd.name);
                            if (existing) {
                                const updates = {};
                                if (cmd.unitPrice !== undefined) updates.unit_price = cmd.unitPrice;
                                if (cmd.packPrice !== undefined) updates.pack_price = cmd.packPrice || null;
                                if (cmd.perPack !== undefined) updates.per_pack = cmd.perPack || null;

                                if (Object.keys(updates).length > 0) {
                                    await businessManager.updateMaterial(businessId, cmd.name, updates);
                                    results.push(`✅ Bahan *${cmd.name}* diperbarui`);
                                } else {
                                    results.push(`⚠️ Tidak ada perubahan untuk *${cmd.name}*`);
                                }
                            } else {
                                await businessManager.addMaterial(businessId, cmd.name, cmd.unitPrice, cmd.packPrice || null, cmd.perPack || null);
                                results.push(`✅ Bahan *${cmd.name}* ditambahkan`);
                            }
                        } catch (err) {
                            console.error('multi add_material inner error:', err);
                            results.push(`❌ Gagal menambahkan/ memperbarui *${cmd.name}*: ${err.message || err}`);
                        }
                    } else if (cmd.type === 'add_price_tier') {
                        await businessManager.addPriceTier(businessId, cmd.price);
                        results.push(`✅ Harga jual ${formatCurrency(cmd.price)} ditambahkan`);
                    } else if (cmd.type === 'add_catalog') {
                        try {
                            let productionCost = null;
                            if (cmd.productionCost !== undefined) {
                                productionCost = cmd.productionCost;
                            } else if (cmd.materials && Array.isArray(cmd.materials) && cmd.materials.length > 0) {
                                // cmd.materials expected: [{name, quantity},...]
                                const availableMaterials = await businessManager.getMaterials(businessId);
                                const calcInput = [];
                                for (const m of cmd.materials) {
                                    const mat = findMaterialByName(availableMaterials, m.name);
                                    if (mat) {
                                        const unit = (mat.unit_price === null || mat.unit_price === undefined) ? (mat.pack_price && mat.per_pack ? Number(mat.pack_price)/Number(mat.per_pack) : 0) : Number(mat.unit_price);
                                        calcInput.push({ unit_price: unit, quantity: Number(m.quantity) || 0 });
                                    }
                                }
                                    if (calcInput.length > 0) productionCost = businessManager.calculateCost(calcInput);
                                    // build productionMaterials from cmd.materials
                                    const productionMaterials = [];
                                    for (const m of cmd.materials) {
                                        const mat = findMaterialByName(availableMaterials, m.name);
                                        if (mat) {
                                            productionMaterials.push({ name: mat.name, quantity: Number(m.quantity) || null, matchedName: mat.name, unit_price: mat.unit_price || null, found: true });
                                        } else {
                                            productionMaterials.push({ name: m.name, quantity: Number(m.quantity) || null, matchedName: null, unit_price: null, found: false });
                                        }
                                    }
                                }

                                await businessManager.addCatalog(businessId, cmd.name, cmd.price, null, productionCost, productionMaterials);
                                let resText = `✅ Katalog *${cmd.name}* ditambahkan`;
                                if (productionCost !== null) resText += ` (estimasi biaya: ${formatCurrency(productionCost)})`;
                                results.push(resText);
                        } catch (err) {
                            console.error('multi add_catalog error:', err);
                            results.push(`❌ Gagal menambahkan katalog *${cmd.name}*: ${err.message || err}`);
                        }
                    } else if (cmd.type === 'list_catalogs_by_price') {
                        try {
                            const price = cmd.price;
                            if (price === undefined || price === null) {
                                results.push('❌ Perintah list_catalogs_by_price butuh parameter price');
                            } else {
                                const catalogs = await businessManager.getCatalogsByPrice(businessId, price);
                                if (!catalogs || catalogs.length === 0) {
                                    results.push(`📸 Tidak ada katalog dengan harga jual ${formatCurrency(price)}`);
                                } else {
                                    // Send header first
                                    await msg.reply(`📸 *Katalog dengan Harga ${formatCurrency(price)} - ${activeSession.business_name}*\n\nMengirim ${catalogs.length} item...`);
                                    for (let i = 0; i < catalogs.length; i++) {
                                        const catalog = catalogs[i];
                                        if (catalog.image_path && fs.existsSync(catalog.image_path)) {
                                            try {
                                                const media = MessageMedia.fromFilePath(catalog.image_path);
                                                let caption = `${i + 1}. *${catalog.name}*\n💰 ${formatCurrency(catalog.price)}`;
                                                if (catalog.production_cost) caption += `\n💵 Biaya produksi: ${formatCurrency(catalog.production_cost)}`;
                                                await client.sendMessage(msg.from, media, { caption });
                                                if (i < catalogs.length - 1) await new Promise(res => setTimeout(res, 800));
                                                // send details
                                                try {
                                                    let detailMsg = `*${catalog.name}*\n\n*Bahan yang digunakan:*\n`;
                                                    if (catalog.production_materials && Array.isArray(catalog.production_materials) && catalog.production_materials.length > 0) {
                                                        for (const pm of catalog.production_materials) {
                                                            if (pm.found) {
                                                                const qtyText = pm.quantity !== null && pm.quantity !== undefined ? `${pm.quantity} ` : '';
                                                                detailMsg += `• ${qtyText}${pm.matchedName || pm.name}\n`;
                                                            } else {
                                                                detailMsg += `• ${pm.name} (tidak dikenali)\n`;
                                                            }
                                                        }
                                                    } else {
                                                        detailMsg += `• (tidak ada data bahan)\n`;
                                                    }
                                                    detailMsg += `\n*Total Cost:* ${catalog.production_cost ? formatCurrency(catalog.production_cost) : '—'}\n`;
                                                    detailMsg += `*Harga Jual:* ${formatCurrency(catalog.price)}`;
                                                    await msg.reply(detailMsg);
                                                } catch (err) { }
                                            } catch (err) {
                                                console.error('Error sending catalog item (multi):', err);
                                                await msg.reply(`${i + 1}. *${catalog.name}* - ${formatCurrency(catalog.price)}\n(Gambar tidak tersedia)`);
                                            }
                                        } else {
                                            let line = `${i + 1}. *${catalog.name}* - ${formatCurrency(catalog.price)}`;
                                            if (catalog.production_cost) line += `\n(Biaya produksi: ${formatCurrency(catalog.production_cost)})`;
                                            line += '\n(Gambar tidak tersedia)';
                                            await msg.reply(line);
                                            // send details for non-image item
                                            try {
                                                let detailMsg = `*${catalog.name}*\n\n*Bahan yang digunakan:*\n`;
                                                if (catalog.production_materials && Array.isArray(catalog.production_materials) && catalog.production_materials.length > 0) {
                                                    for (const pm of catalog.production_materials) {
                                                        if (pm.found) {
                                                            const qtyText = pm.quantity !== null && pm.quantity !== undefined ? `${pm.quantity} ` : '';
                                                            detailMsg += `• ${qtyText}${pm.matchedName || pm.name}\n`;
                                                        } else {
                                                            detailMsg += `• ${pm.name} (tidak dikenali)\n`;
                                                        }
                                                    }
                                                } else {
                                                    detailMsg += `• (tidak ada data bahan)\n`;
                                                }
                                                detailMsg += `\n*Total Cost:* ${catalog.production_cost ? formatCurrency(catalog.production_cost) : '—'}\n`;
                                                detailMsg += `*Harga Jual:* ${formatCurrency(catalog.price)}`;
                                                await msg.reply(detailMsg);
                                            } catch (err) { }
                                        }
                                    }
                                    results.push(`✅ Mengirim ${catalogs.length} katalog dengan harga ${formatCurrency(price)}`);
                                }
                            }
                        } catch (err) {
                            console.error('multi list_catalogs_by_price error:', err);
                            results.push(`❌ Gagal mengambil katalog untuk price ${cmd.price}`);
                        }
                    } else if (cmd.type === 'add_expense') {
                        await businessManager.addExpense(businessId, cmd.description || 'pengeluaran', cmd.amount || 0);
                        results.push(`✅ Pengeluaran dicatat: ${formatCurrency(cmd.amount || 0)}`);
                    } else if (cmd.type === 'add_income') {
                        await businessManager.addIncome(businessId, cmd.description || 'pemasukan', cmd.amount || 0);
                        results.push(`✅ Pemasukan dicatat: ${formatCurrency(cmd.amount || 0)}`);
                    } else if (cmd.type === 'add_empty_bouquet') {
                        const size = (cmd.size || cmd.ukuran || '').toString().trim();
                        const priceVal = cmd.price !== undefined ? Number(cmd.price) : (cmd.harga !== undefined ? Number(cmd.harga) : null);

                        if (!size) {
                            results.push('❌ Perintah add_empty_bouquet butuh parameter size (mis. "size":"XL").');
                        } else if (!priceVal || isNaN(priceVal)) {
                            results.push('❌ Perintah add_empty_bouquet butuh parameter price yang valid (mis. 55000).');
                        } else {
                            try {
                                const existing = await businessManager.getEmptyBouquetBySize(businessId, size);
                                if (existing) {
                                    await businessManager.updateEmptyBouquet(existing.id, { price: priceVal });
                                    results.push(`✅ Harga buket kosong ukuran *${existing.size}* diperbarui menjadi ${formatCurrency(priceVal)}`);
                                } else {
                                    await businessManager.addEmptyBouquet(businessId, size, priceVal);
                                    results.push(`✅ Harga buket kosong ukuran *${size}* ditambahkan: ${formatCurrency(priceVal)}`);
                                }
                            } catch (err) {
                                console.error('multi add_empty_bouquet error:', err);
                                results.push(`❌ Gagal menambahkan/ memperbarui buket kosong: ${err.message || err}`);
                            }
                        }
                    } else if (cmd.type === 'calculate_bouquet') {
                        // Calculate bouquet estimate: stems, flower (optional), size (optional)
                        const stems = Number(cmd.stems) || Number(cmd.tangkai) || 0;
                        const flower = (cmd.flower || cmd.name || '').toString();
                        const size = cmd.size || cmd.ukuran || null;

                        try {
                            let flowerCost = 0;
                            let usedCatalog = false;
                            if (stems > 0 && flower) {
                                // Prefer catalog price if a matching catalog exists
                                try {
                                    const catalogs = await businessManager.getCatalogs(businessId);
                                    const normFlower = normalizeName(flower);
                                    let matchedCat = catalogs.find(c => normalizeName(c.name) === normFlower) || catalogs.find(c => normalizeName(c.name).includes(normFlower));
                                    if (!matchedCat) {
                                        // token overlap scoring
                                        const targetTokens = new Set(normFlower.split(' ').filter(Boolean));
                                        let best = null; let bestScore = 0;
                                        for (const c of catalogs) {
                                            const ctokens = normalizeName(c.name).split(' ').filter(Boolean);
                                            let score = 0;
                                            for (const t of ctokens) if (targetTokens.has(t)) score++;
                                            if (score > bestScore) { bestScore = score; best = c; }
                                        }
                                        if (bestScore > 0) matchedCat = best;
                                    }

                                    if (matchedCat && matchedCat.price) {
                                        const unit = Number(matchedCat.price) || 0;
                                        flowerCost = unit * stems;
                                        usedCatalog = true;
                                    }
                                } catch (err) {
                                    // ignore catalog lookup errors and fallback to materials
                                    console.error('catalog lookup error in multi calculate_bouquet:', err);
                                }

                                // Fallback to materials if catalog not used
                                if (!usedCatalog) {
                                    const materials = await businessManager.getMaterials(businessId);
                                    const mat = findMaterialByName(materials, flower);
                                    if (mat) {
                                        const unit = (mat.unit_price === null || mat.unit_price === undefined) ? (mat.pack_price && mat.per_pack ? Number(mat.pack_price) / Number(mat.per_pack) : 0) : Number(mat.unit_price);
                                        flowerCost = unit * stems;
                                    }
                                }
                            }

                            let chosenSize = size;
                            let emptyPrice = null;

                            if (chosenSize) {
                                const eb = await businessManager.getEmptyBouquetBySize(businessId, chosenSize);
                                if (eb) emptyPrice = eb.price;
                            } else {
                                const empties = await businessManager.getEmptyBouquets(businessId);
                                const capacities = { 'S': 6, 'M': 12, 'L': 18, 'XL': 24 };
                                // pick the smallest size that fits stems
                                let candidate = null;
                                for (const e of empties) {
                                    const cap = capacities[(e.size || '').toString().toUpperCase()] || null;
                                    if (cap && cap >= stems) {
                                        if (!candidate || (capacities[(e.size||'').toUpperCase()] < capacities[(candidate.size||'').toUpperCase()])) candidate = e;
                                    }
                                }
                                if (!candidate && empties.length > 0) {
                                    // fallback to largest available
                                    candidate = empties.reduce((a, b) => {
                                        const ca = capacities[(a.size||'').toUpperCase()] || 0;
                                        const cb = capacities[(b.size||'').toUpperCase()] || 0;
                                        return cb > ca ? b : a;
                                    });
                                }
                                if (candidate) {
                                    chosenSize = candidate.size;
                                    emptyPrice = candidate.price;
                                }
                            }

                            const total = (Number(flowerCost) || 0) + (Number(emptyPrice) || 0);
                            let text = `✅ Estimasi untuk ${stems} tangkai${flower ? ' ' + flower : ''}:\n`;
                            if (usedCatalog) {
                                text += `• Bunga: ${flowerCost ? formatCurrency(flowerCost) : '—'} (dihitung dari harga katalog)\n`;
                            } else {
                                text += `• Bunga: ${flowerCost ? formatCurrency(flowerCost) : '— (bahan tidak ditemukan)'}\n`;
                            }
                            text += `• Buket kosong (${chosenSize || '—'}): ${emptyPrice ? formatCurrency(emptyPrice) : '— (tidak ada data)'}\n`;
                            text += `• Total estimasi: ${formatCurrency(total)}`;
                            results.push(text);
                        } catch (err) {
                            console.error('multi calculate_bouquet error:', err);
                            results.push(`❌ Gagal menghitung buket: ${err.message || err}`);
                        }
                    } else if (cmd.type === 'list_empty_bouquets') {
                        try {
                            const empties = await businessManager.getEmptyBouquets(businessId);
                            if (!empties || empties.length === 0) {
                                results.push('ℹ️ Belum ada data harga buket kosong.');
                            } else {
                                let lines = '📋 Daftar Buket Kosong:\n';
                                empties.forEach(e => {
                                    lines += `• ${e.size}: ${formatCurrency(e.price)}\n`;
                                });
                                results.push(lines);
                            }
                        } catch (err) {
                            console.error('multi list_empty_bouquets error:', err);
                            results.push(`❌ Gagal mengambil daftar buket kosong: ${err.message || err}`);
                        }
                    } else {
                        results.push(`❌ Perintah tidak dikenali: ${cmd.type}`);
                    }
                } catch (err) {
                    console.error('multi_command business error:', err);
                    results.push(`❌ Gagal menjalankan ${cmd.type}: ${err.message || err}`);
                }
            }

            const summary = results.join('\n');
            await msg.reply(`Hasil multi-command:\n${summary}`);
            addToChatHistory(userId, `Multi-command executed: ${results.length} items`, 'bot');
        }
        else if (decision.action === 'other') {
            // Don't reply if AI doesn't understand - just skip
            console.log('⚠️ Business mode: Action "other" - no response sent');
            return;
        }
    } catch (error) {
        console.error('❌ Business mode error:', error);
        // Don't send generic error message - just log
    }
}

async function handleListMaterials(msg, businessId, businessName) {
    const materials = await businessManager.getMaterials(businessId);
    
    if (materials.length === 0) {
        await msg.reply('📦 Belum ada bahan yang ditambahkan.');
        return;
    }
    
    let response = `📦 *Daftar Bahan - ${businessName}*\n\n`;
    materials.forEach((m, i) => {
        response += `${i + 1}. *${m.name}*\n`;
        response += `   Per unit: ${formatCurrency(m.unit_price)}\n`;
        if (m.pack_price) {
            response += `   Per pack: ${formatCurrency(m.pack_price)}\n`;
        }
        response += '\n';
    });
    
    await msg.reply(response);
}

async function handleListPriceTiers(msg, businessId, businessName) {
    const priceTiers = await businessManager.getPriceTiers(businessId);
    
    if (priceTiers.length === 0) {
        await msg.reply('💰 Belum ada harga jual yang ditambahkan.\n\nSistem akan menggunakan harga default.\nTambahkan harga jual dengan:\n"tambahkan harga jual 12000"');
        return;
    }
    
    let response = `💰 *Daftar Harga Jual - ${businessName}*\n\n`;
    priceTiers.forEach((pt, i) => {
        response += `${i + 1}. ${formatCurrency(pt.price)}\n`;
    });
    
    await msg.reply(response);
}

async function handleAddCatalog(msg, businessId) {
    const text = msg.body.trim();
    
    // Parse caption: "bunga mawar 12K"
    const match = text.match(/(.+?)\s+(\d+[krb]*)/i);
    if (!match) {
        await msg.reply('❌ Format caption tidak valid. Contoh: "bunga mawar 12K"');
        return;
    }
    
    const name = match[1].trim();
    const price = parseAmount(match[2]);
    
    try {
        // Download media
        const media = await msg.downloadMedia();
        if (!media) {
            await msg.reply('❌ Gagal mengunduh gambar.');
            return;
        }
        
        // Save image
        const catalogDir = path.join(__dirname, 'business_catalogs');
        if (!fs.existsSync(catalogDir)) {
            fs.mkdirSync(catalogDir, { recursive: true });
        }
        
        const filename = `catalog_${businessId}_${Date.now()}.${media.mimetype.split('/')[1]}`;
        const filepath = path.join(catalogDir, filename);
        
        const buffer = Buffer.from(media.data, 'base64');
        fs.writeFileSync(filepath, buffer);
        
        // Try to compute production cost by extracting known materials from caption
        let productionCost = null;
        let productionMaterials = null;
        try {
            const availableMaterials = await businessManager.getMaterials(businessId);
            const normalizedCaption = normalizeName(text);
            const found = [];
            const foundMaterialTokens = new Set();
            for (const m of availableMaterials) {
                const mn = normalizeName(m.name);
                if (normalizedCaption.includes(mn)) {
                    // attempt to find quantity near material name
                    const tokenRegex = mn.split(' ').map(t => t.trim()).filter(Boolean).join('\\s+');
                    const reAfter = new RegExp(tokenRegex + '\\s*(\\d+)', 'i');
                    const reBefore = new RegExp('(\\\d+)\\s*' + tokenRegex, 'i');
                    let qty = 1;
                    const matchAfter = text.match(reAfter);
                    const matchBefore = text.match(reBefore);
                    if (matchAfter && matchAfter[1]) qty = Number(matchAfter[1]);
                    else if (matchBefore && matchBefore[1]) qty = Number(matchBefore[1]);

                    found.push({ name: m.name, quantity: qty, unit_price: m.unit_price, pack_price: m.pack_price, per_pack: m.per_pack });
                    mn.split(' ').forEach(t => t && foundMaterialTokens.add(t));
                }
            }

            // Extract tokens from caption that look like potential material names but were not matched
            const stopwords = new Set(['k','rb','ribu','per','pack','pcs','kg','g','unit','buah','pc','katalog','harga','jual']);
            const captionTokens = normalizedCaption.split(' ').filter(Boolean);
            const productNameTokens = normalizeName(name).split(' ').filter(Boolean);
            const notFoundSet = new Set();
            for (const tok of captionTokens) {
                if (!tok) continue;
                if (productNameTokens.includes(tok)) continue;
                if (stopwords.has(tok)) continue;
                if (/^\d+$/.test(tok)) continue;
                if (foundMaterialTokens.has(tok)) continue;
                notFoundSet.add(tok);
            }

            const notFound = Array.from(notFoundSet);

            // Build productionMaterials array combining found and not-found items
            productionMaterials = [];
            for (const f of found) {
                productionMaterials.push({ name: f.name, quantity: f.quantity, matchedName: f.name, unit_price: f.unit_price || null, found: true });
            }
            for (const nf of notFound) {
                productionMaterials.push({ name: nf, quantity: null, matchedName: null, unit_price: null, found: false });
            }

            if (found.length > 0) {
                // Map to calculateCost input
                const calcInput = found.map(f => ({ unit_price: f.unit_price, quantity: f.quantity }));
                productionCost = businessManager.calculateCost(calcInput);
            }
        } catch (err) {
            console.error('Error computing production cost for catalog:', err);
        }

        // Add to database (include production cost and materials if available)
        await businessManager.addCatalog(businessId, name, price, filepath, productionCost, productionMaterials);

        let replyMsg = `✅ Katalog *${name}* berhasil ditambahkan dengan harga ${formatCurrency(price)}`;
        if (productionCost !== null) replyMsg += `\n💵 Estimasi Biaya Produksi: ${formatCurrency(productionCost)}`;
        await msg.reply(replyMsg);
    } catch (error) {
        console.error('Error adding catalog:', error);
        await msg.reply('❌ Gagal menambahkan katalog.');
    }
}

async function handleShowCatalogs(msg, businessId, businessName, productName = null) {
    // If a specific productName is requested, try to find and show only that catalog
    if (productName) {
        // Try exact lookup first
        let catalog = await businessManager.getCatalogByName(businessId, productName);

        if (!catalog) {
            // Fallback: fuzzy search among catalogs
            const catalogsAll = await businessManager.getCatalogs(businessId);
            const normTarget = normalizeName(productName);
            catalog = catalogsAll.find(c => normalizeName(c.name) === normTarget) || catalogsAll.find(c => normalizeName(c.name).includes(normTarget)) || null;
        }

        if (!catalog) {
            await msg.reply(`⚠️ Katalog "${productName}" tidak ditemukan.`);
            return;
        }

        // Send the single catalog
        try {
            if (catalog.image_path && fs.existsSync(catalog.image_path)) {
                const media = MessageMedia.fromFilePath(catalog.image_path);
                let caption = `*${catalog.name}*\n💰 ${formatCurrency(catalog.price)}`;
                if (catalog.production_cost) caption += `\n💵 Biaya produksi: ${formatCurrency(catalog.production_cost)}`;
                await client.sendMessage(msg.from, media, { caption });
            } else {
                let line = `*${catalog.name}* - ${formatCurrency(catalog.price)}`;
                if (catalog.production_cost) line += `\n(Biaya produksi: ${formatCurrency(catalog.production_cost)})`;
                line += `\n(Gambar tidak tersedia)`;
                await msg.reply(line);
            }

            // send details
            let detailMsg = `*${catalog.name}*\n\n*Bahan yang digunakan:*\n`;
            if (catalog.production_materials && Array.isArray(catalog.production_materials) && catalog.production_materials.length > 0) {
                for (const pm of catalog.production_materials) {
                    if (pm.found) {
                        const qtyText = pm.quantity !== null && pm.quantity !== undefined ? `${pm.quantity} ` : '';
                        detailMsg += `• ${qtyText}${pm.matchedName || pm.name}\n`;
                    } else {
                        detailMsg += `• ${pm.name} (tidak dikenali)\n`;
                    }
                }
            } else {
                detailMsg += `• (tidak ada data bahan)\n`;
            }

            detailMsg += `\n*Total Cost:* ${catalog.production_cost ? formatCurrency(catalog.production_cost) : '—'}\n`;
            detailMsg += `*Harga Jual:* ${formatCurrency(catalog.price)}`;

            await msg.reply(detailMsg);
        } catch (err) {
            console.error('Error sending specific catalog:', err);
            await msg.reply(`⚠️ Gagal mengirim katalog "${productName}".`);
        }

        return;
    }

    // Default: show all catalogs (existing behavior)
    const catalogs = await businessManager.getCatalogs(businessId);
    
    if (catalogs.length === 0) {
        await msg.reply('📸 Belum ada katalog.');
        return;
    }
    
    await msg.reply(`📸 *Katalog - ${businessName}*\n\nTotal ${catalogs.length} item:\n\nMengirim katalog...`);
    
    // Send each catalog as separate message
    for (let i = 0; i < catalogs.length; i++) {
        const catalog = catalogs[i];
        
        if (catalog.image_path && fs.existsSync(catalog.image_path)) {
            try {
                const media = MessageMedia.fromFilePath(catalog.image_path);
                let caption = `${i + 1}. *${catalog.name}*\n💰 ${formatCurrency(catalog.price)}`;
                if (catalog.production_cost) caption += `\n💵 Biaya produksi: ${formatCurrency(catalog.production_cost)}`;
                await client.sendMessage(msg.from, media, { caption });

                // Delay to avoid rate limiting
                if (i < catalogs.length - 1) {
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
            } catch (error) {
                console.error(`Error sending catalog ${catalog.name}:`, error);
                let line = `${i + 1}. *${catalog.name}* - ${formatCurrency(catalog.price)}`;
                if (catalog.production_cost) line += `\n(Biaya produksi: ${formatCurrency(catalog.production_cost)})`;
                line += `\n(Gambar tidak tersedia)`;
                await msg.reply(line);
            }
        } else {
            let line = `${i + 1}. *${catalog.name}* - ${formatCurrency(catalog.price)}`;
            if (catalog.production_cost) line += `\n(Biaya produksi: ${formatCurrency(catalog.production_cost)})`;
            line += `\n(Gambar tidak tersedia)`;
            await msg.reply(line);
        }
        
        // Send detailed breakdown (materials, total cost, selling price)
        try {
            let detailMsg = `*${catalog.name}*\n\n*Bahan yang digunakan:*\n`;
            if (catalog.production_materials && Array.isArray(catalog.production_materials) && catalog.production_materials.length > 0) {
                for (const pm of catalog.production_materials) {
                    if (pm.found) {
                        const qtyText = pm.quantity !== null && pm.quantity !== undefined ? `${pm.quantity} ` : '';
                        detailMsg += `• ${qtyText}${pm.matchedName || pm.name}\n`;
                    } else {
                        detailMsg += `• ${pm.name} (tidak dikenali)\n`;
                    }
                }
            } else {
                detailMsg += `• (tidak ada data bahan)\n`;
            }

            detailMsg += `\n*Total Cost:* ${catalog.production_cost ? formatCurrency(catalog.production_cost) : '—'}\n`;
            detailMsg += `*Harga Jual:* ${formatCurrency(catalog.price)}`;

            await msg.reply(detailMsg);
        } catch (err) {
            // ignore errors when sending details
        }
    }
}

async function handleShowExpenses(msg, businessId, businessName) {
    const allExpenses = await businessManager.getExpenses(businessId, true);
    const unrecordedExpenses = allExpenses.filter(e => e.is_recorded === 0);
    
    if (allExpenses.length === 0) {
        await msg.reply('📊 Belum ada pengeluaran.');
        return;
    }
    
    let response = `📊 *Pengeluaran - ${businessName}*\n\n`;
    
    if (unrecordedExpenses.length > 0) {
        response += '🔴 *Belum Dicatat:*\n';
        unrecordedExpenses.forEach((e, i) => {
            response += `${i + 1}. ${e.description}\n`;
            response += `   💰 ${formatCurrency(e.amount)}\n`;
            response += `   🕐 ${formatDate(e.created_at)}\n\n`;
        });
    }
    
    const recordedExpenses = allExpenses.filter(e => e.is_recorded === 1);
    if (recordedExpenses.length > 0) {
        response += '✅ *Sudah Dicatat:*\n';
        recordedExpenses.slice(0, 5).forEach((e, i) => {
            response += `• ${e.description} - ${formatCurrency(e.amount)}\n`;
        });
        if (recordedExpenses.length > 5) {
            response += `\n_...dan ${recordedExpenses.length - 5} lainnya_\n`;
        }
    }
    
    const totalExpense = allExpenses.reduce((sum, e) => sum + e.amount, 0);
    response += `\n💵 *Total Pengeluaran: ${formatCurrency(totalExpense)}*`;
    
    await msg.reply(response);
}

async function handleBusinessStats(msg, businessId, businessName) {
    const stats = await businessManager.getBusinessStats(businessId);
    
    let response = `📊 *Statistik Bisnis - ${businessName}*\n\n`;
    response += `📈 Pemasukan: ${formatCurrency(stats.totalIncome)}\n`;
    response += `📉 Pengeluaran: ${formatCurrency(stats.totalExpense)}\n`;
    response += `💰 *Profit: ${formatCurrency(stats.profit)}*\n\n`;
    response += `📦 Jumlah Bahan: ${stats.materialsCount}\n`;
    response += `📸 Jumlah Katalog: ${stats.catalogsCount}\n`;
    
    if (stats.unrecordedExpensesCount > 0) {
        response += `\n⚠️ ${stats.unrecordedExpensesCount} pengeluaran belum dicatat`;
    }
    
    await msg.reply(response);
}

async function handleBusinessHelp(msg, businessName) {
    // If user asked a specific question like "cara pakai ...", extract topic
    const text = msg.body || '';
    const topic = (() => {
        const t = text.match(/cara pakai\s+(.+)|bagaimana cara (?:pakai\s*)?(.+)|how to use\s+(.+)/i);
        if (t) return (t[1] || t[2] || t[3] || '').trim();
        return null;
    })();

    try {
        if (topic) {
            const explanation = await explainFeature(topic, { mode: 'business', businessName });
            await msg.reply(explanation);
            return;
        }

        // If no specific topic, ask AI for a concise business-mode guide
        const explanation = await explainFeature('business mode', { mode: 'business', businessName });
        await msg.reply(explanation);
    } catch (err) {
        console.error('❌ Business help generation failed:', err);
        const helpText = `🏢 *Mode Bisnis: ${businessName}*\n\nKetik "bagaimana cara pakai [fitur]" mis. "bagaimana cara pakai katalog" atau kirim "help" untuk panduan umum.`;
        await msg.reply(helpText);
    }
}

// Helper function to parse amount (support K, rb, ribu)
function parseAmount(str) {
    const cleaned = str.toLowerCase().replace(/\./g, '').replace(/,/g, '');
    
    if (cleaned.includes('k') && !cleaned.includes('rb')) {
        return parseFloat(cleaned.replace('k', '')) * 1000;
    }
    if (cleaned.includes('rb') || cleaned.includes('ribu')) {
        return parseFloat(cleaned.replace(/rb|ribu/g, '')) * 1000;
    }
    if (cleaned.includes('jt') || cleaned.includes('juta')) {
        return parseFloat(cleaned.replace(/jt|juta/g, '')) * 1000000;
    }
    
    return parseFloat(cleaned);
}

// Normalize material/catalog names for matching
function normalizeName(s) {
    if (!s) return '';
    return s.toString().toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Find best matching material by name from a list of materials
function findMaterialByName(materials, name) {
    if (!name || !materials || materials.length === 0) return null;
    const target = normalizeName(name);

    // exact match first
    for (const m of materials) {
        if (normalizeName(m.name) === target) return m;
    }

    // substring match (material contains target or target contains material)
    for (const m of materials) {
        const mn = normalizeName(m.name);
        if (mn.includes(target) || target.includes(mn)) return m;
    }

    // token overlap scoring
    const targetTokens = new Set(target.split(' ').filter(Boolean));
    let best = null;
    let bestScore = 0;
    for (const m of materials) {
        const mtokens = normalizeName(m.name).split(' ').filter(Boolean);
        let score = 0;
        for (const t of mtokens) {
            if (targetTokens.has(t)) score++;
        }
        if (score > bestScore) {
            bestScore = score;
            best = m;
        }
    }

    // Return best only if there is some overlap
    return bestScore > 0 ? best : null;
}

// Parse freeform catalog update messages like:
// "update daun v3,\nbahan :\n1 kawat bulu\ntfl"
function parseCatalogUpdateText(text) {
    if (!text) return null;
    const t = text.trim();
    const m = t.match(/^(?:update|perbarui|ubah)\s+([^,\n]+)(?:[,\n].*)?/i);
    if (!m) return null;
    let productName = m[1].trim();

    // Try to extract price if it's attached to the product name like "daun v2 6000"
    let price = null;
    const priceInNameMatch = productName.match(/(.+?)\s+(\d[\d\.,]*(?:\s*(?:k|rb|ribu|jt|juta))?)$/i);
    if (priceInNameMatch) {
        productName = priceInNameMatch[1].trim();
        try { price = parseAmount(priceInNameMatch[2]); } catch (e) { price = null; }
    }

    // Find the 'bahan' block (everything after the word 'bahan')
    let bahanText = null;
    const bahanMatch = t.match(/bahan\s*[:\-]?\s*([\s\S]*)/i);
    if (bahanMatch) {
        bahanText = bahanMatch[1].trim();
    } else {
        // If there's no explicit 'bahan' keyword, accept trailing content after a comma/newline
        const afterMatch = t.match(/^(?:update|perbarui|ubah)\s+[^,\n]+[,\n]\s*([\s\S]+)/i);
        if (afterMatch) bahanText = afterMatch[1].trim();
    }

    // Also look for an explicit 'harga' token anywhere if price not found yet
    if (price === null) {
        const hargaMatch = t.match(/harga\s*[:\-]?\s*(\d[\d\.,]*(?:\s*(?:k|rb|ribu|jt|juta))?)/i);
        if (hargaMatch) {
            try { price = parseAmount(hargaMatch[1]); } catch (e) { price = null; }
        }
    }

    return { productName, bahanText, price };
}

// Message handler
client.on('message', async (msg) => {
    const userId = msg.from;
    const text = msg.body.trim();
    
    try {
        // Skip status updates dan grup
        if (msg.isStatus || msg.from.includes('@g.us')) {
            return;
        }

        // Add to chat history
        addToChatHistory(userId, text, 'user');

        // Check if in business mode
        const activeSession = await businessManager.getActiveSession(userId);
        
        if (activeSession) {
            // Handle business mode commands
            await handleBusinessMode(msg, activeSession);
            return;
        }

        // Check if trying to enter business mode
        if (text.toLowerCase().includes('mode bisnis') || text.toLowerCase().includes('masuk bisnis')) {
            await handleEnterBusinessMode(msg);
            return;
        }

        // Check if trying to create business
        if (text.toLowerCase().includes('buat bisnis') || text.toLowerCase().includes('bisnis baru')) {
            await handleCreateBusiness(msg);
            return;
        }

        // Handle business creation state
        if (client.businessCreationState && client.businessCreationState.has(userId)) {
            const state = client.businessCreationState.get(userId);
            
            if (state.stage === 'waiting_credentials') {
                // Parse username and password
                const usernameMatch = text.match(/username:\s*(\S+)/i);
                const passwordMatch = text.match(/password:\s*(\S+)/i);
                
                if (!usernameMatch || !passwordMatch) {
                    await msg.reply('❌ Format tidak valid. Silakan kirim:\nusername: [username]\npassword: [password]');
                    return;
                }
                
                const username = usernameMatch[1];
                const password = passwordMatch[1];
                
                try {
                    await businessManager.createBusiness(userId, state.businessName, username, password, state.description);
                    await msg.reply(`✅ Bisnis *${state.businessName}* berhasil dibuat!\n\nUntuk masuk ke mode bisnis, ketik:\n"mode bisnis"`);
                    client.businessCreationState.delete(userId);
                } catch (error) {
                    if (error.message === 'BUSINESS_ALREADY_EXISTS') {
                        await msg.reply(`⚠️ Bisnis *${state.businessName}* sudah ada.`);
                    } else {
                        await msg.reply('❌ Gagal membuat bisnis.');
                    }
                    client.businessCreationState.delete(userId);
                }
                return;
            }
        }

        // Handle business login state
        if (client.businessLoginState && client.businessLoginState.has(userId)) {
            const state = client.businessLoginState.get(userId);
            
            if (state.stage === 'waiting_business_name') {
                // Allow entering any existing business name (not only user's own business)
                const business = await businessManager.getBusinessByNameAny(text);

                if (!business) {
                    await msg.reply(`❌ Bisnis *${text}* tidak ditemukan.`);
                    client.businessLoginState.delete(userId);
                    return;
                }

                // Ask for credentials
                await msg.reply(`🔐 *Login ke ${business.name}*\n\nSilakan kirim username dan password dengan format:\nusername: [username]\npassword: [password]`);

                state.stage = 'waiting_credentials';
                state.businessId = business.id;
                state.businessName = business.name;
                client.businessLoginState.set(userId, state);
                return;
            }
            
            if (state.stage === 'waiting_credentials') {
                // Parse username and password
                const usernameMatch = text.match(/username:\s*(\S+)/i);
                const passwordMatch = text.match(/password:\s*(\S+)/i);
                
                if (!usernameMatch || !passwordMatch) {
                    await msg.reply('❌ Format tidak valid. Silakan kirim:\nusername: [username]\npassword: [password]');
                    return;
                }
                
                const username = usernameMatch[1];
                const password = passwordMatch[1];
                
                // Verify credentials across businesses (returns business row on success)
                const matchedBusiness = await businessManager.verifyBusinessCredentials(userId, state.businessName, username, password);

                if (!matchedBusiness) {
                    await msg.reply('❌ Username atau password salah.');
                    client.businessLoginState.delete(userId);
                    return;
                }

                // Start business session for this user with the matched business id
                await businessManager.startBusinessSession(userId, matchedBusiness.id);
                await msg.reply(`✅ *Masuk ke Mode Bisnis: ${state.businessName}*\n\nKetik "help" untuk melihat perintah yang tersedia.\nKetik "keluar" untuk kembali ke mode personal.`);
                client.businessLoginState.delete(userId);
                return;
            }
        }

        // Get user wallets for AI context
        const userWallets = await financeManager.getWallets(userId);

        // AI Decision Making - AI yang tentukan action
        console.log(`📨 Pesan dari ${userId}: ${text}`);
        const history = getChatHistory(userId, 5);
        
        const decision = await aiDecideAction(text, history, userWallets);
        
        if (!decision) {
            console.log('⚠️ Personal mode: AI returned null - no response sent');
            return;
        }
        
        console.log(`🤖 AI Action: ${decision.action}`);
        console.log(`📋 Reasoning: ${decision.reasoning}`);
        
        // Execute action based on AI decision
        try {
        if (decision.action === 'list_catalogs_by_price') {
            const price = decision.params?.price;
            if (!price && price !== 0) {
                await msg.reply('❌ Harap sebutkan harga yang ingin dicari. Contoh: "list katalog harga jual 12k"');
                return;
            }

            try {
                const catalogs = await businessManager.getCatalogsByPrice(businessId, price);
                if (!catalogs || catalogs.length === 0) {
                    await msg.reply(`📸 Tidak ada katalog dengan harga jual ${formatCurrency(price)}.`);
                    return;
                }

                await msg.reply(`📸 *Katalog dengan Harga ${formatCurrency(price)} - ${businessName}*\n\nTotal ${catalogs.length} item:\n\nMengirim katalog...`);
                for (let i = 0; i < catalogs.length; i++) {
                    const catalog = catalogs[i];
                    if (catalog.image_path && fs.existsSync(catalog.image_path)) {
                        try {
                            const media = MessageMedia.fromFilePath(catalog.image_path);
                            let caption = `${i + 1}. *${catalog.name}*\n💰 ${formatCurrency(catalog.price)}`;
                            if (catalog.production_cost) caption += `\n💵 Biaya produksi: ${formatCurrency(catalog.production_cost)}`;
                            await client.sendMessage(msg.from, media, { caption });
                            if (i < catalogs.length - 1) await new Promise(res => setTimeout(res, 1000));
                        } catch (err) {
                            console.error('Error sending catalog item:', err);
                            let line = `${i + 1}. *${catalog.name}* - ${formatCurrency(catalog.price)}`;
                            if (catalog.production_cost) line += `\n(Biaya produksi: ${formatCurrency(catalog.production_cost)})`;
                            line += `\n(Gambar tidak tersedia)`;
                            await msg.reply(line);
                        }
                    } else {
                        let line = `${i + 1}. *${catalog.name}* - ${formatCurrency(catalog.price)}`;
                        if (catalog.production_cost) line += `\n(Biaya produksi: ${formatCurrency(catalog.production_cost)})`;
                        line += `\n(Gambar tidak tersedia)`;
                        await msg.reply(line);
                    }
                }
            } catch (err) {
                console.error('list_catalogs_by_price error:', err);
                await msg.reply('❌ Gagal mengambil katalog berdasarkan harga.');
            }

            return;
        }
            if (decision.action === 'check_balance') {
                const balance = await financeManager.getBalance(userId);
                const wallets = await financeManager.getWallets(userId);
                
                let response = `💰 *Saldo Total*\n${formatCurrency(balance)}\n\n`;
                
                if (wallets.length > 0) {
                    response += `📊 *Per Kantong:*\n`;
                    wallets.forEach(w => {
                        const icon = w.type === 'savings' ? '🐷' : '💼';
                        response += `${icon} ${w.name}: ${formatCurrency(w.balance)}\n`;
                    });
                }
                
                await msg.reply(response);
                addToChatHistory(userId, response, 'bot');
            }
            else if (decision.action === 'check_wallet_balance') {
                const walletName = decision.params.wallet;
                const wallet = userWallets.find(w => w.name.toLowerCase() === walletName.toLowerCase());
                
                if (!wallet) {
                    await msg.reply(`❌ Kantong *${walletName}* tidak ditemukan.`);
                    return;
                }
                
                const response = `💰 Saldo *${wallet.name}*: ${formatCurrency(wallet.balance)}`;
                await msg.reply(response);
                addToChatHistory(userId, response, 'bot');
            }
            else if (decision.action === 'adjustment') {
                const walletName = decision.params.wallet;
                const realBalance = decision.params.realBalance;
                
                // Get current balance from wallet
                const wallet = userWallets.find(w => w.name.toLowerCase() === walletName.toLowerCase());
                
                if (!wallet) {
                    await msg.reply(`❌ Kantong *${walletName}* tidak ditemukan.`);
                    return;
                }
                
                const result = await financeManager.adjustWalletBalance(
                    userId,
                    walletName,
                    wallet.balance,
                    realBalance,
                    decision.params.description || 'Penyesuaian saldo'
                );
                
                if (result.difference === 0) {
                    await msg.reply(`ℹ️ Saldo ${walletName} sudah sesuai (${formatCurrency(realBalance)})`);
                } else {
                    const sign = result.difference > 0 ? '+' : '';
                    const response = `✅ *Penyesuaian Saldo*\n\n` +
                        `Kantong: ${walletName}\n` +
                        `Saldo tercatat: ${formatCurrency(wallet.balance)}\n` +
                        `Saldo sebenarnya: ${formatCurrency(realBalance)}\n` +
                        `Selisih: ${sign}${formatCurrency(result.difference)}\n\n` +
                        `💰 Saldo baru: ${formatCurrency(result.newBalance)}`;
                    await msg.reply(response);
                    addToChatHistory(userId, response, 'bot');
                }
            }
            else if (decision.action === 'income') {
                await financeManager.addIncome(
                    userId,
                    decision.params.amount,
                    decision.params.description,
                    decision.params.wallet || 'cash',
                    decision.params.category,
                    decision.params.date
                );
                
                const dateInfo = decision.params.date ? ` (${decision.params.date})` : '';
                const response = `✅ Pemasukan ${formatCurrency(decision.params.amount)} ke ${decision.params.wallet}${dateInfo}`;
                await msg.reply(response);
                addToChatHistory(userId, response, 'bot');
            }
            else if (decision.action === 'expense') {
                await financeManager.addExpense(
                    userId,
                    decision.params.amount,
                    decision.params.description,
                    decision.params.wallet || 'cash',
                    decision.params.category || 'lainnya',
                    decision.params.date
                );
                
                const dateInfo = decision.params.date ? ` (${decision.params.date})` : '';
                const response = `✅ Pengeluaran ${formatCurrency(decision.params.amount)} dari ${decision.params.wallet}${dateInfo}`;
                await msg.reply(response);
                addToChatHistory(userId, response, 'bot');
            }
            else if (decision.action === 'transfer') {
                await financeManager.transferBetweenWallets(
                    userId,
                    decision.params.amount,
                    decision.params.fromWallet,
                    decision.params.toWallet,
                    decision.params.description,
                    decision.params.date
                );
                
                const response = `✅ Transfer ${formatCurrency(decision.params.amount)}: ${decision.params.fromWallet} → ${decision.params.toWallet}`;
                await msg.reply(response);
                addToChatHistory(userId, response, 'bot');
            }
            else if (decision.action === 'create_wallet') {
                await financeManager.createWallet(
                    userId,
                    decision.params.name,
                    decision.params.type || 'regular',
                    decision.params.includeInTotal !== false
                );
                
                const response = `✅ Kantong *${decision.params.name}* berhasil dibuat`;
                await msg.reply(response);
                addToChatHistory(userId, response, 'bot');
            }
            else if (decision.action === 'update_wallet') {
                const updates = {};
                if (decision.params.includeInTotal !== undefined) {
                    updates.include_in_total = decision.params.includeInTotal ? 1 : 0;
                }
                if (decision.params.type) {
                    updates.type = decision.params.type;
                }
                
                await financeManager.updateWallet(userId, decision.params.name, updates);
                
                let response = `✅ Kantong *${decision.params.name}* berhasil diupdate`;
                if (updates.include_in_total !== undefined) {
                    response += `\n${updates.include_in_total ? '✓' : '✗'} Dihitung dalam total saldo`;
                }
                
                await msg.reply(response);
                addToChatHistory(userId, response, 'bot');
            }
            else if (decision.action === 'show_history') {
                const period = decision.params?.period || 'today';
                const yearMonth = decision.params?.month || null;
                const limit = decision.params?.limit || 10;
                
                const txHistory = await financeManager.getHistoryByPeriod(userId, period, yearMonth, limit);
                
                if (txHistory.length === 0) {
                    const periodLabels = {
                        'today': 'Hari Ini',
                        'this_month': 'Bulan Ini',
                        'last_month': 'Bulan Lalu',
                        'all_time': 'Seluruh Periode',
                        'specific_month': yearMonth ? `Bulan ${yearMonth}` : 'Bulan Tertentu'
                    };
                    await msg.reply(`📋 *Riwayat Transaksi ${periodLabels[period]}*\n\nBelum ada transaksi.`);
                    return;
                }

                const periodLabels = {
                    'today': 'Hari Ini',
                    'this_month': 'Bulan Ini',
                    'last_month': 'Bulan Lalu',
                    'all_time': `Semua (${txHistory.length} transaksi)`,
                    'specific_month': yearMonth ? yearMonth : 'Bulan Tertentu'
                };

                let response = `📋 *Riwayat Transaksi ${periodLabels[period]}*\n\n`;
                
                txHistory.forEach((tx, index) => {
                    const icon = tx.type === 'income' ? '📈' : '📉';
                    const sign = tx.type === 'income' ? '+' : '-';
                    const label = tx.type === 'income' ? 'Pemasukan' : 'Pengeluaran';
                    
                    response += `${index + 1}. ${icon} *${label}*\n`;
                    response += `   ${sign}${formatCurrency(tx.amount)}\n`;
                    response += `   📝 ${tx.description}\n`;
                    if (tx.category) response += `   🏷️ ${tx.category}\n`;
                    if (tx.wallet_name) response += `   💼 ${tx.wallet_name}\n`;
                    response += `   🕐 ${formatDate(tx.created_at)}\n\n`;
                });

                const balance = await financeManager.getBalance(userId);
                response += `💰 *Saldo Saat Ini*\n${formatCurrency(balance)}`;

                await msg.reply(response);
                addToChatHistory(userId, response, 'bot');
            }
            else if (decision.action === 'show_stats') {
                const period = decision.params?.period || 'today';
                const balance = await financeManager.getBalance(userId);
                
                try {
                    if (period === 'all_time') {
                        // All-time stats with monthly trends chart
                        await msg.reply('⏳ Sedang membuat chart trend bulanan...');
                        
                        const monthlyData = await financeManager.getMonthlyTrends(userId);
                        const allTimeStats = await financeManager.getAllTimeStats(userId);
                        const firstDate = await financeManager.getFirstTransactionDate(userId);
                        
                        if (Object.keys(monthlyData).length === 0) {
                            await msg.reply('📊 *Belum ada data transaksi*');
                            return;
                        }
                        
                        const monthCount = Object.keys(monthlyData).length;
                        
                        const chartMedia = await chartGenerator.generateMonthlyTrendsChartMedia(
                            monthlyData,
                            allTimeStats.income,
                            allTimeStats.expense
                        );
                        
                        const caption = chartGenerator.generateTrendsCaption(
                            monthlyData,
                            allTimeStats.income,
                            allTimeStats.expense,
                            monthCount
                        );
                        
                        await client.sendMessage(userId, chartMedia, { caption });
                        addToChatHistory(userId, 'Chart trend bulanan dikirim', 'bot');
                        
                    } else if (period === 'today') {
                        // Daily stats with pie chart if available
                        const stats = await financeManager.getDailyStats(userId);
                        const categoryStats = await financeManager.getDailyCategoryStats(userId);
                        
                        if (categoryStats.length > 0) {
                            await msg.reply('⏳ Sedang membuat chart statistik...');
                            
                            const chartMedia = await chartGenerator.generateExpenseChartMedia(
                                categoryStats,
                                stats.income,
                                stats.expense,
                                'Hari Ini'
                            );
                            
                            let caption = `📊 *Statistik Hari Ini*\n\n`;
                            caption += `📈 Pemasukan: ${formatCurrency(stats.income)}\n`;
                            caption += `   (${stats.incomeCount} transaksi)\n\n`;
                            caption += `📉 Pengeluaran: ${formatCurrency(stats.expense)}\n`;
                            caption += `   (${stats.expenseCount} transaksi)\n\n`;
                            
                            const totalExpenseValue = categoryStats.reduce((sum, cat) => sum + cat.total, 0);
                            caption += `🏷️ *Pengeluaran per Kategori:*\n`;
                            categoryStats.forEach(cat => {
                                const percentage = ((cat.total / totalExpenseValue) * 100).toFixed(1);
                                const icon = chartGenerator.getCategoryIcon(cat.category);
                                caption += `${icon} ${cat.category}: ${formatCurrency(cat.total)} (${percentage}%)\n`;
                            });
                            caption += `\n💰 Saldo: ${formatCurrency(balance)}\n`;
                            caption += `📊 Net Hari Ini: ${formatCurrency(stats.income - stats.expense)}`;
                            
                            await client.sendMessage(userId, chartMedia, { caption });
                            addToChatHistory(userId, 'Chart statistik hari ini dikirim', 'bot');
                        } else {
                            let response = `📊 *Statistik Hari Ini*\n\n` +
                                `📈 Pemasukan: ${formatCurrency(stats.income)}\n` +
                                `   (${stats.incomeCount} transaksi)\n\n` +
                                `📉 Pengeluaran: ${formatCurrency(stats.expense)}\n` +
                                `   (${stats.expenseCount} transaksi)\n\n` +
                                `💰 Saldo: ${formatCurrency(balance)}\n\n` +
                                `📊 Net: ${formatCurrency(stats.income - stats.expense)}\n\n` +
                                `_Belum ada pengeluaran hari ini_`;
                            await msg.reply(response);
                            addToChatHistory(userId, response, 'bot');
                        }
                        
                    } else if (period === 'this_month' || period === 'last_month' || period === 'specific_month') {
                        // Monthly stats with pie chart
                        let yearMonth;
                        let periodLabel;
                        
                        if (period === 'this_month') {
                            const now = new Date();
                            yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
                            periodLabel = 'Bulan Ini';
                        } else if (period === 'last_month') {
                            const now = new Date();
                            now.setMonth(now.getMonth() - 1);
                            yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
                            periodLabel = 'Bulan Lalu';
                        } else {
                            yearMonth = decision.params.month;
                            const [year, month] = yearMonth.split('-');
                            const monthNames = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
                            periodLabel = `${monthNames[parseInt(month) - 1]} ${year}`;
                        }
                        
                        const stats = await financeManager.getMonthlyStatsByMonth(userId, yearMonth);
                        const categoryStats = await financeManager.getCategoryStatsByMonth(userId, yearMonth);
                        
                        if (categoryStats.length > 0) {
                            await msg.reply('⏳ Sedang membuat chart statistik...');
                            
                            const chartMedia = await chartGenerator.generateExpenseChartMedia(
                                categoryStats,
                                stats.income,
                                stats.expense,
                                periodLabel
                            );
                            
                            let caption = `📊 *Statistik ${periodLabel}*\n\n`;
                            caption += `📈 Pemasukan: ${formatCurrency(stats.income)}\n`;
                            caption += `   (${stats.incomeCount} transaksi)\n\n`;
                            caption += `📉 Pengeluaran: ${formatCurrency(stats.expense)}\n`;
                            caption += `   (${stats.expenseCount} transaksi)\n\n`;
                            
                            const totalExpenseValue = categoryStats.reduce((sum, cat) => sum + cat.total, 0);
                            caption += `🏷️ *Pengeluaran per Kategori:*\n`;
                            categoryStats.forEach(cat => {
                                const percentage = ((cat.total / totalExpenseValue) * 100).toFixed(1);
                                const icon = chartGenerator.getCategoryIcon(cat.category);
                                caption += `${icon} ${cat.category}: ${formatCurrency(cat.total)} (${percentage}%)\n`;
                            });
                            caption += `\n💰 Saldo: ${formatCurrency(balance)}\n`;
                            caption += `📊 Net: ${formatCurrency(stats.income - stats.expense)}`;
                            
                            await client.sendMessage(userId, chartMedia, { caption });
                            addToChatHistory(userId, `Chart statistik ${periodLabel} dikirim`, 'bot');
                        } else {
                            let response = `📊 *Statistik ${periodLabel}*\n\n` +
                                `📈 Pemasukan: ${formatCurrency(stats.income)}\n` +
                                `   (${stats.incomeCount} transaksi)\n\n` +
                                `📉 Pengeluaran: ${formatCurrency(stats.expense)}\n` +
                                `   (${stats.expenseCount} transaksi)\n\n` +
                                `💰 Saldo: ${formatCurrency(balance)}\n\n` +
                                `📊 Net: ${formatCurrency(stats.income - stats.expense)}\n\n` +
                                `_Belum ada pengeluaran di periode ini_`;
                            await msg.reply(response);
                            addToChatHistory(userId, response, 'bot');
                        }
                    }
                } catch (error) {
                    console.error('❌ Error generating stats:', error);
                    await msg.reply('❌ Gagal membuat statistik. Silakan coba lagi.');
                }
            }
            else if (decision.action === 'show_wallets') {
                const wallets = await financeManager.getWallets(userId);
                const totalBalance = await financeManager.getBalance(userId);
                
                if (wallets.length === 0) {
                    await msg.reply('🏦 *Belum ada kantong*\n\nBuat kantong dulu dengan:\n• "buatkan kantong cash"\n• "buat kantong tabungan"');
                    return;
                }
                
                let response = '🏦 *Kantong Anda*\n\n';
                wallets.forEach((w, i) => {
                    const icon = w.type === 'savings' ? '🐷' : '💼';
                    const includeText = w.include_in_total ? '' : ' (tidak dihitung)';
                    response += `${i + 1}. ${icon} *${w.name}*${includeText}\n`;
                    response += `   Saldo: ${formatCurrency(w.balance)}\n`;
                    response += `   Tipe: ${w.type}\n\n`;
                });
                
                response += `💰 *Total Saldo*: ${formatCurrency(totalBalance)}`;
                
                await msg.reply(response);
                addToChatHistory(userId, response, 'bot');
            }
            else if (decision.action === 'help') {
                // Determine topic from AI params or message text
                const topic = decision.params?.topic || (() => {
                    const t = text.match(/cara pakai\s+(.+)|bagaimana cara (?:pakai\s*)?(.+)|how to use\s+(.+)/i);
                    if (t) return (t[1] || t[2] || t[3] || '').trim();
                    return null;
                })();

                try {
                    if (topic) {
                        const explanation = await explainFeature(topic, { mode: 'personal' });
                        await msg.reply(explanation);
                    } else {
                        const explanation = await explainFeature(null, { mode: 'personal' });
                        await msg.reply(explanation);
                    }
                } catch (err) {
                    console.error('❌ Help generation failed:', err);
                    await msg.reply('🤖 Bantuan: silakan tulis "bagaimana cara pakai [fitur]" atau ketik "help" untuk panduan singkat.');
                }
            }
            else if (decision.action === 'backup_database') {
                await msg.reply('⏳ Sedang membuat backup database...');
                
                if (!client.backupManager) {
                    await msg.reply('❌ Backup manager belum siap. Silakan coba lagi.');
                    return;
                }
                
                const result = await client.backupManager.sendBackupToOwner();
                
                if (result.success) {
                    await msg.reply('✅ Backup database berhasil dikirim ke owner!');
                } else {
                    await msg.reply(`❌ Gagal backup database: ${result.error}`);
                }
            }
            else if (decision.action === 'export_excel') {
                await msg.reply('⏳ Sedang membuat file Excel...');
                
                try {
                    const type = decision.params.type || 'all';
                    const period = decision.params.period || 'this_month';
                    const month = decision.params.month;
                    
                    // Get wallet data
                    const wallets = await financeManager.getWallets(userId);
                    
                    // Get transactions based on period
                    let transactions = [];
                    const now = new Date();
                    const currentYear = now.getFullYear();
                    const currentMonth = now.getMonth() + 1;
                    
                    if (period === 'today') {
                        const today = now.toISOString().split('T')[0];
                        const allTx = await financeManager.getHistoryByPeriod(userId, 'today');
                        transactions = allTx;
                    } else if (period === 'this_month') {
                        const targetMonth = `${currentYear}-${String(currentMonth).padStart(2, '0')}`;
                        transactions = await financeManager.getHistoryByPeriod(userId, 'this_month');
                    } else if (period === 'last_month') {
                        const lastMonth = currentMonth === 1 ? 12 : currentMonth - 1;
                        const lastYear = currentMonth === 1 ? currentYear - 1 : currentYear;
                        const targetMonth = `${lastYear}-${String(lastMonth).padStart(2, '0')}`;
                        transactions = await financeManager.getHistoryByPeriod(userId, 'last_month');
                    } else if (period === 'specific_month' && month) {
                        transactions = await financeManager.getHistoryByPeriod(userId, 'specific_month', month);
                    } else if (period === 'all_time') {
                        transactions = await financeManager.getHistoryByPeriod(userId, 'all_time');
                    }
                    
                    // Filter by type
                    if (type === 'income') {
                        transactions = transactions.filter(tx => tx.type === 'income');
                    } else if (type === 'expense') {
                        transactions = transactions.filter(tx => tx.type === 'expense');
                    }
                    
                    // Check if no transactions
                    if (transactions.length === 0) {
                        const typeLabel = type === 'income' ? 'pemasukan' : type === 'expense' ? 'pengeluaran' : 'transaksi';
                        const periodLabel = period === 'today' ? 'hari ini' : period === 'this_month' ? 'bulan ini' : period === 'last_month' ? 'bulan lalu' : period === 'specific_month' ? `bulan ${month}` : 'selama ini';
                        await msg.reply(`📊 Tidak ada ${typeLabel} ${periodLabel}`);
                        return;
                    }
                    
                    // Export to Excel with wallet data
                    const result = await excelExporter.exportTransactions(transactions, type, userId, wallets);
                    
                    if (result.success) {
                        // Send Excel file to user
                        await excelExporter.sendExcelToUser(
                            client,
                            userId,
                            result.filePath,
                            result.filename,
                            type,
                            result.totalIncome,
                            result.totalExpense,
                            result.count
                        );
                    } else {
                        await msg.reply('❌ Gagal membuat file Excel');
                    }
                } catch (error) {
                    console.error('❌ Export Excel error:', error);
                    await msg.reply(`❌ Gagal export Excel: ${error.message}`);
                }
            }
            else if (decision.action === 'create_business') {
                // Route to business creation flow
                await handleCreateBusiness(msg, decision.params);
            }
            else if (decision.action === 'enter_business_mode') {
                // Route to business mode login
                await handleEnterBusinessMode(msg);
            }
            else if (decision.action === 'other') {
                // Don't reply if AI doesn't understand - just skip
                console.log('⚠️ Personal mode: Action "other" - no response sent');
                return;
            }
            else if (decision.action === 'multi_command') {
                // Handle multiple commands in sequence
                const commands = decision.params.commands || [];
                let results = [];
                
                for (const cmd of commands) {
                    try {
                        if (cmd.type === 'create_wallet') {
                            await financeManager.createWallet(userId, cmd.name, cmd.walletType || 'regular', cmd.includeInTotal !== false);
                            results.push(`✅ Kantong *${cmd.name}* dibuat`);
                        } 
                        else if (cmd.type === 'transfer') {
                            await financeManager.transferBetweenWallets(userId, cmd.amount, cmd.fromWallet, cmd.toWallet, cmd.description, cmd.date);
                            results.push(`✅ Transfer ${formatCurrency(cmd.amount)}: ${cmd.fromWallet} → ${cmd.toWallet}`);
                        }
                        else if (cmd.type === 'income') {
                            await financeManager.addIncome(userId, cmd.amount, cmd.description, cmd.wallet || 'cash', cmd.category, cmd.date);
                            results.push(`✅ Pemasukan ${formatCurrency(cmd.amount)}`);
                        }
                        else if (cmd.type === 'calculate_bouquet' || cmd.type === 'list_empty_bouquets' || cmd.type === 'add_empty_bouquet') {
                            // Business-only commands: inform user to enter business mode
                            results.push('❌ Perintah terkait bisnis. Masuk ke mode bisnis terlebih dahulu (ketik "mode bisnis").');
                        }
                        else if (cmd.type === 'expense') {
                            await financeManager.addExpense(userId, cmd.amount, cmd.description, cmd.wallet || 'cash', cmd.category || 'lainnya', cmd.date);
                            results.push(`✅ Pengeluaran ${formatCurrency(cmd.amount)}`);
                        }
                        else if (cmd.type === 'adjustment') {
                            // Get current wallet balance
                            const wallets = await financeManager.getWallets(userId);
                            const wallet = wallets.find(w => w.name.toLowerCase() === cmd.wallet.toLowerCase());
                            
                            if (!wallet) {
                                results.push(`❌ Kantong *${cmd.wallet}* tidak ditemukan`);
                            } else {
                                const result = await financeManager.adjustWalletBalance(
                                    userId,
                                    cmd.wallet,
                                    wallet.balance,
                                    cmd.realBalance,
                                    cmd.description || 'Penyesuaian saldo'
                                );
                                
                                if (result.difference === 0) {
                                    results.push(`ℹ️ Saldo ${cmd.wallet} sudah sesuai`);
                                } else {
                                    const sign = result.difference > 0 ? '+' : '';
                                    results.push(`✅ Adjustment ${cmd.wallet}: ${sign}${formatCurrency(result.difference)}`);
                                }
                            }
                        }
                    } catch (error) {
                        if (error.message === 'ALREADY_EXISTS') {
                            results.push(`⚠️ Kantong *${cmd.name}* sudah ada`);
                        } else if (error.message === 'WALLET_NOT_FOUND') {
                            results.push(`❌ Kantong tidak ditemukan`);
                        } else if (error.message === 'INSUFFICIENT_BALANCE') {
                            results.push(`❌ Saldo tidak cukup`);
                        } else {
                            results.push(`❌ Gagal: ${error.message}`);
                        }
                    }
                }
                
                const response = results.join('\n');
                await msg.reply(response);
                addToChatHistory(userId, response, 'bot');
            }
        } catch (error) {
            console.error('❌ Error:', error);
            
            if (error.message === 'ALREADY_EXISTS') {
                await msg.reply('⚠️ Kantong sudah ada.');
            } else if (error.message === 'WALLET_NOT_FOUND') {
                await msg.reply('❌ Kantong tidak ditemukan.');
            } else if (error.message === 'INSUFFICIENT_BALANCE') {
                await msg.reply('❌ Saldo tidak cukup.');
            } else if (error.message === 'FROM_WALLET_NOT_FOUND') {
                await msg.reply('❌ Kantong asal tidak ditemukan.');
            } else if (error.message === 'TO_WALLET_NOT_FOUND') {
                await msg.reply('❌ Kantong tujuan tidak ditemukan.');
            } else {
                // Don't send generic error message - just log
                console.error('❌ Unhandled error:', error.message);
            }
        }
    } catch (error) {
        console.error('❌ Error handler:', error);
    }
});

// Initialize client
console.log('🚀 Starting WhatsApp Bot...\n');
client.initialize();

// Handle process termination
process.on('SIGINT', async () => {
    console.log('\n⏳ Shutting down bot...');
    await client.destroy();
    process.exit(0);
});
