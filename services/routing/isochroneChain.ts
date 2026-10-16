import type { IsochroneResult } from '../isochrone/types';
import { stitchIsochrones } from './stitchIsochrones';
import {
    resolveRouteConstraints,
    routeRetainsConstraints,
    routeSegmentAllowed,
    type RouteConstraintPoint,
    type ResolvedRouteConstraints,
} from './routeConstraints';
import { withDeadline } from '../../utils/deadline';

export interface ConstrainedLegRequest {
    origin: RouteConstraintPoint;
    destination: RouteConstraintPoint;
    departureTime: string;
    /** Hours from the original departure; all forecast adapters use this clock. */
    offsetHours: number;
    signal: AbortSignal;
    shouldContinue: () => boolean;
    segmentAllowed: (a: RouteConstraintPoint, b: RouteConstraintPoint) => boolean;
}
function clockedGeometry(result: IsochroneResult, departureMs: number): boolean {
    return (
        result.route.length >= 2 &&
        result.route.length <= 8192 &&
        result.routeCoordinates.length === result.route.length &&
        Number.isFinite(result.totalDurationHours) &&
        result.totalDurationHours >= 0 &&
        Number.isFinite(result.totalDistanceNM) &&
        result.totalDistanceNM >= 0 &&
        Number.isFinite(Date.parse(result.arrivalTime)) &&
        result.route.every(
            (n, j) =>
                Number.isFinite(n.timeHours) &&
                n.timeHours >= 0 &&
                Number.isFinite(n.distance) &&
                n.distance >= 0 &&
                (!j || (n.timeHours >= result.route[j - 1].timeHours && n.distance >= result.route[j - 1].distance)) &&
                n.lon === result.routeCoordinates[j][0] &&
                n.lat === result.routeCoordinates[j][1],
        ) &&
        Math.abs(result.route[0].timeHours) < 1e-9 &&
        result.route.at(-1)!.timeHours > 0 &&
        result.route.at(-1)!.distance > 0 &&
        Math.abs(Date.parse(result.arrivalTime) - departureMs - result.route.at(-1)!.timeHours * 3600000) <= 2
    );
}
/** Same engine and final verifier are injected by the planner, never replaced.
 * There is no partial result/fallback when any ordered leg or final check fails. */
export async function computeVerifiedIsochroneChain(input: {
    origin: RouteConstraintPoint;
    destination: RouteConstraintPoint;
    vias: readonly RouteConstraintPoint[];
    departureTime: string;
    deadlineMs: number;
    shouldContinue?: () => boolean;
    computeLeg: (request: ConstrainedLegRequest) => Promise<IsochroneResult | null>;
    verify: (
        result: IsochroneResult,
        constraints: ResolvedRouteConstraints,
        stillCurrent: () => boolean,
    ) => Promise<{ result: IsochroneResult; verified: boolean; reason?: string }>;
}): Promise<IsochroneResult> {
    const constraints = resolveRouteConstraints(input.origin, input.vias, input.destination),
        departureMs = Date.parse(input.departureTime);
    if (!constraints || !Number.isFinite(departureMs) || !Number.isFinite(input.deadlineMs))
        throw Error('Invalid route constraints or departure clock.');
    const budget = Math.min(60000, input.deadlineMs - Date.now()),
        monotonicEnd = performance.now() + budget;
    const abort = new AbortController(),
        timer = setTimeout(() => abort.abort(), Math.max(1, budget));
    const current = () =>
        !abort.signal.aborted &&
        Date.now() < input.deadlineMs &&
        performance.now() < monotonicEnd &&
        (input.shouldContinue?.() ?? true);
    const remaining = () => Math.max(1, Math.min(input.deadlineMs - Date.now(), monotonicEnd - performance.now()));
    let combined: IsochroneResult | null = null,
        offsetHours = 0,
        frontNodes = 0;
    try {
        for (let i = 1; i < constraints.points.length; i++) {
            if (!current()) throw Error('Waypoint routing expired or was cancelled.');
            const from = constraints.points[i - 1],
                to = constraints.points[i];
            const legDeparture = new Date(departureMs + offsetHours * 3600000).toISOString();
            const leg = await withDeadline(
                input.computeLeg({
                    origin: from,
                    destination: to,
                    departureTime: legDeparture,
                    offsetHours,
                    signal: abort.signal,
                    shouldContinue: current,
                    segmentAllowed: (a, b) => routeSegmentAllowed(a, b, constraints.halfLines),
                }),
                remaining(),
                'waypoint leg',
            );
            if (
                !current() ||
                !leg ||
                !clockedGeometry(leg, Date.parse(legDeparture)) ||
                !routeRetainsConstraints(leg.route, { points: [from, to], halfLines: constraints.halfLines })
            )
                throw Error('A required waypoint leg could not be verified at its actual clock.');
            frontNodes += leg.isochrones.reduce((n, front) => n + front.nodes.length, 0);
            if (frontNodes > 50000 || (combined?.route.length ?? 1) + leg.route.length - 1 > 8192)
                throw Error('The complete waypoint route exceeds its bounded memory window.');
            combined = combined ? stitchIsochrones(combined, leg) : leg;
            offsetHours = combined.route.at(-1)!.timeHours;
        }
        if (!combined || !current() || !routeRetainsConstraints(combined.route, constraints))
            throw Error('The complete route did not retain every required mark.');
        const final = await withDeadline(
            input.verify(combined, constraints, current),
            remaining(),
            'whole waypoint route verification',
        );
        if (
            !current() ||
            !final.verified ||
            !clockedGeometry(final.result, departureMs) ||
            !routeRetainsConstraints(final.result.route, constraints)
        )
            throw Error(final.reason ?? 'The chart-verified route changed a required point or leave-side constraint.');
        return final.result;
    } finally {
        clearTimeout(timer);
        abort.abort();
    }
}
