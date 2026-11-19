import { existsSync } from "node:fs";

import path from "node:path";

import { ROOT, fetchAllCards, officialCard, readJson, writeJson, writeJsonLines } from "./lib.mjs";

const now = Date.now();

const {items, lastSync, total, pages} = await fetchAllCards();

const existing = await readJson("data/cards.json", null);

const prevById = new Map;

if (existing && Array.isArray(existing.cards)) {
  for (const c of existing.cards) prevById.set(c.id, c);
}

const cards = items.map(live => {
  const base = officialCard(live, now);
  const prev = prevById.get(live.id);
  if (prev) {
    return {
      ...base,
      confirmed: prev.confirmed !== false,
      valueOverride: prev.valueOverride ?? null,
      valueSource: prev.valueSource ?? null,
      holoOverride: prev.holoOverride ?? null,
      demand: prev.demand ?? base.demand,
      demandSource: prev.demandSource ?? base.demandSource,
      holoDemand: prev.holoDemand ?? null,
      holoDemandSource: prev.holoDemandSource ?? null,
      note: prev.note || "",
      updatedAt: prev.updatedAt ?? null,
      addedAt: prev.addedAt ?? now
    };
  }
  return base;
});

cards.sort((a, b) => a.rank - b.rank);

await writeJsonLines("data/cards.json", {
  ...existing || {},
  schema: 1,
  source: "https://demongacha.com/api/levels",
  syncedAt: lastSync || now,
  total,
  cards
}, "cards");

const confirmed = cards.filter(c => c.confirmed).length;

await writeJson("data/meta.json", {
  schema: 1,
  syncedAt: lastSync || now,
  generatedAt: now,
  total: cards.length,
  confirmed,
  pending: cards.length - confirmed,
  valued: cards.filter(c => c.valueOverride != null).length,
  demandSet: cards.filter(c => c.demand != null).length,
  pages
});

if (!existsSync(path.join(ROOT, "data/audit.json"))) {
  await writeJson("data/audit.json", {
    schema: 1,
    entries: []
  });
}

console.log(`Seeded ${cards.length} cards (${confirmed} confirmed, ${cards.length - confirmed} pending).`);
