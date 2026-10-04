const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { logInfo, logError } = require("./utils");

const EXT = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/gif": "gif",
};

function buktiDir() {
  const dir = path.resolve(__dirname, "..", process.env.BUKTI_DIR || "bukti");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function enabled() {
  return String(process.env.BUKTI_SAVE || "true").toLowerCase() !== "false";
}

function dedupOn() {
  return String(process.env.BUKTI_DEDUP || "true").toLowerCase() !== "false";
}

function sanitize(s) {
  return String(s || "anon").replace(/[^0-9a-zA-Z_-]/g, "").slice(0, 24) || "anon";
}

/** Hash SHA-256 dari isi file — dipakai deteksi gambar duplikat. */
function hashBukti(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

/**
 * Deteksi gambar yang SUDAH pernah dikirim (hash sama).
 * Return objek riwayat bila duplikat, null bila baru.
 */
function cekDuplikat(buffer) {
  if (!dedupOn()) return null;
  try {
    const idxPath = path.join(buktiDir(), "index.json");
    if (!fs.existsSync(idxPath)) return null;
    const idx = JSON.parse(fs.readFileSync(idxPath, "utf8"));
    const hash = hashBukti(buffer);
    return idx[hash] || null;
  } catch (e) {
    logError("Gagal cek duplikat:", e.message);
    return null;
  }
}

/** Catat hash gambar agar pengiriman berikutnya ditolak sebagai duplikat. */
function catatDuplikat(buffer, info) {
  if (!dedupOn()) return;
  try {
    const idxPath = path.join(buktiDir(), "index.json");
    let idx = {};
    if (fs.existsSync(idxPath)) idx = JSON.parse(fs.readFileSync(idxPath, "utf8"));
    idx[hashBukti(buffer)] = {
      waktu: new Date().toISOString(),
      pengirim: info.pengirim || "-",
      hasil: info.hasil || "-",
      file: info.file || "-",
    };
    fs.writeFileSync(idxPath, JSON.stringify(idx, null, 2));
  } catch (e) {
    logError("Gagal catat duplikat:", e.message);
  }
}

/**
 * Simpan gambar bukti ke disk sebelum dikirim ke AI.
 * Return { filepath, duplikat } — duplikat = riwayat pengiriman sebelumnya.
 */
function saveBukti(buffer, mimeType, pengirim) {
  if (!enabled()) return { filepath: null, duplikat: null };
  try {
    const duplikat = cekDuplikat(buffer);
    if (duplikat) {
      logInfo(`Gambar DUPLIKAT dari ${pengirim} — sudah pernah dikirim (${duplikat.waktu})`);
      return { filepath: null, duplikat };
    }
    const dir = buktiDir();
    const ext = EXT[String(mimeType || "").toLowerCase()] || "jpg";
    const now = new Date();
    const tgl = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
    const waktu = `${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}`;
    const nama = `${tgl}_${waktu}_${sanitize(pengirim)}.${ext}`;
    const filepath = path.join(dir, nama);
    fs.writeFileSync(filepath, buffer);
    logInfo(`Bukti disimpan: ${filepath} (${(buffer.length / 1024).toFixed(1)} KB)`);
    return { filepath, duplikat: null };
  } catch (e) {
    logError("Gagal menyimpan bukti:", e.message);
    return { filepath: null, duplikat: null };
  }
}

/** Hapus file bukti lama agar folder tidak menumpuk. */
function bersihkanBukti(maxHari) {
  if (!enabled()) return;
  const hari = Number(maxHari || process.env.BUKTI_MAX_AGE_DAYS || 30);
  if (hari <= 0) return;
  try {
    const dir = buktiDir();
    const batas = Date.now() - hari * 86400000;
    let dihapus = 0;
    for (const f of fs.readdirSync(dir)) {
      if (f === "index.json") continue;
      const fp = path.join(dir, f);
      try {
        if (fs.statSync(fp).mtimeMs < batas) { fs.unlinkSync(fp); dihapus++; }
      } catch {}
    }
    if (dihapus) logInfo(`Bersihkan ${dihapus} file bukti lama (> ${hari} hari)`);
  } catch (e) {
    logError("Gagal bersihkan bukti:", e.message);
  }
}

module.exports = { saveBukti, bersihkanBukti, buktiDir, enabled, dedupOn, cekDuplikat, catatDuplikat, hashBukti };
