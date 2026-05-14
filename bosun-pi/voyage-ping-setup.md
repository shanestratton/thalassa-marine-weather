# Voyage Log telemetry ping — Pi setup

The hourly **store-and-forward** ping that keeps the public Voyage Log's
map track and telemetry ribbon current while the boat is underway.

Once an hour a systemd timer fires `bosun_voyage_ping.py`, which:

1. reads position, SOG, COG and barometric pressure from SignalK,
2. pushes one row into the Thalassa `ship_log` table, and
3. if the uplink is down (no sat coverage), holds the ping in a local
   queue and batch-uploads the backlog on the next successful run — so
   the track never has gaps.

`ship_log` is the same table the iOS app already writes to, and the
`voyage-log` edge function reads it for the public page — so no schema
changes and no API changes were needed; the Pi just adds rows.

## Prerequisites

- SignalK running on the Pi at `http://127.0.0.1:3000` with NMEA 2000
  position/SOG/COG (and ideally `environment.outside.pressure`) on the bus.
- The Bosun venv at `/mnt/nvme/bosun/el-venv` (same one the other units use).
- Your Supabase **service-role key** and your **auth user id**.

## Install

```sh
scp -r bosun-pi skipper@bosun:/tmp/
ssh skipper@bosun
cd /tmp/bosun-pi
./install-voyage-ping.sh
```

The installer copies the script, seeds `/mnt/nvme/bosun/voyage-ping.env`
from the example (only if it doesn't already exist), installs the
systemd service + timer, and enables the timer.

## Configure

Edit the env file and fill in the three required values:

```sh
sudo -u skipper nano /mnt/nvme/bosun/voyage-ping.env
```

| Key                         | Where to get it                                                                                                                |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `SUPABASE_URL`              | Pre-filled with the project URL.                                                                                               |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase Dashboard → Project Settings → API → `service_role`. Treat like a password — the file is `600`.                       |
| `BOSUN_USER_ID`             | Supabase Dashboard → Authentication → Users (your row), or `SELECT auth.uid();` in the SQL editor while logged in as yourself. |

The service-role key is what lets the Pi write `ship_log` rows on your
behalf without an interactive login — it bypasses row-level security, so
keep the env file locked down.

## Test

```sh
# Fire one ping by hand
sudo systemctl start bosun-voyage-ping.service

# See what it did
journalctl -u bosun-voyage-ping.service -n 20 --no-pager

# Confirm the hourly schedule is armed
systemctl list-timers bosun-voyage-ping.timer
```

A healthy run logs `sent 1 ping`. Other normal outcomes:

- `no GPS position fix — skipping this run` — SignalK has no position
  yet; nothing to send, will retry next hour.
- `offline — N ping(s) held in the local queue` — uplink was down; the
  ping is queued at `/var/lib/calypso/voyage-ping-queue.json` and will
  flush on the next successful run.

## Notes

- **Timer, not cron.** This matches the other `bosun-pi` units. `OnCalendar=hourly`
  fires at the top of every hour; `Persistent=true` catches a slot missed
  while the Pi was powered down.
- **Capture-time timestamps.** Every ping carries the time it was _taken_,
  not the time it uploaded — so a flushed backlog lands on the timeline
  where it actually happened.
- **Queue cap.** The local queue holds at most 2000 pings (~83 days);
  past that the oldest are dropped.
- **Disable it:** `sudo systemctl disable --now bosun-voyage-ping.timer`.
