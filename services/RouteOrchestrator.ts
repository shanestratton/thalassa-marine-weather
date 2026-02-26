/**
 * Route Orchestrator v2 — Distance.tools API
 * 
 * 3-phase routing engine:
 *   Phase 1: Coastal departure (origin → 30nm handoff) via Distance.tools API
 *   Phase 2: Open ocean (handoff A → handoff B) — straight line or weather routing
 *   Phase 3: Coastal arrival (30nm handoff → destination) via Distance.tools API
 * 
 * For short routes (<60nm total), uses a single API call for the whole journey.
 * 
 * Falls back to straight-line routing if:
 *   - API key is missing
 *   - API request fails
 *   - Route is too short to need phasing
 */

import * as turf from '@turf/turf';

// ── Types ──────────────────────────────────────────────────────────

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

// ── Distance.tools API ─────────────────────────────────────────────

// Use the Vite dev proxy to avoid CORS (browser → Vite → API)
// In production, this routes through a Vercel/Supabase proxy function
const API_BASE = '/api/distance-tools';
const HANDOFF_NM = 30; // Distance from coast to switch engines
const SHORT_ROUTE_NM = 60; // Routes shorter than this use a single API call

/**
 * Call Distance.tools maritime routing API.
 * Returns an array of [lon, lat] coordinates and distance in NM.
 */
async function callDistanceToolsAPI(
    originLat: number, originLon: number,
    destLat: number, destLon: number,
): Promise<{ coordinates: [number, number][]; distanceNM: number } | null> {
    // API key is injected by the Vite proxy (dev) or edge function (prod)
    // so we don't send it from the browser — avoids exposing it in client JS

    try {
        const resp = await fetch(`${API_BASE}/routing/maritime`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                route: [
                    { lat: originLat, lng: originLon },
                    { lat: destLat, lng: destLon },
                ],
            }),
        });

        if (!resp.ok) {
            console.error(`[Orchestrator] Distance.tools API error: ${resp.status} ${resp.statusText}`);
            return null;
        }

        const data = await resp.json();

        // Extract route geometry from OSRM-style response
        // The response has routes[0].geometry with coordinates
        if (!data.routes || data.routes.length === 0) {
            console.warn('[Orchestrator] Distance.tools returned no routes');
            return null;
        }

        const route = data.routes[0];
        const distanceMeters = route.distance || 0;
        const distanceNM = distanceMeters / 1852; // meters to NM

        // Extract coordinates from geometry
        let coordinates: [number, number][] = [];

        if (route.geometry) {
            if (typeof route.geometry === 'string') {
                // Polyline encoded — decode it
                coordinates = decodePolyline(route.geometry);
            } else if (route.geometry.coordinates) {
                // GeoJSON format
                coordinates = route.geometry.coordinates as [number, number][];
            }
        }

        // Fallback: extract from legs/steps if geometry is empty
        if (coordinates.length === 0 && route.legs) {
            for (const leg of route.legs) {
                if (leg.steps) {
                    for (const step of leg.steps) {
                        if (step.geometry?.coordinates) {
                            coordinates.push(...step.geometry.coordinates);
                        }
                    }
                }
            }
        }

        if (coordinates.length === 0) {
            console.warn('[Orchestrator] Distance.tools returned route with no geometry');
            return null;
        }

        console.log(`[Orchestrator] Distance.tools: ${coordinates.length} WPs, ${distanceNM.toFixed(1)} NM`);
        return { coordinates, distanceNM };

    } catch (err) {
        console.error('[Orchestrator] Distance.tools API call failed:', err);
        return null;
    }
}

/**
 * Decode a polyline-encoded string into [lon, lat] coordinates.
 * Google polyline encoding format.
 */
function decodePolyline(encoded: string): [number, number][] {
    const coords: [number, number][] = [];
    let index = 0;
    let lat = 0;
    let lng = 0;

    while (index < encoded.length) {
        let b: number;
        let shift = 0;
        let result = 0;

        do {
            b = encoded.charCodeAt(index++) - 63;
            result |= (b & 0x1f) << shift;
            shift += 5;
        } while (b >= 0x20);

        lat += (result & 1) ? ~(result >> 1) : (result >> 1);

        shift = 0;
        result = 0;

        do {
            b = encoded.charCodeAt(index++) - 63;
            result |= (b & 0x1f) << shift;
            shift += 5;
        } while (b >= 0x20);

        lng += (result & 1) ? ~(result >> 1) : (result >> 1);

        // Return as [lon, lat] for GeoJSON compatibility
        coords.push([lng / 1e5, lat / 1e5]);
    }

    return coords;
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
 * Route from origin to destination using 3-phase pipeline:
 * 
 * Short routes (<60nm): Single Distance.tools API call
 * Long routes: 
 *   Phase 1: Coast departure via API (origin → 30nm handoff)
 *   Phase 2: Open ocean straight line (handoff A → handoff B)
 *   Phase 3: Coast arrival via API (30nm handoff → destination)
 */
export async function orchestrateRoute(
    originLat: number,
    originLon: number,
    destLat: number,
    destLon: number,
    vesselDraft: number = 2.5,
    _region: string = 'se_queensland',
): Promise<OrchestratedRoute | null> {
    const t0 = performance.now();
    const engines: string[] = [];
    const segments: OrchestratedRoute['segments'] = [];

    const totalDistNM = haversineNM(originLat, originLon, destLat, destLon);
    console.log(`[Orchestrator] Route: [${originLat.toFixed(4)}, ${originLon.toFixed(4)}] → [${destLat.toFixed(4)}, ${destLon.toFixed(4)}] (${totalDistNM.toFixed(1)} NM)`);

    let allCoords: [number, number][] = [];

    // ── Short route: single API call ──────────────────────────────
    if (totalDistNM < SHORT_ROUTE_NM) {
        console.log('[Orchestrator] Short route — single API call');

        const result = await callDistanceToolsAPI(originLat, originLon, destLat, destLon);

        if (result) {
            engines.push('distance_tools');
            allCoords = result.coordinates;
            segments.push({
                engine: 'distance_tools',
                coordinates: result.coordinates,
                distanceNM: result.distanceNM,
            });
        } else {
            // Fallback: straight line
            console.warn('[Orchestrator] API failed — falling back to straight line');
            engines.push('straight_line');
            allCoords = [[originLon, originLat], [destLon, destLat]];
            segments.push({
                engine: 'straight_line',
                coordinates: allCoords,
                distanceNM: totalDistNM,
            });
        }

    } else {
        // ── Long route: 3-phase pipeline ──────────────────────────

        // Calculate handoff points using Turf.js
        const originPt = turf.point([originLon, originLat]);
        const destPt = turf.point([destLon, destLat]);

        // Phase 1: Departure handoff — 30nm from origin toward destination
        const bearingOut = turf.bearing(originPt, destPt);
        const handoffA = turf.destination(originPt, HANDOFF_NM, bearingOut, { units: 'nauticalmiles' });
        const [handoffALon, handoffALat] = handoffA.geometry.coordinates;

        // Phase 3: Arrival handoff — 30nm from destination toward origin
        const bearingBack = turf.bearing(destPt, originPt);
        const handoffB = turf.destination(destPt, HANDOFF_NM, bearingBack, { units: 'nauticalmiles' });
        const [handoffBLon, handoffBLat] = handoffB.geometry.coordinates;

        console.log(`[Orchestrator] Handoffs: A=[${handoffALat.toFixed(4)}, ${handoffALon.toFixed(4)}] B=[${handoffBLat.toFixed(4)}, ${handoffBLon.toFixed(4)}]`);

        // ── Phase 1: Coastal departure ────────────────────────────
        console.log('[Orchestrator] Phase 1: Coastal departure...');
        const phase1 = await callDistanceToolsAPI(originLat, originLon, handoffALat, handoffALon);

        if (phase1) {
            engines.push('distance_tools_departure');
            allCoords.push(...phase1.coordinates);
            segments.push({
                engine: 'distance_tools_departure',
                coordinates: phase1.coordinates,
                distanceNM: phase1.distanceNM,
            });
        } else {
            // Fallback: straight line to handoff
            allCoords.push([originLon, originLat], [handoffALon, handoffALat]);
            engines.push('straight_departure');
            segments.push({
                engine: 'straight_departure',
                coordinates: [[originLon, originLat], [handoffALon, handoffALat]],
                distanceNM: HANDOFF_NM,
            });
        }

        // ── Phase 2: Open ocean (straight line for now) ───────────
        // TODO: Replace with weather/isochrone routing
        console.log('[Orchestrator] Phase 2: Open ocean...');
        const oceanDistNM = haversineNM(handoffALat, handoffALon, handoffBLat, handoffBLon);
        engines.push('open_ocean');
        // Don't include the first point (it's the last of phase 1)
        allCoords.push([handoffBLon, handoffBLat]);
        segments.push({
            engine: 'open_ocean',
            coordinates: [[handoffALon, handoffALat], [handoffBLon, handoffBLat]],
            distanceNM: oceanDistNM,
        });

        // ── Phase 3: Coastal arrival ──────────────────────────────
        console.log('[Orchestrator] Phase 3: Coastal arrival...');
        const phase3 = await callDistanceToolsAPI(handoffBLat, handoffBLon, destLat, destLon);

        if (phase3) {
            engines.push('distance_tools_arrival');
            // Skip first point (overlaps with handoff B)
            allCoords.push(...phase3.coordinates.slice(1));
            segments.push({
                engine: 'distance_tools_arrival',
                coordinates: phase3.coordinates,
                distanceNM: phase3.distanceNM,
            });
        } else {
            // Fallback: straight line from handoff to destination
            allCoords.push([destLon, destLat]);
            engines.push('straight_arrival');
            segments.push({
                engine: 'straight_arrival',
                coordinates: [[handoffBLon, handoffBLat], [destLon, destLat]],
                distanceNM: HANDOFF_NM,
            });
        }
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
