/*
 * feature_extractor.cpp — v0.1 returns mock data
 *
 * The shape of the response is correct (so pi-cache can integrate
 * against it immediately) but the data is hand-rolled until Phase
 * 14b-real lands. Specifically, we synthesize ONE DEPARE polygon
 * spanning the requested bbox so the inshore router has something
 * to chew on during integration testing.
 *
 * Replacing this with real OpenCPN feature extraction is the next
 * milestone. The OpenCPN APIs to use:
 *   - GetPlugInChartObjectsAtCursor(lat, lon, max_dist)
 *       returns ListOfPI_S57Obj* — point-query at a position
 *   - For bbox queries we iterate a grid of point queries OR find
 *     the bulk-extraction API (research needed; possibly a new
 *     OpenCPN core API call that hasn't been promoted to the
 *     plugin SDK yet)
 *   - PI_S57Obj has FeatureName, attVal, geoPt[Multi]
 *
 * The grid-of-point-queries approach is workable: at 50m resolution
 * over a 5km bbox, that's 100×100 = 10,000 point queries. Each query
 * is ~1 ms, so ~10 seconds total. Acceptable for one-off route
 * computes; cacheable so repeat queries are instant.
 *
 * Faster path: dig into OpenCPN's chart class directly via the
 * underlying chart pointer. That's a deeper SDK dive but skips the
 * grid-iteration overhead.
 */

#include "feature_extractor.h"

#include <algorithm>
#include <sstream>
#include <string>

namespace {

// Returns true if the given S-57 layer name is in the requested list.
// Matching is case-sensitive — S-57 layer codes are always uppercase.
bool IsRequested(const std::vector<std::string>& layers,
                 const std::string& name) {
    return std::find(layers.begin(), layers.end(), name) != layers.end();
}

}  // namespace

FeatureExtractor::FeatureExtractor() = default;
FeatureExtractor::~FeatureExtractor() = default;

std::string FeatureExtractor::Extract(const double bbox[4],
                                      const std::vector<std::string>& layers) {
    std::ostringstream out;
    out << R"({"type":"FeatureCollection","features":[)";

    bool first = true;

    // ── MOCK: synthesize one DEPARE polygon spanning the bbox ──
    //
    // Real implementation will iterate OpenCPN's chart objects.
    // For now we emit a polygon shaped like the bbox so pi-cache
    // can wire up against the response shape.
    if (IsRequested(layers, "DEPARE")) {
        if (!first) out << ',';
        first = false;
        out << R"({"type":"Feature",)"
            << R"("geometry":{"type":"Polygon","coordinates":[[)"
            << '[' << bbox[0] << ',' << bbox[1] << "],"
            << '[' << bbox[2] << ',' << bbox[1] << "],"
            << '[' << bbox[2] << ',' << bbox[3] << "],"
            << '[' << bbox[0] << ',' << bbox[3] << "],"
            << '[' << bbox[0] << ',' << bbox[1] << ']'
            << "]]},"
            << R"("properties":{"_layer":"DEPARE","_cellId":"MOCK",)"
            << R"("_mock":true,"DRVAL1":10.0,"DRVAL2":20.0}})";
    }

    out << "]}";
    return out.str();
}
