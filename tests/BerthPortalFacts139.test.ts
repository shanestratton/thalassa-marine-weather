import { describe, expect, it } from 'vitest';
import { berthSearchPoints, berthPortalViews, chartedBerthPortals } from '../services/routing/berthPortals';
import { berthDisclosure } from '../services/routing/berthProposal';
import type { LeadGraph } from '../services/routing/leadCompiler';
import type { BerthRouteResult } from '../services/routing/berthToBerth';
import { haversineNm } from '../services/isochrone/geodesy';
const berth = { lat: 0, lon: 0 },
    relief = { lat: 0, lon: 0.1 };
const edge = () =>
    ({
        id: 'fictional-chart-lead',
        trust: 'chart',
        coordinates: [
            [0.1, 0],
            [0.2, 0],
        ],
        sourceLandM: 0,
        directionUnresolved: false,
        depth: { minDepthM: 50, uncoveredM: 0, class: 'clear', review: [] },
    }) as unknown as LeadGraph['edges'][number];
describe('charted berth portal admission', () => {
    it('has exactly 48 bounded relief candidates and splits dateline windows without a world request', () => {
        const points = berthSearchPoints({ lat: 0, lon: 179.99 });
        expect(points).toHaveLength(48);
        expect(
            points.every((p) => p.lon >= -180 && p.lon <= 180 && haversineNm(0, 179.99, p.lat, p.lon) <= 43.0001),
        ).toBe(true);
        const views = berthPortalViews({ lat: 0, lon: 179.99 });
        expect(views).toHaveLength(2);
        expect(views.every((b) => b[0] >= -180 && b[2] <= 180 && b[2] - b[0] < 1)).toBe(true);
    });
    it('requires original clear chart lead/depth evidence near the relief candidate', () => {
        expect(chartedBerthPortals({ edges: [edge()] }, berth, relief, 'fictional-current-cohort', 2)).toMatchObject([
            { at: relief, depthM: 50, sourceKey: 'fictional-current-cohort' },
        ]);
        expect(chartedBerthPortals({ edges: [edge()] }, berth, relief, '', 2)).toEqual([]);
    });
    it.each(['osm', 'unknown', 'survey', 'shallow', 'land', 'uncovered', 'direction'] as const)(
        'never promotes %s evidence into a qualified portal',
        (kind) => {
            const e = edge();
            if (kind === 'osm') e.trust = 'osm';
            if (kind === 'unknown') e.depth.class = 'unknown';
            if (kind === 'survey') {
                e.depth.class = 'needs-review';
                e.depth.review = ['survey'];
            }
            if (kind === 'shallow') e.depth.minDepthM = 1;
            if (kind === 'land') e.sourceLandM = 2;
            if (kind === 'uncovered') e.depth.uncoveredM = 20;
            if (kind === 'direction') e.directionUnresolved = true;
            expect(chartedBerthPortals({ edges: [e] }, berth, relief, 'current', 2)).toEqual([]);
        },
    );
});
function joined(): BerthRouteResult {
    return {
        result: { totalDistanceNM: 300 },
        departure: {
            states: ['green', 'channel'],
            disclosure: {
                stateMask: ['green', 'channel'],
                cellsUsed: ['US5TEST1'],
                canalMask: [false, false],
                cautionMask: [false, false],
                shallowRuns: [],
                chartedShallowSpans: [],
                surveyRuns: [],
                backstop: 'verified',
            },
        },
        arrival: {
            states: ['danger'],
            disclosure: {
                stateMask: ['danger'],
                cellsUsed: ['US5TEST2'],
                canalMask: [true],
                cautionMask: [true],
                shallowRuns: [{ startSeg: 0, endSeg: 0, minDepthM: 1 }],
                chartedShallowSpans: [{ startSeg: 0, endSeg: 0 }],
                surveyRuns: [],
                backstop: 'verified',
            },
        },
        states: ['green', 'channel', 'offshore', 'danger', 'danger'],
        offshoreSegments: 2,
        portals: [
            { at: { lat: 0, lon: 0.2 }, sourceKey: 'cohort-A' },
            { at: { lat: 0, lon: 4.8 }, sourceKey: 'cohort-B' },
        ],
    } as unknown as BerthRouteResult;
}
describe('mixed-route disclosure', () => {
    it('retains approach masks and shifts arrival hazard indices across the offshore middle without inventing depth', () => {
        const proof = berthDisclosure(joined(), 42);
        expect(proof.stateMask).toEqual(['green', 'channel', 'offshore', 'danger', 'danger']);
        expect(proof.cautionMask).toEqual([false, false, false, true, true]);
        expect(proof.canalMask).toEqual([false, false, false, false, true]);
        expect(proof.shallowRuns).toMatchObject([{ startSeg: 4, endSeg: 4, minDepthM: 1 }]);
        expect(proof.chartedShallowSpans).toMatchObject([{ startSeg: 4, endSeg: 4 }]);
        expect(proof.cautionDepthM).toEqual([null, null, null, null, null]);
        expect(proof.berth?.sourceKeys).toEqual(['cohort-A', 'cohort-B']);
    });
    it('refuses a mismatched original mask or an interval outside the original approach', () => {
        const a = joined();
        a.arrival.disclosure.cautionMask = [];
        expect(() => berthDisclosure(a, 1)).toThrow('classifications');
        const b = joined();
        b.arrival.disclosure.shallowRuns![0].endSeg = 100;
        expect(() => berthDisclosure(b, 1)).toThrow('interval');
    });
});
