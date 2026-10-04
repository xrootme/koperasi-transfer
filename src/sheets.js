const { google } = require("googleapis");
const path = require("path");

const CREDENTIALS_PATH = path.join(__dirname, "..", "credentials.json");
const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];
const GROUP_SHEETS = ["Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu"];

const HEADERS_10X = ["nama","no_hp","pinjaman","pinjaman_ke","angsuran","tgl_cair","A1","A2","A3","A4","A5","A6","A7","A8","A9","A10","sisa","keterangan"];
const HEADERS_10X_HELP = ["","", "(total)", "#", "(per minggu)", "YYYY-MM-DD","minggu 1","minggu 2","minggu 3","minggu 4","minggu 5","minggu 6","minggu 7","minggu 8","minggu 9","minggu 10","otomatis","bebas"];

function getTodaySheetName(date = new Date()) {
  const tz = process.env.TIMEZONE || "Asia/Jakarta";
  const weekday = new Intl.DateTimeFormat("id-ID", { weekday: "long", timeZone: tz }).format(date);
  return weekday.charAt(0).toUpperCase() + weekday.slice(1).toLowerCase();
}
function isGroupMode() { return String(process.env.USE_GROUP_SHEETS || "true").toLowerCase() !== "false"; }
async function getSheetsClient() {
  const auth = new google.auth.GoogleAuth({ keyFile: CREDENTIALS_PATH, scopes: SCOPES });
  return google.sheets({ version: "v4", auth: await auth.getClient() });
}
function addDays(dateStr, days) {
  const d = new Date(String(dateStr).trim());
  if (isNaN(d)) return null;
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + days);
  return d;
}
function digitsOnly(phone) {
  let p = String(phone).replace(/[^0-9]/g, "");
  if (p.startsWith("0")) p = "62" + p.slice(1);
  return p;
}
function normalizeHeader(h) { return String(h||"").trim().toLowerCase(); }

// Locale spreadsheet (mis. in_ID) menentukan pemisah argumen formula: ";" bukan ",".
let cachedSep = null;
function formulaSep() { return cachedSep || ","; }
async function detectFormulaSep() {
  if (cachedSep) return cachedSep;
  try {
    const sheets = await getSheetsClient();
    const meta = await sheets.spreadsheets.get({ spreadsheetId: process.env.SPREADSHEET_ID, fields: "properties.locale" });
    const loc = meta?.data?.properties?.locale || "en_US";
    cachedSep = /^id_ID$/i.test(loc) || /^in_ID$/i.test(loc) ? ";" : ",";
  } catch { cachedSep = ","; }
  return cachedSep;
}
function sisaFormula(row) {
  const sep = formulaSep();
  return `="Sisa "&(10-COUNTIF(G${row}:P${row}${sep}"Sudah dibayar"))&"x"`;
}

const STATUS_BAYAR = "Sudah dibayar";
const STATUS_BELUM = "Belum dibayar";
const STATUS_TERKIRIM = "Terkirim";
const PAIVED_KEYS = ["sudah dibayar", "sudahdibayar", "lunas", "paid", "sudah bayar", "bayar", "selesai"];

function isPaid(status) {
  return PAIVED_KEYS.includes(String(status || "").trim().toLowerCase());
}
function isBelum(status) {
  const s = String(status || "").trim().toLowerCase();
  return s === "" || ["belum", "belum dibayar", "belumdibayar", "pending", "tidak"].includes(s);
}
function isTerkirim(status) {
  return String(status || "").trim().toLowerCase() === "terkirim";
}
function paidCount(installments) {
  return (installments || []).filter((x) => isPaid(x.status)).length;
}

function resolveIdx(headers) {
  const h = headers.map(normalizeHeader);
  const find = (aliases) => {
    for (const a of aliases) { const i = h.indexOf(a); if (i !== -1) return i; }
    return -1;
  };
  return {
    nama: find(["nama"]),
    no_hp: find(["no_hp","no hp","hp","telepon","phone"]),
    pinjaman: find(["pinjaman","plafon","pokok","besar pinjaman","besar_pinjaman"]),
    pinjaman_ke: find(["pinjaman_ke","pinjaman ke","pinjaman-ke","ke","siklus"]),
    angsuran: find(["angsuran","nominal","jumlah","cicilan"]),
    tgl_cair: find(["tgl_cair","tgl cair","tgl_mulai","tgl mulai","mulai","start","tanggal_mulai","tanggal_cair","tanggal pencairan","tgl_pencairan"]),
    keterangan: find(["keterangan","catatan","note"]),
    sisa: find(["sisa"]),
  };
}

function parse10xRow(row, headers, rowIndex, sheetName) {
  const idx = resolveIdx(headers);
  const h = headers.map(normalizeHeader);
  const hasA = h.includes("a1");
  const installments = [];
  if (hasA) {
    for (let n = 1; n <= 10; n++) {
      const col = h.indexOf(`a${n}`);
      const status = col !== -1 ? String(row[col] || "").trim() : "";
      const cair = idx.tgl_cair !== -1 ? row[idx.tgl_cair] : "";
      const due = cair ? addDays(cair, (n - 1) * 7) : null;
      installments.push({ n, col, colLetter: col !== -1 ? String.fromCharCode(65 + col) : null, status, due });
    }
  }
  const countLunas = paidCount(installments);
  return {
    rowIndex, sheetName,
    nama: idx.nama !== -1 ? String(row[idx.nama] || "").trim() : "",
    no_hp: idx.no_hp !== -1 ? String(row[idx.no_hp] || "").trim() : "",
    pinjaman: idx.pinjaman !== -1 ? String(row[idx.pinjaman] || "").trim() : "",
    pinjaman_ke: idx.pinjaman_ke !== -1 ? String(row[idx.pinjaman_ke] || "").trim() : "",
    angsuran: idx.angsuran !== -1 ? String(row[idx.angsuran] || "").trim() : "",
    tgl_cair: idx.tgl_cair !== -1 ? String(row[idx.tgl_cair] || "").trim() : "",
    tgl_mulai: idx.tgl_cair !== -1 ? String(row[idx.tgl_cair] || "").trim() : "",
    keterangan: idx.keterangan !== -1 ? String(row[idx.keterangan] || "").trim() : "",
    sisa: hasA ? 10 - countLunas : null,
    countLunas,
    installments,
    is10x: hasA,
    headers,
    raw: row,
  };
}

async function getAngsuranData(sheetNameOverride) {
  const sheets = await getSheetsClient();
  const spreadsheetId = process.env.SPREADSHEET_ID;
  let sheetName = sheetNameOverride;
  if (!sheetName) {
    if (isGroupMode()) sheetName = getTodaySheetName();
    else sheetName = process.env.SHEET_NAME || "Sheet1";
    if (sheetName === "Minggu") return [];
  }
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${sheetName}!A:Z` });
  const rows = res.data.values || [];
  if (rows.length < 1) return [];
  const headers = rows[0].map((s) => String(s).trim().toLowerCase());
  const is10x = headers.includes("a1") && headers.includes("a10");
  let dataStart = 1;
  if (is10x && rows.length >= 2) {
    const second = (rows[1] || []).map((v) => String(v).trim().toLowerCase());
    if (second.includes("minggu 1") || second[5] === "minggu 1" || second.includes("(per minggu)") || second.includes("yyyy-mm-dd")) dataStart = 2;
  }
  if (rows.length <= dataStart) return [];
  if (is10x) return rows.slice(dataStart).map((row, i) => parse10xRow(row, headers, i + dataStart + 1, sheetName)).filter((r) => (r.nama || r.no_hp) && !String(r.nama).toLowerCase().startsWith("petunjuk"));
  const idx = {
    nama: headers.indexOf("nama"),
    no_hp: headers.findIndex((h) => ["no_hp", "no hp", "hp", "telepon", "phone"].includes(h)),
    nominal: headers.findIndex((h) => ["nominal", "jumlah", "angsuran"].includes(h)),
    jatuh_tempo: headers.findIndex((h) => ["jatuh_tempo", "jatuh tempo", "tanggal", "due"].includes(h)),
    status: headers.indexOf("status"),
  };
  return rows.slice(dataStart).map((row, i) => ({
    rowIndex: i + dataStart + 1, sheetName,
    nama: row[idx.nama] || "", no_hp: row[idx.no_hp] || "", nominal: row[idx.nominal] || "", angsuran: row[idx.nominal] || "",
    jatuh_tempo: row[idx.jatuh_tempo] || "", status: row[idx.status] || "", is10x: false, headers, raw: row,
  })).filter((r) => (r.nama || r.no_hp) && !String(r.nama).toLowerCase().startsWith("petunjuk"));
}

async function getAllGroupsData() {
  const out = {};
  for (const s of GROUP_SHEETS) { try { out[s] = await getAngsuranData(s); } catch (e) { out[s] = { error: e.message }; } }
  return out;
}

async function findMemberByPhone(phoneDigits) {
  const target = digitsOnly(phoneDigits);
  for (const sheet of GROUP_SHEETS) {
    let rows; try { rows = await getAngsuranData(sheet); } catch { continue; }
    for (const r of rows) if (digitsOnly(r.no_hp) === target) return r;
  }
  try {
    const fallback = process.env.SHEET_NAME || "Sheet1";
    if (!GROUP_SHEETS.includes(fallback)) {
      const rows = await getAngsuranData(fallback);
      for (const r of rows) if (digitsOnly(r.no_hp) === target) return r;
    }
  } catch {}
  return null;
}

async function findMemberByPhoneDetailed(phoneDigits) {
  const m = await findMemberByPhone(phoneDigits);
  if (!m) return null;
  const sheets = await getSheetsClient();
  const spreadsheetId = process.env.SPREADSHEET_ID;
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const sh = meta.data.sheets.find((s) => s.properties.title === m.sheetName);
  return { ...m, sheetId: sh ? sh.properties.sheetId : null };
}

function pickInstallmentToConfirm(member) {
  if (!member || !member.is10x) return null;
  if (member.sisa === 0) return null;
  const terkirim = member.installments.find((x) => isTerkirim(x.status));
  if (terkirim) return terkirim;
  const today = new Date(); today.setHours(0,0,0,0);
  for (const inst of member.installments) {
    if (isPaid(inst.status)) continue;
    if (!inst.due) return inst;
    const d = new Date(inst.due); d.setHours(0,0,0,0);
    if (d <= today) return inst;
    return null;
  }
  return member.installments.find((x) => !isPaid(x.status)) || null;
}

const headerCache = new Map(); // "sheetName" -> string[] (header lowercase)
const HEADER_TTL_MS = 60 * 1000;
async function getHeaderRow(sheets, spreadsheetId, sheetName) {
  const cached = headerCache.get(sheetName);
  if (cached && Date.now() - cached.at < HEADER_TTL_MS) return cached.headers;
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${sheetName}!1:1` });
  const headers = (res.data.values?.[0] || []).map((h) => String(h).trim().toLowerCase());
  headerCache.set(sheetName, { headers, at: Date.now() });
  return headers;
}
function clearHeaderCache(sheetName) {
  if (sheetName) headerCache.delete(sheetName);
  else headerCache.clear();
}

async function updateStatus(rowIndex, status, sheetNameOverride) {
  const sheets = await getSheetsClient();
  const spreadsheetId = process.env.SPREADSHEET_ID;
  let sheetName = sheetNameOverride;
  if (!sheetName) { if (isGroupMode()) sheetName = getTodaySheetName(); else sheetName = process.env.SHEET_NAME || "Sheet1"; }
  const headers = await getHeaderRow(sheets, spreadsheetId, sheetName);
  if (headers.includes("a1")) throw new Error(`Sheet 10x "${sheetName}": gunakan updateInstallment`);
  const col = headers.indexOf("status");
  if (col === -1) throw new Error(`Kolom 'status' tidak ditemukan di "${sheetName}"`);
  await sheets.spreadsheets.values.update({ spreadsheetId, range: `${sheetName}!${String.fromCharCode(65 + col)}${rowIndex}`, valueInputOption: "RAW", requestBody: { values: [[status]] } });
}

async function updateInstallment(rowIndex, n, status, sheetNameOverride) {
  const sheets = await getSheetsClient();
  const spreadsheetId = process.env.SPREADSHEET_ID;
  let sheetName = sheetNameOverride;
  if (!sheetName) { if (isGroupMode()) sheetName = getTodaySheetName(); else sheetName = process.env.SHEET_NAME || "Sheet1"; }
  const headers = await getHeaderRow(sheets, spreadsheetId, sheetName);
  const col = headers.indexOf(`a${n}`);
  if (col === -1) throw new Error(`Kolom A${n} tidak ditemukan di "${sheetName}" (header: ${headers.join(",")})`);
  await sheets.spreadsheets.values.update({ spreadsheetId, range: `${sheetName}!${String.fromCharCode(65 + col)}${rowIndex}`, valueInputOption: "RAW", requestBody: { values: [[status]] } });
  headerCache.delete(sheetName);
}

async function updateMemberFields(sheetName, rowIndex, fields) {
  const sheets = await getSheetsClient();
  const spreadsheetId = process.env.SPREADSHEET_ID;
  const headers = await getHeaderRow(sheets, spreadsheetId, sheetName);
  const idx = resolveIdx(headers);
  const updates = [];
  for (const [key, value] of Object.entries(fields)) {
    let aliases = [key];
    if (key === "tgl_cair") aliases = ["tgl_cair","tgl cair","tgl_mulai","tgl mulai","mulai","tanggal_cair","tgl_pencairan"];
    if (key === "pinjaman_ke") aliases = ["pinjaman_ke","pinjaman ke","pinjaman-ke"];
    if (key === "pinjaman") aliases = ["pinjaman","plafon","pokok"];
    if (key === "angsuran") aliases = ["angsuran","nominal","cicilan"];
    if (key === "nama") aliases = ["nama"];
    if (key === "no_hp") aliases = ["no_hp","no hp","hp"];
    if (key === "keterangan") aliases = ["keterangan"];
    let col = -1;
    for (const a of aliases) { const i = headers.indexOf(a); if (i !== -1) { col = i; break; } }
    if (col === -1) throw new Error(`Kolom ${key} tidak ditemukan di "${sheetName}" (header: ${headers.join(",")})`);
    const colLetter = col < 26 ? String.fromCharCode(65 + col) : String.fromCharCode(64 + Math.floor(col/26)) + String.fromCharCode(65 + (col % 26));
    updates.push({ range: `${sheetName}!${colLetter}${rowIndex}`, value });
  }
  for (const u of updates) {
    await sheets.spreadsheets.values.update({ spreadsheetId, range: u.range, valueInputOption: "RAW", requestBody: { values: [[String(u.value)]] } });
  }
  headerCache.delete(sheetName);
}

const TRANSAKSI_SHEET = process.env.TRANSAKSI_SHEET || "Transaksi";
const TRANSAKSI_HEADERS = ["no_transaksi","waktu","nama","no_hp","kelompok","pinjaman_ke","angsuran_ke","nominal","tgl_transfer","waktu_transfer","bank_pengirim","rekening_pengirim","bank_penerima","referensi","status_ai","klasifikasi","confidence","sisa_setelah","status"];

async function ensureTransaksiSheet(sheets, spreadsheetId) {
  const meta0 = await sheets.spreadsheets.get({ spreadsheetId });
  let sh = meta0.data.sheets.find((s) => s.properties.title === TRANSAKSI_SHEET);
  let isNew = false;
  if (!sh) {
    await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: [{ addSheet: { properties: { title: TRANSAKSI_SHEET } } }] } });
    isNew = true;
    const meta2 = await sheets.spreadsheets.get({ spreadsheetId });
    sh = meta2.data.sheets.find((s) => s.properties.title === TRANSAKSI_SHEET);
  }
  // Pastikan baris header ada & benar (aman dipanggil ulang)
  const first = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${TRANSAKSI_SHEET}!A1:B1` });
  const cur = (first.data.values?.[0] || []).map((v) => String(v).trim().toLowerCase());
  const needHeader = cur[0] !== "no_transaksi";
  if (needHeader) {
    await sheets.spreadsheets.values.update({
      spreadsheetId, range: `${TRANSAKSI_SHEET}!A1:S1`, valueInputOption: "RAW",
      requestBody: { values: [TRANSAKSI_HEADERS] },
    });
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [
        { repeatCell: { range: { sheetId: sh.properties.sheetId, startRowIndex: 0, endRowIndex: 1 }, cell: { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: { red: 0.85, green: 0.95, blue: 0.85 } } }, fields: "userEnteredFormat(textFormat,backgroundColor)" } },
        { updateSheetProperties: { properties: { sheetId: sh.properties.sheetId, gridProperties: { frozenRowCount: 1 } }, fields: "gridProperties.frozenRowCount" } },
        { autoResizeDimensions: { dimensions: { sheetId: sh.properties.sheetId, dimension: "COLUMNS", startIndex: 0, endIndex: TRANSAKSI_HEADERS.length } } },
      ]},
    });
  }
  return { sh, isNew, headerWritten: needHeader };
}

async function catatTransaksi(data) {
  const sheets = await getSheetsClient();
  const spreadsheetId = process.env.SPREADSHEET_ID;
  if (!spreadsheetId) return null;
  await ensureTransaksiSheet(sheets, spreadsheetId);
  const now = new Date();
  const noTrx = `TRX-${now.getTime().toString(36).toUpperCase()}`;
  const row = [
    noTrx,
    now.toLocaleString("id-ID", { timeZone: process.env.TIMEZONE || "Asia/Jakarta" }),
    data.nama || "", data.no_hp || "", data.kelompok || "", data.pinjaman_ke || "1",
    data.angsuran_ke || "", data.nominal || "", data.tanggal_transfer || "", data.waktu_transfer || "",
    data.bank_pengirim || "", data.rekening_pengirim || "", data.bank_penerima || "", data.referensi || "",
    data.status_ai || "", data.klasifikasi || "", data.confidence ?? "", data.sisa_setelah ?? "", data.status || "Berhasil",
  ];
  const res = await sheets.spreadsheets.values.append({
    spreadsheetId, range: `${TRANSAKSI_SHEET}!A:S`, valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [row] },
  });
  // Ambil nomor baris aktual dari updatedRange (mis. Transaksi!A3:S3 -> 3)
  let rowNum = null;
  const range = res?.data?.updates?.updatedRange || "";
  const m = range.match(/!A(\d+):/);
  if (m) rowNum = Number(m[1]);
  return { noTrx, row: rowNum, range };
}

module.exports = { getSheetsClient, getAngsuranData, getAllGroupsData, findMemberByPhone, findMemberByPhoneDetailed, pickInstallmentToConfirm, updateStatus, updateInstallment, updateMemberFields, getTodaySheetName, GROUP_SHEETS, isGroupMode, addDays, digitsOnly, HEADERS_10X, HEADERS_10X_HELP, resolveIdx, isPaid, isBelum, isTerkirim, paidCount, STATUS_BAYAR, STATUS_BELUM, STATUS_TERKIRIM, detectFormulaSep, sisaFormula, formulaSep, clearHeaderCache, catatTransaksi, ensureTransaksiSheet, TRANSAKSI_SHEET, TRANSAKSI_HEADERS };
