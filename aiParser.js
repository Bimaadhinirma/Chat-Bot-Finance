const { GoogleGenerativeAI } = require("@google/generative-ai");
require('dotenv').config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

/**
 * AI Decision Maker - AI memutuskan action berdasarkan pesan dan context
 * Return: {"action": "...", "params": {...}, "reasoning": "..."}
 */
async function aiDecideAction(message, chatHistory = [], userWallets = []) {
    if (!process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY === 'your_gemini_api_key_here') {
        return null;
    }

    try {
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

        // Build context
        let contextPrompt = '';
        if (chatHistory.length > 0) {
            contextPrompt = 'CHAT HISTORY (5 terakhir):\n';
            chatHistory.slice(-5).forEach(item => {
                contextPrompt += `${item.role === 'user' ? 'User' : 'Bot'}: ${item.message}\n`;
            });
            contextPrompt += '\n';
        }

        let walletsInfo = '';
        if (userWallets.length > 0) {
            walletsInfo = 'WALLET USER:\n';
            userWallets.forEach(w => {
                walletsInfo += `- ${w.name}: ${w.balance} (type: ${w.type}, include_in_total: ${w.include_in_total})\n`;
            });
            walletsInfo += '\n';
        }

        const prompt = `${contextPrompt}${walletsInfo}TANGGAL HARI INI: ${new Date().toISOString().split('T')[0]}

Kamu adalah AI financial assistant. Analisis pesan user dan TENTUKAN ACTION yang tepat berdasarkan:
1. Isi pesan user
2. Chat history sebagai konteks
3. Wallet yang dimiliki user
4. Semua fitur yang tersedia

AVAILABLE ACTIONS:
1. "check_balance" - Cek saldo total atau saldo wallet tertentu
   params: {"wallet": "nama_wallet"} atau {} untuk total
   
2. "check_wallet_balance" - Cek saldo wallet spesifik
   params: {"wallet": "nama_wallet"}
   
3. "adjustment" - Adjust saldo jika user bilang saldo real berbeda
   params: {"wallet": "...", "realBalance": angka, "description": "..."}
   
4. "income" - Tambah pemasukan
   params: {"amount": angka, "wallet": "...", "description": "...", "category": "...", "date": "YYYY-MM-DD" atau null}
   
5. "expense" - Tambah pengeluaran
   params: {"amount": angka, "wallet": "...", "description": "...", "category": "...", "date": "YYYY-MM-DD" atau null}
   
6. "transfer" - Transfer antar wallet
   params: {"amount": angka, "fromWallet": "...", "toWallet": "...", "description": "...", "date": "YYYY-MM-DD" atau null}
   
7. "create_wallet" - Buat wallet baru
   params: {"name": "...", "type": "regular/savings", "includeInTotal": true/false}
   
8. "update_wallet" - Update pengaturan wallet yang sudah ada
   params: {"name": "...", "includeInTotal": true/false} atau {"name": "...", "type": "regular/savings"}
   
9. "multi_command" - Untuk multiple actions dalam 1 pesan
   params: {"commands": [array of command objects]}
   Command types: create_wallet, income, expense, transfer, adjustment
   - create_wallet: {"type":"create_wallet","name":"...","walletType":"regular/savings","includeInTotal":true/false}
   - income: {"type":"income","amount":...,"wallet":"...","description":"...","category":"...","date":"YYYY-MM-DD"}
   - expense: {"type":"expense","amount":...,"wallet":"...","description":"...","category":"...","date":"YYYY-MM-DD"}
   - transfer: {"type":"transfer","amount":...,"fromWallet":"...","toWallet":"...","description":"...","date":"YYYY-MM-DD"}
   - adjustment: {"type":"adjustment","wallet":"...","realBalance":...,"description":"..."}
   
10. "show_history" - Tampilkan riwayat transaksi (DEFAULT: hari ini)
    params: {"period": "today|this_month|last_month|all_time|specific_month", "month": "YYYY-MM" (optional), "limit": number}
    - "transaksi" atau "riwayat" → period: "today", limit: 10 (hari ini)
    - "transaksi bulan ini" → period: "this_month", limit: 20
    - "transaksi bulan lalu" → period: "last_month", limit: 20
    - "transaksi bulan januari" → period: "specific_month", month: "2025-01", limit: 20
    - "transaksi semua" atau "semua transaksi" → period: "all_time", limit: 50
   
11. "show_stats" - Tampilkan statistik (DEFAULT: hari ini)
    params: {"period": "today|this_month|last_month|all_time|specific_month", "month": "YYYY-MM" (optional)}
    - "statistik" atau "stats" → period: "today" (hari ini)
    - "statistik bulan ini" → period: "this_month"
    - "statistik bulan lalu" → period: "last_month"
    - "statistik bulan januari" atau "statistik bulan 1" → period: "specific_month", month: "2025-01"
    - "statistik selama ini" atau "statistik semua" → period: "all_time"
   
12. "show_wallets" - Tampilkan daftar wallet

13. "backup_database" - Backup dan kirim database ke owner
    params: {}
   
14. "export_excel" - Export transaksi ke Excel
    params: {"type": "income|expense|all", "period": "today|this_month|last_month|all_time|specific_month", "month": "YYYY-MM" (optional)}
    - "export excel pengeluaran" → type: "expense", period: "this_month"
    - "export pemasukan bulan ini" → type: "income", period: "this_month"
    - "export semua transaksi" atau "export excel" → type: "all", period: "this_month"
    - "export pengeluaran hari ini" → type: "expense", period: "today"
    - "export excel januari" → type: "all", period: "specific_month", month: "2025-01"
   
15. "help" - Tampilkan bantuan
   
16. "other" - Tidak jelas/perlu info lebih

LOGIC RULES:
- Jika user bilang "tabungan saya 1.5jt" dan dari history/wallet data terlihat beda → ACTION: adjustment
- Jika user tanya "saldo tabungan" → ACTION: check_wallet_balance dengan wallet: "tabungan"
- Jika user bilang "dapat gaji 5jt" → ACTION: income dengan wallet dari context atau default "rekening"
- Jika user bilang "narik 50rb" tanpa tujuan jelas → ACTION: transfer dari rekening ke cash (dari context)
- Jika user minta "buatkan kantong X" → ACTION: create_wallet
- Jika user minta "backup database", "saya mau database nya", "kirim database" → ACTION: backup_database
- DEFAULT statistik adalah HARI INI, bukan bulan ini
- "statistik bulan 6" → specific_month dengan month: "2025-06"
- "statistik januari" atau "statistik bulan januari" → specific_month dengan month: "2025-01"
- Parse angka: "1jt 500" = 1500000, "50rb" = 50000, "5jt" = 5000000, "2500" = 2500
- Parse tanggal: "kemarin" = 2025-11-25, "tanggal 24" = 2025-11-24, "24 november" = 2025-11-24
- PENTING: Untuk multiple actions gunakan multi_command dengan array commands
- Setiap command dalam multi_command harus punya field "type"

CONTOH DECISIONS:
User: "tabungan saya sekarang 1jt 500"
History: Bot bilang tabungan 650rb
→ {"action": "adjustment", "params": {"wallet": "tabungan", "realBalance": 1500000, "description": "Penyesuaian saldo tabungan"}, "reasoning": "User menyebutkan saldo real 1.5jt yang berbeda dari tercatat"}

User: "saldo tabungan"
→ {"action": "check_wallet_balance", "params": {"wallet": "tabungan"}, "reasoning": "User ingin cek saldo wallet tabungan"}

User: "saldo tabungan tidak dihitung" atau "jangan hitung tabungan"
→ {"action": "update_wallet", "params": {"name": "tabungan", "includeInTotal": false}, "reasoning": "User ingin wallet tabungan tidak dihitung dalam total saldo"}

User: "dapat gaji 5jt kemarin"
→ {"action": "income", "params": {"amount": 5000000, "wallet": "rekening", "description": "dapat gaji", "category": "gaji", "date": "2025-11-25"}, "reasoning": "Pemasukan gaji kemarin ke rekening"}

User: "buatkan kantong Cash, Rekening, dan Tabungan"
→ {"action": "multi_command", "params": {"commands": [
  {"type":"create_wallet","name":"cash","walletType":"regular","includeInTotal":true},
  {"type":"create_wallet","name":"rekening","walletType":"regular","includeInTotal":true},
  {"type":"create_wallet","name":"tabungan","walletType":"savings","includeInTotal":true}
]}, "reasoning": "User minta buat 3 kantong sekaligus"}

User: "kemarin saya terima 1jt, transfer 650rb ke tabungan dengan biaya 2500, dan tabungan real saya 1.5jt"
→ {"action": "multi_command", "params": {"commands": [
  {"type":"income","amount":1000000,"wallet":"rekening","description":"terima uang","date":"2025-11-24"},
  {"type":"transfer","amount":650000,"fromWallet":"rekening","toWallet":"tabungan","description":"transfer","date":"2025-11-24"},
  {"type":"expense","amount":2500,"wallet":"rekening","description":"biaya transfer","category":"biaya","date":"2025-11-24"},
  {"type":"adjustment","wallet":"tabungan","realBalance":1500000,"description":"Penyesuaian saldo"}
]}, "reasoning": "Multiple aksi: income, transfer, expense biaya, dan adjustment saldo"}

User: "export excel pengeluaran bulan ini"
→ {"action": "export_excel", "params": {"type": "expense", "period": "this_month"}, "reasoning": "User ingin export Excel untuk pengeluaran bulan ini"}

User: "export semua transaksi"
→ {"action": "export_excel", "params": {"type": "all", "period": "this_month"}, "reasoning": "User ingin export semua transaksi bulan ini ke Excel"}

User: "export pemasukan hari ini"
→ {"action": "export_excel", "params": {"type": "income", "period": "today"}, "reasoning": "User ingin export pemasukan hari ini ke Excel"}

User: "export excel januari"
→ {"action": "export_excel", "params": {"type": "all", "period": "specific_month", "month": "2025-01"}, "reasoning": "User ingin export semua transaksi bulan Januari ke Excel"}

Pesan user: "${message}"

Berikan response dalam format JSON:
{
  "action": "nama_action",
  "params": {...},
  "reasoning": "penjelasan singkat kenapa pilih action ini"
}`;

        const result = await model.generateContent(prompt);
        const response = result.response.text().trim();
        
        // Extract JSON from response
        const jsonMatch = response.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            console.error('❌ AI response tidak valid JSON:', response);
            return null;
        }
        
        const decision = JSON.parse(jsonMatch[0]);
        console.log('🤖 AI Decision:', decision);
        
        return decision;
    } catch (error) {
        console.error('❌ AI decision error:', error.message);
        return null;
    }
}

/**
 * Parse tanggal dari pesan natural language
 */
async function parseDate(message) {
    if (!process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY === 'your_gemini_api_key_here') {
        return null;
    }

    try {
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

        const prompt = `Analisis pesan dan ekstrak tanggal dalam format YYYY-MM-DD. Tanggal hari ini adalah ${new Date().toISOString().split('T')[0]}.

ATURAN:
- "kemarin" → tanggal kemarin
- "tanggal X" atau "tgl X" → bulan dan tahun saat ini
- "tanggal X bulan Y" → tahun saat ini
- "X november", "X desember" → tahun 2025
- Jika tidak ada petunjuk tanggal → null

CONTOH (hari ini: 2025-11-26):
- "kemarin saya dapat uang" → 2025-11-25
- "tanggal 25 november" → 2025-11-25
- "tgl 20" → 2025-11-20
- "15 desember" → 2025-12-15
- "dapat gaji" → null (gunakan hari ini)

Pesan: "${message}"

Berikan HANYA tanggal format YYYY-MM-DD atau kata "null":`;

        const result = await model.generateContent(prompt);
        const response = result.response.text().trim();
        
        console.log('📅 Date parsed:', response);
        
        if (response === 'null' || !response.match(/^\d{4}-\d{2}-\d{2}$/)) {
            return null;
        }
        
        return response;
    } catch (error) {
        console.error('❌ Date parsing error:', error.message);
        return null;
    }
}

/**
 * Parse multi-command dari satu pesan
 */
async function parseMultiCommand(message, chatHistory = []) {
    if (!process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY === 'your_gemini_api_key_here') {
        return null;
    }

    try {
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

        let contextPrompt = '';
        if (chatHistory.length > 0) {
            contextPrompt = 'CONTEXT CHAT SEBELUMNYA:\n';
            chatHistory.forEach(item => {
                contextPrompt += `${item.role === 'user' ? 'User' : 'Bot'}: ${item.message}\n`;
            });
            contextPrompt += '\n';
        }

        const prompt = `${contextPrompt}Analisis pesan user dan ekstrak SEMUA perintah/aksi yang diminta dalam format JSON array.

JENIS PERINTAH:
1. buat_kantong: {"type":"buat_kantong","name":"...","walletType":"regular/savings","includeInTotal":true/false}
2. transfer: {"type":"transfer","amount":...,"fromWallet":"...","toWallet":"...","description":"...","date":"YYYY-MM-DD"}
3. income: {"type":"income","amount":...,"wallet":"...","description":"...","date":"YYYY-MM-DD"}
4. expense: {"type":"expense","amount":...,"wallet":"...","category":"...","description":"...","date":"YYYY-MM-DD"}
5. adjustment: {"type":"adjustment","wallet":"...","currentBalance":...,"realBalance":...,"description":"Penyesuaian saldo"}

ATURAN PARSING:
- Jika ada koma/dan dalam daftar kantong → buat beberapa perintah buat_kantong
- "narik uang 50rb dan 500rb ke tabungan" → 2 transfer: 50rb rekening→cash, 500rb rekening→tabungan
- Gunakan context untuk menentukan wallet asal (default: rekening untuk transfer/gaji)
- PENTING: Parse tanggal jika disebutkan (kemarin, tanggal X, tgl X bulan Y)
- Tanggal hari ini: ${new Date().toISOString().split('T')[0]}
- Jika tidak ada tanggal, gunakan null untuk date
- ADJUSTMENT: Jika user menyebutkan saldo real berbeda dengan tercatat, buat adjustment command
  * "tabungan saya seharusnya 1jt 500" → adjustment dengan realBalance
  * "total tabungan real saya 1.5jt" → adjustment
  * Bot akan hitung selisih dan adjust otomatis

CONTOH:
"buatkan kantong cash, tabungan, rekening" →
[
  {"type":"buat_kantong","name":"cash","walletType":"regular","includeInTotal":true},
  {"type":"buat_kantong","name":"tabungan","walletType":"savings","includeInTotal":true},
  {"type":"buat_kantong","name":"rekening","walletType":"regular","includeInTotal":true}
]

"saya narik uang 50rb dan 500rb ke tabungan" →
[
  {"type":"transfer","amount":50000,"fromWallet":"rekening","toWallet":"cash","description":"Tarik tunai"},
  {"type":"transfer","amount":500000,"fromWallet":"rekening","toWallet":"tabungan","description":"Transfer ke tabungan"}
]

"dapat gaji 5jt, simpan 2jt ke tabungan, sisanya ke cash" →
[
  {"type":"income","amount":5000000,"wallet":"rekening","description":"Dapat gaji","date":null},
  {"type":"transfer","amount":2000000,"fromWallet":"rekening","toWallet":"tabungan","description":"Simpan ke tabungan","date":null},
  {"type":"transfer","amount":3000000,"fromWallet":"rekening","toWallet":"cash","description":"Pindah ke cash","date":null}
]

"kemarin saya di kirim uang 1jt tanggal 25 november" →
[
  {"type":"income","amount":1000000,"wallet":"rekening","description":"Dikirim uang","date":"2025-11-25"}
]

Context: Bot: "Tabungan 650rb"
"sebelumnya saya sudah ada tabungan, dan setelah ditambahkan 650rb total tabungan saya saat ini 1jt 500" →
[
  {"type":"adjustment","wallet":"tabungan","currentBalance":650000,"realBalance":1500000,"description":"Penyesuaian saldo tabungan - ada saldo awal yang belum tercatat"}
]

PESAN USER: "${message}"

Berikan HANYA JSON array tanpa teks lain. Jika hanya 1 perintah, tetap gunakan array:`;

        const result = await model.generateContent(prompt);
        const response = result.response.text();
        
        console.log('🔍 Multi-command parsed:', response);
        
        const jsonMatch = response.match(/\[[\s\S]*?\]/);
        if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            return Array.isArray(parsed) ? parsed : [parsed];
        }
        
        return null;
    } catch (error) {
        console.error('❌ Multi-command parsing error:', error.message);
        return null;
    }
}

/**
 * Deteksi intent user menggunakan AI dengan chat history context
 */
async function detectIntent(message, chatHistory = []) {
    if (!process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY === 'your_gemini_api_key_here') {
        return null;
    }

    try {
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

        let contextPrompt = '';
        if (chatHistory.length > 0) {
            contextPrompt = '\n\nCONTEXT CHAT SEBELUMNYA:\n';
            chatHistory.forEach(item => {
                contextPrompt += `${item.role === 'user' ? 'User' : 'Bot'}: ${item.message}\n`;
            });
            contextPrompt += '\n';
        }

        const prompt = `Analisis pesan user dan tentukan intent/niatnya. Berikan HANYA satu kata jawaban:
${contextPrompt}
INTENT yang valid:
- "saldo" jika user ingin cek/tanya saldo/balance
- "riwayat" jika user ingin lihat history/riwayat transaksi
- "statistik" jika user ingin lihat laporan/stats bulanan
- "kantong" jika user ingin lihat daftar kantong/wallet
- "buat_kantong" jika user ingin buat kantong baru (misal: "buatkan kantong", "tambah kantong")
- "update_kantong" jika user ingin ubah setting kantong (misal: "jangan dihitung ke total", "dihitung ke total saldo")
- "transfer_kantong" jika user ingin pindahkan uang dari satu kantong ke kantong lain (misal: "pindah ke tabungan", "simpan ke tabungan")
- "hapus_kantong" jika user ingin hapus kantong (misal: "hapus kantong", "delete wallet")
- "help" jika user minta bantuan/info/menu
- "transaksi" jika user ingin catat pemasukan/pengeluaran
- "other" jika tidak jelas atau sapaan biasa

CONTOH:
- "berapa saldo saya?" → saldo
- "kantong" → kantong
- "buatkan kantong cash" → buat_kantong
- "tambah kantong rekening" → buat_kantong
- "saldo tabungan tidak dihitung ke total" → update_kantong
- "kantong investasi jangan masuk total saldo" → update_kantong
- "simpan 500rb ke tabungan" → transfer_kantong
- "pindah 1jt dari rekening ke tabungan" → transfer_kantong
- "hapus kantong darurat" → hapus_kantong
- "delete wallet tabungan" → hapus_kantong
- "riwayat transaksi" → riwayat
- "dapat gaji 5jt" → transaksi
- "beli bakso 20k" → transaksi
- "halo" → other

Pesan: "${message}"

Jawab HANYA dengan satu kata: saldo/riwayat/statistik/kantong/buat_kantong/update_kantong/transfer_kantong/hapus_kantong/help/transaksi/other`;

        const result = await model.generateContent(prompt);
        const response = result.response.text().trim().toLowerCase();
        
        console.log('🎯 Intent detected:', response);
        
        if (['saldo', 'riwayat', 'statistik', 'kantong', 'buat_kantong', 'update_kantong', 'transfer_kantong', 'hapus_kantong', 'help', 'transaksi', 'other'].includes(response)) {
            return response;
        }
        
        return null;
    } catch (error) {
        console.error('❌ Intent detection error:', error.message);
        return null;
    }
}

/**
 * Extract wallet creation details (name, type, include_in_total)
 */
async function parseWalletCreation(message) {
    if (!process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY === 'your_gemini_api_key_here') {
        // Fallback regex
        const match = message.match(/kantong\s+([\w\s]+?)(?:\s+tabungan|\s+savings)?/i);
        const name = match ? match[1].trim().toLowerCase() : null;
        const isSavings = /tabungan|saving|simpanan/i.test(message);
        const excludeFromTotal = /jangan|tidak|exclude|tanpa.*total/i.test(message);
        
        return {
            name: name,
            type: isSavings ? 'savings' : 'regular',
            includeInTotal: !excludeFromTotal
        };
    }

    try {
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

        const prompt = `Analisis pesan pembuatan kantong dan ekstrak informasi dalam format JSON.

ATURAN:
1. Ekstrak nama kantong (name)
2. Tentukan tipe kantong (type):
   - "savings" jika ada kata: tabungan, simpanan, saving, menabung
   - "regular" untuk kantong biasa
3. Tentukan apakah dihitung dalam total saldo (includeInTotal):
   - false jika ada kata: jangan, tidak, exclude, tanpa dihitung, tidak dihitung
   - true jika tidak disebutkan

CONTOH:
- "buatkan kantong cash" → {"name":"cash","type":"regular","includeInTotal":true}
- "buat kantong tabungan darurat" → {"name":"tabungan darurat","type":"savings","includeInTotal":true}
- "tambah kantong simpanan jangan dihitung ke total" → {"name":"simpanan","type":"savings","includeInTotal":false}
- "buat kantong liburan tabungan tanpa total" → {"name":"liburan","type":"savings","includeInTotal":false}

Pesan: "${message}"

Berikan HANYA JSON tanpa teks lain:`;

        const result = await model.generateContent(prompt);
        const response = result.response.text();
        
        console.log('🏦 Wallet creation parsed:', response);
        
        const jsonMatch = response.match(/\{[\s\S]*?\}/);
        if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            return {
                name: parsed.name || null,
                type: parsed.type || 'regular',
                includeInTotal: parsed.includeInTotal !== false
            };
        }
        
        return null;
    } catch (error) {
        console.error('❌ Wallet creation parsing error:', error.message);
        // Fallback
        const match = message.match(/kantong\s+([\w\s]+?)(?:\s+tabungan|\s+savings)?/i);
        const name = match ? match[1].trim().toLowerCase() : null;
        const isSavings = /tabungan|saving|simpanan/i.test(message);
        const excludeFromTotal = /jangan|tidak|exclude|tanpa.*total/i.test(message);
        
        return {
            name: name,
            type: isSavings ? 'savings' : 'regular',
            includeInTotal: !excludeFromTotal
        };
    }
}

/**
 * Parse wallet update settings from message
 */
async function parseWalletUpdate(message) {
    if (!process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY === 'your_gemini_api_key_here') {
        // Fallback regex
        const nameMatch = message.match(/(?:kantong|wallet)\s+([\w\s]+?)(?:\s+tidak|\s+jangan|\s+harus|\s+dihitung|$)/i);
        const name = nameMatch ? nameMatch[1].trim().toLowerCase() : null;
        const excludeFromTotal = /tidak.*total|jangan.*total|exclude|tanpa.*total/i.test(message);
        const includeInTotal = /dihitung.*total|masuk.*total|include|hitung/i.test(message) && !excludeFromTotal;
        
        return {
            name: name,
            includeInTotal: excludeFromTotal ? false : (includeInTotal ? true : null)
        };
    }

    try {
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

        const prompt = `Analisis pesan update kantong dan ekstrak informasi dalam format JSON.

ATURAN:
1. Ekstrak nama kantong yang ingin diupdate (name)
2. Tentukan apakah user ingin ubah setting "dihitung dalam total saldo" (includeInTotal):
   - false jika ada kata: tidak dihitung, jangan dihitung, jangan masuk, exclude, tanpa total
   - true jika ada kata: dihitung, hitung, masuk total, include
   - null jika tidak disebutkan (tidak ada perubahan)

CONTOH:
- "saldo tabungan tidak dihitung ke total" → {"name":"tabungan","includeInTotal":false}
- "kantong investasi jangan masuk total saldo" → {"name":"investasi","includeInTotal":false}
- "kantong darurat harus dihitung ke total" → {"name":"darurat","includeInTotal":true}
- "tabungan liburan masuk ke total saldo" → {"name":"tabungan liburan","includeInTotal":true}

Pesan: "${message}"

Berikan HANYA JSON tanpa teks lain:`;

        const result = await model.generateContent(prompt);
        const response = result.response.text();
        
        console.log('🔄 Wallet update parsed:', response);
        
        const jsonMatch = response.match(/\{[\s\S]*?\}/);
        if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            return {
                name: parsed.name || null,
                includeInTotal: parsed.includeInTotal
            };
        }
        
        return null;
    } catch (error) {
        console.error('❌ Wallet update parsing error:', error.message);
        // Fallback
        const nameMatch = message.match(/(?:kantong|wallet)\s+([\w\s]+?)(?:\s+tidak|\s+jangan|\s+harus|\s+dihitung|$)/i);
        const name = nameMatch ? nameMatch[1].trim().toLowerCase() : null;
        const excludeFromTotal = /tidak.*total|jangan.*total|exclude|tanpa.*total/i.test(message);
        const includeInTotal = /dihitung.*total|masuk.*total|include|hitung/i.test(message) && !excludeFromTotal;
        
        return {
            name: name,
            includeInTotal: excludeFromTotal ? false : (includeInTotal ? true : null)
        };
    }
}

/**
 * Parse transfer between wallets with chat history context
 */
async function parseTransfer(message, chatHistory = []) {
    if (!process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY === 'your_gemini_api_key_here') {
        return null;
    }

    try {
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

        let contextPrompt = '';
        if (chatHistory.length > 0) {
            contextPrompt = 'CONTEXT CHAT SEBELUMNYA:\n';
            chatHistory.forEach(item => {
                contextPrompt += `${item.role === 'user' ? 'User' : 'Bot'}: ${item.message}\n`;
            });
            contextPrompt += '\n';
        }

        const prompt = `${contextPrompt}Analisis pesan user dan ekstrak informasi transfer antar kantong dalam format JSON.

ATURAN:
1. Ekstrak jumlah yang ditransfer (amount) - konversi k=1000, rb=1000, jt=1000000
2. Tentukan kantong asal (fromWallet) - dari mana uang diambil
3. Tentukan kantong tujuan (toWallet) - ke mana uang dipindahkan
4. Buat deskripsi singkat (description)

PETUNJUK CONTEXT:
- Jika user baru terima uang/transfer, kantong asal biasanya "rekening"
- "simpan ke tabungan" berarti dari kantong terakhir yang dapat uang → tabungan
- "pindah ke X" berarti dari kantong aktif/terakhir → X

CONTOH:
Context: User: "dapat transfer 1jt"
Pesan: "simpan 500rb ke tabungan" → {"amount":500000,"fromWallet":"rekening","toWallet":"tabungan","description":"Transfer ke tabungan"}

Context: User: "terima gaji 5jt"
Pesan: "dari uang yang dikirim saya simpan 650rb nya ke tabungan" → {"amount":650000,"fromWallet":"rekening","toWallet":"tabungan","description":"Simpan ke tabungan"}

Pesan: "pindah 1jt dari cash ke tabungan" → {"amount":1000000,"fromWallet":"cash","toWallet":"tabungan","description":"Transfer dari cash"}

PESAN USER: "${message}"

Berikan HANYA JSON tanpa teks lain:`;

        const result = await model.generateContent(prompt);
        const response = result.response.text();
        
        console.log('🔄 Transfer parsed:', response);
        
        const jsonMatch = response.match(/\{[\s\S]*?\}/);
        if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            return {
                amount: parsed.amount || 0,
                fromWallet: parsed.fromWallet || null,
                toWallet: parsed.toWallet || null,
                description: parsed.description || 'Transfer antar kantong'
            };
        }
        
        return null;
    } catch (error) {
        console.error('❌ Transfer parsing error:', error.message);
        return null;
    }
}

/**
 * Extract nama kantong dari pesan
 */
async function extractWalletName(message) {
    if (!process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY === 'your_gemini_api_key_here') {
        // Fallback regex
        const match = message.match(/kantong\s+(\w+)/i);
        return match ? match[1].toLowerCase() : null;
    }

    try {
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

        const prompt = `Ekstrak nama kantong/wallet dari pesan user. Berikan HANYA nama kantongnya saja tanpa kata lain.

CONTOH:
- "buatkan kantong cash" → cash
- "tambah kantong rekening" → rekening
- "buat kantong tabungan darurat" → tabungan darurat
- "hapus kantong emergency fund" → emergency fund
- "delete wallet uang jajan" → uang jajan

Pesan: "${message}"

Jawab HANYA nama kantongnya:`;

        const result = await model.generateContent(prompt);
        const response = result.response.text().trim().toLowerCase();
        
        console.log('💼 Wallet name extracted:', response);
        return response || null;
    } catch (error) {
        console.error('❌ Wallet name extraction error:', error.message);
        // Fallback
        const match = message.match(/kantong\s+([\w\s]+?)(?:\?|$)/i);
        return match ? match[1].trim().toLowerCase() : null;
    }
}

/**
 * Parse pesan natural language menggunakan Google Gemini AI
 */
async function parseMessage(message) {
    if (!process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY === 'your_gemini_api_key_here') {
        console.error('❌ GEMINI_API_KEY tidak ditemukan atau belum diisi!');
        return null;
    }

    try {
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

        const prompt = `Kamu adalah AI parser untuk aplikasi keuangan. Analisis pesan pengguna dan ekstrak informasi dalam format JSON strict.

ATURAN:
1. Identifikasi apakah ini "income" (pemasukan) atau "expense" (pengeluaran)
2. Ekstrak jumlah uang dalam angka penuh (tanpa simbol)
3. Buat deskripsi singkat dan jelas
4. Konversi "k" = 1000, "rb" = 1000, "jt" = 1000000, "m" = 1000000
5. Deteksi wallet/kantong dari konteks pesan:
   - "transfer", "ditransfer", "masuk rekening" → "rekening"
   - "tunai", "cash", "uang cash" → "cash"
   - "tabungan", "saving" → "tabungan"
   - Jika tidak ada petunjuk jelas, tetap coba deteksi berdasarkan konteks:
     * Transfer/Gaji/Pembayaran digital → "rekening"
     * Belanja fisik/Jajan/Bensin → "cash"
6. Untuk EXPENSE, kategorikan otomatis:
   - "makanan" untuk makan, jajan, snack, minuman, restoran
   - "transportasi" untuk bensin, ojek, taxi, parkir, tol
   - "belanja" untuk beli barang, shopping
   - "tagihan" untuk bayar listrik, air, internet, pulsa
   - "hiburan" untuk nonton, game, traveling
   - "kebutuhan" untuk keperluan penting
   - "lainnya" untuk yang tidak jelas

CONTOH INPUT DAN OUTPUT:
- "ditransfer 1jt" → {"type":"income","amount":1000000,"description":"Ditransfer uang","wallet":"rekening"}
- "dapat gaji 5jt" → {"type":"income","amount":5000000,"description":"Dapat gaji","wallet":"rekening"}
- "terima uang cash 100k" → {"type":"income","amount":100000,"description":"Terima uang","wallet":"cash"}
- "beli bakso 20k" → {"type":"expense","amount":20000,"description":"Beli bakso","wallet":"cash","category":"makanan"}
- "bayar kos 1.5jt" → {"type":"expense","amount":1500000,"description":"Bayar kos","wallet":"rekening","category":"kebutuhan"}
- "jajan 15k" → {"type":"expense","amount":15000,"description":"Jajan","wallet":"cash","category":"makanan"}
- "isi bensin 50k" → {"type":"expense","amount":50000,"description":"Isi bensin","wallet":"cash","category":"transportasi"}
- "transfer 200k buat adik" → {"type":"expense","amount":200000,"description":"Transfer buat adik","wallet":"rekening","category":"lainnya"}

PESAN USER: "${message}"

PENTING: 
- Berikan HANYA JSON tanpa penjelasan, markdown, atau teks lain
- Wallet HARUS disebutkan jika ada petunjuk dalam pesan
- User harus membuat kantong terlebih dahulu sebelum transaksi
Format: {"type":"...","amount":...,"description":"...","wallet":"...","category":"..."}`;

        const result = await model.generateContent(prompt);
        const response = result.response.text();
        
        console.log('🤖 AI Response:', response);
        
        // Extract JSON dari response
        const jsonMatch = response.match(/\{[\s\S]*?\}/);
        if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            
            // Validasi hasil parsing
            if (parsed.type && (parsed.type === 'income' || parsed.type === 'expense') 
                && parsed.amount && typeof parsed.amount === 'number' 
                && parsed.description) {
                
                // Set default values
                if (!parsed.wallet) parsed.wallet = 'cash';
                if (parsed.type === 'expense' && !parsed.category) parsed.category = 'lainnya';
                
                return parsed;
            }
        }
        
        return null;
    } catch (error) {
        console.error('❌ AI parsing error:', error.message);
        return null;
    }
}

/**
 * Fallback parser jika AI gagal
 */
function fallbackParser(text) {
    text = text.toLowerCase().trim();
    
    // Pattern untuk income
    const incomePatterns = [
        /(?:dapat|terima|dikirim|gaji|bonus|transfer masuk|jual)\s+(?:uang\s+)?(\d+(?:\.\d+)?)\s*([kmrb]+)/i,
        /(\d+(?:\.\d+)?)\s*([kmrb]+)\s+(?:masuk|diterima|dari)/i
    ];
    
    // Pattern untuk expense
    const expensePatterns = [
        /(?:beli|bayar|buat|untuk|transfer|kirim)\s+(.+?)\s+(\d+(?:\.\d+)?)\s*([kmrb]+)/i,
        /(\d+(?:\.\d+)?)\s*([kmrb]+)\s+(?:buat|untuk)\s+(.+)/i
    ];
    
    // Helper untuk convert ke angka
    const convertAmount = (num, unit) => {
        num = parseFloat(num);
        unit = unit.toLowerCase();
        if (unit.includes('jt') || unit.includes('m')) return num * 1000000;
        if (unit.includes('k') || unit.includes('rb') || unit.includes('ribu')) return num * 1000;
        return num;
    };
    
    // Cek income
    for (let pattern of incomePatterns) {
        const match = text.match(pattern);
        if (match) {
            const amount = convertAmount(match[1], match[2]);
            return { 
                type: 'income', 
                amount, 
                description: text.substring(0, 50)
            };
        }
    }
    
    // Cek expense
    for (let pattern of expensePatterns) {
        const match = text.match(pattern);
        if (match) {
            let amount, description;
            if (match[3]) {
                amount = convertAmount(match[1], match[2]);
                description = match[3].trim();
            } else {
                amount = convertAmount(match[2], match[3]);
                description = match[1].trim();
            }
            return { type: 'expense', amount, description };
        }
    }
    
    return null;
}

module.exports = { 
    aiDecideAction,
    parseDate,
    parseMultiCommand,
    detectIntent,
    extractWalletName,
    parseWalletCreation,
    parseWalletUpdate,
    parseTransfer,
    parseMessage,
    fallbackParser
};
