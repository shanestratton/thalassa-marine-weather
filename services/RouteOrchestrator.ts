/**
 * Route Orchestrator v6 — Pre-defined Marina Exit Waypoints
 *
 * Simple, reliable approach:
 *   1. Check if origin is inside a marina polygon
 *   2. Look up the marina's pre-defined exit waypoint
 *   3. Route: origin → exit WP → destination
 *
 * No graph routing, no A*, no centerline chaining.
 * Every skipper knows how to get from their berth to the canal exit.
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

interface MarinaExit {
    exit_lat: number;
    exit_lon: number;
    centroid_lat: number;
    centroid_lon: number;
    nearest_channel: string;
    channel_dist_m: number;
}

// ── Data loading ───────────────────────────────────────────────────

let zonesData: { features: WaterwayZone[] } | null = null;
let marinaExits: Record<string, MarinaExit> | null = null;

async function loadZones(): Promise<{ features: WaterwayZone[] }> {
    if (zonesData) return zonesData;
    try {
        const resp = await fetch('/data/waterway_zones.geojson');
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        zonesData = await resp.json();
        const marinas = zonesData!.features.filter(f => f.properties.zone_type === 'marina').length;
        console.log(`[Orchestrator] Loaded SE QLD zones: ${marinas} marinas`);
        return zonesData!;
    } catch (err) {
        console.error('[Orchestrator] Failed to load zones:', err);
        return { features: [] };
    }
}

async function loadMarinaExits(): Promise<Record<string, MarinaExit>> {
    if (marinaExits) return marinaExits;
    try {
        const resp = await fetch('/data/marina_exits.json');
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        marinaExits = await resp.json();
        console.log(`[Orchestrator] Loaded ${Object.keys(marinaExits!).length} marina exit waypoints`);
        return marinaExits!;
    } catch (err) {
        console.error('[Orchestrator] Failed to load marina exits:', err);
        return {};
    }
}

// ── Geometry helpers ───────────────────────────────────────────────

function fastDistM(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const dx = (lon2 - lon1) * Math.cos(((lat1 + lat2) / 2) * Math.PI / 180) * 111320;
    const dy = (lat2 - lat1) * 111320;
    return Math.sqrt(dx * dx + dy * dy);
}

function totalDistanceNM(coords: [number, number][]): number {
    let total = 0;
    for (let i = 1; i < coords.length; i++) {
        total += fastDistM(coords[i - 1][1], coords[i - 1][0], coords[i][1], coords[i][0]);
    }
    return total / 1852;
}

// ── Zone detection ─────────────────────────────────────────────────

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
            } catch { /* skip */ }
        }
    }
    return null;
}

function findNearestMarina(
    lon: number, lat: number, zones: WaterwayZone[], maxDistM: number = 1000
): WaterwayZone | null {
    let best: { zone: WaterwayZone; dist: number } | null = null;
    for (const zone of zones) {
        if (zone.properties.zone_type !== 'marina' || zone.geometry.type !== 'Polygon') continue;
        // Check distance to centroid
        const boundary = zone.geometry.coordinates[0];
        const cx = boundary.reduce((s, v) => s + v[0], 0) / boundary.length;
        const cy = boundary.reduce((s, v) => s + v[1], 0) / boundary.length;
        const d = fastDistM(lat, lon, cy, cx);
        if (d < maxDistM && (!best || d < best.dist)) {
            best = { zone, dist: d };
        }
    }
    return best ? best.zone : null;
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

    console.log(`[Orchestrator] Route: [${originLat.toFixed(4)}, ${originLon.toFixed(4)}] → [${destLat.toFixed(4)}, ${destLon.toFixed(4)}]`);

    // Load data
    const [zones, exits] = await Promise.all([loadZones(), loadMarinaExits()]);
    if (zones.features.length === 0) {
        console.warn('[Orchestrator] No zone data — returning null');
        return null;
    }

    // ── Check if origin is in/near a marina ────────────────────────
    let marina = findContainingMarina(originLon, originLat, zones.features);
    if (!marina) {
        marina = findNearestMarina(originLon, originLat, zones.features, 500);
    }

    if (!marina) {
        console.log('[Orchestrator] ⚓ Not in/near a marina — AI handles route');
        return null;
    }

    const marinaName = marina.properties.name;
    console.log(`[Orchestrator] 🏗 Marina: ${marinaName}`);

    // ── Look up exit waypoint ──────────────────────────────────────
    const exit = exits[marinaName];
    if (!exit) {
        console.warn(`[Orchestrator] No exit waypoint for "${marinaName}" — returning null`);
        return null;
    }

    console.log(`[Orchestrator] Exit WP: [${exit.exit_lat.toFixed(5)}, ${exit.exit_lon.toFixed(5)}] via ${exit.nearest_channel}`);

    // ── Build route: origin → exit WP → destination ────────────────
    const exitCoords: [number, number][] = [
        [originLon, originLat],          // Start: boat position
        [exit.exit_lon, exit.exit_lat],   // Exit: canal mouth
        [destLon, destLat],              // End: destination
    ];

    const totalNM = totalDistanceNM(exitCoords);
    const computeMs = performance.now() - t0;
    const engines = ['marina_exit'];

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
        `${computeMs.toFixed(0)}ms [marina_exit: ${marinaName}]`
    );

    return {
        coordinates: exitCoords,
        totalNM: Math.round(totalNM * 10) / 10,
        computeMs: Math.round(computeMs),
        engines,
        waypointCount: exitCoords.length,
        segments: [{
            engine: 'marina_exit',
            coordinates: exitCoords,
            distanceNM: totalNM,
        }],
        geojson,
    };
}
