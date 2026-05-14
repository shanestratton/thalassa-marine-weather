#!/bin/bash
# install-voyage-ping.sh — install the hourly Voyage Log telemetry ping
# onto a Pi.
#
# Run AS SKIPPER on the Pi after `scp -r bosun-pi skipper@bosun:/tmp/`.
# It sudo's for the bits that need root.
#
# Idempotent — safe to re-run.

set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BOSUN_DIR=/mnt/nvme/bosun
ENV_FILE="$BOSUN_DIR/voyage-ping.env"

echo "[install-voyage-ping] src: $SRC"
echo "[install-voyage-ping] bosun dir: $BOSUN_DIR"

# 1. Python script into the bosun service dir (owned by skipper).
echo "[install-voyage-ping] copying python script…"
install -m 644 -o skipper -g skipper "$SRC/bosun_voyage_ping.py" "$BOSUN_DIR/bosun_voyage_ping.py"

# 2. Config file — copy the template on first install only; never clobber
#    a populated env file on re-run.
if [ -f "$ENV_FILE" ]; then
    echo "[install-voyage-ping] $ENV_FILE already exists — leaving it untouched"
else
    echo "[install-voyage-ping] seeding $ENV_FILE from the example…"
    install -m 600 -o skipper -g skipper "$SRC/voyage-ping.env.example" "$ENV_FILE"
    echo "[install-voyage-ping]   ⚠  edit $ENV_FILE and fill in the keys before enabling the timer"
fi

# 3. State directory writable by skipper (shared with the calypso units).
echo "[install-voyage-ping] ensuring state dir exists…"
sudo install -d -m 755 -o skipper -g skipper /var/lib/calypso

# 4. systemd service + timer.
echo "[install-voyage-ping] installing systemd units…"
sudo install -m 644 "$SRC/bosun-voyage-ping.service" /etc/systemd/system/bosun-voyage-ping.service
sudo install -m 644 "$SRC/bosun-voyage-ping.timer" /etc/systemd/system/bosun-voyage-ping.timer

# 5. Reload systemd + enable the timer (not the service — the timer
#    triggers it hourly).
echo "[install-voyage-ping] reloading systemd + enabling the timer…"
sudo systemctl daemon-reload
sudo systemctl enable --now bosun-voyage-ping.timer

echo
echo "[install-voyage-ping] DONE."
echo
echo "Next steps:"
echo "  1. Fill in the keys:    sudo -u skipper nano $ENV_FILE"
echo "  2. Smoke-test a ping:   sudo systemctl start bosun-voyage-ping.service"
echo "  3. Watch the log:       journalctl -u bosun-voyage-ping.service -n 20 --no-pager"
echo "  4. Check the schedule:  systemctl list-timers bosun-voyage-ping.timer"
