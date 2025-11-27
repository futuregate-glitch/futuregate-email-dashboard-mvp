# Future Gate – Email Dashboard (MVP)

A minimal web app (Azure-friendly) that:
- triggers Zapier → Outlook email search by keyword
- receives results back from Zapier
- stores emails + threads locally in `db.json`
- displays emails, sorts by date
- calculates response times (client → first @futuregate.info reply)
- generates a basic summary (or can call a Zapier summary hook)

## 1) Quick start (local)
```bash
npm install
npm start
# open http://localhost:3000
```

## 2) Environment variables
Set these in your shell (local) or Azure App Service → Configuration:

Required:
- `APP_BASE_URL` (example: `https://YOURAPP.azurewebsites.net`)
- `ZAPIER_SEARCH_HOOK_URL` (Zapier Catch Hook URL that receives search requests from this app)
- `INCOMING_WEBHOOK_SECRET` (shared secret you will configure in Zapier when it POSTs results back)

Optional:
- `ZAPIER_SUMMARY_HOOK_URL` (Zapier hook for AI summarization)

Other optional:
- `DB_PATH` (default: `./db.json`)
- `STAFF_DOMAIN` (default: `futuregate.info`)
- `PORT` (default: `3000`)

## 3) Zapier setup (minimal)
Create a Zap called **Outlook Search → Send to App**:

### Trigger
**Webhooks by Zapier → Catch Hook**
- This hook receives a JSON payload from the app. Example:
```json
{
  "queryId": "abc123",
  "keyword": "Siemens",
  "dateFrom": "2025-11-01",
  "dateTo": "2025-11-26",
  "maxResults": 50
}
```

### Action
**Microsoft Outlook (or Microsoft 365 Email)** → Search/Find Email
- Use the `keyword` from the incoming hook.
- If Outlook connector limitations block advanced searching, use Microsoft Graph via a Zapier integration step (or a “Code by Zapier” step) later.
- Ensure the action outputs: subject, body/snippet, from, to, cc, date/sent time, message id, conversation/thread id (if available).

### Action
**Webhooks by Zapier → POST**
- URL: `{{APP_BASE_URL}}/api/zapier/results`
- Headers:
  - `Content-Type: application/json`
  - `X-Webhook-Secret: <INCOMING_WEBHOOK_SECRET>`
- Body: build a JSON object like:
```json
{
  "queryId": "{{bundle.inputData.queryId}}",
  "emails": [
    {
      "messageId": "outlook-id",
      "conversationId": "thread-id-if-available",
      "subject": "Subject here",
      "from": "client@company.com",
      "to": ["staff@futuregate.info"],
      "cc": [],
      "sentAt": "2025-11-26T10:20:00Z",
      "snippet": "Short text…",
      "bodyHtml": "<p>Optional</p>"
    }
  ]
}
```

## 4) Optional: Zapier Summary hook
If you set `ZAPIER_SUMMARY_HOOK_URL`, the app will call it with:
```json
{ "threadId": "t_...", "subject": "...", "messages": [ ... ] }
```
Then your Zap should POST back a summary:
```json
{ "summary": "text", "actionItems": ["..."] }
```

## 5) Deploy to Azure App Service (Node)
1. Create an App Service (Linux or Windows) with Node 18+.
2. Deploy this repo (ZIP deploy / GitHub actions).
3. In **Configuration**, add the environment variables above.
4. Set Startup Command (Linux) if needed: `npm start`
5. Browse: `https://YOURAPP.azurewebsites.net`

## Notes
- This MVP uses a local `db.json`. For production, swap to Azure SQL/Postgres.
- Response time logic is computed per-thread from stored emails.
