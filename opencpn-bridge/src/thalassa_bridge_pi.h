/*
 * thalassa_bridge_pi.h — OpenCPN plugin entry point
 *
 * Implements the opencpn_plugin_119 ABI (compatible with OpenCPN 5.10+).
 * The plugin's job is small: start an HTTP server on plugin Init, stop
 * it on DeInit, route incoming requests to the feature extractor.
 *
 * All chart-feature work happens in feature_extractor.{h,cpp}; this
 * file is purely lifecycle + metadata + glue.
 */

#ifndef THALASSA_BRIDGE_PI_H
#define THALASSA_BRIDGE_PI_H

#include "ocpn_plugin.h"

#include <memory>

class HttpServer;
class FeatureExtractor;

class ThalassaBridgePI : public opencpn_plugin_119 {
public:
    explicit ThalassaBridgePI(void* ppimgr);
    ~ThalassaBridgePI() override;

    // ── Lifecycle ────────────────────────────────────────────────
    int Init() override;
    bool DeInit() override;

    // ── Plugin metadata (OpenCPN displays these in the plugin list) ──
    int GetAPIVersionMajor() override;
    int GetAPIVersionMinor() override;
    int GetPlugInVersionMajor() override;
    int GetPlugInVersionMinor() override;
    wxBitmap* GetPlugInBitmap() override;
    wxString GetCommonName() override;
    wxString GetShortDescription() override;
    wxString GetLongDescription() override;

private:
    std::unique_ptr<HttpServer> m_server;
    std::unique_ptr<FeatureExtractor> m_extractor;
    wxBitmap m_bitmap;  // empty placeholder, satisfies GetPlugInBitmap()
};

#endif  // THALASSA_BRIDGE_PI_H
