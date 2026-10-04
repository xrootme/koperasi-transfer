#koperasi-transfer

Bot WhatsApp untuk pengingat & verifikasi pembayaran angsuran koperasi.

Dibangun dengan **Baileys** (WhatsApp multi-device), **Gemini AI Vision** (verifikasi bukti
transfer), dan **Google Sheets** (database anggota).

## Fitur

- **Broadcast pengingat** otomatis harian per kelompok (Senin–Sabtu)
- **Verifikasi bukti transfer otomatis** dari foto yang dikirim anggota
- **CRUD anggota** lewat chat WhatsApp (hanya nomor admin)
- **Riwayat transaksi** tersimpan di sheet `Transaksi`
- Sheet formula otomatis untuk sisa angsuran (`Sisa 3x`)

## Kebutuhan

- Node.js 18+
- Google Cloud project dengan **Google Sheets API** aktif
- Service Account credentials (`credentials.json`)
- Gemini API key (opsional — tanpa ini verifikasi bukti transfer nonaktif)

## Instalasi

```bash
npm install
cp .env.example .env    # lalu isi .env
npm run setup:groups    # buat sheet Senin-Sabtu + Transaksi
npm start
```

Saat pertama jalan, scan QR code yang muncul di terminal
(WhatsApp → Perangkat Tertaut → Tautkan).

## Konfigurasi `.env`

| Variabel | Keterangan |
|---|---|
| `AI_PROVIDER` | `local` (Hermes/Ollama/vLLM — default) atau `gemini` |
| `LOCAL_AI_URL` | Base URL OpenAI-compatible, default `http://127.0.0.1:8080/v1` |
| `LOCAL_AI_MODEL` | Nama model vision di server lokal |
| `LOCAL_AI_API_KEY` | Kosongkan kalau server tidak minta autentikasi |
| `LOCAL_AI_TIMEOUT_MS` | Default `120000` |
| `SPREADSHEET_ID` | ID spreadsheet (dari URL) |
| `ADMIN_NUMBERS` | Nomor admin, pisahkan koma. Boleh nomor HP atau LID |
| `GEMINI_API_KEY` | Hanya dipakai bila `AI_PROVIDER=gemini` |
| `GEMINI_MODEL` | Default `gemini-2.5-flash` |
| `CRON_SCHEDULE` | Jadwal broadcast, default `0 9 * * *` |
| `TIMEZONE` | Default `Asia/Jakarta` |
| `DELAY_MS` | Jeda antar pesan, default `3000` |
| `STRICT_HARI` | `true` = bukti transfer hanya auto-update pada hari jadwal anggota |
| `USE_GROUP_SHEETS` | `true` = pakai sheet per kelompok |
| `BUKTI_MAX_AGE_DAYS` | Bukti transfer dianggap valid jika umurnya ≤ nilai ini, default `14` |
| `NOMINAL_TOLERANCE` | Toleransi selisih nominal, default `0` (harus persis) |

> **Penting:** `credentials.json` dan `.env` sudah masuk `.gitignore` — jangan pernah di-commit.

### Menjalankan AI Vision lokal

Verifikasi bukti transfer bisa berjalan **sepenuhnya di VPS** tanpa API cloud, memakai model
vision yang kompatibel OpenAI (Hermes, Qwen2.5-VL, Llama, Gemma, dll). Panduan lengkap:
[`docs/HERMES-SETUP.md`](docs/HERMES-SETUP.md).

## Struktur Sheet

Setiap kelompok punya sheet sendiri (`Senin`–`Sabtu`) dengan 18 kolom:

```
nama | no_hp | pinjaman | pinjaman_ke | angsuran | tgl_cair | A1..A10 | sisa | keterangan
```

- `pinjaman_ke` — siklus pinjaman (1, 2, 3, …) untuk anggota yang punya pinjaman lebih dari sekali
- `tgl_cair` — tanggal pencairan (YYYY-MM-DD)
- `A1`–`A10` — status 10 angsuran mingguan
- `sisa` — formula otomatis `="Sisa "&(10-COUNTIF(G3:P3;"Sudah dibayar"))&"x"`

Nilai status angsuran:

| Nilai | Arti |
|---|---|
| `Sudah dibayar` | Sudah dibayar anggota |
| `Belum dibayar` | Belum dibayar |
| `Terkirim` | Sudah diingatkan, belum dibayar |

Kata **LUNAS** hanya muncul pada balas pesan ketika 10/10 angsuran sudah dibayar.

Sheet `Transaksi` menyimpan riwayat setiap pembayaran yang berhasil diverifikasi
(no transaksi, waktu, nama, kelompok, angsuran ke, nominal, data rekening dari AI, dll).

## Perintah Admin (via WhatsApp)

Kirim dari nomor admin:

```
tambah 081234567890 Budi Santoso 2026-10-06 5jt
→ hari otomatis dari tanggal, angsuran auto 5jt/10 = 500rb

lunas 081234567890 2          → angsuran ke-2 jadi "Sudah dibayar"
lunas 081234567890 ke1 3      → angsuran ke-3 dari pinjaman ke-1
set 081234567890 ke1 a3:Sudah dibayar

ubah 081234567890 Budi Santoso
ubah 081234567890 6jt

cek 081234567890
list Senin
list all
hapus 081234567890

menu    → daftar lengkap perintah
jid     → debug identitas/LID
```

Format dengan label juga bisa dipakai:

```
tambah 081234567890 nama:Budi hari:Senin tgl:2026-10-06 pinjaman:5000000 ke:1 angsuran:500000
```

Nominal bisa disingkat: `5jt`, `500rb`, `500k`, atau angka penuh.

## CLI (alternatif tanpa WhatsApp)

```bash
npm run member -- list --hari Senin
npm run member -- upsert --hp 081234567890 --nama "Budi" --tgl-cair 2026-10-06 \
  --pinjaman 5000000 --pinjaman-ke 1 --angsuran 500000
npm run member -- set --hp 081234567890 --pinjaman-ke 1 --angsuran-ke 2 --status Lunas
npm run member -- remove --hp 081234567890 --pinjaman-ke 1
```

## Alur Verifikasi Bukti Transfer

```
WhatsApp → foto bukti → Gemini AI Vision (JSON 4 klasifikasi)
   ↓
Node.js validation (nominal, tanggal, status transaksi, hari jadwal)
   ↓
VALID / POSSIBLE / NOT_TRANSFER / UNREADABLE
   ↓
Cocokkan Google Sheets
   ↓
VERIFIED → update angsuran + balas anggota
REVIEW   → masuk sheet Review + forward ke admin (anggota tidak dibalas)
SKIP     → bukan bukti transfer, hanya forward ke admin
```

AI **hanya** mengekstrak data. Keputusan `LUNAS` selalu diambil Node.js
bukan AI — hasil AI dicocokkan dengan nominal, tanggal, dan jadwal anggota.

## Menjalankan di VPS

```bash
npm install -g pm2
pm2 start src/index.js --name "koperasi-reminder"
pm2 save && pm2 startup
```

Bot memakai file `.bot.lock` untuk mencegah dua instance berjalan bersamaan
(jika tanpa lock, akan muncul `Stream Errored (conflict)`).

## License

ISC
