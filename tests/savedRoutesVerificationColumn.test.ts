/**
 * Route checks that stick (125-07): saved_routes.verification.
 *
 * A route check lived only on the phone that made it, so a reinstall, a
 * second phone or the 50-route cap brought a checked passage back yellow
 * (Shane, 2026-10-08: three Newport → Whitsundays legs). 124 recovered
 * passage legs from their voyages.notes copy; 125 gives every saved route a
 * verification column. The migration waits for Shane's db push, so the client
 * PROBES for the column and behaves exactly as 124 did until it is there.
 *
 * Fictional routes only: the Stockholm archipelago (Sweden) and the Solent (UK).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;
type Call = {
    table: string;
    op: 'select' | 'upsert' | 'update';
    fields?: string;
    values?: Row;
    eq: Array<[string, unknown]>;
    inIds?: unknown;
    limit?: number;
};

const db = vi.hoisted(() => ({
    columnPresent: false,
    rows: [] as Row[],
    voyageRows: [] as Row[],
    calls: [] as Call[],
    updateMatches: true,
    updateError: null as unknown,
}));

const missingVerification = { code: '42703', message: 'column saved_routes.verification does not exist' };

function answer(call: Call): { data?: unknown; error: unknown } {
    if (call.table === 'voyages') return { data: db.voyageRows, error: null };
    const namesColumn =
        (call.op === 'select' && /\bverification\b/.test(call.fields ?? '')) ||
        (call.op !== 'select' && call.values !== undefined && 'verification' in call.values);
    if (namesColumn && !db.columnPresent) return { data: null, error: missingVerification };
    if (call.op === 'upsert') return { error: null };
    if (call.op === 'update' && db.updateError) return { data: null, error: db.updateError };
    if (call.op === 'update') return { data: db.updateMatches ? [{ id: call.eq[0]?.[1] }] : [], error: null };
    if (call.limit === 0) return { data: [], error: null };
    const ids = Array.isArray(call.inIds) ? (call.inIds as string[]) : null;
    const rows = db.rows
        .filter((row) => !ids || ids.includes(row.id as string))
        .map((row) => {
            if (/\bverification\b/.test(call.fields ?? '')) return row;
            const { verification: _hidden, ...rest } = row;
            return rest;
        });
    return { data: rows, error: null };
}

vi.mock('../services/supabase', () => ({
    isSupabaseConfigured: () => true,
    supabase: {
        auth: { getUser: async () => ({ data: { user: { id: 'skipper-se' } } }) },
        from: (table: string) => {
            const call: Call = { table, op: 'select', eq: [] };
            const chain: Record<string, unknown> = {
                select: (fields: string) => {
                    if (call.op === 'select') call.fields = fields;
                    return chain;
                },
                upsert: (values: Row) => {
                    call.op = 'upsert';
                    call.values = values;
                    return chain;
                },
                update: (values: Row) => {
                    call.op = 'update';
                    call.values = values;
                    return chain;
                },
                eq: (column: string, value: unknown) => {
                    call.eq.push([column, value]);
                    return chain;
                },
                in: (_column: string, ids: unknown) => {
                    call.inIds = ids;
                    return chain;
                },
                order: () => chain,
                limit: (count: number) => {
                    call.limit = count;
                    return chain;
                },
                returns: () => chain,
                maybeSingle: () => chain,
                then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => {
                    db.calls.push(call);
                    return Promise.resolve(answer(call)).then(resolve, reject);
                },
            };
            return chain;
        },
    },
}));
vi.mock('../services/VoyageService', () => ({ refreshSavedRouteVoyageVerification: vi.fn(async () => ({})) }));
vi.mock('../stores/settingsStore', () => ({
    useSettingsStore: { getState: () => ({ settings: { vessel: { draft: 1.8 * 3.28084, estimatedFields: [] } } }) },
}));

import { authScopedStorageKey, setAuthIdentityScope } from '../services/authIdentityScope';
import { bankTraceVerification, loadSavedTraces, saveTrace, type TraceLegVerdict } from '../services/routeTracer';
import {
    __resetSavedRoutesVerificationColumnForTests,
    pushSavedRoute,
    pushSavedRouteVerification,
    syncSavedRoutes,
} from '../services/savedRoutesSync';
import { recoverTraceChecks } from '../services/traceCheckRecovery';
import {
    evaluateTraceRelease,
    serialiseTraceVerificationNote,
    traceFollowStatus,
    type TraceVerification,
} from '../services/traceVerification';

// Fictional: Stockholm archipelago, Stavsnäs → Sandhamn (Sweden).
const sandhamn = [
    { lat: 59.287, lon: 18.689 },
    { lat: 59.29, lon: 18.79 },
    { lat: 59.284, lon: 18.912 },
];
// Fictional: the Solent, Lymington → Cowes (UK) — a day sail, no passage.
const solent = [
    { lat: 50.755, lon: -1.53 },
    { lat: 50.765, lon: -1.4 },
    { lat: 50.765, lon: -1.297 },
];
const PASSAGE = '5d1e2f3a-4b5c-4d6e-8f70-81a2b3c4d5e6';

const clear: TraceLegVerdict = {
    grade: 'clear',
    issues: [],
    minDepthM: 11,
    minAt: null,
    needsTide: false,
    nudge: null,
    nudgeTo: null,
};
const checkedAt = (points: typeof sandhamn, iso: string, draftM = 1.8, draftAssumed = false): TraceVerification =>
    evaluateTraceRelease(
        points,
        'ready',
        points.slice(1).map(() => clear),
        new Set(),
        {
            draftM,
            draftAssumed,
            encRegistryVersion: 1,
            encRegistryFingerprint: 'SE5STH01@4',
            departureMs: Date.parse('2026-10-11T06:00:00Z'),
            tideWindowLabel: '',
        },
        iso,
    ).verification!;
const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
const wire = (points: typeof sandhamn) => points.map((p) => [p.lat, p.lon]);
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async () => {
    for (let i = 0; i < 6; i++) await flush();
};
const statusOf = (id: string) => {
    const trace = loadSavedTraces().find((t) => t.id === id)!;
    return traceFollowStatus(trace.verification, trace.points, { draftM: 1.8, draftAssumed: false, nowMs: Date.now() });
};
const calls = (op: Call['op'], table = 'saved_routes') => db.calls.filter((c) => c.op === op && c.table === table);
const reads = () => calls('select').filter((c) => c.limit !== 0);
const probes = () => calls('select').filter((c) => c.limit === 0);

describe('saved_routes.verification — probed, then written and read by savedRoutesSync', () => {
    beforeEach(() => {
        localStorage.clear();
        db.columnPresent = false;
        db.rows = [];
        db.voyageRows = [];
        db.calls = [];
        db.updateMatches = true;
        db.updateError = null;
        __resetSavedRoutesVerificationColumnForTests();
        setAuthIdentityScope(null);
        setAuthIdentityScope('skipper-se');
    });
    afterEach(() => setAuthIdentityScope(null));

    it('column ABSENT: pushes and pulls exactly as 124 did, and the passage notes still bring the check back', async () => {
        await syncSavedRoutes();
        expect(probes()).toHaveLength(1);
        expect(probes()[0].fields).toBe('verification');
        expect(reads().at(-1)?.fields).not.toContain('verification');

        const iso = daysAgo(2);
        const saved = saveTrace('Stavsnäs → Sandhamn', sandhamn, {
            passageVoyageId: PASSAGE,
            verification: checkedAt(sandhamn, iso),
        });
        await expect(saved.cloud).resolves.toBe('ok');
        const pushed = calls('upsert').at(-1)!.values!;
        expect(pushed).not.toHaveProperty('verification');

        // A reinstall: the account row has no check, the passage mirror does.
        localStorage.clear();
        db.rows = [{ ...pushed, updated_at: pushed.updated_at }];
        db.voyageRows = [
            {
                id: PASSAGE,
                saved_route_id: saved.trace.id,
                notes: serialiseTraceVerificationNote(checkedAt(sandhamn, iso)),
            },
        ];
        const [adopted] = await syncSavedRoutes();
        expect(adopted.verification).toBeUndefined();
        expect(await recoverTraceChecks()).toBe(1);
        expect(statusOf(saved.trace.id).tone).toBe('checked');
        // Absent is remembered for the hour: no second probe, and nothing is
        // ever written to a column that is not there.
        expect(probes()).toHaveLength(1);
        expect(calls('update')).toHaveLength(0);
    });

    it('column PRESENT: a check made on one phone arrives on a fresh install', async () => {
        db.columnPresent = true;
        await syncSavedRoutes();
        expect(probes()).toHaveLength(1);
        expect(reads().at(-1)?.fields).toContain('verification');

        const iso = daysAgo(1);
        const saved = saveTrace('Lymington → Cowes', solent, { verification: checkedAt(solent, iso) });
        await expect(saved.cloud).resolves.toBe('ok');
        const pushed = calls('upsert').at(-1)!.values!;
        expect(pushed.verification).toEqual(checkedAt(solent, iso));

        // The second phone: nothing local, the account row carries the check.
        localStorage.clear();
        db.rows = [pushed];
        await syncSavedRoutes();
        expect(loadSavedTraces()[0].verification?.checkedAt).toBe(iso);
        expect(statusOf(saved.trace.id).tone).toBe('checked');
        // Present is remembered for the session.
        expect(probes()).toHaveLength(1);
    });

    it('a bank pushes ONLY the check, to the revision it was made for — never the pins, never updated_at', async () => {
        db.columnPresent = true;
        const revision = '2026-10-07T21:14:03.512+00:00';
        db.rows = [
            {
                id: 'trace-sandhamn',
                name: 'Stavsnäs → Sandhamn',
                points: wire(sandhamn),
                created_at: '2026-10-07T21:10:00.000Z',
                updated_at: revision,
                deleted: false,
            },
        ];
        await syncSavedRoutes();
        expect(loadSavedTraces()[0].updatedAt).toBe(revision);
        const upsertsBefore = calls('upsert').length;

        const v = checkedAt(sandhamn, daysAgo(0));
        expect(bankTraceVerification('trace-sandhamn', v).banked).toBe(true);
        await settle();

        expect(calls('upsert')).toHaveLength(upsertsBefore);
        const [update] = calls('update');
        expect(update.values).toEqual({ verification: v });
        expect(update.eq).toEqual(
            expect.arrayContaining([
                ['id', 'trace-sandhamn'],
                ['user_id', 'skipper-se'],
                ['deleted', false],
                ['updated_at', revision],
            ]),
        );
    });

    it('the newer check wins either way; a check for other pins is ignored; a newer local check catches the account up', async () => {
        db.columnPresent = true;
        const revision = '2026-10-01T08:00:00.000+00:00';
        const row = (verification: unknown): Row => ({
            id: 'trace-sandhamn',
            name: 'Stavsnäs → Sandhamn',
            points: wire(sandhamn),
            created_at: '2026-10-01T07:59:00.000Z',
            updated_at: revision,
            deleted: false,
            verification,
        });
        const older = daysAgo(6);
        const newer = daysAgo(3);
        const newest = daysAgo(1);

        // Local newer than the account: kept, and pushed up (check only).
        db.rows = [row(null)];
        await syncSavedRoutes();
        // Banked while the account could not take it (offline at the bank).
        db.updateError = { message: 'Failed to fetch' };
        expect(bankTraceVerification('trace-sandhamn', checkedAt(sandhamn, newer)).banked).toBe(true);
        await settle();
        db.updateError = null;
        db.calls = [];
        db.rows = [row(checkedAt(sandhamn, older))];
        await syncSavedRoutes();
        expect(loadSavedTraces()[0].verification?.checkedAt).toBe(newer);
        await settle();
        expect(calls('update').map((c) => c.values)).toEqual([{ verification: checkedAt(sandhamn, newer) }]);
        expect(calls('update')[0].eq).toContainEqual(['updated_at', revision]);

        // The account newer than local: taken, nothing pushed back.
        db.calls = [];
        db.rows = [row(checkedAt(sandhamn, newest))];
        await syncSavedRoutes();
        expect(loadSavedTraces()[0].verification?.checkedAt).toBe(newest);
        await settle();
        expect(calls('update')).toHaveLength(0);

        // A check for OTHER pins never lands on these.
        localStorage.clear();
        db.rows = [row(checkedAt(solent, newest))];
        await syncSavedRoutes();
        expect(loadSavedTraces()[0].verification).toBeUndefined();
    });

    it('a check that is green on THIS phone is kept over a newer one made at another keel or an assumed draft', async () => {
        db.columnPresent = true;
        const revision = '2026-10-02T08:00:00.000+00:00';
        const row = (verification: unknown): Row => ({
            id: 'trace-sandhamn',
            name: 'Stavsnäs → Sandhamn',
            points: wire(sandhamn),
            created_at: '2026-10-02T07:59:00.000Z',
            updated_at: revision,
            deleted: false,
            verification,
        });
        const mine = daysAgo(3);
        db.rows = [row(null)];
        await syncSavedRoutes();
        expect(bankTraceVerification('trace-sandhamn', checkedAt(sandhamn, mine)).banked).toBe(true);
        await settle();

        // An iPad whose fleet still says 2.4 m checked it two days later.
        db.calls = [];
        db.rows = [row(checkedAt(sandhamn, daysAgo(1), 2.4))];
        await syncSavedRoutes();
        expect(loadSavedTraces()[0].verification?.checkedAt).toBe(mine);
        expect(statusOf('trace-sandhamn').tone).toBe('checked');
        // …and the account's newer copy is left alone: no flip-flop.
        await settle();
        expect(calls('update')).toHaveLength(0);

        // A freshly installed phone, its draft not rehydrated yet (assumed).
        db.rows = [row(checkedAt(sandhamn, daysAgo(1), 1.8, true))];
        await syncSavedRoutes();
        expect(loadSavedTraces()[0].verification?.checkedAt).toBe(mine);
        expect(statusOf('trace-sandhamn').tone).toBe('checked');
    });

    it('an account check dated in the future (a skewed clock elsewhere) counts as absent', async () => {
        db.columnPresent = true;
        const revision = '2026-10-03T08:00:00.000+00:00';
        const row = (verification: unknown): Row => ({
            id: 'trace-solent',
            name: 'Lymington → Cowes',
            points: wire(solent),
            created_at: '2026-10-03T07:59:00.000Z',
            updated_at: revision,
            deleted: false,
            verification,
        });
        const future = new Date(Date.now() + 3 * 86_400_000).toISOString();
        const mine = daysAgo(3);
        db.rows = [row(null)];
        await syncSavedRoutes();
        expect(bankTraceVerification('trace-solent', checkedAt(solent, mine)).banked).toBe(true);
        await settle();

        db.calls = [];
        db.rows = [row(checkedAt(solent, future))];
        await syncSavedRoutes();
        expect(loadSavedTraces()[0].verification?.checkedAt).toBe(mine);
        expect(statusOf('trace-solent').tone).toBe('checked');
        // A genuine re-check on this phone still banks.
        expect(bankTraceVerification('trace-solent', checkedAt(solent, daysAgo(0))).banked).toBe(true);

        // A fresh install never adopts it, and recovery never banks it —
        // from the column or from the passage notes.
        localStorage.clear();
        db.rows = [{ ...row(checkedAt(solent, future)), passage_voyage_id: PASSAGE }];
        db.voyageRows = [
            {
                id: PASSAGE,
                saved_route_id: 'trace-solent',
                notes: serialiseTraceVerificationNote(checkedAt(solent, future)),
            },
        ];
        await syncSavedRoutes();
        expect(loadSavedTraces()[0].verification).toBeUndefined();
        expect(await recoverTraceChecks()).toBe(0);
        expect(loadSavedTraces()[0].verification).toBeUndefined();
    });

    it('a sync at the cap keeps every route new from another device (column absent: they arrive unchecked)', async () => {
        const april = (n: number) => new Date(Date.UTC(2026, 3, 1 + n, 8)).toISOString();
        const line = (i: number) => [
            { lat: 50.7 + i * 0.002, lon: -1.6 },
            { lat: 50.7 + i * 0.002, lon: -1.5 },
        ];
        const accountRow = (id: string, createdAt: string, points: typeof solent): Row => ({
            id,
            name: `Solent ${id}`,
            points: wire(points),
            created_at: createdAt,
            updated_at: createdAt,
            deleted: false,
        });
        // This phone: 50 older routes, all checked here.
        localStorage.setItem(
            authScopedStorageKey('thalassa_traced_routes_v1'),
            JSON.stringify(
                Array.from({ length: 50 }, (_, k) => ({
                    id: `old-${k + 1}`,
                    name: `Solent old-${k + 1}`,
                    createdAt: april(k + 1),
                    updatedAt: april(k + 1),
                    points: line(k + 1),
                    verification: checkedAt(line(k + 1), daysAgo(5)),
                })).reverse(),
            ),
        );
        expect(loadSavedTraces()).toHaveLength(50);
        // The account: those 50 plus three built on the desktop yesterday.
        db.rows = [
            ...[1, 2, 3].map((n) =>
                accountRow(`desk-${n}`, new Date(Date.now() - 86_400_000 + n * 60_000).toISOString(), line(200 + n)),
            ),
            ...Array.from({ length: 50 }, (_, k) => accountRow(`old-${k + 1}`, april(k + 1), line(k + 1))),
        ];
        await syncSavedRoutes();
        const ids = loadSavedTraces().map((t) => t.id);
        expect(ids).toHaveLength(50);
        expect(ids).toEqual(expect.arrayContaining(['desk-1', 'desk-2', 'desk-3']));
        expect(ids).not.toContain('old-1');
    });

    it('a sync never evicts the route this phone holds alone and is still pushing up', async () => {
        db.columnPresent = true;
        const april = (n: number) => new Date(Date.UTC(2026, 3, 1 + n, 8)).toISOString();
        const line = (i: number) => [
            { lat: 59.2 + i * 0.002, lon: 18.5 },
            { lat: 59.2 + i * 0.002, lon: 18.6 },
        ];
        const checkedRoute = (n: number) => ({
            id: `old-${n}`,
            name: `Skerries old-${n}`,
            createdAt: april(n),
            updatedAt: april(n),
            points: line(n),
            verification: checkedAt(line(n), daysAgo(5)),
        });
        // This phone: 49 checked routes the account has, plus one unchecked
        // route from mid-April that never reached the account.
        const localOnly = { id: 'local-only', name: 'Skerries local', createdAt: april(15), points: line(300) };
        localStorage.setItem(
            authScopedStorageKey('thalassa_traced_routes_v1'),
            JSON.stringify([...Array.from({ length: 49 }, (_, k) => checkedRoute(k + 2)), localOnly]),
        );
        // The account: those 49, and one more checked route (adopted here now).
        db.rows = Array.from({ length: 50 }, (_, k) => {
            const r = checkedRoute(k + 1);
            return {
                id: r.id,
                name: r.name,
                points: wire(r.points),
                created_at: r.createdAt,
                updated_at: r.updatedAt,
                deleted: false,
                verification: r.verification,
            };
        });
        await syncSavedRoutes();
        const ids = loadSavedTraces().map((t) => t.id);
        expect(ids).toHaveLength(50);
        expect(ids).toContain('local-only');
        expect(ids).not.toContain('old-1');
        await settle();
        expect(calls('upsert').some((c) => c.values?.id === 'local-only')).toBe(true);
    });

    it("a 9,500-pin route's check still goes to the account (the client cap fits a 10,000-pin envelope)", async () => {
        db.columnPresent = true;
        await syncSavedRoutes();
        // Fictional: a long coastal run north from Valparaíso (Chile).
        const pins = Array.from({ length: 9_500 }, (_, i) => ({
            lat: -33.012345 + i * 0.000123,
            lon: -71.612345 - (i % 7) * 0.0001,
        }));
        const v = checkedAt(pins as typeof solent, daysAgo(0));
        expect(JSON.stringify(v).length).toBeGreaterThan(262_144);
        await expect(pushSavedRouteVerification('trace-valparaiso', v, '2026-10-09T08:00:00.000+00:00')).resolves.toBe(
            'ok',
        );
    });

    it('recovery reads the column first (any route, passage or not) and falls back to the passage notes', async () => {
        db.columnPresent = true;
        await syncSavedRoutes(); // learns the column is there
        const iso = daysAgo(4);
        const daySail = saveTrace('Lymington → Cowes', solent).trace;
        const leg = saveTrace('Stavsnäs → Sandhamn', sandhamn, { passageVoyageId: PASSAGE }).trace;
        const accountRow = (trace: typeof daySail, points: typeof solent, verification: unknown): Row => ({
            id: trace.id,
            name: trace.name,
            points: wire(points),
            created_at: trace.createdAt,
            updated_at: trace.createdAt,
            deleted: false,
            verification,
        });
        // The day sail's check is in the column; the leg's only in its notes.
        db.rows = [accountRow(daySail, solent, checkedAt(solent, iso)), accountRow(leg, sandhamn, null)];
        db.voyageRows = [
            { id: PASSAGE, saved_route_id: leg.id, notes: serialiseTraceVerificationNote(checkedAt(sandhamn, iso)) },
        ];
        await settle();
        db.calls = [];

        expect(await recoverTraceChecks()).toBe(2);
        expect(statusOf(daySail.id).tone).toBe('checked');
        expect(statusOf(leg.id).tone).toBe('checked');
        const columnRead = calls('select').find((c) => c.fields === 'id, verification');
        expect(columnRead?.inIds).toEqual(expect.arrayContaining([daySail.id, leg.id]));
        expect(columnRead?.eq).toContainEqual(['user_id', 'skipper-se']);
        expect(calls('select', 'voyages')).toHaveLength(1);
        // A check read from the column is never echoed back to it.
        await settle();
        expect(calls('update').filter((c) => c.eq.some(([k, v]) => k === 'id' && v === daySail.id))).toHaveLength(0);
    });

    it('pushes a route without a check exactly as before, leaving the account copy of the check alone', async () => {
        db.columnPresent = true;
        await syncSavedRoutes();
        await expect(
            pushSavedRoute({ id: 'trace-plain', name: 'Plain', createdAt: '2026-10-09T00:00:00.000Z', points: solent }),
        ).resolves.toBe('ok');
        expect(calls('upsert').at(-1)!.values).not.toHaveProperty('verification');
    });
});

describe('the saved_routes.verification migration', () => {
    const file = readdirSync('supabase/migrations').find((name) => /_saved_routes_verification\.sql$/.test(name));
    const sql = file ? readFileSync(`supabase/migrations/${file}`, 'utf8') : '';

    it('adds one nullable, bounded jsonb column and changes nothing else', () => {
        expect(file).toBeDefined();
        expect(sql).toContain('ADD COLUMN IF NOT EXISTS verification jsonb');
        expect(sql).toContain('verification IS NULL OR');
        expect(sql).toContain("jsonb_typeof(verification) = 'object'");
        expect(sql).not.toMatch(
            /(?:GRANT|REVOKE|CREATE POLICY|DROP POLICY|DISABLE ROW LEVEL SECURITY|UPDATE public|DELETE FROM|DROP COLUMN|NOT NULL)/i,
        );
    });
});
