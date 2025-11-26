const db = require('./database');

class FinanceManager {
    /**
     * Normalize wallet name to lowercase for case-insensitive comparison
     */
    normalizeWalletName(walletName) {
        return walletName.toLowerCase().trim();
    }

    /**
     * Buat wallet baru atau ambil yang sudah ada
     */
    getOrCreateWallet(userId, walletName) {
        const normalizedName = this.normalizeWalletName(walletName);
        return new Promise((resolve, reject) => {
            db.get(
                'SELECT * FROM wallets WHERE user_id = ? AND LOWER(name) = ?',
                [userId, normalizedName],
                (err, row) => {
                    if (err) return reject(err);
                    
                    if (row) {
                        resolve(row);
                    } else {
                        db.run(
                            'INSERT INTO wallets (user_id, name, balance) VALUES (?, ?, 0)',
                            [userId, normalizedName],
                            function(err) {
                                if (err) return reject(err);
                                resolve({ id: this.lastID, user_id: userId, name: normalizedName, balance: 0 });
                            }
                        );
                    }
                }
            );
        });
    }

    /**
     * Buat wallet baru (manual)
     */
    createWallet(userId, walletName, type = 'regular', includeInTotal = true) {
        const normalizedName = this.normalizeWalletName(walletName);
        return new Promise((resolve, reject) => {
            // Cek apakah sudah ada
            db.get(
                'SELECT * FROM wallets WHERE user_id = ? AND LOWER(name) = ?',
                [userId, normalizedName],
                (err, row) => {
                    if (err) return reject(err);
                    
                    if (row) {
                        reject(new Error('ALREADY_EXISTS'));
                    } else {
                        db.run(
                            'INSERT INTO wallets (user_id, name, type, include_in_total, balance) VALUES (?, ?, ?, ?, 0)',
                            [userId, normalizedName, type, includeInTotal ? 1 : 0],
                            function(err) {
                                if (err) return reject(err);
                                resolve({ 
                                    id: this.lastID, 
                                    user_id: userId, 
                                    name: normalizedName, 
                                    type: type,
                                    include_in_total: includeInTotal ? 1 : 0,
                                    balance: 0 
                                });
                            }
                        );
                    }
                }
            );
        });
    }

    /**
     * Update wallet settings
     */
    updateWallet(userId, walletName, updates) {
        const normalizedName = this.normalizeWalletName(walletName);
        return new Promise((resolve, reject) => {
            // Cek apakah ada
            db.get(
                'SELECT * FROM wallets WHERE user_id = ? AND LOWER(name) = ?',
                [userId, normalizedName],
                (err, row) => {
                    if (err) return reject(err);
                    
                    if (!row) {
                        reject(new Error('NOT_FOUND'));
                    } else {
                        const setClause = [];
                        const values = [];
                        
                        if (updates.type !== undefined) {
                            setClause.push('type = ?');
                            values.push(updates.type);
                        }
                        if (updates.include_in_total !== undefined) {
                            setClause.push('include_in_total = ?');
                            values.push(updates.include_in_total);
                        }
                        
                        if (setClause.length === 0) {
                            return reject(new Error('NO_UPDATES'));
                        }
                        
                        values.push(userId, normalizedName);
                        
                        db.run(
                            `UPDATE wallets SET ${setClause.join(', ')} WHERE user_id = ? AND LOWER(name) = ?`,
                            values,
                            (err) => {
                                if (err) return reject(err);
                                
                                // Get updated wallet
                                db.get(
                                    'SELECT * FROM wallets WHERE user_id = ? AND LOWER(name) = ?',
                                    [userId, normalizedName],
                                    (err, updated) => {
                                        if (err) return reject(err);
                                        resolve(updated);
                                    }
                                );
                            }
                        );
                    }
                }
            );
        });
    }

    /**
     * Transfer between wallets
     */
    transferBetweenWallets(userId, amount, fromWallet, toWallet, description = 'Transfer antar kantong', customDate = null) {
        const normalizedFrom = this.normalizeWalletName(fromWallet);
        const normalizedTo = this.normalizeWalletName(toWallet);
        return new Promise(async (resolve, reject) => {
            try {
                // Validasi wallet exist
                const fromExists = await this.walletExists(userId, normalizedFrom);
                const toExists = await this.walletExists(userId, normalizedTo);
                
                if (!fromExists) {
                    return reject(new Error('FROM_WALLET_NOT_FOUND'));
                }
                if (!toExists) {
                    return reject(new Error('TO_WALLET_NOT_FOUND'));
                }
                
                const dateValue = customDate || new Date().toISOString();
                
                // Cek saldo cukup
                db.get(
                    'SELECT balance FROM wallets WHERE user_id = ? AND LOWER(name) = ?',
                    [userId, normalizedFrom],
                    (err, row) => {
                        if (err) return reject(err);
                        
                        if (row.balance < amount) {
                            return reject(new Error('INSUFFICIENT_BALANCE'));
                        }
                        
                        // Kurangi dari wallet asal
                        db.run(
                            'UPDATE wallets SET balance = balance - ? WHERE user_id = ? AND LOWER(name) = ?',
                            [amount, userId, normalizedFrom],
                            (err) => {
                                if (err) return reject(err);
                                
                                // Tambah ke wallet tujuan
                                db.run(
                                    'UPDATE wallets SET balance = balance + ? WHERE user_id = ? AND LOWER(name) = ?',
                                    [amount, userId, normalizedTo],
                                    (err) => {
                                        if (err) return reject(err);
                                        
                                        // Catat transaksi (expense dari fromWallet)
                                        db.run(
                                            'INSERT INTO transactions (user_id, wallet_name, type, amount, category, description, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
                                            [userId, normalizedFrom, 'expense', amount, 'transfer', `Transfer ke ${normalizedTo}: ${description}`, dateValue],
                                            function(err) {
                                                if (err) return reject(err);
                                                
                                                // Catat transaksi (income ke toWallet)
                                                db.run(
                                                    'INSERT INTO transactions (user_id, wallet_name, type, amount, category, description, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
                                                    [userId, normalizedTo, 'income', amount, 'transfer', `Transfer dari ${normalizedFrom}: ${description}`, dateValue],
                                                    (err) => {
                                                        if (err) return reject(err);
                                                        
                                                        // Get new balances
                                                        db.get('SELECT balance FROM wallets WHERE user_id = ? AND LOWER(name) = ?', [userId, normalizedFrom], (err, fromRow) => {
                                                            if (err) return reject(err);
                                                            db.get('SELECT balance FROM wallets WHERE user_id = ? AND LOWER(name) = ?', [userId, normalizedTo], (err, toRow) => {
                                                                if (err) return reject(err);
                                                                resolve({
                                                                    amount,
                                                                    fromWallet: normalizedFrom,
                                                                    toWallet: normalizedTo,
                                                                    fromBalance: fromRow ? fromRow.balance : 0,
                                                                    toBalance: toRow ? toRow.balance : 0
                                                                });
                                                            });
                                                        });
                                                    }
                                                );
                                            }
                                        );
                                    }
                                );
                            }
                        );
                    }
                );
            } catch (err) {
                reject(err);
            }
        });
    }

    /**
     * Hapus wallet
     */
    deleteWallet(userId, walletName) {
        const normalizedName = this.normalizeWalletName(walletName);
        return new Promise((resolve, reject) => {
            // Cek apakah ada
            db.get(
                'SELECT * FROM wallets WHERE user_id = ? AND LOWER(name) = ?',
                [userId, normalizedName],
                (err, row) => {
                    if (err) return reject(err);
                    
                    if (!row) {
                        reject(new Error('NOT_FOUND'));
                    } else if (row.balance !== 0) {
                        reject(new Error('NOT_EMPTY'));
                    } else {
                        db.run(
                            'DELETE FROM wallets WHERE user_id = ? AND LOWER(name) = ?',
                            [userId, normalizedName],
                            (err) => {
                                if (err) return reject(err);
                                resolve(normalizedName);
                            }
                        );
                    }
                }
            );
        });
    }

    /**
     * Cek apakah wallet exist
     */
    walletExists(userId, walletName) {
        const normalizedName = this.normalizeWalletName(walletName);
        return new Promise((resolve, reject) => {
            db.get(
                'SELECT * FROM wallets WHERE user_id = ? AND LOWER(name) = ?',
                [userId, normalizedName],
                (err, row) => {
                    if (err) return reject(err);
                    resolve(!!row);
                }
            );
        });
    }

    /**
     * Ambil semua wallet user
     */
    getWallets(userId) {
        return new Promise((resolve, reject) => {
            db.all('SELECT * FROM wallets WHERE user_id = ? ORDER BY name', [userId], (err, rows) => {
                if (err) return reject(err);
                resolve(rows || []);
            });
        });
    }

    /**
     * Adjust wallet balance (for reconciliation)
     * Menghitung selisih antara saldo tercatat dan saldo sebenarnya, lalu menambahkan adjustment transaction
     */
    adjustWalletBalance(userId, walletName, currentBalance, realBalance, description) {
        const normalizedName = this.normalizeWalletName(walletName);
        return new Promise(async (resolve, reject) => {
            try {
                // Validasi wallet exist
                const exists = await this.walletExists(userId, normalizedName);
                if (!exists) {
                    return reject(new Error('WALLET_NOT_FOUND'));
                }

                // Hitung selisih
                const difference = realBalance - currentBalance;
                
                if (difference === 0) {
                    return resolve({ message: 'Saldo sudah sesuai, tidak perlu penyesuaian', difference: 0 });
                }

                // Buat adjustment transaction
                const transactionType = difference > 0 ? 'income' : 'expense';
                const amount = Math.abs(difference);
                const adjustmentDesc = description || `Penyesuaian saldo: ${currentBalance} → ${realBalance}`;

                db.run(
                    'INSERT INTO transactions (user_id, wallet_name, type, amount, category, description, created_at) VALUES (?, ?, ?, ?, ?, ?, datetime("now"))',
                    [userId, normalizedName, transactionType, amount, 'adjustment', adjustmentDesc],
                    async function(err) {
                        if (err) return reject(err);

                        // Update wallet balance
                        db.run(
                            'UPDATE wallets SET balance = balance + ? WHERE user_id = ? AND LOWER(name) = ?',
                            [difference, userId, normalizedName],
                            (err) => {
                                if (err) return reject(err);
                                resolve({ 
                                    transactionId: this.lastID,
                                    difference: difference,
                                    type: transactionType,
                                    amount: amount,
                                    newBalance: realBalance
                                });
                            }
                        );
                    }
                );
            } catch (error) {
                reject(error);
            }
        });
    }

    /**
     * Menambahkan pemasukan
     */
    addIncome(userId, amount, description, walletName = 'cash', category = null, customDate = null) {
        const normalizedName = this.normalizeWalletName(walletName);
        return new Promise(async (resolve, reject) => {
            try {
                // Validasi wallet exist
                const exists = await this.walletExists(userId, normalizedName);
                if (!exists) {
                    return reject(new Error('WALLET_NOT_FOUND'));
                }
                
                const dateValue = customDate || new Date().toISOString();
                
                db.run(
                    'INSERT INTO transactions (user_id, wallet_name, type, amount, category, description, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
                    [userId, normalizedName, 'income', amount, category, description, dateValue],
                    function(err) {
                        if (err) return reject(err);
                        
                        // Update wallet balance
                        db.run(
                            'UPDATE wallets SET balance = balance + ? WHERE user_id = ? AND LOWER(name) = ?',
                            [amount, userId, normalizedName],
                            (err) => {
                                if (err) return reject(err);
                                
                                // Update total balance
                                db.run(
                                    `INSERT INTO balances (user_id, balance, updated_at) 
                                     VALUES (?, ?, datetime('now'))
                                     ON CONFLICT(user_id) DO UPDATE SET 
                                     balance = balance + ?,
                                     updated_at = datetime('now')`,
                                    [userId, amount, amount],
                                    (err) => {
                                        if (err) return reject(err);
                                        
                                        // Get new balances
                                        db.get('SELECT balance FROM balances WHERE user_id = ?', [userId], (err, row) => {
                                            if (err) return reject(err);
                                            db.get('SELECT balance FROM wallets WHERE user_id = ? AND LOWER(name) = ?', [userId, normalizedName], (err, wRow) => {
                                                if (err) return reject(err);
                                                resolve({
                                                    transactionId: this.lastID,
                                                    newBalance: row.balance,
                                                    walletBalance: wRow ? wRow.balance : 0,
                                                    walletName: normalizedName
                                                });
                                            });
                                        });
                                    }
                                );
                            }
                        );
                    }
                );
            } catch (err) {
                reject(err);
            }
        });
    }

    /**
     * Menambahkan pengeluaran
     */
    addExpense(userId, amount, description, walletName = 'cash', category = 'lainnya', customDate = null) {
        const normalizedName = this.normalizeWalletName(walletName);
        return new Promise(async (resolve, reject) => {
            try {
                // Validasi wallet exist
                const exists = await this.walletExists(userId, normalizedName);
                if (!exists) {
                    return reject(new Error('WALLET_NOT_FOUND'));
                }
                
                const dateValue = customDate || new Date().toISOString();
                
                db.run(
                    'INSERT INTO transactions (user_id, wallet_name, type, amount, category, description, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
                    [userId, normalizedName, 'expense', amount, category, description, dateValue],
                    function(err) {
                        if (err) return reject(err);
                        
                        // Update wallet balance
                        db.run(
                            'UPDATE wallets SET balance = balance - ? WHERE user_id = ? AND LOWER(name) = ?',
                            [amount, userId, normalizedName],
                            (err) => {
                                if (err) return reject(err);
                                
                                // Update total balance
                                db.run(
                                    `INSERT INTO balances (user_id, balance, updated_at) 
                                     VALUES (?, ?, datetime('now'))
                                     ON CONFLICT(user_id) DO UPDATE SET 
                                     balance = balance - ?,
                                     updated_at = datetime('now')`,
                                    [userId, -amount, amount],
                                    (err) => {
                                        if (err) return reject(err);
                                        
                                        // Get new balances
                                        db.get('SELECT balance FROM balances WHERE user_id = ?', [userId], (err, row) => {
                                            if (err) return reject(err);
                                            db.get('SELECT balance FROM wallets WHERE user_id = ? AND LOWER(name) = ?', [userId, normalizedName], (err, wRow) => {
                                                if (err) return reject(err);
                                                resolve({
                                                    transactionId: this.lastID,
                                                    newBalance: row.balance,
                                                    walletBalance: wRow ? wRow.balance : 0,
                                                    walletName: normalizedName
                                                });
                                            });
                                        });
                                    }
                                );
                            }
                        );
                    }
                );
            } catch (err) {
                reject(err);
            }
        });
    }

    /**
     * Mendapatkan balance user (hanya wallet yang include_in_total = 1)
     */
    getBalance(userId) {
        return new Promise((resolve, reject) => {
            db.get(
                'SELECT SUM(balance) as total FROM wallets WHERE user_id = ? AND include_in_total = 1',
                [userId],
                (err, row) => {
                    if (err) return reject(err);
                    resolve(row && row.total ? row.total : 0);
                }
            );
        });
    }

    /**
     * Mendapatkan riwayat transaksi
     */
    getHistory(userId, limit = 10) {
        return new Promise((resolve, reject) => {
            db.all(
                'SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT ?',
                [userId, limit],
                (err, rows) => {
                    if (err) return reject(err);
                    resolve(rows);
                }
            );
        });
    }

    /**
     * Get history by period
     */
    getHistoryByPeriod(userId, period, yearMonth = null, limit = 20) {
        return new Promise((resolve, reject) => {
            let query = 'SELECT * FROM transactions WHERE user_id = ?';
            const params = [userId];
            
            if (period === 'today') {
                query += ` AND date(created_at) = date('now')`;
            } else if (period === 'this_month') {
                query += ` AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')`;
            } else if (period === 'last_month') {
                query += ` AND strftime('%Y-%m', created_at) = strftime('%Y-%m', date('now', '-1 month'))`;
            } else if (period === 'specific_month' && yearMonth) {
                query += ` AND strftime('%Y-%m', created_at) = ?`;
                params.push(yearMonth);
            }
            // 'all_time' tidak menambahkan kondisi WHERE tambahan
            
            query += ' ORDER BY created_at DESC LIMIT ?';
            params.push(limit);
            
            db.all(query, params, (err, rows) => {
                if (err) return reject(err);
                resolve(rows);
            });
        });
    }

    /**
     * Mendapatkan statistik bulanan
     */
    getMonthlyStats(userId) {
        return new Promise((resolve, reject) => {
            const query = `
                SELECT 
                    type,
                    SUM(amount) as total,
                    COUNT(*) as count
                FROM transactions 
                WHERE user_id = ? 
                AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')
                GROUP BY type
            `;
            
            db.all(query, [userId], (err, rows) => {
                if (err) return reject(err);
                
                const stats = {
                    income: 0,
                    expense: 0,
                    incomeCount: 0,
                    expenseCount: 0
                };
                
                rows.forEach(row => {
                    if (row.type === 'income') {
                        stats.income = row.total;
                        stats.incomeCount = row.count;
                    } else {
                        stats.expense = row.total;
                        stats.expenseCount = row.count;
                    }
                });
                
                resolve(stats);
            });
        });
    }

    /**
     * Mendapatkan statistik per kategori
     */
    getCategoryStats(userId) {
        return new Promise((resolve, reject) => {
            const query = `
                SELECT 
                    category,
                    SUM(amount) as total,
                    COUNT(*) as count
                FROM transactions 
                WHERE user_id = ? 
                AND type = 'expense'
                AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')
                GROUP BY category
                ORDER BY total DESC
            `;
            
            db.all(query, [userId], (err, rows) => {
                if (err) return reject(err);
                resolve(rows || []);
            });
        });
    }

    /**
     * Statistik hari ini
     */
    getDailyStats(userId) {
        return new Promise((resolve, reject) => {
            const query = `
                SELECT 
                    type,
                    SUM(amount) as total,
                    COUNT(*) as count
                FROM transactions 
                WHERE user_id = ? 
                AND date(created_at) = date('now')
                GROUP BY type
            `;
            
            db.all(query, [userId], (err, rows) => {
                if (err) return reject(err);
                
                const stats = {
                    income: 0,
                    expense: 0,
                    incomeCount: 0,
                    expenseCount: 0
                };
                
                rows.forEach(row => {
                    if (row.type === 'income') {
                        stats.income = row.total;
                        stats.incomeCount = row.count;
                    } else {
                        stats.expense = row.total;
                        stats.expenseCount = row.count;
                    }
                });
                
                resolve(stats);
            });
        });
    }

    /**
     * Statistik per kategori hari ini
     */
    getDailyCategoryStats(userId) {
        return new Promise((resolve, reject) => {
            const query = `
                SELECT 
                    category,
                    SUM(amount) as total,
                    COUNT(*) as count
                FROM transactions 
                WHERE user_id = ? 
                AND type = 'expense'
                AND date(created_at) = date('now')
                GROUP BY category
                ORDER BY total DESC
            `;
            
            db.all(query, [userId], (err, rows) => {
                if (err) return reject(err);
                resolve(rows || []);
            });
        });
    }

    /**
     * Statistik bulan tertentu (format: YYYY-MM atau nama bulan)
     */
    getMonthlyStatsByMonth(userId, yearMonth) {
        return new Promise((resolve, reject) => {
            const query = `
                SELECT 
                    type,
                    SUM(amount) as total,
                    COUNT(*) as count
                FROM transactions 
                WHERE user_id = ? 
                AND strftime('%Y-%m', created_at) = ?
                GROUP BY type
            `;
            
            db.all(query, [userId, yearMonth], (err, rows) => {
                if (err) return reject(err);
                
                const stats = {
                    income: 0,
                    expense: 0,
                    incomeCount: 0,
                    expenseCount: 0,
                    month: yearMonth
                };
                
                rows.forEach(row => {
                    if (row.type === 'income') {
                        stats.income = row.total;
                        stats.incomeCount = row.count;
                    } else {
                        stats.expense = row.total;
                        stats.expenseCount = row.count;
                    }
                });
                
                resolve(stats);
            });
        });
    }

    /**
     * Statistik per kategori bulan tertentu
     */
    getCategoryStatsByMonth(userId, yearMonth) {
        return new Promise((resolve, reject) => {
            const query = `
                SELECT 
                    category,
                    SUM(amount) as total,
                    COUNT(*) as count
                FROM transactions 
                WHERE user_id = ? 
                AND type = 'expense'
                AND strftime('%Y-%m', created_at) = ?
                GROUP BY category
                ORDER BY total DESC
            `;
            
            db.all(query, [userId, yearMonth], (err, rows) => {
                if (err) return reject(err);
                resolve(rows || []);
            });
        });
    }

    /**
     * Statistik all-time (seluruh periode)
     */
    getAllTimeStats(userId) {
        return new Promise((resolve, reject) => {
            const query = `
                SELECT 
                    type,
                    SUM(amount) as total,
                    COUNT(*) as count
                FROM transactions 
                WHERE user_id = ?
                GROUP BY type
            `;
            
            db.all(query, [userId], (err, rows) => {
                if (err) return reject(err);
                
                const stats = {
                    income: 0,
                    expense: 0,
                    incomeCount: 0,
                    expenseCount: 0
                };
                
                rows.forEach(row => {
                    if (row.type === 'income') {
                        stats.income = row.total;
                        stats.incomeCount = row.count;
                    } else {
                        stats.expense = row.total;
                        stats.expenseCount = row.count;
                    }
                });
                
                resolve(stats);
            });
        });
    }

    /**
     * Statistik per bulan untuk chart combo (bar/line)
     */
    getMonthlyTrends(userId) {
        return new Promise((resolve, reject) => {
            const query = `
                SELECT 
                    strftime('%Y-%m', created_at) as month,
                    type,
                    SUM(amount) as total
                FROM transactions 
                WHERE user_id = ?
                GROUP BY month, type
                ORDER BY month ASC
            `;
            
            db.all(query, [userId], (err, rows) => {
                if (err) return reject(err);
                
                // Group by month
                const monthlyData = {};
                rows.forEach(row => {
                    if (!monthlyData[row.month]) {
                        monthlyData[row.month] = { income: 0, expense: 0 };
                    }
                    if (row.type === 'income') {
                        monthlyData[row.month].income = row.total;
                    } else {
                        monthlyData[row.month].expense = row.total;
                    }
                });
                
                resolve(monthlyData);
            });
        });
    }

    /**
     * Get first transaction date
     */
    getFirstTransactionDate(userId) {
        return new Promise((resolve, reject) => {
            const query = `
                SELECT MIN(created_at) as first_date
                FROM transactions
                WHERE user_id = ?
            `;
            
            db.get(query, [userId], (err, row) => {
                if (err) return reject(err);
                resolve(row?.first_date || null);
            });
        });
    }
}

module.exports = new FinanceManager();
