const { getAngsuranData, updateInstallment, updateStatus, getTodaySheetName, isGroupMode, isPaid, isTerkirim } = require("./sheets");
const { sendMessage, isReady } = require("./whatsapp");
const { formatRupiah, formatTanggal, normalizePhone, sleep, logInfo, logError } = require("./utils");

function buildMessageLegacy(r) {
  return `Halo *${r.nama}*,\n\nPengingat pembayaran angsuran koperasi:\nNominal: *${formatRupiah(r.angsuran || r.nominal)}*\nJatuh tempo: *${formatTanggal(r.jatuh_tempo)}*\n\nMohon segera melakukan pembayaran tepat waktu.\nTerima kasih.`;
}

function buildMessage10x(m, inst) {
  const dueStr = inst.due ? formatTanggal(inst.due) : (m.tgl_mulai || "-");
  const angs = m.angsuran || m.nominal || "";
  const pinj = m.pinjaman ? `Pinjaman: *${formatRupiah(m.pinjaman)}*\n` : "";
  return `Halo *${m.nama}*,\n\nPengingat angsuran koperasi *${m.sheetName}* minggu ke-${inst.n}/10:\n${pinj}Angsuran ke-${inst.n}: *${formatRupiah(angs)}*\nJatuh tempo: *${dueStr}*\nStatus: *Belum dibayar*\nSisa: *${m.sisa}x lagi* (${m.countLunas}/10 sudah dibayar)\n\nMohon dibayarkan tepat waktu.\nTerima kasih.`;
}

function isOverdue(dateObj) {
  if (!dateObj) return true;
  const d = new Date(dateObj);
  if (isNaN(d)) return true;
  const today = new Date(); today.setHours(0,0,0,0);
  d.setHours(0,0,0,0);
  return d <= today;
}

function findDueInstallment(member) {
  if (!member.is10x || !member.installments?.length) return null;
  if (member.sisa === 0) return null;
  for (const inst of member.installments) {
    if (isPaid(inst.status) || isTerkirim(inst.status)) continue;
    if (isOverdue(inst.due)) return inst;
    return null;
  }
  return null;
}

function isLegacyOverdue(jatuhTempo) {
  if (!jatuhTempo) return true;
  const due = new Date(jatuhTempo);
  if (isNaN(due)) return true;
  const today = new Date(); today.setHours(0,0,0,0);
  due.setHours(0,0,0,0);
  return due <= today;
}

async function runReminder(opts = {}) {
  if (!isReady()) { logError("WhatsApp belum ready, reminder dibatalkan"); return { sent: 0, skipped: 0, failed: 0, sheet: null }; }
  const delayMs = Number(process.env.DELAY_MS) || 3000;
  const forceSheet = opts.sheet || null;

  let sheetName = forceSheet;
  if (!sheetName && isGroupMode()) {
    sheetName = getTodaySheetName(opts.date);
    if (sheetName === "Minggu") { logInfo("Hari Minggu — tidak ada grup, skip"); return { sent: 0, skipped: 0, failed: 0, sheet: "Minggu" }; }
  }

  const list = await getAngsuranData(sheetName || undefined);
  const effectiveSheet = sheetName || process.env.SHEET_NAME || "Sheet1";
  const is10x = list.length > 0 ? !!list[0].is10x : false;

  logInfo(`Sheet "${effectiveSheet}" — total ${list.length} anggota ${is10x ? "(10x mingguan)" : ""}`);

  let targets = [];
  if (is10x) {
    for (const m of list) {
      const inst = findDueInstallment(m);
      if (inst) targets.push({ member: m, inst });
    }
    logInfo(`Ditemukan ${targets.length} angsuran jatuh tempo dari ${list.length} anggota`);
  } else {
    targets = list.filter((r) => {
      const status = String(r.status || "").trim().toLowerCase();
      if (["lunas", "sudah dibayar", "paid"].includes(status)) return false;
      if (status === "terkirim") return false;
      return isLegacyOverdue(r.jatuh_tempo);
    }).map((r) => ({ member: r, inst: null }));
    logInfo(`Ditemukan ${targets.length} tagihan perlu diingatkan dari total ${list.length}`);
  }

  let sent = 0, skipped = 0, failed = 0;
  for (const { member, inst } of targets) {
    if (!member.no_hp) { skipped++; logError(`Skip ${member.nama}: no_hp kosong`); continue; }
    try {
      const phone = normalizePhone(member.no_hp);
      const msg = is10x ? buildMessage10x(member, inst) : buildMessageLegacy(member);
      await sendMessage(phone, msg);
      if (is10x) await updateInstallment(member.rowIndex, inst.n, "Terkirim", member.sheetName);
      else await updateStatus(member.rowIndex, "Terkirim", member.sheetName);
      sent++;
      logInfo(`Terkirim ke ${member.nama} (${phone}) [${member.sheetName}${is10x ? ` A${inst.n}` : ""}]`);
      await sleep(delayMs);
    } catch (err) {
      failed++;
      logError(`Gagal kirim ke ${member.nama}`, err.message);
      await sleep(1000);
    }
  }
  logInfo(`Selesai sheet "${effectiveSheet}": terkirim=${sent}, skip=${skipped}, gagal=${failed}`);
  return { sent, skipped, failed, sheet: effectiveSheet };
}

module.exports = { buildMessage: buildMessageLegacy, buildMessage10x, isOverdue, findDueInstallment, runReminder };
