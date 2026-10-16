/** Explicit waypoint requests use the existing engines and whole-route verifier.
 * No hidden fallback can drop a via or publish a partially checked cohort. */
import type { UserSettings } from '../../types/settings';
import type { IsochroneNode, IsochroneResult, TurnWaypoint } from '../isochrone/types';
import { detectTurnWaypoints } from '../isochrone/output';
import type { InshoreRouteResult } from '../InshoreRouter';
import type { WindGrid } from '../weather/windGridEncoding';
import { computeVerifiedIsochroneChain, type ConstrainedLegRequest } from './isochroneChain';
import { resolveRouteConstraints, type RouteConstraintPoint } from './routeConstraints';
import { computeComfortIsochrones } from './comfortRoute';
import { verifiedIsochroneRoute } from './verifiedIsochroneRoute';
import { loadIsochroneEnvironment, isochroneEnvironmentAt } from './isochroneEnvironment';
import { routingComfortConfig, vesselIsochroneConfig, INSHORE_HOP_NM } from './isochronePolicy';
import { resolveRoutingPolar } from '../routingPolar';
import { cumulativeLegs, haversineNm } from '../isochrone/geodesy';
import { inspectRouteEnvironment } from '../isochrone/routeComfort';
import { validateRouteSegments } from '../isochrone/landAvoidance';
import { sampleWindGrid } from '../weather/importedGribSample';
import { replanWindCovered } from './routeReplanPolicy';
import { OFFSHORE_COMPARISON_MODELS } from './offshoreModelComparison';
import { vesselDraftMetres, vesselDraftIsAssumed, vesselAirDraftMetres } from '../units';
import { withDeadline } from '../../utils/deadline';
import { chartedLandFinding } from './landBackstopWords';

function coarseLeg(points: RouteConstraintPoint[], departure: string, speed: number, notes: string[]): IsochroneResult {
    const distance = cumulativeLegs(points, speed);
    const route = points.map(
        (p, i): IsochroneNode => ({
            ...p,
            timeHours: distance[i].hours,
            distance: distance[i].nm,
            bearing: 0,
            speed,
            tws: 0,
            twa: 0,
            parentIndex: null,
            propulsion: 'unknown',
            tackSide: null,
        }),
    );
    const tail = distance.at(-1)!;
    return {
        route,
        routeCoordinates: route.map((p) => [p.lon, p.lat]),
        shallowFlags: route.map(() => false),
        isochrones: [],
        totalDistanceNM: Math.round(tail.nm * 10) / 10,
        totalDurationHours: Math.round(tail.hours * 10) / 10,
        arrivalTime: new Date(Date.parse(departure) + tail.hours * 3600000).toISOString(),
        environmentNotes: notes,
        motorHours: null,
    };
}

export async function computeConstrainedPassage(input: {
    origin: RouteConstraintPoint;
    destination: RouteConstraintPoint;
    vias: readonly RouteConstraintPoint[];
    departureTime: string;
    speed: number;
    settings: UserSettings;
    model: string;
    privateWind?: WindGrid;
    deadlineMs: number;
    stillCurrent: () => boolean;
    /** Existing UI policy adapters preserve mask validation and all inshore caveats. */
    inshoreEvidence: (result: InshoreRouteResult) => { masksVerified: boolean; caveats: string[] };
}): Promise<{
    result: IsochroneResult;
    cells: string[];
    polarLabel: string;
    points: RouteConstraintPoint[];
    turns: TurnWaypoint[];
    constraints: RouteConstraintPoint[];
}> {
    const constraints = resolveRouteConstraints(input.origin, input.vias, input.destination),
        departureMs = Date.parse(input.departureTime);
    if (
        !constraints ||
        !Number.isFinite(departureMs) ||
        !Number.isFinite(input.speed) ||
        input.speed <= 0 ||
        input.speed > 50
    )
        throw Error('The complete waypoint request is invalid.');
    if (input.settings.satelliteMode)
        throw Error(
            'Satellite Mode: a new waypoint route needs explicit ordinary-internet forecast and chart verification. The original route stays.',
        );
    const model = OFFSHORE_COMPARISON_MODELS.find((m) => m.id === input.model);
    if (!model) throw Error('Choose a supported named global wind model for this waypoint route.');
    const monotonicEnd = performance.now() + Math.min(60000, input.deadlineMs - Date.now());
    const current = () => input.stillCurrent() && Date.now() < input.deadlineMs && performance.now() < monotonicEnd;
    const remaining = () => Math.max(1, Math.min(input.deadlineMs - Date.now(), monotonicEnd - performance.now()));
    if (!current()) throw Error('Waypoint route expired or was superseded.');
    // One explicit regional download for this entire ordered request.
    const lons = [constraints.points[0].lon];
    for (const p of constraints.points.slice(1))
        lons.push(lons.at(-1)! + ((((p.lon - lons.at(-1)! + 180) % 360) + 360) % 360) - 180);
    const north = Math.max(...constraints.points.map((p) => p.lat)),
        south = Math.min(...constraints.points.map((p) => p.lat)),
        west = Math.min(...lons),
        east = Math.max(...lons);
    if (north - south > 20 || east - west > 20 || north > 83 || south < -83)
        throw Error(
            'This waypoint route exceeds the bounded regional forecast window. Split it into reviewed passages.',
        );
    const abort = new AbortController(),
        timer = setTimeout(() => abort.abort(), remaining());
    const contextTimer = setInterval(() => {
        try {
            if (!current()) abort.abort();
        } catch {
            abort.abort();
        }
    }, 100);
    const cells = new Set<string>(),
        notes = new Set<string>();
    try {
        const windPromise = input.privateWind
            ? Promise.resolve(input.privateWind)
            : (async () => {
                  const { fetchModelWindGrid } = await import('../weather/OpenMeteoWindFetcher');
                  return fetchModelWindGrid(
                      model.id,
                      { north: north + 2, south: south - 2, west: west - 2, east: east + 2 },
                      168,
                      2,
                      model.domain,
                      abort.signal,
                  );
              })();
        const [wind, polar, environment] = await withDeadline(
            Promise.all([
                windPromise,
                resolveRoutingPolar({ settings: input.settings, vessel: input.settings.vessel ?? null }),
                loadIsochroneEnvironment({
                    origin: { lat: south, lon: ((((west + 180) % 360) + 360) % 360) - 180 },
                    destination: { lat: north, lon: ((((east + 180) % 360) + 360) % 360) - 180 },
                    departureTime: input.departureTime,
                    speedKts: input.speed,
                    currentNrtEnabled: input.settings.currentNrtEnabled,
                    satelliteMode: input.settings.satelliteMode,
                }),
            ]),
            remaining(),
            'waypoint forecast preparation',
        );
        if (
            !current() ||
            !wind?.refTime ||
            !Number.isFinite(Date.parse(wind.refTime)) ||
            [wind.u, wind.v, wind.speed, wind.gust ?? []].flat().reduce((n, a) => n + a.byteLength, 0) > 8 * 1024 * 1024
        )
            throw Error('A bounded clocked forecast is unavailable for the waypoint route.');
        environment.notes.forEach((note) => notes.add(note));
        const comfort = routingComfortConfig(input.settings.vessel, input.settings.comfortParams);
        const makeLeg = async (request: ConstrainedLegRequest): Promise<IsochroneResult | null> => {
            const distance = haversineNm(
                request.origin.lat,
                request.origin.lon,
                request.destination.lat,
                request.destination.lon,
            );
            if (distance < 100) {
                const { tryInshoreRoute } = await import('../InshoreRouter');
                const inshore = await tryInshoreRoute(
                    request.origin,
                    request.destination,
                    vesselDraftMetres(input.settings.vessel),
                    vesselAirDraftMetres(input.settings.vessel),
                    'safest',
                    { departureMs: Date.parse(request.departureTime), signal: request.signal },
                );
                if (!request.shouldContinue()) return null;
                if (inshore && 'polyline' in inshore) {
                    const evidence = input.inshoreEvidence(inshore);
                    if (!evidence.masksVerified || chartedLandFinding(inshore.hardLand))
                        throw Error('A waypoint leg lacks complete inshore masks or crosses charted land.');
                    const { inshoreRouteCrossesLand } = await import('./landBackstop');
                    const backstop = await inshoreRouteCrossesLand(inshore.polyline, {
                        chartVerdicts: inshore.chartVerdicts,
                    });
                    if (!request.shouldContinue() || backstop.status !== 'verified' || backstop.crossesLand)
                        throw Error('The complete waypoint leg land check is unavailable or found land.');
                    inshore.cellsUsed.forEach((cell) => cells.add(cell));
                    evidence.caveats.forEach((note) => notes.add(note));
                    notes.add(
                        'Inshore waypoint legs use cruising-speed duration; propulsion and local current effects are unresolved.',
                    );
                    const result = coarseLeg(
                        inshore.polyline.map(([lon, lat]) => ({ lat, lon })),
                        request.departureTime,
                        input.speed,
                        [],
                    );
                    result.shallowFlags = result.route.map((_, i) => !!inshore.cautionMask?.[Math.max(0, i - 1)]);
                    return result;
                }
                if (distance < INSHORE_HOP_NM)
                    throw Error(
                        'A required hop under 15 NM needs the charted inshore router; no offshore shortcut was substituted.',
                    );
                notes.add(
                    'Coastal waypoint legs use cruising-speed duration; fine channel ETA and propulsion remain unknown.',
                );
                return coarseLeg([request.origin, request.destination], request.departureTime, input.speed, []);
            }
            const { preloadBathymetry } = await import('../BathymetryCache');
            // Never turn a short dateline leg into an almost-global raster request.
            const bathy =
                Math.abs(request.origin.lon - request.destination.lon) > 180
                    ? null
                    : await preloadBathymetry(request.origin, request.destination, 6);
            if (!request.shouldContinue()) return null;
            const env = isochroneEnvironmentAt(environment, request.departureTime);
            const result = await computeComfortIsochrones(
                request.origin,
                request.destination,
                request.departureTime,
                polar.polar,
                {
                    getWind: (lat, lon, hours) => {
                        const value = sampleWindGrid(
                            wind,
                            lat,
                            lon,
                            departureMs + (request.offsetHours + hours) * 3600000,
                        );
                        return value ? { speed: value.speedKts, direction: value.directionFromDeg } : null;
                    },
                },
                {
                    ...vesselIsochroneConfig(input.settings.vessel, distance),
                    ...comfort,
                    vesselDraft: vesselDraftMetres(input.settings.vessel),
                    minDepthM: null,
                    useDepthPenalty: !!bathy,
                    shouldContinue: request.shouldContinue,
                    segmentAllowed: request.segmentAllowed,
                },
                bathy,
                env.currentField,
                env.exclusionField,
                env.waveField,
            );
            if (!result) return null;
            const route = [...result.route];
            if (route[0].lat !== request.origin.lat || route[0].lon !== request.origin.lon)
                route.unshift({ ...route[0], ...request.origin });
            if (route.at(-1)!.lat !== request.destination.lat || route.at(-1)!.lon !== request.destination.lon)
                route.push({ ...route.at(-1)!, ...request.destination });
            return verifiedIsochroneRoute(result, route, request.departureTime, input.speed);
        };
        const result = await computeVerifiedIsochroneChain({
            ...input,
            computeLeg: makeLeg,
            shouldContinue: current,
            verify: async (candidate, _constraints, stillCurrent) => {
                const outcome: { current: { status: 'verified' | 'unverified'; reason?: string } | null } = {
                    current: null,
                };
                const route = await validateRouteSegments(candidate.route, {
                    vesselDraftM: vesselDraftMetres(input.settings.vessel),
                    draftAssumed: vesselDraftIsAssumed(input.settings.vessel),
                    departureTimeMs: departureMs,
                    stillCurrent,
                    publishReport: false,
                    onVerificationOutcome: (next) => {
                        outcome.current = next;
                    },
                });
                const checked = verifiedIsochroneRoute(candidate, route, input.departureTime, input.speed);
                const env = inspectRouteEnvironment(
                    checked.route,
                    environment.waveField,
                    environment.exclusionField,
                    candidate.comfort?.usedLimitM ?? comfort.comfortParams?.maxWaveM,
                    comfort.comfortVessel,
                );
                checked.comfort = {
                    ...env.comfort,
                    ...(candidate.comfort?.relaxedFromM !== undefined
                        ? { relaxedFromM: candidate.comfort.relaxedFromM, usedLimitM: candidate.comfort.usedLimitM }
                        : {}),
                };
                const verdict = outcome.current;
                const verified =
                    verdict?.status === 'verified' && !env.rejected && replanWindCovered(checked, wind, departureMs);
                return {
                    result: checked,
                    verified,
                    reason: !verified
                        ? (verdict?.reason ?? 'Final waypoint weather or chart verification was incomplete.')
                        : undefined,
                };
            },
        });
        result.environmentNotes = [...new Set([...notes, ...(result.environmentNotes ?? [])])];
        const turns = detectTurnWaypoints(result.route, input.departureTime);
        for (let i = 1; i < constraints.points.length - 1; i++) {
            const point = constraints.points[i],
                index = result.route.findIndex((p) => haversineNm(p.lat, p.lon, point.lat, point.lon) * 1852 <= 1),
                node = result.route[index];
            if (!node) throw Error('A verified required point lost its modeled clock.');
            const existing = turns.findIndex((p) => haversineNm(p.lat, p.lon, node.lat, node.lon) * 1852 <= 1);
            const via = {
                id: `VIA${i}`,
                lat: node.lat,
                lon: node.lon,
                bearingChange: 0,
                bearing: node.bearing,
                timeHours: node.timeHours,
                distanceNM: node.distance,
                speed: node.speed,
                tws: node.tws,
                twa: node.twa,
                eta: new Date(departureMs + node.timeHours * 3600000).toISOString(),
            };
            if (existing < 0) turns.push(via);
            else turns[existing] = via;
        }
        turns.sort((a, b) => a.timeHours - b.timeHours || a.distanceNM - b.distanceNM);
        if (turns.length > 258)
            throw Error(
                'This route has too many intermediate turns to save atomically. Split it into reviewed passages.',
            );
        return {
            result,
            cells: [...cells],
            polarLabel: polar.label,
            points: constraints.points,
            turns,
            constraints: constraints.canonicalVias,
        };
    } finally {
        clearTimeout(timer);
        clearInterval(contextTimer);
        abort.abort();
    }
}
