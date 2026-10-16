import type { VesselProfile } from '../../types';
import type { IsochroneNode } from './types';
import { routeComfortLines, type RouteComfortSummary } from './routeComfort';

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

export interface RouteFuelEstimate {
    basis: 'computed-motor-legs' | 'all-motor-assumption';
    hours: number;
    litres: number | null;
    burnLitresPerHour: number | null;
    tankLitres: number | null;
    reservePercent: number;
    usableLitres: number | null;
    fitsCapacity: boolean | null;
}

/** fuelBurn is L/h; capacity remains the existing US-gallon storage contract. */
export function estimateRouteFuel(
    motorHours: number | null | undefined,
    durationHours: number,
    vessel?: Partial<VesselProfile> | null,
): RouteFuelEstimate {
    const knownMotor = typeof motorHours === 'number' && Number.isFinite(motorHours) && motorHours >= 0;
    const hours = knownMotor ? motorHours : Math.max(0, Number.isFinite(durationHours) ? durationHours : 0);
    const burn =
        typeof vessel?.fuelBurn === 'number' && Number.isFinite(vessel.fuelBurn) && vessel.fuelBurn > 0
            ? vessel.fuelBurn
            : null;
    const tank =
        typeof vessel?.fuelCapacity === 'number' && Number.isFinite(vessel.fuelCapacity) && vessel.fuelCapacity > 0
            ? vessel.fuelCapacity * 3.785411784
            : null;
    const reservePercent =
        typeof vessel?.fuelReservePct === 'number' &&
        Number.isFinite(vessel.fuelReservePct) &&
        vessel.fuelReservePct >= 0 &&
        vessel.fuelReservePct <= 90
            ? vessel.fuelReservePct
            : 20;
    const litres = hours === 0 && knownMotor ? 0 : burn === null ? null : hours * burn;
    const usableLitres = tank === null ? null : tank * (1 - reservePercent / 100);
    return {
        basis: knownMotor ? 'computed-motor-legs' : 'all-motor-assumption',
        hours,
        litres,
        burnLitresPerHour: burn,
        tankLitres: tank,
        reservePercent,
        usableLitres,
        fitsCapacity: litres === null || usableLitres === null ? null : litres <= usableLitres,
    };
}

/** Identical words/units in cards, shared text and PDFs. All figures are estimates. */
export function routeEstimateLines(
    stats?: RouteSailingStats | null,
    fuel?: RouteFuelEstimate | null,
    comfort?: RouteComfortSummary | null,
): string[] {
    const lines: string[] = routeComfortLines(comfort);
    if (stats) {
        lines.push(
            `Estimated sailing: beating ${stats.beatingHours.toFixed(1)} h; reaching ${stats.reachingHours.toFixed(1)} h; running ${stats.runningHours.toFixed(1)} h.`,
        );
        lines.push(
            `Motor ${stats.motorHours === null ? 'unknown' : stats.motorHours.toFixed(1) + ' h'}; tacks ${stats.tacks ?? 'unknown'}${stats.unknownHours > 0 ? `; ${stats.unknownHours.toFixed(1)} h without propulsion data` : ''}.`,
        );
    }
    if (fuel) {
        const amount = fuel.litres === null ? 'set fuel burn in Vessel' : `${fuel.litres.toFixed(1)} L`;
        lines.push(
            `Fuel estimate: ${amount}${fuel.basis === 'all-motor-assumption' ? ` if motoring all ${fuel.hours.toFixed(1)} h` : ' for computed motor legs'}.`,
        );
        if (fuel.usableLitres !== null)
            lines.push(
                `Tank capacity ${fuel.tankLitres!.toFixed(0)} L; ${fuel.reservePercent}% reserve leaves ${fuel.usableLitres.toFixed(0)} L usable${fuel.fitsCapacity === false ? ' — estimated fuel exceeds usable capacity' : ''}. Confirm actual fuel aboard.`,
            );
    }
    return lines;
}

export function withRouteEstimates<T extends { estimatedDuration: number }>(
    analysis: T,
    stats: RouteSailingStats | undefined,
    vessel?: Partial<VesselProfile> | null,
    routeComfort?: RouteComfortSummary,
): T & {
    sailingStats?: RouteSailingStats;
    routeFuel: RouteFuelEstimate;
    fuelEstimate: number | null;
    routeComfort?: RouteComfortSummary;
} {
    const routeFuel = estimateRouteFuel(stats?.motorHours, analysis.estimatedDuration, vessel);
    return { ...analysis, sailingStats: stats, routeFuel, fuelEstimate: routeFuel.litres, routeComfort };
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
