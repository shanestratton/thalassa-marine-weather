/**
 * Red with no charted depth behind it (review fix-up, 2026-10-01).
 *
 * In the review's scene a relaxed route ran 400 m through a land wall beside
 * a bank no tide clears; it was drawn red, and the independent review graded
 * the leg 'caution', so Auto could save it and Plan My Day rated it amber.
 * The router's own colours say what is behind a red segment: a charted
 * shallow depth (a tide could lift it), decision-1 water (a finer survey's
 * band under coarser land paint), a canal — or nothing at all: land the relax
 * retry opened, water no chart vouches for, a charted hazard's buffer.
 */
import { describe, expect, it } from 'vitest';
import { dangerWithoutChartedDepth, type InshoreSegmentState } from '../components/map/inshoreRouteState';

const states = (s: string): InshoreSegmentState[] =>
    [...s].map((c) => (c === 'd' ? 'danger' : c === 'c' ? 'channel' : c === 'o' ? 'offshore' : 'green'));
const mask = (s: string): boolean[] => [...s].map((c) => c === '1');

describe('dangerWithoutChartedDepth', () => {
    it('names the red segments no chart depth, decision-1 band or canal explains', () => {
        expect(
            dangerWithoutChartedDepth({
                stateMask: states('gdddddg'),
                chartedShallowMask: mask('0100000'),
                landPaintConflictMask: mask('0010000'),
                canalMask: mask('0001000'),
            }),
        ).toEqual([4, 5]);
    });

    it('never names a non-red segment', () => {
        expect(dangerWithoutChartedDepth({ stateMask: states('gcog') })).toEqual([]);
    });

    it('reads the shallow runs when the charted-shallow mask is missing (an older route)', () => {
        expect(
            dangerWithoutChartedDepth({
                stateMask: states('ddd'),
                shallowRuns: [
                    { startSeg: 0, endSeg: 0, lengthM: 300, minDepthM: 0.5, midLat: 0, midLon: 0 },
                    { startSeg: 1, endSeg: 1, lengthM: 300, minDepthM: null, midLat: 0, midLon: 0 },
                ],
            }),
        ).toEqual([1, 2]);
    });

    it('a mask that does not fit explains nothing, and no state mask is unverified', () => {
        expect(dangerWithoutChartedDepth({ stateMask: states('dd'), chartedShallowMask: mask('1') })).toEqual([0, 1]);
        expect(dangerWithoutChartedDepth({ stateMask: null })).toBeNull();
    });
});
