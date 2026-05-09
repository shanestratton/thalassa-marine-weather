# Thalassa Bridge — OpenCPN Plugin

> Bridges OpenCPN's vector chart feature catalog to Thalassa's pi-cache via
> a localhost HTTP server, so the inshore router can route through encrypted
> ENCs (AusENC, UKHO, NLHO, etc.) the user has decrypted via their o-charts
> dongle. Phase 14b of the [ENC integration plan](../docs/ENC_INTEGRATION.md).

## Why

Phase 14 spike (see `docs/PHASE_14_SPIKE.md`) confirmed that OpenCPN's
plugin API exposes full S-57 attribute data when an o-charts encrypted
cell is the loaded chart source — DEPARE, DRGARE, LNDARE, OBSTRN, WRECKS,
UWTROC all return with depth values and geometries via the same Object
Query API the chart UI uses.

This plugin wraps that API in a small HTTP server. Pi-cache calls the
HTTP endpoint with a bbox, the plugin queries OpenCPN's in-memory feature
catalog, returns GeoJSON. The Phase 13 inshore router consumes that
GeoJSON exactly as it would consume features extracted from a public
NOAA `.000` file.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  USER'S MACHINE (Mac, Pi, anywhere OpenCPN runs)    │
│                                                      │
│  ┌────────────────────────────────────────────┐     │
│  │ OpenCPN 5.14+                              │     │
│  │  ┌──────────────────┐  ┌──────────────┐   │     │
│  │  │ o-charts plugin  │  │ THIS PLUGIN  │   │     │
│  │  │ (decrypts cells  │  │ (HTTP server │   │     │
│  │  │  via dongle)     │  │  + feature   │   │     │
│  │  └────────┬─────────┘  │  extractor)  │   │     │
│  │           │            └──────┬───────┘   │     │
│  │           ▼                   │           │     │
│  │  ┌──────────────────┐         │           │     │
│  │  │ Feature catalog  │◄────────┘           │     │
│  │  │ (S-57 objects)   │  via PI_S57Obj API  │     │
│  │  └──────────────────┘                     │     │
│  └────────────────────────────────────────────┘     │
│                                                      │
│   Listens on: localhost:3002                         │
└──────────────────────────┬──────────────────────────┘
                           │ HTTP
                           ▼
┌─────────────────────────────────────────────────────┐
│  PI-CACHE (boat Pi)                                  │
│                                                      │
│  POST /api/enc/route?via=opencpn                     │
│   ↓                                                  │
│  GET http://opencpn-host:3002/features?bbox=...      │
│   ↓ GeoJSON FeatureCollection                        │
│  Phase 13 inshore router (UNCHANGED)                 │
└─────────────────────────────────────────────────────┘
```

## Endpoints

### `GET /health`

Sanity check. Returns `{"status":"ok","plugin":"thalassa-bridge","version":"0.1.0"}`.

### `GET /features?bbox=minLon,minLat,maxLon,maxLat&layers=DEPARE,LNDARE,...`

Returns all S-57 features in the given bbox, filtered by the requested
layer types. The `layers` param is optional — if omitted, the plugin
returns the default set listed below.

#### Supported layers

The plugin doesn't whitelist — it returns whatever you ask for if
OpenCPN's catalog has it. These are the ones we've designed for:

**Routing-essential** (consumed by the Phase 13 inshore router):

| Code     | S-57 name       | Why it matters                                             |
| -------- | --------------- | ---------------------------------------------------------- |
| `DEPARE` | Depth area      | Polygon w/ DRVAL1/DRVAL2 — channel depth bands             |
| `DRGARE` | Dredged area    | Maintained-depth channels (more authoritative than DEPARE) |
| `LNDARE` | Land area       | Hard navigation block                                      |
| `OBSTRN` | Obstruction     | Wrecks/structures with VALSOU                              |
| `WRECKS` | Wreck           | Sunken vessels with VALSOU when known                      |
| `UWTROC` | Underwater rock | Always blocked, no exceptions                              |

**Descriptive** (route narration, jurisdiction info, advisories):

| Code     | S-57 name                   | What we use it for                                     |
| -------- | --------------------------- | ------------------------------------------------------ |
| `SEAARE` | Sea area / named water body | "Inner Bar Reach", "Moreton Bay" — route segment names |
| `ADMARE` | Administrative area         | Territorial waters, EEZ, port limits                   |
| `HRBARE` | Harbour area                | "Entering Brisbane Port"                               |
| `CTNARE` | Caution area                | "VTS contact required on Ch 12"                        |
| `RESARE` | Restricted area             | No-anchor / military / marine park boundaries          |
| `PRCARE` | Precautionary area          | High-traffic zones — "expect commercial traffic"       |

**Default** (when `layers` param is omitted): all of the above.

#### Output shape

GeoJSON FeatureCollection with one `Feature` per S-57 object:

```json
{
  "type": "FeatureCollection",
  "features": [
    {
      "type": "Feature",
      "geometry": { "type": "Polygon", "coordinates": [...] },
      "properties": {
        "_layer": "DEPARE",
        "_cellId": "OC-61-10ENB5.oesu",
        "DRVAL1": 14.0,
        "DRVAL2": 20.0,
        "QUASOU": 1
      }
    }
    /* ...more features... */
  ]
}
```

## Production deployment: on the Pi

The boat Pi is the real target — it's where the dongle lives offshore.
Mac is for development verification only (the Mac doesn't go sailing).

### Build on the Pi

```bash
cd /opt/thalassa-pi-cache/opencpn-bridge   # or wherever the repo lives
sudo ./build-pi.sh
```

The script installs build deps via apt (cmake, build-essential,
libwxgtk3.2-dev), clones OpenCPN source for the plugin SDK headers,
fetches cpp-httplib, builds, and installs the plugin to
`~/.opencpn/plugins/lib/`. ~5 minutes on Pi 5, mostly the OpenCPN
source clone.

### The o-charts plugin must also be on the Pi

The Thalassa Bridge plugin doesn't decrypt charts — it asks OpenCPN's
already-decrypted feature catalog for the data. So you also need
**o-charts plugin (`oesenc_pi`) installed on the same Pi**, otherwise
there's nothing for us to bridge.

OpenCPN's master plugin catalogue may not include an arm64 build of
oesenc_pi (we found this earlier — that's why we did the spike on Mac).
You have to grab the .deb directly from o-charts.org:

1. Go to https://o-charts.org/shop2/en/ → log in with your dongle
2. Download section → look for "OpenCPN plugin for Linux ARM64
   (Raspberry Pi)"
3. `sudo dpkg -i ocharts_pi_X.X-X_arm64.deb` on the Pi
4. Restart OpenCPN — `oesenc_pi` should appear in the plugin list

Activate it once with the dongle plugged into the Pi USB.

If o-charts.org doesn't ship an arm64 build for Pi 5: the bridge
plugin still works, but you'd need OpenCPN+o-charts on a separate
machine (e.g. a small x86 NUC also on the boat, or a laptop you bring
aboard) and the bridge plugin runs on THAT machine, exposing port 3002
on the LAN. Pi-cache discovers it via mDNS or explicit host config.

### Once both plugins are loaded

OpenCPN starts → both plugins init → Thalassa Bridge HTTP server is up.
Pi-cache (also on the Pi, on a different port) calls
`http://localhost:3002/features` to extract chart data.

You don't need to keep OpenCPN's GUI visible — it can run minimized
or even headless via `xvfb-run` if you want it as a background
service. The HTTP endpoint stays responsive either way.

## Build (macOS — spike verification only)

Use this if you want to verify the plugin code works before deploying
to the Pi. The build artifact (`libthalassa_bridge_pi.dylib`) only
runs on macOS; the Pi needs `build-pi.sh` to produce a `.so`.

Prerequisites:

```bash
brew install wxwidgets cmake
# Xcode command line tools must be installed:
xcode-select --install
```

You also need OpenCPN's plugin SDK headers. The cleanest path is to
clone OpenCPN's source alongside this repo:

```bash
cd ~/projects
git clone https://github.com/OpenCPN/OpenCPN.git opencpn-source
```

Then build the plugin:

```bash
cd opencpn-bridge
./build-mac.sh
```

This produces `build/libthalassa_bridge_pi.dylib`. To install:

```bash
# macOS plugin location (varies by OpenCPN version)
cp build/libthalassa_bridge_pi.dylib \
   ~/Library/Application\ Support/OpenCPN/plugins/
```

Restart OpenCPN. The plugin should appear in **OpenCPN → Settings →
Plugins** as "Thalassa Bridge" with an Enable checkbox.

After enabling, `curl http://localhost:3002/health` should return ok.

## Status (as of 2026-05-09)

- [x] Plugin class skeleton compiles + loads in OpenCPN 5.14
- [x] HTTP server (cpp-httplib) starts on plugin Init, stops on DeInit
- [x] `/health` endpoint returns plugin metadata
- [x] `/features` endpoint returns valid GeoJSON FeatureCollection shape
- [ ] `/features` returns **real** features extracted from
      OpenCPN's chart objects (currently returns mock data)
- [ ] Iteration over multiple loaded charts in the bbox
- [ ] Geometry serialization for Point / LineString / Polygon
- [ ] All S-57 attribute serialization
- [ ] Multi-platform build (Pi/Linux next)

## Next milestones

1. **Verify load** — user builds and confirms plugin shows in Plugin
   list, curl /health works.
2. **Real feature extraction** — replace mock GeoJSON with actual data
   from `GetPlugInChartObjectsAtCursor` / `ListOfPI_S57Obj`. This is
   the meat of the work — researching the exact OpenCPN plugin API
   for bulk feature retrieval (vs. point-query at cursor).
3. **Pi-cache integration** — pi-cache adds `?via=opencpn` mode to
   `POST /api/enc/route`. Discovers plugin via mDNS or known host.
4. **Linux/Pi build** — same plugin, ARM64 target.

## License

MIT. Designed as an open piece of glue between OpenCPN and Thalassa —
anyone else who wants to build a similar bridge for their app can fork
this and rip out the parts they don't need.
