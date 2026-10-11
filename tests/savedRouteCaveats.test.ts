/**
 * A route saved from the MAP planner keeps its caveats (round-3 review,
 * 2026-09-30). PassageBanner's save built the plan from its origin,
 * destination and turn waypoints only: 'Bridges and power lines not checked',
 * 'pin on a drying bank' and decision 9's survey words were all gone once
 * saved. They now ride the plan (__inshoreRouting.caveats), the logbook
 * route's notes (one line each), the route read back from the logbook, and a
 * plan followed from it — where savedInshoreRouteCaveats says them again.
 */
import { describe, expect, it } from 'vitest';
import { ROUTE_CAVEAT_LINE_PREFIX, routeCaveatNotes } from '../services/shiplog/PassagePlanSave';
import { recoverRouteCaveats, type RouteOrTrack } from '../services/shiplog/RoutesAndTracks';
import { buildFollowRoutePlanFromRoute } from '../services/shiplog/followRoutePlan';
import { savedInshoreRouteCaveats } from '../components/map/inshoreRouteNotice';

const caveats = [
    'Bridges and power lines not checked on this chart — known bridges are.',
    'Your destination pin is on a drying bank — the route stops at its edge. It dries at low water.',
];

describe('a saved route keeps its caveats', () => {
    it('the logbook notes carry one line per caveat, after the summary, and read back exactly', () => {
        // Worked out on an open (NOAA) chart: its notes are written as they are
        // (over licensed charts they are made number-free; tests/VoyagePlanChartFacts).
        const notes = `__route_geometry__::[[153,-27],[153.1,-27.1]]\nPlanned: A → B${routeCaveatNotes({ __inshoreRouting: { cellsUsed: ['US5XX01M'], caveats: [...caveats, 3, '  '] } })}`;
        expect(notes.split('\n').filter((l) => l.startsWith(ROUTE_CAVEAT_LINE_PREFIX))).toHaveLength(2);
        expect(recoverRouteCaveats(notes)).toEqual(caveats);
        // The geometry line is untouched: still the first line.
        expect(notes.split('\n')[0]).toBe('__route_geometry__::[[153,-27],[153.1,-27.1]]');
        expect(routeCaveatNotes({})).toBe('');
        expect(recoverRouteCaveats(null)).toEqual([]);
    });

    it('a plan followed from the logbook route says them again', () => {
        const route: RouteOrTrack = {
            id: 'planned_1',
            label: 'Newport → Tangalooma',
            sublabel: 'Planned · 20 NM',
            points: [
                { lat: -27.2, lon: 153.09 },
                { lat: -27.18, lon: 153.37 },
            ],
            bbox: [153.09, -27.2, 153.37, -27.18],
            timestamp: Date.parse('2026-10-01T00:00:00Z'),
            distanceNm: 20,
            isLocal: false,
            kind: 'sea',
            caveats,
        };
        const plan = buildFollowRoutePlanFromRoute(route);
        expect(savedInshoreRouteCaveats(plan)).toEqual(caveats);
        // A route with none adds nothing.
        const plain = buildFollowRoutePlanFromRoute({ ...route, caveats: undefined });
        expect(plain?.__inshoreRouting).toBeUndefined();
    });
});
