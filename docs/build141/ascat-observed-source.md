# Satellite wind source packet

Satellite wind is an independent default-OFF entry in the existing Sky menu.
Its component/session modules load only after the first opt-in; Clear all,
Plan, clear view, foreground and account/network fences retain their existing
meaning. The layer supplies no route, depth, alarm, buoy-truth or model-choice
authority. All credits/status use the existing single44px rollup, with no added
map strip or page extent.

The public reader requests only the independent `weather/ascat/v1` pointer and
checksum-bound index, then at most nine fixed5-degree viewport tiles. Wider
views ask for zoom; missing tiles remain swath gaps. Each session has8MiB
cumulative read reservation, at most four actual unfinished reads globally,
15-second individual deadlines,35-second viewport deadline,15-minute session
life and original cohort expiry. Ignored-abort fetches remain charged until
native settlement; old viewport results cannot be adopted. No global cache or
import-time request is introduced.

Original UTC, zero wind, source ordinal, current B/Ccoastal identity, QC,
original raw SHA/byte count, orbit/processing clocks, licence and DOI survive
decoding. NetCDF oceanographic TO has already become meteorological FROM once
on the server; the app preserves that value. Arrows point downwind and zero
wind uses a circle. Rendering keeps at most600 newest actual screen-thinned
vectors, never averages or bridges gaps, and refuses world-spanning arrow
geometry. Original rows expire after24 hours, independently of publication.

Popup interaction uses44px queries and existing competing-gesture leases;
the popup identifies the original observation UTC, Metop platform, age, wind
speed/direction and stress-equivalent10m/25km effective-resolution limit.
The bottom Close is pinned inside the bounded existing ModalSheet.

The provider source remains **unavailable/unadmitted**. Both actual KNMI
shared-key listings returned429 and no original or temporary URL was obtained.
This app does not retry that provider credential. The server package separately
requires an actual reviewed download origin and new worker native proof; no
installation, provider read, publication or timer admission is made here.

Forecast comparison is explicitly unavailable. The existing issued forecast
archive is fixed-station buoy forecasts, not genuine pre-observation global
wind-component fields at these satellite coordinates. The new server scorer
refuses later forecasts/hindcasts and separates satellite agreement from buoy
truth. It cannot create missing archived authority. No forecast comparison or
ready skill claim is shown from the synthetic fixture.

## Verification

-33 focused cases/6 suites passed: original contracts/session/layer/menu plus
preserved measured-sea menu/startup behavior. Account A/B/A, late viewport,
background/OFF cleanup, ignored abort, original expiry, style replacement,
zero wind, FROM/downwind and600-vector cap are exercised.

- Four Chrome/WebKit cases passed at300/375px,130% text,667px viewport using
  the actual layer/session/popup/credits components and a fictional Python-built
  cohort in a synthetic map host. All external requests were aborted. Initial
  reads0; enabled viewport reads3; popup reads none. Fully ancestor-clipped44px
  controls and hit targets, pinned Close after bottom scroll, unchanged map
  rectangle and exact document width/height are asserted. Final artifacts:
  `work/ascat141-own-browser-v4` (retains the generation's original copyright
  year). The first run captured animation before it
  settled; the second exposed an invalid zero-width fixture credits wrapper.
  Both failure receipts remain; final run waits actual animations and mounts
  the unchanged rollup directly in its full-width map host.
- `ascat141-layout.spec.ts` is included in ordinary
  `playwright.keyboard.config.ts`, not only the local proof configuration.
- No whole-app TypeScript or production Vite was run for this packet. Final
  composed compilation, configured JS/asset budgets and real-map integration
  remain parent release checks. Native phone/hardware acceptance is unverified.
