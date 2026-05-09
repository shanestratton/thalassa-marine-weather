/*
 * feature_extractor.h — pulls S-57 features from OpenCPN's catalog
 *
 * This is where the real work will live. For the v0.1 scaffold we
 * return a mock GeoJSON FeatureCollection so the HTTP plumbing is
 * provable end-to-end (build, load, curl, see real bytes).
 *
 * Phase 14b-real (next step) replaces the mock with calls to:
 *   GetPlugInChartObjectsAtCursor(...)  → ListOfPI_S57Obj
 * iterating over each chart loaded in the bbox, plus
 *   PI_S57Obj.attVal / PI_S57Obj.geoPt[Multi]
 * for the actual data extraction.
 */

#ifndef THALASSA_FEATURE_EXTRACTOR_H
#define THALASSA_FEATURE_EXTRACTOR_H

#include <string>
#include <vector>

class FeatureExtractor {
public:
    FeatureExtractor();
    ~FeatureExtractor();

    /**
     * Extract S-57 features from OpenCPN's currently-loaded charts
     * within `bbox` ([minLon, minLat, maxLon, maxLat]) where the
     * feature class name matches one of `layers` (e.g. "DEPARE",
     * "DRGARE", etc.).
     *
     * Returns a serialized GeoJSON FeatureCollection as a string,
     * with one feature per S-57 object. Properties include the
     * S-57 layer name (`_layer`), source cell (`_cellId`), and all
     * feature attributes copied verbatim from the OpenCPN catalog.
     *
     * Always returns a valid JSON document — empty FeatureCollection
     * if no features match.
     */
    std::string Extract(const double bbox[4],
                        const std::vector<std::string>& layers);
};

#endif  // THALASSA_FEATURE_EXTRACTOR_H
