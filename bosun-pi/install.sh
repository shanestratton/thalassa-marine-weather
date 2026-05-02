#!/bin/bash
# install.sh — install the bosun network-setup pieces onto a Pi.
#
# Run this AS SKIPPER on the Pi after `scp -r bosun-pi skipper@bosun:/tmp/`.
# It will sudo for the bits that need root.
#
# Idempotent — safe to re-run.

set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BOSUN_DIR=/mnt/nvme/bosun

echo "[install] src: $SRC"
echo "[install] bosun dir: $BOSUN_DIR"

# 1. Python modules into the bosun service dir.
# These need to be owned by `skipper` so subsequent `scp` from a dev
# machine works without re-elevating. The whole script is intended to
# be run with `sudo`, so explicitly install as skipper.
echo "[install] copying python modules…"
install -m 644 -o skipper -g skipper "$SRC/bosun_network_apply.py" "$BOSUN_DIR/bosun_network_apply.py"
install -m 644 -o skipper -g skipper "$SRC/bosun_network_api.py" "$BOSUN_DIR/bosun_network_api.py"

# 2. Boot script — needs root for /usr/local/bin
echo "[install] installing boot decision script…"
sudo install -m 755 "$SRC/calypso-network-decide" /usr/local/bin/calypso-network-decide

# 3. Polkit rule for nmcli without password prompts
echo "[install] installing polkit rule…"
sudo install -m 644 "$SRC/50-bosun-network.rules" /etc/polkit-1/rules.d/50-bosun-network.rules

# 4. Systemd unit for the boot decision
echo "[install] installing systemd unit…"
sudo install -m 644 "$SRC/calypso-network-decide.service" /etc/systemd/system/calypso-network-decide.service

# 5. State directory writable by skipper
echo "[install] ensuring state dir exists and is writable by skipper…"
sudo install -d -m 755 -o skipper -g skipper /var/lib/calypso

# 6. Reload systemd + enable the boot decision unit
echo "[install] reloading systemd…"
sudo systemctl daemon-reload
sudo systemctl enable calypso-network-decide.service

echo
echo "[install] DONE."
echo
echo "Next steps:"
echo "  1. Edit $BOSUN_DIR/bosun_web.py to register the network blueprint:"
echo "       from bosun_network_api import network_bp"
echo "       app.register_blueprint(network_bp)"
echo "  2. sudo systemctl restart bosun-web"
echo "  3. Smoke-test: curl -s http://localhost:5000/api/network/status | jq ."
echo "  4. Reboot to exercise calypso-network-decide.service end-to-end."
