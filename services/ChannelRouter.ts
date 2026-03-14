/**
 * ChannelRouter v8 — Simple Channel Exit Route
 *
 * After 7 iterations of graph-based approaches, we learned that GEBCO
 * depth data is too coarse for harbour-scale land avoidance — residential
 * canal estates (e.g. Pelican Canal, Kingfisher Canal at Redcliffe)
 * appear as "water" at GEBCO resolution, breaking all land detection.
 *
 * This version takes a fundamentally different approach:
 *   - No graph, no Dijkstra, no depth-based land detection
 *   - Routes through 2-3 key marks: nearest mark → channel exit mark → gate
 *   - The "channel exit" is the outermost nav mark closest to the gate
 *   - Queries depth ONLY at the final waypoints for safety annotation
 *
 * This mirrors how sailors actually navigate: leave the marina, head for
 * the nearest channel mark, follow marks outward to the sea buoy, then
 * proceed to open water.
 */

import { createLogger } from '../utils/createLogger';
import { GebcoDepthService } from './GebcoDepthService';
import type { SeamarkCollection, SeamarkFeature } from './SeamarkService';

const log = createLogger('ChannelRouter');

// ── Types ──────────────────────────────────────────────────────

export interface ChannelWaypoint {
    lat: number;
    lon: number;
    depth_m: number;
    safety: 'safe' | 'caution' | 'danger' | 'land';
    distanceNM: number;
    nearestMark?: {
        name: string;
        class: string;
        distanceM: number;
    };
}

export interface ChannelRouteResult {
    waypoints: ChannelWaypoint[];
    totalDistanceNM: number;
    minDepth_m: number;
    hasShallowSections: boolean;
    seamarkAssisted: boolean;
    seamarkCount: number;
    ialaRegion: 'A' | 'B';
}

// ── Geo Helpers ────────────────────────────────────────────────

const DEG_TO_RAD = Math.PI / 180;

function distNM(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const dlat = lat2 - lat1;
    const dlon = (lon2 - lon1) * Math.cos(((lat1 + lat2) / 2) * DEG_TO_RAD);
    return Math.sqrt(dlat * dlat + dlon * dlon) * 60;
}

function classifyDepth(depth_m: number, draft_m: number): 'safe' | 'caution' | 'danger' | 'land' {
    if (depth_m >= 0) return 'land';
    const abs = Math.abs(depth_m);
    if (abs > draft_m * 3) return 'safe';
    if (abs > draft_m * 1.5) return 'caution';
    return 'danger';
}

// ── Constants ──────────────────────────────────────────────────

/** Navigation mark classes relevant for channel routing */
const NAV_CLASSES = new Set([
    'port', 'starboard', 'lateral',
    'cardinal_n', 'cardinal_s', 'cardinal_e', 'cardinal_w', 'cardinal',
    'safe_water', 'fairway',
    'light_major', 'light_minor', 'light',
]);

/** Max distance to search for marks near departure/arrival */
const SEARCH_RADIUS_NM = 5.0;

// ── Main Router ────────────────────────────────────────────────

export async function routeChannel(
    startLat: number,
    startLon: number,
    endLat: number,
    endLon: number,
    draft_m: number,
    seamarks: SeamarkCollection,
): Promise<ChannelRouteResult> {
    const totalNM = distNM(startLat, startLon, endLat, endLon);
    log.info(`Channel routing: ~${totalNM.toFixed(1)} NM, ${seamarks.features.length} seamarks`);

    // Filter to navigation marks
    const navMarks = seamarks.features.filter(f => NAV_CLASSES.has(f.properties._class));
    log.info(`Nav marks: ${navMarks.length}`);

    if (navMarks.length === 0) {
        log.info('No nav marks — direct route');
        return buildDirectRoute(startLat, startLon, endLat, endLon, draft_m, seamarks);
    }

    // ── Find key marks ──
    // 1. Nearest mark to departure (marina channel mark)
    // 2. Marks along the route, sorted by distance to gate
    // 3. Outermost mark (closest to gate = channel exit)

    interface MarkWithDist {
        mark: SeamarkFeature;
        lat: number;
        lon: number;
        distToStart: number;
        distToEnd: number;
    }

    const marksInRange: MarkWithDist[] = [];
    for (const mark of navMarks) {
        const [mLon, mLat] = mark.geometry.coordinates;
        const dStart = distNM(mLat, mLon, startLat, startLon);
        if (dStart <= SEARCH_RADIUS_NM) {
            marksInRange.push({
                mark,
                lat: mLat,
                lon: mLon,
                distToStart: dStart,
                distToEnd: distNM(mLat, mLon, endLat, endLon),
            });
        }
    }

    if (marksInRange.length === 0) {
        log.info('No marks within range — direct route');
        return buildDirectRoute(startLat, startLon, endLat, endLon, draft_m, seamarks);
    }

    // Sort by distance to start
    marksInRange.sort((a, b) => a.distToStart - b.distToStart);

    // Nearest mark to departure
    const nearestMark = marksInRange[0];
    log.info(`Nearest mark: "${nearestMark.mark.properties.name || nearestMark.mark.properties._class}" @ ${nearestMark.distToStart.toFixed(2)} NM`);

    // Channel exit: the mark closest to the gate (farthest from departure in gate direction)
    const channelExit = marksInRange.reduce((best, m) =>
        m.distToEnd < best.distToEnd ? m : best
    );
    log.info(`Channel exit: "${channelExit.mark.properties.name || channelExit.mark.properties._class}" @ ${channelExit.distToEnd.toFixed(1)} NM from gate`);

    // Deduplicate co-located marks (port/starboard pairs at same spot)
    // Keep only one mark per ~90m area to avoid zigzagging across channel
    const deduped: MarkWithDist[] = [];
    for (const m of marksInRange) {
        const tooClose = deduped.some(d =>
            distNM(d.lat, d.lon, m.lat, m.lon) < 0.05 // 0.05 NM ≈ 90m
        );
        if (!tooClose) deduped.push(m);
    }
    log.info(`Deduped: ${marksInRange.length} → ${deduped.length} marks`);

    // Build waypoint chain: departure → walk through marks → gate
    //
    // Gate-progress walk: from each mark, pick the reachable mark (within 3 NM)
    // that's CLOSEST TO THE GATE. This follows the channel outward without
    // zigzagging between port/starboard pairs.
    const chain: { lat: number; lon: number; mark?: SeamarkFeature }[] = [
        { lat: startLat, lon: startLon },
        { lat: nearestMark.lat, lon: nearestMark.lon, mark: nearestMark.mark },
    ];

    const used = new Set<MarkWithDist>([nearestMark]);
    let current = nearestMark;
    const MAX_HOPS = 15;

    for (let hop = 0; hop < MAX_HOPS; hop++) {
        // Find the reachable mark closest to the GATE (most progress)
        let bestNext: MarkWithDist | null = null;
        let bestDistToEnd = Infinity;

        for (const m of deduped) {
            if (used.has(m)) continue;
            // Must make progress toward the gate
            if (m.distToEnd >= current.distToEnd) continue;

            const stepDist = distNM(current.lat, current.lon, m.lat, m.lon);
            if (stepDist > 3.0) continue;

            // Prioritise GATE PROGRESS (smallest distToEnd wins)
            if (m.distToEnd < bestDistToEnd) {
                bestDistToEnd = m.distToEnd;
                bestNext = m;
            }
        }

        if (!bestNext) break;

        chain.push({ lat: bestNext.lat, lon: bestNext.lon, mark: bestNext.mark });
        used.add(bestNext);
        current = bestNext;
    }

    // Add gate
    chain.push({ lat: endLat, lon: endLon });

    log.info(`Chain: ${chain.length} waypoints (${chain.filter(p => p.mark).length} marks)`);

    // ── Query depth at waypoints ──
    const wpPoints = chain.map(p => ({ lat: p.lat, lon: p.lon }));
    let wpDepths: (number | null)[] = new Array(wpPoints.length).fill(-100);
    try {
        const results = await GebcoDepthService.queryDepths(wpPoints);
        wpDepths = results.map(r => r.depth_m);
    } catch {
        log.warn('Waypoint depth query failed — using defaults');
    }

    // ── Build result ──
    let cumDist = 0;
    let minDepth = 0;
    let hasShallow = false;

    const waypoints: ChannelWaypoint[] = chain.map((point, i) => {
        if (i > 0) cumDist += distNM(chain[i - 1].lat, chain[i - 1].lon, point.lat, point.lon);

        const depth = wpDepths[i] ?? -100;
        const safety = classifyDepth(depth, draft_m);
        if (safety === 'caution' || safety === 'danger') hasShallow = true;
        if (depth < minDepth) minDepth = depth;

        const wp: ChannelWaypoint = {
            lat: point.lat, lon: point.lon,
            depth_m: depth, safety, distanceNM: cumDist,
        };

        if (point.mark) {
            wp.nearestMark = {
                name: point.mark.properties.name || point.mark.properties._type,
                class: point.mark.properties._class,
                distanceM: 0,
            };
        }

        return wp;
    });

    log.info(`Route: ${waypoints.length} wps, ${cumDist.toFixed(1)} NM, min depth ${minDepth}m`);

    return {
        waypoints,
        totalDistanceNM: cumDist,
        minDepth_m: minDepth,
        hasShallowSections: hasShallow,
        seamarkAssisted: true,
        seamarkCount: navMarks.length,
        ialaRegion: seamarks.metadata.ialaRegion,
    };
}

// ── Direct Route Fallback ──────────────────────────────────────

async function buildDirectRoute(
    startLat: number, startLon: number,
    endLat: number, endLon: number,
    draft_m: number,
    seamarks: SeamarkCollection,
): Promise<ChannelRouteResult> {
    const d = distNM(startLat, startLon, endLat, endLon);
    return {
        waypoints: [
            { lat: startLat, lon: startLon, depth_m: -100, safety: 'safe', distanceNM: 0 },
            { lat: endLat, lon: endLon, depth_m: -100, safety: 'safe', distanceNM: d },
        ],
        totalDistanceNM: d,
        minDepth_m: -100,
        hasShallowSections: false,
        seamarkAssisted: false,
        seamarkCount: seamarks.features.length,
        ialaRegion: seamarks.metadata.ialaRegion,
    };
}

// ── Test helpers — export internal pure functions for unit testing ──
export const _testableInternals = {
    distNM,
    classifyDepth,
};
