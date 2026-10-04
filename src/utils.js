function formatRupiah(n) {
  const num = Number(String(n).replace(/[^0-9.-]/g, "")) || 0;
  return new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(num);
}

function formatTanggal(dateStr) {
  const d = new Date(dateStr);
  if (isNaN(d)) return dateStr;
  return d.toLocaleDateString("id-ID", { day: "2-digit", month: "long", year: "numeric" });
}

function normalizePhone(phone) {
  let p = String(phone).replace(/[^0-9]/g, "");
  if (p.startsWith("0")) p = "62" + p.slice(1);
  if (p.includes("@")) return p;
  return `${p}@s.whatsapp.net`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function logInfo(msg) {
  console.log(`[${new Date().toLocaleString("id-ID")}] ${msg}`);
}

function logError(msg, err) {
  console.error(`[${new Date().toLocaleString("id-ID")}] ERROR: ${msg}`, err || "");
}

module.exports = { formatRupiah, formatTanggal, normalizePhone, sleep, logInfo, logError };
