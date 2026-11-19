import { readFile, writeFile } from "node:fs/promises";

import path from "node:path";

import { ROOT, readJson, writeJson, writeJsonLines } from "./lib.mjs";

const SHEET_ID = "1zSUN6pZ-kzTptvaG_gEPOAkldx38Qwuv16_4iNqG1d0";

const SHEET_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit?gid=0#gid=0`;

const CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=0`;

const SNAPSHOT = "data/sheet-source.csv";

const DEMAND = {
  "very high demand": 10,
  "high demand": 8,
  "normal demand": 6,
  "low demand": 4,
  "very low demand": 2
};

function parseCsv(text) {
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true; else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (c !== "\r") field += c;
  }
  row.push(field);
  if (row.length > 1 || row[0]) rows.push(row);
  return rows;
}

function digits(v) {
  const s = String(v == null ? "" : v).replace(/,/g, "").replace(/%/g, "").trim();
  if (!s || !/^\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function normName(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function demandOf(v) {
  const key = String(v || "").trim().toLowerCase();
  return DEMAND[key] != null ? DEMAND[key] : null;
}

async function loadCsv() {
  try {
    const res = await fetch(CSV_URL, {
      headers: {
        "user-agent": "Mozilla/5.0",
        accept: "text/csv"
      },
      signal: AbortSignal.timeout(3e4)
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const text = await res.text();
    if (!text || text.length < 100) throw new Error("Empty response");
    return {
      text,
      live: true
    };
  } catch (err) {
    console.warn("Live fetch failed (" + err.message + "), using " + SNAPSHOT);
    return {
      text: await readFile(path.join(ROOT, SNAPSHOT), "utf8"),
      live: false
    };
  }
}

const {text: csv, live} = await loadCsv();

const rows = parseCsv(csv).slice(2).filter(r => r.some(x => x.trim()));

const doc = await readJson("data/cards.json", null);

if (!doc || !Array.isArray(doc.cards)) {
  console.error("data/cards.json missing. Run npm run seed first.");
  process.exit(1);
}

const anchorsDoc = await readJson("data/anchors.json", {
  schema: 1,
  unit: {
    rank: 25,
    note: "1.00 is the card sitting at rank 25."
  },
  curve: {
    interpolation: "log-log",
    min: .001,
    decimals: 2
  },
  anchors: [],
  demand: {}
});

const beforeCards = JSON.stringify(doc);

const beforeAnchors = JSON.stringify(anchorsDoc);

const cards = doc.cards;

const byName = new Map(cards.map(c => [ normName(c.name), c ]));

const byRank = new Map(cards.map(c => [ Number(c.rank), c ]));

const sheetRows = [];

for (const r of rows) {
  const rank = Number(r[1]);
  const name = String(r[3] || "").trim();
  if (!name) continue;
  sheetRows.push({
    rank: Number.isFinite(rank) ? rank : null,
    name,
    value: digits(r[7]),
    holo: digits(r[8]),
    demand: demandOf(r[10]),
    holoDemand: demandOf(r[11])
  });
}

const unitRow = sheetRows.find(r => r.rank === 25 && r.value) || sheetRows.find(r => normName(r.name) === "avernus" && r.value);

if (!unitRow) {
  console.error("Could not find the rank-25 unit value in the sheet.");
  process.exit(1);
}

const unitValue = unitRow.value;

const unit = v => Math.round(v / unitValue * 1e3) / 1e3;

let matchedName = 0, matchedRank = 0, priced = 0, holoPriced = 0, demands = 0, holoDemands = 0;

const numericCards = [];

for (const row of sheetRows) {
  let card = byName.get(normName(row.name));
  if (card) matchedName++; else {
    const byR = row.rank ? byRank.get(row.rank) : null;
    if (byR && normName(byR.name) === normName(row.name)) {
      card = byR;
      matchedRank++;
    }
  }
  if (!card) continue;
  const manual = card.valueSource === "manual" || card.demandSource === "manual" || card.holoDemandSource === "manual" || card.priceStatus != null || (card.valueOverride != null && card.valueSource !== "sheet") || (card.holoOverride != null && card.valueSource !== "sheet") || (card.demand != null && card.demandSource !== "sheet" && card.demandSource !== "seed") || (card.holoDemand != null && card.holoDemandSource !== "sheet");
  let sheetUnits = null;
  if (row.value != null) {
    sheetUnits = unit(row.value);
    numericCards.push({
      card,
      units: sheetUnits
    });
  }
  if (manual) continue;
  if (sheetUnits != null) {
    card.valueOverride = sheetUnits;
    card.valueSource = "sheet";
    priced++;
  }
  if (row.holo != null) {
    card.holoOverride = unit(row.holo);
    holoPriced++;
  }
  if (row.demand != null) {
    card.demand = row.demand;
    card.demandSource = "sheet";
    demands++;
  }
  if (row.holoDemand != null) {
    card.holoDemand = row.holoDemand;
    card.holoDemandSource = "sheet";
    holoDemands++;
  }
}

cards.sort((a, b) => a.rank - b.rank);

const nextDoc = {
  ...doc,
  syncedAt: doc.syncedAt,
  sheetImport: {
    url: SHEET_URL,
    unit: "rank 25",
    unitValue,
    priced
  },
  cards
};

const grief = numericCards.find(n => normName(n.card.name) === "grief");

const avernus = cards.find(c => normName(c.name) === "avernus") || cards.find(c => Number(c.rank) === 25);

const low = numericCards.slice().sort((a, b) => Math.abs(a.card.rank - 100) - Math.abs(b.card.rank - 100))[0];

const avernusOfficial = avernus && avernus.officialValue ? avernus.officialValue : 1100;

const officialValues = cards.map(c => c.officialValue).filter(v => Number.isFinite(v));

const bottomOfficial = officialValues.length ? Math.min.apply(null, officialValues) : null;

const maxRank = Math.max.apply(null, cards.map(c => Number(c.rank) || 0));

const anchors = [];

if (grief) anchors.push({
  rank: 1,
  value: grief.units,
  label: "GRIEF (sheet)",
  provisional: false
});

anchors.push({
  rank: 25,
  value: 1,
  label: "rank 25",
  provisional: false
});

if (low && low.card.rank > 25) {
  anchors.push({
    rank: low.card.rank,
    value: low.units,
    label: low.card.name + " (sheet)",
    provisional: false
  });
}

if (Number.isFinite(bottomOfficial)) {
  anchors.push({
    rank: maxRank,
    value: Math.round(bottomOfficial / avernusOfficial * 1e4) / 1e4,
    label: "bottom (site ratio)",
    provisional: true
  });
}

const seen = new Set;

anchorsDoc.anchors = anchors.filter(a => {
  if (seen.has(a.rank)) return false;
  seen.add(a.rank);
  return Number.isFinite(a.value) && a.value > 0;
}).sort((a, b) => a.rank - b.rank);

anchorsDoc.unit = {
  rank: 25,
  note: "1.00 is the card sitting at rank 25 (Avernus). Top-tier values and demand follow the community sheet."
};

anchorsDoc.curve = anchorsDoc.curve || {
  interpolation: "log-log",
  min: .001,
  decimals: 2
};

const cardsChanged = JSON.stringify(nextDoc) !== beforeCards;

const anchorsChanged = JSON.stringify(anchorsDoc) !== beforeAnchors;

if (!cardsChanged && !anchorsChanged) {
  console.log(`No value changes. ${priced} priced cards already current.`);
  process.exit(0);
}

if (live) await writeFile(path.join(ROOT, SNAPSHOT), csv, "utf8");

await writeJsonLines("data/cards.json", nextDoc, "cards");

await writeJson("data/anchors.json", anchorsDoc);

const audit = await readJson("data/audit.json", {
  schema: 1,
  entries: []
});

audit.entries = Array.isArray(audit.entries) ? audit.entries : [];

audit.entries.unshift({
  at: Date.now(),
  by: "import",
  action: "sheet-import",
  url: SHEET_URL,
  priced,
  holoPriced,
  demands,
  holoDemands,
  unitValue
});

audit.entries = audit.entries.slice(0, 500);

await writeJson("data/audit.json", audit);

const meta = await readJson("data/meta.json", {});

await writeJson("data/meta.json", {
  ...meta,
  schema: 1,
  generatedAt: Date.now(),
  total: cards.length,
  confirmed: cards.filter(c => c.confirmed !== false).length,
  pending: cards.filter(c => c.confirmed === false).length,
  valued: cards.filter(c => c.valueOverride != null).length,
  demandSet: cards.filter(c => c.demand != null).length,
  revision: (Number(meta.revision) || 0) + 1,
  sheetImport: {
    url: SHEET_URL,
    unitValue,
    priced,
    holoPriced,
    demands,
    holoDemands,
    at: Date.now()
  }
});

console.log(JSON.stringify({
  sheetRows: sheetRows.length,
  matchedName,
  matchedRank,
  unitValue,
  griefUnits: grief ? grief.units : null,
  priced,
  holoPriced,
  demands,
  holoDemands,
  anchors: anchorsDoc.anchors
}, null, 2));
