# AIS Boat Bridge — the yacht as a shore station

`workers/ais-ingest/bridge.ts` (built to `dist/bridge.js` by the same package
as the Railway worker) turns the boat's own AIS receiver into a data source:

    YDWG-02 (boat, via tailnet) ──TCP──▶ bridge (pi5) ──┬─▶ Supabase vessels
                                                        └─▶ AISHub (UDP, optional)

The transponder aboard hears every target in the bay and the YDWG serves the
decoded `!AIVDM` sentences over TCP. The bridge decodes them (aivdm.ts — a
vendored copy of the app's own decoder, parity-tested in the main suite) and
upserts through the SAME VesselDB as the Railway worker: identical change
detection, batching, merge_vessels COALESCE, wedge counter. Own-ship `!AIVDO`
is decoded too — that is how the owner's yacht lands in the table — and is
rewritten as `!AIVDM` for the AISHub forward.

## Deploy on the pi5

```bash
git clone https://github.com/shanestratton/thalassa-marine-weather.git
cd thalassa-marine-weather/workers/ais-ingest
npm ci && npm run build
cat > .env <<'ENV'
SUPABASE_URL=https://<project>.supabase.co
SUPABASE_SERVICE_KEY=<sb_secret_...>       # never commit; pi5-local only
YDWG_HOST=192.168.1.151
YDWG_PORT=1457
# AISHub lane — leave unset until the station is registered:
# AISHUB_HOST=data.aishub.net
# AISHUB_PORT=<your assigned port>
ENV
node dist/bridge.js
```

systemd unit (`sudo tee /etc/systemd/system/ais-bridge.service`):

```ini
[Unit]
Description=Thalassa AIS boat bridge (YDWG -> Supabase/AISHub)
After=network-online.target tailscaled.service

[Service]
User=shanes
WorkingDirectory=/home/shanes/thalassa-marine-weather/workers/ais-ingest
ExecStart=/usr/bin/node dist/bridge.js
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

Then `sudo systemctl enable --now ais-bridge` and watch
`journalctl -u ais-bridge -f` for the `[STATS]` lines.

## Operational notes

- **YDWG slot budget**: the gateway has 3 TCP slots. The app aboard and
  wind.py hold two; the bridge takes the third (port 1457). When a diagnostic
  capture needs a slot, stop the bridge first — otherwise the contention
  fakes bus dropouts (learned the hard way, 2026-08-18).
- **Boat asleep is normal.** The bridge idles on failed connects with capped
  backoff (60 s) forever and picks up the moment the boat network returns.
  `/health` (port 3002) reports `degraded-upstream`, HTTP 200 — like the
  Railway worker, silence upstream is not a process fault.
- **AISHub activation**: plain UDP NMEA. Register the station, set
  AISHUB_HOST/PORT, restart, then EMAIL AISHub that streaming has begun —
  the account is not issued until you do.
- **An assigned AISHub port can be taken back, and nothing tells you.** UDP
  never answers, so a reassigned port looks *exactly* like a healthy one from
  here: sentences leave, `AISHub fwd` keeps climbing, zero send errors. The
  port issued in March 2026 was given to another user because too long passed
  before the boat went live, and the bridge then spent a day forwarding 161k
  sentences into a stranger's station before anyone noticed. The only
  ground truth is the station page — `aishub.net/stations/<port>` — so check
  it after any activation or long silence, and don't read a clean local log
  as proof of delivery.
- **Two lanes carry this port, not one.** The boat bridge reads AISHUB_PORT
  from `~/ais-bridge/.env` on pi5; the Railway worker's crowd-feed forward
  (`fleetFeed.ts`) reads its own AISHUB_PORT from the Railway dashboard.
  Changing one does not change the other. The Railway lane fails safe when
  the vars are unset, which also means a stale value there is silent.
