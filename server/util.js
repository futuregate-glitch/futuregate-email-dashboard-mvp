const crypto = require("crypto");

function safeEmail(val) {
  if (!val) return "";
  return String(val).trim().toLowerCase();
}

function domainOf(email) {
  const e = safeEmail(email);
  const at = e.lastIndexOf("@");
  return at >= 0 ? e.slice(at + 1) : "";
}

function normalizeSubject(subject) {
  if (!subject) return "";
  let s = String(subject).trim();
  // Remove common reply/forward prefixes repeatedly
  let prev;
  do {
    prev = s;
    s = s.replace(/^(\s*(re|fw|fwd)\s*:\s*)/i, "");
  } while (s !== prev);
  // Collapse whitespace
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

function stableHash(input) {
  return crypto.createHash("sha256").update(String(input)).digest("hex");
}

function parseIsoDate(d) {
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return null;
  return dt;
}

function pickParticipants(email) {
  const list = [];
  if (email.from) list.push(safeEmail(email.from));
  (email.to || []).forEach(x => list.push(safeEmail(x)));
  (email.cc || []).forEach(x => list.push(safeEmail(x)));
  return Array.from(new Set(list)).filter(Boolean).sort();
}

module.exports = {
  safeEmail,
  domainOf,
  normalizeSubject,
  stableHash,
  parseIsoDate,
  pickParticipants,
};
