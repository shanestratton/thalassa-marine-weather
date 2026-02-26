/**
 * Route Orchestrator
 * 
 * Geofence-based multi-phase routing engine.
 * Checks if the origin is inside a marina or river zone,
 * then chains the appropriate routing engines:
 * 
 *   1. Marina Grid Router (Turf.js) → exits marina to safe water
 *   2. OfflineRouter (OSM graph A*) → handles river + open water
 * 
 * The orchestrator stitches the route segments into one continuous path.
 */

import * as turf from '@turf/turf';
import type { Feature, Polygon, FeatureCollection } from 'geojson';
import { routeThroughMarina, type MarinaRouteResult } from './MarinaGridRouter';
import { offlineRouter } from './OfflineRouterService';

// ── Types ──────────────────────────────────────────────────────────

interface GeofenceFeature extends Feature<Polygon> {
    properties: {
        name: string;
        zone_type: 'marina' | 'river';
        exit_point: [number, number]; // [lon, lat]
    };
}

interface GeofenceCollection {
    type: 'FeatureCollection';
    features: GeofenceFeature[];
}

export interface OrchestratedRoute {
    /** Full route coordinates [lon, lat] */
    coordinates: [number, number][];
    /** Total distance in nautical miles */
    totalNM: number;
    /** Computation time in ms */
    computeMs: number;
    /** Which engines were used */
    engines: string[];
    /** Number of waypoints */
    waypointCount: number;
    /** Route segments for debugging */
    segments: {
        engine: string;
        coordinates: [number, number][];
        distanceNM: number;
    }[];
    /** GeoJSON LineString for map rendering */
    geojson: GeoJSON.Feature<GeoJSON.LineString>;
}

// ── Geofence Cache ─────────────────────────────────────────────────

let geofenceCache: GeofenceCollection | null = null;

async function loadGeofences(): Promise<GeofenceCollection> {
    if (geofenceCache) return geofenceCache;

    try {
        // Import geofences from the data directory
        const resp = await fetch('/data/geofences.json');
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        geofenceCache = await resp.json();
        console.log(`[Orchestrator] Loaded ${geofenceCache!.features.length} geofences`);
        return geofenceCache!;
    } catch (err) {
        console.warn('[Orchestrator] Failed to load geofences, using inline fallback:', err);
        // Inline fallback with just Newport Marina
        geofenceCache = {
            type: 'FeatureCollection',
            features: [{
                type: 'Feature',
                properties: {
                    name: 'Newport Marina',
                    zone_type: 'marina',
                    exit_point: [153.1005, -27.1990],
                },
                geometry: {
                    type: 'Polygon',
                    coordinates: [[
                        [153.0960, -27.2030], [153.1035, -27.2030],
                        [153.1035, -27.1960], [153.0960, -27.1960],
                        [153.0960, -27.2030],
                    ]],
                },
            }],
        };
        return geofenceCache;
    }
}

// ── Geofence Checks ────────────────────────────────────────────────

function findContainingZone(
    lon: number, lat: number, geofences: GeofenceCollection
): GeofenceFeature | null {
    const pt = turf.point([lon, lat]);
    for (const feature of geofences.features) {
        if (turf.booleanPointInPolygon(pt, feature)) {
            return feature;
        }
    }
    return null;
}

// ── Haversine ──────────────────────────────────────────────────────

function haversineNM(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 3440.065;
    const toRad = (d: number) => d * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
        Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
}

// ── Main Orchestrator ──────────────────────────────────────────────

/**
 * Route from origin to destination using the appropriate engine(s).
 * 
 * Logic:
 * 1. If origin is in a marina → MarinaGridRouter to exit, then OfflineRouter
 * 2. If origin is in a river → OfflineRouter (graph has channel edges + penalties)
 * 3. Otherwise → OfflineRouter directly (open water)
 */
export async function orchestrateRoute(
    originLat: number,
    originLon: number,
    destLat: number,
    destLon: number,
    vesselDraft: number = 2.5,
    region: string = 'se_queensland',
): Promise<OrchestratedRoute | null> {
    const t0 = performance.now();
    const engines: string[] = [];
    const segments: OrchestratedRoute['segments'] = [];

    console.log(`[Orchestrator] Route: [${originLat.toFixed(4)}, ${originLon.toFixed(4)}] → [${destLat.toFixed(4)}, ${destLon.toFixed(4)}]`);

    // Load geofences
    const geofences = await loadGeofences();

    // Check if origin is inside a geofence zone
    const originZone = findContainingZone(originLon, originLat, geofences);

    let currentLat = originLat;
    let currentLon = originLon;
    const allCoords: [number, number][] = [];

    // ── Phase 1: Marina exit (DISABLED — needs obstacle data) ──────
    // The MarinaGridRouter requires breakwater/land/pier polygons to avoid.
    // Without them it routes through buildings. Skipping to OfflineRouter
    // which has the full OSM graph with bathymetry penalties.
    if (originZone) {
        console.log(`[Orchestrator] Origin in ${originZone.properties.zone_type}: ${originZone.properties.name} (using graph router)`);
    }

    // ── Phase 2: Open water / river routing via OfflineRouter ─────

    // Ensure the offline router is loaded
    const supabaseUrl = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SUPABASE_URL)
        || 'https://pcisdplnodrphauixcau.supabase.co';
    if (!offlineRouter.isReady) {
        try {
            // Force region to 'se_queensland' — matches filename in nav-graphs bucket
            offlineRouter.clearCache('se_queensland');
            await offlineRouter.load(supabaseUrl, 'se_queensland');
        } catch (err) {
            console.error('[Orchestrator] Failed to load OfflineRouter:', err);
            return null;
        }
    }

    // Route from current position to destination
    const graphResult = offlineRouter.route(
        currentLat, currentLon,
        destLat, destLon,
    );

    if (graphResult && graphResult.coordinates.length > 0) {
        engines.push('offline_graph');

        // Convert from [lon, lat] pairs
        const graphCoords = graphResult.coordinates as [number, number][];

        // If we have marina coords, skip the first graph coord (it overlaps with marina exit)
        const startIdx = allCoords.length > 0 ? 1 : 0;
        allCoords.push(...graphCoords.slice(startIdx));

        segments.push({
            engine: 'offline_graph',
            coordinates: graphCoords,
            distanceNM: graphResult.distanceNM,
        });
    } else {
        // Fallback: straight line
        console.warn('[Orchestrator] Graph routing failed, using straight line');
        engines.push('straight_line');
        allCoords.push([currentLon, currentLat], [destLon, destLat]);
        segments.push({
            engine: 'straight_line',
            coordinates: [[currentLon, currentLat], [destLon, destLat]],
            distanceNM: haversineNM(currentLat, currentLon, destLat, destLon),
        });
    }

    // ── Build final result ────────────────────────────────────────

    const totalNM = segments.reduce((sum, s) => sum + s.distanceNM, 0);
    const computeMs = performance.now() - t0;

    const geojson: GeoJSON.Feature<GeoJSON.LineString> = {
        type: 'Feature',
        properties: {
            distanceNM: Math.round(totalNM * 10) / 10,
            waypointCount: allCoords.length,
            computeMs: Math.round(computeMs),
            engines: engines.join('+'),
        },
        geometry: {
            type: 'LineString',
            coordinates: allCoords,
        },
    };

    console.log(
        `[Orchestrator] ✓ ${allCoords.length} WPs, ${totalNM.toFixed(1)} NM, ${computeMs.toFixed(0)}ms ` +
        `[engines: ${engines.join(' → ')}]`
    );

    return {
        coordinates: allCoords,
        totalNM: Math.round(totalNM * 10) / 10,
        computeMs: Math.round(computeMs),
        engines,
        waypointCount: allCoords.length,
        segments,
        geojson,
    };
}
