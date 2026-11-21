import { readFile, writeFile } from "node:fs/promises";

import { existsSync } from "node:fs";

import path from "node:path";

import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const BASE = "https://demongacha.com";

export const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

export const TIER_ORDER = [ "Apex", "Mythic", "Legendary", "Epic", "Rare", "Uncommon", "Common" ];

export const DEMAND_SEED = {
  Apex: 10,
  Mythic: 9,
  Legendary: 8,
  Epic: 7,
  Rare: 5,
  Uncommon: 3,
  Common: 1
};

export async function readJson(rel, fallback) {
  const p = path.join(ROOT, rel);
  if (!existsSync(p)) return fallback;
  return JSON.parse(await readFile(p, "utf8"));
}

export async function writeJsonLines(rel, obj, arrayKey) {
  const {[arrayKey]: arr, ...rest} = obj;
  const head = JSON.stringify(rest, null, 2).replace(/\n}$/, "");
  const lines = [ "{", head.slice(2) + ",", `  ${JSON.stringify(arrayKey)}: [` ];
  arr.forEach((item, i) => {
    lines.push(`    ${JSON.stringify(item)}${i === arr.length - 1 ? "" : ","}`);
  });
  lines.push("  ]", "}", "");
  await writeFile(path.join(ROOT, rel), lines.join("\n"), "utf8");
}

export async function writeJson(rel, obj) {
  await writeFile(path.join(ROOT, rel), JSON.stringify(obj, null, 2) + "\n", "utf8");
}

async function fetchPage(page, pageSize) {
  const url = `${BASE}/api/levels?page=${page}&pageSize=${pageSize}`;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          "user-agent": UA,
          accept: "application/json"
        },
        signal: AbortSignal.timeout(3e4)
      });
      if (res.status === 429 || res.status === 503) {
        await new Promise(r => setTimeout(r, 2500 * (attempt + 1)));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (!Array.isArray(json.items)) throw new Error("Malformed response");
      return json;
    } catch (err) {
      if (attempt === 3) throw err;
      await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  throw new Error("Unreachable");
}

export async function fetchAllCards(pageSize = 200) {
  const first = await fetchPage(1, pageSize);
  const pages = Number(first.pages) || 1;
  const items = [ ...first.items ];
  for (let page = 2; page <= pages; page++) {
    const next = await fetchPage(page, pageSize);
    items.push(...next.items);
    process.stdout.write(`\rFetched page ${page}/${pages}`);
    await new Promise(r => setTimeout(r, 350));
  }
  process.stdout.write("\n");
  return {
    items,
    lastSync: first.lastSync,
    total: Number(first.total) || items.length,
    pages
  };
}

export function officialCard(card, now) {
  return {
    id: card.id,
    rank: card.rank,
    name: card.name,
    tier: card.tier,
    creator: card.creator,
    verifier: card.verifier,
    points: card.points,
    officialValue: card.value,
    p: card.p,
    twoPlayer: !!card.twoPlayer,
    active: !!card.active,
    tags: Array.isArray(card.tags) ? card.tags : [],
    description: card.description || "",
    thumb: card.thumb || "",
    video: card.video || "",
    aredlUrl: card.aredlUrl || "",
    gdId: card.gdId ?? null,
    confirmed: true,
    valueOverride: null,
    valueSource: null,
    holoOverride: null,
    demand: DEMAND_SEED[card.tier] ?? null,
    demandSource: "seed",
    holoDemand: null,
    holoDemandSource: null,
    priceStatus: null,
    note: "",
    updatedAt: null,
    addedAt: now
  };
}

export function blankNewCard(card, now) {
  return {
    ...officialCard(card, now),
    confirmed: false,
    demand: null,
    demandSource: null
  };
}
