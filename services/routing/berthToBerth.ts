/** One bounded three-stage request. Adapters own chart/forecast IO; no partial adoption. */
import type { IsochroneNode, IsochroneResult } from '../isochrone/types';
import type { InshoreSegmentState } from '../../components/map/inshoreRouteState';
import type { ThalassaRouteDisclosure } from '../../types/autorouting';
import { haversineNm } from '../isochrone/geodesy';
import { stitchIsochrones } from './stitchIsochrones';
import { freezeLeg, type BoundaryNode, type Leg } from './legContract';
import { stitchLegs } from '../glue/gluer';
import { withDeadline } from '../../utils/deadline';

export const MAX_BERTH_ROUTE_NM = 1200;
export const BERTH_ROUTE_BUDGET_MS = 90000;
export const MAX_BERTH_APPROACH_NM = 45;
export interface BerthPoint {
    lat: number;
    lon: number;
}
export interface BerthPortal {
    id: string;
    at: BerthPoint;
    /** Original charted lower bound; admission already checks the existing
     * survey-margin classification. No tide credit is added. */
    depthM: number;
    sourceKey: string;
}
export interface BerthPortalLease {
    candidates: readonly BerthPortal[];
    current: () => boolean;
    release: () => void;
}
export interface BerthLegRequest {
    origin: BerthPoint;
    destination: BerthPoint;
    departureTime: string;
    offsetHours: number;
    signal: AbortSignal;
    current: () => boolean;
    remaining: () => number;
}
export interface BerthApproach {
    result: IsochroneResult;
    states: readonly InshoreSegmentState[];
    disclosure: ThalassaRouteDisclosure;
    warnings: string[];
}
export interface BerthRouteResult {
    result: IsochroneResult;
    states: InshoreSegmentState[];
    departure: BerthApproach;
    arrival: BerthApproach;
    portals: [BerthPortal, BerthPortal];
    offshoreSegments: number;
}
const distance = (a: BerthPoint, b: BerthPoint) => haversineNm(a.lat, a.lon, b.lat, b.lon);
const validPoint = (p: BerthPoint) =>
    Number.isFinite(p?.lat) && Math.abs(p.lat) <= 83 && Number.isFinite(p.lon) && Math.abs(p.lon) <= 180;
// Both solvers must terminate at the shared source point. The gluer's 1 m
// numerical tolerance must not hide a connector discarded by concatenation.
const samePoint = (a: BerthPoint, b: BerthPoint) => a.lon === b.lon && a.lat === b.lat;
function geometry(result: IsochroneResult, departureMs: number): boolean {
    return (
        result.route.length >= 2 &&
        result.route.length <= 8192 &&
        result.routeCoordinates.length === result.route.length &&
        result.shallowFlags.length === result.route.length &&
        result.shallowFlags.every((v) => typeof v === 'boolean') &&
        result.route.every(
            (n, i) =>
                validPoint(n) &&
                Number.isFinite(n.timeHours) &&
                n.timeHours >= 0 &&
                Number.isFinite(n.distance) &&
                n.distance >= 0 &&
                n.lon === result.routeCoordinates[i][0] &&
                n.lat === result.routeCoordinates[i][1] &&
                (!i || (n.timeHours >= result.route[i - 1].timeHours && n.distance >= result.route[i - 1].distance)),
        ) &&
        Math.abs(result.route[0].timeHours) < 1e-9 &&
        result.route.at(-1)!.timeHours > 0 &&
        result.route.at(-1)!.distance > 0 &&
        Number.isFinite(result.totalDurationHours) &&
        Math.abs(result.totalDurationHours - result.route.at(-1)!.timeHours) <= 0.051 &&
        Number.isFinite(result.totalDistanceNM) &&
        Math.abs(result.totalDistanceNM - result.route.at(-1)!.distance) <= 0.051 &&
        Math.abs(Date.parse(result.arrivalTime) - departureMs - result.route.at(-1)!.timeHours * 3600000) <= 2
    );
}
const heading = (a: BerthPoint, b: BerthPoint) => {
    const r = Math.PI / 180,
        x = a.lat * r,
        y = b.lat * r,
        d = (b.lon - a.lon) * r;
    return (
        (Math.atan2(Math.sin(d) * Math.cos(y), Math.cos(x) * Math.sin(y) - Math.sin(x) * Math.cos(y) * Math.cos(d)) /
            r +
            360) %
        360
    );
};
function seamLeg(
    result: IsochroneResult,
    states: readonly InshoreSegmentState[],
    tier: 3 | 4,
    entryDepth: number | null,
    exitDepth: number | null,
): Leg {
    const points = result.route;
    const node = (
        p: IsochroneNode,
        bearing: number,
        depthM: number | null,
        kind: BoundaryNode['kind'],
    ): BoundaryNode => ({ at: [p.lon, p.lat], headingDeg: bearing, depthM, snapped: true, kind });
    return freezeLeg({
        tierId: tier,
        entry: node(points[0], heading(points[0], points[1]), entryDepth, 'shelf-edge'),
        exit: node(points.at(-1)!, heading(points.at(-2)!, points.at(-1)!), exitDepth, 'shelf-edge'),
        polyline: result.routeCoordinates.map((p) => [p[0], p[1]]),
        cautionMask: [states[0] === 'danger', ...states.map((s) => s === 'danger')],
        depthSource: tier === 4 ? 'gebco' : 'charted',
        controllingDepthM: null,
        provenance: tier === 4 ? 'offshore forecast' : 'checked approach',
    });
}
export async function computeBerthToBerth(input: {
    origin: BerthPoint;
    destination: BerthPoint;
    departureTime: string;
    draftM: number;
    deadlineMs: number;
    signal?: AbortSignal;
    current: () => boolean;
    portals: (end: 'departure' | 'arrival', signal: AbortSignal, current: () => boolean) => Promise<BerthPortalLease>;
    approach: (request: BerthLegRequest) => Promise<BerthApproach | null>;
    offshore: (request: BerthLegRequest) => Promise<IsochroneResult | null>;
    verify: (
        candidate: IsochroneResult,
        current: () => boolean,
        remaining: () => number,
    ) => Promise<{ verified: boolean; result: IsochroneResult; reason?: string }>;
}): Promise<BerthRouteResult> {
    const departureMs = Date.parse(input.departureTime),
        direct = distance(input.origin, input.destination);
    if (
        !validPoint(input.origin) ||
        !validPoint(input.destination) ||
        !Number.isFinite(departureMs) ||
        !Number.isFinite(input.draftM) ||
        input.draftM <= 0 ||
        !Number.isFinite(input.deadlineMs) ||
        direct <= 50 ||
        direct > MAX_BERTH_ROUTE_NM
    )
        throw Error('Choose a valid berth passage beyond 50 NM and within 1200 NM.');
    const budget = Math.min(BERTH_ROUTE_BUDGET_MS, input.deadlineMs - Date.now()),
        end = performance.now() + budget;
    const abort = new AbortController(),
        leases: BerthPortalLease[] = [];
    const cancel = () => abort.abort();
    input.signal?.addEventListener('abort', cancel, { once: true });
    const current = () => {
        try {
            return (
                !abort.signal.aborted &&
                !input.signal?.aborted &&
                input.current() &&
                Date.now() < input.deadlineMs &&
                performance.now() < end &&
                leases.every((l) => l.current())
            );
        } catch {
            return false;
        }
    };
    const remaining = () => Math.max(1, Math.min(input.deadlineMs - Date.now(), end - performance.now()));
    const check = () => {
        if (!current()) throw Error('Berth routing expired or its boat/chart source changed.');
    };
    const timer = setTimeout(cancel, Math.max(1, budget)),
        watch = setInterval(() => {
            try {
                if (!current()) cancel();
            } catch {
                cancel();
            }
        }, 100);
    const request = (origin: BerthPoint, destination: BerthPoint, offsetHours: number): BerthLegRequest => ({
        origin,
        destination,
        offsetHours,
        departureTime: new Date(departureMs + offsetHours * 3600000).toISOString(),
        signal: abort.signal,
        current,
        remaining,
    });
    const load = async (which: 'departure' | 'arrival') => {
        check();
        const pending = input.portals(which, abort.signal, current).then((lease) => {
            if (!current()) {
                lease.release();
                throw Error('The chart portal cohort arrived after its request retired.');
            }
            return lease;
        });
        const lease = await withDeadline(pending, remaining(), 'berth portal cohort');
        leases.push(lease);
        check();
        const berth = which === 'departure' ? input.origin : input.destination;
        if (
            !lease.candidates.length ||
            lease.candidates.length > 4 ||
            lease.candidates.some(
                (p) =>
                    !validPoint(p.at) ||
                    !p.id ||
                    !p.sourceKey ||
                    !Number.isFinite(p.depthM) ||
                    p.depthM < input.draftM + 0.5 ||
                    distance(berth, p.at) > MAX_BERTH_APPROACH_NM ||
                    distance(berth, p.at) < 0.1,
            )
        )
            throw Error('A bounded current charted deep-water portal is unavailable at the ' + which + '.');
        return lease.candidates;
    };
    const approach = async (portals: readonly BerthPortal[], which: 'departure' | 'arrival', offset: number) => {
        for (const portal of portals.slice(0, 2)) {
            check();
            const req =
                which === 'departure'
                    ? request(input.origin, portal.at, offset)
                    : request(portal.at, input.destination, offset);
            const leg = await withDeadline(input.approach(req), remaining(), 'checked berth approach');
            check();
            if (!leg) continue;
            if (
                !geometry(leg.result, Date.parse(req.departureTime)) ||
                leg.states.length !== leg.result.route.length - 1 ||
                !samePoint(leg.result.route[0], req.origin) ||
                !samePoint(leg.result.route.at(-1)!, req.destination) ||
                leg.disclosure.backstop !== 'verified' ||
                (leg.disclosure.hardLandAwayM ?? 0) > 0 ||
                !leg.disclosure.stateMask ||
                leg.disclosure.stateMask.length !== leg.states.length ||
                leg.states.some(
                    (state, i) =>
                        !['green', 'channel', 'danger', 'offshore'].includes(state) ||
                        state !== leg.disclosure.stateMask![i],
                )
            )
                throw Error('The complete approach geometry, masks or land check is unavailable.');
            const edge = which === 'departure' ? leg.states.at(-1) : leg.states[0];
            if (edge === 'danger') continue;
            return { portal, leg };
        }
        throw Error('No chart-checked ' + which + ' approach reaches its deep-water portal.');
    };
    try {
        const depPortals = await load('departure'),
            arrPortals = await load('arrival');
        const dep = await approach(depPortals, 'departure', 0),
            offset = dep.leg.result.route.at(-1)!.timeHours;
        // A ranked arrival portal is fixed before the offshore solve; failure
        // never substitutes a guessed portal or stitches a partial route.
        const arrivalPortal = arrPortals[0];
        if (distance(dep.portal.at, arrivalPortal.at) < 1)
            throw Error('The checked offshore portals overlap; split this coastal passage.');
        const offshoreRequest = request(dep.portal.at, arrivalPortal.at, offset);
        const ocean = await withDeadline(input.offshore(offshoreRequest), remaining(), 'offshore berth leg');
        check();
        if (
            !ocean ||
            !geometry(ocean, Date.parse(offshoreRequest.departureTime)) ||
            !samePoint(ocean.route[0], dep.portal.at) ||
            !samePoint(ocean.route.at(-1)!, arrivalPortal.at)
        )
            throw Error('The offshore leg did not reach both shared portals at its actual forecast clock.');
        const arrOffset = offset + ocean.route.at(-1)!.timeHours;
        const arr = await approach([arrivalPortal], 'arrival', arrOffset);
        const oceanStates: InshoreSegmentState[] = ocean.route
            .slice(1)
            .map((_, i) => (ocean.shallowFlags[i] || ocean.shallowFlags[i + 1] ? 'danger' : 'offshore'));
        const glue = stitchLegs([
            seamLeg(dep.leg.result, dep.leg.states, 3, null, dep.portal.depthM),
            seamLeg(ocean, oceanStates, 4, dep.portal.depthM, arrivalPortal.depthM),
            seamLeg(arr.leg.result, arr.leg.states, 3, arrivalPortal.depthM, null),
        ]);
        if (glue.refusal) throw Error('The berth/offshore join failed: ' + glue.refusal.reason + '.');
        const candidate = stitchIsochrones(stitchIsochrones(dep.leg.result, ocean), arr.leg.result);
        const states = [...dep.leg.states, ...oceanStates, ...arr.leg.states];
        if (
            candidate.route.length > 8192 ||
            candidate.route.at(-1)!.distance > MAX_BERTH_ROUTE_NM ||
            candidate.isochrones.reduce((n, f) => n + f.nodes.length, 0) > 50000 ||
            states.length !== candidate.route.length - 1 ||
            !geometry(candidate, departureMs)
        )
            throw Error('The complete berth route exceeds its geometry or forecast-clock bounds.');
        // The verifier may return or mutate the same object. Keep independent
        // pre-await geometry and clocks, rather than comparing aliases.
        const joined = candidate.route.map(({ lon, lat, timeHours, distance }) => ({ lon, lat, timeHours, distance }));
        const joinedSummary = {
            arrivalTime: candidate.arrivalTime,
            totalDistanceNM: candidate.totalDistanceNM,
            totalDurationHours: candidate.totalDurationHours,
        };
        const final = await withDeadline(
            input.verify(candidate, current, remaining),
            remaining(),
            'whole berth route verification',
        );
        check();
        if (
            !final.verified ||
            !geometry(final.result, departureMs) ||
            final.result.route.length !== joined.length ||
            final.result.route.some((p, i) =>
                (['lon', 'lat', 'timeHours', 'distance'] as const).some((key) => p[key] !== joined[i][key]),
            ) ||
            final.result.arrivalTime !== joinedSummary.arrivalTime ||
            final.result.totalDistanceNM !== joinedSummary.totalDistanceNM ||
            final.result.totalDurationHours !== joinedSummary.totalDurationHours
        )
            throw Error(
                final.reason ??
                    'Whole-route verification changed or did not verify the exact joined geometry and clocks.',
            );
        return {
            result: final.result,
            states,
            departure: dep.leg,
            arrival: arr.leg,
            portals: [dep.portal, arrivalPortal],
            offshoreSegments: oceanStates.length,
        };
    } finally {
        clearTimeout(timer);
        clearInterval(watch);
        input.signal?.removeEventListener('abort', cancel);
        abort.abort();
        for (const lease of leases) lease.release();
    }
}
