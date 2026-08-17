/**
 * An acknowledgement has to survive leaving the tracer.
 *
 * onAckLeg only ever set React state, and the envelope carrying
 * acknowledgedDangerLegs reached storage solely through a manual Save. So a
 * skipper could open a saved route, tap through every no-go leg, come back to
 * the Log page and be asked to acknowledge exactly the same legs again —
 * Shane, 2026-08-18: "i do that, come back and it still asks me to do it
 * again???"
 *
 * The persistence is deliberately narrow, because auto-saving inside a route
 * editor is the kind of helpfulness that loses people's work. These tests pin
 * the narrowness as much as the feature: geometry identifies the route, so an
 * edit in progress is never written behind the skipper's back.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { traceGeometryKey } from '../services/traceVerification';
import { adoptServerRoute, loadSavedTraces, saveTrace } from '../services/routeTracer';
import type { TraceVerification } from '../services/traceVerification';

const POINTS = [
    { lat: -27.2, lon: 153.1 },
    { lat: -27.3, lon: 153.2 },
    { lat: -27.4, lon: 153.25 },
];

const envelope = (acked: number[]): TraceVerification =>
    ({
        version: 1,
        graderVersion: 'route-tracer-v1',
        geometryKey: traceGeometryKey(POINTS),
        checkedAt: new Date().toISOString(),
        result: 'danger-acknowledged',
        legGrades: ['clear', 'danger'],
        acknowledgedDangerLegs: acked,
        draftM: 2,
        draftAssumed: false,
        encRegistryVersion: 1,
        encRegistryFingerprint: 'fp-A',
        departureMs: Date.now(),
        tideWindowLabel: '',
    }) as TraceVerification;

beforeEach(() => localStorage.clear());

describe('geometry identifies the open route', () => {
    it('matches a stored route that has not been edited', () => {
        adoptServerRoute('r1', 'Bay run', POINTS);
        const stored = loadSavedTraces().find((t) => traceGeometryKey(t.points) === traceGeometryKey(POINTS));
        expect(stored?.id).toBe('r1');
    });

    it('does NOT match once a waypoint has moved', () => {
        // The guard that stops an edit in progress being written behind the
        // skipper's back. A moved pin is a different line, so no stored route
        // matches and nothing is persisted until they choose Save.
        adoptServerRoute('r1', 'Bay run', POINTS);
        const edited = [POINTS[0], { lat: -27.31, lon: 153.21 }, POINTS[2]];
        const stored = loadSavedTraces().find((t) => traceGeometryKey(t.points) === traceGeometryKey(edited));
        expect(stored).toBeUndefined();
    });
});

describe('the acknowledgement survives', () => {
    it('is readable again after being written to an existing route', () => {
        adoptServerRoute('r1', 'Bay run', POINTS);
        // Adoption deliberately carries no verification across.
        expect(loadSavedTraces().find((t) => t.id === 'r1')?.verification).toBeUndefined();

        saveTrace('Bay run', POINTS, { overwriteId: 'r1', verification: envelope([1]) });

        const after = loadSavedTraces().find((t) => t.id === 'r1');
        expect(after?.verification?.acknowledgedDangerLegs).toEqual([1]);
        // Same route, not a twin — the id and the geometry both survive.
        expect(loadSavedTraces().filter((t) => t.name === 'Bay run')).toHaveLength(1);
        expect(after?.points).toHaveLength(3);
    });

    it('is dropped if the envelope does not describe these waypoints', () => {
        // saveTrace normalises against the points, so an envelope earned on a
        // different line cannot ride along on this one.
        adoptServerRoute('r1', 'Bay run', POINTS);
        const otherLine = [POINTS[0], { lat: -27.9, lon: 153.9 }];
        saveTrace('Bay run', otherLine, { overwriteId: 'r1', verification: envelope([1]) });
        expect(loadSavedTraces().find((t) => t.id === 'r1')?.verification).toBeUndefined();
    });
});
