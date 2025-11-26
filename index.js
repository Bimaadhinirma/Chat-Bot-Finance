const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const financeManager = require('./financeManager');
const { aiDecideAction } = require('./aiParser');
const BackupManager = require('./backupManager');
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

        // Get user wallets for AI context
        const userWallets = await financeManager.getWallets(userId);

        // AI Decision Making - AI yang tentukan action
        console.log(`📨 Pesan dari ${userId}: ${text}`);
        const history = getChatHistory(userId, 5);
        
        const decision = await aiDecideAction(text, history, userWallets);
        
        if (!decision) {
            await msg.reply('❌ Maaf, saya tidak bisa memproses pesan Anda. Ketik "help" untuk bantuan.');
            return;
        }
        
        console.log(`🤖 AI Action: ${decision.action}`);
        console.log(`📋 Reasoning: ${decision.reasoning}`);
        
        // Execute action based on AI decision
        try {
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
                const txHistory = await financeManager.getHistory(userId, 10);
                
                if (txHistory.length === 0) {
                    await msg.reply('📋 *Riwayat Transaksi*\n\nBelum ada transaksi.');
                    return;
                }

                let response = '📋 *Riwayat Transaksi (10 Terakhir)*\n\n';
                
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
                const stats = await financeManager.getMonthlyStats(userId);
                const categoryStats = await financeManager.getCategoryStats(userId);
                const balance = await financeManager.getBalance(userId);
                
                let response = `📊 *Statistik Bulan Ini*\n\n` +
                    `📈 Pemasukan: ${formatCurrency(stats.income)}\n` +
                    `   (${stats.incomeCount} transaksi)\n\n` +
                    `📉 Pengeluaran: ${formatCurrency(stats.expense)}\n` +
                    `   (${stats.expenseCount} transaksi)\n\n`;
                
                if (categoryStats.length > 0) {
                    response += `🏷️ *Per Kategori:*\n`;
                    categoryStats.forEach(cat => {
                        response += `   • ${cat.category}: ${formatCurrency(cat.total)} (${cat.count}x)\n`;
                    });
                    response += `\n`;
                }
                
                response += `💰 Saldo: ${formatCurrency(balance)}\n\n` +
                    `📊 Net: ${formatCurrency(stats.income - stats.expense)}`;

                await msg.reply(response);
                addToChatHistory(userId, response, 'bot');
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
                const helpText = `🤖 *Bot Keuangan - Bantuan*

📊 *Cek Saldo:*
• "saldo" - total saldo
• "saldo tabungan" - saldo wallet tertentu

📝 *Transaksi:*
• "dapat gaji 5jt"
• "beli makan 25rb"
• "transfer 100rb ke tabungan"

🏦 *Kantong:*
• "buatkan kantong cash"
• "buat kantong tabungan"
• "daftar kantong"

📋 *Riwayat & Statistik:*
• "riwayat" - 10 transaksi terakhir
• "statistik" - laporan bulan ini

⚖️ *Penyesuaian Saldo:*
• "tabungan saya sekarang 1.5jt"
Bot akan otomatis adjust jika beda

💾 *Backup Database:*
• "saya mau database nya"
• "backup database"

_Semua perintah diproses dengan AI - cukup chat natural!_`;
                
                await msg.reply(helpText);
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
            else if (decision.action === 'other') {
                await msg.reply('❓ Maaf, saya kurang paham. Ketik "help" untuk melihat panduan.');
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
                await msg.reply('❌ Terjadi kesalahan. Ketik "help" untuk bantuan.');
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
