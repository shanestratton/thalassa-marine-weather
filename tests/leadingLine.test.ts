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

    // RECTRC wins over NAVLNE: a run already riding the recommended track must
    // NOT be dragged off onto a (deliberately off-centre) leading line.
    describe('protect — RECTRC authoritative over the leading line', () => {
        // A recommended track running ~88 m NORTH of LINE, parallel to it. The
        // zigzag's interior vertices sit within protectM of this track.
        const TRACK: LeadingLine = {
            pts: [
                { lat: -27.1992, lon: 153.3 },
                { lat: -27.1992, lon: 153.32 },
            ],
        };
        // A route riding the recommended track (all interior vertices ON it).
        const onTrack: LatLon[] = [
            { lat: -27.2, lon: 153.295 }, // origin off the W end
            { lat: -27.1992, lon: 153.305 },
            { lat: -27.1992, lon: 153.31 },
            { lat: -27.1992, lon: 153.315 },
            { lat: -27.2, lon: 153.325 }, // dest off the E end
        ];
        const onTrackCaution = [false, false, false, false];

        it('does NOT snap a run that already rides the protected track', () => {
            const r = snapToLeadingLines(onTrack, onTrackCaution, [LINE], {
                protect: [TRACK],
                protectM: 70,
            });
            expect(r.snapped).toBe(0);
            expect(r.polyline).toEqual(onTrack);
        });

        it('STILL snaps the same run when no protect track is supplied (today behaviour)', () => {
            const r = snapToLeadingLines(onTrack, onTrackCaution, [LINE]);
            expect(r.snapped).toBe(1);
        });

        it('still snaps a run that is OFF the protected track', () => {
            // The hugging zigzag sits ~88 m off LINE and ~176 m off TRACK — well
            // beyond protectM, so the protect guard does not fire.
            const r = snapToLeadingLines(zigzag, caution, [LINE], { protect: [TRACK], protectM: 70 });
            expect(r.snapped).toBe(1);
        });
    });
});

describe('buildLeadingApproach — route-via-transit (transit LINES, never beacons)', () => {
    // The REAL Tangalooma leads (OSM navigation_line, Moreton Bay): a dog-leg —
    // ride the outer transit, turn at the line intersection, run the inner
    // transit in, break off abeam the anchorage. Leading beacons routinely
    // stand on shore/drying banks, so NO chain vertex may be a mark position.
    const INNER: LeadingLine = {
        pts: [
            { lat: -27.1735, lon: 153.3714 },
            { lat: -27.1773, lon: 153.3712 },
        ],
    };
    const OUTER: LeadingLine = {
        pts: [
            { lat: -27.1894, lon: 153.3701 },
            { lat: -27.1913, lon: 153.3644 },
        ],
    };
    const DEST = { lat: -27.1704, lon: 153.3695 };

    /** Cross-track distance (m) from p to the infinite line through a→b. */
    const xtM = (p: LatLon, a: LatLon, b: LatLon): number => {
        const mLat = 110_540;
        const mLon = 111_320 * Math.cos((a.lat * Math.PI) / 180);
        const ax = 0;
        const ay = 0;
        const bx = (b.lon - a.lon) * mLon;
        const by = (b.lat - a.lat) * mLat;
        const px = (p.lon - a.lon) * mLon;
        const py = (p.lat - a.lat) * mLat;
        const len = Math.hypot(bx - ax, by - ay);
        return Math.abs(((bx - ax) * (ay - py) - (ax - px) * (by - ay)) / len);
    };

    it('dog-leg: anchor on the outer transit, turn at the intersection, break-off abeam dest', () => {
        const a = buildLeadingApproach(DEST, [INNER, OUTER]);
        expect(a).not.toBeNull();
        expect(a!.lineCount).toBe(2);
        const [anchor, turn, breakOff, dest] = a!.chain;
        expect(dest).toMatchObject(DEST);
        // Anchor + turn lie ON the outer transit LINE (not at a beacon).
        expect(xtM(anchor, OUTER.pts[0], OUTER.pts[1])).toBeLessThan(5);
        expect(xtM(turn, OUTER.pts[0], OUTER.pts[1])).toBeLessThan(5);
        // Turn + break-off lie ON the inner transit LINE.
        expect(xtM(turn, INNER.pts[0], INNER.pts[1])).toBeLessThan(5);
        expect(xtM(breakOff, INNER.pts[0], INNER.pts[1])).toBeLessThan(5);
        // Anchor stands ~captureM seaward of the turn.
        expect(distM(anchor, turn)).toBeGreaterThan(700);
        expect(distM(anchor, turn)).toBeLessThan(900);
        // Break-off is abeam the destination (dest projected onto the lead).
        expect(distM(breakOff, dest)).toBeLessThan(400);
        // And the run-in makes monotone progress toward the destination.
        expect(distM(turn, dest)).toBeLessThan(distM(anchor, dest));
        expect(distM(breakOff, dest)).toBeLessThan(distM(turn, dest));
    });

    it('single serving line → [capture, breakOff, dest] along the transit', () => {
        const a = buildLeadingApproach(DEST, [INNER]);
        expect(a).not.toBeNull();
        expect(a!.lineCount).toBe(1);
        expect(a!.chain).toHaveLength(3);
        const [anchor, breakOff, dest] = a!.chain;
        expect(dest).toMatchObject(DEST);
        expect(xtM(anchor, INNER.pts[0], INNER.pts[1])).toBeLessThan(5);
        expect(xtM(breakOff, INNER.pts[0], INNER.pts[1])).toBeLessThan(5);
        expect(distM(anchor, breakOff)).toBeGreaterThan(700);
        expect(distM(anchor, breakOff)).toBeLessThan(900);
    });

    it('returns null when no leading line serves the destination', () => {
        expect(buildLeadingApproach({ lat: -27.5, lon: 153.6 }, [INNER, OUTER])).toBeNull();
    });

    it('returns null with no lines', () => {
        expect(buildLeadingApproach(DEST, [])).toBeNull();
    });
});
