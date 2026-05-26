import express from "express";
import { google } from "googleapis";
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || `http://localhost:${PORT}/api/oauth-callback`;
const SCOPES = ["https://www.googleapis.com/auth/gmail.send"];

const missing = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"].filter(k => !process.env[k]);
if (missing.length) {
  console.error(`\n[!] Missing env vars: ${missing.join(", ")}`);
  console.error(`    Copy .env.example to .env and fill in your Google OAuth credentials.\n`);
  process.exit(1);
}

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  REDIRECT_URI
);

if (process.env.GMAIL_REFRESH_TOKEN) {
  oauth2Client.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });
}

const app = express();
app.use(express.json({ limit: "1mb" }));

// ---------- Static ----------
app.get("/", (_, res) => res.sendFile(path.join(__dirname, "index.html")));

// ---------- Auth status ----------
app.get("/api/auth-status", (_, res) => {
  const authed = !!(oauth2Client.credentials.refresh_token || process.env.GMAIL_REFRESH_TOKEN);
  res.json({ authenticated: authed });
});

// ---------- OAuth start ----------
app.get("/api/auth", (_, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES
  });
  res.redirect(url);
});

// ---------- OAuth callback ----------
app.get("/api/oauth-callback", async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.status(400).send(htmlPage("Auth failed", `Google returned: <code>${escapeHtml(error)}</code>`));
  if (!code) return res.status(400).send(htmlPage("Auth failed", "Missing authorization code."));

  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    const refreshToken = tokens.refresh_token;
    if (!refreshToken) {
      return res.status(500).send(htmlPage(
        "No refresh token returned",
        "Google did not return a refresh token. Revoke this app's access at " +
        "<a href='https://myaccount.google.com/permissions' target='_blank'>myaccount.google.com/permissions</a>, " +
        "then try <a href='/api/auth'>/api/auth</a> again."
      ));
    }

    const saved = saveRefreshToken(refreshToken);
    process.env.GMAIL_REFRESH_TOKEN = refreshToken;

    const msg = saved
      ? `Saved to <code>.env</code>. You can close this tab and start sending — no restart needed.`
      : `Couldn't write to .env automatically. Copy this and paste it into your <code>.env</code> as <code>GMAIL_REFRESH_TOKEN</code>:<br><br><code style="word-break:break-all;background:#f1f5f9;padding:8px;border-radius:6px;display:block">${escapeHtml(refreshToken)}</code>`;

    res.send(htmlPage("Gmail connected ✓", msg, true));
  } catch (e) {
    res.status(500).send(htmlPage("Auth error", escapeHtml(e.message)));
  }
});

// ---------- Send ----------
app.post("/api/send", async (req, res) => {
  const hasAuth = !!(oauth2Client.credentials.refresh_token || process.env.GMAIL_REFRESH_TOKEN);
  if (!hasAuth) {
    return res.status(401).json({ error: "Not authenticated. Visit /api/auth to grant Gmail access." });
  }
  const { to, subject, body } = req.body || {};
  if (!to || !String(to).includes("@")) return res.status(400).json({ error: "Invalid 'to' address" });
  if (subject == null) return res.status(400).json({ error: "Missing 'subject'" });

  try {
    const gmail = google.gmail({ version: "v1", auth: oauth2Client });
    const raw = Buffer.from(buildMessage({ to, subject, body: body || "" })).toString("base64url");
    const result = await gmail.users.messages.send({ userId: "me", requestBody: { raw } });
    res.json({ ok: true, id: result.data.id });
  } catch (e) {
    const status = e.code || 500;
    res.status(status).json({ error: e.message });
  }
});

// ---------- Helpers ----------
function buildMessage({ to, subject, body }) {
  return [
    `To: ${to}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    `Subject: ${encodeSubjectIfNeeded(subject)}`,
    "",
    body
  ].join("\r\n");
}

function encodeSubjectIfNeeded(s) {
  return /^[\x00-\x7F]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`;
}

function saveRefreshToken(token) {
  const envPath = path.join(__dirname, ".env");
  try {
    let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
    if (/^GMAIL_REFRESH_TOKEN=.*$/m.test(content)) {
      content = content.replace(/^GMAIL_REFRESH_TOKEN=.*$/m, `GMAIL_REFRESH_TOKEN=${token}`);
    } else {
      content += (content.endsWith("\n") || content === "" ? "" : "\n") + `GMAIL_REFRESH_TOKEN=${token}\n`;
    }
    fs.writeFileSync(envPath, content);
    return true;
  } catch {
    return false;
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function htmlPage(title, msg, success = false) {
  const color = success ? "#059669" : "#dc2626";
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>body{font-family:-apple-system,Segoe UI,sans-serif;background:#f8fafc;color:#1e293b;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px}
.card{background:#fff;border:1px solid #e2e8f0;border-radius:16px;padding:32px;max-width:560px;box-shadow:0 1px 3px rgba(0,0,0,.05)}
h1{margin:0 0 12px;color:${color};font-size:22px}
p,div{font-size:14px;line-height:1.6;color:#475569}
a{color:#4f46e5}
code{font-family:ui-monospace,Menlo,monospace;font-size:13px}</style></head>
<body><div class="card"><h1>${escapeHtml(title)}</h1><div>${msg}</div>
<p style="margin-top:24px"><a href="/">← Back to the tool</a></p></div></body></html>`;
}

app.listen(PORT, () => {
  console.log(`\n  Cold Outreach running at  http://localhost:${PORT}`);
  if (!process.env.GMAIL_REFRESH_TOKEN) {
    console.log(`  Not authenticated yet  →  http://localhost:${PORT}/api/auth\n`);
  } else {
    console.log(`  Gmail connected  ✓\n`);
  }
});
