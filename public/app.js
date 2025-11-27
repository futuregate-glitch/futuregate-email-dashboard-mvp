const el = (id) => document.getElementById(id);

const state = {
  activeQueryId: null,
  threads: [],
  activeThreadId: null
};

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = { ok: false, raw: text }; }
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

function fmt(dtIso) {
  if (!dtIso) return "";
  try {
    const d = new Date(dtIso);
    return d.toLocaleString();
  } catch { return dtIso; }
}

function fmtDuration(seconds) {
  if (seconds === null || seconds === undefined) return "—";
  const s = Number(seconds);
  if (!Number.isFinite(s)) return "—";
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = (m / 60);
  if (h < 24) return `${h.toFixed(1)} h`;
  const d = h / 24;
  return `${d.toFixed(1)} d`;
}

async function refreshHealth() {
  try {
    await api("/health");
    el("healthPill").textContent = "Online";
    el("healthPill").style.color = "var(--good)";
  } catch (e) {
    el("healthPill").textContent = "Offline";
    el("healthPill").style.color = "var(--bad)";
  }
}

function renderQueries(queries) {
  const box = el("queries");
  box.innerHTML = "";
  if (!queries.length) {
    box.innerHTML = `<div class="hint">No searches yet.</div>`;
    return;
  }
  for (const q of queries) {
    const div = document.createElement("div");
    div.className = "queryItem";
    const status = q.status || "pending";
    div.innerHTML = `
      <div class="top">
        <div class="k">${escapeHtml(q.keyword)}</div>
        <span class="badge ${status}">${status}</span>
      </div>
      <div class="meta">
        ${q.dateFrom ? `From ${escapeHtml(q.dateFrom)} ` : ""}${q.dateTo ? `to ${escapeHtml(q.dateTo)} ` : ""}
        • created ${fmt(q.createdAt)}
        ${q.createdMessages ? ` • new messages: ${q.createdMessages}` : ""}
      </div>
      ${q.error ? `<div class="meta" style="color: var(--bad)">Error: ${escapeHtml(q.error)}</div>` : ""}
    `;
    div.addEventListener("click", () => {
      state.activeQueryId = q.id;
      loadThreads();
    });
    box.appendChild(div);
  }
}

function renderThreads(threads) {
  const box = el("threads");
  box.innerHTML = "";
  if (!threads.length) {
    box.innerHTML = `<div class="hint" style="padding:12px">No threads yet. Run a search.</div>`;
    return;
  }

  const filter = (el("threadFilter").value || "").trim().toLowerCase();

  for (const t of threads) {
    const subject = t.subject || "(no subject)";
    const participants = (t.participants || []).slice(0, 3).join(", ");
    const matches = !filter || subject.toLowerCase().includes(filter) || participants.toLowerCase().includes(filter);
    if (!matches) continue;

    const div = document.createElement("div");
    div.className = "thread" + (state.activeThreadId === t.id ? " active" : "");
    div.innerHTML = `
      <div class="title">${escapeHtml(subject)}</div>
      <div class="subline">
        <span>${escapeHtml(participants)}${(t.participants||[]).length>3 ? "…" : ""}</span>
        <span>${fmt(t.lastAt)}</span>
      </div>
    `;
    div.addEventListener("click", () => selectThread(t.id));
    box.appendChild(div);
  }
}

function escapeHtml(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function loadQueries() {
  const data = await api("/api/queries");
  renderQueries(data.queries || []);
  // auto-select the latest if none selected
  if (!state.activeQueryId && data.queries?.[0]?.id) {
    state.activeQueryId = data.queries[0].id;
  }
}

async function loadThreads() {
  const queryId = state.activeQueryId;
  if (!queryId) return;
  const data = await api(`/api/threads?queryId=${encodeURIComponent(queryId)}`);
  state.threads = data.threads || [];
  renderThreads(state.threads);
}

async function selectThread(threadId) {
  state.activeThreadId = threadId;
  renderThreads(state.threads);
  el("summarizeBtn").disabled = false;

  const data = await api(`/api/threads/${encodeURIComponent(threadId)}`);
  renderThreadDetail(data);
}

function renderThreadDetail({ thread, emails, metrics, summary }) {
  el("threadMeta").innerHTML = `
    <div><b>Subject:</b> ${escapeHtml(thread.subject || "(no subject)")}</div>
    <div><b>Participants:</b> ${escapeHtml((thread.participants || []).join(", "))}</div>
    <div><b>Window:</b> ${fmt(thread.firstAt)} → ${fmt(thread.lastAt)}</div>
  `;

  el("summaryBox").textContent = summary?.summary || "(No summary yet. Click Summarize.)";

  // metrics
  const avg = metrics?.averageSeconds ?? null;
  const per = metrics?.perClient ?? [];
  let html = `
    <div class="rowm"><span>Average response</span><span>${avg === null ? "—" : fmtDuration(avg)}</span></div>
    <div class="rowm"><span>Client messages</span><span>${per.length}</span></div>
  `;
  const pending = per.filter(x => x.responseSeconds === null).length;
  html += `<div class="rowm"><span>No reply yet</span><span>${pending}</span></div>`;

  // show a few worst response times
  const responded = per.filter(x => typeof x.responseSeconds === "number")
    .sort((a,b) => b.responseSeconds - a.responseSeconds)
    .slice(0, 5);

  if (responded.length) {
    html += `<div style="margin-top:10px; font-weight:700">Slowest replies</div>`;
    for (const r of responded) {
      html += `<div class="rowm"><span>${escapeHtml(r.clientMessageId)}</span><span>${fmtDuration(r.responseSeconds)}</span></div>`;
    }
  }

  el("metricsBox").innerHTML = html;

  // messages
  const box = el("messages");
  box.innerHTML = "";
  for (const m of emails) {
    const div = document.createElement("div");
    div.className = "msg " + (m.direction || "");
    div.innerHTML = `
      <div class="head">
        <span class="from">${escapeHtml(m.from)}</span>
        <span>${fmt(m.sentAt)}</span>
      </div>
      <div class="body">
        <div>${escapeHtml(m.subject || "")}</div>
        ${m.snippet ? `<div class="snippet">${escapeHtml(m.snippet)}</div>` : ""}
      </div>
    `;
    box.appendChild(div);
  }
}

async function doSearch(e) {
  e.preventDefault();
  const keyword = el("keyword").value.trim();
  const dateFrom = el("dateFrom").value || null;
  const dateTo = el("dateTo").value || null;
  const maxResults = Number(el("maxResults").value || 50);

  const btn = e.submitter;
  btn.disabled = true;
  btn.textContent = "Searching…";

  try {
    const data = await api("/api/search", {
      method: "POST",
      body: JSON.stringify({ keyword, dateFrom, dateTo, maxResults })
    });
    state.activeQueryId = data.queryId;
    await loadQueries();
    await loadThreads();
    alert("Search triggered. If Zapier is set correctly, results will appear after Zap posts back.");
  } catch (err) {
    alert(err.message || String(err));
  } finally {
    btn.disabled = false;
    btn.textContent = "Search";
  }
}

async function summarizeActiveThread() {
  if (!state.activeThreadId) return;
  const btn = el("summarizeBtn");
  btn.disabled = true;
  btn.textContent = "Summarizing…";
  try {
    const data = await api(`/api/threads/${encodeURIComponent(state.activeThreadId)}/summarize`, {
      method: "POST",
      body: JSON.stringify({})
    });
    // Refresh detail
    await selectThread(state.activeThreadId);
  } catch (err) {
    alert(err.message || String(err));
  } finally {
    btn.disabled = false;
    btn.textContent = "Summarize";
  }
}

async function boot() {
  await refreshHealth();
  await loadQueries();
  await loadThreads();

  el("searchForm").addEventListener("submit", doSearch);
  el("refreshBtn").addEventListener("click", async () => {
    await loadQueries();
    await loadThreads();
  });
  el("threadFilter").addEventListener("input", () => renderThreads(state.threads));
  el("summarizeBtn").addEventListener("click", summarizeActiveThread);

  // light auto-refresh (manual is fine, but this helps after Zapier posts results)
  setInterval(async () => {
    try {
      await loadQueries();
      await loadThreads();
      if (state.activeThreadId) await selectThread(state.activeThreadId);
    } catch {}
  }, 12000);
}

boot();
