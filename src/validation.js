const { logInfo } = require("./utils");

function parseIDR(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(/[^0-9]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parseTanggal(v) {
  if (!v) return null;
  const d = new Date(String(v).trim());
  if (!isNaN(d)) { d.setHours(0,0,0,0); return d; }
  const m = String(v).match(/(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})/);
  if (m) {
    const dd = Number(m[1]), mo = Number(m[2])-1, yy = Number(m[3].length===2? "20"+m[3]: m[3]);
    const d2 = new Date(yy, mo, dd);
    if (!isNaN(d2)) { d2.setHours(0,0,0,0); return d2; }
  }
  return null;
}

function isBerhasil(status) {
  if (!status) return null;
  const s = String(status).toUpperCase();
  if (/(BERHASIL|SUKSES|SUCCESS|COMPLETED|SELESAI)/.test(s)) return true;
  if (/(GAGAL|FAILED|PENDING|PROSES|BATAL)/.test(s)) return false;
  return null;
}

function validateBukti(ai, member) {
  const reasons = [];
  let decision = "REVIEW";
  const nominalAI = ai.nominal;
  const expected = parseIDR(member.angsuran || member.nominal);
  const pinjaman = parseIDR(member.pinjaman);

  if (ai.classification === "NOT_TRANSFER_PROOF" || ai.classification === "UNREADABLE") {
    return { decision: "SKIP", reasons: [ai.reason || ai.classification], matchedInstallment: null };
  }

  if (ai.classification === "POSSIBLE_TRANSFER_PROOF") {
    reasons.push("AI POSSIBLE — informasi tidak lengkap: " + (ai.missing_fields?.join(", ") || ai.reason));
  }

  if (member.sisa === 0 || member.countLunas >= 10) {
    reasons.push("Semua 10 angsuran sudah dibayar");
    return { decision: "REVIEW", reasons, matchedInstallment: null };
  }

  const inst = require("./sheets").pickInstallmentToConfirm(member);
  if (!inst) {
    reasons.push("Tidak ada angsuran jatuh tempo untuk dikonfirmasi (sudah dibayar / Terkirim, atau belum jatuh tempo)");
  }

  if (ai.missing_fields?.length) reasons.push("Field tidak terbaca: " + ai.missing_fields.join(", "));

  if (nominalAI === null) {
    reasons.push("Nominal tidak terbaca AI");
  } else if (expected !== null && nominalAI !== expected) {
    const tolerance = Number(process.env.NOMINAL_TOLERANCE || 0);
    if (Math.abs(nominalAI - expected) > tolerance) {
      reasons.push(`Nominal tidak cocok: AI=${nominalAI} expected=${expected} (angsuran ${member.angsuran})`);
      if (pinjaman !== null && nominalAI === pinjaman) reasons.push("Nominal AI cocok dengan PINJAMAN bukan angsuran — kemungkinan salah nominal");
    }
  }

  const berhasil = isBerhasil(ai.status_transaksi);
  if (berhasil === false) reasons.push(`Status transaksi bukan BERHASIL: ${ai.status_transaksi}`);
  if (berhasil === null && ai.status_transaksi) reasons.push(`Status transaksi tidak jelas: ${ai.status_transaksi}`);
  if (!ai.status_transaksi) reasons.push("Status transaksi tidak terbaca");

  if (ai.tanggal_transfer) {
    const dAI = parseTanggal(ai.tanggal_transfer);
    const today = new Date(); today.setHours(0,0,0,0);
    if (!dAI) reasons.push(`Tanggal AI tidak valid: ${ai.tanggal_transfer}`);
    else {
      if (dAI > today) reasons.push(`Tanggal transfer di masa depan: ${ai.tanggal_transfer}`);
      if (member.tgl_mulai) {
        const start = new Date(member.tgl_mulai); start.setHours(0,0,0,0);
        if (!isNaN(start) && dAI < start) reasons.push(`Tanggal transfer sebelum tgl_mulai ${member.tgl_mulai}`);
      }
      const diffDays = Math.round((today - dAI) / 86400000);
      const maxAge = Number(process.env.BUKTI_MAX_AGE_DAYS || 14);
      if (diffDays > maxAge) reasons.push(`Tanggal transfer terlalu lama (${diffDays} hari > ${maxAge} hari): ${ai.tanggal_transfer}`);
      if (inst?.due) {
        const due = new Date(inst.due); due.setHours(0,0,0,0);
        if (!isNaN(due)) {
          const early = Math.round((due - dAI) / 86400000);
          if (early > 7) reasons.push(`Transfer terlalu awal vs jatuh tempo A${inst.n} (${early} hari sebelum due)`);
        }
      }
    }
  } else {
    reasons.push("Tanggal transfer tidak terbaca");
  }

  if (ai.confidence !== null && ai.confidence < 0.85 && ai.classification === "VALID_TRANSFER_PROOF") {
    reasons.push(`Confidence rendah: ${ai.confidence}`);
  }

  if (ai.classification === "VALID_TRANSFER_PROOF" && reasons.length === 0) decision = "VERIFIED";
  else if (ai.classification === "POSSIBLE_TRANSFER_PROOF" && reasons.length === 0) decision = "REVIEW";
  else if (ai.classification === "VALID_TRANSFER_PROOF" && reasons.length > 0) decision = "REVIEW";
  else decision = "REVIEW";

  if (ai.classification === "POSSIBLE_TRANSFER_PROOF") decision = "REVIEW";

  return { decision, reasons, matchedInstallment: inst, nominalAI, expected, berhasil };
}

module.exports = { validateBukti, parseIDR, parseTanggal, isBerhasil };
