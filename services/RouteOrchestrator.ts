/**
 * Route Orchestrator v8 — Pre-computed Channel Waypoints
 *
 * Clean, simple approach:
 *   1. Detect marina → look up pre-defined exit WP + channel waypoints
 *   2. Canal-only A* from boat through canal network TO the exit WP
 *   3. Follow pre-computed channel waypoints to open water
 *   4. Straight line from channel end to destination
 *
 * No runtime channel-finding. No dynamic direction logic.
 * All channel waypoints pre-computed in marina_exits.json.
 */

import * as turf from '@turf/turf';
import { graphRoute } from './waterwayGraph';

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
    channel_waypoints?: [number, number][]; // pre-computed [lon, lat]
    channel_name?: string;
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
        const marinas = zonesData!.features.filter((f) => f.properties.zone_type === 'marina').length;
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
        const withChannel = Object.values(marinaExits!).filter(
            (e) => e.channel_waypoints && e.channel_waypoints.length > 0,
        ).length;
        return marinaExits!;
    } catch (err) {
        console.error('[Orchestrator] Failed to load marina exits:', err);
        return {};
    }
}

// ── Geometry helpers ───────────────────────────────────────────────

function fastDistM(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const dx = (lon2 - lon1) * Math.cos((((lat1 + lat2) / 2) * Math.PI) / 180) * 111320;
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

function findContainingMarina(lon: number, lat: number, zones: WaterwayZone[]): WaterwayZone | null {
    const pt = turf.point([lon, lat]);
    for (const zone of zones) {
        if (zone.properties.zone_type === 'marina' && zone.geometry.type === 'Polygon') {
            try {
                if (turf.booleanPointInPolygon(pt, zone as any)) {
                    return zone;
                }
            } catch (e) {
                console.warn('[RouteOrchestrator] skip:', e);
            }
        }
    }
    return null;
}

function findNearestMarina(
    lon: number,
    lat: number,
    zones: WaterwayZone[],
    maxDistM: number = 500,
): WaterwayZone | null {
    let best: { zone: WaterwayZone; dist: number } | null = null;
    for (const zone of zones) {
        if (zone.properties.zone_type !== 'marina' || zone.geometry.type !== 'Polygon') continue;
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
    // Load data
    const [zones, exits] = await Promise.all([loadZones(), loadMarinaExits()]);
    if (zones.features.length === 0) {
        return null;
    }

    // ── Check if origin is in/near a marina ────────────────────────
    let marina = findContainingMarina(originLon, originLat, zones.features);
    if (!marina) {
        marina = findNearestMarina(originLon, originLat, zones.features, 500);
    }

    if (!marina) {
        return null;
    }

    const marinaName = marina.properties.name;

    // ── Look up exit waypoint ──────────────────────────────────────
    const exit = exits[marinaName];
    if (!exit) {
        return null;
    }
    // ── BUILD ROUTE ────────────────────────────────────────────────

    const routeCoords: [number, number][] = [];

    // Phase 1: Canal A* from boat to exit WP
    const graphResult = await graphRoute(originLat, originLon, exit.exit_lat, exit.exit_lon);

    if (graphResult && graphResult.coords.length > 2 && graphResult.snapDistM < 500) {
        // A* succeeded — use canal path (replace first coord with actual origin)
        routeCoords.push([originLon, originLat]);
        for (let i = 1; i < graphResult.coords.length - 1; i++) {
            routeCoords.push(graphResult.coords[i]);
        }
    } else {
        // A* failed — straight line from origin
        routeCoords.push([originLon, originLat]);
    }

    // Phase 2: Exit WP (canal mouth)
    routeCoords.push([exit.exit_lon, exit.exit_lat]);

    // Phase 3: Pre-computed channel waypoints (if available)
    const channelWPs = exit.channel_waypoints || [];
    if (channelWPs.length > 0) {
        for (const wp of channelWPs) {
            routeCoords.push(wp as [number, number]);
        }
    }

    // Phase 4: Destination
    routeCoords.push([destLon, destLat]);

    // ── COMPUTE RESULT ─────────────────────────────────────────────

    const totalNM = totalDistanceNM(routeCoords);
    const computeMs = performance.now() - t0;
    const engines = graphResult && graphResult.snapDistM < 500 ? ['canal_astar', 'channel_follow'] : ['marina_exit'];

    const geojson: GeoJSON.Feature<GeoJSON.LineString> = {
        type: 'Feature',
        properties: {
            distanceNM: Math.round(totalNM * 10) / 10,
            waypointCount: routeCoords.length,
            computeMs: Math.round(computeMs),
            engines: engines.join('+'),
        },
        geometry: {
            type: 'LineString',
            coordinates: routeCoords,
        },
    };
    return {
        coordinates: routeCoords,
        totalNM: Math.round(totalNM * 10) / 10,
        computeMs: Math.round(computeMs),
        engines,
        waypointCount: routeCoords.length,
        segments: [
            {
                engine: engines.join('+'),
                coordinates: routeCoords,
                distanceNM: totalNM,
            },
        ],
        geojson,
    };
}
