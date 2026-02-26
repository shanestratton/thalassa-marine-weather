/**
 * Route Orchestrator v3 — OSM Waterway Exit Router
 *
 * Uses real OSM geometry to route boats out of marinas and rivers:
 *   1. Load waterway_zones.geojson (marina polygons + river centerlines)
 *   2. Check if origin is inside a marina or on a river (Turf point-in-polygon)
 *   3. If yes → snap to nearest centerline, follow it downstream to safe water
 *   4. If no → return null (let Gemini AI handle the whole route)
 *
 * No external API calls. No massive graphs. Just geometry.
 */

import * as turf from '@turf/turf';

// ── Types ──────────────────────────────────────────────────────────

export interface OrchestratedRoute {
    coordinates: [number, number][];
    totalNM: number;
    computeMs: number;
    engines: string[];
    waypointCount: number;
    segments: {
        engine: string;
        coordinates: [number, number][];
        distanceNM: number;
    }[];
    geojson: GeoJSON.Feature<GeoJSON.LineString>;
}

interface WaterwayZone {
    type: 'Feature';
    properties: {
        zone_type: 'marina' | 'waterway_centerline' | 'channel_centerline' | 'river';
        name: string;
        waterway?: string;
        osm_id: number;
    };
    geometry: GeoJSON.Polygon | GeoJSON.LineString;
}

// ── Data loading ───────────────────────────────────────────────────

let zonesData: { features: WaterwayZone[] } | null = null;

async function loadZones(): Promise<{ features: WaterwayZone[] }> {
    if (zonesData) return zonesData;

    try {
        const resp = await fetch('/data/waterway_zones.geojson');
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        zonesData = await resp.json();
        const marinas = zonesData!.features.filter(f => f.properties.zone_type === 'marina').length;
        const centerlines = zonesData!.features.filter(f => f.properties.zone_type === 'waterway_centerline').length;
        console.log(`[Orchestrator] Loaded ${marinas} marinas, ${centerlines} waterway centerlines`);
        return zonesData!;
    } catch (err) {
        console.error('[Orchestrator] Failed to load waterway zones:', err);
        return { features: [] };
    }
}

// ── Helpers ────────────────────────────────────────────────────────

/** Fast equirectangular distance in meters */
function fastDistM(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const dx = (lon2 - lon1) * Math.cos(((lat1 + lat2) / 2) * Math.PI / 180) * 111320;
    const dy = (lat2 - lat1) * 111320;
    return Math.sqrt(dx * dx + dy * dy);
}

/** Convert meters to nautical miles */
function metersToNM(m: number): number {
    return m / 1852;
}

/** Calculate total distance along a coordinate array [lon, lat][] */
function totalDistanceNM(coords: [number, number][]): number {
    let total = 0;
    for (let i = 1; i < coords.length; i++) {
        total += fastDistM(coords[i - 1][1], coords[i - 1][0], coords[i][1], coords[i][0]);
    }
    return metersToNM(total);
}

/**
 * Find which marina polygon (if any) contains the given point.
 */
function findContainingMarina(
    lon: number, lat: number, zones: WaterwayZone[]
): WaterwayZone | null {
    const pt = turf.point([lon, lat]);
    for (const zone of zones) {
        if (zone.properties.zone_type === 'marina' && zone.geometry.type === 'Polygon') {
            try {
                if (turf.booleanPointInPolygon(pt, zone as any)) {
                    return zone;
                }
            } catch { /* skip malformed polygons */ }
        }
    }
    return null;
}

/**
 * Find the nearest waterway or channel centerline to the given point.
 * Checks both OSM waterway centerlines and IALA-derived channel centerlines.
 * Prefers channel_centerline (from paired marks) over waterway_centerline (from OSM).
 */
function findNearestCenterline(
    lon: number, lat: number, zones: WaterwayZone[], maxDistM: number = 500
): { feature: WaterwayZone; nearestIdx: number; distM: number } | null {
    let best: { feature: WaterwayZone; nearestIdx: number; distM: number } | null = null;

    for (const zone of zones) {
        // Accept both OSM waterway centerlines and IALA channel centerlines
        const zt = zone.properties.zone_type;
        if (zt !== 'waterway_centerline' && zt !== 'channel_centerline') continue;
        if (zone.geometry.type !== 'LineString') continue;

        const coords = zone.geometry.coordinates as [number, number][];
        for (let i = 0; i < coords.length; i++) {
            const d = fastDistM(lat, lon, coords[i][1], coords[i][0]);
            if (d < maxDistM && (!best || d < best.distM)) {
                best = { feature: zone, nearestIdx: i, distM: d };
            }
        }
    }

    return best;
}

/**
 * Follow a waterway centerline from a starting index toward the endpoint
 * that is closest to the destination.
 * 
 * Returns the route coordinates [lon, lat][] from the snap point to the exit.
 */
function followCenterline(
    centerline: WaterwayZone,
    startIdx: number,
    destLon: number,
    destLat: number,
): [number, number][] {
    const coords = centerline.geometry.coordinates as [number, number][];

    // Determine direction: follow toward whichever end is closer to destination
    const distToStart = fastDistM(destLat, destLon, coords[0][1], coords[0][0]);
    const distToEnd = fastDistM(destLat, destLon, coords[coords.length - 1][1], coords[coords.length - 1][0]);

    if (distToEnd <= distToStart) {
        // Follow downstream (toward end)
        return coords.slice(startIdx);
    } else {
        // Follow upstream (toward start)
        return coords.slice(0, startIdx + 1).reverse();
    }
}

/**
 * For a marina, find the nearest waterway centerline just outside the marina.
 * This gives us the handoff from marina to waterway.
 */
function findExitCenterline(
    marina: WaterwayZone,
    zones: WaterwayZone[],
): { feature: WaterwayZone; nearestIdx: number } | null {
    // Get the marina centroid and look for centerlines within 2km
    const centroid = turf.centroid(marina as any);
    const [cLon, cLat] = centroid.geometry.coordinates;

    return findNearestCenterline(cLon, cLat, zones, 2000);
}

// ── Main Orchestrator ──────────────────────────────────────────────

export async function orchestrateRoute(
    originLat: number,
    originLon: number,
    destLat: number,
    destLon: number,
    _vesselDraft: number = 2.5,
    _region: string = 'se_queensland',
): Promise<OrchestratedRoute | null> {
    const t0 = performance.now();
    const engines: string[] = [];
    const segments: OrchestratedRoute['segments'] = [];

    console.log(`[Orchestrator] Route: [${originLat.toFixed(4)}, ${originLon.toFixed(4)}] → [${destLat.toFixed(4)}, ${destLon.toFixed(4)}]`);

    // Load waterway data
    const zones = await loadZones();
    if (zones.features.length === 0) {
        console.warn('[Orchestrator] No waterway data loaded — returning null');
        return null;
    }

    let exitCoords: [number, number][] = [];

    // ── Check 1: Is the origin inside a marina? ────────────────────
    const marina = findContainingMarina(originLon, originLat, zones.features);

    if (marina) {
        console.log(`[Orchestrator] 🏗 Origin in marina: ${marina.properties.name}`);

        // Find the nearest waterway centerline to this marina
        const exitLine = findExitCenterline(marina, zones.features);

        if (exitLine) {
            console.log(`[Orchestrator] Found exit waterway: ${exitLine.feature.properties.name}`);

            // Build route: origin → marina exit → follow centerline downstream
            const centerlineRoute = followCenterline(
                exitLine.feature,
                exitLine.nearestIdx,
                destLon,
                destLat,
            );

            // Prepend the origin point and connection to centerline
            exitCoords = [
                [originLon, originLat],
                ...centerlineRoute,
            ];

            engines.push('marina_exit');
            segments.push({
                engine: 'marina_exit',
                coordinates: exitCoords,
                distanceNM: totalDistanceNM(exitCoords),
            });
        } else {
            console.warn(`[Orchestrator] No centerline found near ${marina.properties.name}`);
            // Fall through — the AI will handle the full route
            return null;
        }
    }

    // ── Check 2: Is the origin near a waterway? ────────────────────
    if (!marina) {
        const nearest = findNearestCenterline(originLon, originLat, zones.features, 300);

        if (nearest) {
            console.log(`[Orchestrator] 🌊 Origin near waterway: ${nearest.feature.properties.name} (${nearest.distM.toFixed(0)}m)`);

            // Follow the centerline toward the destination
            const centerlineRoute = followCenterline(
                nearest.feature,
                nearest.nearestIdx,
                destLon,
                destLat,
            );

            exitCoords = [
                [originLon, originLat],
                ...centerlineRoute,
            ];

            engines.push('waterway_follow');
            segments.push({
                engine: 'waterway_follow',
                coordinates: exitCoords,
                distanceNM: totalDistanceNM(exitCoords),
            });
        } else {
            // Not in a marina, not near a waterway — open water
            console.log('[Orchestrator] ⚓ Origin in open water — letting AI handle route');
            return null;
        }
    }

    // ── Build result ───────────────────────────────────────────────

    if (exitCoords.length === 0) return null;

    const totalNM = totalDistanceNM(exitCoords);
    const computeMs = performance.now() - t0;

    const geojson: GeoJSON.Feature<GeoJSON.LineString> = {
        type: 'Feature',
        properties: {
            distanceNM: Math.round(totalNM * 10) / 10,
            waypointCount: exitCoords.length,
            computeMs: Math.round(computeMs),
            engines: engines.join('+'),
        },
        geometry: {
            type: 'LineString',
            coordinates: exitCoords,
        },
    };

    console.log(
        `[Orchestrator] ✓ ${exitCoords.length} WPs, ${totalNM.toFixed(1)} NM, ` +
        `${computeMs.toFixed(0)}ms [${engines.join(' → ')}]`
    );

    return {
        coordinates: exitCoords,
        totalNM: Math.round(totalNM * 10) / 10,
        computeMs: Math.round(computeMs),
        engines,
        waypointCount: exitCoords.length,
        segments,
        geojson,
    };
}
