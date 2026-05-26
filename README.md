# Cold Outreach

Internal tool for sending personalized cold emails from your own Gmail. Upload a CSV/Excel of recipients, write a template with `{{placeholders}}`, preview, send.

Sends from your own Gmail via the Gmail API — replies land in your normal inbox, deliverability stays high.

## Quick start (joining an existing setup)

If someone on the team already set up the Google Cloud project and gave you credentials:

```powershell
git clone https://github.com/SivaramNalliboyana/Email-outreach.git
cd Email-outreach
npm install
copy .env.example .env
```

Open `.env` and paste in the shared `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. Leave `GMAIL_REFRESH_TOKEN` blank.

```powershell
npm start
```

Open http://localhost:3000 → click **Connect Gmail** in the footer → grant access with your gmail. Your refresh token gets saved to `.env` automatically. Done.

Make sure the project owner has added your gmail as a **test user** in the OAuth consent screen, or auth will fail.

## First-time setup (creating the Google project from scratch)

Skip this if you're joining an existing setup.

1. Go to [console.cloud.google.com](https://console.cloud.google.com), create a new project.
2. **APIs & Services → Library** → search "Gmail API" → **Enable**.
3. **OAuth consent screen** → User type: **External** → fill in app name + your support email + dev email.
   - Add scope: `https://www.googleapis.com/auth/gmail.send`
   - Add your gmail as a test user.
4. **Credentials → Create Credentials → OAuth client ID** → type: **Web application**.
   - Authorized redirect URI: `http://localhost:3000/api/oauth-callback`
   - Copy the **Client ID** and **Client secret** that appear.
5. Follow the **Quick start** above with those credentials.

## Using the tool

1. **Upload** a `.csv` or `.xlsx` with at least a `name` and `email` column. Any extra columns (`company`, `role`, …) become available as `{{placeholders}}`.
2. **Compose template** — write a subject and body. Click placeholder chips on the right to insert `{{name}}` etc. at the cursor.
3. **Preview** each rendered email by flipping through recipients.
4. **Send** — adjust the delay (1s default), turn off **Dry Run** to send for real.

The template auto-saves to `localStorage` — refreshing won't lose your draft.

## Notes / gotchas

- **Gmail caps:** ~500/day on personal accounts, ~2000/day on Workspace.
- **Token expiry in Testing mode:** while the OAuth consent screen is in "Testing", refresh tokens expire after **7 days**. Hit `/api/auth` to re-grant when sends start failing with 401s. To remove the expiry, hit **PUBLISH APP** on the OAuth consent screen — for `gmail.send` scope and personal use, no verification is needed.
- **Each user runs their own local copy** with their own refresh token. Sends always go from the gmail account that granted access.
- **Never commit `.env`.** It's gitignored. Share OAuth credentials through a password manager, not chat tools.

## Stack

- `index.html` — single-file frontend, Tailwind + SheetJS via CDN
- `server.js` — Node/Express + `googleapis` for the OAuth flow and Gmail send
- `.env` — secrets (gitignored)
