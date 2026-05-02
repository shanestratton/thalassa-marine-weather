# NMEA 2000 setup on Bosun Pi (PiCAN-M Hat)

What's currently configured on `bosun.local` and how to recover if the Pi is reflashed.

## Hardware

- **Copperhill PiCAN-M Pi Hat** (MCP2515 CAN controller over SPI, MCP2562 transceiver)
- Connected to a Pi 5 16GB via the Pi GPIO header
- Wires out to the boat's NMEA 2000 backbone via the M12 connector or screw terminals (pins H/L/V+/V-)

## What the kernel needs

`/boot/firmware/config.txt` (current values verified on `bosun`):

```
dtparam=spi=on
dtoverlay=mcp2515-can0,oscillator=16000000,interrupt=25,spimaxfrequency=2000000
dtoverlay=spi-bcm2835-overlay
```

The 16MHz oscillator value is the PiCAN-M hat's default; if you swap to a Copperhill PiCAN-FD or another vendor you'll need to change this. `interrupt=25` matches the PiCAN-M's GPIO25 INT pin — also vendor-specific.

After editing config.txt, reboot. Verify:

```sh
lsmod | grep -E 'mcp25|can_dev|spi'
# expected:
#   mcp251x      ...
#   can_dev      1 mcp251x
#   spi_bcm2835  ...
```

## Bringing `can0` up

The `can0` interface needs to come up at the right bitrate (250kbps for NMEA 2000). The systemd unit at `/etc/systemd/system/can0-up.service` (or whatever it's called on the box) does this on boot:

```ini
[Unit]
Description=Bring up can0 for NMEA 2000
After=network-pre.target
Wants=network-pre.target

[Service]
Type=oneshot
ExecStart=/sbin/ip link set can0 up type can bitrate 250000
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
```

Verify after boot:

```sh
ip -d link show can0
# expected:
#   3: can0: <NOARP,UP,LOWER_UP,ECHO>  state UP
#   can state ERROR-ACTIVE  bitrate 250000  sample-point 0.875
```

`ERROR-ACTIVE` = bus alive with at least one peer. `ERROR-PASSIVE` = no peers / no termination (normal on a bench Pi). `BUS-OFF` = something seriously wrong, usually a wiring fault.

## SignalK ingest config

SignalK runs as a system service (`signalk.service`) and reads `can0` via the canboatjs provider. Provider config lives in `~skipper/.signalk/settings.json`:

```json
{
    "pipedProviders": [
        {
            "id": "n2k-can0",
            "enabled": true,
            "pipeElements": [
                {
                    "type": "providers/simple",
                    "options": {
                        "type": "NMEA2000",
                        "subOptions": {
                            "type": "canbus-canboatjs",
                            "interface": "can0",
                            "filtersEnabled": true,
                            "uniqueNumber": 1621067
                        }
                    }
                }
            ]
        }
    ]
}
```

After editing settings.json, restart SignalK:

```sh
sudo systemctl restart signalk
```

`uniqueNumber` is a per-installation device ID on the N2K bus; pick anything that won't collide with the chartplotter / instruments already there. The current value is fine to keep on a reflash unless you're running two Bosun Pis on the same boat (don't).

## Verifying end-to-end

When the Pi is connected to a live backbone:

```sh
# 1. Bus is talking
ip -s link show can0    # RX bytes climbing

# 2. Frames being decoded
candump can0 | head      # raw CAN frames in/out
# (install can-utils first: sudo apt-get install can-utils)

# 3. SignalK paths populating
curl -s http://localhost:3000/signalk/v1/api/vessels/self | jq .

# 4. Bosun's tools API surfacing it
curl -s -X POST http://localhost:5000/tool/get_vessel_state \
  -H 'Content-Type: application/json' -d '{}' | jq .

# 5. Health rollup (the one Thalassa reads)
curl -s http://localhost:5000/api/n2k/status | jq .
```

The new `/api/n2k/status` endpoint surfaces a `health: red | amber | green` flag for the iOS UI:

- **red**: `can0` down or driver missing — needs Pi attention
- **amber**: `can0` up but no traffic / no SignalK paths populated (typical when not yet plugged into the backbone)
- **green**: traffic flowing AND at least one tracked SignalK path populated

## Recovery on reflash

If the Pi is reflashed and we need to re-establish N2K ingest:

1. Restore the three `dtoverlay` lines in `/boot/firmware/config.txt` and reboot.
2. Re-create the `can0-up.service` systemd unit.
3. Reinstall + configure SignalK with the canboatjs provider — settings.json snippet above.
4. `sudo apt-get install -y can-utils` for diagnostics.
5. Reinstall the bosun-pi package (which now includes `bosun_n2k_api.py`):
   `ssh -t bosun "sudo bash /tmp/bosun-pi/install.sh && sudo systemctl restart bosun-web"`.

The `install-n2k.sh` companion script automates steps 1, 2, 4 — see that file.

## What's NOT yet wired

- **Native USB-Actisense / W2K-1 BLE iOS path** — the wire-layer modules in `services/nmea2000/` (canId.ts, fastPacket.ts, actisenseAscii.ts, pgnDecoder.ts) are ready but no transport hooks them up yet. The PiCAN-M path goes through SignalK, which has its own frame parser — those iOS modules are for future direct-from-iOS reads if SignalK ever becomes a bottleneck.
- **Engine telemetry beyond RPM** — boat_state.py only pulls revolutions; oil pressure, coolant temp, alternator voltage, fuel rate are decoded by canboatjs but not yet surfaced through `/tool/get_vessel_state`. Easy follow-up when the engine instance shows up on the bus.
- **AC/DC monitoring (PGN 127505/127506/127507)** — Victron Cerbo handles this via Modbus today; if the boat's batt monitor publishes via N2K, we could consolidate.
