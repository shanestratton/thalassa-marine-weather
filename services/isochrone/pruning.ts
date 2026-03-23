/**
 * Isochrone Router — Wavefront pruning.
 *
 * Sector-based pruning with fallback candidates for land avoidance.
 * Uses fast equirectangular bearing for sector assignment.
 */

import type { IsochroneNode } from './types';

// Precompute cosine for equirectangular bearing approximation
let _eqCosLat = 0;
let _eqCosLatCached = NaN;
function eqBearing(originLat: number, originLon: number, nodeLat: number, nodeLon: number): number {
    // Cache cos(originLat) — it's the same for every node in a step
    if (originLat !== _eqCosLatCached) {
        _eqCosLat = Math.cos((originLat * Math.PI) / 180);
        _eqCosLatCached = originLat;
    }
    const dLon = (nodeLon - originLon) * _eqCosLat;
    const dLat = nodeLat - originLat;
    return ((Math.atan2(dLon, dLat) * 180) / Math.PI + 360) % 360;
}

/**
 * Prune a wavefront, returning an array-of-arrays: one ranked list
 * per sector (best candidate first). This lets the caller try fallback
 * candidates when the sector winner crosses land.
 *
 * Uses equirectangular flat-earth bearing for sector assignment (fast).
 */
export function pruneWavefrontWithFallbacks(
    entries: { node: IsochroneNode; distToDest: number }[],
    origin: { lat: number; lon: number },
    destination: { lat: number; lon: number },
    sectorCount: number,
    explorationMode?: boolean,
): IsochroneNode[][] {
    const sectorSize = 360 / sectorCount;
    // Each sector holds up to 3 candidates, sorted by ranking metric
    const MAX_PER_SECTOR = 3;
    const sectors: { node: IsochroneNode; rank: number }[][] = new Array(sectorCount);
    for (let i = 0; i < sectorCount; i++) sectors[i] = [];

    // Suppress unused variable — destination is reserved for future directional weighting
    void destination;

    for (const { node, distToDest } of entries) {
        const bearing = eqBearing(origin.lat, origin.lon, node.lat, node.lon);
        const sectorIdx = Math.floor(bearing / sectorSize) % sectorCount;
        const bucket = sectors[sectorIdx];

        // In exploration mode: rank by NEGATIVE distance from origin (most explored = best)
        // In normal mode: rank by distance to destination (closest = best)
        const rankValue = explorationMode ? -node.distance : distToDest;

        if (bucket.length < MAX_PER_SECTOR) {
            bucket.push({ node, rank: rankValue });
            // Keep sorted (insertion sort — max 3 items)
            for (let j = bucket.length - 1; j > 0 && bucket[j].rank < bucket[j - 1].rank; j--) {
                [bucket[j], bucket[j - 1]] = [bucket[j - 1], bucket[j]];
            }
        } else if (rankValue < bucket[MAX_PER_SECTOR - 1].rank) {
            // Better than the worst in the bucket — replace it
            bucket[MAX_PER_SECTOR - 1] = { node, rank: rankValue };
            for (let j = MAX_PER_SECTOR - 1; j > 0 && bucket[j].rank < bucket[j - 1].rank; j--) {
                [bucket[j], bucket[j - 1]] = [bucket[j - 1], bucket[j]];
            }
        }
    }

    // Return non-empty sectors as ranked arrays of IsochroneNode[]
    return sectors.filter((b) => b.length > 0).map((b) => b.map((e) => e.node));
}
