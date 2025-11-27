/**
 * Future Gate - Email Dashboard MVP
 * server/server.js
 *
 * Features:
 * - Serves the UI from /public
 * - Creates searches and triggers Zapier catch-hook
 * - Receives results from Zapier (supports BOTH:
 *      1) raw JSON: { queryId, emails: [...] }
 *      2) wrapper:  { payload: "{...json...}" }  <-- your current Zapier setup
 *   )
 * - Stores data in a local JSON db (db.json)
 */

const express = require("express");
const path = require("path");
const fs = require("fs");

// -------------------- Config --------------------
const PORT = process.env.PORT || 3000;
const APP_BASE_URL = (process.env.APP_BASE_URL || "").replace(/\/+$/, ""); // no trailing slash
const ZAPIER_SEARCH_HOOK_URL = process.env.ZAPIER_SEARCH_HOOK_URL || "";
const ZAPIER_SUMMARY_HOOK_URL = process.env.ZAPIER_SUMMARY_HOOK_URL || "";
const INCOMING_WEBHOOK_SECRET = process.env.INCOMING_WEBHOOK_SECRET || "";
const STAFF_DOMAIN = (process.env.STAFF_DOMAIN || "futuregate.info").toLowerCase();
const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), "db.json");

// Node 18+ has global fetch; for older runtimes, you can install node-fetch.
const fetchFn =
  typeof fetch === "function"
    ? fetch
    : (...args) => import("node-fetch").then(({ default: f }) => f(...args));

// -------------------- App --------------------
const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));

// Serve UI
app.use(express.static(path.join(process.cwd(), "public")));

// -------------------- DB Helpers --------------------
function ensureDbFile() {
  if (!fs.existsSync(DB_PATH)) {
    const empty = { queries: [], emails: [], threads: [] };
    fs.writeFileSync(DB_PATH, JSON.stringify(empty, null, 2), "utf-8");
  }
}

function readDb() {
  ensureDbFile();
  const raw = fs.readFileSync(DB_PATH, "utf-8");
  try {
    const db = JSON.parse(raw);
    if (!db.queries) db.queries = [];
    if (!db.emails) db.emails = [];
    if (!db.threads) db.threads = [];
    return db;
  } catch {
    const empty = { queries: [], emails: [], threads: [] };
    fs.writeFileSync(DB_PATH, JSON.stringify(empty, null, 2), "utf-8");
    return empty;
  }
}

function writeDb(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), "utf-8");
}

function withDb(mutatorFn) {
  const db = readDb();
  const result = mutatorFn(db);
  writeDb(db);
  return result;
}

function makeId(prefix = "id") {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function normalizeSubject(subject = "") {
  // Remove common prefixes like RE:, FW:, FWD:
  return String(subject)
    .trim()
    .replace(/^\s*(re|fw|fwd)\s*:\s*/gi, "")
    .trim()
    .toLowerCase();
}

function parseDateSafe(s) {
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function isStaffEmail(email) {
  if (!email) return false;
  const e = String(email).trim().toLowerCase();
  return e.endsWith("@" + STAFF_DOMAIN);
}

function upsertEmailsAndThreads(db, queryId, emails) {
  const emailIdsCreated = [];
  const threadIdsTouched = new Set();

  // Indexes for speed
  const emailByMessageId = new Map(db.emails.map((e) => [e.messageId, e]));
  const threadByKey = new Map(db.threads.map((t) => [t.key, t]));

  for (const item of emails) {
    const messageId = item?.messageId ? String(item.messageId) : "";
    if (!messageId) continue;

    const existing = emailByMessageId.get(messageId);
    if (!existing) {
      const emailRec = {
        id: makeId("msg"),
        queryId,
        messageId,
        conversationId: item.conversationId || null,
        subject: item.subject || "",
        from: item.from || "",
        to: Array.isArray(item.to) ? item.to : (item.to ? [item.to] : []),
        cc: Array.isArray(item.cc) ? item.cc : [],
        sentAt: item.sentAt || "",
        snippet: item.snippet || ""
      };
      db.emails.push(emailRec);
      emailByMessageId.set(messageId, emailRec);
      emailIdsCreated.push(emailRec.id);
    }

    const subjectNorm = normalizeSubject(item.subject || "");
    const threadKey = item.conversationId
      ? `conv:${item.conversationId}`
      : `subj:${subjectNorm || "no-subject"}`;

    let thread = threadByKey.get(threadKey);
    if (!thread) {
      thread = {
        id: makeId("thr"),
        queryId,
        key: threadKey,
        subject: item.subject || "(No subject)",
        subjectNorm,
        participants: Array.from(
          new Set(
            [item.from, ...(Array.isArray(item.to) ? item.to : [])]
              .filter(Boolean)
              .map((x) => String(x).toLowerCase())
          )
        ),
        firstAt: item.sentAt || "",
        lastAt: item.sentAt || "",
        messageIds: [messageId]
      };
      db.threads.push(thread);
      threadByKey.set(threadKey, thread);
    } else {
      // Update thread info
      if (!thread.messageIds.includes(messageId)) thread.messageIds.push(messageId);

      // Update first/last times
      const cur = parseDateSafe(item.sentAt);
      const first = parseDateSafe(thread.firstAt);
      const last = parseDateSafe(thread.lastAt);

      if (cur) {
        if (!first || cur < first) thread.firstAt = item.sentAt;
        if (!last || cur > last) thread.lastAt = item.sentAt;
      }

      // Update participants
      const p = new Set(thread.participants || []);
      if (item.from) p.add(String(item.from).toLowerCase());
      const toList = Array.isArray(item.to) ? item.to : (item.to ? [item.to] : []);
      for (const t of toList) if (t) p.add(String(t).toLowerCase());
      thread.participants = Array.from(p);
    }

    threadIdsTouched.add(thread.id);
  }

  return { emailIdsCreated, threadIdsTouched: Array.from(threadIdsTouched) };
}

function computeResponseMetrics(messages) {
  // metrics: response time from first non-staff email to first staff reply after it
  // messages must be sorted by sentAt asc
  const sorted = [...messages].sort((a, b) => {
    const da = parseDateSafe(a.sentAt)?.getTime() ?? 0;
    const db = parseDateSafe(b.sentAt)?.getTime() ?? 0;
    return da - db;
  });

  let firstClient = null;
  let firstStaffReply = null;

  for (const m of sorted) {
    const from = (m.from || "").toLowerCase();
    const isStaff = isStaffEmail(from);
    const dt = parseDateSafe(m.sentAt);

    if (!dt) continue;

    if (!isStaff && !firstClient) {
      firstClient = dt;
      continue;
    }

    if (firstClient && isStaff) {
      firstStaffReply = dt;
      break;
    }
  }

  if (!firstClient) {
    return { hasClientEmail: false, hasStaffReply: false, responseMinutes: null };
  }

  if (!firstStaffReply) {
    return { hasClientEmail: true, hasStaffReply: false, responseMinutes: null };
  }

  const diffMs = firstStaffReply.getTime() - firstClient.getTime();
  const minutes = Math.round(diffMs / 60000);
  return { hasClientEmail: true, hasStaffReply: true, responseMinutes: minutes };
}

function basicSummary(messages) {
  // Very simple summary: list top subjects/senders and last message snippet
  const sorted = [...messages].sort((a, b) => {
    const da = parseDateSafe(a.sentAt)?.getTime() ?? 0;
    const db = parseDateSafe(b.sentAt)?.getTime() ?? 0;
    return da - db;
  });

  const senders = new Map();
  for (const m of sorted) {
    const from = (m.from || "").toLowerCase();
    if (!from) continue;
    senders.set(from, (senders.get(from) || 0) + 1);
  }

  const topSenders = [...senders.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([k, v]) => `${k} (${v})`);

  const last = sorted[sorted.length - 1];
  const lastLine = last ? `${last.from || "Unknown"}: ${String(last.snippet || "").slice(0, 200)}` : "";

  return {
    messageCount: sorted.length,
    topSenders,
    lastUpdate: last?.sentAt || null,
    lastLine
  };
}

// -------------------- Routes --------------------
app.get("/health", (req, res) => res.json({ ok: true }));

// App state API
app.get("/api/state", (req, res) => {
  const db = readDb();
  // Sort queries newest-first for UI
  const queries = [...db.queries].sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  const threads = [...db.threads].sort((a, b) => (b.lastAt || "").localeCompare(a.lastAt || ""));
  res.json({ ok: true, queries, threads });
});

app.get("/api/thread/:threadId", (req, res) => {
  const { threadId } = req.params;
  const db = readDb();
  const thread = db.threads.find((t) => t.id === threadId);
  if (!thread) return res.status(404).json({ ok: false, error: "Thread not found" });

  const msgs = db.emails
    .filter((m) => thread.messageIds.includes(m.messageId))
    .sort((a, b) => (a.sentAt || "").localeCompare(b.sentAt || ""));

  const metrics = computeResponseMetrics(msgs);
  const summary = basicSummary(msgs);

  res.json({ ok: true, thread, messages: msgs, metrics, summary });
});

// Trigger search -> sends a payload to Zapier catch hook
app.post("/api/search", async (req, res) => {
  const keyword = String(req.body.keyword || "").trim();
  const dateFrom = req.body.dateFrom ? String(req.body.dateFrom) : "";
  const dateTo = req.body.dateTo ? String(req.body.dateTo) : "";
  const maxResults = Number(req.body.maxResults || 50);

  if (!keyword) return res.status(400).json({ ok: false, error: "Keyword is required." });
  if (!ZAPIER_SEARCH_HOOK_URL) return res.status(500).json({ ok: false, error: "ZAPIER_SEARCH_HOOK_URL is not set." });
  if (!APP_BASE_URL) return res.status(500).json({ ok: false, error: "APP_BASE_URL is not set." });

  const queryId = makeId("q");
  const callbackUrl = `${APP_BASE_URL}/api/zapier/results`;

  withDb((db) => {
    db.queries.push({
      id: queryId,
      keyword,
      dateFrom,
      dateTo,
      maxResults,
      status: "pending",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      receivedCount: 0,
      createdMessages: 0
    });
    return true;
  });

  // Send to Zapier
  const payload = { queryId, keyword, dateFrom, dateTo, maxResults, callbackUrl };

  try {
    const r = await fetchFn(ZAPIER_SEARCH_HOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const text = await r.text().catch(() => "");
    if (!r.ok) {
      withDb((db) => {
        const q = db.queries.find((x) => x.id === queryId);
        if (q) {
          q.status = "error";
          q.updatedAt = new Date().toISOString();
          q.error = `Zapier hook failed: ${r.status} ${text.slice(0, 200)}`;
        }
      });
      return res.status(502).json({ ok: false, error: "Zapier hook call failed", detail: text.slice(0, 200), queryId });
    }

    return res.json({ ok: true, queryId });
  } catch (e) {
    withDb((db) => {
      const q = db.queries.find((x) => x.id === queryId);
      if (q) {
        q.status = "error";
        q.updatedAt = new Date().toISOString();
        q.error = String(e?.message || e);
      }
    });
    return res.status(500).json({ ok: false, error: "Failed to call Zapier hook", queryId });
  }
});

/**
 * Zapier posts results here.
 * Supports:
 * 1) Direct body: { queryId, emails: [...] }
 * 2) Wrapper body: { payload: "{ \"queryId\":..., \"emails\":... }" }  <-- your current Zapier Step 4
 */
app.post("/api/zapier/results", (req, res) => {
  // Shared secret check (optional but recommended)
  const secret = req.header("X-Webhook-Secret") || "";
  if (INCOMING_WEBHOOK_SECRET && secret !== INCOMING_WEBHOOK_SECRET) {
    return res.status(401).json({ ok: false, error: "Unauthorized (bad webhook secret)." });
  }

  const safeJsonParse = (s) => {
    try { return JSON.parse(s); } catch { return null; }
  };

  let body = req.body;

  // If Zapier sends { payload: "{...json...}" }
  if (body && typeof body === "object" && typeof body.payload === "string") {
    const parsed = safeJsonParse(body.payload);
    if (parsed) body = parsed;
  }

  // If body itself is a JSON string (rare)
  if (typeof body === "string") {
    const parsed = safeJsonParse(body);
    if (parsed) body = parsed;
  }

  const queryId = body?.queryId;
  const emails = body?.emails;

  if (!queryId || !Array.isArray(emails)) {
    return res.status(400).json({
      ok: false,
      error: "Invalid payload. Expected { queryId, emails: [] }",
      receivedType: typeof body,
      receivedKeys: body && typeof body === "object" ? Object.keys(body) : null
    });
  }

  const result = withDb((db) => {
    const q = db.queries.find((x) => x.id === queryId);
    if (!q) return { ok: false, error: "Unknown queryId" };

    const { emailIdsCreated, threadIdsTouched } = upsertEmailsAndThreads(db, queryId, emails);

    q.status = "complete";
    q.updatedAt = new Date().toISOString();
    q.receivedCount = (q.receivedCount || 0) + emails.length;
    q.createdMessages = (q.createdMessages || 0) + emailIdsCreated.length;

    return { ok: true, emailIdsCreated, threadIdsTouched, received: emails.length };
  });

  return res.json(result);
});

// Optional: summarize a specific thread. Uses local summary by default, or Zapier hook if configured.
app.post("/api/summarize", async (req, res) => {
  const threadId = String(req.body.threadId || "");
  if (!threadId) return res.status(400).json({ ok: false, error: "threadId is required" });

  const db = readDb();
  const thread = db.threads.find((t) => t.id === threadId);
  if (!thread) return res.status(404).json({ ok: false, error: "Thread not found" });

  const msgs = db.emails
    .filter((m) => thread.messageIds.includes(m.messageId))
    .sort((a, b) => (a.sentAt || "").localeCompare(b.sentAt || ""));

  // If Zapier summary hook exists, call it; otherwise use basic summary
  if (ZAPIER_SUMMARY_HOOK_URL) {
    try {
      const payload = { threadId, subject: thread.subject, messages: msgs };
      const r = await fetchFn(ZAPIER_SUMMARY_HOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const text = await r.text();
      if (!r.ok) {
        return res.status(502).json({ ok: false, error: "Zapier summary hook failed", detail: text.slice(0, 300) });
      }
      // Expect Zapier to return JSON { summary: "..." } or plain text; handle both
      const maybeJson = (() => { try { return JSON.parse(text); } catch { return null; } })();
      return res.json({ ok: true, summary: maybeJson?.summary || text });
    } catch (e) {
      return res.status(500).json({ ok: false, error: "Failed to call Zapier summary hook", detail: String(e?.message || e) });
    }
  }

  return res.json({ ok: true, summary: basicSummary(msgs) });
});

// Fallback to UI for any unknown route (SPA style)
app.get("*", (req, res) => {
  res.sendFile(path.join(process.cwd(), "public", "index.html"));
});

// -------------------- Start --------------------
app.listen(PORT, () => {
  console.log(`Future Gate Email Dashboard MVP running on port ${PORT}`);
  console.log(`DB_PATH: ${DB_PATH}`);
});
