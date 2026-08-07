import { beforeEach, describe, expect, it, vi } from 'vitest';

const settings = vi.hoisted(() => ({ vessel: { draft: 1.8 * 3.28084, estimatedFields: [] as string[] } }));
vi.mock('../stores/settingsStore', () => ({
    useSettingsStore: { getState: () => ({ settings: { vessel: settings.vessel } }) },
}));
vi.mock('../services/enc/EncCellMetadata', () => ({
    getRegistryFingerprint: () => 'chart-set-v1',
}));

import { setAuthIdentityScope } from '../services/authIdentityScope';
import { saveTrace } from '../services/routeTracer';
import { evaluateTraceRelease } from '../services/traceVerification';
import { tracedRouteDirectUseBlockReason } from '../services/traceDirectUseGate';

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

    it('blocks a linked legacy trace without exact verification', () => {
        const { trace } = saveTrace('Legacy trace', points);
        expect(tracedRouteDirectUseBlockReason({ savedRouteId: trace.id, points })).toMatch(/no valid check/i);
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

        // Geometry that was NOT the checked line stays blocked — Log follow
        // steers route.points, so allowing this would verify one line and
        // follow another.
        const divergent = tracedRouteDirectUseBlockReason(
            { savedRouteId: trace.id, points: [points[0], { ...points[1], lon: points[1].lon + 0.01 }] },
            now,
        );
        expect(divergent).not.toBeNull();
        // ...but it must name the real cause. This case previously reported
        // "no valid check for its current waypoints — open Route Tracer and
        // check it again", which is false (the trace IS checked) and
        // unsatisfiable (re-checking cannot change a voyage's recorded track).
        // LogPage builds route.points from ship-log ENTRIES, so a linked
        // voyage hits this every time.
        expect(divergent).toMatch(/recorded track/i);
        expect(divergent).not.toMatch(/check it again/i);
    });
});
