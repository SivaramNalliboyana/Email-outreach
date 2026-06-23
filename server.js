import express from "express";
import { google } from "googleapis";
import nodemailer from "nodemailer";
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

// ---------- SMTP (IONOS / generic) ----------
function buildSmtp() {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) return null;
  const port = parseInt(SMTP_PORT || "587", 10);
  const secure = port === 465;
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port,
    secure,
    requireTLS: !secure,
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  });
}
let smtpTransport = buildSmtp();

const app = express();
app.use(express.json({ limit: "1mb" }));

// ---------- Static ----------
app.get("/", (_, res) => res.sendFile(path.join(__dirname, "index.html")));

// ---------- Account status ----------
function gmailConfigured() {
  return !!(oauth2Client.credentials.refresh_token || process.env.GMAIL_REFRESH_TOKEN);
}
function smtpConfigured() {
  return !!smtpTransport;
}

app.get("/api/accounts", (_, res) => {
  const accounts = [];
  if (gmailConfigured()) {
    accounts.push({
      id: "gmail",
      label: "Gmail / Google Workspace",
      from: process.env.GMAIL_FROM || null,
      ready: true
    });
  } else {
    accounts.push({
      id: "gmail",
      label: "Gmail / Google Workspace",
      from: null,
      ready: false,
      authUrl: "/api/auth"
    });
  }
  if (smtpConfigured()) {
    accounts.push({
      id: "ionos",
      label: "IONOS (SMTP)",
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      ready: true
    });
  } else {
    accounts.push({
      id: "ionos",
      label: "IONOS (SMTP)",
      from: null,
      ready: false,
      hint: "Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS (and optional SMTP_FROM) in .env"
    });
  }
  res.json({ accounts });
});

// Backwards-compat — Gmail-only auth status
app.get("/api/auth-status", (_, res) => {
  res.json({ authenticated: gmailConfigured() });
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

    const saved = saveEnvVar("GMAIL_REFRESH_TOKEN", refreshToken);
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
  const { to, subject, body, from } = req.body || {};
  if (!to || !String(to).includes("@")) return res.status(400).json({ error: "Invalid 'to' address" });
  if (subject == null) return res.status(400).json({ error: "Missing 'subject'" });

  const account = from || (gmailConfigured() ? "gmail" : smtpConfigured() ? "ionos" : null);
  if (!account) {
    return res.status(401).json({ error: "No sender configured. Connect Gmail at /api/auth or set SMTP env vars." });
  }

  try {
    if (account === "gmail") {
      if (!gmailConfigured()) return res.status(401).json({ error: "Gmail not connected. Visit /api/auth." });
      const gmail = google.gmail({ version: "v1", auth: oauth2Client });
      const raw = Buffer.from(buildMessage({ to, subject, body: body || "" })).toString("base64url");
      const result = await gmail.users.messages.send({ userId: "me", requestBody: { raw } });
      return res.json({ ok: true, id: result.data.id, via: "gmail" });
    }
    if (account === "ionos") {
      if (!smtpConfigured()) return res.status(401).json({ error: "SMTP not configured. Set SMTP_HOST/USER/PASS in .env." });
      const fromAddr = process.env.SMTP_FROM || process.env.SMTP_USER;
      const info = await smtpTransport.sendMail({
        from: fromAddr,
        to,
        subject,
        text: body || ""
      });
      return res.json({ ok: true, id: info.messageId, via: "ionos" });
    }
    return res.status(400).json({ error: `Unknown sender '${account}'` });
  } catch (e) {
    const status = Number.isInteger(e.code) ? e.code : 500;
    res.status(status).json({ error: e.message });
  }
});

// ---------- Helpers ----------
function buildMessage({ to, subject, body }) {
  const headers = [
    `To: ${to}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    `Subject: ${encodeSubjectIfNeeded(subject)}`
  ];
  if (process.env.GMAIL_FROM) headers.unshift(`From: ${process.env.GMAIL_FROM}`);
  return [...headers, "", body].join("\r\n");
}

function encodeSubjectIfNeeded(s) {
  return /^[\x00-\x7F]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`;
}

function saveEnvVar(key, value) {
  const envPath = path.join(__dirname, ".env");
  try {
    let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
    const re = new RegExp(`^${key}=.*$`, "m");
    if (re.test(content)) {
      content = content.replace(re, `${key}=${value}`);
    } else {
      content += (content.endsWith("\n") || content === "" ? "" : "\n") + `${key}=${value}\n`;
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
  const gmail = gmailConfigured();
  const smtp = smtpConfigured();
  console.log(`  Gmail / Workspace  ${gmail ? "✓ connected" : "✗ not connected — visit /api/auth"}`);
  console.log(`  IONOS SMTP         ${smtp ? `✓ ready (${process.env.SMTP_FROM || process.env.SMTP_USER})` : "✗ not configured — set SMTP_HOST/USER/PASS in .env"}`);
  console.log("");
});
