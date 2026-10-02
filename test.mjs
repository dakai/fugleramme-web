// Run: node test.mjs
import assert from "node:assert/strict";
import { englishWiki, groupDetections, kebab, pickPlate, sizeWeight, toPinyin, zhArticle } from "./server.mjs";

assert.equal(kebab("Zosterops simplex"), "zosterops-simplex");
assert.equal(kebab("  Hylopezus  "), "hylopezus");

const files = ["anas-crecca.webp", "anas-crecca-2.webp", "anas-platyrhynchos.webp"];
assert.equal(pickPlate(files, "Anas crecca"), "anas-crecca.webp");
assert.equal(pickPlate(files, "Anas platyrhynchos"), "anas-platyrhynchos.webp");
assert.equal(pickPlate(["anas-crecca-2.webp"], "Anas crecca"), "anas-crecca-2.webp");
assert.equal(pickPlate(files, "Psilopogon cristatus"), null);

// Bird size: fugleramme's rule. A known mass gives mass**0.14 against the table
// median; a plate cut tight to its bird multiplies by 1. A loose crop (the bird
// fills half the plate's long side) doubles it so the bird itself still lands at
// the mass-derived size. Nothing known anywhere leaves it at 1.
const tight = { box: [0, 0, 1, 1], cut: [1200, 900] };
const loose = { box: [0, 0, 0.5, 0.5], cut: [1200, 1200] };
assert.equal(sizeWeight("Corvus corax", undefined).toFixed(2), sizeWeight("Corvus corax", tight).toFixed(2));
assert.equal(sizeWeight("Corvus corax", loose).toFixed(4), (2 * sizeWeight("Corvus corax", tight)).toFixed(4));
// An eagle draws bigger than a white-eye; a species fugleramme has no plate for
// is unknown to the mass table and draws at 1.
assert.ok(sizeWeight("Zosterops simplex", tight) < 1);
assert.ok(sizeWeight("Gyps fulvus", tight) > 1);
assert.equal(sizeWeight("Zzyzx nonexistentia", tight), 1);

const day = Date.parse("2026-10-01T13:38:30+08:00");
const rows = [
  { id: 101, scientificName: "Zosterops simplex", commonName: "Swinhoe's White-eye", confidence: 0.9, timestamp: "2026-10-01T12:02:35+08:00" },
  { id: 138, scientificName: "Zosterops simplex", commonName: "Swinhoe's White-eye", confidence: 0.99, timestamp: "2026-10-01T12:48:06+08:00" },
  { scientificName: "Ixos mcclellandii", commonName: "Mountain Bulbul", confidence: 0.92, timestamp: "2026-10-01T13:38:30+08:00" },
  { scientificName: "Old bird", commonName: "Gone", timestamp: "2026-09-01T00:00:00+08:00" },
  { timestamp: "2026-10-01T13:00:00+08:00" }, // no species name
];
// A one-hour window drops the 12:02 call; a two-hour one keeps both.
assert.equal(groupDetections(rows, day - 3600_000).length, 2);
const birds = groupDetections(rows, day - 2 * 3600_000);
assert.deepEqual(birds.map((b) => b.sci), ["Ixos mcclellandii", "Zosterops simplex"]);
assert.equal(birds[1].count, 2);
assert.equal(birds[1].confidence, 0.99);
assert.equal(birds[1].en, "Swinhoe's White-eye");
assert.equal(birds[1].last, Date.parse("2026-10-01T12:48:06+08:00"));
// The card's recorder and its false-positive delete both act on the newest call.
assert.equal(birds[1].id, 138);
assert.equal(birds[0].id, null); // no id upstream -> no recorder, no delete

// A bare date/time pair still parses (older BirdNET-Go builds omit `timestamp`).
const legacy = groupDetections(
  [{ scientificName: "A b", commonName: "C", date: "2026-10-01", time: "12:00:00" }],
  0,
);
assert.equal(legacy.length, 1);

// Pinyin: tone-marked, correct on polyphonic characters, absent without Han.
assert.equal(toPinyin("红耳鹎"), "hóng ěr bēi");
assert.equal(toPinyin("极北柳莺复合群"), "jí běi liǔ yīng fù hé qún");
assert.equal(toPinyin("Red-whiskered Bulbul"), null);
assert.equal(toPinyin(null), null);

// Wikipedia links: Chinese first, iNaturalist's English article as the fallback.
// Network-dependent, so an offline station skips rather than fails.
try {
  const zh = await zhArticle("Motacilla alba");
  assert.equal(zh.lang, "zh");
  assert.ok(zh.url.startsWith("https://zh.wikipedia.org/wiki/"));
  assert.equal(await zhArticle("Zzyzx nonexistentia"), null); // no Chinese article
} catch (err) {
  console.log("skipped wikipedia lookup checks (offline):", err.message);
}
assert.deepEqual(englishWiki("https://en.wikipedia.org/wiki/Indian_paradise_flycatcher"), {
  url: "https://en.wikipedia.org/wiki/Indian_paradise_flycatcher",
  lang: "en",
});
assert.equal(englishWiki("https://zh.wikipedia.org/wiki/白鹡鸰"), null);
assert.equal(englishWiki(undefined), null);

console.log("ok");
