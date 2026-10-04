require("dotenv").config();
const { google } = require("googleapis");
const path = require("path");

const CREDENTIALS_PATH = path.join(__dirname, "..", "credentials.json");
const HEADERS = ["nama", "no_hp", "nominal", "jatuh_tempo", "status"];
const SAMPLE = [
  ["Budi Santoso", "081234567890", "500000", "2026-10-05", ""],
  ["Siti Aminah", "082345678901", "750000", "2026-09-30", ""],
  ["Andi Wijaya", "083456789012", "1000000", "2026-10-01", "Lunas"],
];

async function main() {
  const spreadsheetId = process.env.SPREADSHEET_ID;
  const sheetName = process.env.SHEET_NAME || "Sheet1";
  if (!spreadsheetId || spreadsheetId.includes("isi_")) throw new Error("SPREADSHEET_ID belum diisi di .env");

  const auth = new google.auth.GoogleAuth({ keyFile: CREDENTIALS_PATH, scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
  const sheets = google.sheets({ version: "v4", auth: await auth.getClient() });

  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  let sheet = meta.data.sheets.find((s) => s.properties.title === sheetName);
  if (!sheet) {
    console.log(`Sheet "${sheetName}" tidak ada, membuat baru...`);
    await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: [{ addSheet: { properties: { title: sheetName } } }] } });
    const meta2 = await sheets.spreadsheets.get({ spreadsheetId });
    sheet = meta2.data.sheets.find((s) => s.properties.title === sheetName);
  }
  const sheetId = sheet.properties.sheetId;

  const cur = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${sheetName}!1:1` });
  const existing = cur.data.values?.[0]?.map((v) => v.trim().toLowerCase()) || [];
  const needSetup = HEADERS.some((h, i) => existing[i] !== h);

  if (needSetup) {
    console.log(`Menulis header: ${HEADERS.join(" | ")}`);
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${sheetName}!A1:E1`,
      valueInputOption: "RAW",
      requestBody: { values: [HEADERS] },
    });
  } else {
    console.log("Header sudah sesuai, skip tulis header");
  }

  const all = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${sheetName}!A:Z` });
  if ((all.data.values || []).length < 2) {
    console.log("Menulis sample data...");
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${sheetName}!A2:E${SAMPLE.length + 1}`,
      valueInputOption: "RAW",
      requestBody: { values: SAMPLE },
    });
  }

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        { repeatCell: { range: { sheetId, startRowIndex: 0, endRowIndex: 1 }, cell: { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: { red: 0.9, green: 0.9, blue: 0.9 } } }, fields: "userEnteredFormat(textFormat,backgroundColor)" } },
        { updateSheetProperties: { properties: { sheetId, gridProperties: { frozenRowCount: 1 } }, fields: "gridProperties.frozenRowCount" } },
        { autoResizeDimensions: { dimensions: { sheetId, dimension: "COLUMNS", startIndex: 0, endIndex: 5 } } },
      ],
    },
  });

  console.log(`Selesai setup "${sheetName}" di ${spreadsheetId}`);
  console.log("Kolom: nama | no_hp (08.../62...) | nominal (angka) | jatuh_tempo (YYYY-MM-DD) | status (kosong/Lunas/Terkirim)");
}

main().catch((e) => { console.error(e.message); process.exit(1); });
