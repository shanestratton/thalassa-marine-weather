/**
 * Route Orchestrator v4 — SE QLD Routing Sandbox
 *
 * Three-tier exit routing engine:
 *   Tier A (Marina): Origin inside leisure=marina → snap to channel centerline,
 *                    follow through red/green leads to safe water
 *   Tier B (River/Canal): Origin near waterway=river/canal → snap to centerline,
 *                         follow downstream to bay
 *   Tier C (Bay/Open): Origin in open water → return null (AI handles it)
 *
 * Uses real OSM geometry from waterway_zones.geojson:
 *   - 38 marina polygons (leisure=marina)
 *   - 397 waterway centerlines (waterway=river/canal/fairway)
 *   - 11 IALA channel centerlines (paired port/starboard marks)
 *   - 3 safe water exit geofences (NW Channel, South Passage, GC Seaway)
 *
 * Zero API costs. Runs entirely client-side.
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

type ZoneType = 'marina' | 'waterway_centerline' | 'channel_centerline' | 'river' | 'safe_water_exit';

interface WaterwayZone {
    type: 'Feature';
    properties: {
        zone_type: ZoneType;
        name: string;
        waterway?: string;
        osm_id?: number;
        source?: string;
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
        const waterways = zonesData!.features.filter(f =>
            f.properties.zone_type === 'waterway_centerline' ||
            f.properties.zone_type === 'channel_centerline'
        ).length;
        const exits = zonesData!.features.filter(f => f.properties.zone_type === 'safe_water_exit').length;

        console.log(`[Orchestrator] Loaded SE QLD sandbox: ${marinas} marinas, ${waterways} waterways, ${exits} exits`);
        return zonesData!;
    } catch (err) {
        console.error('[Orchestrator] Failed to load waterway zones:', err);
        return { features: [] };
    }
}

// ── Geometry helpers ───────────────────────────────────────────────

function fastDistM(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const dx = (lon2 - lon1) * Math.cos(((lat1 + lat2) / 2) * Math.PI / 180) * 111320;
    const dy = (lat2 - lat1) * 111320;
    return Math.sqrt(dx * dx + dy * dy);
}

function metersToNM(m: number): number {
    return m / 1852;
}

function totalDistanceNM(coords: [number, number][]): number {
    let total = 0;
    for (let i = 1; i < coords.length; i++) {
        total += fastDistM(coords[i - 1][1], coords[i - 1][0], coords[i][1], coords[i][0]);
    }
    return metersToNM(total);
}

// ── Zone detection ─────────────────────────────────────────────────

/**
 * Check if point is inside any marina polygon.
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
            } catch { /* skip malformed */ }
        }
    }
    return null;
}

/**
 * Check if point is inside a safe water exit geofence.
 */
function isInSafeWater(
    lon: number, lat: number, zones: WaterwayZone[]
): WaterwayZone | null {
    const pt = turf.point([lon, lat]);
    for (const zone of zones) {
        if (zone.properties.zone_type === 'safe_water_exit' && zone.geometry.type === 'Polygon') {
            try {
                if (turf.booleanPointInPolygon(pt, zone as any)) {
                    return zone;
                }
            } catch { /* skip */ }
        }
    }
    return null;
}

// ── Centerline operations ──────────────────────────────────────────

/**
 * Find the nearest centerline (IALA channel or OSM waterway) to a point.
 * Prefers channel_centerline over waterway_centerline when equidistant.
 */
function findNearestCenterline(
    lon: number, lat: number, zones: WaterwayZone[], maxDistM: number = 2000
): { feature: WaterwayZone; nearestIdx: number; distM: number } | null {
    let best: { feature: WaterwayZone; nearestIdx: number; distM: number } | null = null;

    for (const zone of zones) {
        const zt = zone.properties.zone_type;
        if (zt !== 'waterway_centerline' && zt !== 'channel_centerline') continue;
        if (zone.geometry.type !== 'LineString') continue;

        const coords = zone.geometry.coordinates as [number, number][];
        for (let i = 0; i < coords.length; i++) {
            const d = fastDistM(lat, lon, coords[i][1], coords[i][0]);
            if (d < maxDistM) {
                // Prefer channel_centerline (IALA) over waterway_centerline (OSM)
                if (!best || d < best.distM ||
                    (d === best.distM && zt === 'channel_centerline')) {
                    best = { feature: zone, nearestIdx: i, distM: d };
                }
            }
        }
    }

    return best;
}

/**
 * Follow a centerline from a starting index toward the end that is
 * closer to the destination. If we hit a safe water exit geofence,
 * we can stop early.
 */
function followCenterline(
    centerline: WaterwayZone,
    startIdx: number,
    destLon: number,
    destLat: number,
    zones: WaterwayZone[],
): [number, number][] {
    const coords = centerline.geometry.coordinates as [number, number][];

    // Determine direction: follow toward whichever end is closer to destination
    const distToStart = fastDistM(destLat, destLon, coords[0][1], coords[0][0]);
    const distToEnd = fastDistM(destLat, destLon, coords[coords.length - 1][1], coords[coords.length - 1][0]);

    let route: [number, number][];
    if (distToEnd <= distToStart) {
        // Follow toward end (downstream)
        route = coords.slice(startIdx);
    } else {
        // Follow toward start (upstream/reversed)
        route = coords.slice(0, startIdx + 1).reverse();
    }

    // Check if any point along the route enters a safe water exit zone
    // If so, truncate the route there
    for (let i = 0; i < route.length; i++) {
        const exitZone = isInSafeWater(route[i][0], route[i][1], zones);
        if (exitZone) {
            console.log(`[Orchestrator] 🏁 Reached safe water: ${exitZone.properties.name} at WP ${i}`);
            return route.slice(0, i + 1);
        }
    }

    return route;
}

/**
 * Try to chain multiple centerline segments together to build a longer route.
 * When one centerline ends, look for the next nearest one and continue.
 */
function chainCenterlines(
    startLon: number, startLat: number,
    destLon: number, destLat: number,
    zones: WaterwayZone[],
    maxChains: number = 5,
): [number, number][] | null {
    const allCoords: [number, number][] = [[startLon, startLat]];
    const usedIds = new Set<string>();
    let currentLon = startLon;
    let currentLat = startLat;

    for (let chain = 0; chain < maxChains; chain++) {
        const nearest = findNearestCenterline(currentLon, currentLat, zones, 3000);
        if (!nearest) break;

        const featureId = `${nearest.feature.properties.name}_${nearest.feature.properties.osm_id || ''}`;
        if (usedIds.has(featureId)) break; // Don't loop
        usedIds.add(featureId);

        const route = followCenterline(
            nearest.feature,
            nearest.nearestIdx,
            destLon,
            destLat,
            zones,
        );

        if (route.length > 0) {
            // Skip first point (overlap with current position)
            allCoords.push(...route);
            const lastPt = route[route.length - 1];
            currentLon = lastPt[0];
            currentLat = lastPt[1];

            // Check if we've reached safe water
            const exitZone = isInSafeWater(currentLon, currentLat, zones);
            if (exitZone) {
                console.log(`[Orchestrator] 🏁 Reached safe water after ${chain + 1} segments`);
                break;
            }

            // Check if we're making progress toward destination
            const distToDest = fastDistM(currentLat, currentLon, destLat, destLon);
            if (distToDest < 500) {
                break; // Close enough to destination
            }
        }
    }

    return allCoords.length > 1 ? allCoords : null;
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

    // ── Pre-check: Is origin already in safe water? ────────────────
    const originSafe = isInSafeWater(originLon, originLat, zones.features);
    if (originSafe) {
        console.log(`[Orchestrator] ⚓ Origin already in safe water: ${originSafe.properties.name} — AI handles`);
        return null;
    }

    let exitCoords: [number, number][] | null = null;

    // ══════════════════════════════════════════════════════════════
    // TIER A: MARINA EXIT
    // ══════════════════════════════════════════════════════════════
    const marina = findContainingMarina(originLon, originLat, zones.features);

    if (marina) {
        console.log(`[Orchestrator] 🏗 Tier A — MARINA: ${marina.properties.name}`);

        // Find nearest centerline from boat position (not polygon centroid)
        exitCoords = chainCenterlines(originLon, originLat, destLon, destLat, zones.features);

        if (exitCoords) {
            engines.push('marina_exit');
            segments.push({
                engine: 'marina_exit',
                coordinates: exitCoords,
                distanceNM: totalDistanceNM(exitCoords),
            });
            console.log(`[Orchestrator] Marina exit: ${exitCoords.length} WPs via centerline chain`);
        } else {
            console.warn(`[Orchestrator] No centerline found near ${marina.properties.name}`);
            return null;
        }
    }

    // ══════════════════════════════════════════════════════════════
    // TIER B: RIVER/CANAL SNAP
    // ══════════════════════════════════════════════════════════════
    if (!marina) {
        const nearest = findNearestCenterline(originLon, originLat, zones.features, 1000);

        if (nearest) {
            console.log(
                `[Orchestrator] 🌊 Tier B — WATERWAY: ${nearest.feature.properties.name} ` +
                `(${nearest.distM.toFixed(0)}m, ${nearest.feature.properties.zone_type})`
            );

            exitCoords = chainCenterlines(originLon, originLat, destLon, destLat, zones.features);

            if (exitCoords) {
                engines.push('waterway_follow');
                segments.push({
                    engine: 'waterway_follow',
                    coordinates: exitCoords,
                    distanceNM: totalDistanceNM(exitCoords),
                });
                console.log(`[Orchestrator] Waterway route: ${exitCoords.length} WPs`);
            }
        } else {
            // ══════════════════════════════════════════════════════
            // TIER C: OPEN WATER
            // ══════════════════════════════════════════════════════
            console.log('[Orchestrator] ⚓ Tier C — OPEN WATER — AI handles route');
            return null;
        }
    }

    // ── Build result ───────────────────────────────────────────────

    if (!exitCoords || exitCoords.length === 0) return null;

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
