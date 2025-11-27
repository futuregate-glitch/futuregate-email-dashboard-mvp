const express = require("express");
const path = require("path");
const { nanoid } = require("nanoid");
const { withDb, readDb } = require("./db");
const { upsertEmailsAndThreads, computeResponseMetrics, basicSummaryFromEmails } = require("./compute");

const app = express();

const PORT = Number(process.env.PORT || 3000);
const APP_BASE_URL = process.env.APP_BASE_URL || `http://localhost:${PORT}`;

const ZAPIER_SEARCH_HOOK_URL = process.env.ZAPIER_SEARCH_HOOK_URL || "";
const ZAPIER_SUMMARY_HOOK_URL = process.env.ZAPIER_SUMMARY_HOOK_URL || "";
const INCOMING_WEBHOOK_SECRET = process.env.INCOMING_WEBHOOK_SECRET || "";

app.use(express.json({ limit: "8mb" }));
app.use(express.urlencoded({ extended: true, limit: "8mb" }));

// Static UI
app.use(express.static(path.join(__dirname, "..", "public")));

// Health
app.get("/health", (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// --- API ---

// Create a search request and trigger Zapier
app.post("/api/search", async (req, res) => {
  const { keyword, dateFrom, dateTo, maxResults } = req.body || {};
  if (!keyword || String(keyword).trim().length < 2) {
    return res.status(400).json({ ok: false, error: "Keyword is required (min 2 characters)." });
  }
  if (!ZAPIER_SEARCH_HOOK_URL) {
    return res.status(500).json({ ok: false, error: "Server missing ZAPIER_SEARCH_HOOK_URL env var." });
  }

  const queryId = "q_" + nanoid(10);
  const nowIso = new Date().toISOString();
  const query = {
    id: queryId,
    keyword: String(keyword).trim(),
    dateFrom: dateFrom || null,
    dateTo: dateTo || null,
    maxResults: Number(maxResults || 50),
    status: "pending",
    createdAt: nowIso,
    updatedAt: nowIso
  };

  withDb((db) => db.queries.push(query));

  try {
    const payload = {
      queryId,
      keyword: query.keyword,
      dateFrom: query.dateFrom,
      dateTo: query.dateTo,
      maxResults: query.maxResults,
      callbackUrl: `${APP_BASE_URL}/api/zapier/results`
    };

    const r = await fetch(ZAPIER_SEARCH_HOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (!r.ok) {
      const t = await r.text().catch(() => "");
      withDb((db) => {
        const q = db.queries.find(x => x.id === queryId);
        if (q) { q.status = "failed"; q.updatedAt = new Date().toISOString(); q.error = `Zapier hook error: ${r.status} ${t}`; }
      });
      return res.status(502).json({ ok: false, queryId, error: `Zapier hook failed: ${r.status}` });
    }

    return res.json({ ok: true, queryId });
  } catch (err) {
    withDb((db) => {
      const q = db.queries.find(x => x.id === queryId);
      if (q) { q.status = "failed"; q.updatedAt = new Date().toISOString(); q.error = String(err?.message || err); }
    });
    return res.status(500).json({ ok: false, queryId, error: "Failed to call Zapier hook." });
  }
});

// Zapier posts results here
app.post("/api/zapier/results", (req, res) => {
  const secret = req.header("X-Webhook-Secret") || req.query.secret || "";
  if (INCOMING_WEBHOOK_SECRET && secret !== INCOMING_WEBHOOK_SECRET) {
    return res.status(401).json({ ok: false, error: "Unauthorized (bad webhook secret)." });
  }

  const { queryId, emails } = req.body || {};
  if (!queryId || !Array.isArray(emails)) {
    return res.status(400).json({ ok: false, error: "Invalid payload. Expected { queryId, emails: [] }" });
  }

  const result = withDb((db) => {
    const q = db.queries.find(x => x.id === queryId);
    if (!q) {
      return { ok: false, error: "Unknown queryId" };
    }
    const { emailIdsCreated, threadIdsTouched } = upsertEmailsAndThreads(db, queryId, emails);

    q.status = "complete";
    q.updatedAt = new Date().toISOString();
    q.receivedCount = (q.receivedCount || 0) + emails.length;
    q.createdMessages = (q.createdMessages || 0) + emailIdsCreated.length;

    return { ok: true, emailIdsCreated, threadIdsTouched };
  });

  return res.json(result);
});

// List queries
app.get("/api/queries", (req, res) => {
  const db = readDb();
  const list = [...db.queries].sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 50);
  res.json({ ok: true, queries: list });
});

app.get("/api/queries/:id", (req, res) => {
  const db = readDb();
  const q = db.queries.find(x => x.id === req.params.id);
  if (!q) return res.status(404).json({ ok:false, error: "Not found" });
  res.json({ ok:true, query: q });
});

// Threads for a query
app.get("/api/threads", (req, res) => {
  const { queryId } = req.query;
  const db = readDb();
  const threads = db.threads
    .filter(t => !queryId || t.queryId === queryId)
    .sort((a,b) => new Date(b.lastAt) - new Date(a.lastAt));
  res.json({ ok: true, threads });
});

// Thread detail (emails + metrics + summary)
app.get("/api/threads/:id", (req, res) => {
  const db = readDb();
  const thread = db.threads.find(t => t.id === req.params.id);
  if (!thread) return res.status(404).json({ ok:false, error: "Thread not found" });

  const emails = db.emails
    .filter(m => m.threadId === thread.id)
    .sort((a,b) => new Date(a.sentAt) - new Date(b.sentAt));

  const metrics = computeResponseMetrics(emails);

  const summary = db.summaries
    .filter(s => s.threadId === thread.id)
    .sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt))[0] || null;

  res.json({ ok: true, thread, emails, metrics, summary });
});

// Summarize: either call Zapier hook or do basic local summary
app.post("/api/threads/:id/summarize", async (req, res) => {
  const db = readDb();
  const thread = db.threads.find(t => t.id === req.params.id);
  if (!thread) return res.status(404).json({ ok:false, error: "Thread not found" });

  const emails = db.emails
    .filter(m => m.threadId === thread.id)
    .sort((a,b) => new Date(a.sentAt) - new Date(b.sentAt));

  // If a Zapier summary hook exists, call it
  if (ZAPIER_SUMMARY_HOOK_URL) {
    try {
      const payload = {
        threadId: thread.id,
        queryId: thread.queryId,
        subject: thread.subject,
        messages: emails.map(m => ({
          id: m.id,
          from: m.from,
          to: m.to,
          cc: m.cc,
          sentAt: m.sentAt,
          direction: m.direction,
          snippet: m.snippet,
          bodyText: m.bodyText
        })),
        callbackUrl: `${APP_BASE_URL}/api/zapier/summary`
      };

      const r = await fetch(ZAPIER_SUMMARY_HOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      if (!r.ok) {
        const t = await r.text().catch(() => "");
        return res.status(502).json({ ok:false, error:`Zapier summary hook failed (${r.status}). ${t}` });
      }

      // Some users prefer Zapier to post summary back; if so, UI can refresh.
      // Also allow immediate response if Zap returns JSON directly.
      let data = null;
      try { data = await r.json(); } catch (_) {}
      if (data && (data.summary || data.actionItems)) {
        const saved = withDb((db2) => {
          const s = {
            id: "s_" + nanoid(10),
            threadId: thread.id,
            queryId: thread.queryId,
            summary: String(data.summary || ""),
            actionItems: Array.isArray(data.actionItems) ? data.actionItems : [],
            createdAt: new Date().toISOString(),
            source: "zapier"
          };
          db2.summaries.push(s);
          return s;
        });
        return res.json({ ok:true, summary: saved, mode:"zapier-direct" });
      }

      return res.json({ ok:true, mode:"zapier-called", note:"Zapier hook called. If your Zap posts summary back, refresh in a moment." });
    } catch (err) {
      return res.status(500).json({ ok:false, error: String(err?.message || err) });
    }
  }

  // Local basic summary (fast MVP)
  const local = basicSummaryFromEmails(emails);
  const saved = withDb((db2) => {
    const s = {
      id: "s_" + nanoid(10),
      threadId: thread.id,
      queryId: thread.queryId,
      summary: local.summary,
      actionItems: local.actionItems,
      createdAt: new Date().toISOString(),
      source: "local"
    };
    db2.summaries.push(s);
    return s;
  });

  return res.json({ ok:true, summary: saved, mode:"local" });
});

// Optional endpoint: Zapier can post the summary result back here
app.post("/api/zapier/results", (req, res) => {
  const secret = req.header("X-Webhook-Secret") || req.query.secret || "";
  if (INCOMING_WEBHOOK_SECRET && secret !== INCOMING_WEBHOOK_SECRET) {
    return res.status(401).json({ ok: false, error: "Unauthorized (bad webhook secret)." });
  }

  let body = req.body;

  // ✅ Handle: Zapier sends { payload: "{...json...}" }
  if (body && typeof body === "object" && typeof body.payload === "string") {
    try { body = JSON.parse(body.payload); } catch (e) {}
  }

  // ✅ Handle: Zapier sends raw JSON as a string
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch (e) {}
  }

  const { queryId, emails } = body || {};
  if (!queryId || !Array.isArray(emails)) {
    return res.status(400).json({ ok: false, error: "Invalid payload. Expected { queryId, emails: [] }" });
  }

  const result = withDb((db) => {
    const q = db.queries.find(x => x.id === queryId);
    if (!q) return { ok: false, error: "Unknown queryId" };

    const { emailIdsCreated, threadIdsTouched } = upsertEmailsAndThreads(db, queryId, emails);

    q.status = "complete";
    q.updatedAt = new Date().toISOString();
    q.receivedCount = (q.receivedCount || 0) + emails.length;
    q.createdMessages = (q.createdMessages || 0) + emailIdsCreated.length;

    return { ok: true, emailIdsCreated, threadIdsTouched };
  });

  return res.json(result);
});


app.listen(PORT, () => {
  console.log(`MVP Email Dashboard running on ${APP_BASE_URL}`);
});
