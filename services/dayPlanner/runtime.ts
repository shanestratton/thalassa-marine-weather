import { booleanPointInPolygon } from '@turf/boolean-point-in-polygon';
import { lineIntersect } from '@turf/line-intersect';
import type { MultiPolygon, Polygon } from 'geojson';
import type { VesselProfile } from '../../types/vessel';
import type { AutoroutingTrialRequest, AutoroutingTrialRoute } from '../../types/autorouting';
import { AnchorageService } from '../anchorages/AnchorageService';
import { cachedConditionsForecast, loadPlaceConditions } from '../anchorages/PlaceConditionsService';
import { getAuthIdentityScope, isAuthIdentityScopeCurrent, subscribeAuthIdentityScope } from '../authIdentityScope';
import { autoroutingProposalGeometryKey } from '../autoroutingProposalEvidence';
import { reviewAutoroutingProposal } from '../autoroutingReview';
import { calculateThalassaProposal, getThalassaAutorouteStatus } from '../autoroutingThalassa';
import { snapshotAutoroutingVesselProfile } from '../autoroutingVesselProfile';
import { getRegistryFingerprint, subscribe as subscribeEncRegistry } from '../enc/EncCellMetadata';
import { FEET_PER_METRE, vesselDraftMetres } from '../units';
import { discoverMappedDayPlanCandidates } from './discovery';
import { resolvePlanningArea } from './regions';
import { loadCataloguePlan, revalidateCataloguePlan } from './cataloguePlanning';
import { CRUISING_CATALOGUE_LIMITATION } from './catalogue';
import {
    buildFlexibleDayPlan,
    DAY_PLAN_DEFAULT_LIMITS,
    DAY_PLAN_MAX_FORECAST_CELLS,
    dayPlanDistanceNM,
    validateDayPlanRequest,
    type DayPlanCandidate,
    type DayPlanPoint,
    type DayPlanProgress,
    type DayPlanRequest,
    type DayPlanResult,
    type DayPlannerDependencies,
} from './engine';

export const DAY_PLANNER_TIMEOUT_MS = 240_000;

/** A catalogue trip whose route must pass required checkpoints (2026-10-01):
 * Thalassa's router takes two pins, so the candidate is excluded rather than
 * routed without them. Chaining legs through the checkpoints is a follow-up. */
export const DAY_PLANNER_CHECKPOINTS_UNSUPPORTED =
    'This catalogue trip needs checkpoints Auto cannot follow yet. Plot it in Manual.';
export interface DayPlannerRunOptions {
    signal: AbortSignal;
    mapboxToken: string;
    onProgress?: (progress: DayPlanProgress) => void;
}
export interface DayPlannerVesselInputs {
    speedKts: number;
    draftM: number;
    maxWindKts?: number;
    maxWaveM?: number;
}

const between = (value: unknown, minimum: number, maximum: number): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum;

/** Saved performance only. Do not derive speed or wave tolerance from hull
 * length, or substitute a default draft for an incomplete vessel profile. */
export function dayPlannerVesselInputs(vessel: VesselProfile): DayPlannerVesselInputs {
    const draftM = vesselDraftMetres(vessel, Number.NaN);
    if (vessel?.type === 'observer' || !between(vessel?.cruisingSpeed, 0.5, 100))
        throw new Error('Set a valid cruising speed in Vessel settings before planning a day.');
    if (!between(draftM, 0.1, 30))
        throw new Error('Set a valid vessel draft in Vessel settings before planning a day.');
    if (vessel.maxWindSpeed !== undefined && vessel.maxWindSpeed !== 0 && !between(vessel.maxWindSpeed, 0.1, 100))
        throw new Error('Check the saved vessel wind limit in Vessel settings.');
    if (
        vessel.maxWaveHeight !== undefined &&
        vessel.maxWaveHeight !== 0 &&
        !between(vessel.maxWaveHeight / FEET_PER_METRE, 0.1, 20)
    )
        throw new Error('Check the saved vessel wave limit in Vessel settings.');
    return {
        speedKts: vessel.cruisingSpeed,
        draftM,
        ...(between(vessel.maxWindSpeed, 0.1, 100) ? { maxWindKts: vessel.maxWindSpeed } : {}),
        ...(between(vessel.maxWaveHeight / FEET_PER_METRE, 0.1, 20)
            ? { maxWaveM: vessel.maxWaveHeight / FEET_PER_METRE }
            : {}),
    };
}

/** Validate before containment: malformed mapped boundaries cannot be treated
 * as an absence of restrictions or as an inapplicable canal departure. */
function validArea(area: Polygon | MultiPolygon): boolean {
    if (!area || (area.type !== 'Polygon' && area.type !== 'MultiPolygon') || !Array.isArray(area.coordinates))
        return false;
    const polygons = area.type === 'Polygon' ? [area.coordinates] : area.coordinates;
    if (!polygons.length) return false;
    for (const rings of polygons) {
        if (!Array.isArray(rings) || !rings.length) return false;
        for (const ring of rings) {
            if (
                !Array.isArray(ring) ||
                ring.length < 4 ||
                !ring.every(
                    (point) => Array.isArray(point) && between(point[0], -180, 180) && between(point[1], -90, 90),
                ) ||
                ring[0][0] !== ring[ring.length - 1][0] ||
                ring[0][1] !== ring[ring.length - 1][1]
            )
                return false;
            const vertices = ring.slice(0, -1);
            // A repeated vertex (other than closure), collapsed ring or
            // backtracking edge cannot describe a usable restriction boundary.
            const unique = new Set(vertices.map(([lon, lat]) => `${lon},${lat}`));
            if (unique.size < 3 || unique.size !== vertices.length) return false;
            let twiceArea = 0;
            for (let i = 0; i < vertices.length; i++) {
                const a = vertices[i],
                    b = vertices[(i + 1) % vertices.length],
                    c = vertices[(i + 2) % vertices.length];
                twiceArea += (a[0] - ring[0][0]) * (b[1] - ring[0][1]) - (b[0] - ring[0][0]) * (a[1] - ring[0][1]);
                const ab = [b[0] - a[0], b[1] - a[1]],
                    bc = [c[0] - b[0], c[1] - b[1]];
                if (Math.abs(ab[0] * bc[1] - ab[1] * bc[0]) <= 1e-14 && ab[0] * bc[0] + ab[1] * bc[1] < 0) return false;
            }
            if (!Number.isFinite(twiceArea) || Math.abs(twiceArea) <= 1e-14) return false;
        }
        // Holes must be strictly inside the exterior and cannot contain each
        // other. Crossing boundaries are rejected by the sweep below.
        for (let i = 1; i < rings.length; i++) {
            if (
                !booleanPointInPolygon(
                    rings[i][0],
                    { type: 'Polygon', coordinates: [rings[0]] },
                    { ignoreBoundary: true },
                )
            )
                return false;
            for (let j = 1; j < i; j++) {
                if (
                    booleanPointInPolygon(rings[i][0], { type: 'Polygon', coordinates: [rings[j]] }) ||
                    booleanPointInPolygon(rings[j][0], { type: 'Polygon', coordinates: [rings[i]] })
                )
                    return false;
            }
        }
    }
    try {
        return (
            lineIntersect(area, { type: 'FeatureCollection', features: [] }, { ignoreSelfIntersections: false })
                .features.length === 0
        );
    } catch {
        return false;
    }
}

function contains(area: Polygon | MultiPolygon, point: DayPlanPoint): boolean {
    if (!validArea(area)) throw new Error('Mapped restriction or channel-area geometry is unavailable.');
    return booleanPointInPolygon([point.lon, point.lat], area, { ignoreBoundary: false });
}

/** Disposable integration only: no saved route, active voyage, chart registration,
 * navigation activation or account-specific cache is written here. */
export async function runDayPlanner(
    request: DayPlanRequest,
    vessel: VesselProfile,
    options: DayPlannerRunOptions,
): Promise<DayPlanResult> {
    const scope = getAuthIdentityScope();
    const cancelled = () => new DOMException('Day planning was cancelled or the account changed.', 'AbortError');
    if (options.signal.aborted || !isAuthIdentityScopeCurrent(scope)) throw cancelled();
    if (!scope.userId) throw new Error('Sign in to use Plan my day.');
    const capturedVessel = structuredClone(vessel);
    const vesselKey = JSON.stringify(vessel);
    const inputs = dayPlannerVesselInputs(capturedVessel);
    const input = structuredClone(request);
    if (!between(input.start?.lat, -80, 80) || !between(input.start?.lon, -180, 180))
        throw new Error('Choose a valid departure within 80° latitude.');
    const area = resolvePlanningArea(input.start);
    if (input.timeZone !== undefined && input.timeZone !== area.timeZone)
        throw new Error('The departure time zone changed. Refresh the plan for the selected departure.');
    input.timeZone = area.timeZone;
    if (Math.abs(input.speedKts - inputs.speedKts) > 1e-6 || Math.abs(input.draftM - inputs.draftM) > 1e-6)
        throw new Error('The vessel speed or draft changed. Refresh the plan from the current Vessel settings.');
    for (const key of ['maxWindKts', 'maxWaveM'] as const)
        if (inputs[key] !== undefined && input[key] !== undefined && input[key]! > inputs[key]!)
            throw new Error('The selected weather limits exceed the saved vessel limits.');
        else if (inputs[key] !== undefined && input[key] === undefined)
            input[key] = Math.min(inputs[key]!, DAY_PLAN_DEFAULT_LIMITS[key]);
    validateDayPlanRequest(input, Date.now());
    if (
        input.destinationIds?.length &&
        (!area.region || input.destinationIds.some((id) => !area.region!.destinations.some((stop) => stop.id === id)))
    )
        throw new Error('The selected destination is not in this departure area. Refresh the local choices.');
    const profile = snapshotAutoroutingVesselProfile(capturedVessel);
    const profileKey = JSON.stringify(profile);
    const draftAssumed = profile.draftStatus !== 'measured';
    // The provider already lists what it read of the boat (thalassaVesselWarnings).
    const vesselWarnings: string[] = [];
    if (capturedVessel.estimatedFields?.includes('cruisingSpeed'))
        vesselWarnings.push('Cruising speed is estimated; arrival and return times are estimates.');
    const controller = new AbortController();
    const deadlineAtMs = Date.now() + DAY_PLANNER_TIMEOUT_MS;
    let failure: Error = cancelled();
    const stop = () => controller.abort();
    const timeout = setTimeout(() => {
        failure = new Error('Day planning timed out. Try a shorter sailing budget or fewer activities.');
        stop();
    }, DAY_PLANNER_TIMEOUT_MS);
    options.signal.addEventListener('abort', stop, { once: true });
    const unsubscribeAuth = subscribeAuthIdentityScope(() => {
        if (!isAuthIdentityScopeCurrent(scope)) stop();
    });
    const check = () => {
        if (options.signal.aborted || !isAuthIdentityScopeCurrent(scope)) throw cancelled();
        if (controller.signal.aborted) throw failure;
        if (Date.now() >= deadlineAtMs) {
            failure = new Error('Day planning timed out. Try again.');
            stop();
            throw failure;
        }
        if (JSON.stringify(vessel) !== vesselKey) {
            failure = new Error('The vessel profile changed during planning. Calculate a new plan.');
            stop();
            throw failure;
        }
    };
    // These races also bound existing anchorage/weather calls that do not accept
    // AbortSignal. Their late completion cannot publish this account's results.
    const wait = <T>(operation: Promise<T>): Promise<T> => {
        check();
        return new Promise<T>((resolve, reject) => {
            const abort = () => {
                controller.signal.removeEventListener('abort', abort);
                reject(failure);
            };
            controller.signal.addEventListener('abort', abort, { once: true });
            operation
                .then((value) => {
                    try {
                        check();
                        resolve(value);
                    } catch (error) {
                        reject(error);
                    }
                }, reject)
                .finally(() => controller.signal.removeEventListener('abort', abort));
            if (controller.signal.aborted) abort();
        });
    };
    try {
        check();
        // Thalassa's router on this phone (2026-10-01): a signed-in identity
        // and installed navigation charts. No server status call.
        const status = getThalassaAutorouteStatus();
        if (!status.enabled || !status.ready)
            throw new Error(status.message || 'Plan my day needs installed charts for Auto routing.');
        const excluded: DayPlanResult['excluded'] = [];
        const candidates: DayPlanCandidate[] = [];
        const coverage: NonNullable<DayPlanResult['coverage']> = {
            id: area.id,
            name: area.name,
            type: area.coverage,
            timeZone: area.timeZone,
            sourceAttributions: area.region
                ? [...area.region.sourceAttributions]
                : ['OpenStreetMap contributors (ODbL)'],
            limitations: [],
        };
        let referencesFreshUntilMs = Number.POSITIVE_INFINITY;
        if (input.catalogueSelection) {
            const candidate = await wait(loadCataloguePlan(input.catalogueSelection, input.mode, controller.signal));
            check();
            if (!candidate.catalogue) throw new Error('The selected catalogue evidence is unavailable.');
            // The atlas supplies known restrictions only. Missing geographic
            // coverage never establishes current permission or safe anchoring.
            const nearby = await wait(
                AnchorageService.loadNear(candidate.destination.lat, candidate.destination.lon, 1),
            );
            if (
                !nearby ||
                nearby.points?.type !== 'FeatureCollection' ||
                !Array.isArray(nearby.points.features) ||
                nearby.noAnchor?.type !== 'FeatureCollection' ||
                !Array.isArray(nearby.noAnchor.features) ||
                nearby.points.features.length > 10000 ||
                nearby.noAnchor.features.length > 10000
            )
                throw new Error('Mapped restriction data is unavailable for the selected catalogue stop.');
            let restricted = false;
            for (const feature of nearby.noAnchor.features) {
                if (!feature || feature.type !== 'Feature' || !validArea(feature.geometry))
                    throw new Error('Mapped restriction geometry is unavailable for the selected catalogue stop.');
                if (contains(feature.geometry, candidate.destination)) restricted = true;
            }
            for (const feature of nearby.points.features) {
                const coordinates = feature?.geometry?.coordinates;
                const properties = feature?.properties;
                if (
                    !feature ||
                    feature.type !== 'Feature' ||
                    feature.geometry?.type !== 'Point' ||
                    !Array.isArray(coordinates) ||
                    coordinates.length !== 2 ||
                    !between(coordinates[0], -180, 180) ||
                    !between(coordinates[1], -90, 90) ||
                    !properties ||
                    (properties.noAnchoring !== undefined && typeof properties.noAnchoring !== 'boolean') ||
                    (properties.notes != null &&
                        (typeof properties.notes !== 'string' || properties.notes.length > 10000))
                )
                    throw new Error('Mapped restriction data is invalid for the selected catalogue stop.');
                if (
                    dayPlanDistanceNM(candidate.destination, { lon: coordinates[0], lat: coordinates[1] }) * 1852 <=
                        20 &&
                    (properties.noAnchoring ||
                        /\b(?:no[ -]?anchor(?:ing|age)?|(?:do\s+not|must\s+not|not\s+permitted\s+to|not\s+allowed\s+to)\s+anchor|anchor(?:ing|age)?\s+(?:is\s+)?(?:not\s+(?:allowed|permitted)|prohibited|forbidden|banned)|private|no\s+access|restricted|closed|exclusion\s+zone|(?:permit|permission)\s+required)\b/i.test(
                            properties.notes ?? '',
                        ))
                )
                    restricted = true;
            }
            candidate.place.noAnchoring = candidate.place.noAnchoring === true || restricted;
            candidates.push(candidate);
            coverage.id = 'shared-catalogue';
            coverage.name = 'Shared cruising catalogue';
            coverage.type = 'catalogue-reference';
            coverage.sourceAttributions = [
                ...new Set(
                    candidate.catalogue.details.flatMap((detail) =>
                        detail.evidence.map((source) => source.attribution),
                    ),
                ),
            ];
            coverage.limitations = [
                CRUISING_CATALOGUE_LIMITATION,
                'Known mapped restrictions were checked where available; current worldwide access and anchoring permission remain unverified.',
            ];
            await wait(revalidateCataloguePlan(candidate.catalogue, controller.signal));
        } else if (!area.region) {
            const discovery = await wait(
                discoverMappedDayPlanCandidates(input, { signal: controller.signal, timeZone: area.timeZone }),
            );
            candidates.push(...discovery.candidates);
            excluded.push(...discovery.excluded);
            coverage.limitations = discovery.limitations;
            coverage.radiusNM = discovery.radiusNM;
            coverage.tiles = discovery.tileKeys.length;
            referencesFreshUntilMs = discovery.freshUntilMs;
        } else {
            // Public reviewed catalogue centre, never the private yacht position.
            const { center, radiusNM } = area.region.reference;
            const data = await wait(AnchorageService.loadNear(center.lat, center.lon, radiusNM));
            for (const destination of area.region.destinations) {
                if (input.destinationIds?.length && !input.destinationIds.includes(destination.id)) continue;
                const matches = data.points.features.filter(
                    (feature) => feature.properties.id === destination.anchorageId,
                );
                const feature = matches.length === 1 ? matches[0] : undefined;
                if (
                    !feature ||
                    feature.geometry?.type !== 'Point' ||
                    feature.geometry.coordinates[0] !== destination.lon ||
                    feature.geometry.coordinates[1] !== destination.lat ||
                    feature.properties.name !== destination.anchorageName ||
                    !['anchorage', 'designated_anchorage'].includes(feature.properties.kind)
                ) {
                    excluded.push({
                        name: destination.name,
                        reason: 'The exact documented anchorage reference is unavailable.',
                    });
                    continue;
                }
                const mappedRestriction = data.noAnchor.features.some((restriction) =>
                    contains(restriction.geometry, destination),
                );
                candidates.push({
                    destination: structuredClone(destination),
                    place: {
                        id: feature.properties.id,
                        lat: feature.geometry.coordinates[1],
                        lon: feature.geometry.coordinates[0],
                        kind: feature.properties.kind,
                        source: feature.properties.source,
                        noAnchoring: feature.properties.noAnchoring === true || mappedRestriction,
                        fetchLandNM: feature.properties.fetchLandNM ? [...feature.properties.fetchLandNM] : undefined,
                    },
                });
            }
        }
        const dependencies: DayPlannerDependencies = {
            now: Date.now,
            async route(from, to, _signal, constraint) {
                check();
                // Excluded per candidate (the engine's catch puts it in
                // `excluded`); the rest of the plan still runs.
                if (constraint) throw new Error(DAY_PLANNER_CHECKPOINTS_UNSUPPORTED);
                const routeRequest: AutoroutingTrialRequest = {
                    departure: { ...from },
                    destination: { ...to },
                    speedKts: inputs.speedKts,
                    draftM: inputs.draftM,
                    vesselProfile: structuredClone(profile),
                };
                // One engine route per leg, in turn (the engine is synchronous
                // on the phone). It routes from the berth itself: the retired
                // automatic canal exit is not consulted, and offline the Newport
                // estate refuses in the engine's own words (owner decision 2).
                let route: AutoroutingTrialRoute = await wait(
                    calculateThalassaProposal(routeRequest, controller.signal),
                );
                check();
                if (route.provider !== 'Thalassa' || JSON.stringify(route.vesselProfile) !== profileKey)
                    throw new Error('The routing response did not preserve the current vessel profile.');
                route = {
                    ...route,
                    coordinates: route.coordinates.map(([lon, lat]) => [lon, lat]),
                    warnings: [...new Set([...route.warnings, ...vesselWarnings])],
                };
                const geometryKey = autoroutingProposalGeometryKey(route.coordinates);
                if (!geometryKey) throw new Error('The routing response contains invalid geometry.');
                const fingerprint = getRegistryFingerprint();
                const unsubscribeRegistry = subscribeEncRegistry(() => {
                    if (getRegistryFingerprint() !== fingerprint) {
                        failure = new Error('The chart library changed during route review. Calculate a new plan.');
                        stop();
                    }
                });
                try {
                    const review = await wait(
                        reviewAutoroutingProposal(route, inputs.draftM, controller.signal, () => {}, {
                            draftAssumed,
                        }),
                    );
                    check();
                    if (
                        getRegistryFingerprint() !== fingerprint ||
                        autoroutingProposalGeometryKey(route.coordinates) !== geometryKey ||
                        JSON.stringify(route.vesselProfile) !== profileKey
                    )
                        throw new Error('Route geometry, vessel inputs or chart evidence changed during review.');
                    if (review.phase !== 'complete') throw new Error('The route review did not complete.');
                    return {
                        route,
                        review: {
                            ...review,
                            basis: {
                                proposalId: route.id,
                                geometryKey,
                                draftM: inputs.draftM,
                                draftAssumed,
                                vesselProfileKey: profileKey,
                                registryFingerprint: fingerprint,
                                checkedAt: new Date().toISOString(),
                            },
                        },
                    };
                } finally {
                    unsubscribeRegistry();
                }
            },
            async forecast(points) {
                check();
                if (!points.length || points.length > DAY_PLAN_MAX_FORECAST_CELLS)
                    throw new Error('The route exceeds the bounded weather coverage budget.');
                const places = points.map((point, index) => ({
                    ...point,
                    id: `day-plan-weather-${index}`,
                    kind: 'transit',
                }));
                await wait(loadPlaceConditions(places, { forecastDays: 7, maxProviderDistanceNM: 5 }));
                check();
                return points.map((point) => cachedConditionsForecast(point, { maxProviderDistanceNM: 5 }));
            },
        };
        const result = await wait(
            buildFlexibleDayPlan(input, candidates, dependencies, {
                signal: controller.signal,
                onProgress: (progress) => {
                    try {
                        check();
                    } catch {
                        return;
                    }
                    options.onProgress?.(progress);
                },
            }),
        );
        check();
        for (const candidate of candidates) {
            if (candidate.catalogue) await wait(revalidateCataloguePlan(candidate.catalogue, controller.signal));
        }
        check();
        if (Date.now() >= referencesFreshUntilMs)
            throw new Error('Mapped-stop references expired during planning. Calculate a new plan.');
        if (
            result.options.some((option) =>
                option.legs.some((leg) => leg.review.basis?.registryFingerprint !== getRegistryFingerprint()),
            )
        )
            throw new Error('The chart library changed during planning. Calculate a new plan.');
        return { ...result, coverage, excluded: [...excluded, ...result.excluded] };
    } finally {
        clearTimeout(timeout);
        options.signal.removeEventListener('abort', stop);
        unsubscribeAuth();
        stop();
    }
}
