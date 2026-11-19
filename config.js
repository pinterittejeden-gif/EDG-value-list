window.DG_CONFIG = {
  site: {
    name: "Demon Gacha Values",
    tagline: "Community value list and demand tracker",
    updatedLabel: "Values are edited by hand and synced from demongacha.com"
  },
  apiBase: "https://edg-value-api.pinteritte-jeden.workers.dev",
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
