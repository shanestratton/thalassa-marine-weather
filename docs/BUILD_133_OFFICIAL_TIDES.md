# Build 133-08: official tide display tables

The app prefers fresh, validated MSQ, NOAA CO-OPS and LINZ station tables from `weather/tides/` and keeps WorldTides as fallback. A table carries its exact provider, station, datum identity, source, licence, generation, expiry and high/low events. No datum conversion occurs. Between events, the existing display curve is labelled as an estimate. The graph exposes source and licence attribution; expired official tables disappear until refreshed. Voice output carries the same provenance. The planner separately names the official high/low table and the WorldTides departure estimate, so MLLW and LAT cannot acquire one shared caption.

Official tables never enter `TideHeightService`, chart tide credit, under-keel clearance or routing. Those paths retain the independently checked WorldTides/chart datum contract. MSQ CSV headers identify station LAT; the client does not promote that to a universal LAT datum or an unproved 1992 epoch. LINZ retains each port's chart datum. NOAA requests GMT, metres, MLLW and high/low events explicitly.

The weather-server implementation is in `tides/official_tables.py`, `tides/publish_tides.py` and their tests, with reviewed changes to the existing QLD/NOAA fetchers and TMR residual producer. The new timer is prepared in `ops/systemd/official-tides-publish.*`. Station generation objects upload before the manifest, so incomplete uploads cannot activate a missing generation. Downloads, object paths, response sizes, caches and timeouts are bounded. Storage credentials stay in the child environment. An observation appears only when the existing TMR producer supplies matching observed/predicted gauge, raw datum and timestamp evidence; proxy gauges and statistical agreement cannot qualify it.

CHS is disabled. Its current public licence excludes navigation and commercial derivative use; no CHS request is made. An additional agreement is required before adding it.

## Evidence

- Local: 24 Vitest tests in five files passed for client validation, request coalescing, response bounds, fallback, source/datum pairing, graph expiry/attribution, positional refresh and planner provenance. Targeted ESLint has zero errors; changed app files pass Prettier.
- Local: seven Python unittest cases passed for source parsing, GMT and New Zealand DST ambiguity, annual coverage, gauge/datum pairing and manifest-last upload ordering with credentials excluded from command arguments.
- Live public reads, 16 October 2026: local stage-only execution fetched and parsed Scarborough/MSQ, Annapolis/NOAA and Auckland/LINZ with three successful tables and zero failures. No `--publish` was used. This demonstrates source parsing, not deployment or delivery.

## Deployment and rollback

No production publication, timer installation, bucket/RLS change or database migration has occurred. The app stays on WorldTides until the deployed publisher's capability files validate.

Before enabling the timer, review the source changes and run the Python suite on the weather box, then stage locally with an operator-selected station list. The supplied defaults cover the seven existing configured Queensland names, the existing NOAA USVI station and Auckland; this is station coverage, not country-wide interpolation. Verify output and object permissions before supplying the established Supabase S3 credentials and `TIDES_PUBLISH_ENABLED=1`. The service uses `/etc/thalassa/publish.env`, the `weather` bucket and the configured project reference. It requires rclone and Python with `Pacific/Auckland` timezone data. No new database tables are needed.

Enable the prepared 15-minute timer only after an approved first publication and a readback through the app client. Confirm manifest expiry, provider coverage and observed gauge freshness. When an annual source cannot cover fourteen more days, that station is omitted and WorldTides remains available; no annual extrapolation is made. Monitor nonzero publisher exits and manifest age using the weather box's existing operational alert channel. Keep generation-object retention within the existing storage policy.

Rollback: stop/disable the new timer, restore the prior fetcher/TMR files if needed, and remove or expire the capability manifest. The app automatically falls back when the capability read fails or expires. Do not alter the chart datum or routing service to compensate for a publisher failure.

## Primary sources checked 16 October 2026

- [Queensland 2026 Scarborough high/low data and CC BY 4.0 licence](https://www.data.qld.gov.au/dataset/scarborough-tide-gauge-predicted-high-low-data/resource/74d2b81f-2657-42dd-a193-7bc77fdb48b9).
- [MSQ datum guidance](https://www.msq.qld.gov.au/Tides/Tidal-datum-information): QPD LAT (1992) information does not replace a station's raw header or prove a match with a chart.
- [NOAA CO-OPS API](https://api.tidesandcurrents.noaa.gov/api/prod/) and [CO-OPS copyright/disclaimers](https://www.tidesandcurrents.noaa.gov/disclaimers.html).
- [LINZ tide predictions](https://www.linz.govt.nz/products-services/tides-and-tidal-streams/tide-predictions), [port datum descriptions](https://www.linz.govt.nz/guidance/marine-information/tide-prediction-guidance/standard-port-datum-descriptions), [copyright and attribution](https://www.linz.govt.nz/copyright), and [nautical almanac attribution](https://www.linz.govt.nz/products-services/maritime-safety/new-zealand-nautical-almanac/nz-nautical-almanac-nz-204-extracts).
- [CHS licence agreement](https://tides.gc.ca/en/licence-agreement).
