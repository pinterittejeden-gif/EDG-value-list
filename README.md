# Demon Gacha Values

A community value list and demand tracker for [demongacha.com](https://demongacha.com), built as a static site for GitHub Pages.

- The card at **rank 25 is the unit (`1.00`)**. Everything above it is placed on a **non-linear rank curve**. Rank 1 (GRIEF) currently sits at about `23.23`.
- **Demand is a separate axis** from value. Normal and holo copies each have a demand score (D to S), and demand never changes a card's value on its own.
- Holo values come from the community sheet where known, and otherwise default to **3x** value.
- Top-tier values, holo values and demand are based on the community value spreadsheet credited below.
- New cards are added automatically by a scheduled GitHub Action as **pending**, with value and demand shown as **N/A** until a moderator confirms them.
- Only GitHub accounts you choose can edit. Sign-in is a GitHub token; authorization is a roles allowlist plus repo write access. There are no passwords stored anywhere.

## Deploy to GitHub Pages

1. Create a new repository and push this folder to it.
2. Edit `config.js` and set:
   ```js
   repo: { owner: "your-github-username", name: "demongacha-value", branch: "main" }
   ```
3. In the repo: **Settings -> Pages -> Build and deployment -> Source: Deploy from a branch**, branch `main`, folder `/ (root)`. The included `.nojekyll` keeps GitHub from processing the files.
4. The site appears at `https://<owner>.github.io/<repo>/`.

All paths are relative, so it works from a project subpath. No build step is needed.

## Who can edit (admins and mods)

Editing uses GitHub as the identity provider. There is no password database to leak.

A person can edit only if **both** are true:

1. Their GitHub account has **write access** to the repository (collaborator, or part of a team with write).
2. Their GitHub login is listed in `data/roles.json` under `owner`, `admins`, or `mods`.

Roles:

| Role   | Can do |
|--------|--------|
| owner  | everything, including editing `data/roles.json` |
| admin  | edit card values and the **curve anchors** |
| mod    | edit card values, holo values, demand and notes |
| viewer | read only |

`config.js` `repo.owner` is always treated as an owner.

### Giving someone access

1. Add them as a repository collaborator with **Write** (or add them via a team).
2. Add their login to `data/roles.json`, e.g. `"mods": ["theirlogin"]`.
3. They open the site, click **Sign in**, and paste a GitHub token.

Remove either one and they lose edit access.

### Sign-in methods

**Fine-grained personal access token (recommended).** Each editor makes their own token at
`github.com/settings/tokens?type=beta`, scoped to this repository only, with **Contents: Read and write**. Least privilege, independently revocable.

**Device flow (optional).** Create a GitHub OAuth App, turn on **Enable Device Flow**, and put its client id in `config.js`:

```js
oauth: { clientId: "Iv1.xxxxxxxx", scope: "public_repo" }
```

The device flow endpoint can be blocked by some browsers because of CORS. The token method always works.

The token is kept in `sessionStorage` for the current tab and sent only to `api.github.com`.

### Recommended repo hardening

- Protect `main`: require pull requests for changes to `data/roles.json`, or restrict who can push to it.
- Keep write access to a small trusted group. The roles file gates the UI; GitHub write access is the real boundary.
- Consider requiring review before merging changes to `data/anchors.json`.

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

Open `http://127.0.0.1:8090/`. It serves the exact static files, so what you see matches Pages.

## Files

```
index.html            page shell and CSP
styles.css            theme
app.js                rendering, curve math, editor panel, GitHub auth and commits
config.js             public config: repo, paths, optional OAuth client id
logo.svg              icon
data/cards.json       one card per line for clean diffs
data/anchors.json     curve anchors + unit definition + demand labels
data/roles.json       allowlist of owner/admin/mod GitHub logins
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

- Strict Content-Security-Policy via meta tag (`self` only, plus GitHub API for editors and `i.ytimg.com` for thumbnails). No third-party scripts, no CDN, no inline script.
- All card data is rendered with `textContent`, never `innerHTML`. Thumbnail and outbound links are validated against host allowlists.
- Tokens are never placed in URLs or logged. Signing out clears them.
- Commits are atomic multi-file commits through the Git Data API and use a non-forced ref update, so a concurrent edit is rejected instead of overwritten.
- No secrets are committed. The only client-side credential is the editor's own token, entered at runtime.

If you later want server-side accounts or private data, add a small backend; the static site can keep reading the same JSON.
