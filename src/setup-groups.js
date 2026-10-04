require("dotenv").config();
const { google } = require("googleapis");
const path = require("path");
const { detectFormulaSep, sisaFormula } = require("./sheets");

const CREDENTIALS_PATH = path.join(__dirname, "..", "credentials.json");

// Validasi tanggal sungguhan: tolak 31 Feb, 45 Okt, dll.
function validIso(y, m, d) {
  const yy = Number(y), mm = Number(m), dd = Number(d);
  if (!yy || !mm || !dd) return null;
  const year = yy < 100 ? 2000 + yy : yy;
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  const dt = new Date(year, mm - 1, dd);
  if (isNaN(dt) || dt.getFullYear() !== year || dt.getMonth() !== mm - 1 || dt.getDate() !== dd) return null;
  return `${year}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
}
function normalizeTgl(v) {
  const s = String(v || "").trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return validIso(m[1], m[2], m[3]);
  m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (m) return validIso(m[3], m[2], m[1]);
  return null;
}
async function repairTglCair(sheets, spreadsheetId, sheetName) {
  const v = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${sheetName}!A:F` });
  const rows = v.data.values || [];
  let fixed = 0, bad = 0;
  for (let i = 2; i < rows.length; i++) {
    const row = rows[i] || [];
    const nama = String(row[0] || "").trim();
    if (!nama || nama.toLowerCase().startsWith("petunjuk")) continue;
    const cur = String(row[5] || "").trim();
    const norm = normalizeTgl(cur);
    if (!norm) {
      if (cur) { console.log(`  ! tgl_cair tidak valid ${sheetName}!F${i + 1} ${nama} = "${cur}" (perlu isi manual)`); bad++; }
      continue;
    }
    if (norm !== cur) {
      console.log(`  -> perbaiki tgl_cair ${sheetName}!F${i + 1} ${nama}: "${cur}" -> "${norm}"`);
      await sheets.spreadsheets.values.update({ spreadsheetId, range: `${sheetName}!F${i + 1}`, valueInputOption: "RAW", requestBody: { values: [[norm]] } });
      fixed++;
    }
  }
  return { fixed, bad };
}

const HEADERS = ["nama","no_hp","pinjaman","pinjaman_ke","angsuran","tgl_cair","A1","A2","A3","A4","A5","A6","A7","A8","A9","A10","sisa","keterangan"];
const HELP    = ["",    "",     "(total)","#",     "(per minggu)","YYYY-MM-DD","minggu 1","minggu 2","minggu 3","minggu 4","minggu 5","minggu 6","minggu 7","minggu 8","minggu 9","minggu 10","otomatis","bebas"];

const OLD_HEADERS_6 = ["nama","no_hp","pinjaman","angsuran","tgl_mulai","A1","A2","A3","A4","A5","A6","A7","A8","A9","A10","sisa","keterangan"];
const OLD_HEADERS_5 = ["nama","no_hp","nominal","jatuh_tempo","status"];

const GROUPS = [
  { name: "Senin",  color: { red: 0.83, green: 0.91, blue: 1 },    start: "2026-10-06" },
  { name: "Selasa", color: { red: 0.85, green: 1, blue: 0.85 },    start: "2026-10-07" },
  { name: "Rabu",   color: { red: 1, green: 0.95, blue: 0.80 },    start: "2026-10-13" },
  { name: "Kamis",  color: { red: 1, green: 0.85, blue: 0.85 },    start: "2026-10-08" },
  { name: "Jumat",  color: { red: 0.90, green: 0.85, blue: 1 },    start: "2026-10-09" },
  { name: "Sabtu",  color: { red: 1, green: 0.90, blue: 0.75 },    start: "2026-10-10" },
];

function mkRow(nama,no_hp,pinjaman,pinjaman_ke,angsuran,start,aVals,keterangan){
  const arr=[nama,no_hp,pinjaman,String(pinjaman_ke||1),angsuran,start];
  for(let i=0;i<10;i++) arr.push(aVals[i]||"");
  arr.push("");
  arr.push(keterangan||"");
  return arr;
}
function samplesFor(start) {
  return [
    mkRow("Budi Santoso","081234567890","5000000",1,"500000",start,[],`contoh - minggu 1 jatuh tempo ${start}`),
    mkRow("Rina Wati","082111111111","3000000",1,"300000",start,["Sudah dibayar"],`baru A1 sudah dibayar, minggu 2 target berikut`),
    mkRow("Joko P.","083222222222","4000000",2,"400000",start,["Sudah dibayar","Sudah dibayar","Terkirim"],`pinjaman ke-2, 2x sudah dibayar, terkirim minggu 3`),
  ];
}

function isOld6(h) {
  const low = h.map(v=>String(v||"").trim().toLowerCase());
  return low[2]==="pinjaman" && low[3]==="angsuran" && (low[4]==="tgl_mulai" || low[4]==="tgl mulai");
}
function isNew(h) {
  const low = h.map(v=>String(v||"").trim().toLowerCase());
  return low[3]==="pinjaman_ke" && low[5]==="tgl_cair";
}

async function migrateOldToNew(sheets, spreadsheetId, sheetName) {
  const all = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${sheetName}!A:Z` });
  const rows = all.data.values || [];
  if (rows.length < 1) return false;
  const header = rows[0] || [];
  if (!isOld6(header)) return false;
  console.log(`  -> migrasi "${sheetName}" 17 kolom (tgl_mulai) → 18 kolom (pinjaman_ke + tgl_cair) ...`);
  const dataStart = (() => {
    if (rows.length >= 2) {
      const second = (rows[1]||[]).map(v=>String(v).trim().toLowerCase());
      if (second.includes("minggu 1") || second[5]==="minggu 1" || second.includes("(per minggu)") || second.includes("yyyy-mm-dd")) return 2;
    }
    return 1;
  })();
  const dataRows = rows.slice(dataStart).filter(r=> (r[0]||r[1]) && !String(r[0]||"").toLowerCase().startsWith("petunjuk"));
  const newRows = dataRows.map(old => {
    const o = [...old];
    while(o.length < 17) o.push("");
    return [
      o[0]||"", o[1]||"", o[2]||"", "1", o[3]||"", o[4]||"",
      o[5]||"", o[6]||"", o[7]||"", o[8]||"", o[9]||"", o[10]||"", o[11]||"", o[12]||"", o[13]||"", o[14]||"",
      o[15]||"", o[16]||"",
    ];
  });
  await sheets.spreadsheets.values.clear({ spreadsheetId, range: `${sheetName}!A:Z` });
  await sheets.spreadsheets.values.update({ spreadsheetId, range: `${sheetName}!A1:R1`, valueInputOption: "RAW", requestBody: { values: [HEADERS] } });
  await sheets.spreadsheets.values.update({ spreadsheetId, range: `${sheetName}!A2:R2`, valueInputOption: "RAW", requestBody: { values: [HELP] } });
  if (newRows.length) {
    await sheets.spreadsheets.values.update({ spreadsheetId, range: `${sheetName}!A3:R${newRows.length+2}`, valueInputOption: "RAW", requestBody: { values: newRows } });
    for (let i=0;i<newRows.length;i++) {
      const r = i+3;
      try { await sheets.spreadsheets.values.update({ spreadsheetId, range: `${sheetName}!Q${r}`, valueInputOption: "USER_ENTERED", requestBody: { values: [[sisaFormula(r)]] } }); } catch {}
    }
  } else {
    const samples = samplesFor(GROUPS.find(g=>g.name===sheetName)?.start || "2026-10-06");
    await sheets.spreadsheets.values.update({ spreadsheetId, range: `${sheetName}!A3:R${samples.length+2}`, valueInputOption: "RAW", requestBody: { values: samples } });
    for (let i=0;i<samples.length;i++) { const r=i+3; try{ await sheets.spreadsheets.values.update({ spreadsheetId, range: `${sheetName}!Q${r}`, valueInputOption: "USER_ENTERED", requestBody:{values:[[ sisaFormula(r)]]}}); }catch{}}
  }
  await sheets.spreadsheets.values.update({ spreadsheetId, range: `${sheetName}!A${(newRows.length||3)+4}:R${(newRows.length||3)+4}`, valueInputOption: "RAW", requestBody:{values:[["Petunjuk:","no_hp kunci utama, pinjaman_ke = siklus pinjaman, tgl_cair = pencairan, A1-A10: kosong / Belum dibayar = Sudah dibayar / Terkirim. Bot ingatkan minggu pertama jatuh tempo."]]}});
  return true;
}

async function migrateGenericOld(sheets, spreadsheetId, sheetName) {
  const cur = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${sheetName}!A1:Z1` });
  const header = (cur.data.values?.[0]||[]).map(v=>String(v).trim().toLowerCase());
  if (header.length===0) return false;
  if (header[0]==="nama" && header.includes("jatuh_tempo") && !header.includes("a1")) {
    console.log(`  -> migrasi "${sheetName}" format lama (jatuh_tempo/status) → 10x 18 kolom ...`);
    await sheets.spreadsheets.values.clear({ spreadsheetId, range: `${sheetName}!A:Z` });
    await sheets.spreadsheets.values.update({ spreadsheetId, range: `${sheetName}!A1:R1`, valueInputOption:"RAW", requestBody:{values:[HEADERS]}});
    await sheets.spreadsheets.values.update({ spreadsheetId, range: `${sheetName}!A2:R2`, valueInputOption:"RAW", requestBody:{values:[HELP]}});
    return true;
  }
  return false;
}

async function main() {
  const spreadsheetId = process.env.SPREADSHEET_ID;
  if (!spreadsheetId || spreadsheetId.includes("isi_")) throw new Error("SPREADSHEET_ID belum diisi di .env");
  const reset = process.argv.includes("--reset");
  const auth = new google.auth.GoogleAuth({ keyFile: CREDENTIALS_PATH, scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
  const sheets = google.sheets({ version: "v4", auth: await auth.getClient() });
  await detectFormulaSep();

  let meta = await sheets.spreadsheets.get({ spreadsheetId });
  const existingNames = new Set(meta.data.sheets.map(s=>s.properties.title));

  for (const g of GROUPS) {
    if (!existingNames.has(g.name)) {
      console.log(`Membuat sheet "${g.name}"...`);
      await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody:{requests:[{addSheet:{properties:{title:g.name}}}]}});
      meta = await sheets.spreadsheets.get({ spreadsheetId });
    }
  }
  meta = await sheets.spreadsheets.get({ spreadsheetId });

  for (const g of GROUPS) {
    const sheet = meta.data.sheets.find(s=>s.properties.title===g.name);
    const sheetId = sheet.properties.sheetId;

    const cur = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${g.name}!A1:R1` });
    const headerRow = (cur.data.values?.[0]||[]).map(v=>String(v).trim().toLowerCase());
    const samples = samplesFor(g.start);

    if (reset) {
      console.log(`Reset "${g.name}" ...`);
      await sheets.spreadsheets.values.clear({ spreadsheetId, range: `${g.name}!A:Z` });
      await sheets.spreadsheets.values.update({ spreadsheetId, range: `${g.name}!A1:R1`, valueInputOption:"RAW", requestBody:{values:[HEADERS]}});
      await sheets.spreadsheets.values.update({ spreadsheetId, range: `${g.name}!A2:R2`, valueInputOption:"RAW", requestBody:{values:[HELP]}});
      await sheets.spreadsheets.values.update({ spreadsheetId, range: `${g.name}!A3:R${samples.length+2}`, valueInputOption:"RAW", requestBody:{values:samples}});
      for(let i=0;i<samples.length;i++){ const r=i+3; await sheets.spreadsheets.values.update({ spreadsheetId, range:`${g.name}!Q${r}`, valueInputOption:"USER_ENTERED", requestBody:{values:[[ sisaFormula(r)]]}}); }
      await sheets.spreadsheets.values.update({ spreadsheetId, range:`${g.name}!A${samples.length+4}:R${samples.length+4}`, valueInputOption:"RAW", requestBody:{values:[["Petunjuk:","no_hp=kunci, pinjaman_ke=siklus, tgl_cair=pencairan, A1-A10 kosong / Belum dibayar / Sudah dibayar / Terkirim. Bot ingatkan jatuh tempo pertama."]]}});
    } else {
      if (await migrateGenericOld(sheets, spreadsheetId, g.name)) {
        const cur2 = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${g.name}!A3:R20` });
        if (!(cur2.data.values||[]).length) {
          await sheets.spreadsheets.values.update({ spreadsheetId, range:`${g.name}!A3:R${samples.length+2}`, valueInputOption:"RAW", requestBody:{values:samples}});
          for(let i=0;i<samples.length;i++){ const r=i+3; await sheets.spreadsheets.values.update({ spreadsheetId, range:`${g.name}!Q${r}`, valueInputOption:"USER_ENTERED", requestBody:{values:[[ sisaFormula(r)]]}}); }
        }
      } else if (isOld6(await sheets.spreadsheets.values.get({ spreadsheetId, range: `${g.name}!A1:Q1` }).then(r=>r.data.values?.[0]||[]))) {
        await migrateOldToNew(sheets, spreadsheetId, g.name);
      } else if (isNew(headerRow)) {
        const all = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${g.name}!A:R` });
        const dataLen = (all.data.values||[]).length;
        if (dataLen < 3) {
          console.log(`  "${g.name}" header OK tapi kosong — isi sample`);
          await sheets.spreadsheets.values.update({ spreadsheetId, range:`${g.name}!A3:R${samples.length+2}`, valueInputOption:"RAW", requestBody:{values:samples}});
          for(let i=0;i<samples.length;i++){ const r=i+3; await sheets.spreadsheets.values.update({ spreadsheetId, range:`${g.name}!Q${r}`, valueInputOption:"USER_ENTERED", requestBody:{values:[[ sisaFormula(r)]]}}); }
        } else {
          for(let r=3;r<=dataLen;r++){
            const row=(all.data.values[r-1]||[]);
            if (!row[16] && (row[0]||row[1])) { try{ await sheets.spreadsheets.values.update({ spreadsheetId, range:`${g.name}!Q${r}`, valueInputOption:"USER_ENTERED", requestBody:{values:[[ sisaFormula(r)]]}});}catch{}}
          }
          console.log(`  "${g.name}" header 18 kolom OK (${dataLen-2} anggota)`);
        }
      } else if (headerRow.length===0 || headerRow[0]==="") {
        console.log(`  -> tulis header baru "${g.name}"`);
        await sheets.spreadsheets.values.update({ spreadsheetId, range:`${g.name}!A1:R1`, valueInputOption:"RAW", requestBody:{values:[HEADERS]}});
        await sheets.spreadsheets.values.update({ spreadsheetId, range:`${g.name}!A2:R2`, valueInputOption:"RAW", requestBody:{values:[HELP]}});
        await sheets.spreadsheets.values.update({ spreadsheetId, range:`${g.name}!A3:R${samples.length+2}`, valueInputOption:"RAW", requestBody:{values:samples}});
        for(let i=0;i<samples.length;i++){ const r=i+3; await sheets.spreadsheets.values.update({ spreadsheetId, range:`${g.name}!Q${r}`, valueInputOption:"USER_ENTERED", requestBody:{values:[[ sisaFormula(r)]]}}); }
      } else {
        console.log(`  "${g.name}" header tidak dikenal [${headerRow.join(",")}] → migrasi paksa ke 18 kolom`);
        await migrateOldToNew(sheets, spreadsheetId, g.name);
      }
    }

    try{
      await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody:{requests:[
        { repeatCell:{range:{sheetId, startRowIndex:0,endRowIndex:1}, cell:{userEnteredFormat:{textFormat:{bold:true}, backgroundColor:g.color, horizontalAlignment:"CENTER"}}, fields:"userEnteredFormat(textFormat,backgroundColor,horizontalAlignment)"}},
        { repeatCell:{range:{sheetId, startRowIndex:1,endRowIndex:2}, cell:{userEnteredFormat:{textFormat:{italic:true,fontSize:8,foregroundColor:{red:0.5,green:0.5,blue:0.5}}}}, fields:"userEnteredFormat(textFormat)"}},
        { updateSheetProperties:{properties:{sheetId, gridProperties:{frozenRowCount:2,frozenColumnCount:2}}, fields:"gridProperties(frozenRowCount,frozenColumnCount)"}},
        { autoResizeDimensions:{dimensions:{sheetId, dimension:"COLUMNS", startIndex:0,endIndex:18}}},
      ]}});
    }catch(e){ console.log("  warn formatting", e.message.slice(0,120)); }
    try{
      await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody:{requests:[
        { setDataValidation:{range:{sheetId, startRowIndex:2, startColumnIndex:6, endColumnIndex:16}, rule:{condition:{type:"ONE_OF_LIST", values:[{userEnteredValue:"Sudah dibayar"},{userEnteredValue:"Terkirim"},{userEnteredValue:"Belum dibayar"},{userEnteredValue:""}]}, showCustomUi:true, strict:false}}},
      ]}});
    }catch{}
    // Perbaiki tgl_cair yang tidak valid / format salah
    try { await repairTglCair(sheets, spreadsheetId, g.name); } catch (e) { console.log("  warn repair tgl_cair", e.message.slice(0, 120)); }
    // Perbaiki formula kolom Q yang rusak/kosong (#ERROR! karena pemisah argumen salah)
    try {
      const qv = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${g.name}!A:Q` });
      const qRows = qv.data.values || [];
      let repaired = 0;
      for (let r = 3; r <= qRows.length; r++) {
        const row = qRows[r - 1] || [];
        const hasMember = (row[0] || row[1]) && !String(row[0] || "").toLowerCase().startsWith("petunjuk");
        if (!hasMember) continue;
        const curQ = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${g.name}!Q${r}`, valueRenderOption: "FORMULA" });
        const formula = curQ.data.values?.[0]?.[0];
        const need = !formula || formula.includes("Lunas") || formula.includes('G' + r + ':P' + r + ',');
        if (need) {
          await sheets.spreadsheets.values.update({ spreadsheetId, range: `${g.name}!Q${r}`, valueInputOption: "USER_ENTERED", requestBody: { values: [[sisaFormula(r)]] } });
          repaired++;
        }
      }
      if (repaired) console.log(`  -> ${repaired} formula "sisa" diperbaiki di ${g.name}`);
    } catch (e) { console.log("  warn repair sisa", e.message.slice(0, 120)); }
    console.log(`  -> format ${g.name} selesai`);
  }

  console.log(`\nSelesai 10x setup: ${GROUPS.map(g=>g.name).join(", ")}`);
  console.log(`https://docs.google.com/spreadsheets/d/${spreadsheetId}`);
  console.log("Kolom 18: nama | no_hp | pinjaman | pinjaman_ke | angsuran | tgl_cair | A1..A10 | sisa | keterangan");
  console.log("Kunci update: no_hp (+ pinjaman_ke bila ada 2 pinjaman). Command: npm run member -- upsert --hp 08.. --tgl_cair 2026-10-06 --pinjaman 5000000 --pinjaman_ke 1 --angsuran-ke 2 --status Lunas");
}

main().catch(e=>{ console.error(e.message); if(e.response) console.error(JSON.stringify(e.response.data).slice(0,1500)); process.exit(1); });
