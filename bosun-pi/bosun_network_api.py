"""
bosun_network_api — Flask blueprint for /api/network/{status,scan,configure}.

Spec: docs/BOSUN_NETWORK_SETUP_API.md (in the Thalassa repo).

Envelope shape mirrors the existing `bosun_tools_api` blueprint so the
iOS unwrap helpers can be shared:

    {value, source, timestamp, error, latency_ms}

Threading model:
  - status: synchronous, ~10ms (just nmcli reads)
  - scan: synchronous, ~1-3s in station mode; instant cache read in AP
    mode. The waitress thread budget on bosun-web.service is small (2),
    so a slow scan can't tie up the whole server — but other requests
    will queue. Acceptable for v1; iOS shows a spinner.
  - configure: synchronous response in <100ms (writes config, kicks off
    async thread for the actual join). iOS polls /status afterwards.
"""
from __future__ import annotations

import time
from datetime import datetime, timezone
from typing import Any, Optional

from flask import Blueprint, jsonify, request

import bosun_network_apply as net

network_bp = Blueprint("bosun_network", __name__, url_prefix="/api/network")

SOURCE = "bosun.network"


# ── Envelope helper (matches bosun_tools_api shape) ──────────────────────


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def _envelope(
    *,
    value: Any,
    source: str = SOURCE,
    timestamp: Optional[str] = None,
    error: Optional[str] = None,
    latency_ms: int = 0,
):
    return jsonify(
        {
            "value": value,
            "source": source,
            "timestamp": timestamp or _now_iso(),
            "error": error,
            "latency_ms": latency_ms,
        }
    )


def _err(error: str, http_status: int, latency_ms: int = 0):
    """Failure response — value is null, error explains, HTTP status set."""
    return _envelope(value=None, error=error, latency_ms=latency_ms), http_status


# ── /api/network/status ──────────────────────────────────────────────────


@network_bp.route("/status", methods=["GET"])
def status():
    t0 = time.time()
    try:
        value = net.get_status()
    except Exception as e:
        return _err(f"status read failed: {e}", 500, int((time.time() - t0) * 1000))
    return _envelope(value=value, latency_ms=int((time.time() - t0) * 1000))


# ── /api/network/scan ────────────────────────────────────────────────────


@network_bp.route("/scan", methods=["GET"])
def scan():
    t0 = time.time()
    try:
        nets = net.scan_for_endpoint()
    except Exception as e:
        return _err(f"scan failed: {e}", 500, int((time.time() - t0) * 1000))
    # Re-source if we served from the AP-mode cache, so the iOS side can
    # surface "this is a cached list, refresh after rejoining the AP".
    source = SOURCE if not net.is_ap_active() else f"{SOURCE}.cache"
    return jsonify(
        {
            "value": nets,
            "source": source,
            "timestamp": _now_iso(),
            "error": None,
            "latency_ms": int((time.time() - t0) * 1000),
        }
    )


# ── /api/network/configure ───────────────────────────────────────────────

# Validate the security enum strictly — anything else risks the radio
# being misconfigured in a way that needs ssh to recover.
_VALID_SECURITY = {"open", "wep", "wpa", "wpa2", "wpa3", "enterprise"}


@network_bp.route("/configure", methods=["POST", "OPTIONS"])
def configure():
    if request.method == "OPTIONS":
        return ("", 204)

    t0 = time.time()
    body = request.get_json(silent=True) or {}

    ssid = (body.get("ssid") or "").strip()
    if not ssid:
        return _err("ssid required", 400, int((time.time() - t0) * 1000))

    password = body.get("password") or ""
    security = (body.get("security") or "wpa2").strip().lower()
    if security not in _VALID_SECURITY:
        return _err(f"unsupported security: {security}", 400, int((time.time() - t0) * 1000))
    if security == "enterprise":
        return _err(
            "enterprise WiFi is not supported in v1 — pick a personal-PSK network",
            400,
            int((time.time() - t0) * 1000),
        )
    if security != "open":
        if not password:
            return _err("password required for secured networks", 400, int((time.time() - t0) * 1000))
        # WPA/WPA2/WPA3 PSK length is 8–63 ASCII chars (or 64 hex). Reject
        # short passwords here rather than let nmcli surface a confusing
        # "802-11-wireless-security.psk: property is invalid".
        if not (8 <= len(password) <= 64):
            return _err(
                "password must be 8–63 characters",
                400,
                int((time.time() - t0) * 1000),
            )

    tear_down_ap_on_success = bool(body.get("tear_down_ap_on_success", True))

    try:
        settle_seconds = net.configure_station(
            ssid=ssid,
            password=password,
            security=security,
            tear_down_ap_on_success=tear_down_ap_on_success,
        )
    except RuntimeError as e:
        # configure_station raises RuntimeError("join already in progress")
        if "already in progress" in str(e):
            return _err("join already in progress", 409, int((time.time() - t0) * 1000))
        return _err(str(e), 500, int((time.time() - t0) * 1000))

    return _envelope(
        value={
            "accepted": True,
            "next_state": "station_attempting",
            "expected_settle_time_seconds": settle_seconds,
        },
        latency_ms=int((time.time() - t0) * 1000),
    )
