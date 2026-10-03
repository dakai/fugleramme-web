# fugleramme-web

A bird frame for a self-hosted [BirdNET-Go](https://github.com/tphakala/birdnet-go):
every species heard in the last few hours is drawn on one page, named in **Chinese and
English**, and can be shown as **1800s hand-cut plates** or as **real photos**.

Point it at a station, open the page, put it on a screen.

```
┌──────────────────────────────┐
│ 15 species · 51 calls in 24h │   ← everything the frame needs is one endpoint
│ [照片 Photo][插画 Illustration] │   ← 照片 by default, 插画 on click
│ ┌────────┐ ┌────────┐ ┌─────┐ │
│ │ plate  │ │ plate  │ │photo│ │   ← toggle switches every card at once
│ │ 白鹭    │ │ 绿翅鸭  │ │棕背伯劳│ │
│ │ Little │ │ Eurasian│ │Long- │ │   ← each card: 中文名 · English · 学名
│ │ Egret  │ │ Teal   │ │tailed│ │
│ └────────┘ └────────┘ └─────┘ │      + ▶录音 · ✕误报 · 维基百科 / iNaturalist
```

## Run it

```bash
npm install                                               # pinyin-pro, the only dependency
BIRDNA_URL=http://192.168.10.207:8080 node server.mjs   # → http://0.0.0.0:8090
npm test                                                # the pure helpers
```

Node 20+. No build step.

| variable | default | what it does |
| --- | --- | --- |
| `BIRDNA_URL` | `http://192.168.10.207:8080` | the BirdNET-Go station (no auth needed) |
| `PORT` | `8090` | where the frame is served |
| `DATA_DIR` | `./data` | cache: plates, photos, names |
| `FETCH_TIMEOUT_MS` | `20000` | upstream timeout |

## Where the pictures and names come from

| | source | licence |
| --- | --- | --- |
| plates | [fugleramme](https://github.com/arnegiacomo/fugleramme) artwork (`assets/artwork/classic`) | CC BY-SA 4.0 |
| photos + 中文名 | [iNaturalist](https://www.inaturalist.org) taxon API (`locale=zh-CN`), CC-licensed photo preferred | per photo, credited on the card |
| 详情链接 | [中文维基百科](https://zh.wikipedia.org) article by scientific name, falling back to the English article iNaturalist links | — |

Each species is fetched **once** and cached under `DATA_DIR`. After the first sighting the
frame works with the internet unplugged — which is the point on a NAS. Chinese names come
from iNaturalist's locale data in **Simplified** script (`zh-CN`; its plain `zh` locale is
Traditional). BirdNET-Go itself ships no Chinese dictionary: its `speciesdict` covers 15
European languages only.

Every card links out to read more: 维基百科 when a Chinese article exists, else the English
Wikipedia article, plus the iNaturalist taxon page (which is localised to Chinese too).
Under the Chinese name sits its tone-marked pinyin, romanized locally with `pinyin-pro`
(the only dependency) and cached with the rest of the species.

A species fugleramme has no plate for falls back to its photo, and the card's tag says so.
Artwork is filed under the *current* genus, so a station upgraded across a reclassification
is matched through fugleramme's own `birdnet_aliases.json`.

## On the NAS (TrueNAS)

Point `BIRDNA_URL` at whatever the station answers to from inside the container - the
service name if both run in one compose stack, otherwise the host:

```yaml
services:
  fugleramme-web:
    image: ghcr.io/dakai/fugleramme-web:latest
    ports: ["8090:8090"]
    environment:
      BIRDNA_URL: http://host.docker.internal:8080   # Linux: needs extra_hosts below
    extra_hosts: ["host.docker.internal:host-gateway"]
    volumes: ["./data:/data"]
    restart: unless-stopped
```

`docker compose up -d` pulls the image; there is nothing to build on the NAS. The cache
lives in `./data` (`DATA_DIR=/data` in the image), so plates, photos and names survive
image updates. Pushing to `main` rebuilds and republishes via `.github/workflows/image.yml`
(linux/amd64 + linux/arm64).

### Updating the app

Every push to `main` publishes **two** tags: `:latest` and `:<full-commit-sha>`
(e.g. `ghcr.io/dakai/fugleramme-web:7066ce7…`). Pin the SHA one in your YAML and a
normal redeploy always lands the new image, because a changed image reference is a
changed compose file. `:latest` is a pointer, not a version — with it, a redeploy of
unchanged YAML just recreates the container from whatever is already on disk, because
the tag string did not change.

If you keep `:latest`, pull it explicitly before redeploying:

```bash
midclt call app.pull_images fugleramme-web   # TrueNAS: re-pull a custom app's floating tag
```

There is no reliable re-pull for a custom YAML app in the web UI; `app.redeploy` alone
does not contact the registry.

## How it behaves

- `GET /api/frame?hours=24` — detections in the window, grouped per species, each enriched
  with plate, photo and 中文名. `hours` is clamped to 1…168.
- The page polls every 30 s; the server rebuilds a frame at most every 20 s.
- 照片 Photo is the default view (whole image, not cropped), and it is where the call is
  played, the false positive dropped and the names read. 插画 Illustration is the
  **fugleramme collage**: up to **12 plates on one frame**, nothing else — no buttons, no
  links, no pinyin, and **no photo fallback**: a species fugleramme never drew is left out
  of the sheet rather than shown as a photo. More species than that and the collage rolls
  into another frame (`◀ 第 1 / 2 帧 ▶`).
- In the photo grid a sorter sits beside the time window: 最近 latest heard (default),
  最多 most calls, 最少 rarest, 首次 first heard — ties fall back to the freshest. It orders
  the grid only; the collage keeps its own size order, so the sorter hides with it.
- **The collage is drawn the way fugleramme draws it.** Birds are sized by **real body
  mass** — AVONET grams (`assets/bird-masses.json`, Tobias et al. 2022, CC BY 4.0) raised to
  `0.14` so the heaviest reads ~2.5× the lightest — and the plate that carries a bird is
  drawn tall enough for it to land at that size, however loose its crop (`geometry.json`).
  So a heron leads the sheet and a warbler ends it, and two very different plates of one
  species draw the same bird. Each plate stands on a shared baseline, captioned underneath
  in handwriting.
  Each plate's paper is normalised onto the sheet's tone in a canvas (`onPaper`, a port of
  fugleramme's `paper.process_sprite`): the plate's own paper tone is measured from its cut
  edge, the paper reachable from outside is flooded and painted flat, and only the paper the
  ink walls off is pulled toward the tone — so white plumage, pale water and the painted
  ground under a bird survive untouched. `PAPER` is fugleramme's own `TARGET_PAPER`, aged
  cream rather than white, because the plates' paper is not white.
- **What you see is the sheet that prints.** The illustration frame is laid out as an A4
  landscape page: every bird and caption is sized in percent of the *sheet's* height, so the
  screen composition and the PDF are the same page. The birds are then drawn as large as the
  sheet allows, so a frame of twelve fills the page instead of sitting in the middle of it.
  Plates are drawn whole, never cropped, and no blend mode is used — the paper is already the
  page's tone, so the screen and the paper show the same thing.
- **⤓ A4 PDF prints one frame per sheet.** The print stylesheet is A4 landscape with zero
  margin and hides everything but the current frame, so the browser's own *Save as PDF*
  writes a single A4 file for the frame on screen — no PDF library, nothing to install.
  The handwriting is [Ma Shan Zheng](https://fonts.google.com/specimen/Ma+Shan+Zheng)
  (OFL, vendored at `public/fonts/`), the only CJK handwriting face guaranteed to exist
  offline; it carries Latin glyphs too, so one 3 MB file covers both names.
- **Each card plays the call.** `▶ 录音 Play` streams the newest detection's clip through
  the frame (`GET /api/audio/:id`), so nothing third-party is fetched by the browser.
  While it plays the button fills from the left like a progress bar, so a running call is
  visible and not just audible; a paused one keeps its fill, an ended one empties it.
- **`✕ 误报 false positive` deletes that detection from BirdNET-Go** (`DELETE
  /api/detection/:id`) after a confirmation — the record is gone from the station, not just
  hidden here. Needs the station running without HTTP auth; a protected station answers 401
  and the card says so in the banner.
- **A detector blip never blanks the glass.** Upstream failures serve the last good frame
  with `"stale": true` (the page says so); with no frame ever built the endpoint is 503.
- The chosen style and time window live in `localStorage`, so a kiosk keeps them.

## Verified

`npm test` covers plate-file matching, species grouping, the time window and which
detection a card's recorder addresses. Against the live station at `192.168.10.207:8080`:
plates, photos, both names, both toggle modes, whole-image photos, clip playback, the
empty state, and the stale hold when the detector is unreachable. The false-positive
delete was exercised end to end against a stand-in station, never against real data.
The progress fill was checked in Chromium against a stand-in station: it tracks the clip,
survives the 30 s re-render, holds on pause and empties on `ended`.
The collage was checked in Chromium against the live station: birds sized by mass (a
bittern drawn taller than a wagtail), plates flattened into the sheet, species with no
plate left out, 12 to a frame, and each frame one A4 landscape page
(`pdfinfo`: 1 page, 841.92 × 595.92 pt).
