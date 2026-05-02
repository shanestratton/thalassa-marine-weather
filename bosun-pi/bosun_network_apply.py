"""
bosun_network_apply — NetworkManager-backed WiFi state + station/AP swap.

Single thin wrapper over `nmcli` that backs the /api/network/* endpoints
specified in docs/BOSUN_NETWORK_SETUP_API.md.

Why nmcli (and only nmcli):
  - The dev + production Pi images both ship Bookworm/Trixie + NetworkManager
    1.52+, so the spec's `wpa_supplicant` branch is dead code for v1.
  - NM's built-in `ipv4.method=shared` hotspot mode includes a dnsmasq +
    iptables MASQUERADE setup, which means we don't need to install or
    manage standalone hostapd/dnsmasq services.

Permissions:
  - The bosun-web service runs as `skipper`, who is in the `netdev` group.
  - The companion polkit rule at /etc/polkit-1/rules.d/50-bosun-network.rules
    grants `netdev` members full org.freedesktop.NetworkManager.* without
    a password prompt. The rule ships with this firmware image.

Single-radio constraint:
  - Pi 5's onboard wlan0 is a single physical radio. While in AP mode it
    cannot scan for nearby networks. To work around this, the boot-time
    decision script captures a fresh scan BEFORE bringing up the AP and
    persists it to LAST_SCAN_FILE. /api/network/scan reads this cache
    when the radio is busy beaconing.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import threading
import time
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal, Optional

# ── Hard-coded knobs from BOSUN_NETWORK_SETUP_API.md ─────────────────────
# These ship in the firmware image. Don't bikeshed without coordinating
# with the iOS side — the SSID prefix in particular is load-bearing for
# the NEHotspotConfiguration entitlement.

AP_SSID_PREFIX = "Calypso-Setup-"
AP_PASSWORD = "calypso-setup"  # static for v1; per-Pi derivation later
AP_CONNECTION_NAME = "calypso-ap"
AP_IPV4_ADDRESS = "10.0.0.1/24"
AP_BAND = "bg"  # 2.4 GHz — broader compatibility than 5GHz
AP_CHANNEL = 6  # quiet US/EU default; auto-selection requires AP scan first
WIFI_INTERFACE = "wlan0"
STATION_CONNECTION_PREFIX = "calypso-station-"
STATION_AUTOCONNECT_PRIORITY = 100  # outranks any pre-existing netplan-managed connection

# Persistent state files. Primary path is /var/lib/calypso (installed with
# skipper ownership by bosun-pi/install.sh on production firmware). Dev
# fallback is ~/.local/state/calypso so manual runs without `sudo install
# -d` still persist last-join across requests.
def _resolve_state_dir() -> Path:
    primary = Path("/var/lib/calypso")
    try:
        primary.mkdir(parents=True, exist_ok=True)
        probe = primary / ".write-probe"
        probe.touch()
        probe.unlink()
        return primary
    except (OSError, PermissionError):
        pass
    fallback = Path.home() / ".local" / "state" / "calypso"
    fallback.mkdir(parents=True, exist_ok=True)
    return fallback


STATE_DIR = _resolve_state_dir()
LAST_JOIN_FILE = STATE_DIR / "last-join.json"
LAST_SCAN_FILE = STATE_DIR / "last-scan.json"

# nmcli timeouts in seconds
NMCLI_TIMEOUT_FAST = 5.0  # status, list — these should never take more than a second
NMCLI_TIMEOUT_SCAN = 15.0  # rescan + list
NMCLI_TIMEOUT_CONNECT = 35.0  # add + up — wpa_supplicant 4-way handshake can take ~10-15s


# ── Process boot timestamp ───────────────────────────────────────────────
_BOOT_TS = time.time()


def _uptime_seconds() -> int:
    return int(time.time() - _BOOT_TS)


# ── Subprocess helper ────────────────────────────────────────────────────


def _run(args: list[str], timeout: float) -> tuple[int, str, str]:
    """Run a command, return (returncode, stdout, stderr).

    Never raises on non-zero exit — callers inspect the code. Raises only
    on timeout (subprocess.TimeoutExpired) or missing binary (FileNotFoundError).
    """
    p = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    return p.returncode, p.stdout, p.stderr


# ── nmcli output parsing ─────────────────────────────────────────────────
#
# `nmcli -t` separates fields with `:` and escapes literal colons inside
# values as `\:`. Splitting on plain `:` gives wrong results for SSIDs
# like "5G:wired". Parse with a tiny state machine that respects the
# escape sequence.

def _split_nmcli_terse(line: str) -> list[str]:
    """Split a `nmcli -t` row, honouring `\\:` escapes inside fields."""
    fields: list[str] = []
    buf: list[str] = []
    i = 0
    while i < len(line):
        ch = line[i]
        if ch == "\\" and i + 1 < len(line) and line[i + 1] == ":":
            buf.append(":")
            i += 2
            continue
        if ch == ":":
            fields.append("".join(buf))
            buf = []
            i += 1
            continue
        buf.append(ch)
        i += 1
    fields.append("".join(buf))
    return fields


# ── MAC + AP SSID helpers ────────────────────────────────────────────────


def wlan_mac() -> str:
    """Return the wlan0 MAC as a lowercase colon-separated string."""
    try:
        return Path(f"/sys/class/net/{WIFI_INTERFACE}/address").read_text().strip()
    except FileNotFoundError:
        return "00:00:00:00:00:00"


def ap_ssid() -> str:
    """SSID for the setup AP, e.g. `Calypso-Setup-A3F2`.

    Uses the last 4 hex chars of the MAC, uppercased and with the colon
    stripped. Stable across reboots so the iOS NEHotspotConfiguration
    prefix match works.
    """
    mac = wlan_mac().replace(":", "").upper()
    return f"{AP_SSID_PREFIX}{mac[-4:]}"


# ── Connection-name helpers ──────────────────────────────────────────────


def _station_connection_name(ssid: str) -> str:
    """Sanitised NM connection name for a user-supplied SSID."""
    safe = re.sub(r"[^A-Za-z0-9._-]", "_", ssid)[:50]
    return f"{STATION_CONNECTION_PREFIX}{safe}"


# ── Status ───────────────────────────────────────────────────────────────


def is_station_connected() -> bool:
    """True iff wlan0 is in `connected` state with an IPv4 address."""
    rc, out, _ = _run(
        [
            "nmcli",
            "-t",
            "-f",
            "GENERAL.STATE,IP4.ADDRESS",
            "device",
            "show",
            WIFI_INTERFACE,
        ],
        NMCLI_TIMEOUT_FAST,
    )
    if rc != 0:
        return False
    has_state = False
    has_ipv4 = False
    for line in out.splitlines():
        # Lines look like: GENERAL.STATE:100 (connected)
        # or:               IP4.ADDRESS[1]:192.168.50.152/24
        if line.startswith("GENERAL.STATE:") and "(connected)" in line:
            has_state = True
        if line.startswith("IP4.ADDRESS"):
            has_ipv4 = True
    return has_state and has_ipv4


def _current_wifi_connection() -> Optional[str]:
    """Active `nmcli` connection name on wlan0, if any."""
    rc, out, _ = _run(
        ["nmcli", "-t", "-f", "GENERAL.CONNECTION", "device", "show", WIFI_INTERFACE],
        NMCLI_TIMEOUT_FAST,
    )
    if rc != 0:
        return None
    for line in out.splitlines():
        if line.startswith("GENERAL.CONNECTION:"):
            value = line.split(":", 1)[1].strip()
            return value if value and value != "--" else None
    return None


def _current_wlan_ipv4() -> Optional[str]:
    rc, out, _ = _run(
        ["nmcli", "-t", "-f", "IP4.ADDRESS", "device", "show", WIFI_INTERFACE],
        NMCLI_TIMEOUT_FAST,
    )
    if rc != 0:
        return None
    for line in out.splitlines():
        if line.startswith("IP4.ADDRESS"):
            # IP4.ADDRESS[1]:192.168.50.152/24
            try:
                cidr = line.split(":", 1)[1].strip()
                return cidr.split("/")[0] or None
            except IndexError:
                return None
    return None


def _connection_ssid(conn_name: str) -> Optional[str]:
    """Read the SSID configured on an NM connection profile."""
    rc, out, _ = _run(
        [
            "nmcli",
            "-t",
            "-s",  # show secrets / hidden — safe here, we don't print psk
            "-f",
            "802-11-wireless.ssid",
            "connection",
            "show",
            conn_name,
        ],
        NMCLI_TIMEOUT_FAST,
    )
    if rc != 0:
        return None
    for line in out.splitlines():
        if line.startswith("802-11-wireless.ssid:"):
            return line.split(":", 1)[1].strip() or None
    return None


def is_ap_active() -> bool:
    """True iff the calypso-ap connection is currently up on wlan0."""
    conn = _current_wifi_connection()
    return conn == AP_CONNECTION_NAME


Mode = Literal["station", "setup_ap", "starting"]


def current_mode() -> Mode:
    if is_ap_active():
        return "setup_ap"
    if is_station_connected():
        return "station"
    return "starting"


# ── Last-join + last-scan persistence ────────────────────────────────────


def _ensure_state_dir() -> None:
    try:
        STATE_DIR.mkdir(parents=True, exist_ok=True)
    except PermissionError:
        # Fall through — the API will surface a clean error if writes fail.
        pass


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


@dataclass
class LastJoinAttempt:
    ssid: str
    ts: str
    result: Literal["success", "auth_failed", "ssid_not_found", "timeout", "error"]
    error_detail: Optional[str] = None


def write_last_join(attempt: LastJoinAttempt) -> None:
    _ensure_state_dir()
    try:
        LAST_JOIN_FILE.write_text(json.dumps(asdict(attempt)))
    except OSError as e:
        print(f"[bosun_network_apply] could not persist last-join: {e}")


def read_last_join() -> Optional[dict]:
    try:
        return json.loads(LAST_JOIN_FILE.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def persist_scan(networks: list[dict]) -> None:
    _ensure_state_dir()
    payload = {"ts": _now_iso(), "networks": networks}
    try:
        LAST_SCAN_FILE.write_text(json.dumps(payload))
    except OSError as e:
        print(f"[bosun_network_apply] could not persist scan: {e}")


def read_last_scan() -> Optional[dict]:
    try:
        return json.loads(LAST_SCAN_FILE.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return None


# ── Status assembly ──────────────────────────────────────────────────────


def get_status() -> dict:
    mode = current_mode()
    station_conn = _current_wifi_connection() if mode == "station" else None
    station_ssid = _connection_ssid(station_conn) if station_conn else None
    return {
        "mode": mode,
        "station_ssid": station_ssid,
        "station_ip": _current_wlan_ipv4() if mode == "station" else None,
        "ap_ssid": ap_ssid() if mode == "setup_ap" else None,
        "uptime_seconds": _uptime_seconds(),
        "last_join_attempt": read_last_join(),
    }


# ── Scan ─────────────────────────────────────────────────────────────────


_SECURITY_MAP_TABLE: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"^$"), "open"),
    (re.compile(r"WPA3", re.I), "wpa3"),
    (re.compile(r"802\.1X", re.I), "enterprise"),
    (re.compile(r"WPA2", re.I), "wpa2"),
    (re.compile(r"WPA1", re.I), "wpa"),
    (re.compile(r"WPA", re.I), "wpa"),
    (re.compile(r"WEP", re.I), "wep"),
]


def _normalize_security(raw: str) -> str:
    s = raw.strip()
    for pat, label in _SECURITY_MAP_TABLE:
        if pat.search(s):
            return label
    # Fallback for unknown — surface as wpa2 since that's the modal config
    return "wpa2"


def scan_networks(rescan: bool = True) -> list[dict]:
    """Return a list of nearby networks, sorted by signal descending and de-duped by SSID.

    Filters out the Pi's own AP and hidden (no-SSID) entries.
    """
    rescan_arg = "auto" if rescan else "no"
    rc, out, err = _run(
        [
            "nmcli",
            "-t",
            "-f",
            "SSID,SIGNAL,SECURITY,CHAN",
            "device",
            "wifi",
            "list",
            "--rescan",
            rescan_arg,
        ],
        NMCLI_TIMEOUT_SCAN,
    )
    if rc != 0:
        raise RuntimeError(f"nmcli wifi list failed (rc={rc}): {err.strip()}")

    seen: dict[str, dict] = {}
    own_prefix = AP_SSID_PREFIX
    for line in out.splitlines():
        if not line:
            continue
        fields = _split_nmcli_terse(line)
        if len(fields) < 4:
            continue
        ssid = fields[0]
        if not ssid:  # hidden
            continue
        if ssid.startswith(own_prefix):
            continue
        try:
            signal_pct = int(fields[1] or "0")
        except ValueError:
            signal_pct = 0
        # nmcli reports signal as 0-100 percent. Convert back to a coarse
        # dBm (matches the spec) using the standard Linux WPA-supplicant
        # mapping: dBm = (percent / 2) - 100. Lossy but iOS just uses it
        # for the bars, which is also a coarse bucket.
        signal_dbm = int(signal_pct / 2) - 100
        security = _normalize_security(fields[2])
        try:
            channel = int(fields[3] or "0")
        except ValueError:
            channel = 0
        # De-dupe by SSID — keep the strongest signal (multi-AP networks)
        existing = seen.get(ssid)
        if existing is None or signal_dbm > existing["signal_dbm"]:
            seen[ssid] = {
                "ssid": ssid,
                "signal_dbm": signal_dbm,
                "security": security,
                "channel": channel,
            }
    return sorted(seen.values(), key=lambda n: n["signal_dbm"], reverse=True)


def scan_for_endpoint() -> list[dict]:
    """Scan path used by /api/network/scan.

    Behaviour depends on current mode:
      - Station mode: live `nmcli wifi list --rescan auto`. Cache the
        result for future AP-mode reads.
      - AP mode: cannot rescan (single radio). Return last cached scan,
        which the boot script populated before bringing up the AP. If no
        cache exists, raise — the iOS UI will show "no networks visible".
    """
    if not is_ap_active():
        nets = scan_networks(rescan=True)
        persist_scan(nets)
        return nets

    cached = read_last_scan()
    if cached is None:
        raise RuntimeError(
            "scan unavailable in AP mode — pre-AP cache is empty. "
            "Restart the Pi to refresh."
        )
    return cached.get("networks", [])


# ── AP mode bring-up / tear-down ─────────────────────────────────────────


def _connection_exists(name: str) -> bool:
    rc, out, _ = _run(["nmcli", "-t", "-f", "NAME", "connection", "show"], NMCLI_TIMEOUT_FAST)
    if rc != 0:
        return False
    for line in out.splitlines():
        if _split_nmcli_terse(line)[0] == name:
            return True
    return False


def _delete_connection(name: str) -> None:
    if _connection_exists(name):
        _run(["nmcli", "connection", "delete", name], NMCLI_TIMEOUT_FAST)


def bring_up_ap() -> None:
    """Idempotently bring up the Calypso-Setup-XXXX hotspot on wlan0.

    Tears down any previous instance first so the SSID always reflects
    the current MAC suffix (matters if wlan0 was hot-swapped — rare but
    cheap to defend against).
    """
    _delete_connection(AP_CONNECTION_NAME)
    ssid = ap_ssid()
    rc, _, err = _run(
        [
            "nmcli",
            "connection",
            "add",
            "type",
            "wifi",
            "ifname",
            WIFI_INTERFACE,
            "con-name",
            AP_CONNECTION_NAME,
            "ssid",
            ssid,
            "autoconnect",
            "no",
            "802-11-wireless.mode",
            "ap",
            "802-11-wireless.band",
            AP_BAND,
            "802-11-wireless.channel",
            str(AP_CHANNEL),
            "ipv4.method",
            "shared",
            "ipv4.addresses",
            AP_IPV4_ADDRESS,
            "wifi-sec.key-mgmt",
            "wpa-psk",
            "wifi-sec.psk",
            AP_PASSWORD,
        ],
        NMCLI_TIMEOUT_CONNECT,
    )
    if rc != 0:
        raise RuntimeError(f"failed to add AP connection: {err.strip()}")
    rc, _, err = _run(
        ["nmcli", "connection", "up", AP_CONNECTION_NAME],
        NMCLI_TIMEOUT_CONNECT,
    )
    if rc != 0:
        raise RuntimeError(f"failed to bring up AP: {err.strip()}")


def tear_down_ap() -> None:
    """Bring the AP connection down; safe if it's already inactive."""
    _run(["nmcli", "connection", "down", AP_CONNECTION_NAME], NMCLI_TIMEOUT_FAST)


# ── Station-mode configure (the load-bearing /configure path) ────────────


# Module-level lock so we never run two `nmcli c up` in parallel — the
# spec requires HTTP 409 in that case.
_join_lock = threading.Lock()
_join_in_flight = False


def _join_async(ssid: str, password: str, security: str, tear_down_on_success: bool) -> None:
    """Background thread: write the config, attempt the join, persist outcome.

    Side effects:
      - May tear down `calypso-ap` on success (per `tear_down_on_success`).
      - Persists outcome to `last-join.json`.
    """
    global _join_in_flight
    conn_name = _station_connection_name(ssid)

    try:
        # Always start clean — the user may be retrying after a wrong-
        # password attempt and we want to overwrite the saved psk.
        _delete_connection(conn_name)

        # Build add-args — `open` networks must NOT set wifi-sec.*
        add_args = [
            "nmcli",
            "connection",
            "add",
            "type",
            "wifi",
            "ifname",
            WIFI_INTERFACE,
            "con-name",
            conn_name,
            "ssid",
            ssid,
            "autoconnect",
            "yes",
            "connection.autoconnect-priority",
            str(STATION_AUTOCONNECT_PRIORITY),
        ]
        if security != "open":
            add_args += [
                "wifi-sec.key-mgmt",
                "wpa-psk" if security in ("wpa", "wpa2", "wpa3") else "wpa-psk",
                "wifi-sec.psk",
                password,
            ]
        rc, _, err = _run(add_args, NMCLI_TIMEOUT_CONNECT)
        if rc != 0:
            write_last_join(LastJoinAttempt(ssid=ssid, ts=_now_iso(), result="error", error_detail=err.strip()))
            return

        # Tear down the AP first if it's up — single radio, can't AP and
        # station simultaneously. We tear down before bringing up the
        # station so the radio is free; if the join fails we'll bring AP
        # back up.
        ap_was_up = is_ap_active()
        if ap_was_up:
            tear_down_ap()

        rc, out, err = _run(
            ["nmcli", "connection", "up", conn_name],
            NMCLI_TIMEOUT_CONNECT,
        )
        if rc == 0 and is_station_connected():
            write_last_join(LastJoinAttempt(ssid=ssid, ts=_now_iso(), result="success"))
            # Cleanup: leave calypso-ap config in place (so we can fall
            # back to AP mode on next boot if station fails), but tear it
            # down NOW since the spec requires the AP be gone within 5s.
            if tear_down_on_success:
                tear_down_ap()
            return

        # Failed — categorise from nmcli stderr. Patterns drawn from
        # NetworkManager's `src/core/nm-active-connection.c` reason codes
        # surfaced through `nmcli connection up`. The order matters: the
        # auth-failure check has to come before the catch-all because
        # NM's auth message also mentions "Wi-Fi".
        msg = (err or out or "").strip()
        lower = msg.lower()
        result: Literal["auth_failed", "ssid_not_found", "timeout", "error"]
        if (
            "secrets were required" in lower
            or "(7)" in msg  # NM_DEVICE_STATE_REASON_NO_SECRETS
            or "(34)" in msg  # NM_DEVICE_STATE_REASON_SUPPLICANT_FAILED
            or "psk" in lower
            or "passphrase" in lower
            or "authentication" in lower
            or "incorrect" in lower
        ):
            result = "auth_failed"
        elif (
            "wi-fi network could not be found" in lower
            or "network with ssid" in lower
            or "no suitable network" in lower
            or "not visible" in lower
            or "(53)" in msg  # NM_DEVICE_STATE_REASON_SSID_NOT_FOUND
        ):
            result = "ssid_not_found"
        elif "timeout" in lower or "timed out" in lower or "(6)" in msg:
            result = "timeout"
        else:
            result = "error"
        write_last_join(LastJoinAttempt(ssid=ssid, ts=_now_iso(), result=result, error_detail=msg[:300] or None))

        # On failure, drop the dead connection so a retry isn't littered
        # by half-broken `calypso-station-*` entries in `nmcli c show`.
        # Keep on success — the activated connection IS the saved
        # autoconnect state we want for next boot.
        try:
            _delete_connection(conn_name)
        except Exception as e:
            print(f"[bosun_network_apply] failed to clean up dead conn {conn_name}: {e}")

        # Failure → bring the AP back up so the user can retry from the wizard.
        if ap_was_up:
            try:
                bring_up_ap()
            except Exception as e:
                print(f"[bosun_network_apply] failed to restore AP after failed join: {e}")
    finally:
        with _join_lock:
            _join_in_flight = False


def configure_station(ssid: str, password: str, security: str, tear_down_ap_on_success: bool) -> int:
    """Kick off an async join attempt. Returns the expected settle time (seconds).

    Raises RuntimeError if a join is already in flight (HTTP 409 case).
    """
    global _join_in_flight
    with _join_lock:
        if _join_in_flight:
            raise RuntimeError("join already in progress")
        _join_in_flight = True

    # Optimistic: clear last-join so iOS doesn't see a stale outcome
    write_last_join(LastJoinAttempt(ssid=ssid, ts=_now_iso(), result="timeout", error_detail="in_flight"))

    t = threading.Thread(
        target=_join_async,
        args=(ssid, password, security, tear_down_ap_on_success),
        name="calypso-join",
        daemon=True,
    )
    t.start()
    return 12  # ballpark seconds — covers ssid scan + 4-way handshake + DHCP


__all__ = [
    "AP_SSID_PREFIX",
    "AP_PASSWORD",
    "ap_ssid",
    "is_station_connected",
    "is_ap_active",
    "current_mode",
    "get_status",
    "scan_networks",
    "scan_for_endpoint",
    "persist_scan",
    "bring_up_ap",
    "tear_down_ap",
    "configure_station",
]
