# fugleramme-web

A bird frame for a self-hosted [BirdNET-Go](https://github.com/tphakala/birdnet-go):
every species heard in the last few hours is drawn on one page, named in **Chinese and
English**, and can be shown as **1800s hand-cut plates** or as **real photos**.

Point it at a station, open the page, put it on a screen.

```
┌──────────────────────────────┐
│ 15 species · 51 calls in 24h │   ← everything the frame needs is one endpoint
│ [插画 Illustration][照片 Photo] │   ← 照片 by default, 插画 on click
│ ┌────────┐ ┌────────┐ ┌─────┐ │
│ │ plate  │ │ plate  │ │photo│ │   ← toggle switches every card at once
│ │ 白鹭    │ │ 绿翅鸭  │ │棕背伯劳│ │
│ │ Little │ │ Eurasian│ │Long- │ │   ← each card: 中文名 · English · 学名
│ │ Egret  │ │ Teal   │ │tailed│ │      + 维基百科 / iNaturalist links
│ └────────┘ └────────┘ └─────┘ │
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

## How it behaves

- `GET /api/frame?hours=24` — detections in the window, grouped per species, each enriched
  with plate, photo and 中文名. `hours` is clamped to 1…168.
- The page polls every 30 s; the server rebuilds a frame at most every 20 s.
- **A detector blip never blanks the glass.** Upstream failures serve the last good frame
  with `"stale": true` (the page says so); with no frame ever built the endpoint is 503.
- The chosen style and time window live in `localStorage`, so a kiosk keeps them.

## Verified

`npm test` covers plate-file matching, species grouping and the time window. Against the
live station at `192.168.10.207:8080`: plates, photos, both names, both toggle modes,
empty state, and the stale hold when the detector is unreachable.
