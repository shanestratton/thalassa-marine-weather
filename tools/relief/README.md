# Relief base tiles

The Obs page's **Relief** base is a picture of the seafloor drawn on Mapbox's
vector water. It has no imagery, so it has none of satellite's stitching. This
folder holds the scripts that build its tiles. It holds no data: the tiles are
built on the wx server and served from Cloudflare R2.

| File              | What it does                                                                                                                           |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `build_relief.sh` | Downloads the sources, builds the GDAL image and both pyramids, writes `manifest.json`, verifies the tiles, starts the tailnet mirror. |
| `encode_tiles.py` | The tile builder. It runs inside the GDAL docker image.                                                                                |
| `upload.sh`       | Copies the tiles to R2 with immutable cache headers, then spot-checks the public copy.                                                 |
| `r2-cors.json`    | The bucket's CORS rule (GET/HEAD from any origin), in wrangler's format.                                                               |

## Sources and credit

| Pyramid          | Source                                                                                                                                                      | Zooms | Licence                                                                                                                          |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------- |
| `relief-global`  | GEBCO 2026 Grid, 15″ ice-surface elevation                                                                                                                  | z0–9  | Public domain. Commercial use is fine with credit, as long as no endorsement is implied and the data is not used for navigation. |
| `relief-au`      | GA _AusBathyTopo (Great Barrier Reef) 30m 2017 - A regional-scale depth model (20170025C)_, version 10 Nov 2020, grids A–D (eCat 115066), merged over GEBCO | z8–13 | CC BY 4.0, © Commonwealth of Australia (Geoscience Australia). Not for navigation.                                               |
| both (land mask) | OpenStreetMap land polygons, split, EPSG:3857 (osmdata.openstreetmap.de)                                                                                    | —     | ODbL; the tiles are a Produced Work, so credit "© OpenStreetMap contributors".                                                   |

Wherever the tiles are shown, show this credit (`RELIEF_ATTRIBUTION`):

> Seafloor relief derived from GEBCO Compilation Group (2026) GEBCO 2026 Grid; based on AusBathyTopo (Great Barrier Reef) 30m 2017 - A regional-scale depth model (20170025C), version 10 Nov 2020, by Geoscience Australia, © Commonwealth of Australia, CC BY 4.0 (subject to its section 5 disclaimer of warranties); coastline © OpenStreetMap contributors. Not for navigation.

"Derived from" is CC BY 4.0's notice of modification (§3(a)(1)(B)): the
tiles are exaggerated, smoothed, merged and land-masked. The coastline credit
is the ODbL Produced Work notice, carried by the relief itself rather than
left to Mapbox's own "© OpenStreetMap" on the same map.

**Ask GA before the App Store release.** Read from GA's catalogue API on
2026-10-05:

- The download's `metadata.txt` points to GA eCat 115066.
- That record's legal-constraint field is _Creative Commons Attribution 4.0
  International Licence_. Its use limitation is _Not to be used for
  navigation_.
- Its lineage text also carries the standard Australian Hydrographic Service
  notice. It says AHS-sourced material in the product is "All rights
  reserved" and may not be reproduced in machine-readable form without AHS
  consent.

The `dem` tiles are depth values in machine-readable form. The decision for
beta is to publish `relief-au`, because the licence field is the operative
grant. Before the App Store release, send GA a two-line email
(clientservices@ga.gov.au) asking them to confirm that rendered tiles in a
commercial app are covered. If they say no, delete the `v1/relief-au/` prefix
from the bucket. The app then falls back to GEBCO by itself, because a
missing tile is a 404.

The GBR 2020 grids reach 29°S, so they cover Moreton Bay. Grid D has real
depths there: −12.5 m at 153.25°E 27.25°S.

## Tile layout

```
<base>/v1/manifest.json
<base>/v1/relief-global/dem/{z}/{x}/{y}.webp   z0-9
<base>/v1/relief-global/idx/{z}/{x}/{y}.png    z0-9
<base>/v1/relief-au/dem/{z}/{x}/{y}.webp       z8-13, inside 142-156°E 10-29°S
<base>/v1/relief-au/idx/{z}/{x}/{y}.png        z8-13
```

- **Tiles.** All tiles are 256 px, XYZ, Web Mercator. A missing tile returns 404. A 404 means the tile is all land or, in `relief-au`, has no GBR 30 m
  data. The app must treat 404 as "nothing here", which Mapbox GL does.
- **`dem` (hillshade only).** Terrarium RGB in lossless WebP:
  `elev = R*256 + G + B/256 - 32768`.
    - Land is clamped to 0 m, so land draws no hillshade.
    - Values are whole metres, so B is always 0.
    - One vertical exaggeration, **x3**, is baked into both pyramids
      (`manifest.json` → `dem.exaggeration_baked`). Set `hillshade-exaggeration`
      for looks only, never to undo the bake. To make the shallows read stronger
      inshore, raise the `relief-au` hillshade's `hillshade-exaggeration`, not the
      bake.
    - The bake must be the same everywhere. v1's first build baked x4 into the
      GBR 30 m data and x3 into GEBCO, blended across the 2 km feather. At the
      grids' outer edges in deep water, that turned a depth `d` into a fake
      cliff of `d` metres over 2 km. Measured: −6965 → −8662 at 154°E 20.5°S,
      −10162 → −12773 at 147°E 13°S, and −13729 → −17633 at 156°E 25°S. The
      hillshade drew each grid edge as a straight bright or dark line across
      the Coral Sea, which is the stitching this base exists to remove.
      `relief-au` was rebuilt at x3 on 2026-10-05, and `build_relief.sh verify`
      now fails any zoom whose `dem / depth` is not a flat x3.
    - `relief-au` z11–13 is smoothed with a gaussian (σ = 1 px) to soften the
      survey-swath edges.
- **`idx` (colour ramp only).** An 8-bit grey PNG, so a browser reads it as
  R = G = B = index. The index uses the depth `d` in metres, positive down,
  without exaggeration or smoothing:
  `0` if `d <= 0.3`, else `1 + round(253 * ln(1 + min(d, 6000)/2) / ln(3001))`.
  This is the prototype's `encode_index`, unchanged. In GL JS 3.19, draw it
  with `raster-color-mix: [255, 0, 0, 0]` and `raster-color-range: [0, 255]`.
  The mix must be 255, not 1: GL hands the shader 0..1.
- **Fades.** `relief-global` is meant to fade out over z10→11 and `relief-au`
  over z13.5→14.5. Where both pyramids exist, at z8–11, the `relief-au` tint is
  opaque over water and covers the global layers. In a `relief-au` tile, any
  part outside the GBR grids holds the same GEBCO data at the same x3, so the
  two pyramids meet without a step.
- **Land comes from OpenStreetMap.** OSM's land polygons are rasterised onto
  every block, and anything on land or at/above 0 m is 0 m. This keeps the
  tint off ground that lies below sea level, such as the Netherlands polders,
  Lake Eyre and the Caspian depression. It also puts the tint's edge on the
  same OSM coastline that Mapbox draws. GEBCO's TID grid could not do this:
  it codes those depressions as data (TID 40, 44 or 70), not as land.
  Measured: Flevoland is −2 m with TID 44, and Lake Eyre is −15 m with
  TID 40. Lakes that OSM treats as land, like the IJsselmeer and the Great
  Lakes, stay flat vector water. The Caspian is OSM coastline, so it gets
  relief.

## URLs

| Where             | Base URL                                                 | Use                                                                                                                         |
| ----------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| wx tailnet mirror | `http://100.76.191.119:8790/v1`                          | Web dev builds and tests on the tailnet only. It is plain http, so the iOS app (`capacitor://` origin, ATS) cannot load it. |
| Cloudflare R2     | `https://pub-1c99456d42db4077ae4c18b6dce83a23.r2.dev/v1` | The app (`RELIEF_TILE_BASE`). Bucket `thalassa-relief`, location OC (Oceania). Empty until `upload.sh` runs.                |

The mirror is an `nginx:alpine` container named `thalassa-relief-tiles`. It
runs with `--restart unless-stopped`, is bound to wx's tailnet address on port
**8790**, mounts `/srv/relief/v1` read-only, sends CORS `*` and caches for
1 hour. The weather API keeps `:8080`. Restart it with
`tools/relief/build_relief.sh serve`.

## Verifying

`tools/relief/build_relief.sh verify` (part of `all`) runs these checks and
exits 1 on any failure:

- For every zoom of both pyramids, the tiles on disk match the manifest count.
- The `idx` and `dem` sets hold the same z/x/y list.
- No file is empty or left over as `.tmp`.
- For 40 random tiles per zoom:
    - `idx` decodes as 256 px grey and `dem` as 256 px WebP.
    - B = 0, the DEM is never above 0 m, and there is no 0 m DEM under water.
    - `dem / depth` is x3 within 13 % on 99 % of pixels deeper than 10 m. The
      smoothed `relief-au` z11–13 check only the median.

## Building (on wx, never on the Mac)

```bash
ssh shanes@100.76.191.119
cd /srv/relief            # the scripts are copied to /srv/relief/tools
tmux new -s relief 'tools/build_relief.sh all; bash'
```

Run `all` to do fetch → prep → global → au → manifest → verify in one go, or
run the steps one at a time.

- **Docker.** Docker needs sudo on wx; the script uses `sudo -n docker` when
  plain `docker` is refused.
- **Image.** The image is `ghcr.io/osgeo/gdal:ubuntu-small-latest` plus scipy
  and pillow, tagged `thalassa-relief:1`.
- **Restarting.** Every step can be restarted. Each finished block leaves a
  stamp in `/srv/relief/work/done/`. To rebuild from scratch, delete
  `/srv/relief/work` and the output folder.
- **How it works.** Blocks are warped with `gdal.Warp` to EPSG:3857 at the
  top zoom, then halved by 2×2 means for each lower zoom.
    - `relief-global`: GEBCO bilinear plus the OSM land mask, in z5 blocks of
      4096 px (z9).
    - `relief-au`: each GBR grid is warped on its own into a z9 block of 4096 px
      (z13) with 128 px of padding. The grids are blended into one another and
      into GEBCO with weights `clip(distance to that grid's edge / 2 km, 0, 1)`.
      This means the four overlapping grids, and the GBR→GEBCO edge, never show
      a straight join.

## Publishing to R2

Done from the Mac with wrangler (`wrangler r2 bucket info|dev-url get|cors list
thalassa-relief` shows it):

- **Bucket.** `thalassa-relief` exists, location OC.
- **Public access.** The _Public Development URL_ is on, at
  `https://pub-1c99456d42db4077ae4c18b6dce83a23.r2.dev`.
- **CORS.** GET and HEAD are allowed from any origin (`r2-cors.json`). A
  missing key still answers 404 with `Access-Control-Allow-Origin: *`, so a
  land tile is a quiet 404, not a CORS failure.
- **No custom domain.** thalassawx.app's DNS is on Vercel, not on a
  Cloudflare zone, so R2 cannot attach a custom domain to it. r2.dev is
  rate-limited and has no edge cache. That is fine for beta. See _Known limits_
  below for what to change before the public release.

Only the upload is left. It needs an R2 S3 API token, which only the
dashboard can make. Wrangler's OAuth login cannot make one, and
`wrangler r2 object put` sends one object per call, which is far too slow
for 550 k objects.

1. **Make the token.** In the Cloudflare dashboard, go to R2 Object Storage →
   Overview → _Manage API tokens_ (under _Account details_ on the right) →
   _Create Account API token_.
    - Token name: `thalassa-relief-upload`.
    - Permissions: **Object Read & Write**.
    - Specify bucket(s): _Apply to specific buckets only_ → `thalassa-relief`.
    - TTL: 7 days.
    - Click _Create Account API Token_, then copy the **Access Key ID** and the
      **Secret Access Key**. The secret is shown only once.
2. **Save the token on wx.** Keep it out of the repo and out of chat. The
   account ID is already saved, and the secret is typed hidden:
    ```bash
    ssh shanes@100.76.191.119
    /srv/relief/tools/upload.sh setup        # paste the Access Key ID, then the secret
    ```
3. **Upload.** Use tmux, so a dropped ssh does not stop it:

    ```bash
    tmux new -s relief-up '/srv/relief/tools/upload.sh; bash'      # Ctrl-b d to detach
    ```

    - It copies each `idx` and `dem` set, then `manifest.json` last.
    - It can be resumed: objects already there with the same size are skipped.
    - To hold `relief-au` back (see _Sources and credit_), use
      `PYRAMIDS=relief-global /srv/relief/tools/upload.sh`.

4. **Check.** Run
   `/srv/relief/tools/upload.sh check https://pub-1c99456d42db4077ae4c18b6dce83a23.r2.dev/v1`.
    - Every tile probe should be 200, with
      `Cache-Control: public, max-age=31536000, immutable` and
      `Access-Control-Allow-Origin: *`.
    - The absent probe should be 404 and still carry `allow-origin *`.
5. **Revoke the token** once the upload is checked, or let it expire.

**Versioning.** Tiles are immutable. A rebuild with different data or
encoding goes to a new prefix (`OUT=/srv/relief/v2`), and the app's
`RELIEF_TILE_BASE` moves to `/v2`. Never overwrite `v1` in place, because
phones and the edge cache hold it for a year.

There was one exception. `v1/relief-au` was rebuilt in place on 2026-10-05,
for the x3 fix, before anything was uploaded: the bucket was still empty, and
the mirror caches for only an hour. From the first upload on, a change means
a new prefix.

**Size (v1, measured 2026-10-05).** The total is 6.91 GB in 549,736 tiles,
plus `manifest.json`.

| Pyramid         | Zooms | Tiles per set | `dem`   | `idx`   |
| --------------- | ----- | ------------- | ------- | ------- |
| `relief-global` | z0–9  | 217,779       | 5.27 GB | 0.83 GB |
| `relief-au`     | z8–13 | 57,089        | 0.62 GB | 0.18 GB |

The global z9 `dem` alone is 3.4 GB of the total.

**Cost.**

- **Storage.** R2 charges $0.015 per GB-month after the first 10 GB free, with
  no egress fees. 6.9 GB is inside the free 10 GB, so storage costs $0.
- **Upload.** The first upload is about 550 k Class A writes. The first 1 M a
  month are free, then $4.50 per million.
- **Reads.** Tile reads are Class B: 10 M a month are free, then $0.36 per
  million. r2.dev has no edge cache, so every view counts.

## Known limits

- **Missing tiles are 27 KB on r2.dev.**
    - A land tile is a 404, and r2.dev sends a 27,150-byte HTML page with it.
      The wx mirror sends 153 bytes. r2.dev does not compress it, whatever the
      client accepts.
    - Measured on coastal views: 25–65 % of relief requests are 404s.
    - A real idx/dem pair averages 12–24 KB at z9–13, so on metered links the
      404 pages can double the data a coastal view uses.
    - Fine for beta. Before the public release, either put the bucket behind a
      custom domain on a Cloudflare zone, where 404s can be compressed and
      cached, or add tiny all-land placeholder tiles for the land tiles next to
      water. Adding placeholders only fills keys that are 404 today, so it does
      not break v1's immutability. In the app, give the `relief-au` sources
      `bounds: [142, -29, 156, -10]` so nothing outside the grids is requested.
- **GEBCO's own texture shows in deep water at z8–9.**
    - In the Coral Sea, GEBCO 2026 has blocky cells and vertical striping, for
      example east of 156°E at 25°S. They are in the source grid: the
      `relief-global` tiles show them too.
    - GEBCO also changes source at 156°E, so a faint line stays at grid D's
      east edge.
    - A v2 could smooth water deeper than ~1 km at z8–9 (σ ≈ 2 px). It was
      left out of v1.

- The data is not for navigation, and the credit says so.
- At z12–13, a faint straight survey-swath edge can still show in the 30 m
  data. The smoothing and the modest x3 exaggeration soften it.
- Where GEBCO's coarse coast reads ≥ 0 m but OSM says sea, there is no tint,
  so a thin strip of plain vector water can show along some coasts at z9–11.
  The GBR 30 m grid has no such strip.
