const { digitsOnly, GROUP_SHEETS } = require("./sheets");
const { logInfo, logError } = require("./utils");

function getAdminList() {
  const raw = process.env.ADMIN_NUMBERS || process.env.ADMIN_NUMBER || process.env.ADMIN_JID || "";
  return String(raw).split(",").map((s) => digitsOnly(s.trim())).filter(Boolean);
}
function normalizeForCompare(jidOrPhone) {
  let s = String(jidOrPhone || "").trim();
  s = s.split("@")[0].split(":")[0];
  return digitsOnly(s);
}
function isAdmin(...candidates) {
  const list = getAdminList();
  const flat = candidates.flat().filter((x) => x !== null && x !== undefined && x !== "");
  for (const c of flat) {
    const d = normalizeForCompare(c);
    if (!d) continue;
    if (list.includes(d)) return true;
    const alt = d.startsWith("62") ? "0" + d.slice(2) : d.startsWith("0") ? "62" + d.slice(1) : d;
    if (list.includes(alt)) return true;
  }
  return false;
}

const ADMIN_COMMANDS = new Set([
  "tambah","add","upsert","buat","create","t",
  "ubah","update","edit","ganti","u",
  "set","lunas","bayar","lun","l",
  "hapus","remove","delete","hapus_anggota","hapus-anggota","h","del",
  "list","cek","lihat","cari","show","anggota","list_anggota","c",
  "help","menu","bantuan","bantuan_crud","perintah","?","jid","carjid","carilid","nomor","whoami","siapa","debug",
  "panduan","cara","cara_pakai","help_detail",
]);

function isAdminCommand(text) {
  if (!text) return false;
  let t = String(text).trim().replace(/^[\/\!\.\#]/, "").trim().toLowerCase();
  if (!t) return false;
  const first = t.split(/\s+/)[0].replace(/[^a-z0-9_?]/g, "");
  return ADMIN_COMMANDS.has(first);
}
function stripPrefix(text) { return String(text).trim().replace(/^[\/\!\.\#]\s*/, "").trim(); }

function parseMoneyStr(s) {
  if (!s) return null;
  let t = String(s).trim().toLowerCase().replace(/[,]/g,"").replace(/\s+/g,"");
  let mul = 1;
  if (t.endsWith("jt") || t.endsWith("juta")) { mul = 1000000; t = t.replace(/(jt|juta)$/,""); }
  else if (t.endsWith("rb") || t.endsWith("ribu") || t.endsWith("k")) { mul = 1000; t = t.replace(/(rb|ribu|k)$/,""); }
  t = t.replace(/\./g,"");
  const n = Number(t);
  if (!Number.isFinite(n) || n<=0) return null;
  return Math.round(n*mul);
}
function buildIso(y, m, d) {
  const yy = Number(y), mm = Number(m), dd = Number(d);
  if (!yy || !mm || !dd) return null;
  const year = yy < 100 ? 2000 + yy : yy;
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  const dt = new Date(year, mm - 1, dd);
  // validasi nyata: tanggal harus benar-benar ada di kalender (mis. 31 Feb ditolak)
  if (isNaN(dt) || dt.getFullYear() !== year || dt.getMonth() !== mm - 1 || dt.getDate() !== dd) return null;
  return `${year}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
}
function findDateInText(text) {
  const s = String(text);
  let m = s.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (m) { const iso = buildIso(m[1], m[2], m[3]); if (iso) return iso; }
  m = s.match(/\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})\b/);
  if (m) { const iso = buildIso(m[3], m[2], m[1]); if (iso) return iso; }
  m = s.match(/\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2})\b/);
  if (m) { const iso = buildIso(m[3], m[2], m[1]); if (iso) return iso; }
  return null;
}
function removeDateFromText(text, dateStr) {
  if (!dateStr) return text;
  let out = text;
  out = out.replace(dateStr, " ");
  const parts = dateStr.split("-");
  const dmy = `${parts[2]}/${parts[1]}/${parts[0]}`;
  out = out.replace(dmy, " ").replace(dmy.replace(/\//g,"-"), " ");
  return out;
}
function findMoneyTokensInText(text) {
  const re = /\b\d[\d\.\,]*\s*(?:jt|juta|rb|ribu|k)?\b/gi;
  const toks=[];
  let m;
  while((m=re.exec(text))!==null){
    const raw=m[0];
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) continue;
    if (/^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}$/.test(raw.replace(/\s+/g,""))) continue;
    const v=parseMoneyStr(raw);
    if(v!==null && v>=1000) toks.push({raw: raw.trim(), val:v, index:m.index});
  }
  return toks;
}

function parsePairs(input) {
  let s = String(input || "").replace(/--/g, "");
  const keyPat = "(?:hp|no_hp|nama|hari|tgl_cair|tgl-cair|tgl|pinjaman|pinjaman_ke|pinjaman-ke|ke|angsuran|cicilan|nominal|angsuran_ke|angsuran-ke|status|keterangan|a\\d+)";
  const re = new RegExp("\\b" + keyPat + "\\s*[:=]\\s*", "gi");
  const pos = [];
  let m;
  while ((m = re.exec(s)) !== null) {
    const rawKey = (m[0].split(/[:=]/)[0]||"").trim();
    const key = rawKey.toLowerCase().replace(/-/g, "_");
    pos.push({ key, index: m.index, end: m.index + m[0].length });
  }
  if (!pos.length) return {};
  const out = {};
  for (let i = 0; i < pos.length; i++) {
    const cur = pos[i];
    const nxt = pos[i + 1];
    let val = s.slice(cur.end, nxt ? nxt.index : undefined).trim();
    val = val.replace(/^[;|,\s]+/, "").replace(/[;|]\s*$/, "").trim();
    val = val.replace(/^["'](.*)["']$/, "$1").trim();
    out[cur.key] = val;
  }
  return out;
}
function extractHp(text) {
  const m = String(text).match(/(\+?62[\d\s\-]{8,15}|0\d{9,12})/);
  if (!m) return null;
  const raw = m[1].replace(/[\s\-]/g, "");
  const d = digitsOnly(raw);
  return d.length >= 9 ? raw : null;
}
function extractHari(text) {
  const m = String(text).match(/\b(senin|selasa|rabu|kamis|jumat|sabtu|minggu)\b/i);
  if (!m) return null;
  const c = m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase();
  if (GROUP_SHEETS.includes(c)) return c;
  return null;
}
function strippedWithoutPairs(rawText) {
  let s = String(rawText);
  s = s.replace(/--/g,"");
  s = s.replace(/\b(?:hp|no_hp|nama|hari|tgl_cair|tgl-cair|tgl|pinjaman|pinjaman_ke|pinjaman-ke|ke|angsuran|cicilan|nominal|angsuran_ke|angsuran-ke|status|keterangan|a\d+)\s*[:=]\s*[^;|]*/gi, " ");
  return s.replace(/[;|,]+/g," ").replace(/\s{2,}/g," ").trim();
}
function normalizeUpsertOpts(pairs, rawText, cmd) {
  const opts = {};
  let hp = pairs.hp || pairs.no_hp || null;
  if (!hp) { const f = extractHp(rawText); if (f) hp = f; }
  if (hp) opts.hp = hp;

  if (pairs.nama) opts.nama = pairs.nama;

  let stripped = strippedWithoutPairs(rawText);
  let hpStripped = hp ? stripped.replace(hp.replace(/[.*+?^${}()|[\]\\]/g,"\\$&"), " ") : stripped;
  hpStripped = hpStripped.replace(/\+?62[\d\s\-]{8,15}|0\d{9,12}/g," ");

  if (!opts.nama) {
    let needName = !pairs.nama && !["list","cek","lihat","cari","hapus","remove","delete","hapus_anggota","hapus-anggota","set","lunas","bayar"].includes(cmd);
    if (needName) {
      let tmp = hpStripped;
      const hariTmp = pairs.hari ? "" : (extractHari(tmp)||"");
      if (hariTmp) tmp = tmp.replace(new RegExp(hariTmp,"i")," ");
      const dateTmp = findDateInText(tmp);
      if (dateTmp) tmp = removeDateFromText(tmp,dateTmp);
      const moneyToks = findMoneyTokensInText(tmp);
      for(const mt of moneyToks) tmp = tmp.replace(mt.raw," ");
      tmp = tmp.replace(/\b(a\d+)\b/gi," ").replace(/\b(ke\s*[:=]?\s*\d+)\b/gi," ").replace(/\b\d+\b/g, (m)=> Number(m)>=1 && Number(m)<=10 && tmp.split(/\s+/).length>1 ? " " : m);
      tmp = tmp.replace(/\s{2,}/g," ").trim();
      if (tmp) {
        const w = tmp.split(/\s+/).filter(Boolean);
        const filtered = w.filter(x=> !GROUP_SHEETS.map(s=>s.toLowerCase()).includes(x.toLowerCase()));
        if (filtered.length && filtered.join(" ").trim().length>=2) opts.nama = filtered.join(" ").trim();
      }
    }
  }

  if (pairs.hari) opts.hari = pairs.hari;
  else { const h = extractHari(rawText); if (h) opts.hari = h; }

  let dateVal = pairs.tgl_cair || pairs.tgl || null;
  if (!dateVal) { const d=findDateInText(rawText); if(d) dateVal=d; }
  if (dateVal) opts.tgl_cair = dateVal;

  if (pairs.pinjaman) opts.pinjaman = pairs.pinjaman;
  if (pairs.pinjaman_ke) opts.pinjaman_ke = pairs.pinjaman_ke;
  else if (pairs.ke) opts.pinjaman_ke = pairs.ke;

  if (pairs.angsuran) opts.angsuran = pairs.angsuran;
  else if (pairs.cicilan) opts.angsuran = pairs.cicilan;
  else if (pairs.nominal) opts.angsuran = pairs.nominal;

  if (pairs.angsuran_ke) opts.angsuran_ke = pairs.angsuran_ke;
  else {
    for(let n=1;n<=10;n++) if(pairs[`a${n}`]!==undefined){ opts.angsuran_ke=String(n); if(!pairs.status && pairs[`a${n}`]) opts.status=pairs[`a${n}`]; break; }
  }

  if (!opts.pinjaman || !opts.angsuran) {
    let moneySource = strippedWithoutPairs(rawText);
    if (pairs.pinjaman) moneySource = moneySource.replace(String(pairs.pinjaman)," ");
    if (pairs.angsuran) moneySource = moneySource.replace(String(pairs.angsuran)," ");
    if (hp) moneySource = moneySource.replace(hp," ");
    if (opts.hari) moneySource = moneySource.replace(new RegExp(opts.hari,"i")," ");
    if (opts.tgl_cair) moneySource = removeDateFromText(moneySource, opts.tgl_cair);
    moneySource = moneySource.replace(/\b(?:a\d+|ke)\s*[:=]?\s*\w*/gi," ");
    if (opts.nama) moneySource = moneySource.replace(opts.nama," ");
    const toks = findMoneyTokensInText(moneySource);
    const vals = toks.map(t=>t.val).filter(v=> v>=1000);
    if (!opts.pinjaman && vals.length>=1) opts.pinjaman = String(vals[0]);
    if (!opts.angsuran && vals.length>=2) opts.angsuran = String(vals[1]);
    if (opts.pinjaman && !opts.angsuran) {
      const p = parseMoneyStr(opts.pinjaman);
      if (p && p>=10000) opts.angsuran = String(Math.round(p/10));
    }
  }

  if (pairs.status) opts.status = pairs.status;
  if (pairs.keterangan) opts.keterangan = pairs.keterangan;

  if (pairs.a1||pairs.a2||pairs.a3||pairs.a4||pairs.a5||pairs.a6||pairs.a7||pairs.a8||pairs.a9||pairs.a10){
    for(let n=1;n<=10;n++) if(pairs[`a${n}`] && !opts.angsuran_ke){ opts.angsuran_ke=String(n); if(!opts.status) opts.status=pairs[`a${n}`]; }
  }

  if (opts.pinjaman) opts.pinjaman = String(opts.pinjaman).replace(/[^0-9]/g,"");
  if (opts.angsuran) opts.angsuran = String(opts.angsuran).replace(/[^0-9]/g,"");
  return opts;
}

function parseSimpleLunas(rawText, pairs) {
  const out={};
  const hp = pairs.hp || pairs.no_hp || extractHp(rawText);
  if(hp) out.hp=hp;
  if(pairs.pinjaman_ke) out.pinjaman_ke=pairs.pinjaman_ke;
  else if(pairs.ke) out.pinjaman_ke=pairs.ke;
  if(pairs.angsuran_ke) out.angsuran_ke=pairs.angsuran_ke;
  if(pairs.status) out.status=pairs.status;
  let stripped = strippedWithoutPairs(rawText);
  if(hp) stripped=stripped.replace(hp," ");
  stripped=stripped.replace(/\+?62[\d\s\-]{8,15}|0\d{9,12}/g," ");
  stripped=stripped.replace(/\b(?:a\d+|ke|angsuran_ke|pinjaman_ke|status)\s*[:=]?\s*\w*/gi," ");
  const nums = stripped.match(/\b\d+\b/g) || [];
  const small = nums.map(Number).filter(n=> n>=1 && n<=10);
  if(!out.angsuran_ke && small.length===1) out.angsuran_ke=String(small[0]);
  else if(!out.angsuran_ke && small.length>=2){
    if(!out.pinjaman_ke) out.pinjaman_ke=String(small[0]);
    out.angsuran_ke=String(small[1]);
  }
  const hari = pairs.hari || extractHari(rawText);
  if(hari) out.hari=hari;
  for(let n=1;n<=10;n++) if(pairs[`a${n}`]!==undefined){ out.angsuran_ke=String(n); if(!out.status) out.status=pairs[`a${n}`]; }
  if(!out.status){
    const low=String(rawText).toLowerCase();
    // Cek apakah SEMUA 10 angsuran sudah "sudah dibayar"
    const allPaid = stripped.replace(/\D/g,"").length >= 10; // heuristic: minimal 10 angka dikurangi non-digit
    // Count berapa "sudah dibayar" di text
    const paidCount = (stripped.match(/\b(?:sudah dibayar|sudahdibayar|lunas|paid|selesai)\/10/gi) || []).length;
    if(allPaid && paidCount >= 10) {
      out.status = "Lunas";  // semua sudah lunas
    } else {
      // Cek hanya berdasarkan kata kunci
      if(low.includes("sudah dibayar") || low.includes("lunas") && paidCount >= 10) out.status = "Lunas";
      else if(low.includes("belum dibayar") || low.includes("belum")) out.status = "Belum dibayar";
      else if(low.includes("terkirim")) out.status = "Terkirim";
    }
  }
  return out;
}


const HELP_TEXT = `*BANTUAN KOPERASI BOT*

Ketik salah satu perintah di bawah. Semua dikirim ke bot ini.

━━━━━━━━━━━━━━━━━━━━━━

*1. TAMBAH ANGGOTA BARU*

Contoh:
\`tambah 081234567890 Budi 2026-10-06 5jt\`

Artinya:
• Nomor HP : 081234567890
• Nama     : Budi
• Tanggal  : 6 Oktober 2026
• Pinjaman : 5 juta (5jt)
• Angsuran : otomatis 500.000 (5 juta ÷ 10)
• Kelompok : otomatis dari tanggal (Senin)

Bisa juga langsung isi semua:
\`tambah 081234567890 Budi Santoso 2026-10-06 5000000 500000\`

━━━━━━━━━━━━━━━━━━━━━━

*2. UBAH DATA*

Ganti nama saja:
\`ubah 081234567890 Budi Santoso\`

Ganti jumlah pinjaman saja:
\`ubah 081234567890 6jt\`

━━━━━━━━━━━━━━━━━━━━━━

*3. TANDAI ANGSURAN SUDAH DIBAYAR*

Angsuran ke-2 sudah dibayar:
\`lunas 081234567890 2\`

Angsuran ke-3 dari pinjaman ke-1:
\`lunas 081234567890 ke1 3\`

Atau pakai kolom:
\`set 081234567890 ke1 a3:Sudah dibayar\`

━━━━━━━━━━━━━━━━━━━━━━

*4. LIHAT DATA*

Satu orang:
\`cek 081234567890\`

Semua di kelompok Senin:
\`list Senin\`

Semua anggota:
\`list all\`

━━━━━━━━━━━━━━━━━━━━━━

*5. HAPUS ANGGOTA*

\`hapus 081234567890\`

Kalau punya lebih dari satu pinjaman, tentukan:
\`hapus 081234567890 ke:1\`

━━━━━━━━━━━━━━━━━━━━━━

*PENDUKUNG*

\`menu\` → tampilkan bantuan ini
\`panduan\` → penjelasan cara kerja bot
\`jid\` → cek nomor admin

━━━━━━━━━━━━━━━━━━━━━━

*CATATAN*

• Nomor HP harus diawali 08... atau 62...
• \`ke\` = urutan pinjaman (default 1)
• Tanggal format: 2026-10-06 atau 06-10-2026
• Nominal bisa ditulis: 5jt, 500rb, 500k
• Hanya nomor admin yang bisa memakai perintah ini`;

const PANDUAN_TEXT = `*PANDUAN CARA KERJA BOT*

━━━━━━━━━━━━━━━━━━━━━━

*KETIKA ANGGOTA KIRIM GAMBAR*

Cukup kirim foto bukti transfer ke bot. Bot akan:

1. Menolak gambar yang sama (duplikat)
2. Menyimpan gambar untuk arsip
3. Mengecek apakah ini benar bukti transfer
4. Mencocokkan dengan data anggota
5. Mengupdate status angsuran
6. Mengirim balasan ke anggota

━━━━━━━━━━━━━━━━━━━━━━

*HASIL PENGECEKAN*

✅ *DITERIMA* (VERIFIED)
Bukti valid, hari sesuai, nominal cocok
• Angsuran ditandai Sudah dibayar
• Anggota dapat balasan terima kasih
• Transaksi tercatat di sheet Transaksi

⚠️ *PERLU PERIKSA* (REVIEW)
Bukti kurang jelas / hari tidak cocok / nominal beda
• Tidak diupdate otomatis
• Bot meneruskan ke admin untuk diputuskan

❌ *DITOLAK* (SKIP)
Bukan bukti transfer
• Tidak dibalas ke anggota
• Bot meneruskan ke admin

━━━━━━━━━━━━━━━━━━━━━━

*SYARAT UPDATE OTOMIS*

✓ Gambar bukan duplikat
✓ AI mengenali sebagai bukti transfer
✓ Hari ini = hari jadwal anggota
✓ Nominal sesuai dengan tagihan
✓ Tanggal transfer wajar
✓ Angsuran belum pernah dibayar

Kalau salah satu tidak terpenuhi → masuk PERLU PERIKSA

━━━━━━━━━━━━━━━━━━━━━━

*STRUKTUR DATA*

Setiap kelompok punya sheet sendiri:
Senin, Selasa, Rabu, Kamis, Jumat, Sabtu

Setiap anggota memiliki:
• Nama dan nomor HP
• Pinjaman (boleh lebih dari satu)
• Tanggal pencairan
• 10 angsuran mingguan

Sheet tambahan:
• Transaksi = riwayat pembayaran
• Review = bukti yang perlu dipertimbangkan

━━━━━━━━━━━━━━━━━━━━━━

*PENENTUAN KELOMPOK*

Kelompok ditentukan dari tanggal pencairan:
• Tanggal 6 Oktober 2026 (Senin) → Kelompok Senin
• Tanggal 7 Oktober 2026 (Selasa) → Kelompok Selasa
• Dan seterusnya

Bukti dari anggota Kelompok Senin yang dikirim hari Selasa akan masuk PERLU PERIKSA.

Ketik \`panduan\` kapan saja untuk melihat panduan ini.`;

async function handleAdminCommand(rawText, remoteJid, sock) {
  const text = stripPrefix(rawText);
  const lower = text.toLowerCase();

  let first = lower.split(/\s+/)[0].replace(/[^a-z0-9_?]/g, "");
  if(first==="t") first="tambah";
  if(first==="u") first="ubah";
  if(first==="l"||first==="lun") first="lunas";
  if(first==="h"||first==="del") first="hapus";
  if(first==="c") first="cek";
  const rest = text.slice(text.trim().split(/\s+/)[0].length).trim();
  const crud = require("./crud");
  const { formatRupiah } = require("./utils");

  try {
    if (["help","menu","bantuan","bantuan_crud","perintah","?"].includes(first)) {
      await sock.sendMessage(remoteJid, { text: HELP_TEXT });
      return true;
    }

    if (["panduan","cara","cara_pakai","help_detail"].includes(first)) {
      await sock.sendMessage(remoteJid, { text: PANDUAN_TEXT });
      return true;
    }

    if (["jid","carjid","carilid","nomor","whoami","siapa","debug"].includes(first)) {
      const jidMod = require("./jid");
      const lines = [];
      lines.push(`*DEBUG IDENTITAS*`);
      lines.push(`RemoteJid: ${remoteJid}`);
      lines.push(`ADMIN_NUMBERS: ${getAdminList().join(", ")}`);
      lines.push(`isAdmin(remoteJid): ${isAdmin(remoteJid)}`);
      lines.push(`LID count terdaftar: ${jidMod.lidToPn.size}`);
      const pairs = parsePairs(rest);
      const q = rest.trim().replace(/^(jid|carjid|carilid|nomor|whoami|siapa|debug)\s*/i, "").trim();
      const qDigits = digitsOnly(q || pairs.hp || "");
      if (qDigits) {
        const pn = jidMod.lookupPn(qDigits);
        const lid = jidMod.lookupLid(qDigits);
        lines.push(`Query "${q}" -> PN=${pn || "-"} | LID=${lid || "-"}`);
        lines.push(`isAdmin: ${isAdmin(qDigits, pn, lid)}`);
      } else {
        const list = [...jidMod.lidToPn.entries()].slice(-10).map(([l, p]) => `${l} -> ${p}`);
        lines.push(list.length ? `*Mapping terakhir:*\n${list.join("\n")}` : "(belum ada mapping LID->PN)");
      }
      await sock.sendMessage(remoteJid, { text: lines.join("\n") });
      return true;
    }

    if (["tambah","add","upsert","buat","create"].includes(first)) {
      const pairs = parsePairs(rest);
      const opts = normalizeUpsertOpts(pairs, rest, first);
      if (!opts.hp) throw new Error("hp wajib. Contoh: tambah 081234567890 Budi 2026-10-06 5jt");
      if (!opts.tgl_cair) {
        const checkList = await crud.listMembers({ hp: opts.hp });
        const exists = checkList.some((g) => g.rows && g.rows.length);
        if (!exists) throw new Error("Anggota baru wajib tanggal. Contoh: tambah 081234567890 Budi 2026-10-06 5jt  atau  tambah 081.. nama:Budi tgl:2026-10-06 pinjaman:5000000");
      }
      opts.mode = "upsert";
      const res = await crud.upsertMember(opts);
      const m = res.member;
      const aStr = m ? m.installments.map((x) => x.status || "-").join("|") : "-";
      await sock.sendMessage(remoteJid, { text: `✅ ${res.action.toUpperCase()} ${res.sheetName} #${res.rowIndex}\n${m.nama} | ${m.no_hp} | pinj ${formatRupiah(m.pinjaman)} ke-${m.pinjaman_ke} | cair ${m.tgl_cair} | angs ${formatRupiah(m.angsuran)}\nA: ${aStr} | sisa ${m.sisa}x\nhttps://docs.google.com/spreadsheets/d/${res.spreadsheetId}` });
      return true;
    }

    if (["ubah","update","edit","ganti"].includes(first)) {
      const pairs = parsePairs(rest);
      const opts = normalizeUpsertOpts(pairs, rest, first);
      if (!opts.hp) throw new Error("hp wajib. Contoh: ubah 081234567890 Budi S.  atau  ubah 081.. ke:1 pinjaman:6000000");
      if (!opts.nama && !opts.pinjaman && !opts.angsuran && !opts.tgl_cair && !opts.keterangan && !opts.hari && !opts.pinjaman_ke && !opts.angsuran_ke) throw new Error("Tidak ada data diubah. Contoh: ubah 081234567890 Budi S.  atau  ubah 081.. 6jt");
      opts.mode = "update";
      const res = await crud.upsertMember(opts);
      const m = res.member;
      const aStr = m.installments.map((x) => x.status || "-").join("|");
      await sock.sendMessage(remoteJid, { text: `✅ UPDATE ${res.sheetName} #${res.rowIndex}\n${m.nama} | ${m.no_hp} | pinj ${formatRupiah(m.pinjaman)} ke-${m.pinjaman_ke} | cair ${m.tgl_cair} | angs ${formatRupiah(m.angsuran)}\nA: ${aStr} | sisa ${m.sisa}x` });
      return true;
    }

    if (["set","lunas","bayar"].includes(first)) {
      const pairs = parsePairs(rest);
      let opts = normalizeUpsertOpts(pairs, rest, first);
      const simple = parseSimpleLunas(rest, pairs);
      if (!opts.hp && simple.hp) opts.hp = simple.hp;
      if (!opts.pinjaman_ke && simple.pinjaman_ke) opts.pinjaman_ke = simple.pinjaman_ke;
      if (!opts.angsuran_ke && simple.angsuran_ke) opts.angsuran_ke = simple.angsuran_ke;
      if (!opts.status && simple.status) opts.status = simple.status;
      if (!opts.hari && simple.hari) opts.hari = simple.hari;
      if (!opts.hp) throw new Error("hp wajib. Contoh: lunas 081234567890 2  (=A2 Sudah dibayar)  atau  lunas 081.. ke1 3");
      if (!opts.angsuran_ke) throw new Error("angsuran_ke wajib 1..10. Contoh: lunas 081234567890 2  atau  set 081.. a3:Sudah dibayar");
      if (!opts.status) {
        if (["lunas","bayar"].includes(first)) opts.status = "Sudah dibayar";
        else throw new Error("status wajib: Sudah dibayar / Belum dibayar / Terkirim. Contoh: set 081.. a2:Belum dibayar");
      }
      opts.mode = "set";
      const res = await crud.upsertMember(opts);
      const m = res.member;
      await sock.sendMessage(remoteJid, { text: `✅ SET A${opts.angsuran_ke}=${opts.status} ${res.sheetName} #${res.rowIndex}\n${m.nama} | ${m.no_hp} ke-${m.pinjaman_ke}\nA: ${m.installments.map((x) => x.status || "-").join("|")} | sisa ${m.sisa}x` });
      return true;
    }

    if (["hapus","remove","delete","hapus_anggota","hapus-anggota"].includes(first)) {
      const pairs = parsePairs(rest);
      let opts = normalizeUpsertOpts(pairs, rest, first);
      const simple = parseSimpleLunas(rest, pairs);
      if (!opts.hp && simple.hp) opts.hp = simple.hp;
      if (!opts.pinjaman_ke && simple.pinjaman_ke) opts.pinjaman_ke = simple.pinjaman_ke;
      if (!opts.hp) throw new Error("hp wajib. Contoh: hapus 081234567890  atau  hapus 081.. ke:1");
      if (!opts.hari && simple.hari) opts.hari = simple.hari;
      const res = await crud.removeMember({ hp: opts.hp, pinjaman_ke: opts.pinjaman_ke, hari: opts.hari });
      await sock.sendMessage(remoteJid, { text: `🗑️ HAPUS ${res.sheetName} #${res.rowIndex}\n${res.row[0]} | ${res.row[1]} ke-${res.row[3] || 1} terhapus.` });
      return true;
    }

    if (["list","cek","lihat","cari","show","anggota","list_anggota"].includes(first)) {
      const pairs = parsePairs(rest);
      let hari = pairs.hari || null;
      let hp = pairs.hp || pairs.no_hp || null;
      if (!hari) hari = extractHari(rest);
      if (!hp) { const found = extractHp(rest); if (found) hp = found; }
      if (String(rest).toLowerCase().includes("all") || String(rest).toLowerCase().includes("semua")) {
        const hadHari = !!hari;
        hari = pairs.hari || (hadHari ? hari : null);
        if (!pairs.hp) hp = null;
        if (pairs.hp) hp = pairs.hp;
        if (!hadHari && !hp) hari = null;
      }
      const isAll = /all|semua/i.test(rest) && !hp;
      const opts = {};
      if (hp) opts.hp = hp;
      if (hari && !isAll) opts.hari = hari;
      if (isAll && hari) opts.hari = hari;
      if (!hp && !hari && !isAll) {
        const maybeHari = extractHari(rest);
        if (maybeHari) opts.hari = maybeHari;
        else if (rest.trim() && !/^\s*$/.test(rest) && !hp) {
          const nameQuery = strippedWithoutPairs(rest).replace(/\+?62[\d\s\-]{8,15}|0\d{9,12}/g," ").replace(/\b(senin|selasa|rabu|kamis|jumat|sabtu|minggu|all|semua)\b/gi," ").trim();
          if (nameQuery && nameQuery.length>=2) opts.nameContains = nameQuery;
        }
      }
      if (opts.nameContains) {
        const out = await crud.listMembers({});
        let msg = `🔍 Cari nama "${opts.nameContains}"\n`;
        let total=0;
        for(const g of out){
          if(g.error) continue;
          const filt = g.rows.filter(r=> String(r.nama||"").toLowerCase().includes(opts.nameContains.toLowerCase()));
          if(!filt.length) continue;
          total+=filt.length;
          msg+=`\n*${g.sheet} (${filt.length})*`;
          for(const r of filt.slice(0,15)){
            const aStr=r.installments.map(x=> x.status?`${x.n}:${x.status}`:`${x.n}:-`).join(" ");
            msg+=`\n#${r.rowIndex} ${r.nama} | ${r.no_hp} | ke-${r.pinjaman_ke||1} | ${r.tgl_cair||"-"} | ${r.pinjaman||"-"} | A: ${aStr}`;
          }
        }
        if(total===0) msg=`Tidak ada nama mengandung "${opts.nameContains}"`;
        if(msg.length>3500) msg=msg.slice(0,3500)+"...(terpotong)";
        await sock.sendMessage(remoteJid,{text:msg});
        return true;
      }
      const out = await crud.listMembers(opts);
      let msg = "";
      let total = 0;
      for (const g of out) {
        if (g.error) { msg += `\n*${g.sheet}*: error ${g.error}`; continue; }
        if (!g.rows.length) {
          if (hp) continue;
          msg += `\n*${g.sheet}*: (kosong)`;
          continue;
        }
        total += g.rows.length;
        msg += `\n*== ${g.sheet} (${g.rows.length}) ==*`;
        const slice = g.rows.slice(0, 20);
        for (const r of slice) {
          const aStr = r.installments.map((x) => (x.status ? `${x.n}:${x.status}` : `${x.n}:-`)).join(" ");
          msg += `\n#${r.rowIndex} ${r.nama} | ${r.no_hp} | pinj ${r.pinjaman || "-"} ke-${r.pinjaman_ke || 1} | cair ${r.tgl_cair || "-"} | angs ${r.angsuran || "-"} | A: ${aStr} | sisa ${r.sisa}`;
        }
        if (g.rows.length > 20) msg += `\n... +${g.rows.length - 20} lagi`;
      }
      if (hp && total === 0) {
        await sock.sendMessage(remoteJid, { text: `Tidak ditemukan hp ${hp}${hari ? ` di ${hari}` : ""}.` });
        return true;
      }
      if (!msg.trim()) msg = "Tidak ada data.";
      else msg = `📋 *Daftar Anggota*${hp ? ` hp:${hp}` : ""}${hari ? ` hari:${hari}` : ""} (total ${total})\n` + msg;
      if (msg.length > 3500) msg = msg.slice(0, 3500) + "\n...(terpotong)";
      await sock.sendMessage(remoteJid, { text: msg });
      return true;
    }

    return false;
  } catch (e) {
    logError(`Admin CRUD ${first} gagal`, e.message);
    await sock.sendMessage(remoteJid, { text: `❌ Gagal *${first}*: ${e.message}\n\n*Contoh perintah:*\n• tambah 081.. Budi 2026-10-06 5jt\n• ubah 081.. Budi Santoso\n• lunas 081.. 2\n• cek 081..  /  list Senin\n\nKetik *menu* untuk bantuan lengkap.` });
    return true;
  }
}

module.exports = { isAdmin, isAdminCommand, handleAdminCommand, getAdminList, HELP_TEXT };
