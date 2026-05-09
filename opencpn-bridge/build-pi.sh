#!/bin/bash
# ─────────────────────────────────────────────────────────────────────
#  Thalassa Bridge — one-shot Raspberry Pi build (aarch64 / arm64)
#
#  Run on the Pi:
#    cd /opt/thalassa-pi-cache/opencpn-bridge   # or wherever
#    sudo ./build-pi.sh
#
#  Produces: build/libthalassa_bridge_pi.so
#  Installs to: ~/.opencpn/plugins/lib/  (OpenCPN's per-user plugin dir)
#
#  Prerequisite: o-charts plugin (oesenc_pi) must ALSO be installed
#  separately. Without it, OpenCPN can't decrypt your AusENC cells
#  and the bridge has nothing to extract. See README "On the Pi"
#  section.
# ─────────────────────────────────────────────────────────────────────

set -e

cd "$(dirname "$0")"

GREEN='\033[0;32m'
CYAN='\033[0;36m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
BOLD='\033[1m'
NC='\033[0m'

echo ""
echo -e "${CYAN}${BOLD}  ⚓  Thalassa Bridge — Pi build${NC}"
echo -e "${CYAN}  ═══════════════════════════════${NC}"
echo ""

REAL_USER="${SUDO_USER:-$USER}"
if [[ "$REAL_USER" == "root" ]]; then
    REAL_USER=$(getent passwd 1000 | cut -d: -f1 || echo "skipper")
fi
REAL_HOME=$(eval echo "~${REAL_USER}")

ARCH=$(uname -m)
echo -e "  Architecture: ${BOLD}${ARCH}${NC}"
if [[ "$ARCH" != "aarch64" ]] && [[ "$ARCH" != "armv7l" ]]; then
    echo -e "${YELLOW}  Warning: not running on ARM. This script is for Pi.${NC}"
    echo -e "  Use build-mac.sh for macOS, or adapt for x86_64 Linux."
fi

# ── Apt deps ────────────────────────────────────────────────────────
NEEDED_PKGS="cmake build-essential git curl libwxgtk3.2-dev"
MISSING_PKGS=""
for pkg in $NEEDED_PKGS; do
    if ! dpkg -s "$pkg" &>/dev/null; then
        MISSING_PKGS="$MISSING_PKGS $pkg"
    fi
done

if [[ -n "$MISSING_PKGS" ]]; then
    echo -e "  Installing build deps:${MISSING_PKGS}"
    apt-get update -qq >/dev/null 2>&1
    BUILD_LOG="/tmp/bridge-deps.log"
    if ! apt-get install -y $MISSING_PKGS >"$BUILD_LOG" 2>&1; then
        echo -e "${RED}  ✗ Apt install failed. Last lines:${NC}"
        tail -20 "$BUILD_LOG" | sed 's/^/    /'
        # Some Pi distros ship libwxgtk3.0-gtk3-dev instead of 3.2 —
        # fall back automatically.
        if echo "$MISSING_PKGS" | grep -q "libwxgtk3.2-dev"; then
            echo -e "${YELLOW}  Trying libwxgtk3.0-gtk3-dev as fallback...${NC}"
            apt-get install -y libwxgtk3.0-gtk3-dev >>"$BUILD_LOG" 2>&1 || {
                echo -e "${RED}  ✗ Both wxWidgets dev packages failed.${NC}"
                exit 1
            }
        else
            exit 1
        fi
    fi
fi
echo -e "  ${GREEN}✓${NC} Build deps installed"

# ── OpenCPN plugin SDK ──────────────────────────────────────────────
OPENCPN_SOURCE_DIR="${OPENCPN_SOURCE_DIR:-${REAL_HOME}/opencpn-source}"
if [[ ! -f "${OPENCPN_SOURCE_DIR}/include/ocpn_plugin.h" ]]; then
    echo -e "  Cloning OpenCPN source to ${OPENCPN_SOURCE_DIR}..."
    sudo -u "$REAL_USER" git clone --depth 1 \
        https://github.com/OpenCPN/OpenCPN.git "${OPENCPN_SOURCE_DIR}"
fi
echo -e "  ${GREEN}✓${NC} OpenCPN SDK at ${OPENCPN_SOURCE_DIR}"

# ── Vendor cpp-httplib ──────────────────────────────────────────────
mkdir -p third_party
HTTPLIB="third_party/httplib.h"
if [[ ! -f "${HTTPLIB}" ]]; then
    echo -e "  Fetching cpp-httplib..."
    curl -fsSL \
        https://raw.githubusercontent.com/yhirose/cpp-httplib/v0.18.5/httplib.h \
        -o "${HTTPLIB}"
fi
echo -e "  ${GREEN}✓${NC} httplib.h ready"

# ── Configure + build ───────────────────────────────────────────────
mkdir -p build
chown -R "${REAL_USER}:${REAL_USER}" build third_party

cd build
if [[ ! -f CMakeCache.txt ]]; then
    echo -e "  Configuring..."
    sudo -u "$REAL_USER" cmake .. \
        -DCMAKE_BUILD_TYPE=Release \
        -DOPENCPN_SOURCE_DIR="${OPENCPN_SOURCE_DIR}" \
        2>&1 | tail -15
fi

echo -e "  Building (this takes 30-60s on Pi 5)..."
sudo -u "$REAL_USER" cmake --build . --parallel "$(nproc)" 2>&1 | tail -20

SOFILE="$(pwd)/libthalassa_bridge_pi.so"
if [[ ! -f "${SOFILE}" ]]; then
    echo -e "${RED}  ✗ Build failed — no .so produced${NC}"
    exit 1
fi

# ── Install to OpenCPN's per-user plugin dir ───────────────────────
PLUGIN_DIR="${REAL_HOME}/.opencpn/plugins/lib"
mkdir -p "${PLUGIN_DIR}"
cp "${SOFILE}" "${PLUGIN_DIR}/"
chown -R "${REAL_USER}:${REAL_USER}" "${REAL_HOME}/.opencpn"
echo -e "  ${GREEN}✓${NC} Installed to ${PLUGIN_DIR}/libthalassa_bridge_pi.so"

# ── Done ────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}${BOLD}  ✓ Build done!${NC}"
echo ""
echo -e "${CYAN}  Next steps:${NC}"
echo ""
echo -e "  1. ${BOLD}Make sure o-charts plugin is also installed${NC} on this Pi"
echo -e "     (the bridge needs the o-charts plugin to have something to query)"
echo -e "     See README section \"On the Pi\" for download instructions."
echo ""
echo -e "  2. Restart OpenCPN. Settings → Plugins → enable ${BOLD}Thalassa Bridge${NC}"
echo ""
echo -e "  3. Verify with:"
echo -e "     ${BOLD}curl http://localhost:3002/health${NC}"
echo ""
