const DISCORD_API = "https://discord.com/api/v10";

const GH = "https://api.github.com";

const SESSION_TTL = 60 * 60 * 12;

const MAX_CHANGES = 200;

const MAX_AUDIT = 500;

const CARD_FIELDS = [ "valueOverride", "holoOverride", "demand", "holoDemand", "priceStatus", "note" ];

const MAX_IDS_PER_ROLE = 200;

const ROLES_CACHE_MS = 3e4;

const enc = new TextEncoder;

let rolesCache = null;

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extra
    }
  });
}

function fail(message, status = 400) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function b64url(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = "";
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlJson(obj) {
  return b64url(enc.encode(JSON.stringify(obj)));
}

function fromB64url(value) {
  const s = String(value).replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4 ? "=".repeat(4 - s.length % 4) : "";
  const bin = atob(s + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacKey(secret) {
  return crypto.subtle.importKey("raw", enc.encode(secret), {
    name: "HMAC",
    hash: "SHA-256"
  }, false, [ "sign", "verify" ]);
}

async function signJwt(payload, secret) {
  const head = b64urlJson({
    alg: "HS256",
    typ: "JWT"
  });
  const body = b64urlJson(payload);
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(head + "." + body));
  return head + "." + body + "." + b64url(sig);
}

async function verifyJwt(token, secret) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret), fromB64url(parts[2]), enc.encode(parts[0] + "." + parts[1]));
    if (!ok) return null;
    const payload = JSON.parse((new TextDecoder).decode(fromB64url(parts[1])));
    if (!payload || typeof payload.exp !== "number" || payload.exp < Math.floor(Date.now() / 1e3)) return null;
    return payload;
  } catch {
    return null;
  }
}

function origins(env) {
  return String(env.ALLOWED_ORIGINS || env.SITE_URL || "").split(",").map(s => s.trim()).filter(Boolean);
}

function corsHeaders(env, origin) {
  const allowed = origins(env);
  const h = {
    "access-control-allow-methods": "GET,POST,PUT,OPTIONS",
    "access-control-allow-headers": "Authorization,Content-Type",
    "access-control-max-age": "86400",
    vary: "Origin"
  };
  if (origin && allowed.includes(origin)) h["access-control-allow-origin"] = origin;
  return h;
}

function withCors(res, env, origin) {
  const copy = new Response(res.body, res);
  for (const [k, v] of Object.entries(corsHeaders(env, origin))) copy.headers.set(k, v);
  return copy;
}

function cookie(req, name) {
  const raw = req.headers.get("cookie") || "";
  const m = raw.match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
  return m ? decodeURIComponent(m[1]) : "";
}

function redirectUri(req, env) {
  return env.DISCORD_REDIRECT_URI || new URL("/auth/discord/callback", req.url).toString();
}

function envList(env, name) {
  return String(env[name] || "").split(",").map(s => s.trim()).filter(Boolean);
}

function repoBase(env) {
  return `/repos/${encodeURIComponent(env.REPO_OWNER)}/${encodeURIComponent(env.REPO_NAME)}`;
}

function encPath(value) {
  return String(value).split("/").map(encodeURIComponent).join("/");
}

async function gh(env, path, opts = {}) {
  const res = await fetch(GH + path, {
    method: opts.method || "GET",
    headers: {
      authorization: "Bearer " + env.GITHUB_TOKEN,
      accept: opts.accept || "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "edg-value-api",
      ...opts.body ? {
        "content-type": "application/json"
      } : {}
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {}
  if (!res.ok) {
    const e = new Error(data && (data.message || data.error) || "GitHub HTTP " + res.status);
    e.status = res.status === 401 || res.status === 403 ? 502 : res.status;
    throw e;
  }
  return data;
}

async function readText(env, path) {
  const res = await fetch(GH + repoBase(env) + "/contents/" + encPath(path) + "?ref=" + encodeURIComponent(env.BRANCH || "main"), {
    headers: {
      authorization: "Bearer " + env.GITHUB_TOKEN,
      accept: "application/vnd.github.raw",
      "x-github-api-version": "2022-11-28",
      "user-agent": "edg-value-api"
    }
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw fail("Could not read " + path + " (HTTP " + res.status + "): " + detail.slice(0, 200), 502);
  }
  return res.text();
}

async function readJson(env, path) {
  return JSON.parse(await readText(env, path));
}

async function commitFiles(env, files, message) {
  const base = repoBase(env);
  const branch = encPath(env.BRANCH || "main");
  const ref = await gh(env, base + "/git/ref/heads/" + branch);
  const parentSha = ref.object.sha;
  const parent = await gh(env, base + "/git/commits/" + parentSha);
  const tree = [];
  for (const [path, value] of Object.entries(files)) {
    if (value === null) {
      tree.push({
        path,
        mode: "100644",
        type: "blob",
        sha: null
      });
      continue;
    }
    const binary = value && typeof value === "object" && typeof value.base64 === "string";
    const blob = await gh(env, base + "/git/blobs", {
      method: "POST",
      body: binary ? {
        content: value.base64,
        encoding: "base64"
      } : {
        content: String(value),
        encoding: "utf-8"
      }
    });
    tree.push({
      path,
      mode: "100644",
      type: "blob",
      sha: blob.sha
    });
  }
  const newTree = await gh(env, base + "/git/trees", {
    method: "POST",
    body: {
      base_tree: parent.tree.sha,
      tree
    }
  });
  const commit = await gh(env, base + "/git/commits", {
    method: "POST",
    body: {
      message,
      tree: newTree.sha,
      parents: [ parentSha ]
    }
  });
  await gh(env, base + "/git/refs/heads/" + branch, {
    method: "PATCH",
    body: {
      sha: commit.sha,
      force: false
    }
  });
  return commit.sha;
}

function serializeCards(doc) {
  const rest = {};
  for (const [k, v] of Object.entries(doc)) if (k !== "cards") rest[k] = v;
  const head = JSON.stringify(rest, null, 2).replace(/\n}$/, "");
  let out = "{\n" + head.slice(2) + ',\n  "cards": [\n';
  out += doc.cards.map(c => "    " + JSON.stringify(c)).join(",\n");
  out += "\n  ]\n}\n";
  return out;
}

function serializePretty(obj) {
  return JSON.stringify(obj, null, 2) + "\n";
}

function normalizeRoles(data) {
  const list = v => Array.isArray(v) ? v.map(x => {
    if (typeof x === "string") return x.trim();
    if (x && typeof x === "object" && x.id) return String(x.id);
    return "";
  }).filter(Boolean) : [];
  const owner = list(data && data.owner);
  const admins = list(data && data.admins).filter(id => !owner.includes(id));
  const mods = list(data && data.mods).filter(id => !owner.includes(id) && !admins.includes(id));
  const helpers = list(data && data.helpers).filter(id => !owner.includes(id) && !admins.includes(id) && !mods.includes(id));
  const blocked = list(data && data.blocked);
  return {
    owner,
    admins,
    mods,
    helpers,
    blocked
  };
}

async function readRoles(env, force = false) {
  const now = Date.now();
  if (!force && rolesCache && now - rolesCache.at < ROLES_CACHE_MS) return rolesCache.data;
  const data = await readJson(env, "data/roles.json").catch(() => ({
    owner: [],
    admins: [],
    mods: [],
    helpers: [],
    blocked: []
  }));
  rolesCache = {
    at: now,
    data: normalizeRoles(data)
  };
  return rolesCache.data;
}

async function resolveRole(user, env) {
  const id = String(user && user.id || "");
  const username = String(user && user.username || "").toLowerCase();
  if (id && envList(env, "OWNER_DISCORD_IDS").includes(id)) return "owner";
  if (username && envList(env, "OWNER_USERNAMES").map(s => s.toLowerCase()).includes(username)) return "owner";
  const roles = await readRoles(env);
  if (id && roles.owner.includes(id)) return "owner";
  if (id && roles.blocked.includes(id)) return "blocked";
  if (id && roles.admins.includes(id)) return "admin";
  if (id && roles.mods.includes(id)) return "mod";
  if (id && roles.helpers.includes(id)) return "helper";
  return "viewer";
}

function validDiscordId(value) {
  return typeof value === "string" && /^\d{16,20}$/.test(value.trim());
}

function validateRoles(body) {
  if (!body || typeof body !== "object") throw fail("Invalid roles body.", 400);
  const clean = (arr, name) => {
    if (arr == null) return [];
    if (!Array.isArray(arr)) throw fail(name + " must be a list of Discord IDs.", 400);
    if (arr.length > MAX_IDS_PER_ROLE) throw fail(name + " has too many entries.", 400);
    const out = [];
    for (const raw of arr) {
      const id = String(raw).trim();
      if (!validDiscordId(id)) throw fail("Invalid Discord ID: " + id, 400);
      if (!out.includes(id)) out.push(id);
    }
    return out;
  };
  const owner = clean(body.owner, "owner");
  const admins = clean(body.admins, "admins").filter(id => !owner.includes(id));
  const mods = clean(body.mods, "mods").filter(id => !owner.includes(id) && !admins.includes(id));
  const helpers = clean(body.helpers, "helpers").filter(id => !owner.includes(id) && !admins.includes(id) && !mods.includes(id));
  const blocked = clean(body.blocked, "blocked");
  return {
    owner,
    admins,
    mods,
    helpers,
    blocked
  };
}

async function requireUser(req, env) {
  const auth = req.headers.get("authorization") || "";
  const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  const payload = await verifyJwt(token, env.SESSION_SECRET);
  if (!payload) throw fail("Sign in with Discord first.", 401);
  const user = {
    id: String(payload.sub),
    username: String(payload.username || ""),
    global_name: String(payload.global_name || payload.username || "")
  };
  user.role = await resolveRole(user, env);
  return user;
}

async function authStart(req, env) {
  if (!env.DISCORD_CLIENT_ID) throw fail("Discord client id is not configured.", 500);
  const state = crypto.randomUUID();
  const url = new URL("https://discord.com/oauth2/authorize");
  url.searchParams.set("client_id", env.DISCORD_CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", redirectUri(req, env));
  url.searchParams.set("scope", "identify");
  url.searchParams.set("state", state);
  return new Response(null, {
    status: 302,
    headers: {
      location: url.toString(),
      "set-cookie": "dg_state=" + encodeURIComponent(state) + "; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600"
    }
  });
}

async function authCallback(req, env, url) {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state") || "";
  const expected = cookie(req, "dg_state");
  if (!code || !state || state !== expected) throw fail("Invalid or expired OAuth state. Start again.", 400);
  const body = new URLSearchParams({
    client_id: env.DISCORD_CLIENT_ID,
    client_secret: env.DISCORD_CLIENT_SECRET,
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri(req, env)
  });
  const tokenRes = await fetch(DISCORD_API + "/oauth2/token", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded"
    },
    body
  });
  if (!tokenRes.ok) throw fail("Discord token exchange failed.", 502);
  const token = await tokenRes.json();
  if (!token.access_token) throw fail("Discord did not return an access token.", 502);
  const userRes = await fetch(DISCORD_API + "/users/@me", {
    headers: {
      authorization: "Bearer " + token.access_token
    }
  });
  if (!userRes.ok) throw fail("Discord user lookup failed.", 502);
  const user = await userRes.json();
  if (!user || !user.id) throw fail("Discord did not return a user.", 502);
  const role = await resolveRole(user, env);
  const now = Math.floor(Date.now() / 1e3);
  const jwt = await signJwt({
    sub: String(user.id),
    username: user.username || "",
    global_name: user.global_name || user.username || "",
    role,
    iat: now,
    exp: now + SESSION_TTL
  }, env.SESSION_SECRET);
  const site = env.SITE_URL || origins(env)[0];
  if (!site) throw fail("SITE_URL is not configured.", 500);
  const target = new URL(site);
  target.hash = "auth=" + encodeURIComponent(jwt);
  return new Response(null, {
    status: 302,
    headers: {
      location: target.toString(),
      "set-cookie": "dg_state=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0"
    }
  });
}

function asNumberOrNull(value, label, min, max) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) throw fail(label + " is out of range.", 400);
  return n;
}

function asDemand(value, label) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 10) throw fail(label + " must be a whole number from 0 to 10.", 400);
  return n;
}

function applyCardPatch(card, patch, now, by, onlyFields) {
  if (!patch || typeof patch !== "object") throw fail("Invalid card change.", 400);
  if (typeof patch.id !== "string" || !patch.id) throw fail("Card change is missing an id.", 400);
  const allow = f => !onlyFields || onlyFields.includes(f);
  const before = {
    valueOverride: card.valueOverride == null ? null : card.valueOverride,
    holoOverride: card.holoOverride == null ? null : card.holoOverride,
    demand: card.demand == null ? null : card.demand,
    holoDemand: card.holoDemand == null ? null : card.holoDemand,
    priceStatus: card.priceStatus == null ? null : card.priceStatus,
    note: card.note || "",
    confirmed: card.confirmed !== false
  };
  const valueOverride = allow("valueOverride") ? asNumberOrNull(patch.valueOverride, "Value", 0, 1e9) : card.valueOverride == null ? null : card.valueOverride;
  const holoOverride = allow("holoOverride") ? asNumberOrNull(patch.holoOverride, "Holo value", 0, 1e9) : card.holoOverride == null ? null : card.holoOverride;
  const demand = allow("demand") ? asDemand(patch.demand, "Demand") : card.demand == null ? null : card.demand;
  const holoDemand = allow("holoDemand") ? asDemand(patch.holoDemand, "Holo demand") : card.holoDemand == null ? null : card.holoDemand;
  const priceRaw = allow("priceStatus") ? patch.priceStatus : card.priceStatus;
  const priceStatus = priceRaw === undefined || priceRaw === null || priceRaw === "" ? null : String(priceRaw);
  if (priceStatus != null && !["over", "under", "fair"].includes(priceStatus)) throw fail("Invalid price status.", 400);
  const note = allow("note") ? patch.note == null ? "" : String(patch.note).slice(0, 500) : card.note || "";
  const changes = {};
  if (valueOverride !== (card.valueOverride == null ? null : card.valueOverride)) changes.value = {
    from: card.valueOverride,
    to: valueOverride
  };
  if (holoOverride !== (card.holoOverride == null ? null : card.holoOverride)) changes.holo = {
    from: card.holoOverride,
    to: holoOverride
  };
  if (demand !== (card.demand == null ? null : card.demand)) changes.demand = {
    from: card.demand,
    to: demand
  };
  if (holoDemand !== (card.holoDemand == null ? null : card.holoDemand)) changes.holoDemand = {
    from: card.holoDemand,
    to: holoDemand
  };
  if (priceStatus !== (card.priceStatus == null ? null : card.priceStatus)) changes.priceStatus = {
    from: card.priceStatus == null ? null : card.priceStatus,
    to: priceStatus
  };
  if (note !== (card.note || "")) changes.note = true;
  if (card.confirmed === false) changes.confirmed = true;
  if (changes.value || changes.holo) card.valueSource = valueOverride == null ? null : "manual";
  if (changes.demand) card.demandSource = demand == null ? null : "manual";
  if (changes.holoDemand) card.holoDemandSource = holoDemand == null ? null : "manual";
  card.valueOverride = valueOverride;
  card.holoOverride = holoOverride;
  card.demand = demand;
  card.holoDemand = holoDemand;
  card.priceStatus = priceStatus;
  card.note = note;
  card.confirmed = true;
  card.updatedAt = now;
  return {
    id: card.id,
    name: card.name,
    changes,
    before
  };
}

function validateAnchors(input) {
  if (!input || typeof input !== "object" || !Array.isArray(input.anchors)) throw fail("Invalid anchors body.", 400);
  if (input.anchors.length < 2) throw fail("Keep at least two anchors.", 400);
  if (input.anchors.length > 30) throw fail("Too many anchors.", 400);
  const seen = new Set;
  const out = [];
  for (const a of input.anchors) {
    const rank = Math.round(Number(a && a.rank));
    const value = Number(a && a.value);
    if (!Number.isInteger(rank) || rank < 1) throw fail("Anchor rank must be a positive whole number.", 400);
    if (!Number.isFinite(value) || value <= 0) throw fail("Anchor value must be positive.", 400);
    if (seen.has(rank)) throw fail("Two anchors share rank " + rank + ".", 400);
    seen.add(rank);
    out.push({
      rank,
      value,
      label: String(a && a.label || "").slice(0, 40)
    });
  }
  out.sort((a, b) => a.rank - b.rank);
  return {
    schema: 1,
    unit: input.unit || {
      rank: 25,
      note: "1.00 is the card sitting at rank 25."
    },
    curve: input.curve || {
      interpolation: "log-log",
      min: .001,
      decimals: 2
    },
    anchors: out,
    demand: input.demand || {}
  };
}

async function session(req, env) {
  const user = await requireUser(req, env);
  return json({
    user,
    role: user.role
  });
}

async function getRoles(req, env) {
  const user = await requireUser(req, env);
  if (user.role !== "owner") return json({
    error: "Only the owner can view access control."
  }, 403);
  const roles = normalizeRoles(await readJson(env, "data/roles.json"));
  return json({
    roles,
    you: user
  });
}

async function putRoles(req, env) {
  const user = await requireUser(req, env);
  if (user.role !== "owner") return json({
    error: "Only the owner can change access."
  }, 403);
  const body = await req.json().catch(() => null);
  const roles = validateRoles(body);
  const now = Date.now();
  const audit = await readJson(env, "data/audit.json").catch(() => ({
    entries: []
  }));
  audit.entries = Array.isArray(audit.entries) ? audit.entries : [];
  audit.entries.unshift({
    at: now,
    by: user.username,
    byId: user.id,
    action: "roles",
    owner: roles.owner.length,
    admins: roles.admins.length,
    mods: roles.mods.length,
    helpers: roles.helpers.length,
    blocked: roles.blocked.length
  });
  audit.entries = audit.entries.slice(0, MAX_AUDIT);
  const files = {
    "data/roles.json": serializePretty({
      schema: 2,
      note: "Discord user IDs only. The owner is always recognised by the Worker OWNER_USERNAMES / OWNER_DISCORD_IDS too.",
      owner: roles.owner,
      admins: roles.admins,
      mods: roles.mods,
      helpers: roles.helpers,
      blocked: roles.blocked
    }),
    "data/audit.json": serializePretty(audit)
  };
  const sha = await commitFiles(env, files, "Update editor roles");
  rolesCache = null;
  return json({
    roles,
    sha
  });
}

async function applyAndCommit(env, user, changes, anchors, message, extraFiles, extraAudit) {
  const now = Date.now();
  const cardsDoc = await readJson(env, "data/cards.json");
  if (!cardsDoc || !Array.isArray(cardsDoc.cards)) throw fail("cards.json is malformed.", 500);
  const byId = new Map(cardsDoc.cards.map(c => [ c.id, c ]));
  const auditEntries = [];
  let applied = 0;
  for (const patch of changes) {
    if (!patch || typeof patch.id !== "string") throw fail("A card change is missing an id.", 400);
    const card = byId.get(patch.id);
    if (!card) throw fail("Unknown card id: " + patch.id, 400);
    auditEntries.push(applyCardPatch(card, patch, now, user.username, patch.fields));
    applied++;
  }
  const files = {};
  const audit = await readJson(env, "data/audit.json").catch(() => ({
    entries: []
  }));
  audit.entries = Array.isArray(audit.entries) ? audit.entries : [];
  if (anchors) {
    const clean = validateAnchors(anchors);
    files["data/anchors.json"] = serializePretty(clean);
    auditEntries.push({
      at: now,
      by: user.username,
      byId: user.id,
      action: "anchors",
      ranks: clean.anchors.map(a => a.rank)
    });
  }
  if (applied > 0) {
    cardsDoc.cards.sort((a, b) => a.rank - b.rank);
    files["data/cards.json"] = serializeCards(cardsDoc);
  }
  const confirmed = cardsDoc.cards.filter(c => c.confirmed !== false).length;
  const meta = {
    schema: 1,
    syncedAt: cardsDoc.syncedAt || now,
    generatedAt: now,
    total: cardsDoc.cards.length,
    confirmed,
    pending: cardsDoc.cards.length - confirmed,
    valued: cardsDoc.cards.filter(c => c.valueOverride != null).length,
    demandSet: cardsDoc.cards.filter(c => c.demand != null).length,
    revision: (Number((await readJson(env, "data/meta.json").catch(() => ({}))).revision) || 0) + 1
  };
  files["data/meta.json"] = serializePretty(meta);
  const extra = Array.isArray(extraAudit) ? extraAudit : [];
  audit.entries = auditEntries.map(e => ({
    ...e,
    by: user.username
  })).concat(extra).concat(audit.entries).slice(0, MAX_AUDIT);
  files["data/audit.json"] = serializePretty(audit);
  if (extraFiles) Object.assign(files, extraFiles);
  const sha = await commitFiles(env, files, String(message || "Update values").slice(0, 120));
  return {
    sha,
    applied
  };
}
async function commit(req, env) {
  const user = await requireUser(req, env);
  if (user.role === "viewer" || user.role === "helper") return json({
    error: "Not allowed to publish directly."
  }, 403);
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return json({
    error: "Invalid body."
  }, 400);
  const changes = Array.isArray(body.changes) ? body.changes : [];
  if (changes.length > MAX_CHANGES) return json({
    error: "Too many changes in one commit."
  }, 400);
  if (changes.length === 0 && !body.anchors) return json({
    error: "Nothing to commit."
  }, 400);
  if (body.anchors && user.role !== "admin" && user.role !== "owner") return json({
    error: "Only admins and owners can change the curve."
  }, 403);
  return json(await applyAndCommit(env, user, changes, body.anchors, body.message, null, null));
}
function proposalSanitize(card, patch, now, username, fields) {
  const clone = {
    ...card
  };
  applyCardPatch(clone, patch, now, username, fields);
  return {
    id: card.id,
    fields,
    valueOverride: clone.valueOverride,
    holoOverride: clone.holoOverride,
    demand: clone.demand,
    holoDemand: clone.holoDemand,
    priceStatus: clone.priceStatus,
    note: clone.note
  };
}
async function propose(req, env) {
  const user = await requireUser(req, env);
  if (user.role !== "helper") return json({
    error: "Only helpers submit proposals."
  }, 403);
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return json({
    error: "Invalid body."
  }, 400);
  if (body.anchors) return json({
    error: "Helpers cannot propose curve changes."
  }, 403);
  const changes = Array.isArray(body.changes) ? body.changes : [];
  if (changes.length === 0) return json({
    error: "Nothing to propose."
  }, 400);
  if (changes.length > MAX_CHANGES) return json({
    error: "Too many changes in one proposal."
  }, 400);
  const cardsDoc = await readJson(env, "data/cards.json");
  if (!cardsDoc || !Array.isArray(cardsDoc.cards)) return json({
    error: "cards.json is malformed."
  }, 500);
  const byId = new Map(cardsDoc.cards.map(c => [ c.id, c ]));
  const now = Date.now();
  const clean = [];
  for (const patch of changes) {
    if (!patch || typeof patch.id !== "string") return json({
      error: "A card change is missing an id."
    }, 400);
    const card = byId.get(patch.id);
    if (!card) return json({
      error: "Unknown card id: " + patch.id
    }, 400);
    const fields = Array.isArray(patch.fields) ? CARD_FIELDS.filter(f => patch.fields.includes(f)) : CARD_FIELDS.slice();
    if (!fields.length) return json({
      error: "Pick at least one field."
    }, 400);
    clean.push(proposalSanitize(card, patch, now, user.username, fields));
  }
  const pending = await readJson(env, "data/pending.json").catch(() => ({
    proposals: []
  }));
  pending.proposals = Array.isArray(pending.proposals) ? pending.proposals : [];
  if (pending.proposals.filter(p => p.byId === user.id).length >= 20) return json({
    error: "Too many pending proposals."
  }, 429);
  if (pending.proposals.length >= 200) return json({
    error: "Proposal queue is full."
  }, 429);
  const reason = String(body.reason || body.message || "").slice(0, 120);
  const proposal = {
    id: crypto.randomUUID(),
    at: now,
    by: user.username,
    byId: user.id,
    kind: "proposal",
    reason,
    message: reason,
    changes: clean,
    images: []
  };
  pending.proposals.unshift(proposal);
  const audit = await readJson(env, "data/audit.json").catch(() => ({
    entries: []
  }));
  audit.entries = Array.isArray(audit.entries) ? audit.entries : [];
  audit.entries.unshift({
    at: now,
    by: user.username,
    byId: user.id,
    action: "propose",
    proposal: proposal.id,
    count: clean.length
  });
  audit.entries = audit.entries.slice(0, MAX_AUDIT);
  const sha = await commitFiles(env, {
    "data/pending.json": serializePretty({
      schema: 1,
      proposals: pending.proposals
    }),
    "data/audit.json": serializePretty(audit)
  }, "Proposal from " + user.username);
  return json({
    id: proposal.id,
    sha,
    count: clean.length
  });
}
async function suggest(req, env) {
  const user = await requireUser(req, env);
  if (user.role !== "viewer" && user.role !== "helper") return json({
    error: "Sign in to suggest."
  }, 403);
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return json({
    error: "Invalid body."
  }, 400);
  const cardId = typeof body.cardId === "string" ? body.cardId : "";
  if (!cardId) return json({
    error: "Pick a card."
  }, 400);
  const fields = Array.isArray(body.fields) ? CARD_FIELDS.filter(f => body.fields.includes(f)) : [];
  if (!fields.length) return json({
    error: "Pick at least one field."
  }, 400);
  const reason = String(body.reason || "").trim();
  if (reason.length < 10) return json({
    error: "Add a reason (10+ characters)."
  }, 400);
  const cardsDoc = await readJson(env, "data/cards.json");
  if (!cardsDoc || !Array.isArray(cardsDoc.cards)) return json({
    error: "cards.json is malformed."
  }, 500);
  const card = cardsDoc.cards.find(c => c.id === cardId);
  if (!card) return json({
    error: "Unknown card."
  }, 400);
  const now = Date.now();
  const id = crypto.randomUUID();
  const patch = {
    id: cardId,
    valueOverride: body.valueOverride,
    holoOverride: body.holoOverride,
    demand: body.demand,
    holoDemand: body.holoDemand,
    priceStatus: body.priceStatus,
    note: body.note
  };
  const clone = {
    ...card
  };
  applyCardPatch(clone, patch, now, user.username, fields);
  const change = {
    id: card.id,
    fields,
    valueOverride: clone.valueOverride,
    holoOverride: clone.holoOverride,
    demand: clone.demand,
    holoDemand: clone.holoDemand,
    priceStatus: clone.priceStatus,
    note: clone.note
  };
  const files = {};
  const images = [];
  if (body.images != null) {
    if (!Array.isArray(body.images)) return json({
      error: "Invalid images."
    }, 400);
    if (body.images.length > 3) return json({
      error: "Max 3 images."
    }, 400);
    for (let i = 0; i < body.images.length; i++) {
      const img = body.images[i] || {};
      const type = String(img.type || "").toLowerCase();
      const ext = type === "image/png" ? "png" : type === "image/jpeg" || type === "image/jpg" ? "jpg" : type === "image/webp" ? "webp" : type === "image/gif" ? "gif" : "";
      if (!ext) return json({
        error: "Images must be png, jpg, webp or gif."
      }, 400);
      let data = String(img.data || "");
      const comma = data.indexOf(",");
      if (data.startsWith("data:") && comma !== -1) data = data.slice(comma + 1);
      if (!data) return json({
        error: "Empty image."
      }, 400);
      const bytes = Math.floor(data.length * 3 / 4);
      if (bytes > 2 * 1024 * 1024) return json({
        error: "Each image must be under 2MB."
      }, 400);
      const path = "data/suggestions/" + id + "/" + i + "." + ext;
      files[path] = {
        base64: data
      };
      images.push({
        path,
        type,
        name: String(img.name || "").slice(0, 80)
      });
    }
  }
  const pending = await readJson(env, "data/pending.json").catch(() => ({
    proposals: []
  }));
  pending.proposals = Array.isArray(pending.proposals) ? pending.proposals : [];
  if (pending.proposals.filter(p => p.byId === user.id).length >= 20) return json({
    error: "Too many pending suggestions."
  }, 429);
  if (pending.proposals.length >= 200) return json({
    error: "Suggestion queue is full."
  }, 429);
  const proposal = {
    id,
    at: now,
    by: user.username,
    byId: user.id,
    kind: "suggestion",
    reason,
    message: reason,
    changes: [ change ],
    images
  };
  pending.proposals.unshift(proposal);
  const audit = await readJson(env, "data/audit.json").catch(() => ({
    entries: []
  }));
  audit.entries = Array.isArray(audit.entries) ? audit.entries : [];
  audit.entries.unshift({
    at: now,
    by: user.username,
    byId: user.id,
    action: "suggest",
    proposal: id,
    count: 1
  });
  audit.entries = audit.entries.slice(0, MAX_AUDIT);
  files["data/pending.json"] = serializePretty({
    schema: 1,
    proposals: pending.proposals
  });
  files["data/audit.json"] = serializePretty(audit);
  const sha = await commitFiles(env, files, "Suggestion from " + user.username);
  return json({
    id,
    sha
  });
}
async function listProposals(req, env) {
  const user = await requireUser(req, env);
  if (user.role !== "owner" && user.role !== "admin" && user.role !== "helper" && user.role !== "viewer") return json({
    error: "Not allowed."
  }, 403);
  const pending = await readJson(env, "data/pending.json").catch(() => ({
    proposals: []
  }));
  let proposals = Array.isArray(pending.proposals) ? pending.proposals : [];
  if (user.role === "helper" || user.role === "viewer") proposals = proposals.filter(p => p.byId === user.id);
  return json({
    proposals
  });
}
async function approveProposal(req, env) {
  const user = await requireUser(req, env);
  if (user.role !== "owner" && user.role !== "admin") return json({
    error: "Only owners and admins can approve."
  }, 403);
  const body = await req.json().catch(() => null);
  const id = body && typeof body.id === "string" ? body.id : "";
  if (!id) return json({
    error: "Missing proposal id."
  }, 400);
  const pending = await readJson(env, "data/pending.json").catch(() => ({
    proposals: []
  }));
  pending.proposals = Array.isArray(pending.proposals) ? pending.proposals : [];
  const index = pending.proposals.findIndex(p => p.id === id);
  if (index === -1) return json({
    error: "Proposal not found."
  }, 404);
  const proposal = pending.proposals[index];
  pending.proposals.splice(index, 1);
  const extraAudit = [ {
    at: Date.now(),
    by: user.username,
    byId: user.id,
    action: "approve",
    proposal: proposal.id,
    proposalBy: proposal.by,
    proposalById: proposal.byId,
    count: proposal.changes.length
  } ];
  const extraFiles = {
    "data/pending.json": serializePretty({
      schema: 1,
      proposals: pending.proposals
    })
  };
  (proposal.images || []).forEach(img => {
    if (img && img.path) extraFiles[img.path] = null;
  });
  const result = await applyAndCommit(env, user, proposal.changes, null, "Approve " + proposal.by + (proposal.reason ? ": " + proposal.reason : ""), extraFiles, extraAudit);
  return json(result);
}
async function rejectProposal(req, env) {
  const user = await requireUser(req, env);
  if (user.role !== "owner" && user.role !== "admin") return json({
    error: "Only owners and admins can reject."
  }, 403);
  const body = await req.json().catch(() => null);
  const id = body && typeof body.id === "string" ? body.id : "";
  if (!id) return json({
    error: "Missing proposal id."
  }, 400);
  const pending = await readJson(env, "data/pending.json").catch(() => ({
    proposals: []
  }));
  pending.proposals = Array.isArray(pending.proposals) ? pending.proposals : [];
  const index = pending.proposals.findIndex(p => p.id === id);
  if (index === -1) return json({
    error: "Proposal not found."
  }, 404);
  const proposal = pending.proposals.splice(index, 1)[0];
  const now = Date.now();
  const audit = await readJson(env, "data/audit.json").catch(() => ({
    entries: []
  }));
  audit.entries = Array.isArray(audit.entries) ? audit.entries : [];
  audit.entries.unshift({
    at: now,
    by: user.username,
    byId: user.id,
    action: "reject",
    proposal: proposal.id,
    proposalBy: proposal.by,
    proposalById: proposal.byId,
    count: (proposal.changes || []).length
  });
  audit.entries = audit.entries.slice(0, MAX_AUDIT);
  const files = {
    "data/pending.json": serializePretty({
      schema: 1,
      proposals: pending.proposals
    }),
    "data/audit.json": serializePretty(audit)
  };
  (proposal.images || []).forEach(img => {
    if (img && img.path) files[img.path] = null;
  });
  const sha = await commitFiles(env, files, "Reject " + proposal.by + "'s proposal");
  return json({
    sha
  });
}
async function blockProposalUser(req, env) {
  const user = await requireUser(req, env);
  if (user.role !== "owner" && user.role !== "admin") return json({
    error: "Only owners and admins can block."
  }, 403);
  const body = await req.json().catch(() => null);
  const id = body && typeof body.id === "string" ? body.id : "";
  if (!id) return json({
    error: "Missing proposal id."
  }, 400);
  const pending = await readJson(env, "data/pending.json").catch(() => ({
    proposals: []
  }));
  pending.proposals = Array.isArray(pending.proposals) ? pending.proposals : [];
  const index = pending.proposals.findIndex(p => p.id === id);
  if (index === -1) return json({
    error: "Proposal not found."
  }, 404);
  const targetId = pending.proposals[index].byId;
  if (!targetId) return json({
    error: "Proposal has no user."
  }, 400);
  const roles = normalizeRoles(await readJson(env, "data/roles.json").catch(() => ({
    owner: [],
    admins: [],
    mods: [],
    helpers: [],
    blocked: []
  })));
  if (!roles.blocked.includes(targetId)) roles.blocked.push(targetId);
  const removed = pending.proposals.filter(p => p.byId === targetId);
  pending.proposals = pending.proposals.filter(p => p.byId !== targetId);
  const now = Date.now();
  const audit = await readJson(env, "data/audit.json").catch(() => ({
    entries: []
  }));
  audit.entries = Array.isArray(audit.entries) ? audit.entries : [];
  audit.entries.unshift({
    at: now,
    by: user.username,
    byId: user.id,
    action: "block",
    blocked: targetId,
    rejected: removed.length
  });
  audit.entries = audit.entries.slice(0, MAX_AUDIT);
  const files = {
    "data/roles.json": serializePretty({
      schema: 2,
      note: "Discord user IDs only. The owner is always recognised by the Worker OWNER_USERNAMES / OWNER_DISCORD_IDS too.",
      owner: roles.owner,
      admins: roles.admins,
      mods: roles.mods,
      helpers: roles.helpers,
      blocked: roles.blocked
    }),
    "data/pending.json": serializePretty({
      schema: 1,
      proposals: pending.proposals
    }),
    "data/audit.json": serializePretty(audit)
  };
  removed.forEach(p => {
    (p.images || []).forEach(img => {
      if (img && img.path) files[img.path] = null;
    });
  });
  const name = removed[0] && removed[0].by ? removed[0].by : targetId;
  const sha = await commitFiles(env, files, "Block " + name);
  rolesCache = null;
  return json({
    blocked: targetId,
    rejected: removed.length,
    sha
  });
}

async function auditList(req, env) {
  const user = await requireUser(req, env);
  if (user.role === "viewer") return json({
    error: "Editors only."
  }, 403);
  const audit = await readJson(env, "data/audit.json").catch(() => ({
    entries: []
  }));
  return json({
    entries: Array.isArray(audit.entries) ? audit.entries.slice(0, 100) : []
  });
}

export async function handle(req, env) {
  const url = new URL(req.url);
  const origin = req.headers.get("origin") || "";
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(env, origin)
    });
  }
  try {
    if (url.pathname === "/api/health") return withCors(json({
      ok: true,
      service: "edg-value-api",
      time: Date.now()
    }), env, origin);
    if (url.pathname === "/auth/discord") return await authStart(req, env);
    if (url.pathname === "/auth/discord/callback") return await authCallback(req, env, url);
    if (url.pathname === "/api/session" && req.method === "GET") return withCors(await session(req, env), env, origin);
    if (url.pathname === "/api/roles" && req.method === "GET") return withCors(await getRoles(req, env), env, origin);
    if (url.pathname === "/api/roles" && req.method === "PUT") return withCors(await putRoles(req, env), env, origin);
    if (url.pathname === "/api/commit" && req.method === "POST") return withCors(await commit(req, env), env, origin);
    if (url.pathname === "/api/propose" && req.method === "POST") return withCors(await propose(req, env), env, origin);
    if (url.pathname === "/api/suggest" && req.method === "POST") return withCors(await suggest(req, env), env, origin);
    if (url.pathname === "/api/proposals" && req.method === "GET") return withCors(await listProposals(req, env), env, origin);
    if (url.pathname === "/api/proposals/approve" && req.method === "POST") return withCors(await approveProposal(req, env), env, origin);
    if (url.pathname === "/api/proposals/reject" && req.method === "POST") return withCors(await rejectProposal(req, env), env, origin);
    if (url.pathname === "/api/proposals/block" && req.method === "POST") return withCors(await blockProposalUser(req, env), env, origin);
    if (url.pathname === "/api/audit" && req.method === "GET") return withCors(await auditList(req, env), env, origin);
    return withCors(json({
      error: "Not found."
    }, 404), env, origin);
  } catch (e) {
    return withCors(json({
      error: e.message || "Server error."
    }, e.status || 500), env, origin);
  }
}

export default {
  fetch: handle
};

export { signJwt, verifyJwt, resolveRole, normalizeRoles, validateRoles, validateAnchors, applyCardPatch, serializeCards, corsHeaders };
