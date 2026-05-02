"""
bosun_n2k_api — Flask blueprint for /api/n2k/status.

Surfaces the live state of the NMEA 2000 ingest pipeline so Thalassa
can render a "is the bus alive" diagnostic without the user SSHing
into the Pi:

    1. SocketCAN link state (UP/DOWN, ERROR-PASSIVE, BUS-OFF…)
    2. RX/TX byte + packet counters (cumulative since boot)
    3. Bitrate the kernel thinks it's running at (sanity-check 250kbps)
    4. Recent unique PGNs heard, decoded via canboatjs/signalk_paths if
       SignalK exposes them
    5. SignalK paths the Bosun tools API depends on, with their freshness
       (so we can surface "depth_m last seen 3s ago" or "no signal yet")

Designed to work on bench (can0 ERROR-PASSIVE / no traffic) AND on the
boat (depth/wind/heading/etc. populated within seconds of bus-up).

Hardware path:
    NMEA 2000 backbone → PiCAN-M Hat → SocketCAN can0 (250kbps)
                       → SignalK n2k-can0 provider (canboatjs)
                       → SignalK API at http://localhost:3000
                       → boat_state.py / get_vessel_state tool
                       → Thalassa Dashboard
"""
from __future__ import annotations

import json
import re
import subprocess
import time
import urllib.request
from datetime import datetime, timezone
from typing import Any, Optional

from flask import Blueprint, jsonify

n2k_bp = Blueprint("bosun_n2k", __name__, url_prefix="/api/n2k")

SOURCE = "bosun.n2k"
SIGNALK_BASE = "http://127.0.0.1:3000/signalk/v1/api/vessels/self"

# The N2K-derived SignalK paths Bosun tools depend on. If any of these
# is null/stale, that's a diagnostic signal worth surfacing.
TRACKED_PATHS = {
    "navigation.position": ("position", "GPS Position"),
    "navigation.speedOverGround": ("sog_kts", "SOG"),
    "navigation.courseOverGroundTrue": ("cog_deg", "COG"),
    "navigation.headingTrue": ("heading_deg", "Heading"),
    "environment.depth.belowTransducer": ("depth_m", "Depth"),
    "environment.wind.speedApparent": ("wind_apparent_speed_kt", "AWS"),
    "environment.wind.angleApparent": ("wind_apparent_angle_deg", "AWA"),
    "environment.wind.speedTrue": ("wind_true_speed_kt", "TWS"),
    "environment.wind.directionTrue": ("wind_true_angle_deg", "TWD"),
    "environment.water.temperature": ("water_temp_c", "Water Temp"),
    "propulsion.0.revolutions": ("engine_rpm", "Engine RPM"),
}


# ── Envelope helper ──────────────────────────────────────────────────


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def _envelope(*, value: Any, error: Optional[str] = None, latency_ms: int = 0):
    return jsonify(
        {
            "value": value,
            "source": SOURCE,
            "timestamp": _now_iso(),
            "error": error,
            "latency_ms": latency_ms,
        }
    )


# ── SocketCAN state probes ───────────────────────────────────────────


def _ip_link_show_can0() -> dict:
    """Run `ip -s -d link show can0` and parse the bits we care about.

    Returns a dict with link_state, can_state, bitrate, rx_bytes,
    rx_packets, tx_bytes, tx_packets, errors. Any field missing from the
    output is null — we don't crash if the kernel format shifts.
    """
    out = {
        "link_state": None,
        "can_state": None,
        "bitrate": None,
        "rx_bytes": None,
        "rx_packets": None,
        "tx_bytes": None,
        "tx_packets": None,
        "errors": None,
    }
    try:
        r = subprocess.run(
            ["ip", "-s", "-d", "link", "show", "can0"],
            capture_output=True,
            text=True,
            timeout=2.0,
        )
    except FileNotFoundError:
        return out
    if r.returncode != 0:
        return out
    text = r.stdout

    # First-line link state: e.g. "<NOARP,UP,LOWER_UP,ECHO>"
    m = re.search(r"<([^>]+)>", text)
    if m:
        flags = set(m.group(1).split(","))
        out["link_state"] = "up" if "UP" in flags else "down"

    # `can state ERROR-ACTIVE` or `can state BUS-OFF` etc.
    m = re.search(r"can state (\S+)", text)
    if m:
        out["can_state"] = m.group(1)

    # `bitrate 250000`
    m = re.search(r"bitrate (\d+)", text)
    if m:
        out["bitrate"] = int(m.group(1))

    # `RX:  bytes packets ... \n     <values>`
    rx = re.search(r"RX:\s+bytes\s+packets[^\n]*\n\s*(\d+)\s+(\d+)\s+(\d+)", text)
    if rx:
        out["rx_bytes"] = int(rx.group(1))
        out["rx_packets"] = int(rx.group(2))
        out["errors"] = int(rx.group(3))
    tx = re.search(r"TX:\s+bytes\s+packets[^\n]*\n\s*(\d+)\s+(\d+)", text)
    if tx:
        out["tx_bytes"] = int(tx.group(1))
        out["tx_packets"] = int(tx.group(2))

    return out


# ── SignalK path freshness ───────────────────────────────────────────


def _fetch_signalk_self() -> Optional[dict]:
    """Fetch the full SignalK `self` document; None on any failure."""
    try:
        req = urllib.request.Request(SIGNALK_BASE, headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=2.0) as resp:
            return json.loads(resp.read())
    except Exception:
        return None


def _drill(d: dict, path: str) -> Optional[dict]:
    """Navigate dot-path into a SignalK document, return the leaf dict (with .value, .timestamp) or None."""
    cur: Any = d
    for part in path.split("."):
        if not isinstance(cur, dict) or part not in cur:
            return None
        cur = cur[part]
    return cur if isinstance(cur, dict) else None


def _path_freshness(self_doc: Optional[dict]) -> dict:
    """For each TRACKED_PATH, report value / age_seconds / source. Null when path not yet populated."""
    out: dict = {}
    if not self_doc:
        for path, (key, _) in TRACKED_PATHS.items():
            out[key] = {"path": path, "value": None, "age_seconds": None, "source": None}
        return out

    now = datetime.now(timezone.utc)
    for path, (key, label) in TRACKED_PATHS.items():
        leaf = _drill(self_doc, path)
        entry: dict = {"path": path, "label": label, "value": None, "age_seconds": None, "source": None}
        if leaf and "value" in leaf:
            entry["value"] = leaf.get("value")
            ts = leaf.get("timestamp")
            if isinstance(ts, str):
                try:
                    leaf_ts = datetime.fromisoformat(ts.replace("Z", "+00:00"))
                    entry["age_seconds"] = (now - leaf_ts).total_seconds()
                except ValueError:
                    pass
            entry["source"] = leaf.get("$source")
        out[key] = entry
    return out


# ── Endpoint ─────────────────────────────────────────────────────────


@n2k_bp.route("/status", methods=["GET"])
def status():
    t0 = time.time()
    can = _ip_link_show_can0()
    self_doc = _fetch_signalk_self()
    paths = _path_freshness(self_doc)

    # Convenience flags: "is the wire alive?" + "is data flowing?"
    wire_up = can.get("link_state") == "up" and can.get("can_state") not in (None, "BUS-OFF")
    has_traffic = (can.get("rx_bytes") or 0) > 0
    paths_seen = sum(1 for p in paths.values() if p["value"] is not None)

    # Health summary that's safe to render in the iOS UI directly:
    #   green: bus alive, traffic flowing, paths populated
    #   amber: bus alive but ERROR-PASSIVE / no traffic (bench mode)
    #   red:   wire down or driver dead
    if not wire_up:
        health = "red"
        summary = "can0 down — check PiCAN-M hat / mcp251x driver"
    elif not has_traffic:
        health = "amber"
        summary = "can0 up at " + str(can.get("bitrate") or "?") + "bps but no traffic — check N2K backbone connection / termination"
    elif paths_seen == 0:
        health = "amber"
        summary = "Traffic on can0 but no SignalK paths populated yet — give it a few seconds"
    else:
        health = "green"
        summary = f"NMEA 2000 alive ({paths_seen}/{len(TRACKED_PATHS)} tracked paths populated)"

    return _envelope(
        value={
            "health": health,
            "summary": summary,
            "wire_up": wire_up,
            "has_traffic": has_traffic,
            "can": can,
            "tracked_paths": paths,
            "tracked_paths_seen": paths_seen,
            "tracked_paths_total": len(TRACKED_PATHS),
            "signalk_reachable": self_doc is not None,
        },
        latency_ms=int((time.time() - t0) * 1000),
    )
