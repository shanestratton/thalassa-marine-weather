import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthIdentityScope } from '../services/authIdentityScope';
import type { AutoroutingTrialRoute, AutoroutingVesselProfile } from '../types/autorouting';
import { autoroutingProposalGeometryKey } from '../services/autoroutingProposalEvidence';
import { getRegistryFingerprint } from '../services/enc/EncCellMetadata';
import type { CataloguePlanSelection } from '../services/dayPlanner/cataloguePlanningTypes';
import { WHITSUNDAYS_DAY_DESTINATIONS } from '../services/dayPlanner/destinations';
import { buildDayPlan, type DayPlanRequest, type DayPlannerDependencies } from '../services/dayPlanner/engine';
import { saveDayPlanWithCatalogueCheck } from '../services/dayPlanner/save';

const mock = vi.hoisted(() => ({
    rpc: vi.fn(),
    commit: vi.fn(),
    currentUser: vi.fn(),
    scope: { userId: 'catalogue-owner', key: 'user:catalogue-owner', generation: 1 } as AuthIdentityScope,
    listeners: new Set<() => void>(),
    signals: [] as AbortSignal[],
}));
vi.mock('../services/supabase', () => ({
    supabase: { rpc: mock.rpc },
    getCurrentUserId: mock.currentUser,
}));
vi.mock('../services/routeTracer', () => ({ saveTraceTrip: mock.commit, saveTrace: vi.fn() }));
vi.mock('../services/authIdentityScope', () => ({
    getAuthIdentityScope: () => mock.scope,
    isAuthIdentityScopeCurrent: (scope: AuthIdentityScope) =>
        scope.key === mock.scope.key && scope.generation === mock.scope.generation,
    subscribeAuthIdentityScope: (listener: () => void) => {
        mock.listeners.add(listener);
        return () => mock.listeners.delete(listener);
    },
}));

import {
    CATALOGUE_DISCOVERY_LIMIT,
    CATALOGUE_DISCOVERY_RADIUS_NM,
    CATALOGUE_READ_TIMEOUT_MS,
    discoverCatalogueChoices,
    loadCatalogueChoice,
    loadCataloguePlan,
    revalidateCataloguePlan,
    validateCatalogueCandidate,
} from '../services/dayPlanner/cataloguePlanning';

const NOW = Date.parse('2026-09-28T00:00:00Z');
const ORIGIN = '00000000-0000-4000-8000-000000000001';
const DESTINATION = '00000000-0000-4000-8000-000000000002';
const TRIP = '00000000-0000-4000-8000-000000000003';
const OUTBOUND = '00000000-0000-4000-8000-000000000004';
const RETURN = '00000000-0000-4000-8000-000000000005';
const departure = { lat: -20.2, lon: 148.9 };
const arrival = { lat: -20.21, lon: 148.92 };
type WireRow = Record<string, unknown>;
type WireResponse = { data: unknown; error: unknown };
const signal = () => new AbortController().signal;
const destinationRef = { id: DESTINATION, version: 2 };
const tripSelection = (): CataloguePlanSelection => ({
    id: TRIP,
    version: 3,
    outbound: { id: OUTBOUND, version: 4 },
    return: { id: RETURN, version: 5 },
});

function summary(overrides: WireRow = {}) {
    return {
        entry_id: ORIGIN,
        version: 1,
        kind: 'destination',
        name: 'Synthetic catalogue origin',
        summary: 'Synthetic fixture only; not a route or location recommendation.',
        latitude: departure.lat,
        longitude: departure.lon,
        distance_nm: 0,
        status: 'published',
        review_status: 'reviewed',
        reviewed_at: '2026-09-27T00:00:00Z',
        review_due_at: '2026-10-27T00:00:00Z',
        ...overrides,
    };
}

function detail(overrides: WireRow = {}): WireRow {
    const { distance_nm: _distance, ...base } = summary();
    return {
        ...base,
        reviewer_label: 'Synthetic fixture editor',
        review_scope: 'Editorial fixture facts only',
        evidence: [
            {
                source_url: 'https://example.com/catalogue-source',
                source_label: 'Synthetic evidence',
                retrieved_at: '2026-09-26T00:00:00Z',
                licence: 'Synthetic fixture licence',
                licence_url: 'https://example.com/licence',
                attribution: 'Synthetic fixture attribution',
                scope: 'Editorial facts only',
            },
        ],
        limitations: ['Synthetic fixture; access and safe approach are not established.'],
        activities: ['beach'],
        origin_destination_id: null,
        origin_destination_version: null,
        destination_id: null,
        destination_version: null,
        trip_id: null,
        trip_version: null,
        direction: null,
        checkpoints: null,
        variants: [],
        variants_truncated: false,
        ...overrides,
    };
}

function routeVariant(direction: 'outbound' | 'return'): WireRow {
    const from = direction === 'outbound' ? departure : arrival;
    const to = direction === 'outbound' ? arrival : departure;
    return detail({
        entry_id: direction === 'outbound' ? OUTBOUND : RETURN,
        version: direction === 'outbound' ? 4 : 5,
        kind: 'route_variant',
        name: `Synthetic ${direction} variant`,
        latitude: from.lat,
        longitude: from.lon,
        trip_id: TRIP,
        trip_version: 3,
        direction,
        checkpoints: [
            {
                sequence: 1,
                name: 'Required departure',
                latitude: from.lat,
                longitude: from.lon,
                required: true,
                evidence_note: 'Synthetic departure constraint',
            },
            {
                sequence: 2,
                name: `${direction} bend`,
                latitude: direction === 'outbound' ? -20.204 : -20.207,
                longitude: direction === 'outbound' ? 148.915 : 148.905,
                required: true,
                evidence_note: 'Synthetic direction-specific constraint',
            },
            {
                sequence: 3,
                name: 'Required arrival',
                latitude: to.lat,
                longitude: to.lon,
                required: true,
                evidence_note: 'Synthetic arrival constraint',
            },
        ],
    });
}

function graph(): Map<string, WireRow | null> {
    return new Map([
        [ORIGIN, detail()],
        [
            DESTINATION,
            detail({
                entry_id: DESTINATION,
                version: 2,
                name: 'Synthetic catalogue arrival',
                latitude: arrival.lat,
                longitude: arrival.lon,
            }),
        ],
        [
            TRIP,
            detail({
                entry_id: TRIP,
                version: 3,
                kind: 'trip',
                name: 'Synthetic editorial trip',
                origin_destination_id: ORIGIN,
                origin_destination_version: 1,
                destination_id: DESTINATION,
                destination_version: 2,
                variants: [
                    { entry_id: OUTBOUND, version: 4, direction: 'outbound', name: 'Required outbound variant' },
                    { entry_id: RETURN, version: 5, direction: 'return', name: 'Distinct return variant' },
                ],
            }),
        ],
        [OUTBOUND, routeVariant('outbound')],
        [RETURN, routeVariant('return')],
    ]);
}

function rpcReply(response: Promise<WireResponse>) {
    return Object.assign(response, {
        abortSignal: (active: AbortSignal) => {
            mock.signals.push(active);
            return response;
        },
    });
}

function deferredResponse() {
    let resolve!: (response: WireResponse) => void;
    const response = new Promise<WireResponse>((complete) => {
        resolve = complete;
    });
    return { response: rpcReply(response), resolve };
}

let rows: Map<string, WireRow | null>;
beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    mock.scope = { userId: 'catalogue-owner', key: 'user:catalogue-owner', generation: 1 };
    mock.listeners.clear();
    mock.signals.length = 0;
    mock.currentUser.mockReset().mockResolvedValue('catalogue-owner');
    mock.commit.mockReset().mockImplementation((prepared) => ({
        persisted: true,
        traces: structuredClone(prepared),
        cloud: Promise.resolve(prepared.map(() => 'ok')),
    }));
    rows = graph();
    mock.rpc.mockReset().mockImplementation((name: string, args: Record<string, unknown>) => {
        const data = name === 'nearby_cruising_catalogue' ? [summary()] : (rows.get(String(args.p_id)) ?? null);
        return rpcReply(Promise.resolve({ data: structuredClone(data), error: null }));
    });
});
afterEach(() => {
    expect(mock.listeners.size).toBe(0);
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe('account-fenced lazy catalogue discovery', () => {
    it('requests bounded public summaries only and separately loads the chosen exact detail', async () => {
        const result = await discoverCatalogueChoices(departure, signal());
        expect(result.status).toBe('ready');
        expect(result.summaries).toHaveLength(1);
        expect(result.message).toContain('not complete regional coverage');
        expect(mock.currentUser).toHaveBeenCalledWith(mock.scope);
        expect(mock.rpc).toHaveBeenCalledExactlyOnceWith('nearby_cruising_catalogue', {
            p_latitude: departure.lat,
            p_longitude: departure.lon,
            p_radius_nm: CATALOGUE_DISCOVERY_RADIUS_NM,
            p_limit: CATALOGUE_DISCOVERY_LIMIT,
        });
        expect(result.summaries[0]).not.toHaveProperty('checkpoints');
        const chosen = await loadCatalogueChoice({ id: ORIGIN, version: 1 }, signal());
        expect(chosen.kind).toBe('destination');
        expect(mock.rpc).toHaveBeenLastCalledWith('cruising_catalogue_detail', { p_id: ORIGIN, p_version: 1 });
    });

    it('distinguishes an empty published catalogue from a failed or undeployed RPC', async () => {
        mock.rpc.mockReturnValueOnce(rpcReply(Promise.resolve({ data: [], error: null })));
        const empty = await discoverCatalogueChoices(departure, signal());
        expect(empty).toMatchObject({ status: 'empty', summaries: [] });
        expect(empty.message).toContain('No reviewed local route available');
        mock.rpc.mockReturnValueOnce(rpcReply(Promise.resolve({ data: null, error: { message: 'Missing RPC' } })));
        const unavailable = await discoverCatalogueChoices(departure, signal());
        expect(unavailable).toMatchObject({ status: 'unavailable', summaries: [] });
        expect(unavailable.message).toContain('no cached catalogue choice');
        expect(unavailable.message).not.toContain('Missing RPC');
    });

    it.each(['offline', 'signed out', 'unconfirmed account'] as const)(
        'does not request catalogue data when %s',
        async (failure) => {
            if (failure === 'offline') vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
            if (failure === 'signed out') mock.scope = { userId: null, key: 'anonymous', generation: 2 };
            if (failure === 'unconfirmed account') mock.currentUser.mockResolvedValue('different-owner');
            await expect(discoverCatalogueChoices(departure, signal())).resolves.toMatchObject({
                status: 'unavailable',
                summaries: [],
            });
            expect(mock.rpc).not.toHaveBeenCalled();
        },
    );

    it('rejects latitude unsupported by the planner before authentication or an RPC', async () => {
        await expect(discoverCatalogueChoices({ lat: 81, lon: 0 }, signal())).rejects.toThrow(/80° latitude/);
        expect(mock.currentUser).not.toHaveBeenCalled();
        expect(mock.rpc).not.toHaveBeenCalled();
    });

    it('captures the chosen search position before asynchronous authentication', async () => {
        let authenticated!: (owner: string) => void;
        mock.currentUser.mockReturnValue(
            new Promise<string>((resolve) => {
                authenticated = resolve;
            }),
        );
        const position = { ...departure };
        const searching = discoverCatalogueChoices(position, signal());
        position.lat = 81;
        position.lon = 0;
        authenticated('catalogue-owner');
        await searching;
        expect(mock.rpc).toHaveBeenCalledWith(
            'nearby_cruising_catalogue',
            expect.objectContaining({ p_latitude: departure.lat, p_longitude: departure.lon }),
        );
    });

    it('captures the exact chosen detail reference before asynchronous authentication', async () => {
        let authenticated!: (owner: string) => void;
        mock.currentUser.mockReturnValue(
            new Promise<string>((resolve) => {
                authenticated = resolve;
            }),
        );
        const reference = { ...destinationRef };
        const loading = loadCatalogueChoice(reference, signal());
        reference.id = ORIGIN;
        reference.version = 1;
        authenticated('catalogue-owner');
        await expect(loading).resolves.toMatchObject(destinationRef);
        expect(mock.rpc).toHaveBeenCalledExactlyOnceWith('cruising_catalogue_detail', {
            p_id: DESTINATION,
            p_version: 2,
        });
    });

    it.each(['before request', 'during response', 'account changed'] as const)(
        'aborts %s without returning late catalogue choices',
        async (when) => {
            const controller = new AbortController();
            const pending = deferredResponse();
            mock.rpc.mockReturnValue(pending.response);
            if (when === 'before request') controller.abort();
            const searching = discoverCatalogueChoices(departure, controller.signal);
            await Promise.resolve();
            if (when === 'during response') controller.abort();
            if (when === 'account changed') {
                mock.scope = { userId: 'different-owner', key: 'user:different-owner', generation: 2 };
                for (const listener of mock.listeners) listener();
            }
            await expect(searching).rejects.toMatchObject({ name: 'AbortError' });
            if (when === 'before request') expect(mock.rpc).not.toHaveBeenCalled();
            else expect(mock.signals[0].aborted).toBe(true);
            pending.resolve({ data: [summary()], error: null });
            await Promise.resolve();
        },
    );

    it('bounds an ignored-abort RPC by the catalogue timeout and returns unavailable', async () => {
        const pending = deferredResponse();
        mock.rpc.mockReturnValue(pending.response);
        const searching = discoverCatalogueChoices(departure, signal());
        await vi.advanceTimersByTimeAsync(CATALOGUE_READ_TIMEOUT_MS);
        await expect(searching).resolves.toMatchObject({ status: 'unavailable', summaries: [] });
        expect(mock.signals[0].aborted).toBe(true);
        pending.resolve({ data: [summary()], error: null });
        await Promise.resolve();
    });

    it('enforces the elapsed deadline when a suspended timeout callback has not run', async () => {
        const pending = deferredResponse();
        mock.rpc.mockReturnValue(pending.response);
        const loading = loadCatalogueChoice({ id: ORIGIN, version: 1 }, signal());
        await Promise.resolve();
        vi.setSystemTime(NOW + CATALOGUE_READ_TIMEOUT_MS + 1);
        pending.resolve({ data: detail(), error: null });
        await expect(loading).rejects.toThrow(/timed out/);
    });

    it('fails closed on stale review data arriving after its expiry', async () => {
        rows.get(DESTINATION)!.review_due_at = new Date(NOW + 1000).toISOString();
        const pending = deferredResponse();
        mock.rpc.mockReturnValue(pending.response);
        const loading = loadCatalogueChoice(destinationRef, signal());
        await Promise.resolve();
        vi.setSystemTime(NOW + 2000);
        pending.resolve({ data: rows.get(DESTINATION), error: null });
        await expect(loading).rejects.toThrow(/invalid, stale/);
    });
});

describe('exact catalogue plan graph', () => {
    it('turns one exact destination into an unassessed catalogue reference with editorial provenance', async () => {
        const candidate = await loadCataloguePlan(destinationRef, 'return', signal());
        expect(mock.rpc).toHaveBeenCalledExactlyOnceWith('cruising_catalogue_detail', {
            p_id: DESTINATION,
            p_version: 2,
        });
        expect(candidate.destination).toMatchObject({
            name: 'Synthetic catalogue arrival',
            catalogueQuality: 'catalogue-reference',
            referencePosition: 'catalogue-reference',
            timeZone: 'Australia/Brisbane',
            lat: arrival.lat,
            lon: arrival.lon,
        });
        expect(candidate.place).toMatchObject({ kind: 'catalogue-reference', source: 'shared-catalogue' });
        expect(candidate.place).not.toHaveProperty('fetchLandNM');
        expect(candidate.destination.uncertaintyNotes.join(' ')).toContain('No reviewed local route available');
        expect(candidate.destination.supportingSources?.[0].label).toContain('Synthetic fixture attribution');
        expect(candidate.catalogue).toMatchObject({ mode: 'return', selection: destinationRef });
        expect(candidate.catalogue?.details).toHaveLength(1);
        expect(candidate.catalogue?.outbound).toBeUndefined();
        expect(() => validateCatalogueCandidate(candidate, 'return')).not.toThrow();
    });

    it('reads every exact dependency and preserves separate outbound and return checkpoint sequences', async () => {
        const selection = tripSelection();
        const candidate = await loadCataloguePlan(selection, 'return', signal());
        expect(mock.rpc.mock.calls).toEqual([
            ['cruising_catalogue_detail', { p_id: TRIP, p_version: 3 }],
            ['cruising_catalogue_detail', { p_id: ORIGIN, p_version: 1 }],
            ['cruising_catalogue_detail', { p_id: DESTINATION, p_version: 2 }],
            ['cruising_catalogue_detail', { p_id: OUTBOUND, p_version: 4 }],
            ['cruising_catalogue_detail', { p_id: RETURN, p_version: 5 }],
        ]);
        expect(candidate.catalogue?.details).toHaveLength(5);
        expect(candidate.catalogue?.outbound?.checkpoints[1].name).toBe('outbound bend');
        expect(candidate.catalogue?.return?.checkpoints[1].name).toBe('return bend');
        expect(candidate.catalogue?.return?.checkpoints).not.toEqual(
            candidate.catalogue?.outbound?.checkpoints.slice().reverse(),
        );
        expect(candidate.destination).toMatchObject(arrival);
        expect(() => validateCatalogueCandidate(candidate, 'return')).not.toThrow();
    });

    it('loads only four dependencies for an explicitly chosen outbound-only overnight plan', async () => {
        const selection = tripSelection();
        delete selection.return;
        const candidate = await loadCataloguePlan(selection, 'overnight', signal());
        expect(candidate.catalogue?.details).toHaveLength(4);
        expect(candidate.catalogue?.return).toBeUndefined();
        expect(mock.rpc.mock.calls.some(([, args]) => args.p_id === RETURN)).toBe(false);
    });

    it.each([
        'missing outbound',
        'missing return',
        'unavailable return',
        'wrong direction',
        'wrong trip',
        'wrong arrival',
        'wrong departure',
    ] as const)('refuses %s without substituting or reversing another route', async (failure) => {
        const selection = tripSelection();
        if (failure === 'missing outbound') delete selection.outbound;
        if (failure === 'missing return') delete selection.return;
        if (failure === 'unavailable return') rows.set(RETURN, null);
        if (failure === 'wrong direction') rows.get(RETURN)!.direction = 'outbound';
        if (failure === 'wrong trip') rows.get(RETURN)!.trip_version = 2;
        if (failure === 'wrong arrival') (rows.get(OUTBOUND)!.checkpoints as WireRow[])[2].latitude = -20.25;
        if (failure === 'wrong departure') rows.get(TRIP)!.latitude = -20.25;
        await expect(loadCataloguePlan(selection, 'return', signal())).rejects.toThrow();
        expect(mock.rpc.mock.calls.every(([name]) => name === 'cruising_catalogue_detail')).toBe(true);
        expect(mock.rpc.mock.calls.filter(([, args]) => args.p_id === OUTBOUND)).toHaveLength(
            failure.startsWith('missing') ? 0 : 1,
        );
    });

    it('retains nearby Nara closure/access provenance and catalogue attribution once per source URL', async () => {
        const nara = WHITSUNDAYS_DAY_DESTINATIONS.find((destination) => destination.id === 'nara-inlet-cultural-site')!;
        rows.get(DESTINATION)!.latitude = nara.lat + 0.001;
        rows.get(DESTINATION)!.longitude = nara.lon;
        (rows.get(DESTINATION)!.evidence as WireRow[])[0].source_url = nara.sourceUrl;
        const candidate = await loadCataloguePlan(destinationRef, 'overnight', signal());
        expect(candidate.destination.knownClosures).toEqual(nara.knownClosures);
        expect(candidate.destination.accessNotes).toEqual(expect.arrayContaining(nara.accessNotes));
        const sources = candidate.destination.supportingSources!;
        const urls = sources.map(({ url }) => url);
        expect(new Set(urls).size).toBe(urls.length);
        expect(urls).toEqual(
            expect.arrayContaining([
                nara.sourceUrl,
                ...nara.supportingSources!.map(({ url }) => url),
                ...nara.knownClosures!.map(({ sourceUrl }) => sourceUrl),
            ]),
        );
        expect(sources.find(({ url }) => url === nara.sourceUrl)!.label).toContain('Synthetic fixture attribution');
        candidate.destination.knownClosures![0].reason = 'Caller changed closure';
        expect(nara.knownClosures![0].reason).not.toBe('Caller changed closure');
        expect(() => validateCatalogueCandidate(candidate, 'overnight')).toThrow();
    });
});

describe('fresh catalogue binding revalidation', () => {
    it('re-reads all five exact dependencies without using saved details as a cache', async () => {
        const candidate = await loadCataloguePlan(tripSelection(), 'return', signal());
        const original = structuredClone(candidate.catalogue!);
        mock.rpc.mockClear();
        await expect(revalidateCataloguePlan(candidate.catalogue!, signal())).resolves.toBeUndefined();
        expect(mock.rpc).toHaveBeenCalledTimes(5);
        expect(candidate.catalogue).toEqual(original);
    });

    it('rejects caller mutation during the fresh read even if the caller edits its binding to match changed server data', async () => {
        const candidate = await loadCataloguePlan(destinationRef, 'return', signal());
        const pending = deferredResponse();
        mock.rpc.mockReturnValue(pending.response);
        const checking = revalidateCataloguePlan(candidate.catalogue!, signal());
        await Promise.resolve();
        const changed = structuredClone(rows.get(DESTINATION)!);
        changed.summary = 'Changed destination editorial summary';
        candidate.catalogue!.details[0].summary = String(changed.summary);
        pending.resolve({ data: changed, error: null });
        await expect(checking).rejects.toThrow(/unavailable or changed/);
    });

    it.each([
        'withdrawn',
        'superseded',
        'pending review',
        'changed evidence',
        'changed checkpoint',
        'missing origin',
    ] as const)('rejects %s at save preflight instead of retaining the old binding', async (failure) => {
        const candidate = await loadCataloguePlan(tripSelection(), 'return', signal());
        if (failure === 'withdrawn') rows.set(RETURN, null);
        if (failure === 'superseded') rows.get(RETURN)!.version = 6;
        if (failure === 'pending review') rows.get(DESTINATION)!.review_status = 'pending';
        if (failure === 'changed evidence')
            (rows.get(DESTINATION)!.evidence as WireRow[])[0].attribution = 'Changed editorial source';
        if (failure === 'changed checkpoint') (rows.get(RETURN)!.checkpoints as WireRow[])[1].latitude = -20.208;
        if (failure === 'missing origin') rows.set(ORIGIN, null);
        mock.rpc.mockClear();
        await expect(revalidateCataloguePlan(candidate.catalogue!, signal())).rejects.toThrow();
        expect(mock.rpc.mock.calls.every(([name]) => name === 'cruising_catalogue_detail')).toBe(true);
        expect(mock.rpc.mock.calls.every(([, args]) => args.p_version !== 6)).toBe(true);
    });

    it.each([
        'checkpoint',
        'place identity',
        'place kind',
        'place position',
        'place source',
        'provenance',
        'mode',
        'extra detail',
    ] as const)('rejects tampered %s before a calculated candidate can be reused', async (change) => {
        const candidate = await loadCataloguePlan(tripSelection(), 'return', signal());
        if (change === 'checkpoint') candidate.catalogue!.outbound!.checkpoints[1].lat += 0.01;
        if (change === 'place identity') candidate.place.id = 'catalogue:another-reference:v1';
        if (change === 'place kind') candidate.place.kind = 'mooring';
        if (change === 'place position') candidate.place.lon += 0.01;
        if (change === 'place source') candidate.place.source = 'other-source';
        if (change === 'provenance') candidate.destination.sourceUrl = 'https://example.com/forged';
        if (change === 'mode') candidate.catalogue!.mode = 'overnight';
        if (change === 'extra detail')
            candidate.catalogue!.details.push(structuredClone(candidate.catalogue!.details[0]));
        expect(() => validateCatalogueCandidate(candidate, 'return')).toThrow();
    });

    it('allows only a conservative restriction flag to be added by runtime without changing the reference identity', async () => {
        const candidate = await loadCataloguePlan(destinationRef, 'return', signal());
        candidate.place.noAnchoring = true;
        expect(() => validateCatalogueCandidate(candidate, 'return')).not.toThrow();
    });
});

describe('catalogue wire response through calculation and asynchronous save', () => {
    const HOUR = 3_600_000;
    const profile: AutoroutingVesselProfile = {
        length: { status: 'measured', valueM: 12 },
        beam: { status: 'measured', valueM: 4 },
        airDraft: { status: 'measured', valueM: 15 },
        draftStatus: 'measured',
    };

    async function calculateCatalogueTrip() {
        const selection = tripSelection();
        const candidate = await loadCataloguePlan(selection, 'return', signal());
        const request: DayPlanRequest = {
            start: { ...departure, label: 'Synthetic departure' },
            departureMs: NOW + HOUR,
            maxSailingHours: 4,
            stopHours: 1,
            mode: 'return',
            activities: ['walk'],
            catalogueSelection: selection,
            speedKts: 6,
            draftM: 1.5,
        };
        const dependencies: DayPlannerDependencies = {
            now: () => NOW,
            route: vi.fn<DayPlannerDependencies['route']>(async (from, to, _signal, constraint) => {
                const route: AutoroutingTrialRoute = {
                    id: `synthetic-${constraint?.direction}`,
                    provider: 'Thalassa',
                    createdAt: new Date(NOW).toISOString(),
                    coordinates: constraint
                        ? constraint.checkpoints.map(({ lon, lat }) => [lon, lat])
                        : [
                              [from.lon, from.lat],
                              [to.lon, to.lat],
                          ],
                    warnings: ['Synthetic provider result; independently inspect the route.'],
                    engine: {
                        stateMask: (constraint ? constraint.checkpoints.slice(1) : [to]).map(() => 'green' as const),
                        cellsUsed: ['OC-99-SYN001'],
                        distanceNM: 1,
                        elapsedMs: 10,
                        backstop: 'verified',
                    },
                    vesselProfile: structuredClone(profile),
                };
                return {
                    route,
                    review: {
                        phase: 'complete',
                        basis: {
                            proposalId: route.id,
                            geometryKey: autoroutingProposalGeometryKey(route.coordinates),
                            draftM: request.draftM,
                            draftAssumed: false,
                            registryFingerprint: getRegistryFingerprint(),
                            vesselProfileKey: JSON.stringify(profile),
                            checkedAt: new Date(NOW).toISOString(),
                        },
                        legs: route.coordinates.slice(1).map(() => ({
                            incomplete: false,
                            verdict: {
                                grade: 'clear',
                                minDepthM: 8,
                                minAt: null,
                                issues: [],
                                needsTide: false,
                                nudge: null,
                                nudgeTo: null,
                            },
                        })),
                    },
                };
            }),
            forecast: vi.fn<DayPlannerDependencies['forecast']>(async (points) =>
                points.map((point) => ({
                    ...point,
                    fetchedAt: NOW,
                    hours: Array.from({ length: 169 }, (_, index) => ({
                        t: NOW + index * HOUR,
                        wind: 8,
                        gust: 10,
                        direction: 90,
                        weatherCode: 1,
                        waveM: 0.2,
                        waveDirection: 90,
                        wavePeriod: 4,
                    })),
                })),
            ),
        };
        const result = await buildDayPlan(request, [candidate], dependencies, { signal: signal() });
        return { request, result, dependencies };
    }

    it('preserves separate checkpoint routes, unknown stop limitations and fresh versions through one complete commit', async () => {
        const { request, result, dependencies } = await calculateCatalogueTrip();
        expect(result.excluded).toEqual([]);
        expect(result.options).toHaveLength(1);
        expect(dependencies.route).toHaveBeenCalledTimes(2);
        expect(result.options[0].conditions.light).toBe('unknown');
        expect(result.options[0].light).toBe('unknown');
        const option = result.options[0];
        mock.rpc.mockClear();
        const saved = await saveDayPlanWithCatalogueCheck(
            {
                request,
                option,
                calculatedAt: result.calculatedAt,
                acknowledgedPlannedOnly: true,
            },
            mock.scope,
            {
                signal: signal(),
                getCurrentVesselProfile: () => structuredClone(profile),
                getCurrentVesselInputs: () => ({ draftM: 1.5, speedKts: 6 }),
            },
        );
        expect(mock.rpc).toHaveBeenCalledTimes(5);
        expect(mock.commit).toHaveBeenCalledOnce();
        const [prepared, scope] = mock.commit.mock.calls[0];
        expect(scope).toEqual(mock.scope);
        expect(prepared).toHaveLength(2);
        expect(prepared[0].points).toEqual(
            option.candidate.catalogue!.outbound!.checkpoints.map(({ lat, lon }) => ({ lat, lon })),
        );
        expect(prepared[1].points).toEqual(
            option.candidate.catalogue!.return!.checkpoints.map(({ lat, lon }) => ({ lat, lon })),
        );
        for (const leg of prepared) {
            expect(leg.proposalEvidence.warnings.join(' ')).toContain('reviewed editorial catalogue reference');
            expect(leg.proposalEvidence.warnings.join(' ')).toContain('Stop conditions (unknown)');
            expect(leg.proposalEvidence.warnings.join(' ')).toContain(`${RETURN} v5`);
            expect(leg.proposalEvidence.plannedOnlyAcknowledged).toBe(true);
            expect(leg).not.toHaveProperty('verification');
        }
        expect(saved.traces).toHaveLength(2);
        await expect(saved.cloud).resolves.toEqual(['ok', 'ok']);
    });

    it('blocks the complete itinerary when its return reference is withdrawn after calculation', async () => {
        const { request, result } = await calculateCatalogueTrip();
        expect(result.options).toHaveLength(1);
        rows.set(RETURN, null);
        await expect(
            saveDayPlanWithCatalogueCheck(
                {
                    request,
                    option: result.options[0],
                    calculatedAt: result.calculatedAt,
                    acknowledgedPlannedOnly: true,
                },
                mock.scope,
                {
                    signal: signal(),
                    getCurrentVesselProfile: () => structuredClone(profile),
                    getCurrentVesselInputs: () => ({ draftM: 1.5, speedKts: 6 }),
                },
            ),
        ).rejects.toThrow(/unavailable or changed/);
        expect(mock.commit).not.toHaveBeenCalled();
    });

    it.each(['outbound', 'return'] as const)(
        'excludes a trip whose reviewed %s variant requires tidal clearance',
        async (direction) => {
            rows.get(direction === 'outbound' ? OUTBOUND : RETURN)!.limitations = [
                'This route requires a tide-dependent clearance.',
            ];
            const { result } = await calculateCatalogueTrip();
            expect(result.options).toEqual([]);
            expect(result.excluded).toHaveLength(1);
            expect(result.excluded[0].reason).toMatch(/tide|tidal/i);
            expect(mock.commit).not.toHaveBeenCalled();
        },
    );
});
