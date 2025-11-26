const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'finance.db');
const db = new sqlite3.Database(dbPath);

// Initialize database tables
db.serialize(() => {
    // Tabel untuk wallets/kantong
    db.run(`
        CREATE TABLE IF NOT EXISTS wallets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL,
            name TEXT NOT NULL,
            type TEXT DEFAULT 'regular' CHECK(type IN ('regular', 'savings')),
            include_in_total INTEGER DEFAULT 1,
            balance REAL DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(user_id, name)
        )
    `);

    // Tabel untuk transaksi
    db.run(`
        CREATE TABLE IF NOT EXISTS transactions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL,
            wallet_name TEXT DEFAULT 'cash',
            type TEXT NOT NULL CHECK(type IN ('income', 'expense')),
            amount REAL NOT NULL,
            category TEXT,
            description TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // Tabel untuk balance per user (total dari semua wallet)
    db.run(`
        CREATE TABLE IF NOT EXISTS balances (
            user_id TEXT PRIMARY KEY,
            balance REAL DEFAULT 0,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // Index untuk performa
    db.run('CREATE INDEX IF NOT EXISTS idx_transactions_user_id ON transactions(user_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_transactions_created_at ON transactions(created_at)');
    db.run('CREATE INDEX IF NOT EXISTS idx_transactions_category ON transactions(category)');
    db.run('CREATE INDEX IF NOT EXISTS idx_wallets_user_id ON wallets(user_id)');

    console.log('✅ Database initialized successfully');
});

module.exports = db;
