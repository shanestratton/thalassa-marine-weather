import { supabase, getCurrentUserId } from '../supabase';
import { getAuthIdentityScope, isAuthIdentityScopeCurrent, subscribeAuthIdentityScope } from '../authIdentityScope';
import {
    createCruisingCatalogueClient,
    CRUISING_CATALOGUE_LIMITATION,
    type CatalogueDetail,
    type CataloguePosition,
    type CatalogueSummary,
    type CatalogueVersionRef,
} from './catalogue';
import type { CataloguePlanBinding, CataloguePlanSelection, CatalogueRouteConstraint } from './cataloguePlanningTypes';
import type { DayPlanCandidate } from './engine';
import type { DayPlannerActivity } from './destinations';
import { DAY_PLANNER_REGIONS } from './regions';
import { resolveTimeZone } from '../../utils/timezone';
import { isDayPlanTimeZone } from './presentation';

export const CATALOGUE_DISCOVERY_RADIUS_NM = 30;
export const CATALOGUE_DISCOVERY_LIMIT = 24;
export const CATALOGUE_READ_TIMEOUT_MS = 15_000;
type CatalogueClient = ReturnType<typeof createCruisingCatalogueClient>;
type Mode = 'return' | 'overnight';
export interface CatalogueChoices {
    status: 'ready' | 'empty' | 'unavailable';
    summaries: CatalogueSummary[];
    message: string;
}

const unavailable = () =>
    new Error(
        'This exact catalogue choice is unavailable or changed. Refresh the shared choices; no substitute route was used.',
    );
const abortError = () => new DOMException('Catalogue request cancelled or account changed.', 'AbortError');
const sameRef = (a: CatalogueVersionRef, b: CatalogueVersionRef) => a.id === b.id && a.version === b.version;
const key = (ref: CatalogueVersionRef) => `${ref.id}:${ref.version}`;
const idPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
function validRef(ref: CatalogueVersionRef | undefined): ref is CatalogueVersionRef {
    return (
        !!ref && idPattern.test(ref.id) && Number.isInteger(ref.version) && ref.version > 0 && ref.version <= 2147483647
    );
}
function validateSelection(selection: CataloguePlanSelection, mode: Mode) {
    if (
        !['return', 'overnight'].includes(mode) ||
        !validRef(selection) ||
        (selection.outbound !== undefined && !validRef(selection.outbound)) ||
        (selection.return !== undefined && !validRef(selection.return)) ||
        (mode === 'overnight' && selection.return !== undefined)
    )
        throw unavailable();
}
function samePosition(a: CataloguePosition, b: CataloguePosition) {
    return a.lat === b.lat && a.lon === b.lon;
}
function distanceNM(a: CataloguePosition, b: CataloguePosition) {
    const rad = Math.PI / 180;
    const h =
        Math.sin(((a.lat - b.lat) * rad) / 2) ** 2 +
        Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(((a.lon - b.lon) * rad) / 2) ** 2;
    return 3440.065 * 2 * Math.asin(Math.sqrt(Math.max(0, Math.min(1, h))));
}
function canonical(value: unknown): string {
    const normalize = (item: unknown): unknown =>
        Array.isArray(item)
            ? item.map(normalize)
            : item && typeof item === 'object'
              ? Object.fromEntries(
                    Object.entries(item)
                        .filter(([, v]) => v !== undefined)
                        .sort(([a], [b]) => a.localeCompare(b))
                        .map(([k, v]) => [k, normalize(v)]),
                )
              : item;
    return JSON.stringify(normalize(value));
}

/** Account-fenced, bounded reads only. No persistence, service key or private-track access. */
async function withCatalogueRead<T>(
    signal: AbortSignal,
    operation: (client: CatalogueClient, signal: AbortSignal) => Promise<T>,
): Promise<T> {
    signal.throwIfAborted();
    const scope = getAuthIdentityScope();
    if (!scope.userId || !supabase) throw new Error('Sign in to browse the shared cruising catalogue.');
    if (typeof navigator !== 'undefined' && navigator.onLine === false)
        throw new Error('The shared catalogue requires an online check.');
    const client = createCruisingCatalogueClient(supabase);
    const controller = new AbortController();
    const deadline = Date.now() + CATALOGUE_READ_TIMEOUT_MS;
    let failure: Error = abortError();
    const abort = () => controller.abort();
    const unsubscribe = subscribeAuthIdentityScope(() => {
        if (!isAuthIdentityScopeCurrent(scope)) abort();
    });
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => {
        failure = new Error('The shared catalogue check timed out. Try again.');
        abort();
    }, CATALOGUE_READ_TIMEOUT_MS);
    let rejectAbort: () => void = () => {};
    const cancelled = new Promise<never>((_, reject) => {
        rejectAbort = () => reject(failure);
        controller.signal.addEventListener('abort', rejectAbort, { once: true });
    });
    const check = () => {
        if (signal.aborted || !isAuthIdentityScopeCurrent(scope)) throw abortError();
        if (Date.now() >= deadline) {
            failure = new Error('The shared catalogue check timed out. Try again.');
            abort();
        }
        if (controller.signal.aborted) throw failure;
    };
    try {
        check();
        return await Promise.race([
            cancelled,
            (async () => {
                if ((await getCurrentUserId(scope)) !== scope.userId)
                    throw new Error('Sign in again before reading shared trips.');
                check();
                const result = await operation(client, controller.signal);
                check();
                return result;
            })(),
        ]);
    } finally {
        clearTimeout(timer);
        unsubscribe();
        signal.removeEventListener('abort', abort);
        controller.signal.removeEventListener('abort', rejectAbort);
        controller.abort();
    }
}

/** Only summaries are fetched here. Empty and failed reads stay distinguishable. */
export async function discoverCatalogueChoices(
    position: CataloguePosition,
    signal: AbortSignal,
): Promise<CatalogueChoices> {
    if (
        !Number.isFinite(position.lat) ||
        Math.abs(position.lat) > 80 ||
        !Number.isFinite(position.lon) ||
        Math.abs(position.lon) > 180
    )
        throw new Error('Choose a valid departure within 80° latitude.');
    const capturedPosition = { ...position };
    try {
        const summaries = await withCatalogueRead(signal, (client, active) =>
            client.nearby({
                position: capturedPosition,
                radiusNM: CATALOGUE_DISCOVERY_RADIUS_NM,
                limit: CATALOGUE_DISCOVERY_LIMIT,
                signal: active,
            }),
        );
        return summaries.length
            ? {
                  status: 'ready',
                  summaries,
                  message:
                      'Nearby reviewed source references. Access, route and weather suitability still need checking. This bounded list is not complete regional coverage.',
              }
            : {
                  status: 'empty',
                  summaries: [],
                  message:
                      'No published catalogue choices found within 30 nm. No reviewed local route available from this catalogue; local-guide or mapped-stop calculations remain available.',
              };
    } catch (error) {
        if (
            signal.aborted ||
            (error !== null && typeof error === 'object' && 'name' in error && error.name === 'AbortError')
        )
            throw error;
        return {
            status: 'unavailable',
            summaries: [],
            message:
                'Shared catalogue unavailable. Local-guide or mapped-stop calculations remain available; no cached catalogue choice will be substituted.',
        };
    }
}

export async function loadCatalogueChoice(
    reference: CatalogueVersionRef,
    signal: AbortSignal,
): Promise<CatalogueDetail> {
    if (!validRef(reference)) throw unavailable();
    const captured = { id: reference.id, version: reference.version };
    return withCatalogueRead(signal, async (client, active) => {
        const detail = await client.detail(captured, { signal: active });
        if (!detail || detail.kind === 'route_variant') throw unavailable();
        return detail;
    });
}

function assemble(selection: CataloguePlanSelection, mode: Mode, details: CatalogueDetail[]): DayPlanCandidate {
    validateSelection(selection, mode);
    if (
        !Array.isArray(details) ||
        details.length < 1 ||
        details.length > 5 ||
        new Set(details.map(key)).size !== details.length
    )
        throw unavailable();
    for (const detail of details) {
        if (
            !validRef(detail) ||
            !Number.isFinite(detail.position?.lat) ||
            Math.abs(detail.position.lat) > 80 ||
            !Number.isFinite(detail.position?.lon) ||
            Math.abs(detail.position.lon) > 180 ||
            !Number.isFinite(Date.parse(detail.review?.reviewedAt)) ||
            Date.parse(detail.review.reviewedAt) > Date.now() ||
            !Number.isFinite(Date.parse(detail.review?.reviewDueAt)) ||
            Date.parse(detail.review.reviewDueAt) <= Date.now()
        )
            throw unavailable();
    }
    const used: CatalogueDetail[] = [];
    const get = (ref: CatalogueVersionRef): CatalogueDetail => {
        const value = details.find((detail) => sameRef(ref, detail));
        if (!value || used.some((detail) => sameRef(value, detail))) throw unavailable();
        used.push(value);
        return value;
    };
    const selected = get(selection);
    let destination: Extract<CatalogueDetail, { kind: 'destination' }>;
    let outbound: CatalogueRouteConstraint | undefined;
    let homeward: CatalogueRouteConstraint | undefined;
    if (selected.kind === 'destination') {
        if (selection.outbound || selection.return) throw unavailable();
        destination = selected;
    } else if (selected.kind === 'trip') {
        const origin = get(selected.origin);
        const arrival = get(selected.destination);
        if (
            origin.kind !== 'destination' ||
            arrival.kind !== 'destination' ||
            !samePosition(selected.position, origin.position)
        )
            throw unavailable();
        destination = arrival;
        const variant = (
            ref: CatalogueVersionRef | undefined,
            direction: 'outbound' | 'return',
        ): CatalogueRouteConstraint => {
            if (!ref || !selected.variants.some((item) => sameRef(item, ref) && item.direction === direction))
                throw new Error(`Choose an available reviewed ${direction} variant. No route was substituted.`);
            const detail = get(ref);
            if (detail.kind !== 'route_variant' || !sameRef(detail.trip, selected) || detail.direction !== direction)
                throw unavailable();
            const first = direction === 'outbound' ? origin : arrival;
            const last = direction === 'outbound' ? arrival : origin;
            if (
                !samePosition(detail.position, first.position) ||
                !samePosition(detail.checkpoints[0], first.position) ||
                !samePosition(detail.checkpoints.at(-1)!, last.position)
            )
                throw unavailable();
            return {
                variant: { id: detail.id, version: detail.version },
                direction,
                checkpoints: structuredClone(detail.checkpoints),
            };
        };
        outbound = variant(selection.outbound, 'outbound');
        if (mode === 'return') homeward = variant(selection.return, 'return');
    } else throw unavailable();
    if (used.length !== details.length) throw unavailable();
    const zone = resolveTimeZone(destination.position.lat, destination.position.lon);
    if (!isDayPlanTimeZone(zone)) throw new Error('The catalogue stop’s time zone could not be established.');
    // The catalogue does not yet carry structured closures. Never erase the
    // bundled guide's known nearby restrictions when selecting a shared stop.
    const nearbyGuide = DAY_PLANNER_REGIONS.flatMap((region) => region.destinations).filter(
        (stop) => distanceNM(stop, destination.position) <= 0.5,
    );
    const allEvidence = used.flatMap((detail) => detail.evidence);
    const source = destination.evidence[0];
    if (!source) throw unavailable();
    const id = `catalogue:${selection.id}:v${selection.version}`;
    const unique = (notes: string[]) => [...new Set(notes)];
    const sourceLabels = new Map<string, Set<string>>();
    for (const item of [
        ...allEvidence.map((item) => ({ url: item.sourceUrl, label: `${item.sourceLabel} · ${item.attribution}` })),
        ...nearbyGuide.flatMap((stop) => [
            { url: stop.sourceUrl, label: stop.sourceLabel },
            ...(stop.supportingSources ?? []),
            ...(stop.knownClosures ?? []).map((closure) => ({
                url: closure.sourceUrl,
                label: 'Local guide · access notice',
            })),
        ]),
    ]) {
        const labels = sourceLabels.get(item.url) ?? new Set<string>();
        labels.add(item.label);
        sourceLabels.set(item.url, labels);
    }
    const binding: CataloguePlanBinding = {
        mode,
        selection: structuredClone(selection),
        details: structuredClone(used),
        ...(outbound ? { outbound } : {}),
        ...(homeward ? { return: homeward } : {}),
    };
    return {
        catalogue: binding,
        destination: {
            id,
            name: destination.name,
            ...destination.position,
            activities: destination.activities.filter((activity): activity is DayPlannerActivity =>
                ['snorkel', 'beach', 'walk', 'lunch', 'quiet', 'explore'].includes(activity),
            ),
            summary: selected.summary,
            sourceUrl: source.sourceUrl,
            sourceLabel: source.sourceLabel,
            verifiedAt: destination.review.reviewedAt.slice(0, 10),
            catalogueQuality: 'catalogue-reference',
            referencePosition: 'catalogue-reference',
            timeZone: zone,
            anchorageId: `catalogue:${destination.id}:v${destination.version}`,
            anchorageName: destination.name,
            accessNotes: unique([
                ...used.flatMap((detail) => detail.limitations),
                ...nearbyGuide.flatMap((stop) => stop.accessNotes),
            ]),
            uncertaintyNotes: [
                CRUISING_CATALOGUE_LIMITATION,
                'Catalogue stop suitability is incomplete: permission, shelter, holding and landing access are not established.',
                ...(outbound
                    ? [
                          'Required catalogue checkpoints guide a newly calculated and checked route; the stored line is not used as a safe route.',
                      ]
                    : ['No reviewed local route available. A new autoroute must be calculated and checked.']),
            ],
            supportingSources: [...sourceLabels].map(([url, labels]) => ({ url, label: [...labels].join(' / ') })),
            knownClosures: structuredClone(nearbyGuide.flatMap((stop) => stop.knownClosures ?? [])),
        },
        place: {
            id: `catalogue:${destination.id}:v${destination.version}`,
            ...destination.position,
            kind: 'catalogue-reference',
            source: 'shared-catalogue',
        },
    };
}

export async function loadCataloguePlan(
    selection: CataloguePlanSelection,
    mode: Mode,
    signal: AbortSignal,
): Promise<DayPlanCandidate> {
    validateSelection(selection, mode);
    const captured = structuredClone(selection);
    return withCatalogueRead(signal, async (client, active) => {
        const details: CatalogueDetail[] = [];
        const read = async (ref: CatalogueVersionRef) => {
            const detail = await client.detail(ref, { signal: active });
            if (!detail) throw unavailable();
            details.push(detail);
            return detail;
        };
        const selected = await read(captured);
        if (selected.kind === 'trip') {
            await read(selected.origin);
            await read(selected.destination);
            if (!captured.outbound || (mode === 'return' && !captured.return))
                throw new Error('Select reviewed route variants for every sailing leg.');
            await read(captured.outbound);
            if (mode === 'return') await read(captured.return!);
        }
        return assemble(captured, mode, details);
    });
}

/** Pure binding check, not a substitute for the fresh remote preflight. */
export function validateCatalogueCandidate(candidate: DayPlanCandidate, mode: Mode): void {
    const binding = candidate.catalogue;
    if (!binding || binding.mode !== mode) throw unavailable();
    const expected = assemble(binding.selection, mode, binding.details);
    if (
        canonical(expected.catalogue) !== canonical(binding) ||
        canonical(expected.destination) !== canonical(candidate.destination)
    )
        throw unavailable();
    // Runtime may add conservative restriction flags. It must never replace the
    // catalogue identity/position or pretend a reference is a confirmed mooring.
    if (
        candidate.place.id !== expected.place.id ||
        candidate.place.kind !== expected.place.kind ||
        candidate.place.source !== expected.place.source ||
        !samePosition(candidate.place, expected.place)
    )
        throw unavailable();
}

export async function revalidateCataloguePlan(binding: CataloguePlanBinding, signal: AbortSignal): Promise<void> {
    const captured = structuredClone(binding);
    const fresh = await loadCataloguePlan(captured.selection, captured.mode, signal);
    if (canonical(fresh.catalogue) !== canonical(captured) || canonical(binding) !== canonical(captured))
        throw unavailable();
}
