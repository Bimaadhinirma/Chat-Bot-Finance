# 🤖 WhatsApp Finance Bot

Bot WhatsApp untuk mencatat keuangan personal menggunakan AI (Google Gemini) yang memahami bahasa natural.

## ✨ Fitur

- 💬 **Natural Language Processing** - Tulis pesan natural seperti "dapat gaji 5jt" atau "beli bakso 20k"
- 🤖 **AI-Powered** - Menggunakan Google Gemini untuk parsing pesan
- 💰 **Track Balance** - Otomatis hitung saldo Anda
- 📊 **Transaction History** - Lihat riwayat transaksi
- 📈 **Monthly Statistics** - Laporan pemasukan & pengeluaran bulanan
- 💾 **SQLite Database** - Data tersimpan aman

## 📋 Prerequisites

- Node.js 18+
- npm atau yarn
- Google Gemini API Key (gratis)

## 🚀 Quick Start

### 1. Clone & Install

```bash
git clone https://github.com/yourusername/cptlrt-bot-wa.git
cd cptlrt-bot-wa
npm install
```

### 2. Setup Environment

```bash
cp .env.example .env
```

Edit file `.env` dan isi `GEMINI_API_KEY` Anda:

```env
GEMINI_API_KEY=your_actual_api_key_here
```

**Cara Dapatkan Gemini API Key:**
1. Buka https://makersuite.google.com/app/apikey
2. Login dengan akun Google
3. Klik "Create API Key"
4. Copy dan paste ke `.env`

### 3. Jalankan Bot

```bash
npm start
```

### 4. Scan QR Code

Setelah bot berjalan, scan QR code yang muncul di terminal menggunakan WhatsApp Anda.

## 💬 Cara Menggunakan

### Menambah Pemasukan

```
dapat gaji 5jt
dikirim uang 100k
terima bonus 500rb
jual barang 200k
```

### Mencatat Pengeluaran

```
beli bakso 20k
bayar kos 1.5jt
makan siang 25k
50k buat bensin
```

### Perintah Bot

- `saldo` - Cek saldo saat ini
- `riwayat` - Lihat 10 transaksi terakhir
- `statistik` - Laporan bulanan
- `help` - Menu bantuan

## 🐳 Deploy dengan Docker

### Build & Run

```bash
docker-compose up -d
```

### Stop

```bash
docker-compose down
```

## 🖥️ Deploy ke VPS

### Setup Awal di VPS

```bash
# Install Node.js
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install PM2
sudo npm install -g pm2

# Clone repository
git clone https://github.com/yourusername/cptlrt-bot-wa.git
cd cptlrt-bot-wa

# Install dependencies
npm install

# Setup environment
cp .env.example .env
nano .env  # Edit dan isi GEMINI_API_KEY

# Start dengan PM2
pm2 start index.js --name whatsapp-bot
pm2 save
pm2 startup
```

### Auto Deploy dengan GitHub Actions

1. Tambahkan secrets di GitHub repository:
   - `VPS_HOST` - IP address VPS
   - `VPS_USERNAME` - Username SSH
   - `VPS_SSH_KEY` - Private SSH key
   - `VPS_PORT` - Port SSH (default: 22)

2. Push ke branch `main` untuk auto-deploy

```bash
git push origin main
```

## 📁 Struktur Project

```
cptlrt-bot-wa/
├── index.js              # Main bot logic
├── database.js           # Database setup
├── financeManager.js     # Transaction manager
├── aiParser.js           # AI parser dengan Gemini
├── package.json
├── .env.example
├── .gitignore
├── Dockerfile
├── docker-compose.yml
├── README.md
└── .github/
    └── workflows/
        └── deploy.yml    # Auto-deploy workflow
```

## 🛠️ Commands untuk PM2

```bash
# Start bot
pm2 start index.js --name whatsapp-bot

# Stop bot
pm2 stop whatsapp-bot

# Restart bot
pm2 restart whatsapp-bot

# View logs
pm2 logs whatsapp-bot

# Monitor
pm2 monit
```

## 🔧 Troubleshooting

### QR Code tidak muncul

```bash
# Hapus session lama
rm -rf .wwebjs_auth .wwebjs_cache
npm start
```

### AI parsing tidak berfungsi

- Pastikan `GEMINI_API_KEY` sudah diisi dengan benar di `.env`
- Cek quota API di https://makersuite.google.com/
- Bot akan otomatis menggunakan fallback parser jika AI gagal

### Database error

```bash
# Reset database
rm finance.db
npm start
```

## 📊 Database Schema

### Table: transactions

| Column      | Type     | Description           |
|-------------|----------|-----------------------|
| id          | INTEGER  | Primary key           |
| user_id     | TEXT     | WhatsApp user ID      |
| type        | TEXT     | income/expense        |
| amount      | REAL     | Transaction amount    |
| description | TEXT     | Transaction note      |
| created_at  | DATETIME | Timestamp             |

### Table: balances

| Column     | Type     | Description      |
|------------|----------|------------------|
| user_id    | TEXT     | Primary key      |
| balance    | REAL     | Current balance  |
| updated_at | DATETIME | Last update      |

## 🔒 Security Notes

- Jangan commit file `.env` ke repository
- Gunakan `.gitignore` untuk exclude sensitive files
- Simpan SSH keys dengan aman
- Rotate API keys secara berkala

## 📝 License

MIT

## 🤝 Contributing

Pull requests are welcome!

## 💡 Tips

1. **Gunakan pesan yang jelas** - "dapat 100k" lebih mudah dipahami daripada pesan yang ambigu
2. **Cek saldo rutin** - Gunakan perintah `saldo` untuk monitor keuangan
3. **Lihat statistik bulanan** - Gunakan `statistik` untuk evaluasi pengeluaran
4. **Backup database** - Backup file `finance.db` secara berkala

## 🐛 Known Issues

- Puppeteer memerlukan banyak memory di VPS kecil (minimal 512MB RAM)
- Session WhatsApp bisa expire jika tidak digunakan lama

## 📞 Support

Jika ada pertanyaan atau issue, silakan buat issue di GitHub repository.

---

**Happy Tracking! 💰**
