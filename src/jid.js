const { digitsOnly } = require("./sheets");

const lidToPn = new Map();
const pnToLid = new Map();

function baseJid(jid) {
  return String(jid || "").split("@")[0].split(":")[0];
}
function isLidJid(jid) {
  return /@lid$/i.test(String(jid || ""));
}
function registerLid(lid, pn) {
  if (!lid || !pn) return;
  const l = baseJid(lid);
  const p = baseJid(pn);
  if (!l || !p) return;
  lidToPn.set(l, p);
  pnToLid.set(p, l);
}
function lookupLid(lid) {
  return lidToPn.get(baseJid(lid)) || null;
}
function lookupPn(pn) {
  return pnToLid.get(baseJid(pn)) || null;
}

/**
 * Ambil nomor HP asli dari pesan Baileys.
 * WhatsApp kini memakai LID (mis. 186479611531362@lid) sehingga
 * remoteJid bukan nomor HP. Prioritaskan senderPn/participantPn/remoteJidAlt.
 */
function resolveSender(msg) {
  const key = (msg && msg.key) || {};
  const remoteJid = key.remoteJid || "";
  const candidates = [
    key.senderPn,
    key.participantPn,
    key.remoteJidAlt,
    key.participantAlt,
  ].filter(Boolean).map(baseJid);

  let lid = isLidJid(remoteJid) ? baseJid(remoteJid) : null;
  if (!lid) {
    const fromAlt = [key.remoteJidAlt, key.participant].filter(Boolean).map(baseJid).find(isLidJid);
    if (fromAlt) lid = baseJid(fromAlt);
  }

  let phone = candidates.find((c) => !isLidJid(c) && digitsOnly(c).length >= 9) || null;
  if (!phone && lid) phone = lookupLid(lid);
  if (!phone && !lid && !isLidJid(remoteJid)) {
    const b = baseJid(remoteJid);
    if (digitsOnly(b).length >= 9) phone = b;
  }
  if (phone && lid) registerLid(lid, phone);

  return {
    jid: remoteJid,
    lid,
    phone,
    digits: phone ? digitsOnly(phone) : (lid || baseJid(remoteJid)),
    pushName: (msg && (msg.pushName || msg.verifiedBizName)) || "",
  };
}

module.exports = { resolveSender, registerLid, lookupLid, lookupPn, isLidJid, baseJid, lidToPn, pnToLid };