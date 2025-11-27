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

    // Tabel untuk bisnis
    db.run(`
        CREATE TABLE IF NOT EXISTS businesses (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL,
            name TEXT NOT NULL,
            username TEXT NOT NULL,
            password TEXT NOT NULL,
            description TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(user_id, name)
        )
    `);

    // Tabel untuk price tiers (harga jual)
    db.run(`
        CREATE TABLE IF NOT EXISTS price_tiers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            business_id INTEGER NOT NULL,
            price REAL NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE
        )
    `);

    // Tabel untuk bahan (materials)
    db.run(`
        CREATE TABLE IF NOT EXISTS materials (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            business_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            unit_price REAL,
            pack_price REAL,
            per_pack INTEGER,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE,
            UNIQUE(business_id, name)
        )
    `);

    // Migration: If an existing materials table had unit_price NOT NULL, relax constraint
    db.all("PRAGMA table_info('materials')", (err, rows) => {
        if (err) return console.error('Error checking materials schema', err);
        const unitCol = rows && rows.find(r => r.name === 'unit_price');
        if (unitCol && unitCol.notnull === 1) {
            console.log('🔧 Migrating materials table to allow NULL unit_price...');
            db.serialize(() => {
                db.run('ALTER TABLE materials RENAME TO materials_old');
                db.run(`
                    CREATE TABLE materials (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        business_id INTEGER NOT NULL,
                        name TEXT NOT NULL,
                        unit_price REAL,
                        pack_price REAL,
                        per_pack INTEGER,
                        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                        FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE,
                        UNIQUE(business_id, name)
                    )
                `);
                db.run(`
                    INSERT INTO materials (id, business_id, name, unit_price, pack_price, per_pack, created_at)
                    SELECT id, business_id, name, unit_price, pack_price, per_pack, created_at FROM materials_old
                `);
                db.run('DROP TABLE IF EXISTS materials_old', (dropErr) => {
                    if (dropErr) console.error('Error dropping old materials table', dropErr);
                    else console.log('✅ materials table migrated successfully');
                });
            });
        }
    });

    // Tabel untuk katalog produk
    db.run(`
        CREATE TABLE IF NOT EXISTS catalogs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            business_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            price REAL NOT NULL,
            image_path TEXT,
            production_cost REAL,
            production_materials TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE
        )
    `);

    // Migration: add production_cost and production_materials to catalogs if missing
    db.all("PRAGMA table_info('catalogs')", (err, rows) => {
        if (err) return console.error('Error checking catalogs schema', err);
        const prodCol = rows && rows.find(r => r.name === 'production_cost');
        const prodMatCol = rows && rows.find(r => r.name === 'production_materials');
        if (!prodCol) {
            console.log('🔧 Adding production_cost column to catalogs...');
            db.run('ALTER TABLE catalogs ADD COLUMN production_cost REAL', (alterErr) => {
                if (alterErr) console.error('Error adding production_cost column', alterErr);
                else console.log('✅ production_cost column added to catalogs');
            });
        }
        if (!prodMatCol) {
            console.log('🔧 Adding production_materials column to catalogs...');
            db.run("ALTER TABLE catalogs ADD COLUMN production_materials TEXT", (alterErr) => {
                if (alterErr) console.error('Error adding production_materials column', alterErr);
                else console.log('✅ production_materials column added to catalogs');
            });
        }
    });

    // Tabel untuk pengeluaran bisnis
    db.run(`
        CREATE TABLE IF NOT EXISTS business_expenses (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            business_id INTEGER NOT NULL,
            description TEXT NOT NULL,
            amount REAL NOT NULL,
            is_recorded INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE
        )
    `);

    // Tabel untuk pemasukan bisnis
    db.run(`
        CREATE TABLE IF NOT EXISTS business_incomes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            business_id INTEGER NOT NULL,
            description TEXT NOT NULL,
            amount REAL NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE
        )
    `);

    // Tabel untuk menyimpan harga buket kosong (ukuran + harga)
    db.run(`
        CREATE TABLE IF NOT EXISTS empty_bouquets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            business_id INTEGER NOT NULL,
            size TEXT NOT NULL,
            price REAL NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE,
            UNIQUE(business_id, size)
        )
    `);

    // Tabel untuk session mode bisnis
    db.run(`
        CREATE TABLE IF NOT EXISTS business_sessions (
            user_id TEXT PRIMARY KEY,
            business_id INTEGER NOT NULL,
            started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE
        )
    `);

    // Index untuk performa
    db.run('CREATE INDEX IF NOT EXISTS idx_transactions_user_id ON transactions(user_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_transactions_created_at ON transactions(created_at)');
    db.run('CREATE INDEX IF NOT EXISTS idx_transactions_category ON transactions(category)');
    db.run('CREATE INDEX IF NOT EXISTS idx_wallets_user_id ON wallets(user_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_businesses_user_id ON businesses(user_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_materials_business_id ON materials(business_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_catalogs_business_id ON catalogs(business_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_business_expenses_business_id ON business_expenses(business_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_business_incomes_business_id ON business_incomes(business_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_price_tiers_business_id ON price_tiers(business_id)');

    console.log('✅ Database initialized successfully');
});

module.exports = db;
