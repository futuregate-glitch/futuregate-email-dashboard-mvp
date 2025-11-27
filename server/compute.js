const { domainOf, normalizeSubject, stableHash, parseIsoDate, pickParticipants, safeEmail } = require("./util");
const { nanoid } = require("nanoid");

const STAFF_DOMAIN = (process.env.STAFF_DOMAIN || "futuregate.info").toLowerCase();

function classifyDirection(fromEmail) {
  return domainOf(fromEmail) === STAFF_DOMAIN ? "staff" : "client";
}

function threadKeyFor(email) {
  if (email.conversationId) return `conv:${email.conversationId}`;
  const subject = normalizeSubject(email.subject || "");
  const participants = pickParticipants(email);
  const key = stableHash(subject + "|" + participants.join(","));
  return `fallback:${key}`;
}

function upsertEmailsAndThreads(db, queryId, incomingEmails) {
  const nowIso = new Date().toISOString();

  const emailIdsCreated = [];
  const threadIdsTouched = new Set();

  for (const e of incomingEmails) {
    const sentAt = parseIsoDate(e.sentAt || e.dateTime || e.receivedAt || e.receivedTime || e.sentTime);
    if (!sentAt) continue;

    const from = safeEmail(e.from || (e.fromEmail && e.fromEmail.address) || e.sender);
    const to = Array.isArray(e.to) ? e.to.map(safeEmail) : (e.to ? [safeEmail(e.to)] : []);
    const cc = Array.isArray(e.cc) ? e.cc.map(safeEmail) : (e.cc ? [safeEmail(e.cc)] : []);

    const direction = classifyDirection(from);
    const messageId = String(e.messageId || e.id || e.internetMessageId || "").trim();

    // Dedup: messageId within same query or globally
    const already = db.emails.find(x => x.messageId && messageId && x.messageId === messageId);
    if (already) {
      threadIdsTouched.add(already.threadId);
      continue;
    }

    const key = threadKeyFor({ subject: e.subject, conversationId: e.conversationId, from, to, cc });
    let thread = db.threads.find(t => t.key === key && t.queryId === queryId);
    if (!thread) {
      thread = {
        id: "t_" + nanoid(10),
        queryId,
        key,
        conversationId: e.conversationId || null,
        subject: normalizeSubject(e.subject || "(no subject)"),
        participants: Array.from(new Set([from, ...to, ...cc])).filter(Boolean).sort(),
        firstAt: sentAt.toISOString(),
        lastAt: sentAt.toISOString(),
        createdAt: nowIso
      };
      db.threads.push(thread);
    } else {
      // update thread window
      const first = new Date(thread.firstAt);
      const last = new Date(thread.lastAt);
      if (sentAt < first) thread.firstAt = sentAt.toISOString();
      if (sentAt > last) thread.lastAt = sentAt.toISOString();
      // also merge participants
      const merged = Array.from(new Set([...(thread.participants || []), from, ...to, ...cc])).filter(Boolean).sort();
      thread.participants = merged;
      // update subject if current is empty-ish
      if (!thread.subject || thread.subject === "(no subject)") {
        thread.subject = normalizeSubject(e.subject || "(no subject)");
      }
    }

    const email = {
      id: "m_" + nanoid(10),
      queryId,
      threadId: thread.id,
      messageId: messageId || null,
      conversationId: e.conversationId || null,
      subject: e.subject || "",
      from,
      to,
      cc,
      sentAt: sentAt.toISOString(),
      snippet: (e.snippet || e.preview || "").slice(0, 500),
      bodyHtml: e.bodyHtml || e.body || "",
      bodyText: e.bodyText || "",
      direction,
      createdAt: nowIso
    };

    db.emails.push(email);
    emailIdsCreated.push(email.id);
    threadIdsTouched.add(thread.id);
  }

  return { emailIdsCreated, threadIdsTouched: Array.from(threadIdsTouched) };
}

function computeResponseMetrics(emails) {
  // emails: already filtered for one thread, unsorted OK
  const sorted = [...emails].sort((a,b) => new Date(a.sentAt) - new Date(b.sentAt));

  const metrics = [];
  for (let i = 0; i < sorted.length; i++) {
    const msg = sorted[i];
    if (msg.direction !== "client") continue;

    // find first subsequent staff reply
    let reply = null;
    for (let j = i + 1; j < sorted.length; j++) {
      if (sorted[j].direction === "staff") { reply = sorted[j]; break; }
    }
    if (!reply) {
      metrics.push({
        clientMessageId: msg.id,
        staffReplyId: null,
        responseSeconds: null
      });
      continue;
    }
    const diffMs = new Date(reply.sentAt) - new Date(msg.sentAt);
    metrics.push({
      clientMessageId: msg.id,
      staffReplyId: reply.id,
      responseSeconds: Math.max(0, Math.floor(diffMs / 1000))
    });
  }

  // aggregate
  const responded = metrics.filter(m => typeof m.responseSeconds === "number");
  const avgSeconds = responded.length
    ? Math.round(responded.reduce((s,m) => s + m.responseSeconds, 0) / responded.length)
    : null;

  return { perClient: metrics, averageSeconds: avgSeconds };
}

function basicSummaryFromEmails(emails) {
  const sorted = [...emails].sort((a,b) => new Date(a.sentAt) - new Date(b.sentAt));
  const subject = sorted[0]?.subject || "(no subject)";
  const last = sorted[sorted.length - 1];

  const participants = Array.from(new Set(sorted.flatMap(e => [e.from, ...(e.to||[]), ...(e.cc||[])]))).filter(Boolean);
  const clientCount = sorted.filter(e => e.direction === "client").length;
  const staffCount = sorted.filter(e => e.direction === "staff").length;

  // Extract a few key snippets
  const snippets = sorted
    .map(e => (e.snippet || e.bodyText || "").trim())
    .filter(Boolean)
    .slice(-8);

  const bullets = [];
  bullets.push(`Subject: ${subject}`);
  bullets.push(`Messages: ${sorted.length} (client: ${clientCount}, staff: ${staffCount})`);
  bullets.push(`Latest message at: ${last?.sentAt || "N/A"}`);
  if (participants.length) bullets.push(`Participants: ${participants.slice(0, 8).join(", ")}${participants.length>8?"…":""}`);
  if (snippets.length) {
    bullets.push("Key points (auto-extracted):");
    for (const s of snippets.slice(0, 5)) bullets.push(`- ${s.slice(0, 160)}${s.length>160?"…":""}`);
  }

  return {
    summary: bullets.join("\n"),
    actionItems: []
  };
}

module.exports = {
  STAFF_DOMAIN,
  classifyDirection,
  upsertEmailsAndThreads,
  computeResponseMetrics,
  basicSummaryFromEmails
};
