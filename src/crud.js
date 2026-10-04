const { getSheetsClient, getAngsuranData, GROUP_SHEETS, digitsOnly, detectFormulaSep, sisaFormula, clearHeaderCache } = require("./sheets");

const HEADERS = ["nama","no_hp","pinjaman","pinjaman_ke","angsuran","tgl_cair","A1","A2","A3","A4","A5","A6","A7","A8","A9","A10","sisa","keterangan"];
const HELP_ROW = ["", "", "(total)", "#", "(per minggu)", "YYYY-MM-DD","minggu 1","minggu 2","minggu 3","minggu 4","minggu 5","minggu 6","minggu 7","minggu 8","minggu 9","minggu 10","otomatis","bebas"];

function colLetter(idx) {
  if (idx < 26) return String.fromCharCode(65 + idx);
  return String.fromCharCode(64 + Math.floor(idx/26)) + String.fromCharCode(65 + (idx % 26));
}
function capHari(s) {
  if (!s) return null;
  const v = String(s).trim().toLowerCase();
  const map = { senin:"Senin", selasa:"Selasa", rabu:"Rabu", kamis:"Kamis", jumat:"Jumat", sabtu:"Sabtu" };
  if (map[v]) return map[v];
  const c = v.charAt(0).toUpperCase()+v.slice(1).toLowerCase();
  if (GROUP_SHEETS.includes(c)) return c;
  return null;
}
function weekdayFromDate(dateStr) {
  const d = new Date(String(dateStr).trim());
  if (isNaN(d)) return null;
  const name = new Intl.DateTimeFormat("id-ID", { weekday:"long", timeZone: process.env.TIMEZONE||"Asia/Jakarta" }).format(d);
  return name.charAt(0).toUpperCase()+name.slice(1).toLowerCase();
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
  if (rows.length < 1) return { headers: HEADERS, rows, dataStart: 1 };
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

async function upsertMember(opts) {
  await detectFormulaSep();
  const hpRaw = opts.hp;
  if (!hpRaw) throw new Error("hp wajib");
  const targetDigits = digitsOnly(hpRaw);
  if (targetDigits.length < 9) throw new Error(`hp tidak valid: ${hpRaw}`);
  const nama = opts.nama ?? null;
  const pinjaman = opts.pinjaman ?? null;
  const pinjamanKeRaw = opts.pinjaman_ke ?? null;
  const pinjamanKe = pinjamanKeRaw !== null && pinjamanKeRaw !== undefined ? String(pinjamanKeRaw).trim() : null;
  const angsuran = opts.angsuran ?? null;
  const tglCair = opts.tgl_cair ?? null;
  const keterangan = opts.keterangan ?? null;
  const angsuranKeRaw = opts.angsuran_ke ?? null;
  const angsuranKe = angsuranKeRaw !== null && angsuranKeRaw !== undefined ? Number(String(angsuranKeRaw).trim()) : null;
  const status = opts.status !== undefined && opts.status !== null ? String(opts.status).trim() : null;
  const hariRaw = opts.hari ?? null;
  const mode = opts.mode || "upsert";

  const wantPinjamanKe = pinjamanKe !== null ? String(pinjamanKe) : "1";
  if (angsuranKe !== null && (angsuranKe < 1 || angsuranKe > 10 || !Number.isInteger(angsuranKe))) throw new Error("angsuran_ke harus 1..10");
  if (status !== null && status !== "" && !["sudah dibayar","terkirim","belum dibayar"].includes(status.toLowerCase())) throw new Error('status harus Sudah dibayar / Terkirim / Belum dibayar');

  const sheets = await getSheetsClient();
  const spreadsheetId = process.env.SPREADSHEET_ID;
  if (!spreadsheetId) throw new Error("SPREADSHEET_ID belum diisi");

  let sheetName = hariRaw ? capHari(hariRaw) : null;
  if (hariRaw && !sheetName) throw new Error(`hari tidak dikenal: ${hariRaw}`);
  if (!sheetName && tglCair) {
    const wd = weekdayFromDate(tglCair);
    if (wd && GROUP_SHEETS.includes(wd)) sheetName = wd;
  }

  let existingHits = [];
  if (!sheetName) {
    for (const sh of GROUP_SHEETS) {
      const { rows, dataStart } = await findRows(sheets, spreadsheetId, sh);
      const hits = findMemberInRows(rows, dataStart, targetDigits, wantPinjamanKe);
      if (hits.length) { existingHits = hits; sheetName = sh; break; }
    }
    if (!sheetName) {
      for (const sh of GROUP_SHEETS) {
        const { rows, dataStart } = await findRows(sheets, spreadsheetId, sh);
        const hitsAny = findMemberInRows(rows, dataStart, targetDigits, null);
        if (hitsAny.length) { sheetName = sh; existingHits = hitsAny; break; }
      }
    }
    if (!sheetName) throw new Error("Untuk anggota baru wajib hari atau tgl_cair (tentukan sheet Senin-Sabtu)");
  } else {
    const { rows, dataStart } = await findRows(sheets, spreadsheetId, sheetName);
    existingHits = findMemberInRows(rows, dataStart, targetDigits, wantPinjamanKe);
    if (!existingHits.length && pinjamanKe === null) {
      const hitsAny = findMemberInRows(rows, dataStart, targetDigits, null);
      if (hitsAny.length === 1) existingHits = hitsAny;
      else if (hitsAny.length > 1) throw new Error(`HP ${hpRaw} punya ${hitsAny.length} pinjaman di ${sheetName} (ke: ${hitsAny.map(h=>h.pinjaman_ke).join(",")}). Wajib pinjaman_ke`);
    }
  }

  await ensureHeader(sheets, spreadsheetId, sheetName);
  const { rows } = await findRows(sheets, spreadsheetId, sheetName);

  if (mode === "add" && existingHits.length) throw new Error(`Sudah ada hp=${hpRaw} ke=${wantPinjamanKe} di ${sheetName}`);
  if (mode === "update" && !existingHits.length) throw new Error(`Tidak ditemukan hp=${hpRaw} ke=${wantPinjamanKe} di ${sheetName}`);
  if (mode === "set" && !existingHits.length) throw new Error(`Tidak ditemukan hp=${hpRaw} ke=${wantPinjamanKe} untuk set A${angsuranKe}`);
  if (mode === "set" && angsuranKe === null) throw new Error("set wajib angsuran_ke dan status");

  const curHeaders = (await sheets.spreadsheets.values.get({ spreadsheetId, range:`${sheetName}!A1:R1` })).data.values?.[0]||HEADERS;
  const idx={}; curHeaders.forEach((h,i)=> idx[String(h).trim().toLowerCase()]=i);
  const col = (h)=> idx[h];
  clearHeaderCache(sheetName);

  if (existingHits.length) {
    const hit = existingHits[0];
    const rowIndex = hit.rowIndex;

    if (hariRaw && capHari(hariRaw) && capHari(hariRaw) !== sheetName) {
    }

    const fields={};
    if (nama !== null) fields.nama = nama;
    if (pinjaman !== null) fields.pinjaman = String(pinjaman).replace(/[^0-9]/g,"");
    if (pinjamanKe !== null) fields.pinjaman_ke = String(pinjamanKe);
    if (angsuran !== null) fields.angsuran = String(angsuran).replace(/[^0-9]/g,"");
    if (tglCair !== null) fields.tgl_cair = String(tglCair).trim();
    if (keterangan !== null) fields.keterangan = keterangan;

    for (const [k,v] of Object.entries(fields)) {
      const c = col(k);
      if (c===undefined) throw new Error(`Header ${k} tidak ada`);
      await sheets.spreadsheets.values.update({ spreadsheetId, range:`${sheetName}!${colLetter(c)}${rowIndex}`, valueInputOption:"RAW", requestBody:{values:[[String(v)]]}});
    }
    if (angsuranKe !== null) {
      const c = col(`a${angsuranKe}`);
      const low = String(status || "").toLowerCase();
      const val = status === null ? "" : low==="sudah dibayar" || low==="sudahdibayar" || low==="lunas" ? "Sudah dibayar" : low==="terkirim" ? "Terkirim" : low==="belum dibayar" || low==="belum" ? "Belum dibayar" : "";
      await sheets.spreadsheets.values.update({ spreadsheetId, range:`${sheetName}!${colLetter(c)}${rowIndex}`, valueInputOption:"RAW", requestBody:{values:[[val]]}});
    }

    if (hariRaw) {
      const targetHari = capHari(hariRaw);
      if (targetHari && targetHari !== sheetName) {
        const currentData = await sheets.spreadsheets.values.get({ spreadsheetId, range:`${sheetName}!A${rowIndex}:R${rowIndex}` });
        const rowVals = currentData.data.values?.[0] || [];
        await ensureHeader(sheets, spreadsheetId, targetHari);
        const targetRows = (await sheets.spreadsheets.values.get({ spreadsheetId, range:`${targetHari}!A:Z` })).data.values||[];
        const appendAt = targetRows.length + 1;
        const newRow = [];
        for (let i=0;i<HEADERS.length;i++) newRow[i] = rowVals[i] || "";
        newRow[col("sisa")] = "";
        await sheets.spreadsheets.values.update({ spreadsheetId, range:`${targetHari}!A${appendAt}:R${appendAt}`, valueInputOption:"RAW", requestBody:{values:[[newRow.map(v=> String(v).startsWith("=")?"":v)]]}});
        await sheets.spreadsheets.values.update({ spreadsheetId, range:`${targetHari}!Q${appendAt}`, valueInputOption:"USER_ENTERED", requestBody:{values:[[ sisaFormula(appendAt) ]]}});
        const meta = await sheets.spreadsheets.get({ spreadsheetId });
        const shMeta = meta.data.sheets.find(s=>s.properties.title===sheetName);
        await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody:{requests:[{ deleteDimension:{ range:{ sheetId: shMeta.properties.sheetId, dimension:"ROWS", startIndex: rowIndex-1, endIndex: rowIndex } }}]}});
        const moved = await getAngsuranData(targetHari);
        const m = moved.find(x=> digitsOnly(x.no_hp)===targetDigits && String(x.pinjaman_ke)===wantPinjamanKe);
        return { action:"moved", sheetName: targetHari, rowIndex: appendAt, member: m, spreadsheetId };
      }
    }

    const after = await getAngsuranData(sheetName);
    const m = after.find(x=> x.rowIndex===rowIndex);
    return { action:"updated", sheetName, rowIndex, member: m, spreadsheetId };
  } else {
    if (!tglCair) throw new Error("Anggota baru wajib tgl_cair YYYY-MM-DD");
    const pk = wantPinjamanKe;
    const newRow = [];
    const clean = (v)=> v===null||v===undefined ? "" : String(v);
    newRow[col("nama")] = clean(nama);
    newRow[col("no_hp")] = clean(hpRaw);
    newRow[col("pinjaman")] = clean(pinjaman ? String(pinjaman).replace(/[^0-9]/g,"") : "");
    newRow[col("pinjaman_ke")] = clean(pk);
    newRow[col("angsuran")] = clean(angsuran ? String(angsuran).replace(/[^0-9]/g,"") : "");
    newRow[col("tgl_cair")] = clean(tglCair);
    for (let n=1;n<=10;n++) {
      const lowSt = String(status || "").toLowerCase();
      const mapped = (angsuranKe===n && status!==null) ? (lowSt==="sudah dibayar"||lowSt==="sudahdibayar"||lowSt==="lunas" ? "Sudah dibayar" : lowSt==="terkirim" ? "Terkirim" : (lowSt==="belum dibayar"||lowSt==="belum") ? "Belum dibayar" : "") : "";
      newRow[col(`a${n}`)] = mapped;
    }
    newRow[col("sisa")] = sisaFormula(rows.length + 1);
    newRow[col("keterangan")] = clean(keterangan);
    while (newRow.length < HEADERS.length) newRow.push("");
    const appendAt = rows.length + 1;
    if (rows.length < 2) {
      await sheets.spreadsheets.values.update({ spreadsheetId, range:`${sheetName}!A1:R2`, valueInputOption:"RAW", requestBody:{values:[HEADERS, HELP_ROW]}});
      await sheets.spreadsheets.values.update({ spreadsheetId, range:`${sheetName}!A3:R3`, valueInputOption:"RAW", requestBody:{values:[[newRow.map(v=> String(v).startsWith("=")?"":v)]]}});
      await sheets.spreadsheets.values.update({ spreadsheetId, range:`${sheetName}!Q3`, valueInputOption:"USER_ENTERED", requestBody:{values:[[newRow[col("sisa")]]]}});
      const m = (await getAngsuranData(sheetName)).find(x=> x.rowIndex===3);
      return { action:"added", sheetName, rowIndex:3, member:m, spreadsheetId };
    } else {
      const vals = newRow.map(v=> String(v).startsWith("=")?"":v);
      await sheets.spreadsheets.values.update({ spreadsheetId, range:`${sheetName}!A${appendAt}:R${appendAt}`, valueInputOption:"RAW", requestBody:{values:[vals]}});
      await sheets.spreadsheets.values.update({ spreadsheetId, range:`${sheetName}!Q${appendAt}`, valueInputOption:"USER_ENTERED", requestBody:{values:[[newRow[col("sisa")]]]}});
      const m = (await getAngsuranData(sheetName)).find(x=> x.rowIndex===appendAt);
      return { action:"added", sheetName, rowIndex:appendAt, member:m, spreadsheetId };
    }
  }
}

async function listMembers(opts={}) {
  const hari = opts.hari ? capHari(opts.hari) : null;
  const hp = opts.hp ? digitsOnly(opts.hp) : null;
  const sheetsToScan = hari ? [hari] : GROUP_SHEETS;
  const out=[];
  for (const sh of sheetsToScan) {
    const data = await getAngsuranData(sh).catch(e=> ({ error:e.message }));
    if (Array.isArray(data)) {
      let rows=data;
      if (hp) rows=rows.filter(r=> digitsOnly(r.no_hp)===hp);
      out.push({ sheet: sh, rows });
    } else out.push({ sheet: sh, error: data.error });
  }
  return out;
}

async function removeMember(opts) {
  const hpRaw = opts.hp;
  if (!hpRaw) throw new Error("hp wajib");
  const targetDigits = digitsOnly(hpRaw);
  const pinjamanKe = opts.pinjaman_ke ? String(opts.pinjaman_ke).trim() : null;
  const hari = opts.hari ? capHari(opts.hari) : null;
  const sheets = await getSheetsClient();
  const spreadsheetId = process.env.SPREADSHEET_ID;
  const searchSheets = hari ? [hari] : GROUP_SHEETS;
  let found=null, foundSheet=null;
  for (const sh of searchSheets) {
    const { rows, dataStart } = await findRows(sheets, spreadsheetId, sh);
    const hits = findMemberInRows(rows, dataStart, targetDigits, pinjamanKe);
    if (hits.length===1) { found=hits[0]; foundSheet=sh; break; }
    if (hits.length>1) throw new Error(`Ditemukan ${hits.length} baris di ${sh} untuk hp=${hpRaw} ke=${pinjamanKe||"(any)"} — pakai pinjaman_ke & hari`);
    if (!hits.length && pinjamanKe===null) {
      const anyHits = findMemberInRows(rows, dataStart, targetDigits, null);
      if (anyHits.length===1) { found=anyHits[0]; foundSheet=sh; break; }
    }
  }
  if (!found) throw new Error(`Tidak ditemukan hp=${hpRaw} ${pinjamanKe?`ke=${pinjamanKe}`:""} ${hari?`di ${hari}`:""}`);
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const shMeta = meta.data.sheets.find(s=>s.properties.title===foundSheet);
  await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody:{requests:[{ deleteDimension:{ range:{ sheetId: shMeta.properties.sheetId, dimension:"ROWS", startIndex: found.rowIndex-1, endIndex: found.rowIndex } }}]}});
  return { sheetName: foundSheet, rowIndex: found.rowIndex, row: found.row };
}

module.exports = { upsertMember, listMembers, removeMember, capHari, colLetter, HEADERS, HELP_ROW, findRows, findMemberInRows };
