# Bosun Pi Network Setup API — Contract for the iPhone Provisioning Flow

**Status:** Spec only — not yet implemented on either side.
**Last updated:** 2026-05-02
**From:** Claude A (Thalassa-side)
**For:** Claude B (Pi-side)
**Companion docs:** [BOSUN_HAIKU_ARCHITECTURE.md](./BOSUN_HAIKU_ARCHITECTURE.md), [BOSUN_TOOL_API.md](./BOSUN_TOOL_API.md)

This doc specifies the Pi-side behaviour Thalassa needs to provision a freshly-shipped Pi onto the skipper's boat WiFi without SSH, terminal, or any technical setup. Same operational pattern Sonos / Hue / Ring use: Pi boots into its own access point, phone connects, web form takes credentials, Pi joins the user's network.

The iOS side handles the hotspot-join + the setup wizard UI and entitlement. The Pi side owns: AP-mode boot fallback, the setup HTTP endpoints, network-config persistence, and the swap-back-to-station-mode logic.

---

## TL;DR

When Pi has no working WiFi:

1. Bring up open-with-password AP `Calypso-Setup-XXXX` (XXXX = last 4 of `wlan0` MAC).
2. Serve a small HTTP API on `http://10.0.0.1:5000` (same Flask process as `bosun_web.py`, just bound to the AP interface too).
3. iPhone joins the AP, hits `/api/network/scan` → user picks SSID → `POST /api/network/configure` with credentials.
4. Pi writes config, attempts to join, on success tears down the AP. On failure, returns to setup mode and surfaces the error.

Three new endpoints, one boot-time decision, one network-stack-dependent config file.

---

## State machine

```
                           ┌─────────────┐
              boot ───────▶│ STATION     │  (try saved WiFi)
                           │  attempting │
                           └──────┬──────┘
                                  │
                           ┌──────┴──────┐
                           ▼             ▼
                       success         failure
                           │             │
                           ▼             ▼
                    ┌──────────┐  ┌──────────┐
                    │ STATION  │  │ SETUP    │ (AP up, /api/network/* live)
                    │  joined  │  │  AP-mode │
                    └────┬─────┘  └────┬─────┘
                         │             │
                  WiFi drops          configure POST → restart
                         │             │
                         └─────────────┘
                                  │
                                  ▼
                           (loop back to top)
```

**Hard requirements:**

- Pi MUST attempt station mode first on every boot. AP mode is a fallback, never the default.
- If station mode connects but loses internet later, Pi should NOT immediately drop to AP mode (boat marinas are flaky) — only fall back if station mode fails entirely for >60s consecutively.
- If `configure` POST succeeds (Pi joins user's WiFi), the AP MUST tear down within 5s of confirmed station-mode connection so the iPhone can re-discover the Pi via the existing `BoatNetworkService` scan.
- If `configure` POST fails (wrong password, target SSID out of range), the AP MUST stay up so the user can retry.

---

## Access-point details

### SSID

```
Calypso-Setup-XXXX
```

`XXXX` = uppercase hex, last 4 chars of `wlan0` MAC. Stable across reboots so the iOS entitlement can use a prefix match.

**Why this matters for iOS:** `NEHotspotConfiguration` joins WiFi networks programmatically only with prefix-matched SSIDs the app declares in its entitlement. The iOS app will ship with `com.apple.developer.networking.HotspotConfiguration` whitelisting the `Calypso-Setup-` prefix. **The "Calypso-Setup-" string is therefore load-bearing — don't bikeshed it without coordinating.**

### Password

```
calypso-setup
```

Hardcoded default, printed on a sticker on the Pi enclosure. Open WiFi was tempting for UX but a passworded AP is a smaller attack surface during the setup window. Skipper enters once into iOS WiFi prompt; iOS remembers it.

If we ever want per-Pi passwords later, we can derive from MAC, but for v1 the static one is fine.

### IP

```
AP IP:        10.0.0.1
DHCP range:   10.0.0.10 – 10.0.0.50
DNS:          self (10.0.0.1) — captive-portal trick keeps phones from
              dropping the network when iOS pings gstatic.com etc.
```

Standard `hostapd` + `dnsmasq` config. The Flask app on `:5000` should bind both `0.0.0.0:5000` (so it's reachable from station-mode AND AP-mode) — no separate process needed.

### Captive portal hint

Optionally serve `HTTP 302` to `http://10.0.0.1:5000/setup` when the phone hits the captive-detection URLs (`captive.apple.com`, `connectivitycheck.gstatic.com` etc.). iOS will then auto-popup the setup page in its captive-portal mini-browser. Nice-to-have, not required — the iOS app can also drive the flow from inside Thalassa.

---

## Endpoint contract

All three endpoints live on the existing Flask app (`bosun_web.py`), under a new `network` blueprint. Same envelope shape as `/tool/*` — `{value, source, timestamp, error, latency_ms}` — for consistency.

### `GET /api/network/status`

Returns the Pi's current network state. Read regularly by the iOS app to confirm "Pi has joined the boat WiFi" after a configure POST.

```json
{
  "value": {
    "mode": "station" | "setup_ap" | "starting",
    "station_ssid": "MyBoatWiFi" | null,
    "station_ip": "192.168.50.150" | null,
    "ap_ssid": "Calypso-Setup-A3F2" | null,
    "uptime_seconds": 1247,
    "last_join_attempt": {
      "ssid": "MyBoatWiFi",
      "ts": "2026-05-02T03:14:07+00:00",
      "result": "success" | "auth_failed" | "ssid_not_found" | "timeout",
      "error_detail": null | "wpa_supplicant: 4-way handshake failed"
    } | null
  },
  "source": "bosun.network",
  "timestamp": "...",
  "error": null,
  "latency_ms": 8
}
```

The `last_join_attempt` field is the load-bearing one — iOS reads it to give the skipper a clean error message ("That password didn't work, try again").

### `GET /api/network/scan`

Returns a list of WiFi networks the Pi can currently see. Triggered by user tapping "Refresh networks" in the iOS setup wizard.

```json
{
    "value": [
        {
            "ssid": "MyBoatWiFi",
            "signal_dbm": -52,
            "security": "wpa2",
            "channel": 6
        },
        {
            "ssid": "Marina-Free-WiFi",
            "signal_dbm": -71,
            "security": "open",
            "channel": 11
        }
    ],
    "source": "iw_dev_scan",
    "timestamp": "...",
    "error": null,
    "latency_ms": 2300
}
```

**Notes:**

- Sort by `signal_dbm` descending (strongest first).
- De-duplicate by SSID (multi-AP networks show one entry).
- Skip the Pi's own AP (`Calypso-Setup-*`).
- Skip hidden networks (no SSID); we'll add a "manual entry" path later if anyone needs it.
- `security` is a coarse enum: `open`, `wep`, `wpa`, `wpa2`, `wpa3`, `enterprise`. iOS uses this to gate the password field — `enterprise` should be greyed out with "Not supported yet" for v1; `open` should hide the password input.
- Scan can be slow (~1-3s on a quiet 2.4GHz band, longer if dual-band). Iphone shows a spinner. Don't block other Flask routes during the scan — use a thread.

### `POST /api/network/configure`

Sets the WiFi credentials and triggers a join attempt. iOS calls this once the user has filled in SSID + password.

```json
POST /api/network/configure
{
  "ssid": "MyBoatWiFi",
  "password": "redacted-12chars",
  "security": "wpa2",
  "tear_down_ap_on_success": true
}
```

`tear_down_ap_on_success` defaults to `true` — only false in dev/debug if Claude B wants to keep the AP up while testing.

Response:

```json
{
    "value": {
        "accepted": true,
        "next_state": "station_attempting",
        "expected_settle_time_seconds": 12
    },
    "source": "bosun.network",
    "timestamp": "...",
    "error": null,
    "latency_ms": 4
}
```

Important: this endpoint **returns immediately after writing the config and starting the join attempt** — it does NOT block until the join completes. iOS polls `/api/network/status` afterwards for the actual outcome (or rejoins the boat WiFi and re-discovers the Pi via `BoatNetworkService`, whichever is faster).

**Failure modes the endpoint should handle:**

- Missing/empty `ssid` → HTTP 400, error `"ssid required"`.
- `security` doesn't match what the Pi sees on scan → log warning, attempt anyway (user might be configuring against a soon-to-appear network).
- Pi's wpa_supplicant rejects the config write (filesystem read-only, etc.) → HTTP 500.
- Already in setup-mode but join already in flight → HTTP 409 with `"join already in progress"` so iOS doesn't double-fire.

---

## Network-stack detection

Bookworm Pi OS uses NetworkManager. Bullseye and earlier use `dhcpcd` + `wpa_supplicant`. The setup logic on the Pi must work with whichever Claude B is running.

**Recommended:** detect once at boot and dispatch:

```python
# bosun_network.py (sketch)
import shutil
def network_backend() -> Literal["nm", "wpa_supplicant"]:
    if shutil.which("nmcli"):
        return "nm"
    return "wpa_supplicant"
```

Then `apply_config(ssid, password, security)` branches on that.

NetworkManager makes the AP/station swap one-liner per side (`nmcli c up Calypso-Setup`, `nmcli c up MyBoatWiFi`). `wpa_supplicant` requires editing `/etc/wpa_supplicant/wpa_supplicant.conf` and `wpa_cli reconfigure`.

Either is fine — pick what's already on the Pi B is testing on, and we can backport to the other later if a customer Pi runs the other stack.

---

## systemd boot decision

The boot-time "should I be in setup mode or station mode?" decision lives in a small systemd unit:

```
/etc/systemd/system/calypso-network-decide.service
  ExecStart: /usr/local/bin/calypso-network-decide
  After: network-pre.target
  Before: bosun-web.service
```

`calypso-network-decide` script logic:

```
if has_saved_wifi() and try_join_with_timeout(60s):
    log "joined station: $ssid"
    exit 0   # Flask starts, station mode
else:
    log "no station, entering AP mode"
    bring_up_ap()
    exit 0   # Flask starts, AP mode
```

The `bosun_web.py` Flask app doesn't need to know which mode it's in — the same `/api/network/*` endpoints are served either way, and `/tool/*` works in both (though `get_vessel_state` etc. will return null+error in setup mode because SignalK isn't connected).

---

## Sealed-appliance principle

Per the architecture doc and feedback memory, **no SSH access for end-customers**. The setup AP is the only configuration surface. Implications for B:

- The hardcoded AP password (`calypso-setup`) lives in the firmware image, not a config file the user can edit.
- If a customer's WiFi password changes, the failsafe is "wait 60s for station-mode failure → AP comes up → reconfigure via phone". They never need to touch the Pi.
- Root access on the Pi is for B + future maintainers via `ssh skipper@bosun.local`. We don't expose a customer-facing `/api/network/wipe` or similar — too easy to brick.

---

## Open decisions

1. **AP password derivation.** Hardcoded `calypso-setup` for v1. If we ever want per-unit randomized passwords (printed on a per-Pi sticker like routers do), the firmware can derive from `wlan0` MAC at first boot. Trade-off: better security vs. customer-support-asks-for-password headache. **Recommendation: hardcoded for v1.**

2. **Captive-portal redirects.** Nice-to-have for the case where the user joins the AP from outside the Thalassa app. Not required if we drive the flow from inside the app via `NEHotspotConfiguration`. **Recommendation: skip for v1, add later if a beta customer asks.**

3. **`/api/network/forget` endpoint.** Equivalent of "factory reset network config". Useful for "punter sells the boat, new owner needs fresh setup". Triggered from inside the Thalassa app after auth check. **Recommendation: defer to v2.**

4. **Multi-network priority.** wpa_supplicant supports `priority=N` for multiple known networks (boat WiFi, dock WiFi, home WiFi). If we ever want "Pi auto-roams between marina networks", this is how. **Recommendation: defer; v1 is single-network.**

5. **Ethernet fallback.** If the user has an Ethernet cable plugged in and `wlan0` is misconfigured, should we still go into AP mode on `wlan0`? Probably yes — the AP mode lets them fix it from their phone even though the Pi has internet via eth0. **Recommendation: yes, AP-on-wlan0 even when eth0 is up.**

---

## Sanity-test script for B

```bash
PI=192.168.50.150  # in station mode
# OR
PI=10.0.0.1        # in AP mode

H="Content-Type: application/json"

# Status check (works in either mode)
curl -s http://$PI:5000/api/network/status | jq .

# Scan for nearby networks (slow — ~1-3s)
curl -s http://$PI:5000/api/network/scan | jq '.value | map(.ssid)'

# Configure (only meaningful in AP mode)
curl -s -X POST http://10.0.0.1:5000/api/network/configure -H "$H" \
  -d '{"ssid":"MyBoatWiFi","password":"hunter2","security":"wpa2"}' | jq .

# Watch for the join outcome
while true; do
  curl -s http://10.0.0.1:5000/api/network/status \
    | jq '.value | {mode, last_join_attempt}'
  sleep 2
done
```

In AP mode, the scan should show `MyBoatWiFi` if it's nearby. After configure, `mode` should flip to `station_attempting`, then `station` (success) or back to `setup_ap` with `last_join_attempt.result` populated (failure).

---

## What the iOS side will do

For coordination, here's the flow Thalassa will run against the contract above:

1. Detect "no Pi found" via existing `BoatNetworkService` scan.
2. Show "Set up new Pi" CTA in Settings.
3. Walk skipper through powering on the Pi, then "Tap Connect" → uses `NEHotspotConfiguration` to auto-join `Calypso-Setup-*`.
4. Once connected to the AP, GET `/api/network/scan`, render the SSID list.
5. Skipper picks SSID + types password → POST `/api/network/configure`.
6. Show "Connecting..." spinner; meanwhile iOS auto-rejoins the previous boat/home WiFi (`NEHotspotConfiguration` with `joinOnce: true` makes this clean).
7. Re-run `BoatNetworkService` discovery on the original network. Pi shows up → success. Or, fall back: poll `/api/network/status` from the LAN until `mode === 'station'`.
8. Done — Calypso pip flips to "ready".

If step 7 times out (Pi never appears), iOS rejoins the AP and reads `/api/network/status` for the failure reason, shows it to the skipper.

---

## Files of interest on the Pi (proposed)

```
/mnt/nvme/bosun/
├── bosun_web.py            (existing) — register network blueprint
├── bosun_network_api.py    NEW — /api/network/{status,scan,configure}
├── bosun_network_apply.py  NEW — wpa_supplicant + NetworkManager dispatch
└── /usr/local/bin/calypso-network-decide   NEW — boot-time mode chooser

/etc/systemd/system/
├── calypso-network-decide.service   NEW
└── calypso-ap.service               NEW — hostapd + dnsmasq for AP mode

/etc/hostapd/calypso-ap.conf         NEW
/etc/dnsmasq.d/calypso-ap.conf       NEW
```

Existing `bosun-web.service` doesn't need changes — Flask app picks up the new blueprint automatically.

---

## Coordination with the iOS side

The iOS app will be built against this contract assuming:

1. SSID prefix is **`Calypso-Setup-`** exactly (entitlement is locked to it).
2. AP IP is **`10.0.0.1`**.
3. Default AP password is **`calypso-setup`**.
4. Endpoints are **`/api/network/{status,scan,configure}`** with the envelope shapes above.

If any of those need to change, ping me before locking in the firmware image.

Once the Pi side is smoke-tested, I'll wire up the iOS setup wizard and `NEHotspotConfiguration` entitlement against this contract — same handoff pattern as `BOSUN_TOOL_API.md`.
