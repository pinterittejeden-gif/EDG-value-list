// Discord OAuth + GitHub publishing API for the Demon Gacha value list.
// Deploy on Cloudflare Workers. Only this Worker holds the Discord client secret
// and the GitHub write token. Browsers never see either.
//
// Roles are stored in data/roles.json as Discord user IDs. The owner is also
// recognised by OWNER_DISCORD_IDS / OWNER_USERNAMES, so "vxef" always has the
// admin panel even before their ID is written into the repo.

const DISCORD_API = "https://discord.com/api/v10";
const GH = "https://api.github.com";
const SESSION_TTL = 60 * 60 * 12;
const MAX_CHANGES = 200;
const MAX_AUDIT = 500;
const MAX_IDS_PER_ROLE = 200;
const ROLES_CACHE_MS = 30000;

const enc = new TextEncoder();
let rolesCache = null;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra }
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
  const pad = s.length % 4 ? "=".repeat(4 - (s.length % 4)) : "";
  const bin = atob(s + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacKey(secret) {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function signJwt(payload, secret) {
  const head = b64urlJson({ alg: "HS256", typ: "JWT" });
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
    const payload = JSON.parse(new TextDecoder().decode(fromB64url(parts[1])));
    if (!payload || typeof payload.exp !== "number" || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

function origins(env) {
  return String(env.ALLOWED_ORIGINS || env.SITE_URL || "")
    .split(",").map((s) => s.trim()).filter(Boolean);
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
  return String(env[name] || "").split(",").map((s) => s.trim()).filter(Boolean);
}

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

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
      ...(opts.body ? { "content-type": "application/json" } : {})
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch {}
  if (!res.ok) {
    const e = new Error((data && (data.message || data.error)) || ("GitHub HTTP " + res.status));
    e.status = res.status === 401 || res.status === 403 ? 502 : res.status;
    throw e;
  }
  return data;
}

async function readText(env, path) {
  const res = await fetch(
    GH + repoBase(env) + "/contents/" + encPath(path) + "?ref=" + encodeURIComponent(env.BRANCH || "main"),
    { headers: { authorization: "Bearer " + env.GITHUB_TOKEN, accept: "application/vnd.github.raw", "x-github-api-version": "2022-11-28" } }
  );
  if (!res.ok) throw fail("Could not read " + path + " (HTTP " + res.status + ").", 502);
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
  for (const [path, content] of Object.entries(files)) {
    const blob = await gh(env, base + "/git/blobs", { method: "POST", body: { content, encoding: "utf-8" } });
    tree.push({ path, mode: "100644", type: "blob", sha: blob.sha });
  }
  const newTree = await gh(env, base + "/git/trees", { method: "POST", body: { base_tree: parent.tree.sha, tree } });
  const commit = await gh(env, base + "/git/commits", { method: "POST", body: { message, tree: newTree.sha, parents: [parentSha] } });
  await gh(env, base + "/git/refs/heads/" + branch, { method: "PATCH", body: { sha: commit.sha, force: false } });
  return commit.sha;
}

// One card per line, matching scripts/lib.mjs so GitHub diffs stay clean.
function serializeCards(doc) {
  const rest = {};
  for (const [k, v] of Object.entries(doc)) if (k !== "cards") rest[k] = v;
  const head = JSON.stringify(rest, null, 2).replace(/\n}$/, "");
  let out = "{\n" + head.slice(2) + ",\n  \"cards\": [\n";
  out += doc.cards.map((c) => "    " + JSON.stringify(c)).join(",\n");
  out += "\n  ]\n}\n";
  return out;
}

function serializePretty(obj) {
  return JSON.stringify(obj, null, 2) + "\n";
}

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

function normalizeRoles(data) {
  const list = (v) => (Array.isArray(v) ? v.map((x) => {
    if (typeof x === "string") return x.trim();
    if (x && typeof x === "object" && x.id) return String(x.id);
    return "";
  }).filter(Boolean) : []);
  const owner = list(data && data.owner);
  const admins = list(data && data.admins).filter((id) => !owner.includes(id));
  const mods = list(data && data.mods).filter((id) => !owner.includes(id) && !admins.includes(id));
  return { owner, admins, mods };
}

async function readRoles(env, force = false) {
  const now = Date.now();
  if (!force && rolesCache && now - rolesCache.at < ROLES_CACHE_MS) return rolesCache.data;
  const data = await readJson(env, "data/roles.json").catch(() => ({ owner: [], admins: [], mods: [] }));
  rolesCache = { at: now, data: normalizeRoles(data) };
  return rolesCache.data;
}

async function resolveRole(user, env) {
  const id = String((user && user.id) || "");
  const username = String((user && user.username) || "").toLowerCase();
  if (id && envList(env, "OWNER_DISCORD_IDS").includes(id)) return "owner";
  if (username && envList(env, "OWNER_USERNAMES").map((s) => s.toLowerCase()).includes(username)) return "owner";
  const roles = await readRoles(env);
  if (id && roles.owner.includes(id)) return "owner";
  if (id && roles.admins.includes(id)) return "admin";
  if (id && roles.mods.includes(id)) return "mod";
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
  const admins = clean(body.admins, "admins").filter((id) => !owner.includes(id));
  const mods = clean(body.mods, "mods").filter((id) => !owner.includes(id) && !admins.includes(id));
  return { owner, admins, mods };
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

async function requireUser(req, env) {
  const auth = req.headers.get("authorization") || "";
  const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  const payload = await verifyJwt(token, env.SESSION_SECRET);
  if (!payload) throw fail("Sign in with Discord first.", 401);
  const user = { id: String(payload.sub), username: String(payload.username || ""), global_name: String(payload.global_name || payload.username || "") };
  user.role = await resolveRole(user, env);
  return user;
}

async function authStart(req, env) {
  if (!env.DISCORD_CLIENT_ID) return fail("Discord client id is not configured.", 500);
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
  if (!code || !state || state !== expected) return fail("Invalid or expired OAuth state. Start again.", 400);

  const body = new URLSearchParams({
    client_id: env.DISCORD_CLIENT_ID,
    client_secret: env.DISCORD_CLIENT_SECRET,
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri(req, env)
  });
  const tokenRes = await fetch(DISCORD_API + "/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body
  });
  if (!tokenRes.ok) return fail("Discord token exchange failed.", 502);
  const token = await tokenRes.json();
  if (!token.access_token) return fail("Discord did not return an access token.", 502);

  const userRes = await fetch(DISCORD_API + "/users/@me", { headers: { authorization: "Bearer " + token.access_token } });
  if (!userRes.ok) return fail("Discord user lookup failed.", 502);
  const user = await userRes.json();
  if (!user || !user.id) return fail("Discord did not return a user.", 502);

  const role = await resolveRole(user, env);
  const now = Math.floor(Date.now() / 1000);
  const jwt = await signJwt({
    sub: String(user.id),
    username: user.username || "",
    global_name: user.global_name || user.username || "",
    role,
    iat: now,
    exp: now + SESSION_TTL
  }, env.SESSION_SECRET);

  const site = env.SITE_URL || origins(env)[0];
  if (!site) return fail("SITE_URL is not configured.", 500);
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

// ---------------------------------------------------------------------------
// Card change validation
// ---------------------------------------------------------------------------

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

function applyCardPatch(card, patch, now, by) {
  if (!patch || typeof patch !== "object") throw fail("Invalid card change.", 400);
  if (typeof patch.id !== "string" || !patch.id) throw fail("Card change is missing an id.", 400);

  const valueOverride = asNumberOrNull(patch.valueOverride, "Value", 0, 1e9);
  const holoOverride = asNumberOrNull(patch.holoOverride, "Holo value", 0, 1e9);
  const demand = asDemand(patch.demand, "Demand");
  const holoDemand = asDemand(patch.holoDemand, "Holo demand");
  const note = patch.note == null ? "" : String(patch.note).slice(0, 500);

  const changes = {};
  if (valueOverride !== (card.valueOverride == null ? null : card.valueOverride)) changes.value = { from: card.valueOverride, to: valueOverride };
  if (holoOverride !== (card.holoOverride == null ? null : card.holoOverride)) changes.holo = { from: card.holoOverride, to: holoOverride };
  if (demand !== (card.demand == null ? null : card.demand)) changes.demand = { from: card.demand, to: demand };
  if (holoDemand !== (card.holoDemand == null ? null : card.holoDemand)) changes.holoDemand = { from: card.holoDemand, to: holoDemand };
  if (note !== (card.note || "")) changes.note = true;
  if (card.confirmed === false) changes.confirmed = true;

  if (changes.value || changes.holo) card.valueSource = valueOverride == null ? null : "manual";
  if (changes.demand) card.demandSource = demand == null ? null : "manual";
  if (changes.holoDemand) card.holoDemandSource = holoDemand == null ? null : "manual";

  card.valueOverride = valueOverride;
  card.holoOverride = holoOverride;
  card.demand = demand;
  card.holoDemand = holoDemand;
  card.note = note;
  card.confirmed = true;
  card.updatedAt = now;

  return { id: card.id, name: card.name, changes };
}

function validateAnchors(input) {
  if (!input || typeof input !== "object" || !Array.isArray(input.anchors)) throw fail("Invalid anchors body.", 400);
  if (input.anchors.length < 2) throw fail("Keep at least two anchors.", 400);
  if (input.anchors.length > 30) throw fail("Too many anchors.", 400);
  const seen = new Set();
  const out = [];
  for (const a of input.anchors) {
    const rank = Math.round(Number(a && a.rank));
    const value = Number(a && a.value);
    if (!Number.isInteger(rank) || rank < 1) throw fail("Anchor rank must be a positive whole number.", 400);
    if (!Number.isFinite(value) || value <= 0) throw fail("Anchor value must be positive.", 400);
    if (seen.has(rank)) throw fail("Two anchors share rank " + rank + ".", 400);
    seen.add(rank);
    out.push({ rank, value, label: String((a && a.label) || "").slice(0, 40) });
  }
  out.sort((a, b) => a.rank - b.rank);
  return {
    schema: 1,
    unit: input.unit || { rank: 25, note: "1.00 is the card sitting at rank 25." },
    curve: input.curve || { interpolation: "log-log", min: 0.001, decimals: 2 },
    anchors: out,
    demand: input.demand || {}
  };
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

async function session(req, env) {
  const user = await requireUser(req, env);
  return json({ user, role: user.role });
}

async function getRoles(req, env) {
  const user = await requireUser(req, env);
  if (user.role !== "owner") return json({ error: "Only the owner can view access control." }, 403);
  const roles = normalizeRoles(await readJson(env, "data/roles.json"));
  return json({ roles, you: user });
}

async function putRoles(req, env) {
  const user = await requireUser(req, env);
  if (user.role !== "owner") return json({ error: "Only the owner can change access." }, 403);
  const body = await req.json().catch(() => null);
  const roles = validateRoles(body);

  const now = Date.now();
  const audit = await readJson(env, "data/audit.json").catch(() => ({ entries: [] }));
  audit.entries = Array.isArray(audit.entries) ? audit.entries : [];
  audit.entries.unshift({
    at: now, by: user.username, byId: user.id, action: "roles",
    owner: roles.owner.length, admins: roles.admins.length, mods: roles.mods.length
  });
  audit.entries = audit.entries.slice(0, MAX_AUDIT);

  const files = {
    "data/roles.json": serializePretty({
      schema: 2,
      note: "Discord user IDs only. The owner is always recognised by the Worker OWNER_USERNAMES / OWNER_DISCORD_IDS too.",
      owner: roles.owner,
      admins: roles.admins,
      mods: roles.mods
    }),
    "data/audit.json": serializePretty(audit)
  };
  const sha = await commitFiles(env, files, "Update editor roles");
  rolesCache = null;
  return json({ roles, sha });
}

async function commit(req, env) {
  const user = await requireUser(req, env);
  if (user.role === "viewer") return json({ error: "Your Discord account is not on the editor list." }, 403);

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return json({ error: "Invalid body." }, 400);
  const changes = Array.isArray(body.changes) ? body.changes : [];
  if (changes.length > MAX_CHANGES) return json({ error: "Too many changes in one commit." }, 400);
  if (changes.length === 0 && !body.anchors) return json({ error: "Nothing to commit." }, 400);

  const now = Date.now();
  const cardsDoc = await readJson(env, "data/cards.json");
  if (!cardsDoc || !Array.isArray(cardsDoc.cards)) return json({ error: "cards.json is malformed." }, 500);
  const byId = new Map(cardsDoc.cards.map((c) => [c.id, c]));
  const auditEntries = [];
  let applied = 0;

  for (const patch of changes) {
    if (!patch || typeof patch.id !== "string") return json({ error: "A card change is missing an id." }, 400);
    const card = byId.get(patch.id);
    if (!card) return json({ error: "Unknown card id: " + patch.id }, 400);
    auditEntries.push(applyCardPatch(card, patch, now, user.username));
    applied++;
  }

  const files = {};
  const audit = await readJson(env, "data/audit.json").catch(() => ({ entries: [] }));
  audit.entries = Array.isArray(audit.entries) ? audit.entries : [];

  if (body.anchors) {
    if (user.role !== "admin" && user.role !== "owner") {
      return json({ error: "Only admins and owners can change the curve." }, 403);
    }
    const anchors = validateAnchors(body.anchors);
    files["data/anchors.json"] = serializePretty(anchors);
    auditEntries.push({ at: now, by: user.username, byId: user.id, action: "anchors", ranks: anchors.anchors.map((a) => a.rank) });
  }

  if (applied > 0) {
    cardsDoc.cards.sort((a, b) => a.rank - b.rank);
    files["data/cards.json"] = serializeCards(cardsDoc);
  }

  const confirmed = cardsDoc.cards.filter((c) => c.confirmed !== false).length;
  const meta = {
    schema: 1,
    syncedAt: cardsDoc.syncedAt || now,
    generatedAt: now,
    total: cardsDoc.cards.length,
    confirmed,
    pending: cardsDoc.cards.length - confirmed,
    valued: cardsDoc.cards.filter((c) => c.valueOverride != null).length,
    demandSet: cardsDoc.cards.filter((c) => c.demand != null).length,
    revision: (Number((await readJson(env, "data/meta.json").catch(() => ({}))).revision) || 0) + 1
  };
  files["data/meta.json"] = serializePretty(meta);

  audit.entries = auditEntries.map((e) => ({ ...e, by: user.username })).concat(audit.entries).slice(0, MAX_AUDIT);
  files["data/audit.json"] = serializePretty(audit);

  const sha = await commitFiles(env, files, String(body.message || "Update values").slice(0, 120));
  return json({ sha, applied });
}

async function auditList(req, env) {
  const user = await requireUser(req, env);
  if (user.role === "viewer") return json({ error: "Editors only." }, 403);
  const audit = await readJson(env, "data/audit.json").catch(() => ({ entries: [] }));
  return json({ entries: Array.isArray(audit.entries) ? audit.entries.slice(0, 100) : [] });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export async function handle(req, env) {
  const url = new URL(req.url);
  const origin = req.headers.get("origin") || "";

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(env, origin) });
  }

  try {
    if (url.pathname === "/api/health") return withCors(json({ ok: true, service: "edg-value-api", time: Date.now() }), env, origin);
    if (url.pathname === "/auth/discord") return await authStart(req, env);
    if (url.pathname === "/auth/discord/callback") return await authCallback(req, env, url);
    if (url.pathname === "/api/session" && req.method === "GET") return withCors(await session(req, env), env, origin);
    if (url.pathname === "/api/roles" && req.method === "GET") return withCors(await getRoles(req, env), env, origin);
    if (url.pathname === "/api/roles" && req.method === "PUT") return withCors(await putRoles(req, env), env, origin);
    if (url.pathname === "/api/commit" && req.method === "POST") return withCors(await commit(req, env), env, origin);
    if (url.pathname === "/api/audit" && req.method === "GET") return withCors(await auditList(req, env), env, origin);
    return withCors(json({ error: "Not found." }, 404), env, origin);
  } catch (e) {
    return withCors(json({ error: e.message || "Server error." }, e.status || 500), env, origin);
  }
}

export default { fetch: handle };

export { signJwt, verifyJwt, resolveRole, normalizeRoles, validateRoles, validateAnchors, applyCardPatch, serializeCards, corsHeaders };
