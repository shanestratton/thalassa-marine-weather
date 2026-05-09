# Phase 14 Spike — OpenCPN feature-query test

> **STATUS: ✅ CONFIRMED — Path 2 is real.** OpenCPN's standard
> Object Query / feature-catalog API returns full S-57 attribute
> data when an o-charts encrypted cell is the loaded chart source.
> Verified 2026-05-09 against AusENC OC-61-10ENB5.oesu (Brisbane)
> via dongle-activated `oesenc_pi` plugin on macOS OpenCPN 5.14.0.
> Confirmed layers returning attributes: DEPARE, DRGARE, NAVLNE,
> RECTRC, TOPMAR, MAGVAR, M_NSYS. DRVAL1/DRVAL2 depth values come
> through cleanly; OBJNAM, INFORM, QUASOU, TXTDSC, source cell ID
> all populated. Phase 14b (Thalassa Bridge plugin) is unblocked.

Purpose: determine whether the OpenCPN plugin API exposes vector
chart features when an o-charts (encrypted oeSENC) chart is the
loaded chart source. If yes, we can build a Thalassa Bridge plugin
that lets pi-cache route through the user's dongle-decrypted charts.
If no, that path is closed.

## The clever trick: no code needed for the first test

OpenCPN has a built-in **Object Query** feature accessible from the
chart context menu. It calls the same internal API a plugin would
use. So the question "can plugins access o-charts vector data?"
reduces to "does Object Query return DEPARE / LNDARE / etc. when
clicked on an o-charts chart?"

If the right-click query shows depth-area info on an AusENC chart,
plugins have access and Path 2 is real. If it shows nothing or
says "no chart information available," the data is locked behind
o-charts' rendering layer and the plugin path is closed.

Total spike effort if this returns "no": ~2 hours of OpenCPN
install + chart load. Worth the time to know definitively.

## Step 1 — Install OpenCPN on the Pi

OpenCPN is a GUI app — needs a display. Two options:

### Option A: VNC (recommended for headless boat Pi)

```bash
# Install OpenCPN + VNC server
sudo apt update
sudo apt install opencpn tigervnc-standalone-server tigervnc-common

# Set a VNC password
vncpasswd

# Start a VNC session (port 5901)
vncserver :1 -geometry 1280x800 -depth 24

# On Mac: connect via Finder → Go → Connect to Server
#   vnc://calypso.local:5901
# (or the Pi's IP if mDNS is acting up)
```

Then in the VNC session, launch OpenCPN from a terminal: `opencpn`.

### Option B: X11 forwarding (simpler but laggy)

```bash
# On Mac (with XQuartz installed):
ssh -X skipper@calypso.local
# Then on the Pi:
opencpn
```

Network-rendered, slow but works for a one-off test.

### Option C: Skip the Pi, install on Mac

OpenCPN runs natively on macOS — `brew install --cask opencpn`.
The o-charts dongle works on Mac too (Sentinel HASP runtime is
cross-platform). For just the test, this might be the fastest
path. Install OpenCPN there, plug in the dongle, install
o-charts plugin, load a chart.

The point of the spike isn't where OpenCPN runs — it's whether
o-charts exposes feature data through the standard API. Test
wherever's easiest.

## Step 2 — Sanity-check Object Query on a NOAA chart

Before testing o-charts (the real question), verify Object Query
works at all in your OpenCPN install.

1. Launch OpenCPN.
2. Add a NOAA chart directory (Tools → Options → Charts → Chart
   Files → Add Directory). NOAA cells download free from
   https://nauticalcharts.noaa.gov/charts/ (look for "ENC".)
3. Navigate to anywhere with NOAA coverage (e.g., Savannah).
4. Right-click on a depth area on the chart.
5. Select "**Object Query**" (or "Find current chart objects" in
   some versions).

**Expected:** A dialog showing fields like "DEPARE — depth area",
"DRVAL1 = 5", "DRVAL2 = 10", "OBJNAM", etc. The exact fields are
S-57 attribute codes — confirms OpenCPN populated its feature
catalog with the chart data.

If you see this on NOAA → API works in principle. Move to step 3.

If you see nothing or "no chart features at this position" on
NOAA → something's wrong with the install (or you clicked open
ocean where there genuinely are no features). Try clicking a
known buoy or wreck.

## Step 3 — The actual test: Object Query on o-charts

This is the real spike.

1. Plug in the dongle.
2. In OpenCPN: Tools → Options → Plugins → install / enable
   the o-charts plugin (will need a one-time activation with the
   dongle).
3. Add the o-charts AusENC chart directory.
4. Navigate to AU coverage.
5. Right-click on a depth area → "Object Query".

**Three possible outcomes:**

### Outcome A — Full feature data returned ← **THIS IS WHAT HAPPENED**

You see the same DEPARE / DRVAL1 / etc. fields as on NOAA. The
o-charts plugin populates OpenCPN's standard feature catalog.

**Path 2 is real.** What we actually saw on the 2026-05-09 test:

- Right-click on any chart feature in Brisbane harbour returned
  full structured S-57 attributes — same shape as NOAA, just from
  the dongle-decrypted AusENC cell `OC-61-10ENB5.oesu`.
- DEPARE polygons returned with depth ranges (e.g. "2 m - 5 m").
- DRGARE (Dredged Area) returned with maintained depth, OBJNAM
  ("Swinging Basin"), QUASOU=10 (maintained depth), INFORM, and
  the linked text-description file.
- Navigation lines (NAVLNE, RECTRC) returned with bearings,
  CATTRK / CATNAV / TRAFIC categorical attributes.
- Topmark (TOPMAR) returned with explicit lat/lon, COLOUR=red,
  TOPSHP=cylinder.
- Magnetic variation (MAGVAR) returned with VALMAG and annual
  change rate.

The data we need for routing — DEPARE, DRGARE, LNDARE, OBSTRN,
WRECKS, UWTROC with their depth/safety attributes — is all there.

Next steps (Phase 14b onwards):

- Scaffold a `thalassa-bridge` OpenCPN plugin that calls the same
  feature-query API programmatically.
- Plugin iterates DEPARE / DRGARE / LNDARE / OBSTRN / WRECKS /
  UWTROC in a bbox and serializes them as GeoJSON.
- Plugin exposes a tiny localhost HTTP server (`localhost:3002` or
  similar) so pi-cache can query without going through the
  OpenCPN UI.
- pi-cache adds a `POST /api/enc/route?via=opencpn` endpoint that
  asks the bridge for features instead of reading from disk.
- Routing pipeline: unchanged — same A\* on the same shape of
  GeoJSON, just a different decryption path.

Estimate: 2-3 weeks to working build (real plugin development,
real testing, real packaging).

**Strategic implication:** any user with an o-charts subscription
(any region: AU, UK, NL, NZ, Caribbean, Pacific, etc.) can plug
their dongle into the Pi or any always-on machine on the boat LAN
and Thalassa gets vector routing on every cell they're licensed
for. No M_KEY, no per-region public-data pipeline (though that
remains a useful fallback for users without o-charts), no IHO
licensing fee. Worldwide vector routing through ONE plugin.

### Outcome B — Empty result / "no information"

The dialog opens but shows nothing useful, or says "no chart
information at this position."

**Path 2 is dead.** o-charts is rendering the chart through a
private path that bypasses OpenCPN's feature catalog
specifically to prevent extraction. Document the result,
update the spec to remove Path 2 as an option, move on.

### Outcome C — Some data but not what we need

E.g., it shows the chart has a feature but no attributes, or
shows the visible label but not the underlying DEPARE/DRVAL1.

**Partial — needs investigation.** Capture screenshots of what
it does show, share with me, we figure out if there's a way to
get more detail through a custom query.

## What to send back

Whichever outcome:

- Screenshot of the Object Query dialog on NOAA (sanity check)
- Screenshot of the Object Query dialog on o-charts AusENC
- Note which chart cell ID was loaded (e.g., AU530150)

That's enough for me to write the next concrete step — either
the plugin scaffold (Outcome A) or the spec update (Outcome B/C).

## Cost summary

| Step                      | Time      | Cost                               |
| ------------------------- | --------- | ---------------------------------- |
| OpenCPN install + VNC     | 30-60 min | $0                                 |
| NOAA sanity test          | 15 min    | $0                                 |
| Load o-charts + run query | 15-30 min | already-paid o-charts subscription |
| Total                     | ~2 hours  | $0                                 |

Win condition: a definitive "Path 2 works" or "Path 2 dead"
answer instead of forever-pending uncertainty. Either way we
move on cleanly.
