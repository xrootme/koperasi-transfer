const makeWASocket = require("@whiskeysockets/baileys").default;
const { DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, Browsers, downloadMediaMessage } = require("@whiskeysockets/baileys");
const pino = require("pino");
const qrcode = require("qrcode-terminal");
const path = require("path");
const { logInfo, logError } = require("./utils");

// Baileys/libsignal mencetak "Failed to decrypt ... Bad MAC" ke console.
// Ini noise non-fatal (pesan lama/duplikat session), bukan error fatal.
const origConsoleError = console.error.bind(console);
console.error = (...args) => {
  try {
    const first = args[0];
    if (typeof first === "string" && (first.includes("Bad MAC") || first.includes("Failed to decrypt message with any known session"))) return;
    if (first && typeof first === "object" && first.err && String(first.err?.message || "").includes("Bad MAC")) return;
  } catch {}
  return origConsoleError(...args);
};
const origConsoleWarn = console.warn.bind(console);
console.warn = (...args) => {
  try {
    const s = args.map((a) => (typeof a === "string" ? a : "")).join(" ");
    if (s.includes("Bad MAC") || s.includes("Failed to decrypt")) return;
  } catch {}
  return origConsoleWarn(...args);
};

let sock;
let ready = false;
let reconnecting = false;
const processedIds = new Set();

function unwrapMessage(message) {
  let m = message;
  if (!m) return null;
  if (m.ephemeralMessage) m = m.ephemeralMessage.message;
  if (m.viewOnceMessage) m = m.viewOnceMessage.message;
  if (m.viewOnceMessageV2) m = m.viewOnceMessageV2.message;
  if (m.documentWithCaptionMessage) m = m.documentWithCaptionMessage.message;
  return m;
}

function extractImage(message) {
  const m = unwrapMessage(message);
  if (!m) return null;
  if (m.imageMessage) return { content: m.imageMessage, type: "image" };
  if (m.documentMessage && String(m.documentMessage.mimetype || "").startsWith("image/")) return { content: m.documentMessage, type: "image" };
  return null;
}

function extractText(message) {
  const m = unwrapMessage(message);
  if (!m) return "";
  if (m.conversation) return m.conversation;
  if (m.extendedTextMessage?.text) return m.extendedTextMessage.text;
  if (m.imageMessage?.caption) return m.imageMessage.caption;
  if (m.documentMessage?.caption) return m.documentMessage.caption;
  if (m.videoMessage?.caption) return m.videoMessage.caption;
  return "";
}

function digitsOnlyLocal(phone) {
  let p = String(phone).replace(/[^0-9]/g, "");
  if (p.startsWith("0")) p = "62" + p.slice(1);
  return p;
}
function getAdminDigits() {
  const raw = process.env.ADMIN_NUMBERS || process.env.ADMIN_NUMBER || "62895634117345";
  return String(raw).split(",").map(s=> digitsOnlyLocal(s.trim())).filter(Boolean);
}
function isAdminLocal(jidDigits) {
  const d = digitsOnlyLocal(String(jidDigits||"").split("@")[0].split(":")[0]);
  const list = getAdminDigits();
  if (list.includes(d)) return true;
  const alt = d.startsWith("62") ? "0"+d.slice(2) : d.startsWith("0") ? "62"+d.slice(1) : d;
  return list.includes(alt);
}
async function notifyAdminImage(buffer, mime, phoneDigits, pushName, member, ai, validation, captionExtra, senderLid) {
  try {
    if (isAdminLocal(phoneDigits) || (senderLid && isAdminLocal(senderLid))) return;
    const admins = getAdminDigits();
    if (!admins.length) return;
    const name = member ? member.nama : (pushName || "-");
    const sheetInfo = member ? `${member.sheetName} ke-${member.pinjaman_ke||1} | cair ${member.tgl_cair||"-"} | pinj ${member.pinjaman||"-"}` : "Tidak terdaftar di sheet";
    const aiInfo = ai ? `${ai.classification} conf=${ai.confidence}` : "-";
    const decision = validation ? validation.decision : (ai && (ai.classification==="NOT_TRANSFER_PROOF"||ai.classification==="UNREADABLE") ? "SKIP (tanpa balas)" : "-");
    const cap = captionExtra || "";
    const caption = `📸 *Gambar masuk*\nDari: *${name}* (${pushName||"-"})\nNo: ${phoneDigits}\nSheet: ${sheetInfo}\n${member ? `A: ${member.installments.map(x=>x.status||"-").join("|")} sisa ${member.sisa}x` : ""}\n\n*AI Vision:* ${aiInfo}\nNominal: ${ai?.nominal ?? "-"} | Tgl: ${ai?.tanggal_transfer ?? "-"} | Status: ${ai?.status_transaksi ?? "-"}\n*Keputusan:* ${decision}\nAlasan: ${(validation?.reasons||[ai?.reason||"-"]).join(" | ").slice(0,600)}${cap ? "\n"+cap : ""}\n\nWaktu: ${new Date().toLocaleString("id-ID",{timeZone:process.env.TIMEZONE||"Asia/Jakarta"})}`;
    for (const ad of admins) {
      const jid = `${ad}@s.whatsapp.net`;
      try {
        await sock.sendMessage(jid, { image: buffer, caption });
        logInfo(`Forward gambar ${phoneDigits} -> admin ${ad}`);
      } catch(e){ logError(`Forward ke admin ${ad} gagal`, e.message); }
    }
  } catch(e){ logError("notifyAdminImage gagal", e.message); }
}

async function writeReviewRow(rawJid, phoneDigits, ai, validation, member) {
  const id = process.env.SPREADSHEET_ID;
  if (!id) return;
  try {
    const sheetsMod = require("./sheets");
    const sheets = await sheetsMod.getSheetsClient();
    const reviewSheet = process.env.REVIEW_SHEET || "Review";
    const meta = await sheets.spreadsheets.get({ spreadsheetId: id });
    let review = meta.data.sheets.find((s) => s.properties.title === reviewSheet);
    if (!review) {
      await sheets.spreadsheets.batchUpdate({ spreadsheetId: id, requestBody: { requests: [{ addSheet: { properties: { title: reviewSheet } } }] } });
      const meta2 = await sheets.spreadsheets.get({ spreadsheetId: id });
      review = meta2.data.sheets.find((s) => s.properties.title === reviewSheet);
      await sheets.spreadsheets.values.update({
        spreadsheetId: id,
        range: `${reviewSheet}!A1:L1`,
        valueInputOption: "RAW",
        requestBody: { values: [["waktu", "no_hp", "nama", "sheet", "angsuran_ke", "klasifikasi", "confidence", "nominal_ai", "nominal_expected", "status_ai", "tanggal_ai", "alasan_review"]] },
      });
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: id,
        requestBody: { requests: [
          { repeatCell: { range: { sheetId: review.properties.sheetId, startRowIndex: 0, endRowIndex: 1 }, cell: { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: { red: 1, green: 0.95, blue: 0.8 } } }, fields: "userEnteredFormat(textFormat,backgroundColor)" } },
          { updateSheetProperties: { properties: { sheetId: review.properties.sheetId, gridProperties: { frozenRowCount: 1 } }, fields: "gridProperties.frozenRowCount" } },
        ]},
      });
    }
    const row = [
      new Date().toLocaleString("id-ID", { timeZone: process.env.TIMEZONE || "Asia/Jakarta" }),
      phoneDigits,
      member ? member.nama : "",
      member ? member.sheetName : "",
      validation?.matchedInstallment ? `A${validation.matchedInstallment.n}` : "",
      ai.classification,
      String(ai.confidence ?? ""),
      ai.nominal !== null ? String(ai.nominal) : "",
      validation?.expected !== undefined ? String(validation.expected ?? "") : "",
      ai.status_transaksi || "",
      ai.tanggal_transfer || "",
      (validation?.reasons || [ai.reason]).join(" | ").slice(0, 900),
    ];
    await sheets.spreadsheets.values.append({
      spreadsheetId: id,
      range: `${reviewSheet}!A:L`,
      valueInputOption: "RAW",
      requestBody: { values: [row] },
    });
  } catch (e) { logError("Tulis Review gagal", e.message); }
}

function buildTerimaKasih10x(member, inst, sisa, semuaLunas, ai, trx) {
  const { formatRupiah, formatTanggal } = require("./utils");
  const dueStr = inst.due ? formatTanggal(inst.due) : member.tgl_cair || "-";
  const paid = Math.max(0, 10 - sisa);
  const marks = [];
  for (let n = 1; n <= 10; n++) {
    const cur = member.installments.find((x) => x.n === n);
    const st = String(cur?.status || "").toLowerCase();
    const done = ["sudah dibayar", "sudahdibayar", "lunas", "paid", "sudah bayar", "bayar"].includes(st);
    const sent = st === "terkirim";
    marks.push(done ? `${n}✓` : sent ? `${n}•` : `${n}✗`);
  }
  const rekap = marks.join(" ");
  const tail = semuaLunas
    ? `🎉 *Semua 10 angsuran LUNAS.*\nTerima kasih atas kekompasiannya.`
    : `📌 Sisa: *${sisa}x* lagi\nProgres: *${paid}/10* sudah dibayar`;
  const trxLine = trx ? `\n• No. transaksi: *${trx.noTrx}*\n• Tercatat di sheet: *Transaksi* baris #${trx.row}` : "";
  return `✅ *PEMBAYARAN BERHASIL*\n\nTerima kasih *${member.nama}* 🙏\nBukti transfer Anda sudah kami terima & verifikasi.\n\n*━━ Detail Angsuran ━━*\n• Kelompok: *${member.sheetName}*\n• Angsuran ke: *${inst.n} dari 10*\n• Nominal: *${formatRupiah(member.angsuran)}*\n• Jatuh tempo: *${dueStr}*\n• Status: *Sudah dibayar* ✓${trxLine}\n${member.pinjaman ? `• Total pinjaman: *${formatRupiah(member.pinjaman)}*\n` : ""}\n*━━ Riwayat ━━*\n${rekap}\n(✓ sudah dibayar • terkirim ✗ belum)\n\n${tail}\n\n_Tersimpan otomatis di catatan angsuran & riwayat transaksi. Jika ada kekeliruan, hubungi admin._`;
}

async function handleInbound(msg) {
  const remoteJid = msg.key.remoteJid;
  if (!remoteJid || remoteJid.endsWith("@g.us") || remoteJid === "status@broadcast") return;
  const msgId = msg.key.id;
  if (processedIds.has(msgId)) return;
  processedIds.add(msgId);
  if (processedIds.size > 600) { const it = processedIds.values().next().value; processedIds.delete(it); }

  const { resolveSender, registerLid } = require("./jid");
  const sender = resolveSender(msg);
  const phoneDigits = sender.phone || sender.digits;
  const lid = sender.lid;
  const pushName = sender.pushName;
  const img = extractImage(msg.message);
  const text = extractText(msg.message).trim();
  const waAdminForCheck = (()=>{ try{ return require("./wa-admin"); }catch{ return null; }})();
  if (waAdminForCheck) {
    const fromAdmin = waAdminForCheck.isAdmin(phoneDigits, lid);
    const hasAdminWord = waAdminForCheck.isAdminCommand(text);
    logInfo(`Inbound text from ${phoneDigits||remoteJid.split("@")[0]} (${pushName||"-"}) admin=${fromAdmin} isAdminCmd=${hasAdminWord} text="${text.slice(0,120)}" adminList=${waAdminForCheck.getAdminList().join(",")}`);
    if (fromAdmin && hasAdminWord) {
      try { await waAdminForCheck.handleAdminCommand(text, remoteJid, sock); } catch(e){ logError("handleAdminCommand error", e.message); }
      return;
    }
    if (!fromAdmin && hasAdminWord) {
      logInfo(`Non-admin ${phoneDigits||remoteJid.split("@")[0]} coba command admin — diabaikan (tanpa balas)`);
      return;
    }
  }

  if (img) {
    let buffer;
    let mime = img.content.mimetype || "image/jpeg";
    try {
      buffer = await downloadMediaMessage(msg, "buffer", {}, { logger: pino({ level: "silent" }), reuploadRequest: sock.updateMediaMessage });
    } catch (e) { logError(`Download gambar gagal ${phoneDigits} (${pushName})`, e.message); return; }
    if (!buffer || buffer.length < 800) { logInfo(`Gambar dari ${phoneDigits} (${pushName}) terlalu kecil — skip`); return; }

    logInfo(`📸 Gambar diterima dari ${phoneDigits} (${pushName||"-"}) size=${buffer.length} mime=${mime} caption="${(img.content.caption||"").slice(0,80)}"`);

    const { analyzeBukti } = require("./bukti");
    let ai;
    try { ai = await analyzeBukti(buffer, mime); } catch (e) { logError("AI Vision error", e.message); return; }
    if (!ai) return;

    logInfo(`Gambar ${phoneDigits} (${pushName}) → ${ai.classification} conf=${ai.confidence}`);

    const sheetsMod = require("./sheets");
    let member = null;
    try { member = await sheetsMod.findMemberByPhone(phoneDigits); } catch (e) { logError("findMember gagal", e.message); }
    if (member) logInfo(`Pengirim terdaftar: ${member.nama} [${member.sheetName} ke-${member.pinjaman_ke} tgl_cair ${member.tgl_cair}] ${phoneDigits}`);
    else logInfo(`Pengirim TIDAK terdaftar di sheet: ${phoneDigits} (${pushName})`);

    if (ai.classification === "NOT_TRANSFER_PROOF" || ai.classification === "UNREADABLE") {
      logInfo(`Skip ${phoneDigits} (${pushName}): ${ai.classification} — tanpa balas member, tapi forward ke admin`);
      await notifyAdminImage(buffer, mime, phoneDigits, pushName, member, ai, { decision:"SKIP", reasons:[ai.reason||ai.classification], matchedInstallment:null, expected:null }, `Caption: ${(img.content.caption||"").slice(0,100)}`, lid);
      return;
    }

    const { validateBukti } = require("./validation");
    const { formatRupiah, formatTanggal } = require("./utils");

    if (!member) {
      logInfo(`Bukti ${phoneDigits} (${pushName}) (${ai.classification}) — nomor tidak terdaftar, tulis Review + notify admin`);
      try { await writeReviewRow(remoteJid, phoneDigits, ai, { reasons: ["Nomor tidak terdaftar di sheet manapun"], matchedInstallment: null }, null); } catch {}
      await notifyAdminImage(buffer, mime, phoneDigits, pushName, null, ai, { decision:"REVIEW", reasons:["Nomor tidak terdaftar"], matchedInstallment:null, expected:null }, "", lid);
      return;
    }

    // Auto-update HANYA jika hari ini = sheet/hari yang ditentukan admin.
    // Kalau anggota kirim di luar hari jadwalnya -> masuk Review, tidak auto Lunas.
    const hariIni = sheetsMod.getTodaySheetName();
    const strictHari = String(process.env.STRICT_HARI || "true").toLowerCase() !== "false";
    if (strictHari && member.sheetName !== hariIni) {
      const alasan = `Hari kirim ${hariIni}, jadwal angsuran ${member.sheetName} — tidak auto-update`;
      logInfo(`⏸ ${member.nama} [${member.sheetName}] kirim hari ${hariIni} — ${alasan}, masuk Review`);
      await writeReviewRow(remoteJid, phoneDigits, ai, { reasons: [alasan], matchedInstallment: null, expected: null }, member);
      await notifyAdminImage(buffer, mime, phoneDigits, pushName, member, ai, { decision: "REVIEW", reasons: [alasan], matchedInstallment: null, expected: null }, `Caption: ${(img.content.caption || "").slice(0, 100)}`, lid);
      return;
    }

    const validation = validateBukti(ai, member);
    logInfo(`Validation ${member.nama} [${member.sheetName} / hari ${hariIni}] → ${validation.decision} | ${validation.reasons.join(" | ") || "ok"}`);

    await notifyAdminImage(buffer, mime, phoneDigits, pushName, member, ai, validation, `Caption: ${(img.content.caption||"").slice(0,100)}`, lid);

    if (validation.decision === "VERIFIED" && member.is10x) {
      const inst = validation.matchedInstallment || sheetsMod.pickInstallmentToConfirm(member);
      if (!inst) { logInfo(`VERIFIED tapi tidak ada installment untuk ${member.nama} — REVIEW`); await writeReviewRow(remoteJid, phoneDigits, ai, validation, member); return; }
      try {
        await sheetsMod.updateInstallment(member.rowIndex, inst.n, "Sudah dibayar", member.sheetName);
        const sisa = member.sisa - 1;
        const semuaLunas = sisa === 0;
        logInfo(`VERIFIED ${member.nama} [${member.sheetName} A${inst.n}] → Sudah dibayar (sisa ${sisa}x)`);
        const dueStr = inst.due ? formatTanggal(inst.due) : member.tgl_cair;
        // 1) Catat ke sheet "Transaksi" (riwayat setiap pembayaran berhasil)
        let trx = null;
        try {
          trx = await sheetsMod.catatTransaksi({
            nama: member.nama, no_hp: member.no_hp, kelompok: member.sheetName,
            pinjaman_ke: member.pinjaman_ke, angsuran_ke: inst.n,
            nominal: member.angsuran, tanggal_transfer: ai?.tanggal_transfer || null,
            waktu_transfer: ai?.waktu_transfer || null, bank_pengirim: ai?.bank_pengirim || null,
            rekening_pengirim: ai?.rekening_pengirim || null, bank_penerima: ai?.bank_penerima || null,
            referensi: ai?.referensi_transaksi || null, status_ai: ai?.status_transaksi || null,
            klasifikasi: ai?.classification, confidence: ai?.confidence,
            sisa_setelah: sisa, status: "Berhasil",
          });
          logInfo(`Transaksi dicatat: ${trx.noTrx} (sheet Transaksi baris ${trx.row})`);
        } catch (e) { logError("Gagal catat transaksi", e.message); }
        // 2) Tampilkan hasil pencatatan ke anggota
        await sock.sendMessage(remoteJid, { text: buildTerimaKasih10x(member, inst, sisa, semuaLunas, ai, trx) });
      } catch (e) { logError(`Gagal update Sudah dibayar ${member.nama} A${inst.n}`, e.message); }
      return;
    }

    if (validation.decision === "VERIFIED" && !member.is10x) {
      const st = String(member.status || "").trim().toLowerCase();
      if (["lunas", "sudah bayar", "sudah dibayar", "paid"].includes(st)) {
        try { await sock.sendMessage(remoteJid, { text: `Halo *${member.nama}*, pembayaran ini sudah tercatat *Sudah dibayar*. Terima kasih.` }); } catch {}
        return;
      }
      try {
        await sheetsMod.updateStatus(member.rowIndex, "Sudah dibayar", member.sheetName);
        logInfo(`VERIFIED ${member.nama} → Sudah dibayar`);
        const tgl = member.jatuh_tempo ? formatTanggal(member.jatuh_tempo) : "-";
        let trx = null;
        try {
          trx = await sheetsMod.catatTransaksi({
            nama: member.nama, no_hp: member.no_hp, kelompok: member.sheetName,
            pinjaman_ke: "1", angsuran_ke: "", nominal: member.angsuran || member.nominal,
            tanggal_transfer: ai?.tanggal_transfer || null, waktu_transfer: ai?.waktu_transfer || null,
            bank_pengirim: ai?.bank_pengirim || null, rekening_pengirim: ai?.rekening_pengirim || null,
            bank_penerima: ai?.bank_penerima || null, referensi: ai?.referensi_transaksi || null,
            status_ai: ai?.status_transaksi || null, klasifikasi: ai?.classification,
            confidence: ai?.confidence, sisa_setelah: "", status: "Berhasil",
          });
          logInfo(`Transaksi dicatat: ${trx.noTrx} (sheet Transaksi baris ${trx.row})`);
        } catch (e) { logError("Gagal catat transaksi", e.message); }
        const trxLine = trx ? `\n• No. transaksi: *${trx.noTrx}*\n• Tercatat di sheet: *Transaksi* baris #${trx.row}\n` : "";
        await sock.sendMessage(remoteJid, { text: `✅ *PEMBAYARAN BERHASIL*\n\nTerima kasih *${member.nama}* 🙏\n\n*Detail Angsuran*\n• Nominal: *${formatRupiah(member.angsuran || member.nominal)}*\n• Jatuh tempo: *${tgl}*\n• Status: *Sudah dibayar* ✓${trxLine}\nTersimpan di catatan angsuran. Jika ada kekeliruan hubungi admin.` });
      } catch (e) { logError(`Gagal update Sudah dibayar ${member.nama}`, e.message); }
      return;
    }

    await writeReviewRow(remoteJid, phoneDigits, ai, validation, member);
    logInfo(`REVIEW ${member.nama} — tidak auto Lunas, masuk sheet Review (sudah notify admin)`);
    return;
  }

  if (text) {
    const low = text.toLowerCase();
    const waAdminPre = (()=>{ try{ return require("./wa-admin"); }catch{ return null; }})();
    if (waAdminPre && waAdminPre.isAdmin(phoneDigits, lid)) {
      const maybeAdmin = /^\s*[\/\!\.\#]?\s*(tambah|ubah|update|edit|lunas|set|hapus|remove|cek|list|menu|help)\b/i.test(text);
      if (maybeAdmin) {
        logInfo(`Text admin ${phoneDigits} tidak terdeteksi sebagai adminCommand, dump: "${text.slice(0,150)}"`);
      }
    }
    const isStatusQuery = /(cek|sisa|status|bayar|belum|angsuran|tagihan|lunas|review)/i.test(low) && low.length < 80;
    if (!isStatusQuery) return;
    const sheetsMod = require("./sheets");
    const { formatRupiah } = require("./utils");
    let member;
    try { member = await sheetsMod.findMemberByPhone(phoneDigits); } catch { return; }
    if (!member) return;
    if (member.is10x) {
      const lunas = member.installments.filter((x) => x.status.toLowerCase() === "lunas").length;
      const belum = member.installments.filter((x) => x.status.toLowerCase() !== "lunas").map((x) => `A${x.n}:${x.status || "Belum"}`).join(" ");
      const msg = `Halo *${member.nama}* — *${member.sheetName}*\nPinjaman: *${formatRupiah(member.pinjaman)}* | Angsuran: *${formatRupiah(member.angsuran)}*/minggu\nSudah lunas: *${lunas}/10* | Sisa: *${member.sisa}x*\nDetail: ${belum}\n\nKirim foto bukti transfer untuk verifikasi otomatis. Jika bukti tidak jelas akan masuk antrian Review admin.`;
      try { await sock.sendMessage(remoteJid, { text: msg }); } catch {}
    } else {
      const st = member.status || "Belum";
      try { await sock.sendMessage(remoteJid, { text: `Halo *${member.nama}* — tagihan *${formatRupiah(member.angsuran || member.nominal)}* status: *${st}*. Kirim bukti transfer jika sudah bayar.` }); } catch {}
    }
  }
}

async function createClient() {
  const authPath = path.join(__dirname, "..", ".baileys-auth");
  const { state, saveCreds } = await useMultiFileAuthState(authPath);
  let version;
  try { const v = await fetchLatestBaileysVersion(); version = v.version; } catch {}
  sock = makeWASocket({
    version,
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" })) },
    logger: pino({ level: "silent" }),
    browser: Browsers.appropriate("Desktop"),
    printQRInTerminal: false,
  });
  sock.ev.on("creds.update", saveCreds);

  try {
    sock.ev.on("chats.phoneNumberShare", ({ lid, jid } = {}) => {
      if (lid && jid) { registerLid(lid, jid); logInfo(`📱 Mapping LID: ${String(lid).split("@")[0]} -> ${String(jid).split("@")[0]}`); }
    });
  } catch {}
  try {
    sock.ev.on("contacts.update", (contacts) => {
      for (const c of contacts || []) {
        if (c.id && c.lid) registerLid(c.lid, c.id);
      }
    });
  } catch {}
  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) { console.log("Scan QR di WhatsApp:"); qrcode.generate(qr, { small: true }); }
    if (connection === "close") {
      ready = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      logError("WhatsApp disconnected", lastDisconnect?.error?.message || String(statusCode || ""));
      if (shouldReconnect && !reconnecting) {
        reconnecting = true;
        logInfo("Reconnect WhatsApp dalam 3 detik...");
        setTimeout(() => { reconnecting = false; createClient().catch((e) => logError("Reconnect gagal", e.message)); }, 3000);
      } else if (!shouldReconnect) logInfo("Logged out — hapus folder .baileys-auth dan scan ulang");
    } else if (connection === "open") { ready = true; reconnecting = false; logInfo("WhatsApp Baileys siap — AI Vision 4-klasifikasi aktif"); }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const msg of messages) {
      if (!msg.message) continue;
      if (msg.key.fromMe) continue;
      try { await handleInbound(msg); } catch (e) { logError("Inbound handler error", e.message); }
    }
  });

  return sock;
}

function getClient() {
  if (!sock) { createClient().catch((e) => logError("Baileys init gagal", e.message)); return null; }
  return sock;
}

function isReady() { return ready && !!sock; }

async function sendMessage(to, message) {
  if (!ready || !sock) throw new Error("WhatsApp client belum ready");
  let jid = String(to).trim();
  if (!jid.includes("@")) {
    let p = jid.replace(/[^0-9]/g, "");
    if (p.startsWith("0")) p = "62" + p.slice(1);
    jid = `${p}@s.whatsapp.net`;
  } else if (jid.endsWith("@c.us")) jid = jid.replace("@c.us", "@s.whatsapp.net");
  return sock.sendMessage(jid, { text: message });
}

module.exports = { createClient, getClient, isReady, sendMessage };
