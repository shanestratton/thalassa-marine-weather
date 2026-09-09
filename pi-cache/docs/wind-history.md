# Recorded wind history

The instrument panel's **Max · 1h** is the highest observed true wind in the
preceding hour. **Gust 10m** remains the highest sampled true wind in the
preceding ten minutes, including for existing sail-plan advice. This is not a
meteorological three-second gust measurement or a forecast.

## Collection and delivery

- The cache polls its configured local Signal K service every five seconds,
  independently of screens, pairing, internet availability and cloud uploads.
- Samples use `environment.wind.speedTrue` in m/s, converted to knots, with
  that leaf's original timestamp and `$source`. Missing, future, over-20-second
  cached or invalid samples are not recorded. Repeated source timestamps do
  not create extra observations. A physical-source change starts a new record;
  delayed older-source readings cannot rewind it.
- The bounded rolling hour is persisted in `CACHE_DIR/wind-history.json`,
  fenced to the Pi's stable identity. First samples and source changes flush
  immediately; dirty data normally flushes every 30 seconds, including when
  the sensor goes quiet. Abrupt power loss can lose the latest unflushed
  observations. Corrupt or expired files start an empty record.
- Compact versioned summaries and original wind sample timestamps travel in
  the existing LAN payload and `vessel_telemetry.extra`. No new database table,
  migration, cloud function or sharing-permission change is required.
- The app records direct-gateway samples centrally while running and retains
  validated Pi observations across screen changes. Pi collection supplies the
  preceding hour when the app was closed. Older Pi software without these
  source-time fields can still provide current wind, but cannot provide honest
  preceding-hour peaks; those cards stay unavailable until observations exist.
- Peaks expire by their original observation times even when the feed stops.
  Available history may be partial after startup, outages or a source change.
  The existing instrument-status sheet explains this when a peak is tapped.

## Deployment hold

**Prepared code is not an installed yacht update.** Follow the continuity rules
in [onboard-sensor-exports.md](onboard-sensor-exports.md): obtain the skipper's
explicit safe-interruption approval and arrange anchor-watch reassignment
before restarting `thalassa-cache`. Its assignment is held in memory. Do not
restart Signal K, the gateway or the yacht's BMS producers for this change.

Stage and build separately, compare against the installed version, and back up
the exact files being replaced. Preserve pairing credentials, environment,
certificates and existing history. Do not pull a broad unrelated deployment
onto the yacht. After the approved restart:

1. Verify the cache and its existing services are healthy; the app must confirm
   the current anchor-watch assignment before anyone relies on it.
2. Check fresh original `wind_tws_at_ms`, source and stable Pi identity, plus
   `wind_history_v: 1` in LAN telemetry. Confirm the cloud row carries the same
   source-time peaks without changing any boat's sharing opt-in.
3. Leave the wind page, wait for samples, then return. Test cloud-only access
   and reopening the app: both peaks should arrive without opening the page
   for a warm-up period. Real zero must display zero; absent history must not.
4. First deployment cannot recover observations that were never stored. Allow
   one hour of valid collection to build a complete preceding-hour record.

Client changes are prepared for the next native build, not hot-patched into
the installed TestFlight binary. A physical-device acceptance check and the
approved Pi activation remain separate from repository/build verification.
