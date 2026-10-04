require("dotenv").config();
const cron = require("node-cron");
const path = require("path");
const fs = require("fs");
const { createClient, isReady } = require("./whatsapp");
const { runReminder } = require("./reminder");
const { getAllGroupsData, GROUP_SHEETS } = require("./sheets");
const { isTanggalMerah } = require("./holiday");
const { logInfo, logError } = require("./utils");

// Cegah >1 instance (men memicu "Stream Errored (conflict)" + Bad MAC)
const LOCK_FILE = path.join(__dirname, "..", ".bot.lock");
function acquireLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const pid = Number(String(fs.readFileSync(LOCK_FILE, "utf8")).trim());
      if (pid && pid !== process.pid) {
        try { process.kill(pid, 0); logError(`Bot sudah jalan (PID ${pid}). Stop instance lain / hapus .bot.lock`); process.exit(1); }
        catch { /* process lama sudah mati, lanjut */ }
      }
    }
    fs.writeFileSync(LOCK_FILE, String(process.pid));
  } catch (e) { logError("Lock file gagal", e.message); }
}
function releaseLock() {
  try {
    if (fs.existsSync(LOCK_FILE) && Number(String(fs.readFileSync(LOCK_FILE, "utf8")).trim()) === process.pid) fs.unlinkSync(LOCK_FILE);
  } catch {}
}
process.on("exit", releaseLock);
process.on("SIGINT", () => { releaseLock(); process.exit(0); });
process.on("SIGTERM", () => { releaseLock(); process.exit(0); });
process.on("uncaughtException", (e) => { logError("uncaughtException", e && e.message); });
acquireLock();

const CRON = process.env.CRON_SCHEDULE || "0 8 * * *";
const TZ = process.env.TIMEZONE || "Asia/Jakarta";
const GROUP_MODE = String(process.env.USE_GROUP_SHEETS || "true").toLowerCase() !== "false";

async function main() {
  const { detectFormulaSep } = require("./sheets");
  const { getAdminList } = require("./wa-admin");
  await detectFormulaSep();

  const admins = getAdminList();
  if (!admins.length) {
    logError("ADMIN_NUMBERS belum diisi di .env — perintah CRUD dari WhatsApp akan diabaikan semua!");
  } else {
    logInfo(`Admin terdaftar: ${admins.length} nomor`);
  }
  if (!process.env.GEMINI_API_KEY && !process.env.LOCAL_AI_URL) {
    logInfo("GEMINI_API_KEY dan LOCAL_AI_URL kosong — verifikasi bukti transfer otomatis nonaktif");
  }
  try {
    const { aiProvider, localConfig } = require("./bukti");
    if (aiProvider() === "local") {
      const c = localConfig();
      logInfo(`AI Vision: LOKAL → ${c.base} (model: ${c.model})`);
    } else {
      logInfo(`AI Vision: GEMINI (model: ${process.env.GEMINI_MODEL || "gemini-2.5-flash"})`);
    }
  } catch {}
  if (!process.env.SPREADSHEET_ID) {
    logError("SPREADSHEET_ID belum diisi di .env — bot tidak bisa membaca data anggota");
  }

  logInfo(`Memulai koperasi-reminder (Baileys) — mode: ${GROUP_MODE ? "GRUP Senin-Sabtu" : "single sheet"}`);
  await createClient();

  if (!cron.validate(CRON)) { logError(`CRON_SCHEDULE tidak valid: ${CRON}`); process.exit(1); }

  cron.schedule(CRON, async () => {
    const cek = await isTanggalMerah(new Date());
    if (cek.holiday) { logInfo(`Skip broadcast: tanggal merah (${cek.reason})`); return; }
    logInfo(`Cron trigger: ${CRON}`);
    try { await runReminder(); } catch (err) { logError("Cron reminder gagal", err.message); }
  }, { timezone: TZ });

  logInfo(`Cron terdaftar: ${CRON} (${TZ}) — grup: ${GROUP_SHEETS.join(", ")}`);
  process.on("SIGINT", async () => { logInfo("SIGINT diterima, shutdown..."); process.exit(0); });
}

if (process.stdin.isTTY) {
  const rl = require("readline").createInterface({ input: process.stdin, output: process.stdout });
  console.log('\nPerintah:');
  console.log('  kirim              -> broadcast grup hari ini');
  console.log('  kirim <hari>       -> kirim Senin/Selasa/Rabu/Kamis/Jumat/Sabtu');
  console.log('  kirim all          -> broadcast semua grup 1x jalan');
  console.log('  cek                -> tampilkan jumlah anggota per grup');
  console.log('  exit               -> keluar\n');
  rl.on("line", async (input) => {
    const arg = input.trim().toLowerCase();
    if (arg === "cek" || arg === "status") {
      try {
        const all = await getAllGroupsData();
        for (const g of GROUP_SHEETS) {
          const v = all[g];
          if (Array.isArray(v)) console.log(`  ${g}: ${v.length} anggota`);
          else console.log(`  ${g}: error ${v.error}`);
        }
      } catch (e) { logError(e.message); }
      return;
    }
    if (arg === "kirim all") {
      if (!isReady()) { console.log("WhatsApp belum ready, scan QR dulu."); return; }
      for (const g of GROUP_SHEETS) {
        console.log(`-- kirim ${g} --`);
        await runReminder({ sheet: g }).catch((e) => logError(e.message));
      }
      return;
    }
    if (arg.startsWith("kirim")) {
      if (!isReady()) { console.log("WhatsApp belum ready, scan QR dulu."); return; }
      const parts = arg.split(/\s+/);
      const hari = parts[1] ? parts[1].charAt(0).toUpperCase() + parts[1].slice(1).toLowerCase() : null;
      if (hari && GROUP_SHEETS.map((s) => s.toLowerCase()).includes(hari.toLowerCase())) {
        const sheet = GROUP_SHEETS.find((s) => s.toLowerCase() === hari.toLowerCase());
        await runReminder({ sheet }).catch((e) => logError(e.message));
      } else if (!hari) {
        await runReminder().catch((e) => logError(e.message));
      } else {
        console.log(`Hari tidak dikenal: ${hari}. Pilihan: ${GROUP_SHEETS.join(", ")}, all`);
      }
      return;
    }
    if (arg === "exit") { rl.close(); process.exit(0); }
  });
}

main().catch((e) => logError("Fatal", e));
