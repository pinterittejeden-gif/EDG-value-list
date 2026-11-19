import assert from "node:assert/strict";

import { handle, signJwt, validateRoles, validateAnchors, applyCardPatch, serializeCards, normalizeRoles } from "../worker.js";

const env = {
  SESSION_SECRET: "test-session-secret-please-change",
  DISCORD_CLIENT_ID: "123456789",
  DISCORD_CLIENT_SECRET: "secret",
  OWNER_USERNAMES: "vxef",
  OWNER_DISCORD_IDS: "",
  SITE_URL: "https://example.com/EDG-value-list/",
  ALLOWED_ORIGINS: "https://example.com,http://127.0.0.1:8090",
  REPO_OWNER: "pinterittejeden-gif",
  REPO_NAME: "EDG-value-list",
  BRANCH: "main",
  GITHUB_TOKEN: "not-used-in-these-tests"
};

const api = (path, opts = {}) => new Request("https://worker.test" + path, opts);

let pass = 0;

function ok(name) {
  pass++;
  console.log("ok - " + name);
}

{
  const res = await handle(api("/api/health"), env);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  ok("health");
}

{
  const res = await handle(api("/auth/discord"), env);
  assert.equal(res.status, 302);
  const loc = res.headers.get("location");
  assert.match(loc, /discord\.com\/oauth2\/authorize/);
  assert.match(loc, /client_id=123456789/);
  assert.match(loc, /scope=identify/);
  assert.match(res.headers.get("set-cookie"), /dg_state=.*HttpOnly/);
  ok("discord authorize redirect");
}

{
  const res = await handle(api("/api/session"), env);
  assert.equal(res.status, 401);
  ok("session rejects anonymous");
}

{
  const now = Math.floor(Date.now() / 1e3);
  const token = await signJwt({
    sub: "111111111111111111",
    username: "vxef",
    exp: now + 3600
  }, env.SESSION_SECRET);
  const res = await handle(api("/api/session", {
    headers: {
      authorization: "Bearer " + token
    }
  }), env);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.role, "owner");
  assert.equal(body.user.username, "vxef");
  ok("owner session resolved");
}

{
  const now = Math.floor(Date.now() / 1e3);
  const token = await signJwt({
    sub: "1",
    username: "vxef",
    exp: now + 3600
  }, "wrong-secret");
  const res = await handle(api("/api/session", {
    headers: {
      authorization: "Bearer " + token
    }
  }), env);
  assert.equal(res.status, 401);
  ok("forged token rejected");
}

{
  const res = await handle(api("/api/commit", {
    method: "OPTIONS",
    headers: {
      origin: "https://example.com"
    }
  }), env);
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("access-control-allow-origin"), "https://example.com");
  ok("cors preflight");
}

{
  const roles = validateRoles({
    owner: [ "111111111111111111" ],
    admins: [ "222222222222222222", "222222222222222222", "111111111111111111" ],
    mods: [ "333333333333333333", "222222222222222222" ],
    helpers: [ "444444444444444444", "333333333333333333" ]
  });
  assert.deepEqual(roles.owner, [ "111111111111111111" ]);
  assert.deepEqual(roles.admins, [ "222222222222222222" ]);
  assert.deepEqual(roles.mods, [ "333333333333333333" ]);
  assert.deepEqual(roles.helpers, [ "444444444444444444" ]);
  assert.throws(() => validateRoles({
    owner: [ "not-an-id" ]
  }), /Invalid Discord ID/);
  ok("roles validation");
}

{
  const anchors = validateAnchors({
    anchors: [ {
      rank: 25,
      value: 1
    }, {
      rank: 1,
      value: 20.5
    } ]
  });
  assert.deepEqual(anchors.anchors.map(a => a.rank), [ 1, 25 ]);
  assert.throws(() => validateAnchors({
    anchors: [ {
      rank: 1,
      value: 2
    }, {
      rank: 1,
      value: 3
    } ]
  }), /share rank/);
  assert.throws(() => validateAnchors({
    anchors: [ {
      rank: 0,
      value: 1
    }, {
      rank: 25,
      value: 1
    } ]
  }), /rank/);
  ok("anchor validation");
}

{
  const card = {
    id: "f3dd5ead-dda4-415c-affb-2308dd09a0d4",
    name: "GRIEF",
    rank: 1,
    confirmed: true,
    valueOverride: 23.226,
    holoOverride: 70.968,
    demand: 10,
    holoDemand: null,
    priceStatus: null,
    note: "",
    valueSource: "sheet",
    demandSource: "sheet"
  };
  const now = Date.now();
  const audit = applyCardPatch(card, {
    id: card.id,
    valueOverride: 24,
    holoOverride: 72,
    demand: 9,
    holoDemand: 10,
    priceStatus: "over",
    note: "test"
  }, now, "vxef");
  assert.equal(card.valueOverride, 24);
  assert.equal(card.holoOverride, 72);
  assert.equal(card.demand, 9);
  assert.equal(card.holoDemand, 10);
  assert.equal(card.priceStatus, "over");
  assert.equal(card.note, "test");
  assert.equal(card.valueSource, "manual");
  assert.equal(card.updatedAt, now);
  assert.ok(audit.changes.value);
  assert.ok(audit.changes.holoDemand);
  assert.ok(audit.changes.priceStatus);
  assert.throws(() => applyCardPatch(card, {
    id: card.id,
    priceStatus: "wat"
  }, now, "vxef"), /price/);
  assert.throws(() => applyCardPatch(card, {
    id: card.id,
    demand: 11
  }, now, "vxef"), /Demand/);
  assert.throws(() => applyCardPatch(card, {
    id: card.id,
    valueOverride: -1
  }, now, "vxef"), /Value/);
  ok("card patch apply + validation");
}

{
  const text = serializeCards({
    schema: 1,
    total: 1,
    cards: [ {
      id: "a",
      rank: 1,
      name: "X"
    } ]
  });
  const parsed = JSON.parse(text);
  assert.equal(parsed.cards.length, 1);
  assert.equal(parsed.cards[0].name, "X");
  assert.ok(text.includes("\n    {"), "card is on its own line");
  ok("card serializer");
}

{
  const roles = normalizeRoles({
    owner: [ {
      id: "111111111111111111"
    } ],
    admins: [],
    mods: []
  });
  assert.deepEqual(roles.owner, [ "111111111111111111" ]);
  ok("roles normalization");
}

console.log(`\n${pass} checks passed.`);
