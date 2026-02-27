/**
 * Route Orchestrator v5 — Graph-based Waterway Router
 *
 * Uses A* pathfinding on the OSM waterway graph for precise canal routing.
 * Every canal turn followed, no land crossings, works for any marina in SE QLD.
 *
 * Three-tier routing:
 *   Tier A (Marina): Origin inside leisure=marina → graph pathfind to open water
 *   Tier B (River/Canal): Origin near waterway → graph pathfind downstream
 *   Tier C (Bay/Open): Origin in open water → return null (AI handles it)
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

        console.log(`[Orchestrator] Loaded SE QLD zones: ${marinas} marinas, ${waterways} waterways`);
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
            } catch { /* skip malformed */ }
        }
    }
    return null;
}

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

function isNearWaterway(
    lon: number, lat: number, zones: WaterwayZone[], maxDistM: number = 1000
): boolean {
    for (const zone of zones) {
        const zt = zone.properties.zone_type;
        if (zt !== 'waterway_centerline' && zt !== 'channel_centerline') continue;
        if (zone.geometry.type !== 'LineString') continue;
        const coords = zone.geometry.coordinates as [number, number][];
        for (const c of coords) {
            if (fastDistM(lat, lon, c[1], c[0]) < maxDistM) return true;
        }
    }
    return false;
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

    // Load zone data for marina/safe-water detection
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

    // ── Determine tier ─────────────────────────────────────────────
    const marina = findContainingMarina(originLon, originLat, zones.features);
    const nearWaterway = isNearWaterway(originLon, originLat, zones.features, 1000);

    if (!marina && !nearWaterway) {
        console.log('[Orchestrator] ⚓ Tier C — OPEN WATER — AI handles route');
        return null;
    }

    const tierName = marina ? `Tier A — MARINA: ${marina.properties.name}` : 'Tier B — WATERWAY';
    const engineName = marina ? 'marina_exit' : 'waterway_follow';
    console.log(`[Orchestrator] 🏗 ${tierName}`);

    // ── Graph-based A* routing ─────────────────────────────────────
    // Route through the OSM waterway graph — follows every canal turn
    const result = await graphRoute(originLat, originLon, destLat, destLon);

    if (!result) {
        console.warn(`[Orchestrator] Graph routing failed — no path found`);
        return null;
    }

    const exitCoords = result.coords;
    engines.push(engineName);
    segments.push({
        engine: engineName,
        coordinates: exitCoords,
        distanceNM: result.distNM,
    });
    console.log(`[Orchestrator] ${engineName}: ${exitCoords.length} WPs, ${result.distNM.toFixed(1)} NM (snap: ${result.snapDistM.toFixed(0)}m)`);

    // ── Build result ───────────────────────────────────────────────

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
