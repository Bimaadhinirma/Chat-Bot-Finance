const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
require('dotenv').config();

class BackupManager {
    constructor(client) {
        this.client = client;
        this.dbPath = path.join(__dirname, 'finance.db');
        this.backupDir = path.join(__dirname, 'backups');
        
        // Create backup directory if not exists
        if (!fs.existsSync(this.backupDir)) {
            fs.mkdirSync(this.backupDir, { recursive: true });
        }
    }

    /**
     * Create database backup
     */
    createBackup() {
        return new Promise((resolve, reject) => {
            try {
                const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
                const backupFileName = `finance_backup_${timestamp}.db`;
                const backupPath = path.join(this.backupDir, backupFileName);

                // Copy database file
                fs.copyFileSync(this.dbPath, backupPath);

                console.log(`✅ Database backup created: ${backupFileName}`);
                resolve({
                    success: true,
                    fileName: backupFileName,
                    filePath: backupPath,
                    size: fs.statSync(backupPath).size,
                    timestamp: new Date()
                });
            } catch (error) {
                console.error('❌ Backup failed:', error);
                reject(error);
            }
        });
    }

    /**
     * Send backup to owner via WhatsApp
     */
    async sendBackupToOwner() {
        try {
            const ownerNumber = process.env.OWNER_NUMBER;
            if (!ownerNumber) {
                console.error('❌ OWNER_NUMBER not set in .env');
                return { success: false, error: 'OWNER_NUMBER not configured' };
            }

            // Create backup
            const backup = await this.createBackup();

            // Format owner number
            const ownerChatId = ownerNumber.includes('@c.us') 
                ? ownerNumber 
                : `${ownerNumber}@c.us`;

            // Read backup file
            const fileBuffer = fs.readFileSync(backup.filePath);
            const media = new (require('whatsapp-web.js').MessageMedia)(
                'application/x-sqlite3',
                fileBuffer.toString('base64'),
                backup.fileName
            );

            // Send to owner
            await this.client.sendMessage(ownerChatId, media, {
                caption: `🔐 *Database Backup*\n\n` +
                    `📅 Tanggal: ${backup.timestamp.toLocaleString('id-ID')}\n` +
                    `📦 File: ${backup.fileName}\n` +
                    `💾 Size: ${(backup.size / 1024).toFixed(2)} KB`
            });

            console.log(`✅ Backup sent to owner: ${ownerChatId}`);

            // Clean old backups (keep last 7 days)
            this.cleanOldBackups(7);

            return { success: true, backup };
        } catch (error) {
            console.error('❌ Send backup failed:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Clean old backup files
     */
    cleanOldBackups(keepDays = 7) {
        try {
            const files = fs.readdirSync(this.backupDir);
            const now = Date.now();
            const maxAge = keepDays * 24 * 60 * 60 * 1000; // days to milliseconds

            let deletedCount = 0;
            files.forEach(file => {
                const filePath = path.join(this.backupDir, file);
                const stats = fs.statSync(filePath);
                const age = now - stats.mtimeMs;

                if (age > maxAge) {
                    fs.unlinkSync(filePath);
                    deletedCount++;
                    console.log(`🗑️ Deleted old backup: ${file}`);
                }
            });

            if (deletedCount > 0) {
                console.log(`✅ Cleaned ${deletedCount} old backup(s)`);
            }
        } catch (error) {
            console.error('❌ Clean old backups failed:', error);
        }
    }

    /**
     * Schedule automatic daily backup at 00:00
     */
    scheduleAutoBackup() {
        // Schedule at 00:00 every day (timezone: Asia/Jakarta)
        cron.schedule('0 0 * * *', async () => {
            console.log('⏰ Running scheduled backup...');
            await this.sendBackupToOwner();
        }, {
            scheduled: true,
            timezone: "Asia/Jakarta"
        });

        console.log('⏰ Auto backup scheduled: Daily at 00:00 WIB');
    }

    /**
     * Get backup statistics
     */
    getBackupStats() {
        try {
            const files = fs.readdirSync(this.backupDir);
            const backups = files.map(file => {
                const filePath = path.join(this.backupDir, file);
                const stats = fs.statSync(filePath);
                return {
                    name: file,
                    size: stats.size,
                    created: stats.mtime
                };
            }).sort((a, b) => b.created - a.created);

            return {
                total: backups.length,
                totalSize: backups.reduce((sum, b) => sum + b.size, 0),
                latest: backups[0] || null,
                backups: backups
            };
        } catch (error) {
            console.error('❌ Get backup stats failed:', error);
            return { total: 0, totalSize: 0, latest: null, backups: [] };
        }
    }
}

module.exports = BackupManager;
