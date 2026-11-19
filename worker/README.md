# edg-value-api

Cloudflare Worker for Discord sign-in and publishing edits to
`pinterittejeden-gif/EDG-value-list`.

It holds the two things a static site cannot hold safely:

- the Discord OAuth **client secret**
- a GitHub token with **Contents: Read and write** on the value-list repo

Browsers never receive either. Users sign in with Discord, and the Worker
decides their role from `data/roles.json` (Discord IDs) plus the owner settings.

## One-time setup

1. Create a Discord application at https://discord.com/developers/applications
   - OAuth2 -> Redirects: add `https://<your-worker>.workers.dev/auth/discord/callback`
   - Copy the **Client ID** and **Client Secret**.
2. Create a fine-grained GitHub token:
   - Repository access: only `pinterittejeden-gif/EDG-value-list`
   - Permissions: **Contents: Read and write**
   - Copy it once.
3. Install and log in to Wrangler:

   ```powershell
   npm install -g wrangler
   wrangler login
   ```

4. From this `worker` folder, deploy and set the secrets:

   ```powershell
   wrangler deploy
   wrangler secret put DISCORD_CLIENT_ID
   wrangler secret put DISCORD_CLIENT_SECRET
   wrangler secret put SESSION_SECRET
   wrangler secret put GITHUB_TOKEN
   ```

   `SESSION_SECRET` is any long random string (32+ characters). Generate one with:

   ```powershell
   node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
   ```

5. Optional but recommended: pin the owner by Discord ID as well as username:

   ```powershell
   wrangler secret put OWNER_DISCORD_IDS
   ```

   Paste your Discord user ID (right-click your name in Discord -> Copy User ID).

6. Put the Worker URL into the site's `config.js`:

   ```js
   apiBase: "https://<your-worker>.workers.dev"
   ```

7. Push the site. Open it, click **Sign in**, authorize Discord. You are owner
   because your username is `vxef` (or your ID is configured). Open the
   **Admin panel**, paste a person's Discord ID, pick mod/admin/owner, and save.

## Commands

```powershell
wrangler dev      # local Worker on http://127.0.0.1:8787
wrangler deploy   # publish
wrangler tail     # live logs
```

For local testing, create `.dev.vars` in this folder (git-ignored):

```
DISCORD_CLIENT_ID=...
DISCORD_CLIENT_SECRET=...
SESSION_SECRET=...
GITHUB_TOKEN=...
OWNER_USERNAMES=vxef
OWNER_DISCORD_IDS=...
```

If you test against `http://127.0.0.1:8090`, add a Discord redirect URI of
`http://127.0.0.1:8787/auth/discord/callback` and set
`DISCORD_REDIRECT_URI` to it.

## Endpoints

| Method | Path | Who | Purpose |
|--------|------|-----|---------|
| GET | `/auth/discord` | anyone | start Discord OAuth |
| GET | `/auth/discord/callback` | Discord | finish OAuth, redirect with session |
| GET | `/api/session` | signed in | current user and role |
| GET | `/api/roles` | owner | read the Discord ID allowlist |
| PUT | `/api/roles` | owner | replace the allowlist |
| POST | `/api/commit` | mod/admin/owner | apply card changes and/or anchors |
| GET | `/api/audit` | editor | recent edits |
| GET | `/api/health` | anyone | liveness |

All API calls use `Authorization: Bearer <session>`. The session is an
HMAC-signed JWT with a 12 hour lifetime, stored by the site in `sessionStorage`.
No cookies are used for API auth, so there is no CSRF surface. The OAuth
handshake itself uses a short-lived `HttpOnly` state cookie.

## Role rules

- `owner`: everything, including `/api/roles` (the admin panel). `vxef` is owner
  by username, or via `OWNER_DISCORD_IDS`, or via `data/roles.json`.
- `admin`: card edits plus curve anchors.
- `mod`: card edits only.
- anyone else: read only.

`data/roles.json` stores Discord IDs, for example:

```json
{ "owner": [], "admins": ["123456789012345678"], "mods": [] }
```
