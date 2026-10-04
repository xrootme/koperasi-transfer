const fs = require("fs");
const { logInfo, logError } = require("./utils");

async function fetchWithTimeout(url, opts = {}, ms = 25000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try { return await fetch(url, { ...opts, signal: c.signal }); } finally { clearTimeout(t); }
}

function cleanJsonText(text) {
  let t = String(text || "").trim();
  t = t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/g, "").trim();
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a !== -1 && b !== -1 && b > a) t = t.slice(a, b + 1);
  return t;
}

function toNumberOrNull(v) {
  if (v === null || v === undefined || v === "") return null;
  const s = String(v).replace(/[^0-9]/g, "");
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function normalizeAIResult(raw) {
  const allowed = ["VALID_TRANSFER_PROOF", "POSSIBLE_TRANSFER_PROOF", "NOT_TRANSFER_PROOF", "UNREADABLE"];
  let c = String(raw.classification || "").trim().toUpperCase();
  if (!allowed.includes(c)) {
    if (raw.is_transfer_proof === true && c === "") c = "POSSIBLE_TRANSFER_PROOF";
    else if (raw.is_transfer_proof === false) c = "NOT_TRANSFER_PROOF";
    else c = "UNREADABLE";
  }
  const conf = Number(raw.confidence);
  return {
    is_transfer_proof: !!raw.is_transfer_proof,
    classification: c,
    confidence: Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : (c === "VALID_TRANSFER_PROOF" ? 0.9 : c === "NOT_TRANSFER_PROOF" ? 0.95 : 0.6),
    nominal: toNumberOrNull(raw.nominal),
    currency: raw.currency || null,
    tanggal_transfer: raw.tanggal_transfer || null,
    waktu_transfer: raw.waktu_transfer || null,
    nama_pengirim: raw.nama_pengirim || null,
    bank_pengirim: raw.bank_pengirim || null,
    rekening_pengirim: raw.rekening_pengirim || null,
    nama_penerima: raw.nama_penerima || null,
    bank_penerima: raw.bank_penerima || null,
    rekening_penerima: raw.rekening_penerima || null,
    referensi_transaksi: raw.referensi_transaksi || null,
    status_transaksi: raw.status_transaksi || null,
    reason: raw.reason || "",
    missing_fields: Array.isArray(raw.missing_fields) ? raw.missing_fields : [],
    _raw: raw,
  };
}

const PROMPT = `
Anda adalah sistem verifikasi bukti pembayaran untuk koperasi simpan pinjam.

Tugas utama:
1. Periksa gambar yang diberikan.
2. Tentukan apakah gambar tersebut merupakan bukti transfer/pembayaran.
3. Jangan menganggap gambar sebagai bukti transfer hanya karena terdapat nominal uang.
4. Jika bukan bukti transfer, gunakan classification "NOT_TRANSFER_PROOF".
5. Jika terlihat seperti bukti transfer tetapi informasi penting tidak terbaca, gunakan classification "POSSIBLE_TRANSFER_PROOF" atau "UNREADABLE".
6. Jangan pernah menyatakan pembayaran LUNAS hanya berdasarkan hasil AI.

INDIKATOR BUKTI TRANSFER:
- Terdapat informasi transaksi transfer/pembayaran.
- Terdapat nominal transfer.
- Terdapat tanggal atau waktu transaksi.
- Terdapat nama pengirim atau rekening pengirim jika tersedia.
- Terdapat rekening/nama penerima atau tujuan transfer jika tersedia.
- Terdapat nomor referensi transaksi atau ID transaksi jika tersedia.
- Terdapat status transaksi seperti berhasil, sukses, completed, atau sejenisnya.
- Tampilan dapat berupa screenshot mobile banking, internet banking, ATM, e-wallet, atau bukti transfer resmi lainnya.

INDIKATOR BUKAN BUKTI TRANSFER:
- Foto biasa.
- Meme atau gambar random.
- Screenshot chat tanpa bukti transaksi.
- Foto rekening tanpa transaksi.
- Invoice/tagihan tanpa bukti pembayaran.
- Screenshot saldo rekening saja.
- Gambar yang hanya berisi nominal tetapi tidak menunjukkan transaksi.
- Bukti transfer yang terlihat jelas diedit atau dimanipulasi.
- Gambar terlalu buram sehingga transaksi tidak dapat dipastikan.

Klasifikasi yang diperbolehkan:
- VALID_TRANSFER_PROOF
- POSSIBLE_TRANSFER_PROOF
- NOT_TRANSFER_PROOF
- UNREADABLE

ATURAN KLASIFIKASI:

VALID_TRANSFER_PROOF:
Bukti transfer terlihat jelas dan informasi transaksi cukup untuk mengidentifikasi bahwa transaksi benar-benar terjadi.

POSSIBLE_TRANSFER_PROOF:
Gambar terlihat seperti bukti transfer, tetapi terdapat informasi penting yang tidak dapat dipastikan atau tidak terbaca.

NOT_TRANSFER_PROOF:
Gambar bukan bukti transfer.

UNREADABLE:
Gambar terlalu buram, rusak, terpotong, atau tidak dapat dianalisis.

Jika informasi tidak terlihat, gunakan null.
Jangan mengarang informasi.
Confidence harus berupa angka antara 0 dan 1.

Kembalikan HANYA JSON valid.
Jangan gunakan markdown.
Jangan gunakan \`\`\`json.
Jangan memberikan penjelasan di luar JSON.

Format JSON:

{
  "is_transfer_proof": true,
  "classification": "VALID_TRANSFER_PROOF",
  "confidence": 0.95,
  "nominal": 1100000,
  "currency": "IDR",
  "tanggal_transfer": "2026-09-30",
  "waktu_transfer": "14:32:10",
  "nama_pengirim": "BUDI SANTOSO",
  "bank_pengirim": "BCA",
  "rekening_pengirim": "****1234",
  "nama_penerima": "KOPERASI ABC",
  "bank_penerima": "BCA",
  "rekening_penerima": "****5678",
  "referensi_transaksi": "ABC123456",
  "status_transaksi": "BERHASIL",
  "reason": "Gambar menunjukkan bukti transfer dengan informasi transaksi yang dapat dibaca.",
  "missing_fields": []
}

Jika BUKAN bukti transfer, gunakan contoh:

{
  "is_transfer_proof": false,
  "classification": "NOT_TRANSFER_PROOF",
  "confidence": 0.98,
  "nominal": null,
  "currency": null,
  "tanggal_transfer": null,
  "waktu_transfer": null,
  "nama_pengirim": null,
  "bank_pengirim": null,
  "rekening_pengirim": null,
  "nama_penerima": null,
  "bank_penerima": null,
  "rekening_penerima": null,
  "referensi_transaksi": null,
  "status_transaksi": null,
  "reason": "Gambar tidak menunjukkan bukti transaksi transfer.",
  "missing_fields": []
}

Jika gambar terlihat seperti bukti transfer tetapi informasi tidak lengkap:

{
  "is_transfer_proof": true,
  "classification": "POSSIBLE_TRANSFER_PROOF",
  "confidence": 0.72,
  "nominal": 1100000,
  "currency": "IDR",
  "tanggal_transfer": null,
  "waktu_transfer": null,
  "nama_pengirim": null,
  "bank_pengirim": "BCA",
  "rekening_pengirim": null,
  "nama_penerima": "KOPERASI ABC",
  "bank_penerima": null,
  "rekening_penerima": null,
  "referensi_transaksi": null,
  "status_transaksi": null,
  "reason": "Gambar terlihat seperti bukti transfer tetapi beberapa informasi penting tidak terbaca.",
  "missing_fields": [
    "tanggal_transfer",
    "nama_pengirim",
    "referensi_transaksi"
  ]
}

PENTING:

AI hanya melakukan identifikasi dan ekstraksi data.

AI TIDAK boleh menentukan pembayaran sebagai LUNAS.

Keputusan pembayaran harus dilakukan oleh backend Node.js.

Backend harus mencocokkan hasil AI dengan:
- ID anggota
- nominal
- tanggal transfer
- nomor referensi
- rekening tujuan
- nama anggota
- ID pinjaman
- ID angsuran
- angsuran yang sedang jatuh tempo

Jika data tidak cocok, hasil akhir harus REVIEW.

Jangan pernah mengubah status pembayaran menjadi LUNAS hanya berdasarkan confidence AI.
`;

// ============================================================================
// PROVIDER AI Vision
//   local = Hermes / llama.cpp / Ollama / vLLM (OpenAI-compatible, default)
//   gemini = Google Gemini (opsional, hanya dipakai bila AI_PROVIDER=gemini)
// ============================================================================
function aiProvider() {
  const p = String(process.env.AI_PROVIDER || "local").trim().toLowerCase();
  return p === "gemini" ? "gemini" : "local";
}

// Model Gemini yang mendukung vision (fallback kalau AI_PROVIDER=gemini).
// gemini-1.5-flash sudah di-retire oleh Google -> jangan dipakai lagi.
const VISION_MODELS = [
  "gemini-2.5-flash",
  "gemini-flash-latest",
  "gemini-2.0-flash",
  "gemini-2.5-pro",
  "gemini-pro-latest",
];
let activeModel = null; // di-cache setelah berhasil

function modelCandidates() {
  const configured = String(process.env.GEMINI_MODEL || "").trim();
  const list = configured ? [configured, ...VISION_MODELS] : [...VISION_MODELS];
  if (activeModel) list.unshift(activeModel);
  return [...new Set(list)];
}

async function callGemini(model, key, body) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
  const res = await fetchWithTimeout(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (res.ok) return await res.json();
  const t = await res.text().catch(() => "");
  const err = new Error(`Gemini ${model} HTTP ${res.status}: ${t.slice(0, 400)}`);
  err.status = res.status;
  err.body = t;
  throw err;
}

function localConfig() {
  const base = String(process.env.LOCAL_AI_URL || process.env.LLM_BASE_URL || "http://127.0.0.1:8080/v1").replace(/\/+$/, "");
  const model = String(process.env.LOCAL_AI_MODEL || process.env.LLM_MODEL || "hermes").trim();
  const key = String(process.env.LOCAL_AI_API_KEY || process.env.LLM_API_KEY || "local").trim();
  const timeout = Number(process.env.LOCAL_AI_TIMEOUT_MS) || 120000;
  const format = String(process.env.LOCAL_AI_RESPONSE_FORMAT || "json_object").toLowerCase();
  return { base, model, key, timeout, format: format === "none" ? null : format };
}

/**
 * Panggil model lokal via endpoint OpenAI-compatible /chat/completions.
 * Menyerupai: Hermes (NousResearch), llama.cpp server, LM Studio, Ollama, vLLM, SGLang.
 * Butuh model yang mendukung vision (multimodal).
 */
async function callLocal(cfg, bodyParts) {
  const headers = { "Content-Type": "application/json" };
  if (cfg.key && cfg.key !== "local") headers.Authorization = `Bearer ${cfg.key}`;

  const body = {
    model: cfg.model,
    messages: [{ role: "user", content: bodyParts }],
    temperature: 0,
    max_tokens: 1024,
  };
  if (cfg.format) body.response_format = { type: cfg.format };

  const res = await fetchWithTimeout(
    `${cfg.base}/chat/completions`,
    { method: "POST", headers, body: JSON.stringify(body) },
    cfg.timeout
  );
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    const err = new Error(`Local AI HTTP ${res.status}: ${t.slice(0, 400)}`);
    err.status = res.status;
    err.body = t;
    throw err;
  }
  const json = await res.json();
  const text =
    json?.choices?.[0]?.message?.content ??
    json?.choices?.[0]?.text ??
    json?.message?.content ??
    "";
  return String(text || "");
}

async function analyzeBukti(buffer, mimeType = "image/jpeg", opts = {}) {
  if (!buffer || buffer.length < 800) {
    return normalizeAIResult({ is_transfer_proof: false, classification: "UNREADABLE", confidence: 0.9, reason: "File terlalu kecil/rusak", missing_fields: [] });
  }
  const mime = mimeType.includes("/") ? mimeType : "image/jpeg";
  const provider = aiProvider();
  const b64 = buffer.toString("base64");
  const dataUrl = `data:${mime};base64,${b64}`;

  let text = null;

  if (provider === "local") {
    const cfg = localConfig();
    logInfo(`AI Vision lokal → ${cfg.base} model=${cfg.model}`);
    try {
      text = await callLocal(cfg, [
        { type: "text", text: PROMPT },
        { type: "image_url", image_url: { url: dataUrl } },
      ]);
      activeModel = `local:${cfg.model}`;
    } catch (e) {
      // Server lokal belum jalan / model tidak support vision -> beri petunjuk jelas
      logError(`Local AI gagal (${cfg.base}): ${e.message}`);
      logError(`Pastikan server AI lokal jalan & model '${cfg.model}' mendukung vision (multimodal).`);
      logError(`Uji manual: curl ${cfg.base}/models`);
      throw e;
    }
  } else {
    const key = process.env.GEMINI_API_KEY;
    if (!key) {
      logError("AI_PROVIDER=gemini tapi GEMINI_API_KEY belum diisi di .env — bukti di-skip");
      return null;
    }
    // Pakai SDK resmi @google/genai (GoogleGenAI + files.upload + interactions.create)
    try {
      const { GoogleGenAI } = require("@google/genai");
      const client = new GoogleGenAI({ apiKey: key });
      const model = String(process.env.GEMINI_MODEL || "gemini-3.8-flash").trim();

      // 1) Upload gambar (dari path file yang sudah disimpan, atau dari buffer)
      let uri, mimeOut;
      const filePath = opts && opts.filePath;
      if (filePath && fs.existsSync(filePath)) {
        const uploaded = await client.files.upload({ file: filePath, config: { mimeType: mime } });
        uri = uploaded.uri || uploaded.file?.uri;
        mimeOut = uploaded.mimeType || uploaded.file?.mimeType || mime;
      } else {
        const uploaded = await client.files.upload({
          file: { bytes: buffer, mimeType: mime },
          config: { mimeType: mime },
        });
        uri = uploaded.uri || uploaded.file?.uri;
        mimeOut = uploaded.mimeType || uploaded.file?.mimeType || mime;
      }

      // 2) Minta klasifikasi ke model
      const interaction = await client.interactions.create({
        model,
        input: [
          { type: "text", text: PROMPT },
          { type: "image", uri, mime_type: mimeOut },
        ],
      });

      text = interaction?.output_text || interaction?.output?.text || interaction?.text || "";
      activeModel = model;
      if (!text) throw new Error("Gemini SDK: respons kosong");
      logInfo(`Gemini SDK upload ok → ${model} (uri: ${String(uri).slice(0, 60)}...)`);
    } catch (sdkErr) {
      logError(`Gemini SDK gagal: ${sdkErr.message}`);
      logError("Beralih ke REST API generateContent...");
      const body = {
        contents: [{ parts: [{ text: PROMPT }, { inlineData: { mimeType: mime, data: b64 } }] }],
        generationConfig: { temperature: 0, maxOutputTokens: 1024, responseMimeType: "application/json" },
      };
      let json = null, lastErr = null;
      for (const model of modelCandidates()) {
        try {
          json = await callGemini(model, key, body);
          activeModel = model;
          break;
        } catch (e) {
          lastErr = e;
          const modelGone = e.status === 404 || /(is not found for API version|models\/\S+ is not found|model not found)/i.test(e.body || "");
          if (modelGone) { logInfo(`Model ${model} tidak tersedia, mencoba fallback...`); continue; }
          throw e;
        }
      }
      if (!json) throw lastErr || new Error("Gemini: tidak ada model yang tersedia");
      text = json?.candidates?.[0]?.content?.parts?.[0]?.text || "";
      if (!text) throw new Error("Gemini kosong");
    }
  }

  let parsed;
  try {
    parsed = JSON.parse(cleanJsonText(text));
  } catch (e) {
    logError("AI JSON parse gagal:", String(text).slice(0, 500));
    return normalizeAIResult({ is_transfer_proof: false, classification: "UNREADABLE", confidence: 0.6, reason: "AI tidak mengembalikan JSON valid", missing_fields: [] });
  }
  const out = normalizeAIResult(parsed);
  logInfo(`AI Vision [${activeModel || provider}] → ${out.classification} conf=${out.confidence} nominal=${out.nominal ?? "-"} tgl=${out.tanggal_transfer ?? "-"} status=${out.status_transaksi ?? "-"}`);
  return out;
}

async function isBuktiTransfer(buffer, mimeType, opts) {
  const r = await analyzeBukti(buffer, mimeType, opts);
  if (!r) return false;
  return r.classification === "VALID_TRANSFER_PROOF" && r.confidence >= 0.75;
}

module.exports = { analyzeBukti, isBuktiTransfer, normalizeAIResult, PROMPT, aiProvider, localConfig };
