/**
 * The Plan page's saved routes ARE the passage list (Shane 2026-08-27: "a
 * route is not removed from the list in the cast off list or the passage
 * planning page, unless it is removed from the plan page — that should be
 * our truth for the passage list").
 *
 * Both lists used to be voyage-row-first, so a live saved route could vanish
 * four ways: End Voyage flipped its row out of the 'planning' filter, a
 * tracer-only save never minted a row, a cross-device sync arrived with no
 * mirror, and adoptServerRoute builds a trace with no links at all. These
 * pin the stub pass that closes all four.
 */
import { describe, expect, it } from 'vitest';
import { buildTraceStubRows, traceStubId, TRACE_STUB_ID_PREFIX } from '../services/savedRouteRows';
import type { SavedTrace } from '../services/routeTracer';
import type { SavedRouteRow } from '../services/savedRouteRows';

const PTS = [
    { lat: -27.2, lon: 153.1 },
    { lat: -21.1, lon: 152.4 },
];

const trace = (over: Partial<SavedTrace> & Pick<SavedTrace, 'id' | 'name'>): SavedTrace => ({
    createdAt: '2026-08-20T00:00:00.000Z',
    points: PTS,
    ...over,
});

const row = (over: Partial<SavedRouteRow> & Pick<SavedRouteRow, 'id' | 'voyage_name'>): SavedRouteRow =>
    ({
        user_id: 'u',
        vessel_id: null,
        departure_port: null,
        destination_port: null,
        departure_time: null,
        eta: null,
        crew_count: 2,
        status: 'planning',
        weather_master_id: null,
        notes: null,
        created_at: '2026-08-20T00:00:00.000Z',
        updated_at: '2026-08-20T00:00:00.000Z',
        saved_route_id: null,
        ...over,
    }) as SavedRouteRow;

const VESSEL = { crewCount: 2, cruisingSpeed: 6 };

describe('buildTraceStubRows', () => {
    it('stubs a saved route no row stands for — the End Voyage / tracer-only case', () => {
        const stubs = buildTraceStubRows([trace({ id: 't1', name: 'Newport - Mackay' })], [], VESSEL);
        expect(stubs).toHaveLength(1);
        expect(stubs[0].id).toBe(traceStubId('t1'));
        expect(stubs[0].id.startsWith(TRACE_STUB_ID_PREFIX)).toBe(true);
        // Materialise-on-select needs these three to build a real voyage row.
        expect(stubs[0].saved_route_id).toBe('t1');
        expect(stubs[0].voyage_name).toBe('Newport - Mackay');
        expect(stubs[0].routeCoordinates).toHaveLength(2);
        expect(stubs[0].status).toBe('planning');
    });

    it('stays quiet when a row already stands for the route', () => {
        const rows = [row({ id: 'v1', voyage_name: 'Newport - Mackay', saved_route_id: 't1' })];
        expect(buildTraceStubRows([trace({ id: 't1', name: 'Newport - Mackay' })], rows, VESSEL)).toEqual([]);
    });

    it("counts the trace's own passageVoyageId back-link as representation", () => {
        const rows = [row({ id: 'v9', voyage_name: 'Newport - Mackay' })];
        const traces = [trace({ id: 't1', name: 'Newport - Mackay', passageVoyageId: 'v9' })];
        expect(buildTraceStubRows(traces, rows, VESSEL)).toEqual([]);
    });

    it('a "(Passage)" row does NOT represent leg 1 — the trip-id collision', () => {
        // Leg 1's trace id doubles as the trip id, and the rollup carries the
        // trip id as its saved_route_id. Reading that as representation would
        // silently swallow leg 1's own row on every multi-leg trip.
        const rows = [row({ id: 'logbook:trip:t1', voyage_name: 'Newport - Mackay (Passage)', saved_route_id: 't1' })];
        const traces = [
            trace({ id: 't1', name: 'Newport - Coral Sea (1st Leg)', tripId: 't1', legOrdinal: 1 }),
            trace({ id: 't2', name: 'Coral Sea - Mackay (2nd Leg)', tripId: 't1', legOrdinal: 2 }),
        ];
        const stubs = buildTraceStubRows(traces, rows, VESSEL);
        expect(stubs.map((s) => s.saved_route_id)).toEqual(['t1', 't2']);
    });

    it('carries the STORED trace name so the picker can badge it once, not twice', () => {
        // The picker strips and re-adds the "(2nd Leg)" badge itself. Passing
        // displayRouteLabel's list form ("… (Leg 2)") through would survive
        // that strip and render "… (Leg 2) (2nd Leg)".
        const traces = [trace({ id: 't2', name: 'Coral Sea - Mackay (2nd Leg)', tripId: 't1', legOrdinal: 2 })];
        const name = buildTraceStubRows(traces, [], VESSEL)[0].voyage_name;
        expect(name).toBe('Coral Sea - Mackay (2nd Leg)');
        expect(name).not.toMatch(/\(Leg \d/);
    });

    it('is deterministic — a second pass produces identical rows', () => {
        // A fresh timestamp per reload would make every pass emit "different"
        // rows and re-fire the content-keyed effects this page coalesces.
        const traces = [trace({ id: 't1', name: 'Newport - Mackay', updatedAt: '2026-08-26T05:00:00.000Z' })];
        expect(buildTraceStubRows(traces, [], VESSEL)).toEqual(buildTraceStubRows(traces, [], VESSEL));
        expect(buildTraceStubRows(traces, [], VESSEL)[0].departure_time).toBe('2026-08-26T05:00:00.000Z');
    });

    it('skips a trace with no usable geometry rather than offering an empty route', () => {
        expect(buildTraceStubRows([trace({ id: 't1', name: 'x', points: [PTS[0]] })], [], VESSEL)).toEqual([]);
        expect(
            buildTraceStubRows(
                [trace({ id: 't2', name: 'y', points: [{ lat: Number.NaN, lon: 1 }, PTS[0]] })],
                [],
                VESSEL,
            ),
        ).toEqual([]);
    });

    it('inherits the deletion fence — a deleted route is simply absent from the input', () => {
        // loadSavedTraces already filters tombstoned ids, so the stub pass
        // never needs its own delete logic. Deleting on the Plan page stays
        // the ONE way a route leaves these lists.
        expect(buildTraceStubRows([], [row({ id: 'v1', voyage_name: 'ghost' })], VESSEL)).toEqual([]);
    });
});
