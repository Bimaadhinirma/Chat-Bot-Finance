const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');
const { MessageMedia } = require('whatsapp-web.js');

class ExcelExporter {
    constructor() {
        this.exportDir = path.join(__dirname, 'exports');
        
        // Create export directory if not exists
        if (!fs.existsSync(this.exportDir)) {
            fs.mkdirSync(this.exportDir, { recursive: true });
        }
    }

    /**
     * Format currency
     */
    formatCurrency(amount) {
        return new Intl.NumberFormat('id-ID', {
            style: 'currency',
            currency: 'IDR',
            minimumFractionDigits: 0
        }).format(amount);
    }

    /**
     * Format date
     */
    formatDate(dateString) {
        const date = new Date(dateString);
        return date.toLocaleString('id-ID', {
            day: '2-digit',
            month: 'short',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
    }

    /**
     * Export transactions to Excel
     */
    async exportTransactions(transactions, type = 'all', username = 'User', wallets = []) {
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Transaksi');

        let currentRow = 1;

        // Add wallet balances section if provided
        if (wallets && wallets.length > 0) {
            // Title for wallet section
            const walletTitleRow = worksheet.getRow(currentRow);
            walletTitleRow.getCell(1).value = '💰 SALDO KANTONG';
            walletTitleRow.font = { bold: true, size: 14 };
            walletTitleRow.fill = {
                type: 'pattern',
                pattern: 'solid',
                fgColor: { argb: 'FF70AD47' }
            };
            worksheet.mergeCells(`A${currentRow}:G${currentRow}`);
            currentRow++;

            // Wallet headers
            const walletHeaderRow = worksheet.getRow(currentRow);
            walletHeaderRow.getCell(1).value = 'Nama Kantong';
            walletHeaderRow.getCell(2).value = 'Tipe';
            walletHeaderRow.getCell(3).value = 'Saldo';
            walletHeaderRow.getCell(4).value = 'Dihitung Total';
            walletHeaderRow.font = { bold: true, size: 11 };
            walletHeaderRow.fill = {
                type: 'pattern',
                pattern: 'solid',
                fgColor: { argb: 'FFD9E1F2' }
            };
            currentRow++;

            // Add wallet data
            let totalBalance = 0;
            wallets.forEach(wallet => {
                const row = worksheet.getRow(currentRow);
                row.getCell(1).value = wallet.name;
                row.getCell(2).value = wallet.type === 'savings' ? 'Tabungan' : 'Regular';
                row.getCell(3).value = wallet.balance;
                row.getCell(3).numFmt = '#,##0';
                row.getCell(3).alignment = { horizontal: 'right' };
                row.getCell(4).value = wallet.include_in_total ? 'Ya' : 'Tidak';
                
                if (wallet.include_in_total) {
                    totalBalance += wallet.balance;
                }
                currentRow++;
            });

            // Total balance row
            const totalRow = worksheet.getRow(currentRow);
            totalRow.getCell(1).value = 'TOTAL SALDO';
            totalRow.getCell(3).value = totalBalance;
            totalRow.font = { bold: true, size: 12 };
            totalRow.getCell(3).numFmt = '#,##0';
            totalRow.getCell(3).alignment = { horizontal: 'right' };
            totalRow.getCell(3).fill = {
                type: 'pattern',
                pattern: 'solid',
                fgColor: { argb: 'FFFFFF00' }
            };
            currentRow++;

            // Empty row separator
            currentRow++;
        }

        // Transaction section title
        const txTitleRow = worksheet.getRow(currentRow);
        txTitleRow.getCell(1).value = '📊 TRANSAKSI';
        txTitleRow.font = { bold: true, size: 14 };
        txTitleRow.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FF4472C4' }
        };
        worksheet.mergeCells(`A${currentRow}:G${currentRow}`);
        currentRow++;

        // Set column widths
        worksheet.getColumn(1).width = 8;
        worksheet.getColumn(2).width = 20;
        worksheet.getColumn(3).width = 15;
        worksheet.getColumn(4).width = 18;
        worksheet.getColumn(5).width = 15;
        worksheet.getColumn(6).width = 30;
        worksheet.getColumn(7).width = 15;

        // Set column headers
        const headerRow = worksheet.getRow(currentRow);
        headerRow.getCell(1).value = 'No';
        headerRow.getCell(2).value = 'Tanggal';
        headerRow.getCell(3).value = 'Tipe';
        headerRow.getCell(4).value = 'Jumlah';
        headerRow.getCell(5).value = 'Kategori';
        headerRow.getCell(6).value = 'Deskripsi';
        headerRow.getCell(7).value = 'Kantong';

        // Style header row
        headerRow.font = { bold: true, size: 12 };
        headerRow.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FF4472C4' }
        };
        headerRow.alignment = { vertical: 'middle', horizontal: 'center' };
        currentRow++;

        // Add data
        let totalIncome = 0;
        let totalExpense = 0;

        transactions.forEach((tx, index) => {
            const row = worksheet.getRow(currentRow);
            row.getCell(1).value = index + 1;
            row.getCell(2).value = this.formatDate(tx.created_at);
            row.getCell(3).value = tx.type === 'income' ? 'Pemasukan' : 'Pengeluaran';
            row.getCell(4).value = tx.amount;
            row.getCell(5).value = tx.category || '-';
            row.getCell(6).value = tx.description || '-';
            row.getCell(7).value = tx.wallet_name || '-';

            // Style based on transaction type
            if (tx.type === 'income') {
                row.getCell(3).fill = {
                    type: 'pattern',
                    pattern: 'solid',
                    fgColor: { argb: 'FFC6EFCE' }
                };
                totalIncome += tx.amount;
            } else {
                row.getCell(3).fill = {
                    type: 'pattern',
                    pattern: 'solid',
                    fgColor: { argb: 'FFFFC7CE' }
                };
                totalExpense += tx.amount;
            }

            // Format amount
            row.getCell(4).numFmt = '#,##0';
            row.getCell(4).alignment = { horizontal: 'right' };
            currentRow++;
        });

        // Add summary
        currentRow++;
        const summaryRow = worksheet.getRow(currentRow);
        summaryRow.getCell(1).value = '';
        summaryRow.getCell(2).value = '';
        summaryRow.getCell(3).value = 'RINGKASAN';
        summaryRow.font = { bold: true, size: 12 };
        summaryRow.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFE7E6E6' }
        };
        currentRow++;

        if (type === 'all' || type === 'income') {
            const incomeRow = worksheet.getRow(currentRow);
            incomeRow.getCell(3).value = 'Total Pemasukan';
            incomeRow.getCell(4).value = totalIncome;
            incomeRow.getCell(4).numFmt = '#,##0';
            incomeRow.getCell(4).font = { bold: true, color: { argb: 'FF006100' } };
            incomeRow.getCell(4).alignment = { horizontal: 'right' };
            currentRow++;
        }

        if (type === 'all' || type === 'expense') {
            const expenseRow = worksheet.getRow(currentRow);
            expenseRow.getCell(3).value = 'Total Pengeluaran';
            expenseRow.getCell(4).value = totalExpense;
            expenseRow.getCell(4).numFmt = '#,##0';
            expenseRow.getCell(4).font = { bold: true, color: { argb: 'FF9C0006' } };
            expenseRow.getCell(4).alignment = { horizontal: 'right' };
            currentRow++;
        }

        if (type === 'all') {
            const netRow = worksheet.getRow(currentRow);
            netRow.getCell(3).value = 'Net';
            netRow.getCell(4).value = totalIncome - totalExpense;
            netRow.getCell(4).numFmt = '#,##0';
            netRow.getCell(4).font = { bold: true };
            netRow.getCell(4).alignment = { horizontal: 'right' };
        }

        // Generate filename
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const typeLabel = type === 'income' ? 'Pemasukan' : type === 'expense' ? 'Pengeluaran' : 'Semua_Transaksi';
        const filename = `${typeLabel}_${timestamp}.xlsx`;
        const filePath = path.join(this.exportDir, filename);

        // Save file
        await workbook.xlsx.writeFile(filePath);

        console.log(`✅ Excel exported: ${filename}`);

        return {
            success: true,
            filename,
            filePath,
            totalIncome,
            totalExpense,
            count: transactions.length
        };
    }

    /**
     * Send Excel file to WhatsApp
     */
    async sendExcelToUser(client, userId, filePath, filename, type, totalIncome, totalExpense, count) {
        try {
            // Read file
            const fileBuffer = fs.readFileSync(filePath);
            const media = new MessageMedia(
                'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                fileBuffer.toString('base64'),
                filename
            );

            const typeLabels = {
                'income': 'Pemasukan',
                'expense': 'Pengeluaran',
                'all': 'Semua Transaksi'
            };

            let caption = `📊 *Export ${typeLabels[type]}*\n\n`;
            caption += `📝 Total Transaksi: ${count}\n`;
            
            if (type === 'all' || type === 'income') {
                caption += `📈 Total Pemasukan: ${this.formatCurrency(totalIncome)}\n`;
            }
            
            if (type === 'all' || type === 'expense') {
                caption += `📉 Total Pengeluaran: ${this.formatCurrency(totalExpense)}\n`;
            }
            
            if (type === 'all') {
                caption += `💰 Net: ${this.formatCurrency(totalIncome - totalExpense)}\n`;
            }
            
            caption += `\n📅 ${new Date().toLocaleString('id-ID')}`;

            // Send to user
            await client.sendMessage(userId, media, { caption });

            console.log(`✅ Excel sent to user: ${userId}`);

            // Clean up file after sending
            setTimeout(() => {
                if (fs.existsSync(filePath)) {
                    fs.unlinkSync(filePath);
                    console.log(`🗑️ Deleted temporary file: ${filename}`);
                }
            }, 5000);

            return { success: true };
        } catch (error) {
            console.error('❌ Send Excel failed:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Clean old export files
     */
    cleanOldExports(maxAgeHours = 1) {
        try {
            const files = fs.readdirSync(this.exportDir);
            const now = Date.now();
            const maxAge = maxAgeHours * 60 * 60 * 1000;

            let deletedCount = 0;
            files.forEach(file => {
                const filePath = path.join(this.exportDir, file);
                const stats = fs.statSync(filePath);
                const age = now - stats.mtimeMs;

                if (age > maxAge) {
                    fs.unlinkSync(filePath);
                    deletedCount++;
                    console.log(`🗑️ Deleted old export: ${file}`);
                }
            });

            if (deletedCount > 0) {
                console.log(`✅ Cleaned ${deletedCount} old export(s)`);
            }
        } catch (error) {
            console.error('❌ Clean old exports failed:', error);
        }
    }
}

module.exports = new ExcelExporter();
