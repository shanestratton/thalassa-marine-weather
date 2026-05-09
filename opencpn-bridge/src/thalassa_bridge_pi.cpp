/*
 * thalassa_bridge_pi.cpp — OpenCPN plugin entry point
 *
 * See thalassa_bridge_pi.h for the class declaration and the
 * project README for the architectural picture.
 *
 * Lifecycle:
 *   create_pi() ────► ThalassaBridgePI() ────► Init() ─► HttpServer.Start()
 *   destroy_pi() ────► DeInit() ─────────────► HttpServer.Stop() ─► dtor
 *
 * The plugin's port (default 3002) is hard-coded for now. Future work:
 * configurable via the Plugin Preferences dialog.
 */

#include "thalassa_bridge_pi.h"
#include "http_server.h"
#include "feature_extractor.h"

#include <wx/log.h>

namespace {
// Bind to all interfaces by default so pi-cache running on a different
// host on the boat LAN can reach us. localhost-only is safer but
// breaks the most common deployment (OpenCPN on Mac, pi-cache on Pi).
constexpr const char* kBindHost = "0.0.0.0";
constexpr int kBindPort = 3002;
}  // namespace

// ─────────────────────────────────────────────────────────────────────
//  C entry points OpenCPN dynamically loads
// ─────────────────────────────────────────────────────────────────────

extern "C" DECL_EXP opencpn_plugin* create_pi(void* ppimgr) {
    return new ThalassaBridgePI(ppimgr);
}

extern "C" DECL_EXP void destroy_pi(opencpn_plugin* p) {
    delete p;
}

// ─────────────────────────────────────────────────────────────────────
//  ThalassaBridgePI
// ─────────────────────────────────────────────────────────────────────

ThalassaBridgePI::ThalassaBridgePI(void* ppimgr)
    : opencpn_plugin_119(ppimgr) {
    // Constructor runs at OpenCPN startup, BEFORE the user enables the
    // plugin. Don't start any threads / open any ports here.
}

ThalassaBridgePI::~ThalassaBridgePI() = default;

int ThalassaBridgePI::Init() {
    wxLogMessage("Thalassa Bridge: Init");

    m_extractor = std::make_unique<FeatureExtractor>();
    m_server = std::make_unique<HttpServer>(kBindHost, kBindPort, m_extractor.get());

    if (!m_server->Start()) {
        wxLogError("Thalassa Bridge: HTTP server failed to start on %s:%d",
                   kBindHost, kBindPort);
        // Even if the server failed (port in use, etc.), don't kill the
        // plugin — let OpenCPN keep running normally.
    } else {
        wxLogMessage("Thalassa Bridge: HTTP server listening on %s:%d",
                     kBindHost, kBindPort);
    }

    // No special capabilities required — we're a background HTTP service,
    // we don't draw on the chart, install toolbar items, or hook into
    // routing. Returning 0 means "minimal plugin, no extra capabilities."
    return 0;
}

bool ThalassaBridgePI::DeInit() {
    wxLogMessage("Thalassa Bridge: DeInit");
    if (m_server) {
        m_server->Stop();
        m_server.reset();
    }
    m_extractor.reset();
    return true;
}

// ── Plugin metadata ──────────────────────────────────────────────────

int ThalassaBridgePI::GetAPIVersionMajor() { return PLUGIN_API_VERSION_MAJOR; }
int ThalassaBridgePI::GetAPIVersionMinor() { return PLUGIN_API_VERSION_MINOR; }
int ThalassaBridgePI::GetPlugInVersionMajor() { return PLUGIN_VERSION_MAJOR; }
int ThalassaBridgePI::GetPlugInVersionMinor() { return PLUGIN_VERSION_MINOR; }

wxBitmap* ThalassaBridgePI::GetPlugInBitmap() {
    // Returning a default-constructed bitmap is enough — OpenCPN handles
    // empty bitmaps gracefully by drawing a generic plugin icon. We can
    // ship a real Thalassa logo later via embedded XPM data.
    return &m_bitmap;
}

wxString ThalassaBridgePI::GetCommonName() {
    return _T("Thalassa Bridge");
}

wxString ThalassaBridgePI::GetShortDescription() {
    return _T("Exposes ENC vector features to Thalassa pi-cache via HTTP");
}

wxString ThalassaBridgePI::GetLongDescription() {
    return _T(
        "Thalassa Bridge runs a small HTTP server (default port 3002) "
        "that lets Thalassa's pi-cache router query the S-57 chart "
        "features OpenCPN currently has loaded — including o-charts "
        "encrypted cells decrypted via the user's dongle.\n\n"
        "Endpoints:\n"
        "  GET /health\n"
        "  GET /features?bbox=minLon,minLat,maxLon,maxLat&layers=DEPARE,...\n\n"
        "All access is read-only; the plugin never modifies charts.");
}
