const fs = require("fs");
const path = require("path");

const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), "db.json");

function ensureDb() {
  if (!fs.existsSync(DB_PATH)) {
    const initial = {
      queries: [],
      threads: [],
      emails: [],
      summaries: []
    };
    atomicWrite(JSON.stringify(initial, null, 2));
  }
}

function readDb() {
  ensureDb();
  const raw = fs.readFileSync(DB_PATH, "utf-8");
  return JSON.parse(raw);
}

function atomicWrite(content) {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = DB_PATH + ".tmp";
  fs.writeFileSync(tmp, content, "utf-8");
  fs.renameSync(tmp, DB_PATH);
}

function writeDb(db) {
  atomicWrite(JSON.stringify(db, null, 2));
}

function withDb(fn) {
  const db = readDb();
  const result = fn(db);
  writeDb(db);
  return result;
}

module.exports = { DB_PATH, readDb, writeDb, withDb };
