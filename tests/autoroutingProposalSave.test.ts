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

const mock = vi.hoisted(() => ({ registry: 'cell@1@2026-09-13@42', push: vi.fn() }));
vi.mock('../services/enc/EncCellMetadata', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../services/enc/EncCellMetadata')>()),
    getRegistryFingerprint: () => mock.registry,
}));
vi.mock('../services/savedRoutesSync', () => ({ pushSavedRoute: (...args: unknown[]) => mock.push(...args) }));

function fixture(count = 3) {
    const route: AutoroutingTrialRoute = {
        id: 'proposal-1',
        provider: 'SevenCs',
        createdAt: '2026-09-13T01:00:00.000Z',
        coordinates: Array.from({ length: count }, (_, i) => [153 + i * 0.000000001, -27]),
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
                        properties: { uuid: 'area-1', dataset: 'licensed chart', severity: 'Warning' },
                        omittedPropertyCount: 0,
                    },
                },
            ],
        },
        source: { rtz: 'raw licensed RTZ — never persist', geoJson: 'raw licensed GeoJSON — never persist' },
        canalDeparture: { handoverIndex: 1 },
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
    mock.push.mockReset().mockResolvedValue('schema-pending');
});
afterEach(() => setAuthIdentityScope(null));

describe('explicit planned proposal save', () => {
    it('refuses a locally edited route even after fresh complete local checks match its exact geometry', () => {
        const input = fixture(5);
        input.route.coordinates[2] = [153.01, -27.01];
        const waypoint = buildTrialWaypointPlan(input.route.coordinates, [1]).waypoints.find(
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
        expect(result.reason).toMatch(/locally edited.*SevenCs/);
        expect(() => saveReviewedAutoroutingProposal(input, getAuthIdentityScope())).toThrow(/locally edited/);
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
        expect(() => saveReviewedAutoroutingProposal(input, getAuthIdentityScope())).toThrow(/locally edited/);
        expect(loadSavedTraces()).toEqual([]);
    });

    it('retains every sub-metre point, warning/location and provider finding in the canonical library, without navigation proof or a voyage/trip', async () => {
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
        expect(saved.proposalEvidence?.providerCheck).toEqual(input.route.providerCheck);
        expect(saved.proposalEvidence?.legs[0].issues).toEqual(input.review.legs[0]!.verdict.issues);
        expect(saved.proposalEvidence?.legs[0].minAt).toEqual(input.review.legs[0]!.verdict.minAt);
        expect(saved.proposalEvidence?.canalHandoverIndex).toBe(1);
        expect(saved.verification).toBeUndefined();
        expect(saved.tripId).toBeUndefined();
        expect(saved.passageVoyageId).toBeUndefined();
        expect(saved.plannedRouteId).toBeUndefined();
        expect(JSON.stringify(saved)).not.toContain('raw licensed');
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
            'provider unsafe',
            (f: ReturnType<typeof fixture>) => {
                f.route.providerCheck!.status = 'unsafe';
            },
        ],
        [
            'provider hidden danger',
            (f: ReturnType<typeof fixture>) => {
                f.route.providerCheck!.findings[0].severity = 'danger';
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
        result.trace.proposalEvidence!.providerCheck!.findings[0].geometry = { type: 'Point', coordinates: [0, 0] };
        await result.cloud;
        expect(loadSavedTraces()[0].points[0].lon).toBe(original.route.coordinates[0][0]);
        expect(mock.push.mock.calls[0][0].points[0].lon).toBe(original.route.coordinates[0][0]);
        expect(mock.push.mock.calls[0][0].proposalEvidence.providerCheck).toEqual(original.route.providerCheck);
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
        expect(
            normaliseAutoroutingProposalEvidence(
                { ...evidence, providerCheck: { status: 'unsafe', findings: [] } },
                result.trace.points,
            ),
        ).toBeNull();
        expect(
            normaliseAutoroutingProposalEvidence(evidence, [
                { lat: 0, lon: 0 },
                { lat: 1, lon: 1 },
            ]),
        ).toBeNull();
        const malformed = structuredClone(evidence);
        malformed.providerCheck!.findings[0].geometry = { type: 'LineString', coordinates: [[0, 0]] };
        expect(normaliseAutoroutingProposalEvidence(malformed, result.trace.points)).toBeNull();
    });
});
