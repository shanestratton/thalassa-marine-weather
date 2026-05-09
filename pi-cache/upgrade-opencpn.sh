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
#
# Modern Debian Trixie uses sqv (Sequoia) for signature verification,
# stricter than the older gpgv. The reliable pattern that works
# across both old and new Debian:
#   1. Fetch keys directly via HTTPS from the keyserver web API
#      (gives clear curl error codes, no silent failures)
#   2. Write to /etc/apt/keyrings/ as ASCII-armored .asc file
#      (universally accepted by sqv, gpgv, and apt-key)
#   3. Reference via signed-by= in the sources.list.d entry
#
# This replaced an earlier attempt with gpg --recv-keys + gpg --export
# that was producing a file sqv accepted but reported "Missing key"
# for. Most likely cause: gpg --recv-keys silently fetched nothing
# and the export was an empty file. Curl-based fetch fixes that.

PPA_LIST="/etc/apt/sources.list.d/opencpn.list"
KEYRING_DIR="/etc/apt/keyrings"
PPA_KEY="${KEYRING_DIR}/opencpn.asc"

echo -e "  Adding OpenCPN PPA..."

# OpenCPN PPA signing keys (apt-update told us exactly which ones are
# needed; the InRelease file is signed by both).
PPA_KEYS=(
    "5F35EA0636CED80D5C6D604DF9066567FF7CB0D5"
    "116A13C5EDCEAB50DB00229867E4A52AC865EB40"
)

mkdir -p "$KEYRING_DIR"
chmod 755 "$KEYRING_DIR"

# Clear any stale state from prior failed runs.
rm -f "$PPA_KEY"
rm -f "${KEYRING_DIR}/opencpn.gpg"
rm -f /etc/apt/trusted.gpg.d/opencpn.gpg

UPGRADE_LOG="/tmp/upgrade-opencpn.log"
echo "" > "$UPGRADE_LOG"

# Fetch each key as ASCII armor from Ubuntu's HKPS keyserver web API.
# Concatenate them into a single .asc file (apt accepts multiple
# armored keys in one file).
for key in "${PPA_KEYS[@]}"; do
    URL="https://keyserver.ubuntu.com/pks/lookup?op=get&search=0x${key}"
    echo "Fetching key ${key}..." >> "$UPGRADE_LOG"
    if ! curl -fsSL --max-time 30 "$URL" >> "$PPA_KEY" 2>>"$UPGRADE_LOG"; then
        echo -e "${RED}  ✗ Failed to fetch PPA key ${key} from keyserver.${NC}"
        echo -e "    URL: ${URL}"
        tail -10 "$UPGRADE_LOG" | sed 's/^/    /'
        exit 1
    fi
    echo "" >> "$PPA_KEY"
done

# Sanity: verify the file actually contains armored key data.
if ! grep -q "BEGIN PGP PUBLIC KEY BLOCK" "$PPA_KEY"; then
    echo -e "${RED}  ✗ Fetched key file doesn't contain ASCII-armored keys.${NC}"
    echo -e "    File size: $(stat -c%s "$PPA_KEY" 2>/dev/null || echo "?") bytes"
    echo -e "    First few lines:"
    head -5 "$PPA_KEY" | sed 's/^/      /'
    exit 1
fi
chmod 644 "$PPA_KEY"

KEY_BLOCKS=$(grep -c "BEGIN PGP PUBLIC KEY BLOCK" "$PPA_KEY")
echo -e "  ${GREEN}✓${NC} PPA key file written (${KEY_BLOCKS} key blocks, $(stat -c%s "$PPA_KEY") bytes)"

# Pick the Ubuntu codename that matches the host OS's library
# naming. The big switch-point is the t64 transition (time_t became
# 64-bit on 32-bit architectures, and many libraries got renamed
# with a `t64` suffix to avoid ABI mixing).
#
#   - Ubuntu jammy (22.04) and earlier: pre-t64. Has libshp2,
#     libunarr1 etc. without the t64 suffix.
#   - Ubuntu noble (24.04) and later: post-t64. Has libshp2t64,
#     libunarr1t64.
#   - Debian bookworm (12): pre-t64.
#   - Debian trixie (13): post-t64.
#
# So bookworm matches jammy, trixie matches noble. We detect
# which Debian we're on and pick the right codename.
DEBIAN_CODENAME=$(. /etc/os-release; echo "${VERSION_CODENAME:-${ID_VERSION:-unknown}}")
case "$DEBIAN_CODENAME" in
    trixie|forky|sid)
        PPA_CODENAME="noble"
        echo -e "  Detected Debian ${DEBIAN_CODENAME} (post-t64) — using noble PPA"
        ;;
    bookworm|*)
        PPA_CODENAME="jammy"
        echo -e "  Detected Debian ${DEBIAN_CODENAME} (pre-t64) — using jammy PPA"
        ;;
esac

cat > "$PPA_LIST" <<EOF
deb [signed-by=${PPA_KEY}] https://ppa.launchpadcontent.net/opencpn/opencpn/ubuntu ${PPA_CODENAME} main
EOF

echo -e "  ${GREEN}✓${NC} PPA source added at ${PPA_LIST}"

# ── Update + install ────────────────────────────────────────────────
#
# apt-get update returns non-zero if ANY configured repo fails, which
# breaks naive `if ! ...; then exit; fi` — common on Pi setups where
# unrelated third-party repos (comitup, OpenPlotter, etc.) have stale
# keys. We instead:
#   1. Run apt-get update (don't bail on unrelated failures)
#   2. Verify specifically that the OpenCPN PPA's index file exists
#   3. Only fail if WE failed; warn-and-continue if the failure was
#      another repo
#
# This way the user can have ten broken third-party repos and we
# still install OpenCPN successfully.
echo -e "  Updating apt cache..."
APT_UPDATE_LOG="/tmp/upgrade-opencpn-apt.log"
apt-get update >"$APT_UPDATE_LOG" 2>&1 || true

# Check specifically that OpenCPN's package index landed (path
# depends on which Ubuntu codename we picked above).
OPENCPN_INDEX="/var/lib/apt/lists/ppa.launchpadcontent.net_opencpn_opencpn_ubuntu_dists_${PPA_CODENAME}_InRelease"
if [[ ! -f "$OPENCPN_INDEX" ]]; then
    echo -e "${RED}  ✗ OpenCPN PPA index not fetched. apt-update output:${NC}"
    tail -25 "$APT_UPDATE_LOG" | sed 's/^/    /'
    exit 1
fi

# Warn (but don't fail) about unrelated repos that broke during update.
OTHER_FAILS=$(grep -E "^Err:" "$APT_UPDATE_LOG" | grep -v "ppa.launchpadcontent.net/opencpn" || true)
if [[ -n "$OTHER_FAILS" ]]; then
    echo -e "  ${YELLOW}!${NC} Unrelated repo errors (won't block OpenCPN install):"
    echo "$OTHER_FAILS" | sed 's/^/    /'
fi

echo -e "  ${GREEN}✓${NC} OpenCPN PPA cache present"

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
