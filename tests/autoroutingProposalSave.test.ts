import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AutoroutingTrialRoute } from '../types/autorouting';
import type { TrialRouteReview } from '../services/autoroutingReview';
import {
    autoroutingProposalGeometryKey,
    normaliseAutoroutingProposalEvidence,
    AUTOROUTING_PROPOSAL_EVIDENCE_MAX_BYTES,
} from '../services/autoroutingProposalEvidence';
import { evaluateAutoroutingProposalSave, saveReviewedAutoroutingProposal } from '../services/autoroutingProposalSave';
import { getAuthIdentityScope, setAuthIdentityScope } from '../services/authIdentityScope';
import { groupTracesByTrip, loadSavedTraces, saveTrace } from '../services/routeTracer';
import { moveAutoroutingDisplayWaypoint } from '../services/autoroutingWaypointEdit';
import { buildTrialWaypointPlan } from '../services/autoroutingDisplayWaypoints';
import { traceRegistryScope } from '../services/traceRegistryScope';

const mock = vi.hoisted(() => ({
    registry: 'cell@1@2026-09-13@42',
    /** The whole library, where it differs from the charts round the route. */
    whole: null as string | null,
    scopes: [] as unknown[],
    push: vi.fn(),
}));
vi.mock('../services/enc/EncCellMetadata', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../services/enc/EncCellMetadata')>()),
    getRegistryFingerprint: (scope?: unknown) => {
        mock.scopes.push(scope);
        return scope ? mock.registry : (mock.whole ?? mock.registry);
    },
}));
vi.mock('../services/savedRoutesSync', () => ({ pushSavedRoute: (...args: unknown[]) => mock.push(...args) }));

/** Legacy SevenCs-trial evidence as rows saved before 2026-10-01 carry it:
 * still readable, never written by this build. */
function legacyEvidence(points: { lat: number; lon: number }[]) {
    return {
        version: 1,
        origin: 'sevencs-trial',
        proposalId: 'legacy-1',
        providerCreatedAt: '2026-09-13T01:00:00.000Z',
        savedAt: '2026-09-13T01:02:00.000Z',
        plannedOnlyAcknowledged: true,
        basis: {
            proposalId: 'legacy-1',
            geometryKey: autoroutingProposalGeometryKey(points.map((p) => [p.lon, p.lat])),
            draftM: 1.5,
            draftAssumed: true,
            registryFingerprint: 'cell@1',
            checkedAt: '2026-09-13T01:01:00.000Z',
        },
        warnings: ['Confirm all clearance independently.'],
        providerCheck: {
            status: 'caution',
            findings: [
                {
                    featureIndex: 5,
                    featureType: 'danger',
                    providerSeverity: 'Warning',
                    severity: 'caution',
                    message: 'Restricted area',
                    geometry: { type: 'Point', coordinates: [153.2, -27.1] },
                    provenance: {
                        source: 'SevenCs GeoJSON',
                        properties: { uuid: 'area-1', severity: 'Warning' },
                        omittedPropertyCount: 0,
                    },
                },
            ],
        },
        canalHandoverIndex: 1,
        legs: points
            .slice(1)
            .map(() => ({ grade: 'caution', incomplete: true, minDepthM: null, minAt: null, issues: [] })),
    };
}

function fixture(count = 3) {
    const route: AutoroutingTrialRoute = {
        id: 'proposal-1',
        provider: 'Thalassa',
        createdAt: '2026-09-13T01:00:00.000Z',
        coordinates: Array.from({ length: count }, (_, i) => [153 + i * 0.000000001, -27]),
        warnings: ['Confirm all clearance independently.'],
        engine: {
            stateMask: Array.from({ length: count - 1 }, () => 'green' as const),
            cellsUsed: ['OC-99-SYN001'],
            distanceNM: 0.1,
            elapsedMs: 10,
            backstop: 'verified',
        },
    };
    const review: TrialRouteReview = {
        phase: 'complete',
        basis: {
            proposalId: route.id,
            geometryKey: autoroutingProposalGeometryKey(route.coordinates),
            draftM: 1.5,
            draftAssumed: true,
            vesselProfileKey: 'null',
            registryFingerprint: mock.registry,
            checkedAt: '2026-09-13T01:01:00.000Z',
        },
        legs: Array.from({ length: count - 1 }, () => ({
            incomplete: true,
            verdict: {
                grade: 'caution',
                minDepthM: null,
                minAt: { lat: -27, lon: 153 },
                needsTide: false,
                nudge: null,
                nudgeTo: null,
                issues: [
                    {
                        severity: 'caution',
                        message: 'Missing depth — inspect independently',
                        at: { lat: -27, lon: 153 },
                        chartTrack: { id: 'track-1', label: '', kind: 'leading-line', offsetM: 25 },
                    },
                ],
            },
        })),
    };
    return {
        name: 'My reviewed proposal',
        route,
        review,
        currentDraftM: 1.5,
        currentDraftAssumed: true,
        acknowledgedPlannedOnly: true,
    };
}

beforeEach(() => {
    localStorage.clear();
    setAuthIdentityScope('account-a');
    mock.registry = 'cell@1@2026-09-13@42';
    mock.whole = null;
    mock.scopes = [];
    mock.push.mockReset().mockResolvedValue('schema-pending');
});
afterEach(() => setAuthIdentityScope(null));

describe('explicit planned proposal save', () => {
    // Package 125-06: the review is bound to the charts round the route
    // (traceRegistryScope, as the route check and Cast Off are), so Save
    // compares the same charts — a chart synced far away is not "Charts
    // changed" for this route; one under it still is.
    it('compares the charts round the route, as its review was bound', () => {
        const input = fixture();
        mock.whole = 'a cell synced on the far side of the world';
        expect(
            evaluateAutoroutingProposalSave(input.route, input.review, input.currentDraftM, input.currentDraftAssumed)
                .eligible,
        ).toBe(true);
        expect(mock.scopes.at(-1)).toEqual(
            traceRegistryScope(input.route.coordinates.map(([lon, lat]) => ({ lat, lon }))),
        );
        mock.registry = 'a new edition under the route';
        expect(
            evaluateAutoroutingProposalSave(input.route, input.review, input.currentDraftM, input.currentDraftAssumed),
        ).toEqual({ eligible: false, reason: 'Charts changed. Recheck before saving.' });
    });

    it('refuses a locally edited route even after fresh complete local checks match its exact geometry', () => {
        const input = fixture(5);
        input.route.coordinates[2] = [153.01, -27.01];
        const waypoint = buildTrialWaypointPlan(input.route.coordinates, []).waypoints.find(
            (pin) => pin.pathIndex === 2,
        )!;
        input.route = moveAutoroutingDisplayWaypoint(input.route, waypoint, [153.011, -27.011]).route;
        input.review.basis!.geometryKey = autoroutingProposalGeometryKey(input.route.coordinates);
        const result = evaluateAutoroutingProposalSave(
            input.route,
            input.review,
            input.currentDraftM,
            input.currentDraftAssumed,
        );
        expect(result.eligible).toBe(false);
        expect(result.reason).toBe(
            "This edited route has not been rechecked by Thalassa's router and cannot be saved. Recalculate.",
        );
        expect(() => saveReviewedAutoroutingProposal(input, getAuthIdentityScope())).toThrow(/edited route/);
        expect(loadSavedTraces()).toEqual([]);
        expect(mock.push).not.toHaveBeenCalled();
    });

    it('fails closed on any supplied local-edit marker, even a malformed marker', () => {
        const input = fixture();
        input.route.localEdit = null as unknown as AutoroutingTrialRoute['localEdit'];
        expect(
            evaluateAutoroutingProposalSave(input.route, input.review, input.currentDraftM, input.currentDraftAssumed)
                .eligible,
        ).toBe(false);
        expect(() => saveReviewedAutoroutingProposal(input, getAuthIdentityScope())).toThrow(/edited route/);
        expect(loadSavedTraces()).toEqual([]);
    });

    it('accepts only a Thalassa route with its router disclosure for this exact line', () => {
        const input = fixture();
        const ok = evaluateAutoroutingProposalSave(input.route, input.review, 1.5, true);
        expect(ok.eligible).toBe(true);
        const unknown = { ...input.route, provider: 'SevenCs' } as unknown as AutoroutingTrialRoute;
        expect(evaluateAutoroutingProposalSave(unknown, input.review, 1.5, true)).toEqual({
            eligible: false,
            reason: 'The proposal origin is not recognised.',
        });
        const { engine: _engine, ...withoutEngine } = input.route;
        const unverified = { ...input.route, engine: { ...input.route.engine!, stateMask: null } };
        const misaligned = { ...input.route, engine: { ...input.route.engine!, stateMask: ['green' as const] } };
        for (const route of [withoutEngine, unverified, misaligned])
            expect(evaluateAutoroutingProposalSave(route, input.review, 1.5, true)).toEqual({
                eligible: false,
                reason: 'Route shown, verification incomplete. Recalculate before saving.',
            });
    });

    // Review fix-ups, 2026-10-01: a route over charted land, red with no
    // charted depth behind it, or not yet checked against the satellite land
    // relief, is never a saved plan — whatever the independent review graded.
    it('denies a route that crosses charted land, or red with no charted depth, or before the satellite land check', () => {
        const input = fixture(4);
        expect(evaluateAutoroutingProposalSave(input.route, input.review, 1.5, true).eligible).toBe(true);
        const over = { ...input.route, engine: { ...input.route.engine!, hardLandAwayM: 400 } };
        expect(evaluateAutoroutingProposalSave(over, input.review, 1.5, true)).toEqual({
            eligible: false,
            reason: 'This route crosses charted land. It cannot be saved. Nothing was saved.',
        });
        const red = {
            ...input.route,
            engine: {
                ...input.route.engine!,
                stateMask: ['green', 'danger', 'green'] as ('green' | 'danger')[],
                cautionMask: [false, true, false],
                canalMask: [false, false, false],
                chartedShallowMask: [false, false, false],
                landPaintConflictMask: [false, false, false],
            },
        };
        expect(evaluateAutoroutingProposalSave(red, input.review, 1.5, true)).toEqual({
            eligible: false,
            reason: 'Part of this route is drawn red with no charted depth behind it (land, uncharted water or a charted hazard). It cannot be saved.',
        });
        // Red for a charted depth (a tide could lift it), decision-1 water or
        // a canal is not this denial: the review's own rules decide those.
        for (const mask of ['chartedShallowMask', 'landPaintConflictMask', 'canalMask'] as const) {
            const charted = { ...red, engine: { ...red.engine, [mask]: [false, true, false] } };
            expect(evaluateAutoroutingProposalSave(charted, input.review, 1.5, true).eligible).toBe(true);
        }
        // The satellite check could not finish: Save stays off (fail
        // closed), and says what happened — "offline" only when it was
        // (2026-10-02: the field route timed out on Wi-Fi + 4G and was told
        // "offline").
        const timedOut = {
            ...input.route,
            engine: {
                ...input.route.engine!,
                backstop: 'unavailable' as const,
                backstopReason: "the satellite relief service didn't answer within 12 s",
            },
        };
        expect(evaluateAutoroutingProposalSave(timedOut, input.review, 1.5, true)).toEqual({
            eligible: false,
            reason: "The satellite land check couldn't be done just now: the satellite relief service didn't answer within 12 s. Retry the check before saving.",
        });
        const unsaid = { ...input.route, engine: { ...input.route.engine!, backstop: 'unavailable' as const } };
        const words = evaluateAutoroutingProposalSave(unsaid, input.review, 1.5, true);
        expect(words.eligible).toBe(false);
        expect(words.reason).not.toMatch(/offline/i);
        expect(words.reason).toMatch(/Retry the check before saving\.$/);
    });

    it('retains every sub-metre point and warning/location in the canonical library as Thalassa evidence, without the router disclosure, navigation proof or a voyage/trip', async () => {
        const input = fixture(10_000);
        for (const leg of input.review.legs.slice(1)) {
            leg!.incomplete = false;
            Object.assign(leg!.verdict, { grade: 'clear', minDepthM: 8, minAt: null, issues: [] });
        }
        const result = saveReviewedAutoroutingProposal(input, getAuthIdentityScope());
        await expect(result.cloud).resolves.toBe('schema-pending');
        const [saved] = loadSavedTraces();
        expect(saved.points.map(({ lat, lon }) => [lon, lat])).toEqual(input.route.coordinates);
        expect(saved.proposalEvidence?.warnings).toEqual(input.route.warnings);
        expect(saved.proposalEvidence?.origin).toBe('thalassa-inshore');
        expect(saved.proposalEvidence?.legs[0].issues).toEqual(input.review.legs[0]!.verdict.issues);
        expect(saved.proposalEvidence?.legs[0].minAt).toEqual(input.review.legs[0]!.verdict.minAt);
        expect(saved.proposalEvidence).not.toHaveProperty('providerCheck');
        expect(saved.proposalEvidence).not.toHaveProperty('canalHandoverIndex');
        expect(JSON.stringify(saved)).not.toContain('stateMask');
        expect(saved.verification).toBeUndefined();
        expect(saved.tripId).toBeUndefined();
        expect(saved.passageVoyageId).toBeUndefined();
        expect(saved.plannedRouteId).toBeUndefined();
        expect(groupTracesByTrip([saved])[0].legs).toEqual([saved]);
    });

    it('always creates a new named row; never silently overwrites a same-name manual route', async () => {
        const old = saveTrace('My reviewed proposal', [
            { lat: 0, lon: 0 },
            { lat: 1, lon: 1 },
        ]);
        const result = saveReviewedAutoroutingProposal(fixture(), getAuthIdentityScope());
        await Promise.all([old.cloud, result.cloud]);
        expect(result.trace.id).not.toBe(old.trace.id);
        expect(loadSavedTraces()).toHaveLength(2);
        expect(loadSavedTraces().find((t) => t.id === old.trace.id)?.points).toEqual(old.trace.points);
    });

    it.each(['checking', 'stopped', 'stale', 'error'] as const)('refuses %s review without writing', (phase) => {
        const input = fixture();
        input.review.phase = phase;
        expect(() => saveReviewedAutoroutingProposal(input, getAuthIdentityScope())).toThrow(/Finish/);
        expect(loadSavedTraces()).toEqual([]);
    });

    it.each([
        [
            'geometry',
            (f: ReturnType<typeof fixture>) => {
                f.route.coordinates[1][0] += 1e-10;
            },
        ],
        [
            'proposal id',
            (f: ReturnType<typeof fixture>) => {
                f.route.id = 'different';
            },
        ],
        [
            'missing basis',
            (f: ReturnType<typeof fixture>) => {
                delete f.review.basis;
            },
        ],
        [
            'draft',
            (f: ReturnType<typeof fixture>) => {
                f.currentDraftM += 0.1;
            },
        ],
        [
            'assumed draft',
            (f: ReturnType<typeof fixture>) => {
                f.currentDraftAssumed = false;
            },
        ],
        [
            'profile',
            (f: ReturnType<typeof fixture>) => {
                f.review.basis!.vesselProfileKey = '{"different":true}';
            },
        ],
        [
            'registry',
            () => {
                mock.registry = 'changed';
            },
        ],
        [
            'missing leg',
            (f: ReturnType<typeof fixture>) => {
                f.review.legs[0] = null;
            },
        ],
        [
            'missing leg count',
            (f: ReturnType<typeof fixture>) => {
                f.review.legs.pop();
            },
        ],
        [
            'danger grade',
            (f: ReturnType<typeof fixture>) => {
                f.review.legs[0]!.verdict.grade = 'danger';
            },
        ],
        [
            'hidden danger',
            (f: ReturnType<typeof fixture>) => {
                f.review.legs[0]!.verdict.issues[0].severity = 'danger';
            },
        ],
        [
            'tide',
            (f: ReturnType<typeof fixture>) => {
                f.review.legs[0]!.verdict.needsTide = true;
            },
        ],
        [
            'no router disclosure',
            (f: ReturnType<typeof fixture>) => {
                delete f.route.engine;
            },
        ],
        [
            'unverified line',
            (f: ReturnType<typeof fixture>) => {
                f.route.engine!.stateMask = null;
            },
        ],
        [
            'unacknowledged',
            (f: ReturnType<typeof fixture>) => {
                f.acknowledgedPlannedOnly = false;
            },
        ],
        [
            'blank name',
            (f: ReturnType<typeof fixture>) => {
                f.name = '  ';
            },
        ],
    ] as const)('refuses %s without writing', (_name, mutate) => {
        const input = fixture();
        mutate(input);
        expect(() => saveReviewedAutoroutingProposal(input, getAuthIdentityScope())).toThrow();
        expect(loadSavedTraces()).toEqual([]);
        expect(mock.push).not.toHaveBeenCalled();
    });

    it('fences old-account and signed-out submissions', () => {
        const input = fixture();
        const scope = getAuthIdentityScope();
        setAuthIdentityScope('account-b');
        expect(() => saveReviewedAutoroutingProposal(input, scope)).toThrow(/account changed/);
        setAuthIdentityScope(null);
        expect(() => saveReviewedAutoroutingProposal(input, getAuthIdentityScope())).toThrow(/account changed/);
        expect(loadSavedTraces()).toEqual([]);
    });

    it('allows a completed empty-chart-library identity only as acknowledged planned-only missing-depth evidence', () => {
        mock.registry = '';
        const input = fixture();
        expect(evaluateAutoroutingProposalSave(input.route, input.review, 1.5, true).eligible).toBe(true);
        const saved = saveReviewedAutoroutingProposal(input, getAuthIdentityScope());
        expect(saved.trace.proposalEvidence?.basis.registryFingerprint).toBe('');
        expect(saved.trace.proposalEvidence?.legs.every((leg) => leg.incomplete)).toBe(true);
    });

    it('refuses oversized evidence without truncating warnings or writing', () => {
        const input = fixture();
        input.route.warnings = Array.from({ length: 500 }, () => 'x'.repeat(4096));
        expect(() => saveReviewedAutoroutingProposal(input, getAuthIdentityScope())).toThrow(/1 MiB/);
        expect(loadSavedTraces()).toEqual([]);
    });

    it('snapshots local and cloud material before callers can mutate a returned trace or input', async () => {
        const input = fixture();
        const original = structuredClone(input);
        const result = saveReviewedAutoroutingProposal(input, getAuthIdentityScope());
        input.route.coordinates[0][0] = 0;
        input.route.warnings[0] = 'changed';
        input.review.legs[0]!.verdict.issues[0].message = 'changed';
        result.trace.points[0].lon = 1;
        result.trace.proposalEvidence!.warnings[0] = 'changed';
        await result.cloud;
        expect(loadSavedTraces()[0].points[0].lon).toBe(original.route.coordinates[0][0]);
        expect(mock.push.mock.calls[0][0].points[0].lon).toBe(original.route.coordinates[0][0]);
        expect(mock.push.mock.calls[0][0].proposalEvidence.warnings).toEqual(original.route.warnings);
    });

    it('normalizes independent snapshots and rejects mismatched, unsafe, raw, malformed or over-budget evidence', () => {
        const result = saveReviewedAutoroutingProposal(fixture(), getAuthIdentityScope());
        const evidence = result.trace.proposalEvidence!;
        const copy = normaliseAutoroutingProposalEvidence(evidence, result.trace.points)!;
        expect(copy).toEqual(evidence);
        expect(copy).not.toBe(evidence);
        expect(new TextEncoder().encode(JSON.stringify(copy)).length).toBeLessThan(
            AUTOROUTING_PROPOSAL_EVIDENCE_MAX_BYTES,
        );
        expect(
            normaliseAutoroutingProposalEvidence({ ...evidence, raw: 'do not persist' }, result.trace.points),
        ).toBeNull();
        // A Thalassa row never carries the old provider's report or canal handover.
        expect(
            normaliseAutoroutingProposalEvidence(
                { ...evidence, providerCheck: { status: 'not-reported', findings: [] } },
                result.trace.points,
            ),
        ).toBeNull();
        expect(
            normaliseAutoroutingProposalEvidence({ ...evidence, canalHandoverIndex: 1 }, result.trace.points),
        ).toBeNull();
        expect(
            normaliseAutoroutingProposalEvidence({ ...evidence, origin: 'somewhere-else' }, result.trace.points),
        ).toBeNull();
        expect(
            normaliseAutoroutingProposalEvidence(evidence, [
                { lat: 0, lon: 0 },
                { lat: 1, lon: 1 },
            ]),
        ).toBeNull();
    });

    it('still reads legacy SevenCs-trial rows, provider report and canal handover included (read path only)', () => {
        const points = [
            { lat: -27, lon: 153 },
            { lat: -27.01, lon: 153.01 },
            { lat: -27.02, lon: 153.02 },
        ];
        const legacy = legacyEvidence(points);
        const copy = normaliseAutoroutingProposalEvidence(legacy, points);
        expect(copy).toEqual(legacy);
        expect(
            normaliseAutoroutingProposalEvidence(
                { ...legacy, providerCheck: { status: 'unsafe', findings: [] } },
                points,
            ),
        ).toBeNull();
        const malformed = structuredClone(legacy);
        malformed.providerCheck.findings[0].geometry = { type: 'LineString', coordinates: [[0, 0]] } as never;
        expect(normaliseAutoroutingProposalEvidence(malformed, points)).toBeNull();
    });
});
