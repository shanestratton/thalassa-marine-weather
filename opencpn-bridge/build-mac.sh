#!/bin/bash
# ─────────────────────────────────────────────────────────────────────
#  Thalassa Bridge — one-shot Mac build
#
#  Run from the opencpn-bridge directory:
#    ./build-mac.sh
#
#  Produces: build/libthalassa_bridge_pi.dylib
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
echo -e "${CYAN}${BOLD}  ⚓  Thalassa Bridge — Mac build${NC}"
echo -e "${CYAN}  ════════════════════════════════${NC}"
echo ""

# ── Prereq: Homebrew packages ───────────────────────────────────────
for pkg in cmake wxwidgets; do
    if ! brew list --formula 2>/dev/null | grep -q "^${pkg}\$"; then
        echo -e "${YELLOW}  Missing brew package: ${pkg}${NC}"
        echo -e "  Install with: ${BOLD}brew install ${pkg}${NC}"
        exit 1
    fi
done
echo -e "  ${GREEN}✓${NC} Homebrew prereqs installed"

# ── Prereq: OpenCPN source for plugin SDK headers ───────────────────
OPENCPN_SOURCE_DIR="${OPENCPN_SOURCE_DIR:-../../opencpn-source}"
if [[ ! -f "${OPENCPN_SOURCE_DIR}/include/ocpn_plugin.h" ]]; then
    echo -e "${YELLOW}  OpenCPN plugin SDK not found at ${OPENCPN_SOURCE_DIR}${NC}"
    echo -e "  Cloning OpenCPN source to ${OPENCPN_SOURCE_DIR}..."
    git clone --depth 1 https://github.com/OpenCPN/OpenCPN.git "${OPENCPN_SOURCE_DIR}"
fi
echo -e "  ${GREEN}✓${NC} OpenCPN SDK at ${OPENCPN_SOURCE_DIR}"

# ── Vendor cpp-httplib (single header) ──────────────────────────────
mkdir -p third_party
HTTPLIB="third_party/httplib.h"
if [[ ! -f "${HTTPLIB}" ]]; then
    echo -e "  Fetching cpp-httplib..."
    curl -fsSL \
        https://raw.githubusercontent.com/yhirose/cpp-httplib/v0.18.5/httplib.h \
        -o "${HTTPLIB}"
fi
echo -e "  ${GREEN}✓${NC} httplib.h ready ($(wc -l < ${HTTPLIB}) lines)"

# ── Configure + build ───────────────────────────────────────────────
mkdir -p build
cd build

if [[ ! -f CMakeCache.txt ]]; then
    echo -e "  Configuring..."
    cmake .. \
        -DCMAKE_BUILD_TYPE=Release \
        -DOPENCPN_SOURCE_DIR="$(realpath ../${OPENCPN_SOURCE_DIR})" \
        2>&1 | tail -20
fi

echo -e "  Building..."
cmake --build . --parallel 2>&1 | tail -30

DYLIB="$(pwd)/libthalassa_bridge_pi.dylib"
if [[ ! -f "${DYLIB}" ]]; then
    echo -e "${RED}  ✗ Build failed — no .dylib produced${NC}"
    exit 1
fi

echo ""
echo -e "${GREEN}${BOLD}  ✓ Done!${NC}"
echo ""
echo -e "  Plugin: ${BOLD}${DYLIB}${NC}"
echo ""
echo -e "${CYAN}  To install:${NC}"
echo ""
echo -e "    cp '${DYLIB}' \\"
echo -e "       ~/Library/Application\\ Support/OpenCPN/plugins/"
echo ""
echo -e "  Then restart OpenCPN. Plugin should appear in:"
echo -e "  ${BOLD}OpenCPN → Settings → Plugins → Thalassa Bridge${NC}"
echo ""
echo -e "  After enabling, test with:"
echo -e "    ${BOLD}curl http://localhost:3002/health${NC}"
echo ""
