import { readFile, writeFile } from "node:fs/promises";

import path from "node:path";

import { ROOT, fetchAllCards, officialCard, blankPendingCard, readJson, writeJson, writeJsonLines } from "./lib.mjs";

const now = Date.now();

const {items, lastSync, total, pages} = await fetchAllCards();

const existing = await readJson("data/cards.json", null);

if (!existing || !Array.isArray(existing.cards)) {
  console.error("data/cards.json missing. Run `npm run seed` first.");
  process.exit(1);
}

const prevById = new Map(existing.cards.map(c => [ c.id, c ]));

const liveIds = new Set(items.map(c => c.id));

let added = 0;

let updated = 0;

let touched = 0;

const cards = items.map(live => {
  const prev = prevById.get(live.id);
  if (!prev) {
    added++;
    return blankPendingCard(live, now);
  }
  const next = {
    ...prev
  };
  const before = JSON.stringify(prev);
  for (const [k, v] of Object.entries(officialCard(live, now))) {
    if ([ "confirmed", "valueOverride", "holoOverride", "demand", "demandSource", "note", "updatedAt", "addedAt" ].includes(k)) continue;
    next[k] = v;
  }
  if (JSON.stringify(next) !== before) touched++;
  return next;
});

for (const prev of existing.cards) {
  if (liveIds.has(prev.id)) continue;
  const next = {
    ...prev,
    active: false
  };
  if (JSON.stringify(next) !== JSON.stringify(prev)) {
    updated++;
    cards.push(next);
  } else {
    cards.push(prev);
  }
}

cards.sort((a, b) => a.rank - b.rank);

const nextDoc = {
  ...existing,
  schema: 1,
  source: "https://demongacha.com/api/levels",
  syncedAt: lastSync || now,
  total,
  cards
};

const changed = JSON.stringify(cards) !== JSON.stringify(existing.cards) || total !== existing.total;

if (!changed) {
  console.log(`No changes. ${cards.length} cards already current.`);
  process.exit(0);
}

await writeJsonLines("data/cards.json", nextDoc, "cards");

const metaPath = path.join(ROOT, "data/meta.json");

let meta = {};

try {
  meta = JSON.parse(await readFile(metaPath, "utf8"));
} catch {}

const confirmed = cards.filter(c => c.confirmed).length;

await writeJson("data/meta.json", {
  ...meta,
  schema: 1,
  syncedAt: lastSync || now,
  updatedAt: now,
  total: cards.length,
  confirmed,
  pending: cards.length - confirmed,
  valued: cards.filter(c => c.valueOverride != null).length,
  demandSet: cards.filter(c => c.demand != null).length,
  pages,
  revision: (Number(meta.revision) || 0) + 1,
  lastChange: {
    added,
    updated,
    touched
  }
});

console.log(`Synced ${cards.length} cards. Added ${added}, field-updated ${touched}, deactivated ${updated}.`);
