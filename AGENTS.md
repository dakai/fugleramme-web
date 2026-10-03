# Repository Guidelines

## Project Overview

fugleramme-web is a kiosk picture frame for a self-hosted [BirdNET-Go](https://github.com/tphakala/birdnet-go)
station. It reads recent acoustic detections, groups them per species, and renders one
page of cards — 1800s fugleramme plates or real iNaturalist photos, named in Chinese
(plus tone-marked pinyin) and English. Everything is cached to disk under `DATA_DIR`,
so once a species has been seen the frame works with the internet unplugged.

Two source files carry the whole app: `server.mjs` (backend) and `public/index.html`
(frontend). No framework, no build step.

## Architecture & Data Flow

```
GET /api/frame?hours=N
  └─ handle()            server.mjs:278   clamp hours to 1…168
      └─ buildFrame()    server.mjs:240   20 s in-memory frameCache
          ├─ GET {BIRDNA}/api/v2/detections?limit=500
          ├─ groupDetections(rows, since)  server.mjs:177   dedupe per scientificName
          ├─ enrich(birds)                 server.mjs:201   Promise.all fan-out
          │    ├─ cached() manifest + birdnet_aliases.json  (fugleramme raw GitHub)
          │    ├─ plateFor()  → downloads into DIRS.art     (/img/art/…)
          │    └─ resolveTaxon() → iNaturalist locale=zh-CN + zh/en Wikipedia
          │         all three via read-through disk cache `cached()` (server.mjs:68)
          └─ GET {BIRDNA}/api/v2/system/info  → `station` (failure tolerated, `{}`)
```

Static serving (`handle()` tail): `/` → `public/index.html` (`STATIC_FALLBACK`,
server.mjs:261), `/img/<art|photo>/<file>` → `DIRS[kind]` with `path.basename()`
re-applied, everything else resolves inside `PUBLIC_DIR` with a
`file.startsWith(PUBLIC_DIR)` traversal guard (server.mjs:310).

`handle()` also owns the two per-card actions:

- `GET /api/audio/<detectionId>` — proxies `{BIRDNA}/api/v2/audio/:id`. Upstream `503`
  means the clip is still being written, `404` means it is gone; both pass through
  unchanged so the page can tell "wait" from "never".
- `DELETE /api/detection/<detectionId>` — drops the record upstream via
  `birdnetWrite()`, then nulls `frameCache` so the deleted bird cannot reappear from
  the 20 s cache.

Frontend: one inline `<script type="module">` in `public/index.html`, no imports, no CDN.
`load()` polls `/api/frame` every 30 s, rebuilds the grid with `grid.replaceChildren(...)`,
and keeps `mode`/`hours` in `localStorage` keys `fugleramme.mode` / `fugleramme.hours`.
Outbound links pass through `safeUrl()` — only `https:` URLs on `wikipedia.org` /
`inaturalist.org` reach `href`. One shared `Audio` object backs every card's recorder;
`showPlay(btn, el)` is the single place that writes its label and its `--p` progress
custom property, so the 30 s re-render calls it once for the card still playing.

`mode === "plate"` renders the **collage**, not the card grid: `PER_FRAME = 12` birds per
frame, no buttons, no links, no pinyin, and species with no plate left out entirely.
`frame` is the current page, `cell(bird, weight)` draws one cut-out plus handwritten
English/中文名, `collageFrame()` sorts by `size` and scales each bird against the frame's
**biggest** bird, so `--h` 1 is always the tallest plate on the sheet.

**The screen sheet is the paper sheet.** `.collage` is an A4 landscape box — `container-type:
size`, `aspect-ratio: 297/210`, `--sheet` background — and every size inside it is in `cqh`
(1% of the sheet's height), including the captions. The print block only changes the box to
`297mm × 210mm` and drops everything but `.collage`, so `window.print()` writes exactly the
page on screen: one A4 landscape file per frame. `@page { margin: 0 }` is required — any
margin shrinks the sheet below its box and the content spills to a second page. The plate
unit is `26cqh`; four rows of that plus captions is what bounds 12 birds to one page.
Cells are `width: max-content` on purpose: with a width cap the browser shrinks the plate
to fit and the picture distorts or crops.

`⤓ A4 PDF` calls `window.print()`. That and the `@media print` block are the whole export
feature — no PDF library, nothing to install.

**Bird size is fugleramme's rule, ported.** `sizeWeight(sci, entry)` = AVONET body mass
(`assets/bird-masses.json`, vendored, CC BY 4.0 — Tobias et al. 2022) ** 0.14 against the
table median, times the plate's `span_ratio` from the cached `geometry.json`. Both halves
return 1 when unknown. `enrich()` publishes it as `bird.size`. Do not replace it with plate
pixel area: the mass term is what makes a bittern read bigger than a wagtail.

**`onPaper(url, img)` is fugleramme's `paper.process_sprite`, ported to a canvas.** Every
plate carries a ring of its own scan paper around the bird ("halo"), and the plates' paper
runs from (240,236,230) to (232,217,196) — so a sheet drawn at one tone shows every plate
as a pasted rectangle. It runs once per plate (cached in `flattened`, reused by every
30 s poll) and does four things:

1. **measure the plate's own tone** — the median colour of the paper just inside its cut
   edge. There is no fixed answer to measure against, which is why `PAPER` alone is not
   enough;
2. **flood that paper** — grow in from a one-pixel frame around the plate through
   near-paper pixels (`FLOOD` levels from the measured tone, bright, unsaturated). What it
   reaches *is* the halo, and it is painted `PAPER` flat. Seeding from the plate's outside
   rather than from the cut matters: a cut whose alpha ramps over more than a few pixels
   has no pixel "next to transparent" to start from, which is how half the plates kept
   their scan paper. The same code covers a plate that was never cut out at all;
3. **shift what the ink walls off** (paper between a bird's legs, under a tail) by the
   difference between the two tones, `NEAR` levels either side (`paper_px` in the
   original). Never flatten it: that is where a pale bird's white plumage lives, and
   "anything pale is paper" is the bug that repainted white bellies, pale water and sky
   and ate the illustration;
4. **give the transparent pixels `PAPER`** so the soft edge of the cut-out reveals paper
   rather than whatever sat under the alpha.

`PAPER` is fugleramme's `TARGET_PAPER` (242, 237, 226) and must stay equal to `.collage`'s
`--sheet`, or the rectangles come back. Measured on this repo's plates it leaves a mean
~6% of bright low-saturation pixels more than 12 levels off the page tone, against ~22%
for fugleramme's own `process_sprite` on the same assets — and ink pixels move by 0–1
levels. **No `mix-blend-mode`:** the halo is already the sheet's tone, so there is nothing
to blend, and the screen then shows exactly what prints. Print needs
`print-color-adjust: exact` or the sheet prints white under the cream.

The passes are per pixel, so the canvas is scaled to `WORK` (900 px) first — a plate is
drawn at most 26cqh of a 210 mm sheet, so ~1200 px of scan is 2× more than the print
resolves. All twelve plates cost ~1.7 s of main thread, once, on first load.

**What stays is scenery, and that is correct.** A plate's painted ground, rocks, reeds and
perch are inside the cut and are part of the drawing — the flood reaches only what is
connected to the outside through near-paper pixels, so an enclosed ground stays. Do not
"finish the job" by widening the flood until those go: past ~45 levels it crosses from a
plate's paper onto a white bird's head and repaints it.

**Non-obvious invariants (do not "simplify" these away):**

- **A detector blip must never blank the glass.** On upstream failure the last good
  frame is re-served with `"stale": true` (server.mjs:288-296); 503 only when no frame
  was ever built. The page renders a banner.
- **Plate files are kebab-cased scientific names with an optional `-<n>` variant**;
  the un-suffixed plate wins (`pickPlate`, server.mjs:95). Artwork is filed under the
  *current* genus, so a station upgraded across a reclassification is matched through
  fugleramme's `birdnet_aliases.json`, with a retry on the raw `sci` (server.mjs:97-101).
- **Locale is `zh-CN`, deliberately.** iNaturalist's plain `zh` locale is Traditional;
  `zh-CN` is the Simplified one (server.mjs:111). BirdNET-Go ships no Chinese dictionary.
- BirdNET-Go rows may carry `timestamp` or a legacy `date` + `time` pair; both parse
  (server.mjs:181, pinned by `test.mjs:32-36`).
- **BirdNET-Go's writes need a CSRF echo.** Any mutation (the delete above) answers 403
  `Invalid CSRF token` unless the client sends back the `csrf` cookie it was handed on
  any GET, echoed in the `x-csrf-token` header — that is what `birdnetWrite()` does. It
  also assumes the station runs with auth disabled (`/api/v2/auth/status` →
  `{"authenticated":true,"auth_method":"None"}`); a station with BasicAuth on answers 401
  and the card reports the failure in the banner.
- **`groupDetections` keeps the newest detection's `id`** on the group, because the
  recorder and the delete both address one record, not a species. A row without an `id`
  leaves `bird.id === null`, and the card then renders neither button enabled.
- **The collage is only built in plate mode**, and the empty state is decided by the view
  on screen (`plate ? drawn.length : birds.length`). Both were computed from the plate list
  regardless of mode, so photo mode — the default — minted a hidden sheet for every bird,
  each `img` without a plate asking for `/null`, on every 30 s poll.

## Key Directories

| path | purpose |
| --- | --- |
| `server.mjs` | entire backend: config, disk cache, plate/taxon/detection logic, router |
| `public/` | entire frontend: `index.html` plus the vendored `fonts/mashanzheng.woff2` |
| `data/` | generated cache (`art/`, `photo/`, `json/`) — gitignored, `DATA_DIR` override |
| `.github/workflows/` | one workflow: build + push the multi-arch image |
| `assets/` | vendored `bird-masses.json` (AVONET grams) — read once at startup |

## Development Commands

```bash
npm install                                    # pinyin-pro, the only dependency
npm test                                       # node test.mjs — pure helpers, prints "ok"
BIRDNA_URL=http://192.168.10.207:8080 npm start   # → http://0.0.0.0:8090
```

There is no `build`, `lint`, `format`, or `dev` script — do not invent one. Verify by
running the server and loading the page.

| env var | default | effect |
| --- | --- | --- |
| `BIRDNA_URL` | `http://192.168.10.207:8080` | detector base URL (trailing `/` stripped) |
| `PORT` | `8090` | listen port |
| `DATA_DIR` | `./data` (`/data` in the image) | plate/photo/taxon cache root |
| `FETCH_TIMEOUT_MS` | `20000` | `AbortSignal.timeout` for every outbound fetch |

## Code Conventions & Common Patterns

Observed style — match it, there is no formatter config to arbitrate:

- ESM only (`.mjs`, `"type": "module"`), 2-space indent, double quotes, semicolons,
  trailing commas in multi-line literals, numeric separators (`3600_000`).
- Section banners `/* ---- plates */` (server.mjs:83, 108, 175, 236, 259, 315) and a
  one-line JSDoc on anything non-obvious (`/** Read-through disk cache. ... */`).
- One-function-per-concern, arrow consts for tiny pure helpers
  (`export const kebab = (s) => ...`, `englishWiki`, `toPinyin`).
- Concurrency is `Promise.all` over species; upstream timeouts go through `getJSON()`
  (AbortSignal + user-agent) — never call `fetch` directly.
- Error handling is either `try/catch` or an inline `.catch(() => fallback)`. Failures
  degrade (missing photo, missing plate, `{}` station info), they do not throw.
- Pure helpers are `export`ed purely so `test.mjs` can assert them. Exporting a helper
  has no runtime cost and is the convention, not an exception.
- The HTTP listener only runs under the entrypoint guard
  `if (process.argv[1] === fileURLToPath(import.meta.url))` (server.mjs:326). Keep it —
  it is what makes `import "./server.mjs"` side-effect free.

## Important Files

| file | role |
| --- | --- |
| `server.mjs` | entry point + whole backend; sectioned plates / taxon / detection / frame / serve |
| `public/index.html` | whole frontend (inline CSS tokens + module script) |
| `test.mjs` | the entire test suite (61 lines) |
| `package.json` | scripts, `engines.node >= 20`, the single dep |
| `Dockerfile` | `node:22-alpine`, `npm ci --omit=dev`, `EXPOSE 8090`, `/data` volume, wget healthcheck; copies **only** `server.mjs` + `assets/` + `public/` |
| `compose.yaml` | TrueNAS deploy: `ghcr.io/dakai/fugleramme-web:latest`, `8090:8090`, `./data:/data` |
| `.github/workflows/image.yml` | on push to `main`: buildx linux/amd64 + linux/arm64 → ghcr. **No test step.** |

## Runtime / Tooling Preferences

- **Node ≥ 20** (`engines`), **Node 22 Alpine** in the image. Top-level `await` is used
  — do not transpile or target an older baseline.
- **npm** with `lockfileVersion: 3`; `npm ci` in Docker. Do not add a second lockfile.
- **Exactly one runtime dependency: `pinyin-pro`** (MIT), used only by `toPinyin`.
  Anything else must be stdlib or it does not get added — `fetch`, `AbortSignal.timeout`,
  `node:http`, `node:fs/promises` cover everything here. No devDependencies, so
  `--omit=dev` is currently a no-op.
- No linter, formatter, typechecker, or pre-commit hook. `.editorconfig`, `.nvmrc`,
  `.npmrc` do not exist.
- Docker layer order matters: manifests are copied before `npm ci` so installs cache.
  If you add a runtime file to the image, add a `COPY` for it — `test.mjs` is
  deliberately not shipped.

## Testing & QA

`npm test` → `node test.mjs`. No framework: a flat script of top-level
`node:assert/strict` statements that imports pure helpers from `./server.mjs` and prints
`ok`. 24 assertions in 8 groups, all currently passing:

| covered | helper |
| --- | --- |
| name slugging, whitespace trim | `kebab` |
| exact plate match, `-2` fallback, unknown → `null` | `pickPlate` |
| windowing, grouping per species, count, max confidence, sort, legacy `date`/`time`, newest-call `id` | `groupDetections` |
| tone marks, polyphonic chars, non-Han → `null` | `toPinyin` |
| zh Wikipedia hit / miss (network, skipped offline via try/catch) | `zhArticle` |
| en-only URL wrap, non-en → `null` | `englishWiki` |

The testable seam: importing `server.mjs` does not bind a port (entrypoint guard) and
does not mkdir, so **only pure helpers are testable today**. `buildFrame`, `enrich`,
`resolveTaxon`, `plateFor`, `cached`, and every branch of `handle()` are untested. To
cover HTTP behaviour you must import `{ server }` (server.mjs:324) and
`server.listen(0)` on an ephemeral port.

  The frame's two write paths are **not** covered: `birdnetWrite`, `serveAudio`, and the
  `/api/audio` / `/api/detection` routes. Exercise those against a stub station
  (`BIRDNA_URL=http://127.0.0.1:<stub>`), never by deleting a real detection — the
  upstream delete is not reversible.

Adding a test: append top-level assertions to `test.mjs` under a `//` comment stating
the intent. `npm test` hardcodes that one file — a second file needs a new runner or the
script changed. Pin consumer-visible behaviour (clamping, degradation, licence/attribution
fields), not implementation details or incidental defaults.

Because CI never runs the tests, run `npm test` yourself before pushing, and exercise
the real page before claiming UI work: start the server, load `/`, exercise both toggle
modes, the empty state, and the stale banner (stop the detector).

## Known Traps

- **Plate shape has two names and only one is wired.** `plateFor()` returns
  `{ plate, plateSource }`; `enrich()` re-publishes only the filename as
  `plateUrl: \`/img/art/${plate.plate}\`` for the client. `plateSource` (the Wikimedia
  original) is computed and unused. If you add plate attribution, consume it here.
- **Not every species has a plate.** fugleramme covers ~1095 taxa; the card falls back to
  the photo and is tagged `photo fallback`. That is expected, not a bug — check
  `pickPlate(files, sci)` against the live manifest before assuming a lookup is broken.
- **Licence wording contradicts itself.** `server.mjs:5` calls the plates
  "public-domain artwork"; `README.md:42` and `public/index.html:198` say CC BY-SA 4.0.
  CC BY-SA 4.0 is the correct one — `server.mjs:5` is the stale claim. Attribution is
  shown to users, so fix the code comment, never drop the credit.
- **`README.md` is the only doc.** No `docs/`, `LICENSE`, `CHANGELOG`, or `CONTRIBUTING`.
  If you change behaviour, update `README.md` in the same commit — its env table, clamps,
  poll/rebuild cadence, and licence table are all verified to match the source today, and
  that is worth keeping true.
- `<html lang="zh-Hant">` (index.html:2) is Traditional while all fetched names are
  Simplified (`zh-CN`). Existing, deliberate-looking, but do not "fix" one side only.
- The default `BIRDNA_URL` hardcodes a private LAN address in both `server.mjs:16` and
  `README.md:33`; they must change together.