/**
 * The sync lost-update race (build 124, B2). syncSavedRoutes used to snapshot
 * the local library BEFORE awaiting the account fetch and write the merge from
 * that snapshot afterwards — so a route check banked while the fetch was in
 * flight (the Log's in-place check, an acknowledgement, the background
 * re-check) was silently overwritten and the row went back to amber.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    getUser: vi.fn(),
    upsert: vi.fn(),
    read: vi.fn(),
}));

vi.mock('../services/supabase', () => ({
    isSupabaseConfigured: () => true,
    supabase: {
        auth: { getUser: (...args: unknown[]) => mocks.getUser(...args) },
        from: () => ({
            upsert: (...args: unknown[]) => mocks.upsert(...args),
            select: () => ({
                order: () => ({
                    limit: () => ({ returns: () => mocks.read() }),
                }),
            }),
        }),
    },
}));
vi.mock('../services/VoyageService', () => ({ refreshSavedRouteVoyageVerification: vi.fn(async () => ({})) }));

import { setAuthIdentityScope } from '../services/authIdentityScope';
import { bankTraceVerification, loadSavedTraces, saveTrace, type TraceLegVerdict } from '../services/routeTracer';
import { syncSavedRoutes } from '../services/savedRoutesSync';
import { evaluateTraceRelease } from '../services/traceVerification';

// Fictional: Auckland, Westhaven to Waiheke (NZ).
const points = [
    { lat: -36.84, lon: 174.75 },
    { lat: -36.83, lon: 174.85 },
    { lat: -36.79, lon: 175.0 },
];
const clear: TraceLegVerdict = {
    grade: 'clear',
    issues: [],
    minDepthM: 12,
    minAt: null,
    needsTide: false,
    nudge: null,
    nudgeTo: null,
};
const verification = () =>
    evaluateTraceRelease(
        points,
        'ready',
        [clear, clear],
        new Set(),
        {
            draftM: 1.8,
            draftAssumed: false,
            encRegistryVersion: 1,
            encRegistryFingerprint: 'NZ5W0001@2',
            departureMs: Date.parse('2026-10-10T20:00:00Z'),
            tideWindowLabel: '',
        },
        new Date().toISOString(),
    ).verification!;

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => {
        resolve = r;
    });
    return { promise, resolve };
}

describe('syncSavedRoutes keeps a check banked while the fetch was in flight', () => {
    beforeEach(() => {
        localStorage.clear();
        vi.clearAllMocks();
        setAuthIdentityScope('race-owner');
        mocks.getUser.mockResolvedValue({ data: { user: { id: 'race-owner' } } });
        mocks.upsert.mockResolvedValue({ error: null });
    });
    afterEach(() => setAuthIdentityScope(null));

    const serverRow = (trace: { id: string; name: string; createdAt: string; updatedAt?: string }) => ({
        id: trace.id,
        name: trace.name,
        points: points.map((p) => [p.lat, p.lon]),
        created_at: trace.createdAt,
        updated_at: trace.updatedAt ?? trace.createdAt,
        deleted: false,
    });

    for (const [label, bank] of [
        [
            'a plain overwrite-save',
            (id: string, name: string) => saveTrace(name, points, { overwriteId: id, verification: verification() }),
        ],
        ['bankTraceVerification', (id: string) => bankTraceVerification(id, verification())],
    ] as const) {
        it(`via ${label}`, async () => {
            const { trace } = saveTrace('Westhaven → Waiheke', points);
            const fetch = deferred<{ data: unknown[]; error: null }>();
            mocks.read.mockReturnValue(fetch.promise);

            const sync = syncSavedRoutes();
            // Let sync reach its awaited fetch.
            await vi.waitFor(() => expect(mocks.read).toHaveBeenCalled());

            bank(trace.id, trace.name);
            expect(loadSavedTraces().find((t) => t.id === trace.id)?.verification).toBeDefined();

            // The account still holds the row as it was before the check.
            fetch.resolve({ data: [serverRow(trace)], error: null });
            await sync;

            expect(loadSavedTraces().find((t) => t.id === trace.id)?.verification).toBeDefined();
        });
    }
});
