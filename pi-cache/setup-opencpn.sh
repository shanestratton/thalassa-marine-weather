#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# Thalassa OpenCPN + VNC setup
#
# Installs OpenCPN + a minimal desktop + TigerVNC on the Pi so we
# can run the Phase 14 spike (test whether OpenCPN's plugin API
# exposes vector chart features when o-charts is loaded).
#
#   bash setup-opencpn.sh
#
# Connection from your Mac (after this finishes) is via SSH tunnel,
# so VNC is never exposed to the network. Instructions printed at
# the end.
# ═══════════════════════════════════════════════════════════════

set -e

GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
BOLD='\033[1m'
NC='\033[0m'

echo ""
echo -e "${CYAN}${BOLD}  ⚓  OpenCPN + VNC setup${NC}"
echo -e "${CYAN}  ═════════════════════════${NC}"
echo ""

REAL_USER="${SUDO_USER:-$USER}"
if [[ "$REAL_USER" == "root" ]]; then
    REAL_USER=$(getent passwd 1000 | cut -d: -f1 || echo "skipper")
fi
REAL_HOME=$(eval echo "~${REAL_USER}")
echo -e "  Service user: ${BOLD}${REAL_USER}${NC}"

# ── Install OpenCPN + minimal desktop + VNC ──
# openbox = lightweight window manager (10MB), no full Xfce/GNOME bloat.
# xterm = needed inside the VNC session to launch opencpn.
#
# Output is captured to a log file so silent failures (which bit us
# during the Phase 13 install.sh debugging session) are visible. We
# also keep packages to a minimum core — opencpn-doc / opencpn-data
# don't exist as separate packages on Pi OS Bookworm; opencpn alone
# pulls in everything it needs.
echo -e "  Installing OpenCPN, openbox, xterm, TigerVNC..."
INSTALL_LOG="/tmp/setup-opencpn.log"
{
    apt-get update
    apt-get install -y \
        opencpn \
        tigervnc-standalone-server tigervnc-common \
        openbox xterm dbus-x11
} >"$INSTALL_LOG" 2>&1 || {
    echo -e "  ${RED}✗${NC} Install failed. Last 30 lines:"
    tail -30 "$INSTALL_LOG" | sed 's/^/    /'
    echo ""
    echo -e "  ${RED}Aborting.${NC} Full log: $INSTALL_LOG"
    exit 1
}
echo -e "  ${GREEN}✓${NC} Installed"

# ── Set up VNC config for the real user ──
sudo -u "$REAL_USER" mkdir -p "$REAL_HOME/.vnc"

# xstartup tells VNC what to launch when the session starts.
cat > "$REAL_HOME/.vnc/xstartup" <<'XSTARTUP'
#!/bin/bash
# Thalassa VNC session — minimal openbox + a launcher terminal
unset SESSION_MANAGER
unset DBUS_SESSION_BUS_ADDRESS
export XKL_XMODMAP_DISABLE=1
exec dbus-launch --exit-with-x11 openbox-session &
xsetroot -solid '#1a2330'
xterm -geometry 100x30+50+50 -bg '#0c1220' -fg '#5fc1d6' -fa 'Monospace' -fs 11 \
    -title "Thalassa — type 'opencpn' to launch" &
wait
XSTARTUP
chmod +x "$REAL_HOME/.vnc/xstartup"
chown -R "${REAL_USER}:${REAL_USER}" "$REAL_HOME/.vnc"

# ── VNC password ──
# Set a default password non-interactively via vncpasswd -f, which
# reads from stdin and writes the encoded password to stdout. The
# previous "interactive vncpasswd" approach failed under curl|sudo
# bash because stdin is the pipe, not a TTY — vncpasswd printed
# "Password not changed" and the script bailed silently.
#
# Default password is "thalassa". User can change it later with
# `vncpasswd` from a real shell. Security is fine — VNC is bound
# to localhost (see -localhost yes below), only reachable via SSH
# tunnel, so the password is mostly belt-and-braces anyway.
PASSWD_FILE="$REAL_HOME/.vnc/passwd"
DEFAULT_VNC_PASSWORD="thalassa"
if [[ ! -f "$PASSWD_FILE" ]]; then
    echo "$DEFAULT_VNC_PASSWORD" | vncpasswd -f > "$PASSWD_FILE"
    chmod 600 "$PASSWD_FILE"
    chown "${REAL_USER}:${REAL_USER}" "$PASSWD_FILE"
    echo -e "  ${GREEN}✓${NC} VNC password set to: ${BOLD}${DEFAULT_VNC_PASSWORD}${NC} (change with: vncpasswd)"
fi

# ── Firewall — VNC bound to localhost ──
# Bind to 127.0.0.1 only. This means nobody on the LAN can connect to
# VNC directly — they must SSH-tunnel first. That's the right default
# for a boat Pi: no random marina network can poke at the desktop.
LISTEN_FLAG="-localhost yes"

# ── systemd service so VNC comes up on boot ──
SERVICE_FILE="/etc/systemd/system/thalassa-vnc.service"
tee "$SERVICE_FILE" > /dev/null <<SVCEOF
[Unit]
Description=Thalassa VNC (OpenCPN session)
After=network.target

[Service]
Type=forking
User=${REAL_USER}
PAMName=login
PIDFile=${REAL_HOME}/.vnc/%H:1.pid
ExecStartPre=-/usr/bin/vncserver -kill :1 > /dev/null 2>&1
ExecStart=/usr/bin/vncserver :1 -geometry 1440x900 -depth 24 ${LISTEN_FLAG}
ExecStop=/usr/bin/vncserver -kill :1
Restart=on-failure

[Install]
WantedBy=multi-user.target
SVCEOF

systemctl daemon-reload >/dev/null 2>&1
systemctl enable thalassa-vnc >/dev/null 2>&1
systemctl restart thalassa-vnc >/dev/null 2>&1

sleep 2
if systemctl is-active --quiet thalassa-vnc; then
    echo -e "  ${GREEN}✓${NC} VNC service running"
else
    echo -e "  ${RED}✗${NC} VNC service failed to start"
    journalctl -u thalassa-vnc --since "1 minute ago" | tail -10
    exit 1
fi

# ── Done ──
PI_IP=$(hostname -I | awk '{print $1}')

echo ""
echo -e "${GREEN}${BOLD}  ✓ Done!${NC}"
echo ""
echo -e "${CYAN}${BOLD}  How to connect from your Mac:${NC}"
echo ""
echo -e "  Open Terminal on the Mac, run:"
echo ""
echo -e "    ${BOLD}ssh -L 5901:localhost:5901 ${REAL_USER}@${PI_IP}${NC}"
echo ""
echo -e "  (or use ${BOLD}calypso.local${NC} instead of ${PI_IP})"
echo ""
echo -e "  Leave that terminal open, then in Finder:"
echo ""
echo -e "    Go → Connect to Server → ${BOLD}vnc://localhost:5901${NC}"
echo ""
echo -e "  Use the VNC password you just set. Once the desktop"
echo -e "  appears, click in the terminal and type:"
echo ""
echo -e "    ${BOLD}opencpn${NC}"
echo ""
echo -e "${CYAN}  Then follow docs/PHASE_14_SPIKE.md from step 2${NC}"
echo -e "  (load NOAA cells, right-click → Object Query)"
echo ""
