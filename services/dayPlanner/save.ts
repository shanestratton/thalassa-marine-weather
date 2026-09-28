import type { AutoroutingVesselProfile } from '../../types/autorouting';
import { validateAutoroutingVesselProfile } from '../../supabase/functions/_shared/autorouting-vessel';
import { isAuthIdentityScopeCurrent, type AuthIdentityScope } from '../authIdentityScope';
import { CONDITIONS_MAX_AGE_MS } from '../anchorages/placeConditions';
import { prepareReviewedAutoroutingProposal } from '../autoroutingProposalSave';
import { getRegistryFingerprint } from '../enc/EncCellMetadata';
import { saveTraceTrip, type SavedTrace } from '../routeTracer';
import type { PushResult } from '../savedRoutesSync';
import { CRUISING_CATALOGUE_LIMITATION } from './catalogue';
import { revalidateCataloguePlan, validateCatalogueCandidate } from './cataloguePlanning';
import type { CataloguePlanSelection } from './cataloguePlanningTypes';
import { assertCatalogueRouteCheckpoints, catalogueRouteWarnings } from './catalogueRouteConstraints';
import { DAY_PLAN_TIME_ZONE, dayPlanDateTime, dayPlanLocalDate, isDayPlanTimeZone } from './presentation';
import {
    assessDayPlanRoute,
    DAY_PLAN_DEFAULT_LIMITS,
    dayPlanDistanceNM,
    dayPlanRouteDistanceNM,
    validateDayPlanRequest,
    type DayPlanOption,
    type DayPlanRequest,
} from './engine';

export interface DayPlanSaveInput {
    option: DayPlanOption;
    request: DayPlanRequest;
    acknowledgedPlannedOnly: boolean;
    /** Prefer the result's calculation time, especially when forecasts are missing. */
    calculatedAt?: number;
    /** The UI supplies its current settings snapshot, not a fresh inferred vessel. */
    currentVesselProfile?: AutoroutingVesselProfile;
    currentVesselInputs?: { draftM: number; speedKts: number; maxWindKts?: number; maxWaveM?: number };
}

export interface DayPlanCatalogueSaveOptions {
    signal: AbortSignal;
    getCurrentVesselProfile: () => AutoroutingVesselProfile;
    getCurrentVesselInputs: () => {
        draftM: number;
        speedKts: number;
        maxWindKts?: number;
        maxWaveM?: number;
    };
}

export const DAY_PLAN_CATALOGUE_SAVE_TIMEOUT_MS = 15_000;
type DayPlanSaveResult = { traces: SavedTrace[]; cloud: Promise<PushResult[]> };

const HOUR_MS = 3_600_000;
const unchangedTime = (actual: number, expected: number) =>
    Number.isFinite(actual) && Number.isFinite(expected) && Math.abs(actual - expected) < 1;
const boundedText = (value: string, maximum = 4096) => {
    if (typeof value !== 'string' || !value.trim() || value.length > maximum)
        throw new Error('Itinerary notes are missing or too long. Nothing was saved.');
    return value.trim();
};
const shortName = (value: string) => {
    const text = boundedText(value, 500);
    return text.length > 52 ? `${text.slice(0, 51)}…` : text;
};

const hasCatalogueReference = ({ request, option }: DayPlanSaveInput) =>
    request.catalogueSelection !== undefined ||
    option.candidate.catalogue !== undefined ||
    option.candidate.destination.catalogueQuality === 'catalogue-reference' ||
    option.candidate.destination.referencePosition === 'catalogue-reference';

const selectionKey = (selection: CataloguePlanSelection | undefined) =>
    selection === undefined
        ? undefined
        : JSON.stringify([
              selection.id,
              selection.version,
              selection.outbound?.id,
              selection.outbound?.version,
              selection.return?.id,
              selection.return?.version,
          ]);

function assertCatalogueSelection(input: DayPlanSaveInput): void {
    const { catalogue, destination } = input.option.candidate;
    if (
        !catalogue ||
        !input.request.catalogueSelection ||
        catalogue.mode !== input.request.mode ||
        selectionKey(input.request.catalogueSelection) !== selectionKey(catalogue.selection) ||
        destination.catalogueQuality !== 'catalogue-reference' ||
        destination.referencePosition !== 'catalogue-reference'
    )
        throw new Error('The selected catalogue reference changed. Recalculate before saving.');
}

/** Catalogue saves must await a fresh public read. The synchronous entry point
 * cannot accept a caller-supplied timestamp or other reusable preflight token. */
export function saveDayPlan(input: DayPlanSaveInput, expectedScope: AuthIdentityScope): DayPlanSaveResult {
    if (hasCatalogueReference(input))
        throw new Error('Catalogue references require a fresh catalogue check before saving. Nothing was saved.');
    return commitDayPlan(input, expectedScope);
}

/** Re-read the exact catalogue versions, then cross the final local checks and
 * commit in one synchronous turn. Neither request data nor vessel getters can
 * update the detached itinerary while the public reads are pending. */
export async function saveDayPlanWithCatalogueCheck(
    input: DayPlanSaveInput,
    expectedScope: AuthIdentityScope,
    options: DayPlanCatalogueSaveOptions,
): Promise<DayPlanSaveResult> {
    const cancelled = () => new DOMException('Day-plan save cancelled. Nothing was saved.', 'AbortError');
    if (options.signal.aborted) throw cancelled();
    if (!hasCatalogueReference(input)) {
        const currentInput = {
            ...input,
            currentVesselProfile: options.getCurrentVesselProfile(),
            currentVesselInputs: options.getCurrentVesselInputs(),
        };
        if (options.signal.aborted) throw cancelled();
        return saveDayPlan(currentInput, expectedScope);
    }
    if (!expectedScope.userId || !isAuthIdentityScopeCurrent(expectedScope))
        throw new Error('Your account changed. Recalculate the day plan before saving.');

    const scope = { ...expectedScope };
    const snapshot = structuredClone(input);
    assertCatalogueSelection(snapshot);
    validateCatalogueCandidate(snapshot.option.candidate, snapshot.request.mode);
    validateDayPlanRequest(snapshot.request, Date.now());
    const selected = selectionKey(snapshot.request.catalogueSelection);
    const profile = validateAutoroutingVesselProfile(options.getCurrentVesselProfile());
    const vesselInputs = structuredClone(options.getCurrentVesselInputs());
    const profileKey = JSON.stringify(profile);
    const fingerprint = getRegistryFingerprint();
    snapshot.currentVesselProfile = profile;
    snapshot.currentVesselInputs = vesselInputs;

    const controller = new AbortController();
    let timeoutError: Error | undefined;
    const deadline = Date.now() + DAY_PLAN_CATALOGUE_SAVE_TIMEOUT_MS;
    const onCancel = () => controller.abort();
    const timeout = setTimeout(() => {
        timeoutError = new Error('The catalogue check timed out. Nothing was saved. Try again.');
        controller.abort();
    }, DAY_PLAN_CATALOGUE_SAVE_TIMEOUT_MS);
    options.signal.addEventListener('abort', onCancel, { once: true });
    let rejectAborted: () => void = () => undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
        rejectAborted = () => reject(timeoutError ?? cancelled());
        controller.signal.addEventListener('abort', rejectAborted, { once: true });
    });
    try {
        if (options.signal.aborted) controller.abort();
        await Promise.race([
            controller.signal.aborted
                ? Promise.reject(cancelled())
                : revalidateCataloguePlan(snapshot.option.candidate.catalogue!, controller.signal),
            aborted,
        ]);
        if (controller.signal.aborted || options.signal.aborted) throw timeoutError ?? cancelled();
        if (Date.now() >= deadline) throw new Error('The catalogue check timed out. Nothing was saved. Try again.');
        if (!isAuthIdentityScopeCurrent(scope))
            throw new Error('Your account changed. Recalculate the day plan before saving.');
        if (getRegistryFingerprint() !== fingerprint)
            throw new Error('Charts changed. Recalculate the day plan before saving.');
        assertCatalogueSelection(input);
        if (selectionKey(input.request.catalogueSelection) !== selected)
            throw new Error('The selected catalogue reference changed. Recalculate before saving.');
        if (JSON.stringify(validateAutoroutingVesselProfile(options.getCurrentVesselProfile())) !== profileKey)
            throw new Error('The vessel profile changed. Recalculate before saving.');
        const currentInputs = options.getCurrentVesselInputs();
        if (
            !(['draftM', 'speedKts', 'maxWindKts', 'maxWaveM'] as const).every((key) =>
                Object.is(currentInputs[key], vesselInputs[key]),
            )
        )
            throw new Error('Vessel draft, speed or weather limits changed. Recalculate before saving.');
        validateCatalogueCandidate(snapshot.option.candidate, snapshot.request.mode);
        if (controller.signal.aborted || options.signal.aborted) throw timeoutError ?? cancelled();
        return commitDayPlan(snapshot, scope);
    } finally {
        clearTimeout(timeout);
        options.signal.removeEventListener('abort', onCancel);
        controller.signal.removeEventListener('abort', rejectAborted);
    }
}

/** Saves only new canonical planned routes. All legs and notes are prepared
 * synchronously before the single local commit; this creates no voyage,
 * navigation verification, active route, log mirror or Float Plan. */
function commitDayPlan(input: DayPlanSaveInput, expectedScope: AuthIdentityScope): DayPlanSaveResult {
    if (!expectedScope.userId || !isAuthIdentityScopeCurrent(expectedScope))
        throw new Error('Your account changed. Recalculate the day plan before saving.');
    const now = Date.now();
    const { request, option } = input;
    validateDayPlanRequest(request, now);
    const current = input.currentVesselInputs;
    if (current !== undefined) {
        const positive = (value: number | undefined, maximum: number) =>
            typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= maximum;
        if (
            !current ||
            !positive(current.draftM, 30) ||
            !positive(current.speedKts, 100) ||
            current.draftM !== request.draftM ||
            current.speedKts !== request.speedKts ||
            (current.maxWindKts !== undefined &&
                (!positive(current.maxWindKts, 100) ||
                    (request.maxWindKts ?? DAY_PLAN_DEFAULT_LIMITS.maxWindKts) > current.maxWindKts)) ||
            (current.maxWaveM !== undefined &&
                (!positive(current.maxWaveM, 20) ||
                    (request.maxWaveM ?? DAY_PLAN_DEFAULT_LIMITS.maxWaveM) > current.maxWaveM))
        )
            throw new Error('Vessel draft, speed or weather limits changed. Recalculate before saving.');
    }
    if (request.departureMs <= now) throw new Error('Departure has passed. Recalculate the day plan.');
    const fresh = (value: number) =>
        Number.isFinite(value) && value <= now + 60_000 && value >= now - CONDITIONS_MAX_AGE_MS;
    if (input.calculatedAt !== undefined && !fresh(input.calculatedAt))
        throw new Error('The day-plan report is stale. Recalculate before saving.');
    if (option.conditions.fetchedAt !== undefined && !fresh(option.conditions.fetchedAt))
        throw new Error('The day-plan weather report is stale. Recalculate before saving.');
    if (option.transit.fetchedAt !== undefined && !fresh(option.transit.fetchedAt))
        throw new Error('The day-plan transit weather report is stale. Recalculate before saving.');
    if (
        [option.light, option.conditions.light, option.transit.light, option.routeCheck.light].some(
            (light) => !['green', 'amber', 'unknown'].includes(light),
        )
    )
        throw new Error('Adverse or restricted conditions remain unresolved. Nothing was saved.');
    if (option.candidate.place.noAnchoring && option.candidate.place.kind !== 'mooring')
        throw new Error('The proposed stop has a mapped no-anchoring restriction. Nothing was saved.');
    const destination = option.candidate.destination;
    if (request.destinationIds?.length && !request.destinationIds.includes(destination.id))
        throw new Error('The selected destination changed. Recalculate before saving.');
    const departureZone = request.timeZone ?? DAY_PLAN_TIME_ZONE;
    const destinationZone = destination.timeZone ?? departureZone;
    if (destination.timeZone !== undefined && !isDayPlanTimeZone(destination.timeZone))
        throw new Error('The destination time zone is invalid. Nothing was saved.');
    if (
        (destination.catalogueQuality === 'mapped-reference' ||
            destination.catalogueQuality === 'catalogue-reference') &&
        (option.light !== 'unknown' || option.conditions.light !== 'unknown')
    )
        throw new Error('A mapped or catalogue reference must retain its unassessed limitations. Nothing was saved.');
    if (
        !Number.isFinite(option.distanceNM) ||
        !Number.isFinite(option.sailingHours) ||
        !Number.isFinite(dayPlanDistanceNM(request.start, destination)) ||
        option.legs.length !== (request.mode === 'return' ? 2 : 1) ||
        !unchangedTime(option.departureMs, request.departureMs) ||
        !unchangedTime(option.arrivalMs, option.legs[0]?.arrivalMs) ||
        !unchangedTime(option.stayFromMs, option.arrivalMs) ||
        !unchangedTime(
            option.stayToMs,
            request.mode === 'return' ? option.stayFromMs + request.stopHours * HOUR_MS : request.overnightUntilMs!,
        ) ||
        option.stayToMs < option.stayFromMs + request.stopHours * HOUR_MS ||
        !unchangedTime(option.conditions.fromMs, option.stayFromMs) ||
        !unchangedTime(option.conditions.toMs, option.stayToMs) ||
        !unchangedTime(option.finishMs, request.mode === 'return' ? option.legs[1]?.arrivalMs : option.stayToMs)
    )
        throw new Error('The itinerary schedule changed. Recalculate before saving.');
    for (const closure of destination.knownClosures ?? []) {
        if (
            dayPlanLocalDate(option.stayFromMs, destinationZone) <= closure.throughDate &&
            dayPlanLocalDate(option.stayToMs, destinationZone) >= closure.fromDate
        )
            throw new Error(`Destination closure: ${closure.reason}`);
    }
    const profile = validateAutoroutingVesselProfile(input.currentVesselProfile ?? option.legs[0].route.vesselProfile);
    if (profile.draftStatus === 'missing') throw new Error('Vessel draft is missing. Recalculate before saving.');
    const profileKey = JSON.stringify(profile);
    const originName = shortName(request.start.label);
    const destinationName = shortName(destination.name);
    const reportNotes = [
        `Day plan: ${request.mode === 'return' ? 'return trip' : 'overnight stop'}; ${request.catalogueSelection ? 'chosen catalogue reference (activity preferences not applied)' : request.destinationIds?.length ? 'chosen destination (activity preferences not applied)' : request.activities.join(', ') || 'no activity preference'}; ${request.speedKts} kn planning speed.`,
        `Stay at ${destination.name}: ${dayPlanDateTime(option.stayFromMs, destinationZone)} to ${dayPlanDateTime(option.stayToMs, destinationZone)}.`,
        `Destination source: ${boundedText(destination.sourceLabel, 500)}; ${destination.catalogueQuality === 'catalogue-reference' ? 'reviewed editorial catalogue reference; approach and stop suitability remain unverified' : destination.catalogueQuality === 'mapped-reference' || !destination.verifiedAt ? 'unreviewed mapped reference' : `facts reviewed ${boundedText(destination.verifiedAt, 30)}`}; ${boundedText(destination.sourceUrl, 2048)}`,
        ...(option.candidate.catalogue
            ? [
                  CRUISING_CATALOGUE_LIMITATION,
                  `Catalogue versions: ${option.candidate.catalogue.details.map((detail) => `${detail.kind} ${detail.id} v${detail.version}`).join('; ')}.`,
              ]
            : []),
        ...(destination.supportingSources ?? []).map(
            (source) => `Supporting source: ${boundedText(source.label, 500)}; ${boundedText(source.url, 2048)}`,
        ),
        `Stop conditions (${option.conditions.light}): ${option.conditions.reasons.join(' ')}`,
        `Transit conditions (${option.transit.light}): ${option.transit.reasons.join(' ')}`,
        ...destination.accessNotes,
        ...destination.uncertaintyNotes,
        ...option.warnings,
        'Times are estimates at constant vessel speed; currents, tides and manoeuvring are not modelled. This is a planned itinerary, not navigation clearance.',
    ].map((note) => boundedText(note));
    let totalDistanceNM = 0;
    const prepared = option.legs.map((leg, index) => {
        const checkedAt = Date.parse(leg.review.basis?.checkedAt ?? '');
        if (!fresh(checkedAt)) throw new Error('A route review is stale. Recalculate before saving.');
        if (JSON.stringify(validateAutoroutingVesselProfile(leg.route.vesselProfile)) !== profileKey)
            throw new Error('The vessel profile changed. Recalculate before saving.');
        const constraint = index === 0 ? option.candidate.catalogue?.outbound : option.candidate.catalogue?.return;
        if (constraint) assertCatalogueRouteCheckpoints(leg.route.coordinates, constraint);
        const assessedRoute = {
            ...leg.route,
            warnings: [
                ...new Set([...leg.route.warnings, ...catalogueRouteWarnings(option.candidate.catalogue, constraint)]),
            ],
        };
        // These checks also reject provider/local danger and required tide clearance.
        assessDayPlanRoute(assessedRoute, leg.review, request.draftM);
        const distanceNM = dayPlanRouteDistanceNM(leg.route.coordinates);
        const from = index === 0 ? request.start : destination;
        const to = index === 0 ? destination : request.start;
        const first = leg.route.coordinates[0];
        const last = leg.route.coordinates.at(-1)!;
        if (
            dayPlanDistanceNM(from, { lon: first[0], lat: first[1] }) * 1852 > 20 ||
            dayPlanDistanceNM(to, { lon: last[0], lat: last[1] }) * 1852 > 20 ||
            !Number.isFinite(leg.distanceNM) ||
            Math.abs(leg.distanceNM - distanceNM) > 1e-9 ||
            !unchangedTime(leg.departureMs, index === 0 ? request.departureMs : option.stayToMs) ||
            !unchangedTime(leg.arrivalMs, leg.departureMs + (distanceNM / request.speedKts) * HOUR_MS)
        )
            throw new Error('The route or its sailing schedule changed. Recalculate before saving.');
        totalDistanceNM += distanceNM;
        const fromName = index === 0 ? originName : destinationName;
        const toName = index === 0 ? destinationName : originName;
        // Shallow clone only the changed warnings; the preparer detaches all saved
        // geometry/evidence and never persists the licensed raw route.source.
        const route = {
            ...assessedRoute,
            warnings: [
                ...new Set([
                    ...assessedRoute.warnings,
                    `Itinerary leg ${index + 1}: ${fromName} to ${toName}; depart ${dayPlanDateTime(leg.departureMs, index === 0 ? departureZone : destinationZone)}, arrive ${dayPlanDateTime(leg.arrivalMs, index === 0 ? destinationZone : departureZone)}.`,
                    ...reportNotes,
                ]),
            ],
        };
        return {
            ...prepareReviewedAutoroutingProposal(
                {
                    name: `${fromName} → ${toName}`,
                    route,
                    review: leg.review,
                    currentDraftM: request.draftM,
                    currentDraftAssumed: profile.draftStatus !== 'measured',
                    acknowledgedPlannedOnly: input.acknowledgedPlannedOnly,
                },
                expectedScope,
            ),
            destName: toName,
        };
    });
    if (
        Math.abs(option.distanceNM - totalDistanceNM) > 1e-9 ||
        Math.abs(option.sailingHours - totalDistanceNM / request.speedKts) > 1e-9 ||
        totalDistanceNM / request.speedKts > request.maxSailingHours + 1e-9 ||
        (request.mode === 'return' && request.returnByMs !== undefined && option.finishMs > request.returnByMs)
    )
        throw new Error('The sailing budget or return deadline no longer matches. Recalculate before saving.');
    const result = saveTraceTrip(prepared, expectedScope);
    if (!result.persisted)
        throw new Error('Device storage could not retain the complete itinerary. Nothing was saved.');
    return { traces: result.traces, cloud: result.cloud };
}
