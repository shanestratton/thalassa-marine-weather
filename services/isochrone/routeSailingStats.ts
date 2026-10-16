/** Pure incoming-leg statistics shared by the router Worker and passage summaries. */
import type { IsochroneNode } from './types';

export interface RouteSailingStats {
    beatingHours: number;
    reachingHours: number;
    runningHours: number;
    /** Null if any part has unknown propulsion. Never derived from SOG. */
    motorHours: number | null;
    knownMotorHours: number;
    unknownHours: number;
    totalHours: number;
    tacks: number | null;
}

/** Incoming-leg metadata from the computed path, before geometry smoothing. */
export function sailingStatsForNodes(route: readonly IsochroneNode[]): RouteSailingStats {
    let beatingHours = 0,
        reachingHours = 0,
        runningHours = 0,
        knownMotorHours = 0,
        unknownHours = 0,
        totalHours = 0,
        tacks = 0;
    let lastSide: number | null = null;
    for (let i = 1; i < route.length; i++) {
        const n = route[i];
        const duration = n.timeHours - route[i - 1].timeHours;
        if (!Number.isFinite(duration) || duration <= 0) continue;
        totalHours += duration;
        if (n.propulsion === 'motor') {
            knownMotorHours += duration;
            lastSide = null;
        } else if (n.propulsion === 'sail' && Number.isFinite(n.twa)) {
            const angle = Math.abs(n.twa);
            if (angle < 50) beatingHours += duration;
            else if (angle < 150) reachingHours += duration;
            else runningHours += duration;
            if (angle < 90 && n.tackSide) {
                if (lastSide !== null && lastSide !== n.tackSide) tacks++;
                lastSide = n.tackSide;
            } else lastSide = null;
        } else {
            unknownHours += duration;
            lastSide = null;
        }
    }
    return {
        beatingHours,
        reachingHours,
        runningHours,
        knownMotorHours,
        unknownHours,
        totalHours,
        motorHours: unknownHours > 0 || totalHours === 0 ? null : knownMotorHours,
        tacks: unknownHours > 0 || totalHours === 0 ? null : tacks,
    };
}

/** Separate legs keep their modes; the unmodeled seam cannot prove a tack count. */
export function combineSailingStats(parts: Array<RouteSailingStats | undefined>): RouteSailingStats | undefined {
    if (parts.some((p) => !p)) return undefined;
    const known = parts as RouteSailingStats[];
    const sum = (
        key: 'beatingHours' | 'reachingHours' | 'runningHours' | 'knownMotorHours' | 'unknownHours' | 'totalHours',
    ) => known.reduce((n, p) => n + p[key], 0);
    return {
        beatingHours: sum('beatingHours'),
        reachingHours: sum('reachingHours'),
        runningHours: sum('runningHours'),
        knownMotorHours: sum('knownMotorHours'),
        unknownHours: sum('unknownHours'),
        totalHours: sum('totalHours'),
        motorHours: known.some((p) => p.motorHours === null) ? null : sum('knownMotorHours'),
        tacks: null,
    };
}
