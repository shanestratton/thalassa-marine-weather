/*
 * http_server.cpp — cpp-httplib wrapper
 */

#include "http_server.h"
#include "feature_extractor.h"

#define CPPHTTPLIB_OPENSSL_SUPPORT 0
#include "httplib.h"

#include <wx/log.h>

#include <sstream>

namespace {

// Parse "minLon,minLat,maxLon,maxLat" — returns false on malformed input.
bool ParseBbox(const std::string& s, double out[4]) {
    std::stringstream ss(s);
    std::string token;
    int i = 0;
    while (std::getline(ss, token, ',') && i < 4) {
        try {
            out[i++] = std::stod(token);
        } catch (...) {
            return false;
        }
    }
    return i == 4;
}

// Split "DEPARE,LNDARE,DRGARE" into a list. Whitespace tolerated.
std::vector<std::string> ParseLayerList(const std::string& s) {
    std::vector<std::string> result;
    std::stringstream ss(s);
    std::string token;
    while (std::getline(ss, token, ',')) {
        // Trim whitespace
        size_t start = token.find_first_not_of(" \t");
        size_t end = token.find_last_not_of(" \t");
        if (start == std::string::npos) continue;
        result.push_back(token.substr(start, end - start + 1));
    }
    return result;
}

}  // namespace

HttpServer::HttpServer(std::string host, int port, FeatureExtractor* extractor)
    : m_host(std::move(host)),
      m_port(port),
      m_extractor(extractor),
      m_server(std::make_unique<httplib::Server>()) {

    // ── /health — sanity check ──────────────────────────────────
    m_server->Get("/health", [](const httplib::Request&, httplib::Response& res) {
        res.set_content(
            R"({"status":"ok","plugin":"thalassa-bridge","version":"0.1.0"})",
            "application/json");
    });

    // ── /features?bbox=...&layers=... ───────────────────────────
    m_server->Get("/features",
                  [extractor](const httplib::Request& req, httplib::Response& res) {
        // Required: bbox.
        if (!req.has_param("bbox")) {
            res.status = 400;
            res.set_content(R"({"error":"missing required param: bbox"})",
                            "application/json");
            return;
        }
        double bbox[4];
        if (!ParseBbox(req.get_param_value("bbox"), bbox)) {
            res.status = 400;
            res.set_content(
                R"({"error":"bbox must be 4 comma-separated decimals: minLon,minLat,maxLon,maxLat"})",
                "application/json");
            return;
        }

        // Optional: layers. Default covers two purposes:
        //
        //   Routing-essential (drive the inshore A* graph):
        //     DEPARE, DRGARE, LNDARE, OBSTRN, WRECKS, UWTROC
        //
        //   Descriptive (route narration + advisories):
        //     SEAARE  (named water bodies — "Inner Bar Reach")
        //     ADMARE  (admin areas — "Brisbane Port limits")
        //     HRBARE  (harbour boundaries)
        //     CTNARE  (caution areas — "VTS contact required")
        //     RESARE  (restricted — no-anchor / military / marine park)
        //     PRCARE  (precautionary — heavy traffic zones)
        //
        // The plugin returns whatever the caller requests; this is
        // just what we'd default to if no explicit list is given.
        // pi-cache calls with the routing-essential set; future UI
        // surfaces (route description, jurisdiction badge) call with
        // the descriptive layers separately.
        std::vector<std::string> layers;
        if (req.has_param("layers")) {
            layers = ParseLayerList(req.get_param_value("layers"));
        } else {
            layers = {
                // Routing-essential
                "DEPARE", "DRGARE", "LNDARE", "OBSTRN", "WRECKS", "UWTROC",
                // Descriptive
                "SEAARE", "ADMARE", "HRBARE", "CTNARE", "RESARE", "PRCARE",
            };
        }

        const std::string geojson = extractor->Extract(bbox, layers);
        res.set_content(geojson, "application/json");
    });

    // ── Catch-all for unknown routes ────────────────────────────
    m_server->set_error_handler([](const httplib::Request&, httplib::Response& res) {
        if (res.status == 404) {
            res.set_content(
                R"({"error":"unknown endpoint","endpoints":["/health","/features"]})",
                "application/json");
        }
    });
}

HttpServer::~HttpServer() {
    Stop();
}

bool HttpServer::Start() {
    if (m_running.load()) return true;

    // Attempt to bind first so we can report failure synchronously.
    if (!m_server->bind_to_port(m_host.c_str(), m_port)) {
        wxLogError("Thalassa Bridge: cannot bind to %s:%d (port in use?)",
                   m_host.c_str(), m_port);
        return false;
    }

    m_running.store(true);
    m_thread = std::thread([this]() {
        m_server->listen_after_bind();
        m_running.store(false);
    });
    return true;
}

void HttpServer::Stop() {
    if (!m_running.load() && !m_thread.joinable()) return;
    if (m_server) {
        m_server->stop();
    }
    if (m_thread.joinable()) {
        m_thread.join();
    }
    m_running.store(false);
}
