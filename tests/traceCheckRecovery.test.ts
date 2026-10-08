/**
 * Recovering route checks from the server (build 124, B3). Every tracer Save
 * of a passage leg already writes that leg's check into its Passage Planning
 * mirror (voyages.notes), but nothing ever read it back — so a reinstall, a
 * second phone or the silent 50-route cap turned a checked passage amber with
 * the proof sitting on the server. Recovery costs one query and no grading.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    query: vi.fn(),
    calls: [] as Array<{ table: string; select: string; inIds: unknown; eq: Array<[string, unknown]> }>,
    refresh: vi.fn(async () => ({})),
    vessel: { draft: 1.8 * 3.28084, estimatedFields: [] as string[] },
}));

vi.mock('../services/supabase', () => ({
    isSupabaseConfigured: () => true,
    supabase: {
        from: (table: string) => {
            const call = { table, select: '', inIds: undefined as unknown, eq: [] as Array<[string, unknown]> };
            mocks.calls.push(call);
            const chain = {
                select: (fields: string) => {
                    call.select = fields;
                    return chain;
                },
                in: (_column: string, ids: unknown) => {
                    call.inIds = ids;
                    return chain;
                },
                eq: (column: string, value: unknown) => {
                    call.eq.push([column, value]);
                    return chain;
                },
                then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
                    Promise.resolve(mocks.query(call)).then(resolve, reject),
            };
            return chain;
        },
    },
}));
vi.mock('../services/VoyageService', () => ({ refreshSavedRouteVoyageVerification: mocks.refresh }));
vi.mock('../stores/settingsStore', () => ({
    useSettingsStore: { getState: () => ({ settings: { vessel: mocks.vessel } }) },
}));

import { setAuthIdentityScope } from '../services/authIdentityScope';
import { bankTraceVerification, loadSavedTraces, saveTrace, type TraceLegVerdict } from '../services/routeTracer';
import { recoverTraceChecks } from '../services/traceCheckRecovery';
import { evaluateTraceRelease, serialiseTraceVerificationNote } from '../services/traceVerification';

// Fictional: Nouméa to Île des Pins (New Caledonia), two legs of one passage.
const leg1 = [
    { lat: -22.276, lon: 166.437 },
    { lat: -22.4, lon: 166.7 },
    { lat: -22.52, lon: 166.95 },
];
const leg2 = [
    { lat: -22.52, lon: 166.95 },
    { lat: -22.6, lon: 167.2 },
    { lat: -22.66, lon: 167.43 },
];
const VOYAGE_1 = '1f0e2d3c-4b5a-4c6d-8e7f-90a1b2c3d4e5';
const VOYAGE_2 = '2a1b3c4d-5e6f-4a7b-9c8d-e0f1a2b3c4d5';

const clear: TraceLegVerdict = {
    grade: 'clear',
    issues: [],
    minDepthM: 15,
    minAt: null,
    needsTide: false,
    nudge: null,
    nudgeTo: null,
};
const proof = (points: typeof leg1, iso: string) =>
    evaluateTraceRelease(
        points,
        'ready',
        points.slice(1).map(() => clear),
        new Set(),
        {
            draftM: 1.8,
            draftAssumed: false,
            encRegistryVersion: 1,
            encRegistryFingerprint: 'FR5NC001@1',
            departureMs: Date.parse('2026-10-12T19:00:00Z'),
            tideWindowLabel: '',
        },
        iso,
    ).verification!;

const recentIso = () => new Date(Date.now() - 2 * 86_400_000).toISOString();

describe('recoverTraceChecks', () => {
    beforeEach(() => {
        localStorage.clear();
        mocks.calls = [];
        mocks.query.mockReset();
        mocks.refresh.mockClear();
        mocks.vessel = { draft: 1.8 * 3.28084, estimatedFields: [] };
        setAuthIdentityScope(null);
        setAuthIdentityScope('recover-owner');
    });
    afterEach(() => setAuthIdentityScope(null));

    const seed = () => {
        const a = saveTrace('Nouméa → Baie de Prony (1st Leg)', leg1, { passageVoyageId: VOYAGE_1 }).trace;
        const b = saveTrace('Baie de Prony → Île des Pins (2nd Leg)', leg2, { passageVoyageId: VOYAGE_2 }).trace;
        return { a, b };
    };

    it('banks a matching note from the passage mirror, in one query, without echoing it back', async () => {
        const { a, b } = seed();
        const iso = recentIso();
        mocks.query.mockResolvedValue({
            data: [
                { id: VOYAGE_1, saved_route_id: a.id, notes: serialiseTraceVerificationNote(proof(leg1, iso)) },
                { id: VOYAGE_2, saved_route_id: b.id, notes: serialiseTraceVerificationNote(proof(leg2, iso)) },
            ],
            error: null,
        });

        expect(await recoverTraceChecks()).toBe(2);
        expect(mocks.calls).toHaveLength(1);
        expect(mocks.calls[0].table).toBe('voyages');
        expect(mocks.calls[0].select).toBe('id, notes, saved_route_id');
        expect(mocks.calls[0].inIds).toEqual(expect.arrayContaining([VOYAGE_1, VOYAGE_2]));
        expect(mocks.calls[0].eq).toContainEqual(['user_id', 'recover-owner']);
        const traces = loadSavedTraces();
        expect(traces.find((t) => t.id === a.id)?.verification?.checkedAt).toBe(iso);
        expect(traces.find((t) => t.id === b.id)?.verification?.checkedAt).toBe(iso);
        await new Promise((r) => setTimeout(r, 0));
        expect(mocks.refresh).not.toHaveBeenCalled();
    });

    it('ignores a note for other pins, a row linked to another route, and an older note', async () => {
        const { a, b } = seed();
        const newer = new Date(Date.now() - 40 * 86_400_000).toISOString();
        const older = new Date(Date.now() - 50 * 86_400_000).toISOString();
        // Leg 2 already holds an aged check, newer than what the server has.
        expect(bankTraceVerification(b.id, proof(leg2, newer), undefined, { refreshMirror: false }).banked).toBe(true);
        mocks.query.mockResolvedValue({
            data: [
                // A note for leg 2's pins sitting on leg 1's mirror: other geometry.
                { id: VOYAGE_1, saved_route_id: a.id, notes: serialiseTraceVerificationNote(proof(leg2, recentIso())) },
                { id: VOYAGE_2, saved_route_id: b.id, notes: serialiseTraceVerificationNote(proof(leg2, older)) },
            ],
            error: null,
        });
        expect(await recoverTraceChecks()).toBe(0);
        const traces = loadSavedTraces();
        expect(traces.find((t) => t.id === a.id)?.verification).toBeUndefined();
        expect(traces.find((t) => t.id === b.id)?.verification?.checkedAt).toBe(newer);

        mocks.query.mockResolvedValue({
            data: [
                {
                    id: VOYAGE_1,
                    saved_route_id: 'trace-someone-else',
                    notes: serialiseTraceVerificationNote(proof(leg1, recentIso())),
                },
            ],
            error: null,
        });
        expect(await recoverTraceChecks()).toBe(0);
        expect(loadSavedTraces().find((t) => t.id === a.id)?.verification).toBeUndefined();
    });

    it('a voyages query error leaves the device untouched', async () => {
        const { a } = seed();
        const before = localStorage.getItem([...Object.keys(localStorage)].find((k) => k.includes('traced_routes'))!);
        mocks.query.mockResolvedValue({ data: null, error: { message: 'JWT expired' } });
        expect(await recoverTraceChecks()).toBe(0);
        expect(loadSavedTraces().find((t) => t.id === a.id)?.verification).toBeUndefined();
        expect(localStorage.getItem([...Object.keys(localStorage)].find((k) => k.includes('traced_routes'))!)).toBe(
            before,
        );
    });

    it('asks nothing when every candidate is already green, or has no passage mirror', async () => {
        const { a, b } = seed();
        bankTraceVerification(a.id, proof(leg1, recentIso()), undefined, { refreshMirror: false });
        bankTraceVerification(b.id, proof(leg2, recentIso()), undefined, { refreshMirror: false });
        saveTrace('Day sail, no passage', leg1.slice(0, 2));
        expect(await recoverTraceChecks()).toBe(0);
        expect(mocks.calls).toHaveLength(0);
    });

    it('limits itself to the ids asked for', async () => {
        const { a } = seed();
        mocks.query.mockResolvedValue({ data: [], error: null });
        await recoverTraceChecks(undefined, [a.id]);
        expect(mocks.calls[0].inIds).toEqual([VOYAGE_1]);
    });

    it('writes nothing if the account changes while the query is out', async () => {
        const { a } = seed();
        mocks.query.mockImplementation(async () => {
            setAuthIdentityScope('someone-else');
            return {
                data: [
                    {
                        id: VOYAGE_1,
                        saved_route_id: a.id,
                        notes: serialiseTraceVerificationNote(proof(leg1, recentIso())),
                    },
                ],
                error: null,
            };
        });
        expect(await recoverTraceChecks()).toBe(0);
        setAuthIdentityScope('recover-owner');
        expect(loadSavedTraces().find((t) => t.id === a.id)?.verification).toBeUndefined();
    });
});
