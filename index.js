const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const financeManager = require('./financeManager');
const { aiDecideAction } = require('./aiParser');
const BackupManager = require('./backupManager');
const chartGenerator = require('./chartGenerator');
const excelExporter = require('./excelExporter');
require('dotenv').config();

// Chat history storage per user (max 10 messages)
const chatHistory = new Map();

function addToChatHistory(userId, message, role = 'user') {
    if (!chatHistory.has(userId)) chatHistory.set(userId, []);
    const history = chatHistory.get(userId);
    history.push({ role, message, timestamp: new Date() });
    if (history.length > 10) history.shift();
}

function getChatHistory(userId, limit = 5) {
    if (!chatHistory.has(userId)) return [];
    return chatHistory.get(userId).slice(-limit);
}

// Utility helpers
function formatCurrency(amount) {
    return new Intl.NumberFormat('id-ID', {
        style: 'currency',
        currency: 'IDR',
        minimumFractionDigits: 0
    }).format(amount);
}

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

function parseAmount(str) {
    if (str === null || str === undefined) return NaN;
    const cleaned = String(str).toLowerCase().replace(/\./g, '').replace(/,/g, '').trim();
    if (cleaned === '') return NaN;
    if (cleaned.includes('k') && !cleaned.includes('rb')) return parseFloat(cleaned.replace('k', '')) * 1000;
    if (cleaned.includes('rb') || cleaned.includes('ribu')) return parseFloat(cleaned.replace(/rb|ribu/g, '')) * 1000;
    if (cleaned.includes('jt') || cleaned.includes('juta')) return parseFloat(cleaned.replace(/jt|juta/g, '')) * 1000000;
    return parseFloat(cleaned);
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

client.on('qr', (qr) => {
    console.log('\n📱 Scan QR Code ini dengan WhatsApp Anda:\n');
    qrcode.generate(qr, { small: true });
    console.log('\n');
});

client.on('ready', () => {
    console.log('✅ Bot WhatsApp Keuangan siap digunakan!');
    console.log('📊 Mulai chat dengan bot untuk mencatat keuangan Anda\n');

    try {
        const backupManager = new BackupManager(client);
        if (typeof backupManager.scheduleAutoBackup === 'function') backupManager.scheduleAutoBackup();
        client.backupManager = backupManager;
    } catch (err) {
        console.error('BackupManager init failed:', err);
    }
});

client.on('auth_failure', (msg) => {
    console.error('❌ Authentication failed:', msg);
});

client.on('disconnected', (reason) => {
    console.log('⚠️ Client disconnected:', reason);
});

// Main message handler (finance-focused)
client.on('message', async (msg) => {
    const userId = msg.from;
    const text = (msg.body || '').trim();

    try {
        if (msg.isStatus || msg.from.includes('@g.us')) return;

        addToChatHistory(userId, text, 'user');

        const userWallets = await financeManager.getWallets(userId);
        const history = getChatHistory(userId, 5);

        console.log(`📨 Pesan dari ${userId}: ${text}`);
        const decision = await aiDecideAction(text, history, userWallets);
        if (!decision) return;

        console.log(`🤖 AI Action: ${decision.action}`);

        // Handle core finance actions
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
            return;
        }

        if (decision.action === 'check_wallet_balance') {
            const walletName = decision.params.wallet;
            const wallet = userWallets.find(w => w.name.toLowerCase() === (walletName || '').toLowerCase());
            if (!wallet) {
                await msg.reply(`❌ Kantong *${walletName}* tidak ditemukan.`);
                return;
            }
            const response = `💰 Saldo *${wallet.name}*: ${formatCurrency(wallet.balance)}`;
            await msg.reply(response);
            addToChatHistory(userId, response, 'bot');
            return;
        }

        if (decision.action === 'adjustment') {
            const walletName = decision.params.wallet;
            const realBalance = decision.params.realBalance;
            const wallet = userWallets.find(w => w.name.toLowerCase() === (walletName || '').toLowerCase());
            if (!wallet) {
                await msg.reply(`❌ Kantong *${walletName}* tidak ditemukan.`);
                return;
            }
            const result = await financeManager.adjustWalletBalance(userId, walletName, wallet.balance, realBalance, decision.params.description || 'Penyesuaian saldo');
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
            return;
        }

        if (decision.action === 'income') {
            await financeManager.addIncome(userId, decision.params.amount, decision.params.description, decision.params.wallet || 'cash', decision.params.category, decision.params.date);
            const dateInfo = decision.params.date ? ` (${decision.params.date})` : '';
            const response = `✅ Pemasukan ${formatCurrency(decision.params.amount)} ke ${decision.params.wallet}${dateInfo}`;
            await msg.reply(response);
            addToChatHistory(userId, response, 'bot');
            return;
        }

        if (decision.action === 'expense') {
            await financeManager.addExpense(userId, decision.params.amount, decision.params.description, decision.params.wallet || 'cash', decision.params.category || 'lainnya', decision.params.date);
            const dateInfo = decision.params.date ? ` (${decision.params.date})` : '';
            const response = `✅ Pengeluaran ${formatCurrency(decision.params.amount)} dari ${decision.params.wallet}${dateInfo}`;
            await msg.reply(response);
            addToChatHistory(userId, response, 'bot');
            return;
        }

        if (decision.action === 'transfer') {
            await financeManager.transferBetweenWallets(userId, decision.params.amount, decision.params.fromWallet, decision.params.toWallet, decision.params.description, decision.params.date);
            const response = `✅ Transfer ${formatCurrency(decision.params.amount)}: ${decision.params.fromWallet} → ${decision.params.toWallet}`;
            await msg.reply(response);
            addToChatHistory(userId, response, 'bot');
            return;
        }

        if (decision.action === 'list_wallets') {
            const wallets = await financeManager.getWallets(userId);
            if (!wallets || wallets.length === 0) {
                await msg.reply('📁 Belum ada kantong/akun. Tambahkan menggunakan perintah yang sesuai.');
                return;
            }
            let resp = `📁 *Daftar Kantong Anda*\n\n`;
            wallets.forEach((w, i) => resp += `${i + 1}. ${w.name} — ${formatCurrency(w.balance)}\n`);
            await msg.reply(resp);
            addToChatHistory(userId, resp, 'bot');
            return;
        }

        if (decision.action === 'backup_database') {
            await msg.reply('⏳ Sedang membuat backup database...');
            if (!client.backupManager) {
                await msg.reply('❌ Backup manager belum siap. Silakan coba lagi.');
                return;
            }
            const result = await client.backupManager.sendBackupToOwner();
            if (result.success) await msg.reply('✅ Backup database berhasil dikirim ke owner!');
            else await msg.reply(`❌ Gagal backup database: ${result.error}`);
            return;
        }

        if (decision.action === 'history' || decision.action === 'show_history') {
            try {
                const period = decision.params.period || 'this_month';
                const month = decision.params.month;
                const limit = decision.params.limit || 20;

                let transactions = [];
                if (period === 'today') transactions = await financeManager.getHistoryByPeriod(userId, 'today', null, limit);
                else if (period === 'this_month') transactions = await financeManager.getHistoryByPeriod(userId, 'this_month', null, limit);
                else if (period === 'last_month') transactions = await financeManager.getHistoryByPeriod(userId, 'last_month', null, limit);
                else if (period === 'specific_month' && month) transactions = await financeManager.getHistoryByPeriod(userId, 'specific_month', month, limit);
                else transactions = await financeManager.getHistoryByPeriod(userId, 'all_time', null, limit);

                if (!transactions || transactions.length === 0) {
                    await msg.reply('📋 Belum ada transaksi.');
                    return;
                }

                let response = `📋 *Riwayat Transaksi*\n\n`;
                transactions.forEach((t, i) => {
                    const icon = t.type === 'income' ? '💰' : '💸';
                    const sign = t.type === 'income' ? '+' : '-';
                    response += `${i + 1}. ${icon} ${sign}${formatCurrency(t.amount)}\n`;
                    response += `   ${t.description}\n`;
                    response += `   📁 ${t.wallet_name} | ${formatDate(t.created_at)}\n\n`;
                });

                await msg.reply(response);
                addToChatHistory(userId, response, 'bot');
            } catch (err) {
                console.error('History error:', err);
                await msg.reply(`❌ Gagal mengambil riwayat: ${err.message}`);
            }
            return;
        }

        if (decision.action === 'statistics' || decision.action === 'show_stats') {
            try {
                const period = decision.params.period || 'this_month';
                const month = decision.params.month;

                let stats;
                let categoryStats = [];
                let periodLabel = '';

                if (period === 'today') {
                    stats = await financeManager.getDailyStats(userId);
                    categoryStats = await financeManager.getDailyCategoryStats(userId);
                    periodLabel = 'Hari Ini';
                } else if (period === 'this_month') {
                    stats = await financeManager.getMonthlyStats(userId);
                    categoryStats = await financeManager.getCategoryStats(userId);
                    const now = new Date();
                    periodLabel = `Bulan ${now.toLocaleString('id-ID', { month: 'long', year: 'numeric' })}`;
                } else if (period === 'last_month') {
                    const lastMonth = new Date();
                    lastMonth.setMonth(lastMonth.getMonth() - 1);
                    const yearMonth = lastMonth.toISOString().slice(0, 7);
                    stats = await financeManager.getMonthlyStatsByMonth(userId, yearMonth);
                    categoryStats = await financeManager.getCategoryStatsByMonth(userId, yearMonth);
                    periodLabel = `Bulan ${lastMonth.toLocaleString('id-ID', { month: 'long', year: 'numeric' })}`;
                } else if (period === 'specific_month' && month) {
                    stats = await financeManager.getMonthlyStatsByMonth(userId, month);
                    categoryStats = await financeManager.getCategoryStatsByMonth(userId, month);
                    const [year, monthNum] = month.split('-');
                    const date = new Date(year, parseInt(monthNum) - 1);
                    periodLabel = `Bulan ${date.toLocaleString('id-ID', { month: 'long', year: 'numeric' })}`;
                } else { // all_time
                    stats = await financeManager.getAllTimeStats(userId);
                    categoryStats = await financeManager.getCategoryStats(userId);
                    periodLabel = 'Sepanjang Waktu';
                }

                let response = `📊 *Statistik ${periodLabel}*\n\n`;
                response += `💰 Pemasukan: ${formatCurrency(stats.income)} (${stats.incomeCount}×)\n`;
                response += `💸 Pengeluaran: ${formatCurrency(stats.expense)} (${stats.expenseCount}×)\n`;
                const diff = stats.income - stats.expense;
                const diffIcon = diff >= 0 ? '✅' : '⚠️';
                response += `${diffIcon} Selisih: ${formatCurrency(diff)}\n`;

                if (categoryStats && categoryStats.length > 0) {
                    response += `\n📂 *Per Kategori:*\n`;
                    categoryStats.forEach((cat, i) => {
                        response += `${i + 1}. ${cat.category}: ${formatCurrency(cat.total)} (${cat.count}×)\n`;
                    });
                }

                await msg.reply(response);
                addToChatHistory(userId, response, 'bot');
            } catch (err) {
                console.error('Statistics error:', err);
                await msg.reply(`❌ Gagal mengambil statistik: ${err.message}`);
            }
            return;
        }

        if (decision.action === 'export_excel') {
            await msg.reply('⏳ Sedang membuat file Excel...');
            try {
                const type = decision.params.type || 'all';
                const period = decision.params.period || 'this_month';
                const month = decision.params.month;

                let transactions = [];
                if (period === 'today') transactions = await financeManager.getHistoryByPeriod(userId, 'today');
                else if (period === 'this_month') transactions = await financeManager.getHistoryByPeriod(userId, 'this_month');
                else if (period === 'last_month') transactions = await financeManager.getHistoryByPeriod(userId, 'last_month');
                else if (period === 'specific_month' && month) transactions = await financeManager.getHistoryByPeriod(userId, 'specific_month', month);
                else transactions = await financeManager.getHistoryByPeriod(userId, 'all_time');

                if (type === 'income') transactions = transactions.filter(t => t.type === 'income');
                else if (type === 'expense') transactions = transactions.filter(t => t.type === 'expense');

                if (transactions.length === 0) {
                    await msg.reply('📊 Tidak ada transaksi untuk diekspor.');
                    return;
                }

                const result = await excelExporter.exportTransactions(transactions, type, userId, await financeManager.getWallets(userId));
                if (result.success) {
                    await excelExporter.sendExcelToUser(client, userId, result.filePath, result.filename, type, result.totalIncome, result.totalExpense, result.count);
                } else {
                    await msg.reply('❌ Gagal membuat file Excel');
                }
            } catch (err) {
                console.error('Export Excel error:', err);
                await msg.reply(`❌ Gagal export Excel: ${err.message}`);
            }
            return;
        }

        if (decision.action === 'help' || decision.action === 'other') {
            if (decision.response) {
                await msg.reply(decision.response);
                addToChatHistory(userId, decision.response, 'bot');
            } else {
                await msg.reply('🤖 Saya siap membantu dengan pencatatan keuangan: cek saldo, catat pemasukan/pengeluaran, transfer, dan export.');
            }
            return;
        }

    } catch (err) {
        console.error('Message handler error:', err);
        try { await msg.reply('❌ Terjadi kesalahan saat memproses pesan Anda.'); } catch (e) { }
    }
});

// Initialize client
console.log('🚀 Starting WhatsApp Bot...\n');
client.initialize();

process.on('SIGINT', async () => {
    console.log('\n⏳ Shutting down bot...');
    try { await client.destroy(); } catch (e) {}
    process.exit(0);
});
