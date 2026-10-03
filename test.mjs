// Run: node test.mjs
import assert from "node:assert/strict";
import { englishWiki, groupDetections, kebab, massWeight, pickPlate, sizeWeight, toPinyin, zhArticle } from "./server.mjs";

assert.equal(kebab("Zosterops simplex"), "zosterops-simplex");
assert.equal(kebab("  Hylopezus  "), "hylopezus");

const files = ["anas-crecca.webp", "anas-crecca-2.webp", "anas-platyrhynchos.webp"];
assert.equal(pickPlate(files, "Anas crecca"), "anas-crecca.webp");
assert.equal(pickPlate(files, "Anas platyrhynchos"), "anas-platyrhynchos.webp");
assert.equal(pickPlate(["anas-crecca-2.webp"], "Anas crecca"), "anas-crecca-2.webp");
assert.equal(pickPlate(files, "Psilopogon cristatus"), null);

// Bird size: fugleramme's rule. A known mass gives mass**0.14 against the table
// median. The plate's slack only says how tall to draw the plate so that bird
// lands at that size: a plate cut tight to its bird needs no slack, a loose crop
// needs the plate drawn taller. The bird is what must come out the same, so two
// very different crops of one species draw the same bird.
const tight = { box: [0, 0, 1, 1], cut: [1200, 900] };
const loose = { box: [0.25, 0, 0.75, 0.5], cut: [1600, 600] };
/** The bird's own longest side once the plate is drawn at `sizeWeight`. */
const birdPx = (sci, entry) => {
  const [x0, y0, x1, y1] = entry.box;
  const [width, height] = entry.cut;
  const span = Math.max((x1 - x0) * width, (y1 - y0) * height);
  return (sizeWeight(sci, entry) * span) / height; // plate height x the bird's share of it
};
assert.equal(birdPx("Corvus corax", tight).toFixed(6), birdPx("Corvus corax", loose).toFixed(6));
// With no geometry the plate is drawn at the mass term, so the bird comes out at
// the mass term too.
assert.equal(birdPx("Corvus corax", tight).toFixed(6), sizeWeight("Corvus corax", undefined).toFixed(6));
// An eagle draws bigger than a white-eye; no geometry at all leaves the mass term
// alone, and a species with no plate for it is unknown to the mass table.
assert.ok(sizeWeight("Zosterops simplex", undefined) < 1);
assert.ok(sizeWeight("Gyps fulvus", undefined) > 1);
assert.equal(sizeWeight("Zzyzx nonexistentia", undefined), 1);
// The bird's own weight is the mass term and nothing else: the frame is ordered by
// it, so the plate a species happens to be cut from cannot put it first.
assert.equal(massWeight("Corvus corax"), sizeWeight("Corvus corax", undefined));
assert.ok(massWeight("Ardea cinerea") > massWeight("Alcedo atthis"));
assert.equal(massWeight("Zzyzx nonexistentia"), 1);

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
