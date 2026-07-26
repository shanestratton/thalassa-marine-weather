/**
 * inshoreTideSpots — carry charted tide constraints from an inshore route
 * into the departure-time sweep.
 *
 * The inshore engine reports contiguous shallow runs against the exact route
 * geometry. A VoyagePlan stores that geometry as JSON, so this small adapter
 * validates the persisted payload and maps each charted shallow run onto the
 * ETA leg that contains its shallowest known point. Keeping this conversion
 * outside the sheet makes the web and native planning paths use the same
 * tide-gating inputs.
 */

import type { ShallowRunInfo } from '../engine/types';
import type { ShallowSpot } from './DepartureSweepInshore';
import type { LonLat } from './TideAwareAnnotator';

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
    return typeof value === 'object' && value !== null;
}

function finiteNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function nonNegativeInteger(value: unknown): number | null {
    const number = finiteNumber(value);
    return number !== null && Number.isInteger(number) && number >= 0 ? number : null;
}

/**
 * Read the serialised `routeGeoJSON.properties.shallowRuns` safely. Route
 * plans can be restored from an older client or cloud record, so a malformed
 * property must merely omit tide gating — never make the whole planner fail.
 */
export function readPersistedShallowRuns(value: unknown): ShallowRunInfo[] {
    if (!Array.isArray(value)) return [];

    const runs: ShallowRunInfo[] = [];
    for (const candidate of value) {
        if (!isRecord(candidate)) continue;
        const startSeg = nonNegativeInteger(candidate.startSeg);
        const endSeg = nonNegativeInteger(candidate.endSeg);
        const lengthM = finiteNumber(candidate.lengthM);
        const midLat = finiteNumber(candidate.midLat);
        const midLon = finiteNumber(candidate.midLon);
        if (startSeg === null || endSeg === null || endSeg < startSeg || lengthM === null || lengthM < 0) continue;
        if (midLat === null || midLon === null || Math.abs(midLat) > 90 || Math.abs(midLon) > 180) continue;

        const rawDepth = candidate.minDepthM;
        const minDepthM = rawDepth === null ? null : finiteNumber(rawDepth);
        if (rawDepth !== null && minDepthM === null) continue;

        const minAtLat = finiteNumber(candidate.minAtLat);
        const minAtLon = finiteNumber(candidate.minAtLon);
        const hasMinAt =
            minAtLat !== null && minAtLon !== null && Math.abs(minAtLat) <= 90 && Math.abs(minAtLon) <= 180;

        runs.push({
            startSeg,
            endSeg,
            lengthM,
            minDepthM,
            midLat,
            midLon,
            ...(hasMinAt ? { minAtLat, minAtLon } : {}),
            ...(candidate.ntmSurveyed === true ? { ntmSurveyed: true } : {}),
        });
    }
    return runs;
}

function nearestLegIndex(polyline: readonly LonLat[], lat: number, lon: number): number | null {
    if (polyline.length < 2) return null;

    let closestIndex = 0;
    let closestDistanceSquared = Infinity;
    const metresPerLat = 110_540;

    for (let index = 0; index + 1 < polyline.length; index++) {
        const [aLon, aLat] = polyline[index];
        const [bLon, bLat] = polyline[index + 1];
        if (![aLon, aLat, bLon, bLat].every(Number.isFinite)) continue;

        // Local tangent-plane projection is deliberately enough here: shallow
        // runs are bounded inshore stretches and this finds an ETA leg, not a
        // navigation solution.
        const metresPerLon = 111_320 * Math.cos((((aLat + bLat + lat) / 3) * Math.PI) / 180);
        const ax = (aLon - lon) * metresPerLon;
        const ay = (aLat - lat) * metresPerLat;
        const bx = (bLon - lon) * metresPerLon;
        const by = (bLat - lat) * metresPerLat;
        const dx = bx - ax;
        const dy = by - ay;
        const lengthSquared = dx * dx + dy * dy;
        const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lengthSquared));
        const px = ax + dx * t;
        const py = ay + dy * t;
        const distanceSquared = px * px + py * py;
        if (distanceSquared < closestDistanceSquared) {
            closestDistanceSquared = distanceSquared;
            closestIndex = index;
        }
    }

    return Number.isFinite(closestDistanceSquared) ? closestIndex : null;
}

/**
 * Convert charted shallow runs into the departure engine's ETA gate format.
 *
 * Runs with no charted depth remain deliberately absent: a tide window built
 * from an unvouched depth would be fabricated confidence. When the engine
 * supplied the exact shallowest point, use its nearest route leg; old saved
 * plans fall back to the run midpoint segment index.
 */
export function shallowRunsToDepartureSpots(
    polyline: readonly LonLat[],
    runs: readonly ShallowRunInfo[],
): ShallowSpot[] {
    const lastLeg = polyline.length - 2;
    if (lastLeg < 0) return [];

    const spots: ShallowSpot[] = [];
    const seen = new Set<string>();
    for (const run of runs) {
        if (!Number.isFinite(run.minDepthM)) continue;

        const exactLeg =
            Number.isFinite(run.minAtLat) && Number.isFinite(run.minAtLon)
                ? nearestLegIndex(polyline, run.minAtLat!, run.minAtLon!)
                : null;
        const midpointLeg = Math.round((run.startSeg + run.endSeg) / 2);
        const legIndex = Math.max(0, Math.min(lastLeg, exactLeg ?? midpointLeg));
        const minDepthM = run.minDepthM as number;
        const key = `${legIndex}:${minDepthM.toFixed(3)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        spots.push({ legIndex, minDepthM });
    }

    return spots;
}

/**
 * Pick the same tide-curve anchor the native map uses for a multi-gate route:
 * the longest charted shallow run. Fetching at the destination can use a
 * different estuary's tide phase, while one per-run request is needlessly
 * expensive and fragments the offline tide cache.
 */
export function tideAnchorForShallowRuns(runs: readonly ShallowRunInfo[]): { lat: number; lon: number } | null {
    const anchor = runs
        .filter(
            (run) =>
                Number.isFinite(run.minDepthM) &&
                Number.isFinite(run.lengthM) &&
                Number.isFinite(run.midLat) &&
                Number.isFinite(run.midLon),
        )
        .reduce<ShallowRunInfo | null>(
            (longest, run) => (!longest || run.lengthM > longest.lengthM ? run : longest),
            null,
        );

    return anchor ? { lat: anchor.midLat, lon: anchor.midLon } : null;
}
