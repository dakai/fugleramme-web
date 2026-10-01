// fugleramme-web - bird frame for a self-hosted BirdNET-Go station.
//
// Everything the frame needs is cached on disk under DATA, so once a species has
// been seen the frame works with the internet unplugged: plates come from
// fugleramme's public-domain artwork, names/photos from iNaturalist.
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { pinyin } from "pinyin-pro";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA = process.env.DATA_DIR || path.join(ROOT, "data");

const BIRDNA = (process.env.BIRDNA_URL || "http://192.168.10.207:8080").replace(/\/+$/, "");
const INAT = "https://api.inaturalist.org/v1";
const FUGLERAMME_RAW =
  "https://raw.githubusercontent.com/arnegiacomo/fugleramme/main/assets";
const PORT = Number(process.env.PORT || 8090);
const FETCH_MS = Number(process.env.FETCH_TIMEOUT_MS || 20000);
/** How long a built frame is reused; the page polls more often than this. */
const FRAME_TTL_MS = 20000;

const DIRS = {
  art: path.join(DATA, "art"),
  photo: path.join(DATA, "photo"),
  taxon: path.join(DATA, "taxon"),
  json: path.join(DATA, "json"),
};

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};
export const kebab = (s) =>
  s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");


async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function getJSON(url, { timeout = FETCH_MS, ...init } = {}) {
  const res = await fetch(url, {
    ...init,
    headers: { "user-agent": "fugleramme-web/1.0", ...(init.headers || {}) },
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

/** Read-through disk cache. `produce` runs only on a miss and its result is kept. */
async function cached(file, produce) {
  if (await exists(file)) return JSON.parse(await readFile(file, "utf8"));
  const value = await produce();
  await writeFile(file, JSON.stringify(value));
  return value;
}

async function downloadTo(url, file) {
  if (await exists(file)) return true;
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_MS) });
  if (!res.ok) return false;
  await writeFile(file, Buffer.from(await res.arrayBuffer()));
  return true;
}

/* ----------------------------------------------------------------- plates */

const photoFile = (sci) => path.join(DIRS.photo, `${kebab(sci)}.jpg`);

/** fugleramme filenames are the kebab-cased scientific name, plus plate variants. */
export function pickPlate(files, sci) {
  const base = kebab(sci);
  const variant = new RegExp(`^${base}(-\\d+)?\\.webp$`);
  const matches = files.filter((f) => variant.test(f));
  if (matches.length === 0) return null;
  // Prefer the un-suffixed plate, then the lowest variant number.
  return matches.sort((a, b) => a.length - b.length || a.localeCompare(b))[0];
}

async function plateFor(sci, manifest, aliases) {
  // Artwork is filed under the current genus; a station upgraded across a
  // reclassification still reports the old one.
  const canonical = aliases[sci] || sci;
  const file = pickPlate(manifest.files, canonical) || pickPlate(manifest.files, sci);
  if (!file) return null;
  const url = `${FUGLERAMME_RAW}/artwork/classic/birds/${file}`;
  const ok = await downloadTo(url, path.join(DIRS.art, file));
  return ok ? { plate: file, plateSource: manifest.meta[`birds/${file}`]?.url || null } : null;
}

/* ----------------------------------------------------------------- taxon */

const CC = /^cc0|^cc-by|^cc-by-sa/i;
/** iNaturalist carries both scripts; zh-CN is the Simplified one (zh is Traditional). */
const LOCALE = "zh-CN";

/** Chinese Wikipedia article for a scientific name, or null when none exists. */
export async function zhArticle(sci) {
  const title = await getJSON(
    `https://zh.wikipedia.org/w/api.php?action=opensearch&format=json&limit=1&namespace=0&origin=*&search=${encodeURIComponent(sci)}`,
  )
    .then(([_, titles]) => titles?.[0])
    .catch(() => null);
  return title ? { url: `https://zh.wikipedia.org/wiki/${encodeURIComponent(title)}`, lang: "zh" } : null;
}

const EN_WIKI = /^https:\/\/en\.wikipedia\.org\/wiki\//;

/** iNaturalist's own article link, which is the English fallback and knows the
 *  article title even when it is not the scientific name (Alecturus concretus). */
export const englishWiki = (url) =>
  typeof url === "string" && EN_WIKI.test(url) ? { url, lang: "en" } : null;

/** Tone-marked pinyin for a Chinese name, or null when there is no Chinese to romanize. */
export const toPinyin = (zh) =>
  zh && /\p{Script=Han}/u.test(zh) ? pinyin(zh, { toneType: "symbol", nonZh: "removed" }).trim() : null;

/** iNaturalist: Chinese common name, a freely licensed photo, and a place to read more. */
async function resolveTaxon(sci) {
  // The locale is part of the cache key: switching script must not read stale names.
  const file = path.join(DIRS.taxon, `${kebab(sci)}-${LOCALE}.json`);
  return cached(file, async () => {
    const taxon =
      (await getJSON(`${INAT}/taxa/autocomplete?q=${encodeURIComponent(sci)}&per_page=5`)
        .then((r) => r.results || [])
        .catch(() => [])
        .then((r) => r.find((t) => t.name?.toLowerCase() === sci.toLowerCase()) || r[0])) ||
      (await getJSON(`${INAT}/taxa?per_page=5&locale=${LOCALE}&q=${encodeURIComponent(sci)}`)
        .then((r) => r.results || [])
        .catch(() => []))
        .then((r) => r.find((t) => t.name?.toLowerCase() === sci.toLowerCase()) || r[0]);

    const [detail, zhWiki] = await Promise.all([
      taxon && getJSON(`${INAT}/taxa/${taxon.id}?locale=${LOCALE}`).then((r) => r.results?.[0]).catch(() => null),
      zhArticle(sci),
    ]);
    if (!taxon && !detail) return { zh: null, pinyin: null, photo: null, credit: null, wiki: null, inat: null };

    const zh = detail?.preferred_common_name || taxon?.preferred_common_name || null;

    const photos = (detail?.taxon_photos || []).map((p) => p.photo).filter(Boolean);
    const photo = photos.find((p) => CC.test(p.license_code || "")) || photos[0] || detail?.default_photo || null;
    const id = detail?.id ?? taxon?.id;
    return {
      id: id ?? null,
      zh,
      pinyin: toPinyin(zh),
      photo: photo ? photo.large_url || photo.medium_url : null,
      credit: photo
        ? [photo.attribution_name, photo.license_code?.toUpperCase()].filter(Boolean).join(" · ")
        : null,
      wiki: zhWiki || englishWiki(detail?.wikipedia_url),
      inat: id ? `https://www.inaturalist.org/taxa/${id}?locale=${LOCALE}` : null,
    };
  });
}

/* -------------------------------------------------------------- detection */

export function groupDetections(rows, sinceMs) {
  const birds = new Map();
  for (const d of rows) {
    const at = Date.parse(d.timestamp || `${d.date}T${d.time}`);
    if (!Number.isFinite(at) || at < sinceMs) continue;
    const sci = d.scientificName;
    if (!sci) continue;
    const bird = birds.get(sci) || {
      sci,
      en: d.commonName || sci,
      count: 0,
      confidence: 0,
      first: at,
      last: at,
    };
    bird.count += 1;
    bird.confidence = Math.max(bird.confidence, d.confidence || 0);
    bird.first = Math.min(bird.first, at);
    bird.last = Math.max(bird.last, at);
    birds.set(sci, bird);
  }
  return [...birds.values()].sort((a, b) => b.last - a.last || b.count - a.count);
}

async function enrich(birds) {
  const manifest = await cached(path.join(DIRS.json, "manifest.json"), () =>
    getJSON(`${FUGLERAMME_RAW}/artwork/classic/manifest.json`).then((meta) => ({
      files: Object.keys(meta).filter((k) => k.startsWith("birds/")).map((k) => k.slice(6)),
      meta,
    })),
  );
  const aliases = await cached(path.join(DIRS.json, "aliases.json"), () =>
    getJSON(`${FUGLERAMME_RAW}/birdnet_aliases.json`).catch(() => ({})),
  );

  return Promise.all(
    birds.map(async (bird) => {
      const [plate, taxon] = await Promise.all([
        plateFor(bird.sci, manifest, aliases).catch(() => null),
        resolveTaxon(bird.sci).catch(() => ({ zh: null, pinyin: null, photo: null, credit: null })),
      ]);
      let photoPath = null;
      if (taxon.photo) {
        const saved = await downloadTo(taxon.photo, photoFile(bird.sci)).catch(() => false);
        if (saved) photoPath = `/img/photo/${kebab(bird.sci)}.jpg`;
      }
      return {
        ...bird,
        zh: taxon.zh,
        pinyin: taxon.pinyin,
        credit: taxon.credit,
        photo: photoPath,
        wiki: taxon.wiki,
        inat: taxon.inat,
      };
    }),
  );
}

/* ------------------------------------------------------------------ frame */

let frameCache = { at: 0, body: null };

export async function buildFrame(hours) {
  if (frameCache.body && Date.now() - frameCache.at < FRAME_TTL_MS) return frameCache.body;
  const res = await getJSON(`${BIRDNA}/api/v2/detections?limit=500`);
  const rows = Array.isArray(res) ? res : res.data || [];
  const since = Date.now() - hours * 3600_000;
  const birds = await enrich(groupDetections(rows, since));
  const info = await getJSON(`${BIRDNA}/api/v2/system/info`).catch(() => ({}));
  const body = {
    station: info.hostname || BIRDNA,
    detector: BIRDNA,
    windowHours: hours,
    generatedAt: new Date().toISOString(),
    detections: rows.length,
    birds,
  };
  frameCache = { at: Date.now(), body };
  return body;
}

/* ------------------------------------------------------------------ serve */

const STATIC_FALLBACK = "index.html";

async function serveFile(res, file, { download = false } = {}) {
  const body = await readFile(file);
  res.writeHead(200, {
    "content-type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
    "content-length": body.length,
    "cache-control": download ? "public, max-age=604800, immutable" : "no-cache",
  });
  res.end(body);
}

function notFound(res, msg = "not found") {
  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end(msg);
}

async function handle(req, res) {
  const url = new URL(req.url, "http://x");
  const p = decodeURIComponent(url.pathname);

  if (p === "/api/frame") {
    const hours = Math.min(Math.max(Number(url.searchParams.get("hours")) || 24, 1), 168);
    try {
      const body = await buildFrame(hours);
      res.writeHead(200, { "content-type": MIME[".json"], "cache-control": "no-store" });
      res.end(JSON.stringify(body));
    } catch (err) {
      // A detector blip must never blank the glass: hold the last good frame.
      if (frameCache.body) {
        res.writeHead(200, { "content-type": MIME[".json"], "x-stale": "1" });
        res.end(JSON.stringify({ ...frameCache.body, stale: true }));
      } else {
        res.writeHead(503, { "content-type": MIME[".json"] });
        res.end(JSON.stringify({ error: String(err), detector: BIRDNA }));
      }
    }
    return;
  }

  const img = /^\/img\/(art|photo)\/(.+\.(?:webp|jpg|jpeg|png))$/.exec(p);
  if (img) {
    const file = path.join(DIRS[img[1]], path.basename(img[2]));
    (await exists(file)) ? serveFile(res, file, { download: true }) : notFound(res);
    return;
  }

  const rel = p === "/" ? STATIC_FALLBACK : p.replace(/^\/+/, "");
  const file = path.join(PUBLIC_DIR, path.normalize(rel));
  (file.startsWith(PUBLIC_DIR) && (await exists(file)))
    ? serveFile(res, file)
    : notFound(res);
}

/* ------------------------------------------------------------------- main */

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end(String(err));
  });
});

export { server };

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await Promise.all(Object.values(DIRS).map((d) => mkdir(d, { recursive: true })));
  server.listen(PORT, () => {
    console.log(`fugleramme-web on http://0.0.0.0:${PORT}  detector=${BIRDNA}  data=${DATA}`);
  });
}
