/**
 * The cast-off "Following a route?" sheet shows a passage WHOLE.
 *
 * Shane 2026-09-08: "the following a route box only shows the first two legs
 * of my newport whitsundays passage. it is not showing me the last leg?" Two
 * doors a leg could fall through, both closed here:
 *   - the there-and-back fold (written for day sails) treated a homeward leg
 *     as the reverse of the outbound one and folded them into a single row;
 *   - a leg saved in Route Tracer but never mirrored into the log has no
 *     planned-route row at all, so the sheet had nothing to list.
 */
import { describe, expect, it } from 'vitest';
import {
    buildFollowPromptRows,
    buildFollowSheetChoices,
    collapseOutsideTrips,
    missingTripLegs,
    type FollowSheetDeps,
} from '../pages/log/logPageDerive';
import { collapseReversedRoutes } from '../services/shiplog/collapseReversedRoutes';
import type { VoyageSummary } from '../services/shiplog/VoyageSummary';
import type { SavedTrace } from '../services/routeTracer';

const NEWPORT = { lat: -27.2, lon: 153.1 };
const GLADSTONE = { lat: -23.85, lon: 151.25 };
const MACKAY = { lat: -21.1, lon: 149.2 };
const WHITSUNDAYS = { lat: -20.28, lon: 148.95 };

const summary = (
    voyageId: string,
    from: { lat: number; lon: number },
    to: { lat: number; lon: number },
    totalDistanceNM: number,
    startedAt: string,
): VoyageSummary =>
    ({
        voyageId,
        totalDistanceNM,
        firstLat: from.lat,
        firstLon: from.lon,
        lastLat: to.lat,
        lastLon: to.lon,
        startedAt,
        isPlannedRoute: true,
    }) as unknown as VoyageSummary;

const leg1 = summary('v1', NEWPORT, GLADSTONE, 290, '2026-09-20T00:00:00Z');
const leg2 = summary('v2', GLADSTONE, MACKAY, 210, '2026-09-22T00:00:00Z');
const leg3 = summary('v3', MACKAY, WHITSUNDAYS, 70, '2026-09-24T00:00:00Z');
/** The homeward first leg — the exact reverse of leg 3. */
const home1 = summary('v9', WHITSUNDAYS, MACKAY, 70, '2026-10-01T00:00:00Z');
const daySail = summary('v5', NEWPORT, { lat: -27.4, lon: 153.4 }, 22, '2026-09-10T00:00:00Z');
const daySailBack = summary('v6', { lat: -27.4, lon: 153.4 }, NEWPORT, 22, '2026-09-10T06:00:00Z');

const links = new Map<string, string>([
    ['v1', 't1'],
    ['v2', 't2'],
    ['v3', 't3'],
    ['v9', 't9'],
]);
const trace = (id: string, name: string, legOrdinal: number, points = [NEWPORT, GLADSTONE]): SavedTrace =>
    ({ id, name, createdAt: '2026-09-01T00:00:00Z', points, tripId: 't1', legOrdinal }) as SavedTrace;

const deps = (traces: SavedTrace[]): FollowSheetDeps => ({
    tripByTraceId: () =>
        new Map([
            [
                't1',
                {
                    tripId: 't1',
                    legOrdinal: 1,
                    tripName: 'newport - whitsundays (Passage)',
                    legName: 'newport - gladstone',
                },
            ],
            [
                't2',
                {
                    tripId: 't1',
                    legOrdinal: 2,
                    tripName: 'newport - whitsundays (Passage)',
                    legName: 'gladstone - mackay',
                },
            ],
            [
                't3',
                {
                    tripId: 't1',
                    legOrdinal: 3,
                    tripName: 'newport - whitsundays (Passage)',
                    legName: 'mackay - whitsundays',
                },
            ],
        ]),
    traceLinkByVoyageId: () => new Map(),
    blockReason: () => null,
    traces: () => traces,
});

describe('a passage reads whole on the cast-off sheet', () => {
    it('the old fold really did eat the last leg under its homeward twin', () => {
        const folded = collapseReversedRoutes([leg1, leg2, leg3, home1], null);
        expect(folded.map((c) => c.summary.voyageId)).toEqual(['v1', 'v2', 'v3']);
        expect(folded[2].reversible).toBe(true); // leg 3 and home 1 became one row
    });

    it('trip legs are never folded; day sails still are', () => {
        const out = collapseOutsideTrips([leg1, leg2, leg3, home1, daySail, daySailBack], links, null, deps([]));
        expect(out.map((c) => c.summary.voyageId)).toEqual(['v1', 'v2', 'v3', 'v9', 'v5']);
        expect(out.every((c) => c.reversible === (c.summary.voyageId === 'v5'))).toBe(true);
    });

    it('a leg saved in the tracer but never mirrored into the log is named in its place, disabled', () => {
        // Only legs 1 and 2 reached the log; leg 3 exists as a trace alone.
        const d = deps([
            trace('t1', 'newport - gladstone', 1),
            trace('t2', 'gladstone - mackay (2nd Leg)', 2),
            trace('t3', 'mackay - whitsundays (3rd Leg)', 3),
        ]);
        const choices = buildFollowSheetChoices(collapseOutsideTrips([leg1, leg2], links, null, d), links, d);
        const missing = missingTripLegs(choices, d);
        expect(missing).toEqual([
            expect.objectContaining({ tripId: 't1', legOrdinal: 3, name: 'mackay - whitsundays', savedRouteId: 't3' }),
        ]);
        const rows = buildFollowPromptRows(choices, missing);
        expect(
            rows.map((r) =>
                r.type === 'passage'
                    ? `H:${r.name}`
                    : r.type === 'choice'
                      ? `L:${r.row.choice.summary.voyageId}`
                      : `M:${r.leg.savedRouteId}`,
            ),
        ).toEqual(['H:newport - whitsundays (Passage)', 'L:v1', 'L:v2', 'M:t3']);
    });

    it('nothing to report when every leg reached the log, or when there is no trip at all', () => {
        const d = deps([trace('t1', 'newport - gladstone', 1), trace('t2', 'gladstone - mackay (2nd Leg)', 2)]);
        const choices = buildFollowSheetChoices(collapseOutsideTrips([leg1, leg2], links, null, d), links, d);
        expect(missingTripLegs(choices, d)).toEqual([]);
        expect(
            missingTripLegs(buildFollowSheetChoices([{ summary: daySail, reversible: false }], new Map(), d), d),
        ).toEqual([]);
    });
});
