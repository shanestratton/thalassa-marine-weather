/**
 * snapToLeadingLines followInteriorVertices — the river wall-hug fix. A curved RECTRC
 * recommended-track was collapsed to a straight 2-point chord, which cuts the inside of every
 * bend and pins the route to one bank (Shane: Brisbane River north-wall hug). With the flag set
 * (RECTRC call sites only) the snap follows the line's OWN interior vertices through the bend.
 * A straight line is a no-op either way, so every other caller (NAVLINE leads, synthetic channel
 * chains, the canal start) stays byte-identical.
 */
import { describe, it, expect } from 'vitest';
import { snapToLeadingLines, distM } from '../../services/leadingLine';

type LatLon = { lat: number; lon: number };
const minVertDistToM = (poly: LatLon[], m: LatLon): number => Math.min(...poly.map((v) => distM(v, m)));
const opts = { corridorM: 300, minRunM: 80, maxAngleDeg: 45 };

describe('snapToLeadingLines — followInteriorVertices (RECTRC curve-following)', () => {
    // A RECTRC that bulges ~110 m east at its apex M; the route runs down the chord (west of M).
    const bendLine = {
        pts: [
            { lat: -27.3, lon: 153.1 },
            { lat: -27.31, lon: 153.1012 }, // M — the bend apex
            { lat: -27.32, lon: 153.1 },
        ],
    };
    const M = bendLine.pts[1];
    const route: LatLon[] = [
        { lat: -27.295, lon: 153.1 },
        { lat: -27.302, lon: 153.1001 },
        { lat: -27.31, lon: 153.1001 },
        { lat: -27.318, lon: 153.1001 },
        { lat: -27.325, lon: 153.1 },
    ];

    it('chords across the bend by default (legacy behaviour — the wall-hug)', () => {
        const out = snapToLeadingLines(
            route,
            route.map(() => false),
            [bendLine],
            opts,
        );
        expect(out.snapped).toBe(1);
        expect(minVertDistToM(out.polyline, M)).toBeGreaterThan(80); // cuts the inside of the bend
    });

    it('follows the bend when followInteriorVertices is set (rides the recommended track)', () => {
        const out = snapToLeadingLines(
            route,
            route.map(() => false),
            [bendLine],
            { ...opts, followInteriorVertices: true },
        );
        expect(out.snapped).toBe(1);
        expect(minVertDistToM(out.polyline, M)).toBeLessThan(5); // tracks the curve through M, no bank-hug
        expect(out.cautionMask.length).toBe(out.polyline.length); // masks stay index-aligned
    });

    it('a STRAIGHT line is a no-op either way (canal start / NAVLINE leads stay byte-identical)', () => {
        const straight = {
            pts: [
                { lat: -27.3, lon: 153.1 },
                { lat: -27.32, lon: 153.1 },
            ],
        };
        const r: LatLon[] = [
            { lat: -27.295, lon: 153.1001 },
            { lat: -27.305, lon: 153.1001 },
            { lat: -27.315, lon: 153.1001 },
            { lat: -27.325, lon: 153.1001 },
        ];
        const off = snapToLeadingLines(
            r,
            r.map(() => false),
            [straight],
            opts,
        );
        const on = snapToLeadingLines(
            r,
            r.map(() => false),
            [straight],
            { ...opts, followInteriorVertices: true },
        );
        expect(on.polyline).toEqual(off.polyline); // flag has no effect on a straight line
        expect(on.cautionMask).toEqual(off.cautionMask);
    });
});
