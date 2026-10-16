import type { VesselProfile } from '../../types';
import type { RouteComfortSummary } from './routeComfort';
import type { RouteSailingStats } from './routeSailingStats';
export { sailingStatsForNodes, combineSailingStats } from './routeSailingStats';
export type { RouteSailingStats } from './routeSailingStats';

export function routeComfortLines(comfort?: RouteComfortSummary | null): string[] {
    if (!comfort) return [];
    const at = comfort.maxWaveAt;
    const place = at
        ? ` near ${Math.abs(at.lat).toFixed(3)}° ${at.lat < 0 ? 'S' : 'N'}, ${Math.abs(at.lon).toFixed(3)}° ${at.lon < 0 ? 'W' : 'E'}`
        : '';
    const lines = [
        comfort.coverage === 'unavailable'
            ? 'Wave coverage unavailable; the route has no proven wave-limit clearance.'
            : `Wave coverage ${comfort.coverage}; known maximum ${comfort.maxWaveM!.toFixed(1)} m${place}${comfort.unknownHours > 0 ? `; ${comfort.unknownHours.toFixed(1)} h unchecked` : ''}.`,
    ];
    if (comfort.relaxedFromM !== undefined)
        lines.push(
            `Relaxed wave limit: needs ${comfort.maxWaveM?.toFixed(1) ?? 'unknown'} m seas${place}; your limit is ${comfort.relaxedFromM.toFixed(1)} m.`,
        );
    if (comfort.word)
        lines.push(
            `Beta comfort ${comfort.level}/3: ${comfort.word}${comfort.genericBoat ? ' for a generic 38 ft boat' : ''}. Total waves only; wind-sea and cross-sea effects are unknown. This is not a safety rating.`,
        );
    return lines;
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
