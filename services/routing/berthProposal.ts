/** New automatic approaches retain Auto opt-in and existing short-Auto checks.
 * Every source fact is request-owned RAM; this module writes and adopts nothing. */
import type { AutoroutingTrialRequest, AutoroutingTrialRoute, ThalassaRouteDisclosure } from '../../types/autorouting';
import type { UserSettings } from '../../types/settings';
import type { IsochroneResult } from '../isochrone/types';
import type { WindGrid } from '../weather/windGridEncoding';
import { cumulativeLegs, haversineNm } from '../isochrone/geodesy';
import { detectTurnWaypoints } from '../isochrone/output';
import {
    computeBerthToBerth,
    MAX_BERTH_ROUTE_NM,
    type BerthRouteResult,
    type BerthLegRequest,
    type BerthPortalLease,
} from './berthToBerth';
import { withDeadline } from '../../utils/deadline';

/** Carry per-segment facts and their indices across exact concatenation. No
 * invented chart depth, survey grade, tide datum or propulsion is added. */
export function berthDisclosure(route: BerthRouteResult, elapsedMs: number): ThalassaRouteDisclosure {
    const a = route.departure.disclosure,
        b = route.arrival.disclosure,
        n = route.departure.states.length,
        m = route.offshoreSegments;
    const array = <T>(x: readonly T[] | undefined, y: readonly T[] | undefined, fallback: T): T[] => {
        if ((x && x.length !== n) || (y && y.length !== route.arrival.states.length))
            throw Error('Approach classifications do not match their exact line.');
        return [
            ...(x ?? Array.from({ length: n }, () => fallback)),
            ...Array.from({ length: m }, () => fallback),
            ...(y ?? Array.from({ length: route.arrival.states.length }, () => fallback)),
        ];
    };
    const runs = <T extends { startSeg: number; endSeg: number }>(
        x: readonly T[] | undefined,
        y: readonly T[] | undefined,
    ) => {
        for (const [values, count] of [
            [x, n],
            [y, route.arrival.states.length],
        ] as const)
            if (
                values?.some(
                    (r) =>
                        !Number.isSafeInteger(r.startSeg) ||
                        !Number.isSafeInteger(r.endSeg) ||
                        r.startSeg < 0 ||
                        r.endSeg < r.startSeg ||
                        r.endSeg >= count,
                )
            )
                throw Error('An approach hazard interval does not belong to its exact line.');
        return [
            ...(x ?? []),
            ...(y ?? []).map((r) => ({ ...r, startSeg: r.startSeg + n + m, endSeg: r.endSeg + n + m })),
        ];
    };
    const caution = array(a.cautionMask, b.cautionMask, false);
    for (let i = 0; i < m; i++) caution[n + i] = route.states[n + i] === 'danger';
    return {
        stateMask: route.states,
        canalMask: array(a.canalMask, b.canalMask, false),
        channelMask: array(a.channelMask, b.channelMask, false),
        offshoreMask: [
            ...Array.from({ length: n }, () => false),
            ...Array.from({ length: m }, () => true),
            ...Array.from({ length: route.arrival.states.length }, () => false),
        ],
        cautionMask: caution,
        chartedShallowMask: array(a.chartedShallowMask, b.chartedShallowMask, false),
        landPaintConflictMask: array(a.landPaintConflictMask, b.landPaintConflictMask, false),
        cautionWhy: array(a.cautionWhy, b.cautionWhy, 0),
        cautionDepthM: array(a.cautionDepthM, b.cautionDepthM, null),
        cautionNearShallow: array(a.cautionNearShallow, b.cautionNearShallow, null),
        tideDepthM: array(a.tideDepthM, b.tideDepthM, null),
        ...(a.tideNeedM === b.tideNeedM && a.tideNeedM !== undefined ? { tideNeedM: a.tideNeedM } : {}),
        shallowRuns: runs(a.shallowRuns, b.shallowRuns),
        chartedShallowSpans: runs(a.chartedShallowSpans, b.chartedShallowSpans),
        surveyRuns: runs(a.surveyRuns, b.surveyRuns),
        surveyUncheckedCells: [...new Set([...(a.surveyUncheckedCells ?? []), ...(b.surveyUncheckedCells ?? [])])],
        structuresUnknownCells: [
            ...new Set([...(a.structuresUnknownCells ?? []), ...(b.structuresUnknownCells ?? [])]),
        ],
        ...(a.pinOffWater?.origin || b.pinOffWater?.destination
            ? { pinOffWater: { origin: a.pinOffWater?.origin, destination: b.pinOffWater?.destination } }
            : {}),
        ...(a.tideCheck || b.tideCheck ? { tideCheck: 'not-loaded' as const } : {}),
        cellsUsed: [...new Set([...a.cellsUsed, ...b.cellsUsed])],
        distanceNM: route.result.totalDistanceNM,
        elapsedMs,
        backstop: 'verified',
        hardLandAwayM: (a.hardLandAwayM ?? 0) + (b.hardLandAwayM ?? 0),
        tideCeilingsLoaded: a.tideCeilingsLoaded === true && b.tideCeilingsLoaded === true,
        berth: {
            portals: route.portals.map((p) => ({ ...p.at })) as [
                { lat: number; lon: number },
                { lat: number; lon: number },
            ],
            sourceKeys: [route.portals[0].sourceKey, route.portals[1].sourceKey],
            offshoreSegments: m,
        },
    };
}
function approachResult(proposal: AutoroutingTrialRoute, request: BerthLegRequest, speed: number): IsochroneResult {
    const points = proposal.coordinates.map(([lon, lat]) => ({ lat, lon })),
        clock = cumulativeLegs(points, speed);
    const route = points.map((p, i) => ({
        ...p,
        timeHours: clock[i].hours,
        distance: clock[i].nm,
        bearing: 0,
        speed,
        tws: 0,
        twa: 0,
        parentIndex: null,
        propulsion: 'unknown' as const,
        tackSide: null,
    }));
    return {
        route,
        routeCoordinates: proposal.coordinates.map((p) => [...p]),
        shallowFlags: route.map((_, i) => proposal.engine?.stateMask?.[Math.max(0, i - 1)] === 'danger'),
        isochrones: [],
        totalDistanceNM: clock.at(-1)!.nm,
        totalDurationHours: clock.at(-1)!.hours,
        arrivalTime: new Date(Date.parse(request.departureTime) + clock.at(-1)!.hours * 3600000).toISOString(),
        motorHours: null,
        environmentNotes: [
            'Approach duration uses cruising speed. Local wind, current effects and propulsion are unresolved.',
        ],
    };
}
interface BerthOptions {
    signal?: AbortSignal;
    onProgress?: (message: string) => void;
    stillCurrent?: () => boolean;
    settings?: UserSettings;
    model?: string;
    privateWind?: WindGrid;
    deadlineMs?: number;
}
export async function calculateBerthProposal(
    request: AutoroutingTrialRequest,
    options: BerthOptions = {},
): Promise<AutoroutingTrialRoute & { passage: IsochroneResult; polarLabel: string }> {
    const start = performance.now(),
        end = start + 90000,
        deadlineMs = Math.min(Date.now() + 90000, options.deadlineMs ?? Infinity);
    const direct = haversineNm(
        request.departure.lat,
        request.departure.lon,
        request.destination.lat,
        request.destination.lon,
    );
    if (
        !Number.isFinite(direct) ||
        direct <= 50 ||
        direct > MAX_BERTH_ROUTE_NM ||
        !Number.isFinite(request.speedKts) ||
        request.speedKts <= 0 ||
        request.speedKts > 50
    )
        throw Error('Automatic berth passages cover more than 50 NM and at most 1200 NM with a valid cruising speed.');
    const [
        { getAuthIdentityScope, isAuthIdentityScopeCurrent },
        { useSettingsStore },
        { getPairing, getPiEquipmentReadRevision },
        { boatLanBaseNow },
        { isAutorouteTrialOn, AUTO_ROUTE_TRIAL_OFF },
        { WindStore },
        { isochroneRoutingContext },
        { vesselDraftMetres },
        { prepareBerthPortalLeases },
        { computeConstrainedPassage },
        { calculateThalassaProposal },
        { validateRouteSegments },
    ] = await withDeadline(
        Promise.all([
            import('../authIdentityScope'),
            import('../../stores/settingsStore'),
            import('../PiPairingService'),
            import('../enc/piCellSync'),
            import('../autorouteTrialSwitch'),
            import('../../stores/WindStore'),
            import('./isochronePolicy'),
            import('../units'),
            import('./berthPortals'),
            import('./constrainedPassage'),
            import('../autoroutingThalassa'),
            import('../isochrone/landAvoidance'),
        ]),
        Math.max(1, Math.min(end - performance.now(), deadlineMs - Date.now())),
        'berth module preparation',
    );
    if (!isAutorouteTrialOn()) throw Error(AUTO_ROUTE_TRIAL_OFF);
    const scope = getAuthIdentityScope();
    const settings = structuredClone(options.settings ?? useSettingsStore.getState().settings),
        boat = useSettingsStore.getState().activeVesselId;
    const departureMs = request.departureMs ?? Date.now(),
        departureTime = new Date(departureMs).toISOString(),
        model = options.model ?? WindStore.getState().model;
    const policy = isochroneRoutingContext(departureTime, settings);
    const pairing = JSON.stringify(getPairing()),
        pairRevision = getPiEquipmentReadRevision(),
        lan = boatLanBaseNow();
    const profile = request.vesselProfile;
    if (
        !scope.userId ||
        settings.satelliteMode ||
        profile?.draftStatus !== 'measured' ||
        Math.abs(vesselDraftMetres(settings.vessel) - request.draftM) > 1e-6
    )
        throw Error(
            'Automatic berth approaches need ordinary internet and the current measured boat draft. The manual passage remains available.',
        );
    const abort = new AbortController(),
        cancel = () => abort.abort();
    options.signal?.addEventListener('abort', cancel, { once: true });
    const current = () =>
        !abort.signal.aborted &&
        !options.signal?.aborted &&
        isAuthIdentityScopeCurrent(scope) &&
        isAutorouteTrialOn() &&
        (options.stillCurrent?.() ?? true) &&
        useSettingsStore.getState().activeVesselId === boat &&
        JSON.stringify(getPairing()) === pairing &&
        getPiEquipmentReadRevision() === pairRevision &&
        boatLanBaseNow() === lan &&
        WindStore.getState().model === model &&
        isochroneRoutingContext(departureTime, useSettingsStore.getState().settings) === policy &&
        performance.now() < end &&
        Date.now() < deadlineMs;
    const remaining = () => Math.max(1, Math.min(end - performance.now(), deadlineMs - Date.now()));
    const check = () => {
        if (!current()) throw Error('The berth request changed or expired. Nothing was adopted.');
    };
    const timer = setTimeout(cancel, remaining()),
        watch = setInterval(() => {
            try {
                if (!current()) cancel();
            } catch {
                cancel();
            }
        }, 100);
    let leases: [BerthPortalLease, BerthPortalLease] | undefined,
        polarLabel = '';
    try {
        check();
        options.onProgress?.('Finding charted deep-water approach portals…');
        leases = await withDeadline(
            prepareBerthPortalLeases({
                origin: request.departure,
                destination: request.destination,
                draftM: request.draftM,
                airDraftM: profile.airDraft.status === 'missing' ? null : profile.airDraft.valueM,
                draftAssumed: false,
                signal: abort.signal,
                current,
                remaining,
            }).then((value) => {
                if (!current()) {
                    value.forEach((l) => l.release());
                    throw Error('The chart portal request retired.');
                }
                return value;
            }),
            remaining(),
            'complete berth chart preparation',
        );
        check();
        const owned = leases;
        if (!owned || owned.length !== 2 || !owned[0] || !owned[1])
            throw Error('Complete charted berth portals are unavailable. Review the passage again.');
        const mixed = await computeBerthToBerth({
            origin: request.departure,
            destination: request.destination,
            departureTime,
            draftM: request.draftM,
            deadlineMs,
            signal: abort.signal,
            current,
            portals: async (which) => owned[which === 'departure' ? 0 : 1],
            approach: async (leg) => {
                check();
                options.onProgress?.(
                    leg.offsetHours
                        ? 'Checking the arrival approach at its forecast ETA…'
                        : 'Checking the departure approach…',
                );
                try {
                    const proposal = await calculateThalassaProposal(
                        {
                            ...request,
                            departure: leg.origin,
                            destination: leg.destination,
                            departureMs: Date.parse(leg.departureTime),
                        },
                        leg.signal,
                        options.onProgress,
                    );
                    check();
                    if (!proposal.engine?.stateMask) return null;
                    return {
                        result: approachResult(proposal, leg, request.speedKts),
                        states: proposal.engine.stateMask,
                        disclosure: proposal.engine,
                        warnings: proposal.warnings,
                    };
                } catch (error) {
                    check();
                    if (leg.signal.aborted) throw error;
                    return null;
                }
            },
            offshore: async (leg) => {
                check();
                options.onProgress?.('Routing the offshore middle from the actual approach clock…');
                const ocean = await computeConstrainedPassage({
                    origin: leg.origin,
                    destination: leg.destination,
                    vias: [],
                    departureTime: leg.departureTime,
                    speed: request.speedKts,
                    settings,
                    model,
                    privateWind: options.privateWind,
                    offshoreOnly: true,
                    deadlineMs: Date.now() + leg.remaining(),
                    stillCurrent: () => current() && leg.current(),
                    inshoreEvidence: () => ({ masksVerified: false, caveats: [] }),
                });
                check();
                polarLabel = ocean.polarLabel;
                return ocean.result;
            },
            verify: async (candidate, stillCurrent, remaining) => {
                options.onProgress?.('Checking the entire berth-to-berth line and both joins…');
                const verdict: { current: 'verified' | 'unverified' } = { current: 'unverified' };
                const route = await withDeadline(
                    validateRouteSegments(candidate.route, {
                        vesselDraftM: request.draftM,
                        draftAssumed: false,
                        departureTimeMs: departureMs,
                        stillCurrent: () => current() && stillCurrent(),
                        publishReport: false,
                        onVerificationOutcome: (outcome) => {
                            verdict.current = outcome.status;
                        },
                    }),
                    remaining(),
                    'whole berth chart/depth/land check',
                );
                check();
                return {
                    verified: verdict.current === 'verified',
                    result: { ...candidate, route, routeCoordinates: route.map((p) => [p.lon, p.lat]) },
                    reason: 'The complete terminal-expanded berth line did not pass current chart/depth/land verification.',
                };
            },
        });
        check();
        const engine = berthDisclosure(mixed, performance.now() - start);
        const warnings = [
            ...new Set([
                ...mixed.departure.warnings,
                ...mixed.arrival.warnings,
                ...(mixed.result.environmentNotes ?? []),
                'Mixed route: chart-checked approaches and a forecast-routed offshore middle. This is a proposal; independent chart review is still required.',
            ]),
        ];
        const passage = { ...mixed.result, environmentNotes: warnings };
        return {
            id: 'thalassa-berth-' + crypto.randomUUID(),
            provider: 'Thalassa',
            coordinates: mixed.result.routeCoordinates,
            warnings,
            createdAt: new Date().toISOString(),
            vesselProfile: profile,
            departureMs,
            engine,
            passage,
            polarLabel,
        };
    } finally {
        clearTimeout(timer);
        clearInterval(watch);
        options.signal?.removeEventListener('abort', cancel);
        abort.abort();
        leases?.forEach((l) => l.release());
    }
}
export async function computeBerthPassage(input: {
    origin: { lat: number; lon: number };
    destination: { lat: number; lon: number };
    departureTime: string;
    speed: number;
    settings: UserSettings;
    model: string;
    privateWind?: WindGrid;
    deadlineMs: number;
    stillCurrent: () => boolean;
}) {
    const [{ snapshotAutoroutingVesselProfile }, { vesselDraftMetres }] = await Promise.all([
        import('../autoroutingVesselProfile'),
        import('../units'),
    ]);
    const proposal = await calculateBerthProposal(
        {
            departure: input.origin,
            destination: input.destination,
            draftM: vesselDraftMetres(input.settings.vessel),
            speedKts: input.speed,
            vesselProfile: snapshotAutoroutingVesselProfile(input.settings.vessel),
            departureMs: Date.parse(input.departureTime),
        },
        input,
    );
    const turns = detectTurnWaypoints(proposal.passage.route, input.departureTime);
    if (turns.length > 258)
        throw Error('This berth passage has too many turns to save atomically. Split it into reviewed passages.');
    return {
        result: proposal.passage,
        disclosure: proposal.engine!,
        cells: proposal.engine!.cellsUsed,
        polarLabel: proposal.polarLabel,
        points: [
            { ...input.origin, name: 'Departure' },
            { ...input.destination, name: 'Arrival' },
        ],
        turns,
        constraints: [],
    };
}
