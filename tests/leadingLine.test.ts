/**
 * leadingLine — charted leading-line (transit) follower. Proves the snap rides
 * the EXACT charted line where the route transits it ("line up the marks"),
 * leaves everything else alone, never moves the origin/destination, never snaps
 * across hard land, and carries the caution flag honestly.
 */
import { describe, it, expect } from 'vitest';
import {
    parseLeadingLines,
    snapToLeadingLines,
    buildLeadingApproach,
    distM,
    type LatLon,
    type LeadingLine,
} from '../services/leadingLine';

// A straight E-W leading line at lat -27.20, lon 153.30 → 153.32 (~2 km).
const LINE: LeadingLine = {
    pts: [
        { lat: -27.2, lon: 153.3 },
        { lat: -27.2, lon: 153.32 },
    ],
};

describe('parseLeadingLines', () => {
    it('parses LineString + MultiLineString features, ignores non-lines', () => {
        const feats = [
            {
                geometry: {
                    type: 'LineString',
                    coordinates: [
                        [153.3, -27.2],
                        [153.32, -27.2],
                    ],
                },
                properties: {},
            },
            {
                geometry: {
                    type: 'MultiLineString',
                    coordinates: [
                        [
                            [153.4, -27.18],
                            [153.42, -27.19],
                        ],
                    ],
                },
                properties: {},
            },
            { geometry: { type: 'Point', coordinates: [153.3, -27.2] }, properties: {} }, // ignored
        ];
        const lines = parseLeadingLines(feats);
        expect(lines).toHaveLength(2);
        expect(lines[0].pts).toHaveLength(2);
        expect(lines[0].pts[0]).toMatchObject({ lat: -27.2, lon: 153.3 });
    });
});

describe('snapToLeadingLines', () => {
    // origin (W of the line) → zigzag hugging the line → dest (E of the line).
    const zigzag: LatLon[] = [
        { lat: -27.2, lon: 153.295 }, // origin, ~490 m off the W end → not near
        { lat: -27.2008, lon: 153.305 }, // ~88 m S of the line
        { lat: -27.1992, lon: 153.31 }, // ~88 m N of the line
        { lat: -27.2008, lon: 153.315 }, // ~88 m S of the line
        { lat: -27.2, lon: 153.325 }, // dest, ~490 m off the E end → not near
    ];
    const caution = [true, true, true, true]; // all red before the snap

    it('snaps the in-corridor zigzag straight onto the leading line', () => {
        const r = snapToLeadingLines(zigzag, caution, [LINE]);
        expect(r.snapped).toBe(1);
        // Interior vertices now sit ON the line (lat ≈ -27.20), not zigzagging.
        for (let i = 1; i < r.polyline.length - 1; i++) {
            expect(Math.abs(r.polyline[i].lat - -27.2)).toBeLessThan(1e-4);
        }
    });

    it('never moves the origin or the destination', () => {
        const r = snapToLeadingLines(zigzag, caution, [LINE]);
        expect(r.polyline[0]).toMatchObject(zigzag[0]);
        expect(r.polyline[r.polyline.length - 1]).toMatchObject(zigzag[zigzag.length - 1]);
    });

    it('leaves a route that never approaches the line unchanged', () => {
        const away: LatLon[] = [
            { lat: -27.1, lon: 153.3 },
            { lat: -27.1, lon: 153.31 },
            { lat: -27.1, lon: 153.32 },
            { lat: -27.1, lon: 153.33 },
        ];
        const r = snapToLeadingLines(away, [false, false, false], [LINE]);
        expect(r.snapped).toBe(0);
        expect(r.polyline).toEqual(away);
    });

    it('does not snap a brief perpendicular crossing (run too short)', () => {
        const cross: LatLon[] = [
            { lat: -27.205, lon: 153.31 },
            { lat: -27.2, lon: 153.31 }, // momentarily touches the line
            { lat: -27.195, lon: 153.31 },
            { lat: -27.19, lon: 153.31 },
        ];
        const r = snapToLeadingLines(cross, [false, false, false], [LINE]);
        expect(r.snapped).toBe(0);
    });

    it('GATE land-validation: a transit that would cross hard land → not snapped', () => {
        const r = snapToLeadingLines(zigzag, caution, [LINE], { isBlocked: () => true });
        expect(r.snapped).toBe(0);
        expect(r.polyline).toEqual(zigzag);
    });

    it('keeps the on-line transit RED where it genuinely crosses caution water', () => {
        const r = snapToLeadingLines(zigzag, caution, [LINE], { isCaution: () => true });
        expect(r.snapped).toBe(1);
        expect(r.cautionMask.some(Boolean)).toBe(true);
    });

    it('drops the red where the leading-line corridor is clean (Pass 5b rescued it)', () => {
        const r = snapToLeadingLines(zigzag, caution, [LINE], { isCaution: () => false });
        expect(r.snapped).toBe(1);
        // The spliced on-line segment goes clean; only the entry/exit bridges keep red.
        expect(r.cautionMask.filter(Boolean).length).toBeLessThan(caution.filter(Boolean).length);
    });
});

describe('buildLeadingApproach — route-via-transit', () => {
    // The REAL Tangalooma leads (OSM navigation_line, Moreton Bay): a dog-leg —
    // outer transit then turn onto the inner transit into the anchorage.
    const INNER: LeadingLine = {
        pts: [
            { lat: -27.1735, lon: 153.3714 }, // landward (near dest)
            { lat: -27.1773, lon: 153.3712 }, // seaward
        ],
    };
    const OUTER: LeadingLine = {
        pts: [
            { lat: -27.1894, lon: 153.3701 }, // landward
            { lat: -27.1913, lon: 153.3644 }, // seaward (the outermost mark)
        ],
    };
    const DEST = { lat: -27.1704, lon: 153.3695 };

    it('chains the dog-leg seaward→landward and anchors at the outermost mark', () => {
        const a = buildLeadingApproach(DEST, [INNER, OUTER]);
        expect(a).not.toBeNull();
        expect(a!.lineCount).toBe(2);
        // Anchor = the outer line's seaward end (the seaward mark you make first).
        expect(a!.anchor).toMatchObject({ lat: -27.1913, lon: 153.3644 });
        expect(a!.chain[0]).toMatchObject({ lat: -27.1913, lon: 153.3644 });
        expect(a!.chain[a!.chain.length - 1]).toMatchObject(DEST);
        // The leads run IN: every step gets closer to the destination.
        for (let i = 1; i < a!.chain.length; i++) {
            expect(distM(a!.chain[i], DEST)).toBeLessThanOrEqual(distM(a!.chain[i - 1], DEST) + 1);
        }
    });

    it('a single serving line → [seaward, landward, dest]', () => {
        const a = buildLeadingApproach(DEST, [INNER]);
        expect(a).not.toBeNull();
        expect(a!.lineCount).toBe(1);
        expect(a!.chain).toHaveLength(3);
        expect(a!.anchor).toMatchObject({ lat: -27.1773, lon: 153.3712 }); // inner's seaward end
        expect(a!.chain[2]).toMatchObject(DEST);
    });

    it('returns null when no leading line serves the destination', () => {
        expect(buildLeadingApproach({ lat: -27.5, lon: 153.6 }, [INNER, OUTER])).toBeNull();
    });

    it('returns null with no lines', () => {
        expect(buildLeadingApproach(DEST, [])).toBeNull();
    });
});
