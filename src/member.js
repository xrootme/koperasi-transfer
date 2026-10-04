#!/usr/bin/env node
require("dotenv").config();
const { getSheetsClient, getAngsuranData, GROUP_SHEETS, digitsOnly, addDays, detectFormulaSep, sisaFormula } = require("./sheets");

const HEADERS = ["nama","no_hp","pinjaman","pinjaman_ke","angsuran","tgl_cair","A1","A2","A3","A4","A5","A6","A7","A8","A9","A10","sisa","keterangan"];
const HELP_ROW = ["", "", "(total)", "#", "(per minggu)", "YYYY-MM-DD","minggu 1","minggu 2","minggu 3","minggu 4","minggu 5","minggu 6","minggu 7","minggu 8","minggu 9","minggu 10","otomatis","bebas"];

function colLetter(idx) {
  if (idx < 26) return String.fromCharCode(65 + idx);
  return String.fromCharCode(64 + Math.floor(idx/26)) + String.fromCharCode(65 + (idx % 26));
}
function capHari(s) {
  if (!s) return null;
  const v = String(s).trim().toLowerCase();
  const map = { senin:"Senin", selasa:"Selasa", rabu:"Rabu", kamis:"Kamis", jumat:"Jumat", jumat:"Jumat", sabtu:"Sabtu", minggu:"Minggu" };
  if (map[v]) return map[v];
  const c = v.charAt(0).toUpperCase()+v.slice(1);
  if (GROUP_SHEETS.includes(c)) return c;
  return null;
}
function weekdayFromDate(dateStr) {
  const d = new Date(String(dateStr).trim());
  if (isNaN(d)) return null;
  const name = new Intl.DateTimeFormat("id-ID", { weekday:"long", timeZone: process.env.TIMEZONE||"Asia/Jakarta" }).format(d);
  return name.charAt(0).toUpperCase()+name.slice(1).toLowerCase();
}
function parseArgs(argv) {
  const out = { _:[] };
  let k=null;
  for (const a of argv) {
    if (a==="--help"||a==="-h") out.help=true;
    else if (a.startsWith("--")) { k=a.replace(/^--/,"").replace(/-/g,"_"); out[k]=true; }
    else if (k && out[k]===true) { out[k]=a; k=null; }
    else if (k) { out[k]=a; k=null; }
    else out._.push(a);
  }
  for (const key of Object.keys(out)) if (out[key]===true) out[key]=null;
  return out;
}
function printHelp() {
  console.log(`
member — kelola anggota koperasi 10x mingguan (sheet Senin-Sabtu)

Header 18 kolom: nama | no_hp | pinjaman | pinjaman_ke | angsuran | tgl_cair | A1..A10 | sisa | keterangan
Kunci: no_hp + pinjaman_ke  (pinjaman_ke = siklus pinjaman ke-1,2,3...). tgl_cair = tanggal pencairan (YYYY-MM-DD), angsuran = per minggu.

COMMANDS
  upsert   tambah baru atau update yang sudah ada (by hp + pinjaman_ke)
  add      paksa tambah baris baru (error jika sudah ada hp+pinjaman_ke)
  update   hanya update yang sudah ada
  set      set status angsuran A1..A10 saja
  list     lihat anggota
  remove   hapus baris (by hp + pinjaman_ke)

CONTOH
  # tambah anggota baru Cicilan Senin, cair 2026-10-06, pinjaman 5jt, angsuran 500rb
  npm run member -- upsert --hp 081234567890 --nama "Budi Santoso" --hari Senin --tgl-cair 2026-10-06 --pinjaman 5000000 --pinjaman-ke 1 --angsuran 500000

  # update nama / pinjaman / tgl cair anggota yg sama (by hp + pinjaman_ke)
  npm run member -- upsert --hp 081234567890 --pinjaman-ke 1 --nama "Budi S." --pinjaman 6000000 --tgl-cair 2026-10-13

  # tandai angsuran ke-2 sudah Lunas (juga bisa pakai --status Terkirim/Belum)
  npm run member -- upsert --hp 081234567890 --pinjaman-ke 1 --angsuran-ke 2 --status Lunas
  npm run member -- set --hp 081234567890 --pinjaman-ke 1 --angsuran-ke 3 --status Lunas

  # pinjaman kedua untuk hp yg sama (siklus baru, reset A1..A10)
  npm run member -- upsert --hp 081234567890 --pinjaman-ke 2 --tgl-cair 2026-12-01 --pinjaman 7000000 --angsuran 700000

  # list
  npm run member -- list --hp 081234567890
  npm run member -- list --hari Senin
  npm run member -- list

  # hapus
  npm run member -- remove --hp 081234567890 --pinjaman-ke 2

OPS I
  --hp           nomor HP (wajib untuk upsert/update/set/remove)  08... / 62...
  --nama         nama anggota
  --hari         Senin/Selasa/Rabu/Kamis/Jumat/Sabtu (jika tidak diisi: ikut member lama atau dari tgl_cair)
  --tgl-cair     YYYY-MM-DD  (alias --tgl-mulai)
  --pinjaman     besar pinjaman total (angka)
  --pinjaman-ke  siklus pinjaman ke berapa (default 1)
  --angsuran     nominal angsuran per minggu (angka)  (alias --nominal)
  --angsuran-ke  1..10
  --status       Lunas / Terkirim / Belum / ""  (untuk A_n)
  --keterangan   teks bebas
  --hari         untuk list: filter hari; tanpa filter = semua grup

Setup awal: npm run setup:groups
`);
}

async function ensureHeader(sheets, spreadsheetId, sheetName) {
  const cur = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${sheetName}!A1:R1` });
  const hdr = (cur.data.values?.[0]||[]).map(v=>String(v||"").trim().toLowerCase());
  const need = HEADERS.some((h,i)=> hdr[i]!==h) || hdr.length !== HEADERS.length;
  if (need) {
    await sheets.spreadsheets.values.update({ spreadsheetId, range:`${sheetName}!A1:R1`, valueInputOption:"RAW", requestBody:{values:[HEADERS]}});
    await sheets.spreadsheets.values.update({ spreadsheetId, range:`${sheetName}!A2:R2`, valueInputOption:"RAW", requestBody:{values:[HELP_ROW]}});
  }
}

async function findRows(sheets, spreadsheetId, sheetName) {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range:`${sheetName}!A:Z` });
  const rows = res.data.values||[];
  if (rows.length < 1) return { headers: HEADERS, rows: [], dataStart: 1, rawRows: rows };
  const headers = (rows[0]||[]).map(v=>String(v).trim().toLowerCase());
  const is10x = headers.includes("a1");
  let dataStart = 1;
  if (is10x && rows.length>=2) {
    const second=(rows[1]||[]).map(v=>String(v).trim().toLowerCase());
    if (second.includes("minggu 1") || second[5]==="minggu 1" || second.includes("yyyy-mm-dd") || second.includes("(per minggu)")) dataStart=2;
  }
  return { headers, rows, dataStart };
}

function findMemberInRows(rows, dataStart, targetDigits, pinjamanKe) {
  const hits=[];
  for (let i=dataStart; i<rows.length; i++) {
    const r=rows[i]||[];
    if (!r[0] && !r[1]) continue;
    if (String(r[0]||"").toLowerCase().startsWith("petunjuk")) continue;
    const hp = digitsOnly(r[1]||"");
    if (hp !== targetDigits) continue;
    const pk = String(r[3]||"1").trim() || "1";
    if (pinjamanKe !== null && pinjamanKe !== undefined && String(pinjamanKe)!==pk) continue;
    hits.push({ rowIndex: i+1, row: r, pinjaman_ke: pk });
  }
  return hits;
}

async function cmdUpsert(args, mode) {
  const hpRaw = args.hp || args.no_hp || args.phone;
  if (!hpRaw) throw new Error("--hp wajib (contoh: --hp 081234567890)");
  const targetDigits = digitsOnly(hpRaw);
  if (targetDigits.length < 9) throw new Error(`--hp tidak valid: ${hpRaw}`);
  const nama = args.nama || null;
  const pinjaman = args.pinjaman || args.plafon || null;
  const pinjamanKeRaw = args.pinjaman_ke || args.pinjaman_ke_1 || null;
  const pinjamanKe = pinjamanKeRaw !== null && pinjamanKeRaw !== undefined ? String(pinjamanKeRaw).trim() : null;
  const angsuran = args.angsuran || args.nominal || args.cicilan || null;
  const tglCair = args.tgl_cair || args.tgl_mulai || args.tgl || null;
  const keterangan = args.keterangan || null;
  const angsuranKeRaw = args.angsuran_ke || args.angsuran_ke_1 || args.a || null;
  const angsuranKe = angsuranKeRaw !== null ? Number(String(angsuranKeRaw).trim()) : null;
  const status = args.status !== undefined && args.status !== null ? String(args.status).trim() : null;
  const hariRaw = args.hari || null;

  const wantPinjamanKe = pinjamanKe !== null ? String(pinjamanKe) : "1";

  if (angsuranKe !== null && (angsuranKe < 1 || angsuranKe > 10 || !Number.isInteger(angsuranKe))) throw new Error("--angsuran-ke harus 1..10");
  if (status !== null && !["lunas","sudah dibayar","terkirim","belum","belum dibayar",""].includes(status.toLowerCase())) throw new Error('--status harus Lunas / Sudah dibayar / Terkirim / Belum / ""');

  const sheets = await (await require("./sheets").getSheetsClient());
  const spreadsheetId = process.env.SPREADSHEET_ID;
  if (!spreadsheetId) throw new Error("SPREADSHEET_ID belum diisi di .env");
  await detectFormulaSep();

  let sheetName = hariRaw ? capHari(hariRaw) : null;
  if (hariRaw && !sheetName) throw new Error(`--hari tidak dikenal: ${hariRaw} (Senin..Sabtu)`);
  if (!sheetName && tglCair) {
    const wd = weekdayFromDate(tglCair);
    if (wd && GROUP_SHEETS.includes(wd)) sheetName = wd;
  }

  let existingHits = [];
  let existingSheetForHp = null;
  if (!sheetName) {
    for (const sh of GROUP_SHEETS) {
      const { rows, dataStart } = await findRows(sheets, spreadsheetId, sh);
      const hits = findMemberInRows(rows, dataStart, targetDigits, wantPinjamanKe);
      if (hits.length) { existingSheetForHp = sh; existingHits = hits; sheetName = sh; break; }
    }
    if (!sheetName) {
      for (const sh of GROUP_SHEETS) {
        const { rows, dataStart } = await findRows(sheets, spreadsheetId, sh);
        const hitsAny = findMemberInRows(rows, dataStart, targetDigits, null);
        if (hitsAny.length) { existingSheetForHp = sh; sheetName = sh; existingHits = hitsAny; break; }
      }
    }
    if (!sheetName) throw new Error("Untuk anggota baru, wajib --hari atau --tgl-cair (untuk tentukan sheet Senin..Sabtu)");
  } else {
    const { rows, dataStart } = await findRows(sheets, spreadsheetId, sheetName);
    existingHits = findMemberInRows(rows, dataStart, targetDigits, wantPinjamanKe);
    if (!existingHits.length && pinjamanKe === null) {
      const hitsAny = findMemberInRows(rows, dataStart, targetDigits, null);
      if (hitsAny.length === 1) existingHits = hitsAny;
      else if (hitsAny.length > 1) {
        throw new Error(`HP ${hpRaw} punya ${hitsAny.length} pinjaman di ${sheetName} (pinjaman_ke: ${hitsAny.map(h=>h.pinjaman_ke).join(",")}). Wajib --pinjaman-ke untuk pilih.`);
      }
    }
  }

  await ensureHeader(sheets, spreadsheetId, sheetName);
  const { rows, dataStart } = await findRows(sheets, spreadsheetId, sheetName);
  let headerRow = (rows[0]||[]).map(v=>String(v).trim().toLowerCase());
  if (headerRow.length < HEADERS.length) await ensureHeader(sheets, spreadsheetId, sheetName);

  if (mode === "add" && existingHits.length) throw new Error(`Sudah ada ${existingHits.length} baris hp=${hpRaw} pinjaman_ke=${wantPinjamanKe} di ${sheetName} — pakai upsert/update`);
  if (mode === "update" && !existingHits.length) throw new Error(`Tidak ditemukan hp=${hpRaw} pinjaman_ke=${wantPinjamanKe} di ${sheetName}`);
  if (mode === "set" && !existingHits.length) throw new Error(`Tidak ditemukan hp=${hpRaw} pinjaman_ke=${wantPinjamanKe} di ${sheetName} untuk set A${angsuranKe}`);
  if (mode === "set" && angsuranKe === null) throw new Error("mode set wajib --angsuran-ke 1..10 dan --status");

  const idx = {};
  const curHeaders = (await sheets.spreadsheets.values.get({ spreadsheetId, range:`${sheetName}!A1:R1` })).data.values?.[0]||HEADERS;
  curHeaders.forEach((h,i)=> idx[String(h).trim().toLowerCase()]=i);

  function col(h) { return idx[h]; }

  if (existingHits.length) {
    const hit = existingHits[0];
    const rowIndex = hit.rowIndex;
    const fields = {};
    if (nama !== null) fields.nama = nama;
    if (pinjaman !== null) fields.pinjaman = String(pinjaman).replace(/[^0-9]/g,"");
    if (pinjamanKe !== null) fields.pinjaman_ke = String(pinjamanKe);
    if (angsuran !== null) fields.angsuran = String(angsuran).replace(/[^0-9]/g,"");
    if (tglCair !== null) fields.tgl_cair = String(tglCair).trim();
    if (keterangan !== null) fields.keterangan = keterangan;

    if (Object.keys(fields).length) {
      console.log(`Update ${sheetName}!${rowIndex} hp=${hpRaw} pinjaman_ke=${hit.pinjaman_ke} ->`, fields);
      for (const [k,v] of Object.entries(fields)) {
        let hdr = k;
        if (k==="tgl_cair") hdr="tgl_cair";
        const c = col(hdr);
        if (c===undefined) throw new Error(`Header ${hdr} tidak ditemukan`);
        await sheets.spreadsheets.values.update({ spreadsheetId, range:`${sheetName}!${colLetter(c)}${rowIndex}`, valueInputOption:"RAW", requestBody:{values:[[String(v)]]}});
      }
    } else {
      console.log(`Tidak ada field scalar diupdate untuk ${hit.rowIndex}`);
    }

    if (angsuranKe !== null) {
      const c = col(`a${angsuranKe}`);
      if (c===undefined) throw new Error(`Kolom A${angsuranKe} tidak ada`);
      const val = status !== null ? (status.toLowerCase()==="lunas"||status.toLowerCase()==="sudah dibayar" ? "Lunas" : status.toLowerCase()==="terkirim" ? "Terkirim" : status.toLowerCase()==="belum"||status.toLowerCase()==="belum dibayar" ? "Belum" : "") : "";
      console.log(`Set ${sheetName}!${colLetter(c)}${rowIndex} (A${angsuranKe}) = "${val}"`);
      await sheets.spreadsheets.values.update({ spreadsheetId, range:`${sheetName}!${colLetter(c)}${rowIndex}`, valueInputOption:"RAW", requestBody:{values:[[val]]}});
    }
    const after = await getAngsuranData(sheetName);
    const m = after.find(x=> x.rowIndex===rowIndex);
    if (m) console.log(`OK -> ${m.nama} | ${m.no_hp} | pinjaman ${m.pinjaman} ke-${m.pinjaman_ke} | tgl_cair ${m.tgl_cair} | angsuran ${m.angsuran} | A=${m.installments.map(x=>x.status||"-").join("|")} sisa=${m.sisa}`);
    console.log(`https://docs.google.com/spreadsheets/d/${spreadsheetId}`);
    return;
  } else {
    if (!tglCair) throw new Error("Anggota baru wajib --tgl-cair YYYY-MM-DD");
    if (!pinjaman) console.log("WARN: --pinjaman tidak diisi");
    if (!angsuran) console.log("WARN: --angsuran tidak diisi");
    const clean = (v)=> v===null||v===undefined ? "" : String(v);
    const pk = wantPinjamanKe;
    const newRow = [];
    newRow[col("nama")] = clean(nama);
    newRow[col("no_hp")] = clean(hpRaw);
    newRow[col("pinjaman")] = clean(pinjaman ? String(pinjaman).replace(/[^0-9]/g,"") : "");
    newRow[col("pinjaman_ke")] = clean(pk);
    newRow[col("angsuran")] = clean(angsuran ? String(angsuran).replace(/[^0-9]/g,"") : "");
    newRow[col("tgl_cair")] = clean(tglCair);
    for (let n=1;n<=10;n++) newRow[col(`a${n}`)] = (angsuranKe===n && status!==null) ? (status.toLowerCase()==="lunas"||status.toLowerCase()==="sudah dibayar"?"Lunas":status.toLowerCase()==="terkirim"?"Terkirim":status.toLowerCase()==="belum"||status.toLowerCase()==="belum dibayar"?"Belum":"") : "";
    newRow[col("sisa")] = sisaFormula(rows.length + 1);
    newRow[col("keterangan")] = clean(keterangan);
    while (newRow.length < HEADERS.length) newRow.push("");
    const appendAt = rows.length + 1;
    const isHelp = (rows[1]||[]).join("").toLowerCase().includes("minggu 1");
    const targetRow = rows.length === 0 ? 1 : (rows.length < 3 && !isHelp ? 3 : appendAt);
    if (rows.length < 2) {
      await sheets.spreadsheets.values.update({ spreadsheetId, range:`${sheetName}!A1:R2`, valueInputOption:"RAW", requestBody:{values:[HEADERS, HELP_ROW]}});
      const r = [newRow];
      await sheets.spreadsheets.values.update({ spreadsheetId, range:`${sheetName}!A3:R3`, valueInputOption:"RAW", requestBody:{values:[r.map(v=> String(v).startsWith("=") ? "" : v)]}});
      await sheets.spreadsheets.values.update({ spreadsheetId, range:`${sheetName}!Q3`, valueInputOption:"USER_ENTERED", requestBody:{values:[[newRow[col("sisa")]]]}});
      console.log(`Tambah baru ${sheetName}!3 hp=${hpRaw} pinjaman_ke=${pk}`);
    } else {
      const vals = newRow.map(v=> String(v).startsWith("=") ? "" : v);
      await sheets.spreadsheets.values.update({ spreadsheetId, range:`${sheetName}!A${appendAt}:R${appendAt}`, valueInputOption:"RAW", requestBody:{values:[vals]}});
      await sheets.spreadsheets.values.update({ spreadsheetId, range:`${sheetName}!Q${appendAt}`, valueInputOption:"USER_ENTERED", requestBody:{values:[[newRow[col("sisa")]]]}});
      console.log(`Tambah baru ${sheetName}!${appendAt} hp=${hpRaw} pinjaman_ke=${pk}`);
    }
    console.log(`https://docs.google.com/spreadsheets/d/${spreadsheetId} -> ${sheetName}`);
    return;
  }
}

async function cmdList(args) {
  const hp = args.hp || args.no_hp || null;
  const hari = args.hari ? capHari(args.hari) : null;
  const sheetsToScan = hari ? [hari] : GROUP_SHEETS;
  const targetDigits = hp ? digitsOnly(hp) : null;
  for (const sh of sheetsToScan) {
    const data = await getAngsuranData(sh).catch(e=> ({ error:e.message }));
    if (Array.isArray(data)) {
      let rows = data;
      if (targetDigits) rows = rows.filter(r=> digitsOnly(r.no_hp)===targetDigits);
      if (!rows.length) { if (targetDigits) continue; console.log(`${sh}: (kosong)`); continue; }
      console.log(`\n== ${sh} (${rows.length} anggota) ==`);
      for (const r of rows) {
        const aStr = r.installments ? r.installments.map(x=> x.status ? `${x.n}:${x.status}` : `${x.n}:-`).join(" ") : "";
        console.log(`  #${r.rowIndex} ${r.nama} | ${r.no_hp} | pinj ${r.pinjaman||"-"} ke-${r.pinjaman_ke||1} | cair ${r.tgl_cair||"-"} | angs ${r.angsuran||"-"} | A: ${aStr} | sisa ${r.sisa} | ${r.keterangan||""}`);
      }
    } else {
      console.log(`${sh}: error ${data.error}`);
    }
  }
}

async function cmdRemove(args) {
  const hpRaw = args.hp || args.no_hp;
  if (!hpRaw) throw new Error("--hp wajib");
  const targetDigits = digitsOnly(hpRaw);
  const pinjamanKe = args.pinjaman_ke ? String(args.pinjaman_ke).trim() : null;
  const hari = args.hari ? capHari(args.hari) : null;
  const sheets = await (await require("./sheets").getSheetsClient());
  const spreadsheetId = process.env.SPREADSHEET_ID;
  const searchSheets = hari ? [hari] : GROUP_SHEETS;
  let found=null, foundSheet=null;
  for (const sh of searchSheets) {
    const { rows, dataStart } = await findRows(sheets, spreadsheetId, sh);
    const hits = findMemberInRows(rows, dataStart, targetDigits, pinjamanKe);
    if (hits.length===1) { found=hits[0]; foundSheet=sh; break; }
    if (hits.length>1) throw new Error(`Ditemukan ${hits.length} baris di ${sh} untuk hp=${hpRaw} pinjaman_ke=${pinjamanKe||"(any)"} — pakai --pinjaman-ke dan --hari untuk spesifik`);
    if (hits.length===0 && pinjamanKe===null) {
      const anyHits = findMemberInRows(rows, dataStart, targetDigits, null);
      if (anyHits.length===1) { found=anyHits[0]; foundSheet=sh; break; }
      if (anyHits.length>1) continue;
    }
  }
  if (!found) throw new Error(`Tidak ditemukan hp=${hpRaw} ${pinjamanKe?`pinjaman_ke=${pinjamanKe}`:""} ${hari?`di ${hari}`:""}`);
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const shMeta = meta.data.sheets.find(s=>s.properties.title===foundSheet);
  const sheetId = shMeta.properties.sheetId;
  console.log(`Hapus ${foundSheet}!${found.rowIndex} ${found.row[0]} | ${found.row[1]} | pinjaman_ke=${found.pinjaman_ke} ...`);
  await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody:{requests:[{ deleteDimension:{ range:{ sheetId, dimension:"ROWS", startIndex: found.rowIndex-1, endIndex: found.rowIndex } }}]}});
  console.log("OK terhapus");
}

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.length) { printHelp(); process.exit(0); }
  const args = parseArgs(argv);
  const cmd = (args._[0]||"").toLowerCase();
  if (args.help || cmd==="help" || cmd==="--help") { printHelp(); process.exit(0); }
  try {
    if (["upsert","add","update","set"].includes(cmd)) await cmdUpsert(args, cmd);
    else if (cmd==="list"||cmd==="ls") await cmdList(args);
    else if (cmd==="remove"||cmd==="delete"||cmd==="rm") await cmdRemove(args);
    else { console.error(`Command tidak dikenal: ${cmd}`); printHelp(); process.exit(1); }
  } catch(e) {
    console.error("ERROR:", e.message);
    if (e.response) console.error(JSON.stringify(e.response.data||e.response).slice(0,1200));
    process.exit(1);
  }
}

main();
