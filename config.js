// Public client configuration. Everything here is safe to commit: no secrets.
// Set repo.owner and repo.name to the GitHub repository that hosts this site.
window.DG_CONFIG = {
  site: {
    name: "Demon Gacha Values",
    tagline: "Community value list and demand tracker",
    updatedLabel: "Values are edited by hand and synced from demongacha.com"
  },
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
  // Optional convenience login. Create a GitHub OAuth App with "Enable Device Flow"
  // turned on, then paste its client id here. Fine-grained personal access tokens
  // still work and are the recommended method.
  oauth: {
    clientId: "",
    scope: "public_repo"
  },
  limits: {
    maxAuditEntries: 500,
    maxCommitRetries: 2
  }
};
