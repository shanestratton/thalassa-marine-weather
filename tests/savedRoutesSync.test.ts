import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const mocks = vi.hoisted(() => ({
    getUser: vi.fn(),
    upsert: vi.fn(),
    rows: [] as Array<Record<string, unknown>>,
    select: vi.fn(),
    read: vi.fn(),
}));

vi.mock('../services/supabase', () => ({
    isSupabaseConfigured: () => true,
    supabase: {
        auth: { getUser: (...args: unknown[]) => mocks.getUser(...args) },
        from: () => ({
            upsert: (...args: unknown[]) => mocks.upsert(...args),
            select: (...args: unknown[]) => {
                mocks.select(...args);
                return {
                    order: () => ({
                        limit: () => ({ returns: () => mocks.read() }),
                    }),
                };
            },
        }),
    },
}));

import { setAuthIdentityScope } from '../services/authIdentityScope';
import { deleteTrace, getSavedTraceTombstones, loadSavedTraces, saveTrace } from '../services/routeTracer';
import { pushSavedRoute, syncSavedRoutes } from '../services/savedRoutesSync';
import {
    autoroutingProposalGeometryKey,
    type SavedAutoroutingProposalEvidence,
} from '../services/autoroutingProposalEvidence';

const points = [
    { lat: -27.47, lon: 153.02 },
    { lat: -27.1, lon: 153.4 },
];
const proposalEvidence = (positions = points): SavedAutoroutingProposalEvidence => ({
    version: 1,
    origin: 'sevencs-trial',
    proposalId: 'provider-1',
    providerCreatedAt: '2026-09-13T00:00:00Z',
    savedAt: '2026-09-13T00:02:00Z',
    plannedOnlyAcknowledged: true,
    basis: {
        proposalId: 'provider-1',
        geometryKey: autoroutingProposalGeometryKey(positions.map((p) => [p.lon, p.lat])),
        draftM: 1.5,
        draftAssumed: true,
        registryFingerprint: 'charts',
        checkedAt: '2026-09-13T00:01:00Z',
        vesselProfileKey: 'null',
    },
    warnings: ['Check independently'],
    legs: positions.slice(1).map(() => ({ grade: 'clear', incomplete: false, minDepthM: 8, minAt: null, issues: [] })),
});
const missingColumn = {
    code: 'PGRST204',
    message: "Could not find the 'proposal_evidence' column in the schema cache",
};

describe('savedRoutesSync — canonical chain and deletion integrity', () => {
    beforeEach(() => {
        localStorage.clear();
        vi.clearAllMocks();
        setAuthIdentityScope('account-a');
        mocks.getUser.mockResolvedValue({ data: { user: { id: 'account-a' } } });
        mocks.upsert.mockResolvedValue({ error: null });
        mocks.rows = [];
        mocks.read.mockReset().mockImplementation(async () => ({ data: mocks.rows, error: null }));
    });

    afterEach(() => {
        setAuthIdentityScope(null);
    });

    it('keeps the additive migration private and permits JSONB whitespace without raising the client budget', () => {
        const sql = readFileSync('supabase/migrations/20260913120000_saved_autorouting_proposal_evidence.sql', 'utf8');
        expect(sql).toContain('ADD COLUMN IF NOT EXISTS proposal_evidence jsonb');
        expect(sql).toContain('proposal_evidence IS NULL OR');
        expect(sql).toContain('BETWEEN 2 AND 10000');
        expect(sql).toContain('<= 2097152');
        expect(sql).toContain('not a client budget increase');
        expect(sql).not.toMatch(
            /(?:GRANT|REVOKE|CREATE POLICY|DROP POLICY|DISABLE ROW LEVEL SECURITY|UPDATE public|DELETE FROM)/i,
        );
    });

    it('pushes and pulls every structural chain/link field', async () => {
        const trace = {
            id: 'trace-leg-2',
            name: 'Woorim - Mooloolaba (2nd Leg)',
            createdAt: '2026-07-26T00:00:00.000Z',
            updatedAt: '2026-07-26T00:02:00.000Z',
            points,
            tripId: 'trace-leg-1',
            legOrdinal: 2,
            destName: 'Mooloolaba',
            plannedRouteId: 'planned_123_route',
            passageVoyageId: '123e4567-e89b-12d3-a456-426614174000',
        };

        await expect(pushSavedRoute(trace)).resolves.toBe('ok');
        expect(mocks.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                trip_id: 'trace-leg-1',
                leg_ordinal: 2,
                dest_name: 'Mooloolaba',
                planned_route_id: 'planned_123_route',
                passage_voyage_id: '123e4567-e89b-12d3-a456-426614174000',
            }),
        );

        mocks.rows = [
            {
                id: 'trace-leg-1',
                name: 'Brisbane - Woorim (1st Leg)',
                points: points.map((point) => [point.lat, point.lon]),
                created_at: '2026-07-25T23:00:00.000Z',
                updated_at: '2026-07-25T23:01:00.000Z',
                deleted: false,
                trip_id: 'trace-leg-1',
                leg_ordinal: 1,
                dest_name: 'Woorim',
                planned_route_id: 'planned_123_root',
                passage_voyage_id: '223e4567-e89b-12d3-a456-426614174000',
            },
            {
                id: trace.id,
                name: trace.name,
                points: points.map((point) => [point.lat, point.lon]),
                created_at: trace.createdAt,
                updated_at: trace.updatedAt,
                deleted: false,
                trip_id: trace.tripId,
                leg_ordinal: trace.legOrdinal,
                dest_name: trace.destName,
                planned_route_id: trace.plannedRouteId,
                passage_voyage_id: trace.passageVoyageId,
            },
        ];
        await expect(syncSavedRoutes()).resolves.toEqual(expect.arrayContaining([expect.objectContaining(trace)]));
    });

    it('keeps a local deletion fence ahead of a stale live cloud row', async () => {
        const { trace } = saveTrace('Brisbane - Moreton', points);
        expect(deleteTrace(trace.id)).toBe(true);
        expect(getSavedTraceTombstones()).toHaveProperty(trace.id);

        mocks.rows = [
            {
                id: trace.id,
                name: trace.name,
                points: points.map((point) => [point.lat, point.lon]),
                created_at: trace.createdAt,
                updated_at: trace.updatedAt ?? trace.createdAt,
                deleted: false,
                trip_id: null,
                leg_ordinal: null,
                dest_name: null,
                planned_route_id: null,
                passage_voyage_id: null,
            },
        ];

        await expect(syncSavedRoutes()).resolves.toEqual([]);
    });

    it('omits a malformed historical passage id instead of failing the whole route upsert', async () => {
        await expect(
            pushSavedRoute({
                id: 'trace-legacy',
                name: 'Legacy route',
                createdAt: '2026-07-26T00:00:00.000Z',
                points,
                passageVoyageId: 'not-a-uuid-from-an-old-cache',
            }),
        ).resolves.toBe('ok');

        expect(mocks.upsert).toHaveBeenCalledWith(
            expect.objectContaining({ id: 'trace-legacy', passage_voyage_id: null }),
        );
    });

    it('keeps exact 10,000-point proposal and evidence in both private push and pull', async () => {
        const dense = Array.from({ length: 10_000 }, (_, i) => ({ lat: -27, lon: 153 + i / 1e9 }));
        const trace = {
            id: 'dense-proposal',
            name: 'Dense',
            createdAt: '2026-09-13T00:02:00Z',
            points: dense,
            proposalEvidence: proposalEvidence(dense),
        };
        await expect(pushSavedRoute(trace)).resolves.toBe('ok');
        const payload = mocks.upsert.mock.calls[0][0];
        expect(payload.points).toEqual(dense.map((p) => [p.lat, p.lon]));
        expect(payload.proposal_evidence).toEqual(trace.proposalEvidence);
        mocks.rows = [payload];
        const [saved] = await syncSavedRoutes();
        expect(saved.points).toEqual(dense);
        expect(saved.proposalEvidence).toEqual(trace.proposalEvidence);
        expect(saved.verification).toBeUndefined();
    });

    it('does not retry a proposal without evidence on an old backend; exact local copy survives', async () => {
        mocks.upsert.mockResolvedValue({ error: missingColumn });
        const result = saveTrace('Local proposal', points, { proposalEvidence: proposalEvidence() });
        await expect(result.cloud).resolves.toBe('schema-pending');
        expect(mocks.upsert).toHaveBeenCalledTimes(1);
        expect(mocks.upsert.mock.calls[0][0].proposal_evidence).toEqual(proposalEvidence());
        expect(loadSavedTraces()[0].points).toEqual(points);
        expect(loadSavedTraces()[0].proposalEvidence).toEqual(proposalEvidence());
    });

    it('retains old-schema compatibility only for ordinary manual routes', async () => {
        mocks.upsert.mockResolvedValueOnce({ error: missingColumn }).mockResolvedValueOnce({ error: null });
        await expect(
            pushSavedRoute({ id: 'manual', name: 'Manual', createdAt: '2026-09-13T00:02:00Z', points }),
        ).resolves.toBe('ok');
        expect(mocks.upsert).toHaveBeenCalledTimes(2);
        expect(mocks.upsert.mock.calls[1][0]).not.toHaveProperty('proposal_evidence');
    });

    it('falls back to old read schema without losing local proposal evidence', async () => {
        const result = saveTrace('Local proposal', points, { proposalEvidence: proposalEvidence() });
        await result.cloud;
        mocks.rows = [
            {
                id: result.trace.id,
                name: result.trace.name,
                created_at: result.trace.createdAt,
                points: points.map((p) => [p.lat, p.lon]),
            },
        ];
        mocks.read.mockResolvedValueOnce({ data: null, error: missingColumn });
        const [saved] = await syncSavedRoutes();
        expect(mocks.select.mock.calls.at(-1)?.[0]).not.toContain('proposal_evidence');
        expect(saved.proposalEvidence).toEqual(proposalEvidence());
    });

    it('rejects malformed remote coordinates instead of silently dropping points', async () => {
        mocks.rows = [
            {
                id: 'malformed',
                name: 'Do not repair',
                created_at: '2026-09-13T00:02:00Z',
                points: [
                    [-27, 153],
                    ['bad', 153],
                    [-27.1, 153.1],
                ],
            },
        ];
        await expect(syncSavedRoutes()).resolves.toEqual([]);
    });

    it('does not replace exact local evidence with mismatched remote evidence or geometry', async () => {
        const result = saveTrace('Local proposal', points, { proposalEvidence: proposalEvidence() });
        await result.cloud;
        mocks.rows = [
            {
                id: result.trace.id,
                name: 'Remote mismatch',
                created_at: result.trace.createdAt,
                updated_at: '2099-01-01T00:00:00Z',
                points: [
                    [0, 0],
                    [1, 1],
                ],
                proposal_evidence: proposalEvidence(),
            },
        ];
        expect((await syncSavedRoutes())[0]).toEqual(result.trace);
    });

    it('snapshots before asynchronous auth lookup and fences a changed account', async () => {
        let resolve!: (v: unknown) => void;
        mocks.getUser.mockReturnValueOnce(
            new Promise((r) => {
                resolve = r;
            }),
        );
        const trace = {
            id: 'snapshot',
            name: 'Original',
            createdAt: '2026-09-13T00:02:00Z',
            points: structuredClone(points),
            proposalEvidence: proposalEvidence(),
        };
        const pending = pushSavedRoute(trace);
        trace.points[0].lat = 0;
        trace.proposalEvidence.warnings[0] = 'mutated';
        resolve({ data: { user: { id: 'account-a' } } });
        await expect(pending).resolves.toBe('ok');
        expect(mocks.upsert.mock.calls[0][0].points[0]).toEqual([points[0].lat, points[0].lon]);
        expect(mocks.upsert.mock.calls[0][0].proposal_evidence.warnings).toEqual(['Check independently']);
        mocks.upsert.mockClear();
        mocks.getUser.mockReturnValueOnce(
            new Promise((r) => {
                resolve = r;
            }),
        );
        const stale = pushSavedRoute({ ...trace, points, proposalEvidence: proposalEvidence() });
        setAuthIdentityScope('account-b');
        resolve({ data: { user: { id: 'account-a' } } });
        await expect(stale).resolves.toBe('stale');
        expect(mocks.upsert).not.toHaveBeenCalled();
    });
});
