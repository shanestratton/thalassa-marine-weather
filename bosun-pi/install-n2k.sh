#!/bin/bash
# install-n2k.sh — set up the PiCAN-M / NMEA 2000 ingest stack on a fresh Pi.
#
# Run from the Pi (or via `ssh -t bosun "sudo bash /tmp/bosun-pi/install-n2k.sh"`).
# Idempotent — safe to re-run; will skip steps that are already done.
#
# Companion to bosun-pi/n2k-setup.md.

set -euo pipefail

CONFIG_TXT=/boot/firmware/config.txt
[ -f "$CONFIG_TXT" ] || CONFIG_TXT=/boot/config.txt
SYSTEMD_UNIT=/etc/systemd/system/can0-up.service

echo "[install-n2k] config.txt: $CONFIG_TXT"

# 1. Enable SPI + load mcp2515 overlay for the PiCAN-M Hat.
need_reboot=0
if ! grep -qE '^dtparam=spi=on' "$CONFIG_TXT"; then
    echo "[install-n2k] enabling SPI in $CONFIG_TXT"
    echo 'dtparam=spi=on' >> "$CONFIG_TXT"
    need_reboot=1
fi
if ! grep -qE '^dtoverlay=mcp2515-can0' "$CONFIG_TXT"; then
    echo "[install-n2k] adding mcp2515-can0 overlay"
    echo 'dtoverlay=mcp2515-can0,oscillator=16000000,interrupt=25,spimaxfrequency=2000000' >> "$CONFIG_TXT"
    need_reboot=1
fi
if ! grep -qE '^dtoverlay=spi-bcm2835-overlay' "$CONFIG_TXT"; then
    echo "[install-n2k] adding spi-bcm2835 overlay"
    echo 'dtoverlay=spi-bcm2835-overlay' >> "$CONFIG_TXT"
    need_reboot=1
fi

# 2. Systemd unit to bring can0 up at 250kbps on boot.
if [ ! -f "$SYSTEMD_UNIT" ]; then
    echo "[install-n2k] writing $SYSTEMD_UNIT"
    cat > "$SYSTEMD_UNIT" <<'EOF'
[Unit]
Description=Bring up can0 for NMEA 2000 (PiCAN-M Hat, 250kbps)
After=network-pre.target
Wants=network-pre.target

[Service]
Type=oneshot
ExecStart=/sbin/ip link set can0 up type can bitrate 250000
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload
    systemctl enable can0-up.service
fi

# 3. can-utils for diagnostics (candump, cansniffer, etc.)
if ! dpkg -l can-utils >/dev/null 2>&1; then
    echo "[install-n2k] installing can-utils"
    apt-get update -qq
    apt-get install -y can-utils
fi

# 4. If we already have a running kernel with SPI + mcp251x loaded, bring
#    can0 up immediately so we don't need to reboot to test on the bench.
if [ "$need_reboot" -eq 0 ] && lsmod | grep -q '^mcp251x'; then
    if ! ip -br link show can0 2>/dev/null | grep -q UP; then
        echo "[install-n2k] bringing can0 up now"
        systemctl start can0-up.service || true
    fi
fi

echo
echo "[install-n2k] DONE."
echo
if [ "$need_reboot" -eq 1 ]; then
    echo "REBOOT REQUIRED — config.txt was modified."
    echo "    sudo reboot"
    echo
fi
echo "Verify with:"
echo "    ip -d link show can0           # expect 'state UP' + 'bitrate 250000'"
echo "    candump can0                   # expect frames if backbone is connected"
echo "    curl -s http://localhost:5000/api/n2k/status | jq ."
