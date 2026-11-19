// Public client configuration. Everything here is safe to commit: no secrets.
// Set repo.owner and repo.name to the GitHub repository that hosts this site.
window.DG_CONFIG = {
  site: {
    name: "Demon Gacha Values",
    tagline: "Community value list and demand tracker",
    updatedLabel: "Values are edited by hand and synced from demongacha.com"
  },
  // Cloudflare Worker that handles Discord OAuth and publishes edits.
  // Deploy worker/ and paste its URL here, for example:
  //   apiBase: "https://edg-value-api.your-subdomain.workers.dev"
  // Leave empty to keep the site read-only.
  apiBase: "",
  repo: {
    owner: "pinterittejeden-gif",
    name: "EDG-value-list",
    branch: "main"
  },
  paths: {
    cards: "data/cards.json",
    meta: "data/meta.json",
    roles: "data/roles.json",
    audit: "data/audit.json"
  },
  limits: {
    maxAuditEntries: 500,
    maxCommitRetries: 2
  }
};
