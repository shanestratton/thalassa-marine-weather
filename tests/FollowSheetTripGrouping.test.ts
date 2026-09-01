/**
 * Trip identity for the cast-off "Following a route?" sheet.
 *
 * Shane 2026-08-30: give that sheet "the gold standard treatment. to look like
 * the saved routes in the Route Planning page." Its rows are VoyageSummary,
 * which carries no trip or leg identity — so the grouping has to come from the
 * trace store, joined on the trace id the sheet already resolves.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const { loadSavedTraces } = vi.hoisted(() => ({ loadSavedTraces: vi.fn() }));

vi.mock('../services/routeTracer', async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return { ...actual, loadSavedTraces };
});

import { tripIdentityByTraceId } from '../services/traceDirectUseGate';

const pt = (lat: number, lon: number) => ({ lat, lon });

const trace = (over: Record<string, unknown>) => ({
    id: 'x',
    name: 'Route',
    createdAt: '2026-08-01T00:00:00.000Z',
    points: [pt(-27.2, 153.1), pt(-27.3, 153.2)],
    ...over,
});

beforeEach(() => loadSavedTraces.mockReset());

describe('trip identity by trace id', () => {
    it('carries the badge-stripped saved name and parses a dropped ordinal from it', () => {
        loadSavedTraces.mockReturnValue([
            trace({ id: 'leg1', name: 'Newport - Coral Sea (1st Leg)', tripId: 't1', legOrdinal: 1 }),
            // Cloud round-trip dropped legOrdinal; the name badge is the fallback.
            trace({ id: 'leg2', name: 'Coral Sea - Whitsundays (2nd Leg)', tripId: 't1' }),
        ]);
        const map = tripIdentityByTraceId();
        expect(map.get('leg1')?.legName).toBe('Newport - Coral Sea');
        expect(map.get('leg2')?.legName).toBe('Coral Sea - Whitsundays');
        expect(map.get('leg2')?.legOrdinal).toBe(2);
    });

    it('names a passage and tags its legs when both are present', () => {
        loadSavedTraces.mockReturnValue([
            trace({ id: 'leg1', name: 'Newport - Coral Sea (Leg 1)', tripId: 'leg1', legOrdinal: 1 }),
            trace({ id: 'leg2', name: 'Coral Sea - Mackay (Leg 2)', tripId: 'leg1', legOrdinal: 2 }),
        ]);
        const map = tripIdentityByTraceId();
        expect(map.get('leg1')?.tripId).toBe('leg1');
        expect(map.get('leg1')?.legOrdinal).toBe(1);
        expect(map.get('leg2')?.legOrdinal).toBe(2);
        // Both legs share one heading, and it names the whole passage.
        expect(map.get('leg1')?.tripName).toBe(map.get('leg2')?.tripName);
        expect(map.get('leg1')?.tripName).toContain('Passage');
    });

    it('leaves a LONE leg ungrouped rather than orphaning it under nothing', () => {
        // Only one leg of the trip is on this device. A dog-leg arrow beneath a
        // heading that was never emitted is an arrow pointing at nothing.
        loadSavedTraces.mockReturnValue([
            trace({ id: 'leg1', name: 'Newport - Coral Sea (Leg 1)', tripId: 'trip-a', legOrdinal: 1 }),
        ]);
        expect(tripIdentityByTraceId().has('leg1')).toBe(false);
    });

    it('ignores a day sail entirely', () => {
        loadSavedTraces.mockReturnValue([trace({ id: 'solo', name: 'Newport - Moreton Bay' })]);
        expect(tripIdentityByTraceId().size).toBe(0);
    });

    it('is empty when nothing is saved', () => {
        loadSavedTraces.mockReturnValue([]);
        expect(tripIdentityByTraceId().size).toBe(0);
    });

    it('keys by TRACE id, which is what the sheet already resolves', () => {
        // The sheet holds a savedRouteId per row; joining on anything else —
        // a name, a point count — would be guesswork.
        loadSavedTraces.mockReturnValue([
            trace({ id: 'trace-aaa', tripId: 'trace-aaa', legOrdinal: 1 }),
            trace({ id: 'trace-bbb', tripId: 'trace-aaa', legOrdinal: 2 }),
        ]);
        const map = tripIdentityByTraceId();
        expect([...map.keys()].sort()).toEqual(['trace-aaa', 'trace-bbb']);
    });
});
