# Demon Gacha Values

A community value list and demand tracker for [demongacha.com](https://demongacha.com), built as a static site for GitHub Pages.

- The card at **rank 25 is the unit (`1.00`)**. Everything above it is placed on a **non-linear rank curve**. Rank 1 (GRIEF) currently sits at about `23.23`.
- **Demand is a separate axis** from value. Normal and holo copies each have a demand score (D to S), and demand never changes a card's value on its own.
- Holo values come from the community sheet where known, and otherwise default to **3x** value.
- Top-tier values, holo values and demand are based on the community value spreadsheet credited below.
- New cards are added automatically by a scheduled GitHub Action as **pending**, with value and demand shown as **N/A** until a moderator confirms them.
- **Only people you choose can edit.** Everyone signs in with **Discord**. You add editors by **Discord ID** in the admin panel. Only **vxef** gets the admin panel. No one needs a GitHub token.

## Deploy to GitHub Pages

1. Push this folder to your repository (`pinterittejeden-gif/EDG-value-list`).
2. In the repo: **Settings -> Pages -> Build and deployment -> Source: Deploy from a branch**, branch `main`, folder `/ (root)`. The included `.nojekyll` keeps GitHub from processing the files.
3. Deploy the Discord login Worker (next section) and put its URL in `config.js`:
   ```js
   apiBase: "https://edg-value-api.your-subdomain.workers.dev"
   ```
4. Open the site. Sign in with Discord as **vxef**, then use the **Admin panel** to add editors by Discord ID.

All paths are relative, so it works from a project subpath. No build step is needed.

## Discord login Worker (required for editing)

Discord OAuth needs a server to hold the client secret, and publishing needs a server-side GitHub token. The static site cannot hold either. `worker/` is a small Cloudflare Worker that does both.

Full setup: [`worker/README.md`](worker/README.md). Short version:

1. Create a Discord application, add the redirect `https://<worker>.workers.dev/auth/discord/callback`, and copy the client id and secret.
2. Create a fine-grained GitHub token for this repo with **Contents: Read and write**.
3. Deploy and set secrets:
   ```powershell
   cd worker
   wrangler deploy
   wrangler secret put DISCORD_CLIENT_ID
   wrangler secret put DISCORD_CLIENT_SECRET
   wrangler secret put SESSION_SECRET
   wrangler secret put GITHUB_TOKEN
   ```
4. Set `apiBase` in `config.js` to the Worker URL.

The Worker identifies the owner as **vxef** by Discord username. Add your Discord ID to `OWNER_DISCORD_IDS` as a stable backup.

## Who can edit (admins and mods)

Sign-in is Discord OAuth. The Worker resolves each person's role from `data/roles.json`, which stores **Discord user IDs**. There are no passwords or personal tokens to manage.

| Role   | Can do |
|--------|--------|
| owner  | everything, including the **admin panel** and changing the access list |
| admin  | edit card values and the **curve anchors** |
| mod    | edit card values, holo values, demand and notes |
| viewer | read only |

`vxef` is always the owner, by username or by `OWNER_DISCORD_IDS`.

### Giving someone access

1. Sign in as **vxef**.
2. Open the **Admin panel**.
3. Paste the person's **Discord ID** (right-click their name in Discord -> Copy User ID), pick **mod**, **admin** or **owner**, click **Add**, then **Save access list**.
4. They sign in with Discord. No token, no GitHub account needed.

Removing their ID from the list removes their access immediately on their next request.

### How sign-in works

- The browser is sent to Discord, then back to the Worker.
- The Worker exchanges the code using the client secret, reads the Discord user, resolves the role, and issues a signed 12 hour session.
- The site stores that session in `sessionStorage` and sends it to the Worker as a Bearer token.
- API auth does not use cookies, so there is no CSRF surface. The OAuth handshake uses a short-lived `HttpOnly` state cookie.

### Recommended repo hardening

- The Worker is the only thing holding a GitHub write token. Keep that fine-grained token scoped to this one repo and to **Contents: Read and write**.
- Protect `main` if you want a review step for `data/roles.json` or `data/anchors.json`.
- Rotate `SESSION_SECRET` and the `GITHUB_TOKEN` if either is ever exposed; existing sessions are invalidated by a new `SESSION_SECRET`.

## Value model

The list deliberately ignores the site's official point value for display. Value is positional.

```
rank 25  -> 1.00    (unit, Avernus)
rank 1   -> 23.226  (GRIEF, from the community sheet)
rank 101 -> 0.161   (Trickshot, from the community sheet)
rank 1626-> 0.0091  (bottom, derived from the site's own value ratio)
```

Between anchors the app interpolates **log-log** (a power curve), so the scale is never linear. Admins can add anchors at any rank (for example rank 10, rank 50, rank 100) to reshape the curve. Each card can also carry a manual override. Cards that have a value in the community sheet use that exact ratio; the curve only fills in the rest.

- `valueOverride` null means "follow the curve". `valueSource` records whether the override came from the `sheet` or a `manual` edit.
- `holoOverride` null means "3x of the displayed value".
- `demand` is 0-10 (D to S) and is independent. `holoDemand` is the same for holo copies; when it is empty the normal demand is shown.
- `confirmed: false` means a freshly synced card that no editor has checked yet. It displays N/A.

Because value is positional, ranks shifting when new levels are rated will move curve values. That is intended. Use anchors and overrides to correct specific cards.

## Data sources and credit

- **Card metadata and thumbnails:** the public demongacha.com API and YouTube thumbnails.
- **Top-tier values, holo values and demand:** the community value spreadsheet, with thanks to its maintainers:
  https://docs.google.com/spreadsheets/d/1zSUN6pZ-kzTptvaG_gEPOAkldx38Qwuv16_4iNqG1d0/edit?gid=0#gid=0
- **Snapshot:** `data/sheet-source.csv` is the exact sheet download used for the last import.

Import or refresh the sheet at any time:

```powershell
npm run import-sheet
```

The importer normalizes the sheet's absolute values against its rank-25 card (Avernus), so `1.00` stays the unit. It applies the sheet's **value**, **holo value**, **demand** and **holo demand** as per-card overrides, rebuilds the curve anchors from the sheet's top and low-end values, and writes an audit entry. Manual edits are preserved: it skips any field a moderator has already set by hand.

The sheet is sparse by design (it carries the high end, not every common), so lower tiers follow the log curve between the sheet's tail anchor and the site's own bottom ratio.

## Automatic card sync

`.github/workflows/sync-cards.yml` runs daily (and on demand). It fetches the full public catalog from `demongacha.com/api/levels`, then:

- updates official fields (rank, points, site value, tier, drop chance, thumbnails, tags, description),
- preserves every hand edit,
- appends **new cards as pending (N/A)**,
- marks cards that disappeared from the source as inactive instead of deleting them,
- commits only when something changed.

Run it locally any time:

```powershell
npm run sync
```

A full first-time import (also what seeded this repo):

```powershell
npm run seed
```

## Local preview

```powershell
npm run serve
```

Open `http://127.0.0.1:8090/`. It serves the exact static files, so what you see matches Pages. Without `apiBase` set, the site is read-only; that is expected.

To test Discord login locally, run `wrangler dev` in `worker/`, add
`http://127.0.0.1:8787/auth/discord/callback` as a Discord redirect URI, set
`DISCORD_REDIRECT_URI` in `worker/.dev.vars`, and point `apiBase` at
`http://127.0.0.1:8787`. Add `http://127.0.0.1:8090` to `ALLOWED_ORIGINS`.

## Files

```
index.html            page shell and CSP
styles.css            theme
app.js                rendering, curve math, editor panel, Discord session
config.js             public config: apiBase, paths
logo.svg              icon
worker/worker.js      Discord OAuth + GitHub publishing API (Cloudflare Worker)
worker/wrangler.toml  Worker vars and deploy settings
worker/README.md      Worker deployment, secrets and endpoints
data/cards.json       one card per line for clean diffs
data/anchors.json     curve anchors + unit definition + demand labels
data/roles.json       allowlist of owner/admin/mod Discord IDs
data/audit.json       most recent edits
data/meta.json        sync counters and timestamps
data/sheet-source.csv last community sheet snapshot used by the importer
scripts/lib.mjs       shared fetch + serialization helpers
scripts/seed.mjs      full import, preserves edits
scripts/sync-cards.mjs adds new cards as pending
scripts/import-sheet.mjs community sheet -> per-card overrides
scripts/serve.mjs     local static server
.github/workflows/sync-cards.yml
```

## Security notes

- Strict Content-Security-Policy via meta tag (`self` only, the Worker on `*.workers.dev`, and `i.ytimg.com` for thumbnails). No third-party scripts, no CDN, no inline script.
- All card data is rendered with `textContent`, never `innerHTML`. Thumbnail and outbound links are validated against host allowlists.
- The Discord client secret and the GitHub write token exist only as Worker secrets. Browsers never receive them.
- Session tokens are HMAC-signed JWTs kept in `sessionStorage`, sent only to the Worker as a Bearer token. API auth does not use cookies, so there is no CSRF surface; the OAuth handshake uses a short-lived `HttpOnly` state cookie.
- The Worker validates every card field, role ID and anchor before committing, and records each change in `data/audit.json`.
- Commits are atomic multi-file commits through the Git Data API and use a non-forced ref update, so a concurrent edit is rejected instead of overwritten.
- No secrets are committed. `data/roles.json` holds Discord IDs, which are public identifiers.
