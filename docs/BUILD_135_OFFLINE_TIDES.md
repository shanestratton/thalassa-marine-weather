# 135-02 — Offline tide tables

## Implemented source

- Explicit 14/30-day WorldTides downloads, reached from a chart tide-station card or the Glass tide source controls. Station search accepts a saved place or an entire saved route. Great-circle search centres are at most about 160 km apart after deduplication, across the antimeridian as well. A search is bounded to 12 requests and 48 stations; any unsearched remainder or failed search is labelled partial. A station download remains a separate explicit action.
- Per-account on-device tables: 24 tables, 256 events per table, 1 MiB total and 31-day retention. Storage validates owner, station/request/actual prediction identities, actual datum, event coverage, retrieval/save times and attribution. Writes are serialized and read back before success. iOS uses the existing AES-GCM storage bridge with only one new **scoped** logical key; there is no unscoped key or iOS plaintext fallback.
- Offline/Satellite Mode reads persisted station symbols and extrema in map details and Glass without provider calls. It does not invent sampled heights from saved HW/LW events. Glass's existing estimated curve remains labelled as an estimate. The cache uses the original request point within 5 km; it does not substitute a table from an unrelated port.
- A currently validated official publisher table can be saved separately. Reopening it later uses `saved-official`, retains the original source generation, and carries no fresh-publisher expiry or live observation. The UI says **Saved … table**, shows its coverage and save date, and does not revive official publisher capability. No official publisher was installed or activated for this work.
- Saved-table controls display provider, selected station ID, actual prediction name/position (or an explicit unknown), actual datum, UTC event coverage, retrieval/save times, available source-generation date, and required copyright. WorldTides calculation date is unknown when absent, never relabelled as the download date. Removal is account scoped. Account changes, cancellation and a metered/offline transition fence in-flight work.

## Prepared backend prerequisite — not deployed

`proxy-tides` retains its existing authentication/public-client quotas and default 14-day extrema request. New `capabilities:true` returns a bounded schema without coordinates or any upstream call. A legacy deployment rejects that missing-coordinate request before WorldTides, so a support check cannot accidentally purchase a forecast.

`offlineDays:14..30` requests extrema only. The server owns UTC start (yesterday) and adds two bracketing days, so a 30-day download requests at most 32 calendar days and no dense-height grid. It returns `thalassaWindow` schema 1. The client checks this window and requires actual returned events to bracket now through the full requested future period. Short/legacy/malformed responses are not saved. Dense heights stay limited to the existing three-day mode. Responses are private; end-user predictions must not become a shared intermediate cache.

Before release enablement, review this candidate against freshly retrieved live `proxy-tides` source/helpers, preserve newer live fixes, run Deno formatting/types and the hosted Edge tier, then have the release owner approve deployment. No paid WorldTides request, provider credential read, quota expansion or backend deployment was performed here. On an older service the app explains that long offline tables are not enabled, and makes no paid request.

The UI states the expected credits before the explicit action: one per station search, up to three for a 14-day table and five for 30 days, including bracketing days. These follow the provider's published seven-day extrema charging increments; actual billing remains provider controlled.

## NOAA harmonic reconstruction — deliberately bounded

The separate built-in panel computes **San Francisco, NOAA 9414290 only**, MLLW, datum epoch 1983–2001, for UTC dates 1 January 2026 through 30 April 2027. Other stations continue to use provider tables; no constants are transferred to another position. It is not the official NOAA prediction service, measured water level, storm surge, chart depth or route-clearance input.

It uses all 37 NOAA metric amplitudes and Greenwich phase lags; mean offset is MSL minus MLLW, `2.773 - 1.822 = 0.951 m`, from that same station/epoch. Exact-time astronomical arguments, latitude-dependent satellite terms, nodal amplitude/phase and compound-constituent factors are adapted from MIT-licensed UTide revision `9b60caf9aa5102b87935225a118275579e2f73b6`. The full notice is in `services/tides/UTIDE-LICENSE.txt`. Constants/nodes are validated, including bounded arrays, parent existence and cycle detection, before calculations can run.

NOAA names LAM2/M1/RHO/2MK3 map to Foreman LDA2/NO1/RHO1/MO3, as documented by the primary oce implementation. NOAA's SA speed uses the annual solar argument `h`, whereas UTide's table uses `h - pp`; the NOAA adapter uses `h`. This follows the published NOAA solar frequency and is not an offset fitted to prediction samples. Each hour is calculated directly in UTC; no sine/cosine interpolation of HW/LW is called a harmonic reconstruction. Hourly results do not imply exact times of HW/LW.

Measured against unmodified NOAA Data API metric/MLLW/GMT hourly predictions, without calibration:

| Period                      | Samples |       MAE |      RMSE | Maximum absolute difference |
| --------------------------- | ------: | --------: | --------: | --------------------------: |
| 1–30 January 2026           |     720 | 0.01358 m | 0.01629 m |                   0.04235 m |
| 16 October–15 November 2026 |     744 | 0.00886 m | 0.01061 m |                   0.02825 m |
| 1–30 April 2027             |     720 | 0.01035 m | 0.01229 m |                   0.02909 m |

All 2,184 saved reference values are regression fixtures. These differences are measured reference comparisons, **not** an error bound for other dates, actual water levels or other locations. The retained 4.3 cm test threshold is above the measured worst case. The panel labels this limited coverage and uncertainty; it never enters `navigationUse.ts`, which remains fixed false for WorldTides.

## Primary sources and reproducibility

Checked 16 October 2026:

- [WorldTides terms](https://www.worldtides.info/terms): per-end-user retention/redisplay permitted, attribution required, safety restrictions retained. [API](https://www.worldtides.info/apidocs): coordinate-based requests, actual response datum/point and seven-day charging increments. No station-ID prediction parameter was invented.
- [NOAA harmonic prediction description](https://tidesandcurrents.noaa.gov/about_harmonic_constituents), [NOAA Special Publication 98](https://tidesandcurrents.noaa.gov/publications/SpecialPubNo98.pdf), [NOAA Technical Report 21, Table B](https://tidesandcurrents.noaa.gov/publications/techrpt21.pdf).
- [NOAA station metadata](https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations/9414290.json), [metric constants](https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations/9414290/harcon.json?units=metric), [metric datums](https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations/9414290/datums.json?units=metric).
- Reference query: NOAA Data API `product=predictions`, `station=9414290`, `datum=MLLW`, `time_zone=gmt`, `units=metric`, `interval=h`, `format=json`; begin/end dates are the three table periods. Only this fixed public station was queried.
- [UTide pinned astronomy](https://github.com/wesleybowman/UTide/blob/9b60caf9aa5102b87935225a118275579e2f73b6/utide/astronomy.py), [nodal/satellite implementation](https://github.com/wesleybowman/UTide/blob/9b60caf9aa5102b87935225a118275579e2f73b6/utide/harmonics.py), [MIT licence](https://github.com/wesleybowman/UTide/blob/9b60caf9aa5102b87935225a118275579e2f73b6/LICENSE.txt), [primary oce NOAA-name mapping](https://dankelley.github.io/oce/reference/as.tidem.html).

Raw input SHA-256 receipts are outside the checkout in `work/tide-research135/source-hashes.json`. NOAA constants `7129032615c5638aced9f798596e1805809ea6cb0fec29d9b99c7c034d1667eb`; metric datums `7b5d1b79efb7656499fd91508fec05bce539f1eec177f42456ac6aa4b1b4c79f`; UTide constants `6a02c1332e5c499f1924139dd53f5edfacdcc0a8b1a9fecd8473295512deeeba`. The checked-in JSON contains only the station's public constants and the required astronomical nodes, not a worldwide constants catalogue.

## Verification checkpoint

- All 108 focused tests pass across 14 files: tide, proxy-handler, UI, official provenance, NOAA-reference, encrypted-native-bridge and map lifecycle tests. The native storage test writes and cold-reads the real tide-store service through a mocked encrypted iOS bridge, with no Filesystem/plaintext write. Three map identity regressions prove mounted paid details close, pending old-account promises cannot repopulate markers, and a hidden viewport cache is discarded before the next account re-enables it.
- Fresh full build-135 TypeScript check passed; `work/validation135-tides-final-tsc.log` is empty, process exit 0.
- Real React/CSS browser layout with synthetic data and external requests blocked: 320×640 and 375×667 at 130% font; 24 saved tables and 128 events, no horizontal overflow, bounded scrolling, Escape closes and returns focus. `work/tides135-layout/proof.json` and screenshots are outside the checkout.
- iOS native compilation/device persistence and the combined release bundle/checks remain release-owner gates. No device/TestFlight success is claimed here.

SHOM, UKHO and LINZ harmonic constants are absent. WorldTides navigation/safety use remains held pending verified written permission. No account setting, tier or acknowledgement can enable it.
