#!/bin/bash
# ─────────────────────────────────────────────────────────────────────
#  Thalassa — Upgrade Pi's OpenCPN to the version o-charts needs
#
#  Run on the Pi:
#    curl -fsSL https://raw.githubusercontent.com/shanestratton/thalassa-marine-weather/master/pi-cache/upgrade-opencpn.sh | sudo bash
#
#  Why this exists
#  ───────────────
#  Debian's default repos ship OpenCPN 5.10.2 on Pi OS Bookworm.
#  The o-charts plugin (oesenc_pi 2.0.39) in the OpenCPN catalogue
#  is built against OpenCPN 5.12.4+ from the Ubuntu PPA — try to
#  install it on 5.10.2 and you get an "incompatible plugin" error.
#  This is also the path OpenPlotter uses; confirmed working on
#  Pi 5 ARM64 with o-charts (OpenCPN forum, May 2026).
#
#  The fix is to add the OpenCPN Ubuntu PPA and upgrade OpenCPN.
#  Pi OS is Debian-based but the PPA's `jammy` build works fine.
# ─────────────────────────────────────────────────────────────────────

set -e

GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
BOLD='\033[1m'
NC='\033[0m'

echo ""
echo -e "${CYAN}${BOLD}  ⚓  OpenCPN — upgrade to PPA build${NC}"
echo -e "${CYAN}  ════════════════════════════════════${NC}"
echo ""

# ── Show current version ────────────────────────────────────────────
CURRENT_VERSION=$(dpkg -s opencpn 2>/dev/null | grep '^Version:' | awk '{print $2}')
if [[ -n "$CURRENT_VERSION" ]]; then
    echo -e "  Current OpenCPN version: ${BOLD}${CURRENT_VERSION}${NC}"
else
    echo -e "  OpenCPN not installed yet — will install fresh"
fi

# ── Check Pi architecture ───────────────────────────────────────────
ARCH=$(dpkg --print-architecture)
echo -e "  Architecture: ${BOLD}${ARCH}${NC}"
if [[ "$ARCH" != "arm64" ]] && [[ "$ARCH" != "armhf" ]]; then
    echo -e "${YELLOW}  Warning: not arm64/armhf — proceeding anyway.${NC}"
fi

# ── Add the OpenCPN Ubuntu PPA ──────────────────────────────────────
PPA_LIST="/etc/apt/sources.list.d/opencpn-opencpn.list"
PPA_KEY="/etc/apt/trusted.gpg.d/opencpn.gpg"

echo -e "  Adding OpenCPN PPA..."

# OpenCPN PPA's GPG signing keys. apt told us BOTH are needed:
# the InRelease file is multi-signed during a key transition.
# These fingerprints are stable; if they rotate the script will
# fail at apt update with a clear error showing the new ones,
# which is much better than a silent fail.
PPA_KEYS=(
    "5F35EA0636CED80D5C6D604DF9066567FF7CB0D5"
    "116A13C5EDCEAB50DB00229867E4A52AC865EB40"
)

# Remove any stale key file from a previous (failed) run.
rm -f "$PPA_KEY"

UPGRADE_LOG="/tmp/upgrade-opencpn.log"
echo "" > "$UPGRADE_LOG"
for key in "${PPA_KEYS[@]}"; do
    if ! gpg --keyserver keyserver.ubuntu.com --recv-keys "$key" >>"$UPGRADE_LOG" 2>&1; then
        echo -e "${RED}  ✗ Failed to fetch PPA key ${key}.${NC}"
        tail -15 "$UPGRADE_LOG" | sed 's/^/    /'
        exit 1
    fi
done

# Export both keys into a single file for apt to use.
if ! gpg --export "${PPA_KEYS[@]}" > "$PPA_KEY" 2>>"$UPGRADE_LOG"; then
    echo -e "${RED}  ✗ Failed to export PPA keys.${NC}"
    tail -15 "$UPGRADE_LOG" | sed 's/^/    /'
    exit 1
fi
chmod 644 "$PPA_KEY"

# Use Ubuntu jammy (22.04) — OpenCPN PPA's most-aligned build for
# Debian Bookworm/Trixie. Noble (24.04) sometimes has libwxgtk
# version conflicts on Pi OS; jammy is safer.
cat > "$PPA_LIST" <<'PPAEOF'
deb [signed-by=/etc/apt/trusted.gpg.d/opencpn.gpg] https://ppa.launchpadcontent.net/opencpn/opencpn/ubuntu jammy main
PPAEOF

echo -e "  ${GREEN}✓${NC} PPA added with both signing keys"

# ── Update + install ────────────────────────────────────────────────
echo -e "  Updating apt cache..."
APT_UPDATE_LOG="/tmp/upgrade-opencpn-apt.log"
if ! apt-get update >"$APT_UPDATE_LOG" 2>&1; then
    echo -e "${RED}  ✗ apt update failed:${NC}"
    tail -15 "$APT_UPDATE_LOG" | sed 's/^/    /'
    exit 1
fi
echo -e "  ${GREEN}✓${NC} Apt cache updated"

echo -e "  Installing/upgrading OpenCPN..."
INSTALL_LOG="/tmp/upgrade-opencpn-install.log"
if ! apt-get install -y opencpn >"$INSTALL_LOG" 2>&1; then
    echo -e "${RED}  ✗ apt install opencpn failed. Last lines:${NC}"
    tail -25 "$INSTALL_LOG" | sed 's/^/    /'
    echo ""
    echo -e "  ${YELLOW}Common cause:${NC} libwxgtk version conflict between"
    echo -e "  Debian's default and the PPA. If you see 'unmet dependencies',"
    echo -e "  try: ${BOLD}sudo apt-get install -y aptitude && sudo aptitude install opencpn${NC}"
    echo -e "  aptitude is better at resolving complex dep graphs."
    exit 1
fi

NEW_VERSION=$(dpkg -s opencpn 2>/dev/null | grep '^Version:' | awk '{print $2}')
echo -e "  ${GREEN}✓${NC} OpenCPN now at: ${BOLD}${NEW_VERSION}${NC}"

# ── Done ────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}${BOLD}  ✓ Done!${NC}"
echo ""
echo -e "${CYAN}  Next steps:${NC}"
echo ""
echo -e "  1. ${BOLD}Connect to the Pi via VNC${NC} (already set up — just"
echo -e "     run ${BOLD}ssh -L 5901:localhost:5901 skipper@calypso.local${NC}"
echo -e "     from your Mac, then vnc://localhost:5901)"
echo ""
echo -e "  2. Launch OpenCPN — should now show ${BOLD}5.12.4${NC} in the title bar"
echo ""
echo -e "  3. ${BOLD}Settings → Plugins → Update Plugin Catalogue${NC}"
echo ""
echo -e "  4. Find ${BOLD}o-charts (oesenc_pi)${NC} in the list with an Install"
echo -e "     button. Click it. This should now work on Pi 5 arm64."
echo ""
echo -e "  5. Plug your dongle into the Pi USB"
echo ""
echo -e "  6. Restart OpenCPN, activate o-charts plugin (one-time, reads"
echo -e "     dongle for your USERPERMIT)"
echo ""
echo -e "  7. Add your AusENC chart directory and start routing!"
echo ""
