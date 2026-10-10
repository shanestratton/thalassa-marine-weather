import { beforeEach, describe, expect, it, vi } from 'vitest';

const settings = vi.hoisted(() => ({ vessel: { draft: 1.8 * 3.28084, estimatedFields: [] as string[] } }));
vi.mock('../stores/settingsStore', () => ({
    useSettingsStore: { getState: () => ({ settings: { vessel: settings.vessel } }) },
}));
vi.mock('../services/enc/EncCellMetadata', () => ({
    getRegistryFingerprint: () => 'chart-set-v1',
    listRegisteredCells: () => [],
}));

import { setAuthIdentityScope } from '../services/authIdentityScope';
import { saveTrace } from '../services/routeTracer';
import { evaluateTraceRelease, traceGeometryKey } from '../services/traceVerification';
import { recordTraceCheckOutcome } from '../services/traceCheckOutcomes';
import {
    localTraceLinkByVoyageId,
    savedTraceFollowStatus,
    tracedRouteDirectUseBlockReason,
    tracedRouteDirectUseStatus,
} from '../services/traceDirectUseGate';

const points = [
    { lat: -27.47, lon: 153.02 },
    { lat: -27.57, lon: 153.1 },
];

describe('traced route direct-use gate', () => {
    beforeEach(() => {
        localStorage.clear();
        setAuthIdentityScope(null);
        setAuthIdentityScope('trace-gate-owner');
        settings.vessel = { draft: 1.8 * 3.28084, estimatedFields: [] };
    });

    it('does not affect ordinary non-tracer planner routes', () => {
        expect(tracedRouteDirectUseBlockReason({ points })).toBeNull();
    });

    // Build 124 (Shane 2026-10-08: "maybe just a warning rather than having to
    // almost start again"): a missing check is AMBER — said on the row, never
    // a wall. Only a real check's unacknowledged finding is red.
    it('warns, and never blocks, a linked trace without a check', () => {
        const { trace } = saveTrace('Legacy trace', points);
        const status = tracedRouteDirectUseStatus({ savedRouteId: trace.id, points });
        expect(status).toMatchObject({ tone: 'unchecked', code: 'none', blocked: false });
        expect(status.reason).toBe('Not checked yet');
        expect(tracedRouteDirectUseBlockReason({ savedRouteId: trace.id, points })).toBeNull();
    });

    it('a trace that is not on this device is amber, not a refusal', () => {
        const status = tracedRouteDirectUseStatus({ savedRouteId: 'trace-on-another-phone', points });
        expect(status).toMatchObject({ tone: 'unchecked', blocked: false });
        expect(savedTraceFollowStatus('trace-on-another-phone')).toMatchObject({ tone: 'unchecked' });
    });

    it('a red finding blocks until the skipper accepts it, then follows', () => {
        const { trace } = saveTrace('Wreck run', points);
        recordTraceCheckOutcome(trace.id, {
            geometryKey: traceGeometryKey(points),
            draftM: 1.8,
            draftAssumed: false,
            // An open (NOAA) chart keeps its words; over licensed charts the
            // record says "no-go leg" (127-C-b, tests/traceFollowStatus).
            encFingerprint: 'US5XX01M@1',
            at: new Date().toISOString(),
            kind: 'finding',
            reason: 'Pins 1→2: charted wreck',
            legs: [{ from: 1, to: 2, message: 'charted wreck' }],
        });
        const red = tracedRouteDirectUseStatus({ savedRouteId: trace.id, points });
        expect(red).toMatchObject({ tone: 'finding', blocked: true, reason: 'Pins 1→2: charted wreck' });
        expect(tracedRouteDirectUseStatus({ savedRouteId: trace.id, points }, { acceptFinding: true })).toMatchObject({
            tone: 'finding',
            blocked: false,
        });
        expect(tracedRouteDirectUseBlockReason({ savedRouteId: trace.id, points })).toBe('Pins 1→2: charted wreck');
        expect(savedTraceFollowStatus(trace.id).tone).toBe('finding');
    });

    it('allows only the checked geometry under the current draft and charts', () => {
        const now = Date.now();
        const verification = evaluateTraceRelease(
            points,
            'ready',
            [
                {
                    grade: 'clear',
                    issues: [],
                    minDepthM: 8,
                    minAt: points[1],
                    needsTide: false,
                    nudge: null,
                    nudgeTo: null,
                },
            ],
            new Set(),
            {
                draftM: 1.8,
                draftAssumed: false,
                encRegistryVersion: 1,
                encRegistryFingerprint: 'chart-set-v1',
                departureMs: now,
                tideWindowLabel: '',
            },
            new Date(now).toISOString(),
        ).verification!;
        const { trace } = saveTrace('Checked trace', points, { verification });

        expect(tracedRouteDirectUseBlockReason({ savedRouteId: trace.id, points }, now)).toBeNull();

        expect(tracedRouteDirectUseStatus({ savedRouteId: trace.id, points }, { nowMs: now })).toMatchObject({
            tone: 'checked',
            blocked: false,
        });

        // Geometry that was NOT the checked line is amber, naming the real
        // cause: the trace IS checked, and re-checking cannot change a
        // voyage's recorded track (Shane 2026-08-07). Never "check it again".
        const divergent = tracedRouteDirectUseStatus(
            { savedRouteId: trace.id, points: [points[0], { ...points[1], lon: points[1].lon + 0.01 }] },
            { nowMs: now },
        );
        expect(divergent).toMatchObject({ tone: 'unchecked', blocked: false });
        expect(divergent.reason).toMatch(/recorded track/i);
        expect(divergent.reason).not.toMatch(/check it again/i);
    });
});

describe('localTraceLinkByVoyageId', () => {
    beforeEach(() => {
        localStorage.clear();
        setAuthIdentityScope(null);
        setAuthIdentityScope('trace-gate-owner');
    });

    it('resolves a plan voyage to its trace without resident entries', () => {
        // The picker-filter hole (Shane 2026-08-13): on a fresh boot the Log
        // holds summaries only, so the entry-derived link map is empty and a
        // trace-linked plan was offered as "ordinary" — then refused at pick
        // time. The trace store itself must supply the link.
        const { trace } = saveTrace('Linked trace', points, {
            plannedRouteId: 'voyage-planned-1',
            passageVoyageId: 'voyage-passage-1',
        });
        const links = localTraceLinkByVoyageId();
        expect(links.get('voyage-planned-1')).toBe(trace.id);
        expect(links.get('voyage-passage-1')).toBe(trace.id);
    });

    it('omits standalone traces with no voyage mirror', () => {
        saveTrace('Standalone trace', points);
        expect(localTraceLinkByVoyageId().size).toBe(0);
    });
});
