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
  ".wav": "audio/wav",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".woff2": "font/woff2",
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

/* -------------------------------------------------------------- bird size */

/** AVONET body mass in grams (Tobias et al. 2022, CC BY 4.0), trimmed to the
 *  taxa fugleramme draws. Vendored rather than fetched: it is 15 kB and the
 *  frame must still size birds with the internet unplugged. */
const MASSES = await readFile(path.join(ROOT, "assets", "bird-masses.json"), "utf8")
  .then(JSON.parse)
  .catch(() => ({}));
const MASS_MEDIAN =
  Object.values(MASSES).sort((a, b) => a - b)[Object.keys(MASSES).length >> 1] || 1;
/** Display size is mass ** 0.14: <1 compresses, so the heaviest bird reads bigger
 *  without the smallest vanishing. Heaviest lands near 2.5x the lightest. */
export const SIZE_EXPONENT = 0.14;

/** The bird's own size: mass against the table median, with nothing of the plate
 *  it happens to be cut from. This is what the frame is ordered by, so a heron
 *  leads the sheet and a warbler ends it. */
export const massWeight = (sci) => {
  const mass = MASSES[kebab(sci)];
  return mass && Number.isFinite(mass) ? (mass / MASS_MEDIAN) ** SIZE_EXPONENT : 1;
};

/** How big to draw a species, fugleramme's own rule: real body mass, times the
 *  plate's own slack so a loosely-cut scan still draws its bird at that size.
 *  The weight is the height to draw the plate at, so the slack is `height` over
 *  the bird's longest side — the bird then lands on its mass-derived size whatever
 *  the plate's aspect or crop. The longest side instead inflated every landscape
 *  plate by its aspect ratio, which put a woodpecker above a heron.
 *  Unknown geometry draws at the mass term; unknown mass draws an average bird. */
export function sizeWeight(sci, entry) {
  const [x0, y0, x1, y1] = entry?.box || [];
  const [width, height] = entry?.cut || [];
  const span = width > 0 && height > 0 ? Math.max((x1 - x0) * width, (y1 - y0) * height) : 0;
  return massWeight(sci) * (span > 0 ? height / span : 1);
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
      id: d.id ?? null,
    };
    bird.count += 1;
    bird.confidence = Math.max(bird.confidence, d.confidence || 0);
    bird.first = Math.min(bird.first, at);
    // The card's recorder and its false-positive delete both act on the newest call.
    if (at >= bird.last) {
      bird.last = at;
      bird.id = d.id ?? bird.id;
    }
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
  const geometry = await cached(path.join(DIRS.json, "geometry.json"), () =>
    getJSON(`${FUGLERAMME_RAW}/artwork/classic/geometry.json`).catch(() => ({})),
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
        plateUrl: plate ? `/img/art/${plate.plate}` : null,
        // How big to draw the plate in the collage (body mass, plate slack folded
        // in) and how big the bird itself is, which is what the frame is sorted by.
        size: plate ? sizeWeight(aliases[bird.sci] || bird.sci, geometry[`birds/${plate.plate}`]) : 1,
        birdSize: massWeight(bird.sci),
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

let frameCache = { at: 0, hours: 0, body: null };

export async function buildFrame(hours) {
  // Keyed by the window: a cached 1 h frame must not answer a 168 h request, or
  // changing the time window shows the old window's birds for up to FRAME_TTL_MS.
  if (frameCache.body && frameCache.hours === hours && Date.now() - frameCache.at < FRAME_TTL_MS) {
    return frameCache.body;
  }
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
  frameCache = { at: Date.now(), hours, body };
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

/* ------------------------------------------------------ recorder / triage */

/** BirdNET-Go guards every write with a CSRF cookie it hands out on any GET.
 *  Echoing that cookie back in the `x-csrf-token` header clears the check. */
async function birdnetWrite(method, pathname) {
  const seed = await fetch(`${BIRDNA}/api/v2/ping`, { signal: AbortSignal.timeout(FETCH_MS) });
  const cookie = (seed.headers.getSetCookie() || [])
    .map((c) => c.split(";")[0])
    .find((c) => c.startsWith("csrf="));
  if (!cookie) throw new Error("detector issued no csrf cookie");
  return fetch(`${BIRDNA}${pathname}`, {
    method,
    headers: { cookie, "x-csrf-token": cookie.slice(5) },
    signal: AbortSignal.timeout(FETCH_MS),
  });
}

/** Proxy one detection's wav. 503 means the clip is still being written; 404,
 *  that it is gone (never produced, or purged by retention). Pass both through
 *  so the page can tell "wait" from "never". */
async function serveAudio(res, id) {
  const up = await fetch(`${BIRDNA}/api/v2/audio/${id}`, { signal: AbortSignal.timeout(FETCH_MS) });
  if (!up.ok) {
    res.writeHead(up.status, { "content-type": MIME[".json"], "cache-control": "no-store" });
    res.end(JSON.stringify({ status: up.status }));
    return;
  }
  const body = Buffer.from(await up.arrayBuffer());
  res.writeHead(200, {
    "content-type": MIME[".wav"],
    "content-length": body.length,
    "cache-control": "private, max-age=3600",
  });
  res.end(body);
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

  // The recorder for a card: /api/audio/<detectionId>
  const clip = /^\/api\/audio\/(\d+)$/.exec(p);
  if (clip) {
    if (req.method !== "GET") {
      notFound(res, "method not allowed");
      return;
    }
    try {
      await serveAudio(res, clip[1]);
    } catch (err) {
      res.writeHead(504, { "content-type": MIME[".json"] });
      res.end(JSON.stringify({ error: String(err) }));
    }
    return;
  }

  // False-positive triage: DELETE /api/detection/<id> drops the record upstream.
  const drop = /^\/api\/detection\/(\d+)$/.exec(p);
  if (drop) {
    if (req.method !== "DELETE") {
      notFound(res, "method not allowed");
      return;
    }
    try {
      const up = await birdnetWrite("DELETE", `/api/v2/detections/${drop[1]}`);
      // Whatever went upstream, the frame must not keep showing the deleted bird.
      frameCache = { at: 0, body: null };
      res.writeHead(up.ok ? 200 : up.status, { "content-type": MIME[".json"] });
      res.end(JSON.stringify({ ok: up.ok, status: up.status }));
    } catch (err) {
      res.writeHead(502, { "content-type": MIME[".json"] });
      res.end(JSON.stringify({ error: String(err) }));
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
