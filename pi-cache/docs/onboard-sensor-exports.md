# Public instrument sensor supplement

This uses the existing yacht feeds. It does not open another gateway, MQTT or BLE connection.

- BMP390: the running cache service's own `barometer.state()`. Publish only available samples younger than 180 seconds. The optional set hand is the same sensor's sample nearest three hours earlier, within five minutes.
- House SOC: the explicitly selected whole-bank SmartShunt. `house_battery_sample.py` timestamps actual non-retained MQTT messages, expires them after 90 seconds, and exports `house_battery.json`. Do not substitute an individual bank, voltage curve, cached CSV value, or HTTP receipt time.
- Attitude: existing `wind.py` decoder of Signal K's localhost NMEA passthrough. Its per-field 30-second expiry is retained; the patch adds original receipt timestamps. The cache rejects disconnected/stale files and explicit attitude-invalid status. XDR values are already signed degrees.
- Clock: `THALASSA_SHIP_TIME_ZONE` is an explicitly configured IANA zone. It is **not** automatically synced with the app's device-local clock preference. The public clock uses the existing traditional Royal Navy bell table, not a crew-duty rota. Crew names and assignments are never published.

## Deployment hold / continuity

On 7 September 2026 the yacht's anchor relay was active. **Do not restart `thalassa-cache` until the skipper authorises a safe interruption and anchor-watch reassignment is arranged.** Its assignment is in memory; ordinary renewal may take an hour. Do not silently replay an old assignment. The app must confirm current anchor state after the restart.

Prepare a separate staging directory; back up exact installed files before replacement. Build the cache there and preserve its existing environment, pairing credentials, history and TLS certificates. Do not use a broad repository pull/redeploy to introduce unrelated changes.

For this yacht's existing BMS producers:

1. Copy the installed `soc_logger2.py` and `wind.py` into staging. Dry-run `scripts/yacht-sensor-exports.patch` with `patch --dry-run -p1`; refuse unexpected source drift. Apply the patch to staging only and syntax-check both scripts.
2. Include `scripts/house_battery_sample.py` alongside the staged logger. The patch leaves the existing CSV schema/history untouched.
3. After a safe approved change window, install only the helper and patched producer files, keeping recoverable originals. The producers are cron-supervised by `watch_logger.sh` with separate flock locks. Stop only the identified logger/wind processes gracefully and let that existing supervisor restart them; do not launch duplicate un-locked processes or restart Signal K/Bluetooth.
4. Configure the cache explicitly (these are examples for the observed yacht paths):

    ```dotenv
    THALASSA_WIND_FILE=/home/shanes/bms/wind.json
    THALASSA_HOUSE_BATTERY_FILE=/home/shanes/bms/house_battery.json
    THALASSA_SHIP_TIME_ZONE=Australia/Brisbane
    ```

5. In the approved window, install the validated cache artifacts and restart its service. Verify the producer source timestamps, LAN payload, successful cloud publisher, matching public snapshot, and anchor-watch reassignment. Stop and report any failure; never label an absent reading as zero or a replay as live.

The cloud uses existing `vessel_telemetry.extra` with a strict public allowlist; no database migration or new native bundle is required. Keep all other boats' opt-in settings unchanged. Native gauge corrections are source changes for the next scheduled app build, not a reason to sync/release the frozen beta.
