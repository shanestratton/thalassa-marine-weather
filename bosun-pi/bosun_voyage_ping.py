"""
bosun_voyage_ping — hourly store-and-forward telemetry ping for the
public Voyage Log.

Once an hour a systemd timer runs this script. It grabs a snapshot from
SignalK — position, SOG, COG, heading, apparent + true wind, barometric
pressure, depth, air + water temperature — and pushes one row into the
Thalassa `ship_log` table. That table is what the public voyage-log API
reads for the map track and the live telemetry panel, so this is what
keeps the "folks at home" page current while the boat is underway.

Store-and-forward:
    Out of satellite coverage? The insert fails, the ping is appended to
    a local queue file, and the script exits. On the next successful run
    the whole backlog is flushed in one batch — so the track has no gaps
    even across days offline. Each ping carries its own capture-time
    timestamp, so a flushed backlog lands on the timeline where it
    actually happened, not when it finally uploaded.

Data path:
    NMEA 2000 backbone → SignalK (http://127.0.0.1:3000)
                       → this script (hourly systemd timer)
                       → Supabase ship_log  (PostgREST, service-role key)
                       → voyage-log edge function
                       → thalassawx.app/logs/<handle>

Config — supplied via the systemd EnvironmentFile (voyage-ping.env):
    SUPABASE_URL                 e.g. https://<ref>.supabase.co
    SUPABASE_SERVICE_ROLE_KEY    service-role key — bypasses RLS so the
                                 Pi can write rows for the owner
    BOSUN_USER_ID                the owner's auth.users id — the user_id
                                 every ship_log row is attributed to
    SIGNALK_URL                  optional, defaults to http://127.0.0.1:3000

Dependency-free on purpose: stdlib only, so the firmware image needs no
pip step.
"""
from __future__ import annotations

import json
import math
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

# ── Constants ────────────────────────────────────────────────────────────

# State dir is created (owned by skipper) by install-voyage-ping.sh.
QUEUE_FILE = Path("/var/lib/calypso/voyage-ping-queue.json")

# Cap the backlog so a long offline stretch can't grow the file unbounded.
# 2000 hourly pings ≈ 83 days; past that we drop the oldest.
MAX_QUEUE = 2000

# SignalK delivers SI units; ship_log wants knots / degrees / hPa / °C.
MS_TO_KNOTS = 1.943844
KELVIN_TO_C = 273.15

HTTP_TIMEOUT = 15  # seconds — generous, sat links are slow


def log(msg: str) -> None:
    """Single-line stdout — journald captures it via the systemd unit."""
    print(f"[voyage-ping] {msg}", flush=True)


# ── Config ───────────────────────────────────────────────────────────────


class Config:
    def __init__(self) -> None:
        self.supabase_url = (os.environ.get("SUPABASE_URL") or "").rstrip("/")
        self.service_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or ""
        self.user_id = os.environ.get("BOSUN_USER_ID") or ""
        self.signalk_url = (os.environ.get("SIGNALK_URL") or "http://127.0.0.1:3000").rstrip("/")

    def missing(self) -> list[str]:
        out = []
        if not self.supabase_url:
            out.append("SUPABASE_URL")
        if not self.service_key:
            out.append("SUPABASE_SERVICE_ROLE_KEY")
        if not self.user_id:
            out.append("BOSUN_USER_ID")
        return out


# ── SignalK read ─────────────────────────────────────────────────────────


def _sk_value(node: Any) -> Any:
    """SignalK leaves wrap their reading in {"value": …, "timestamp": …}."""
    if isinstance(node, dict) and "value" in node:
        return node["value"]
    return node


def fetch_signalk() -> Optional[dict[str, Any]]:
    """
    Pull the current navigation + wind + environment snapshot from SignalK.

    Returns a dict of whatever was available (missing instruments → None
    for that field), or None overall if SignalK isn't reachable / has no
    vessel yet (bench Pi with a quiet bus 404s on vessels/self — that's a
    normal "nothing to send" case, not an error).
    """
    url = f"{config.signalk_url}/signalk/v1/api/vessels/self"
    try:
        with urllib.request.urlopen(url, timeout=HTTP_TIMEOUT) as resp:
            vessel = json.load(resp)
    except urllib.error.HTTPError as e:
        if e.code == 404:
            log("SignalK has no vessel data yet (quiet bus) — nothing to send")
        else:
            log(f"SignalK HTTP {e.code} — skipping this run")
        return None
    except (urllib.error.URLError, OSError, json.JSONDecodeError) as e:
        log(f"SignalK unreachable ({e}) — skipping this run")
        return None

    nav = vessel.get("navigation", {}) if isinstance(vessel, dict) else {}
    env = vessel.get("environment", {}) if isinstance(vessel, dict) else {}
    wind = env.get("wind") or {}
    outside = env.get("outside") or {}
    water = env.get("water") or {}
    depth = env.get("depth") or {}

    # Prefer course over ground; fall back to heading if COG isn't on the bus.
    cog_rad = _sk_value(nav.get("courseOverGroundTrue"))
    if cog_rad is None:
        cog_rad = _sk_value(nav.get("headingTrue"))

    return {
        "position": _sk_value(nav.get("position")),
        "sog_ms": _sk_value(nav.get("speedOverGround")),
        "cog_rad": cog_rad,
        "heading_rad": _sk_value(nav.get("headingTrue")),
        "pressure_pa": _sk_value(outside.get("pressure")),
        "aws_ms": _sk_value(wind.get("speedApparent")),
        "awa_rad": _sk_value(wind.get("angleApparent")),
        "tws_ms": _sk_value(wind.get("speedTrue")),
        "twd_rad": _sk_value(wind.get("directionTrue")),
        "depth_m": _sk_value(depth.get("belowTransducer")),
        "water_temp_k": _sk_value(water.get("temperature")),
        "air_temp_k": _sk_value(outside.get("temperature")),
    }


# ── Ping construction ────────────────────────────────────────────────────


def build_ping(state: dict[str, Any]) -> Optional[dict[str, Any]]:
    """
    Turn a SignalK snapshot into a ship_log row.

    Returns None when there's no position fix — latitude/longitude are
    NOT NULL in ship_log, and a track point without a position is
    meaningless, so we just skip the hour rather than queue a dud.
    """
    pos = state.get("position")
    if not isinstance(pos, dict) or pos.get("latitude") is None or pos.get("longitude") is None:
        log("no GPS position fix — skipping this run")
        return None

    ping: dict[str, Any] = {
        "user_id": config.user_id,
        "latitude": round(float(pos["latitude"]), 8),
        "longitude": round(float(pos["longitude"]), 8),
        # Capture time, not insert time — a flushed backlog must land on
        # the timeline where it actually happened.
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "entry_type": "auto",
    }

    def num(key: str) -> Optional[float]:
        v = state.get(key)
        return float(v) if isinstance(v, (int, float)) else None

    sog_ms = num("sog_ms")
    if sog_ms is not None:
        ping["speed_kts"] = round(sog_ms * MS_TO_KNOTS, 1)

    cog_rad = num("cog_rad")
    if cog_rad is not None:
        ping["course_deg"] = int(round(math.degrees(cog_rad))) % 360

    heading_rad = num("heading_rad")
    if heading_rad is not None:
        ping["heading_deg"] = int(round(math.degrees(heading_rad))) % 360

    pressure_pa = num("pressure_pa")
    if pressure_pa is not None:
        ping["pressure"] = int(round(pressure_pa / 100.0))

    aws_ms = num("aws_ms")
    if aws_ms is not None:
        ping["wind_speed_apparent"] = round(aws_ms * MS_TO_KNOTS, 1)

    # Apparent wind angle stays signed: negative = port, positive = starboard.
    awa_rad = num("awa_rad")
    if awa_rad is not None:
        ping["wind_angle_apparent"] = int(round(math.degrees(awa_rad)))

    tws_ms = num("tws_ms")
    if tws_ms is not None:
        ping["wind_speed_true"] = round(tws_ms * MS_TO_KNOTS, 1)

    twd_rad = num("twd_rad")
    if twd_rad is not None:
        ping["wind_direction_true"] = int(round(math.degrees(twd_rad))) % 360

    depth_m = num("depth_m")
    if depth_m is not None:
        ping["depth_m"] = round(depth_m, 1)

    # SignalK temperatures are Kelvin; ship_log stores whole °C.
    water_temp_k = num("water_temp_k")
    if water_temp_k is not None:
        ping["water_temp"] = int(round(water_temp_k - KELVIN_TO_C))

    air_temp_k = num("air_temp_k")
    if air_temp_k is not None:
        ping["air_temp"] = int(round(air_temp_k - KELVIN_TO_C))

    return ping


# ── Local store-and-forward queue ────────────────────────────────────────


def load_queue() -> list[dict[str, Any]]:
    try:
        data = json.loads(QUEUE_FILE.read_text())
        return data if isinstance(data, list) else []
    except FileNotFoundError:
        return []
    except (json.JSONDecodeError, OSError) as e:
        # A corrupt queue file shouldn't wedge the pipeline forever —
        # log it and start fresh rather than crash every hour.
        log(f"queue file unreadable ({e}) — starting a fresh queue")
        return []


def save_queue(pings: list[dict[str, Any]]) -> None:
    # Keep only the most recent MAX_QUEUE — drop the oldest if over.
    trimmed = pings[-MAX_QUEUE:]
    if len(trimmed) < len(pings):
        log(f"queue over {MAX_QUEUE} — dropped {len(pings) - len(trimmed)} oldest pings")
    try:
        QUEUE_FILE.parent.mkdir(parents=True, exist_ok=True)
        tmp = QUEUE_FILE.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(trimmed))
        tmp.replace(QUEUE_FILE)  # atomic swap
    except OSError as e:
        log(f"could not write queue file ({e})")


def clear_queue() -> None:
    try:
        QUEUE_FILE.unlink(missing_ok=True)
    except OSError as e:
        log(f"could not clear queue file ({e})")


# ── Supabase uplink ──────────────────────────────────────────────────────


def flush(pings: list[dict[str, Any]]) -> bool:
    """
    Bulk-insert pings into ship_log via PostgREST. Returns True on success.

    The service-role key bypasses RLS, so the Pi can write rows owned by
    BOSUN_USER_ID directly — no interactive auth on the appliance.
    """
    if not pings:
        return True

    url = f"{config.supabase_url}/rest/v1/ship_log"
    body = json.dumps(pings).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "apikey": config.service_key,
            "Authorization": f"Bearer {config.service_key}",
            "Content-Type": "application/json",
            "Prefer": "return=minimal",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
            if 200 <= resp.status < 300:
                return True
            log(f"Supabase returned HTTP {resp.status}")
            return False
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            detail = e.read().decode("utf-8", "replace")[:300]
        except Exception:  # noqa: BLE001 — best-effort error detail only
            pass
        log(f"Supabase HTTP {e.code}: {detail}")
        return False
    except (urllib.error.URLError, OSError) as e:
        log(f"Supabase unreachable ({e})")
        return False


# ── Main ─────────────────────────────────────────────────────────────────


def main() -> int:
    missing = config.missing()
    if missing:
        log(f"missing config: {', '.join(missing)} — check voyage-ping.env. Aborting.")
        return 1

    state = fetch_signalk()
    if state is None:
        # SignalK not ready / unreachable. Nothing to queue (we have no
        # reading), nothing to flush either — try again next hour.
        return 0

    ping = build_ping(state)
    if ping is None:
        return 0

    queue = load_queue()
    batch = queue + [ping]

    if flush(batch):
        clear_queue()
        if len(batch) > 1:
            log(f"sent {len(batch)} pings (1 fresh + {len(batch) - 1} from the backlog)")
        else:
            log("sent 1 ping")
        return 0

    # Uplink failed — hold everything in the queue for the next run.
    save_queue(batch)
    log(f"offline — {len(batch)} ping(s) held in the local queue, will retry next hour")
    return 1


config = Config()

if __name__ == "__main__":
    sys.exit(main())
