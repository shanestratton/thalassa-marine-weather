/**
 * Glue seam contract (PHASE 0) — docs/THREE_TIER_ROUTING.md §3.1.
 *
 * The three real field bugs are seeded as planted-mismatch fixtures, each
 * asserting the exact Refusal code: the bug class becomes a TEST ROW, not a
 * field report. Plus independent coverage of all four clauses.
 */
import { describe, it, expect } from 'vitest';
import { glue, stitchLegs } from '../../services/glue/gluer';
import { isRefusal, type BoundaryNode, type Leg, type LatLon } from '../../services/routing/legContract';

function node(at: LatLon, headingDeg: number, extra: Partial<BoundaryNode> = {}): BoundaryNode {
    return { at, headingDeg, kind: 'channel-mouth', depthM: 10, snapped: true, ...extra };
}
function leg(
    tierId: 1 | 2 | 3,
    entry: BoundaryNode,
    exit: BoundaryNode,
    polyline: LatLon[],
    extra: Partial<Leg> = {},
): Leg {
    return {
        tierId,
        entry,
        exit,
        polyline,
        cautionMask: extra.cautionMask ?? polyline.map(() => false),
        depthSource: extra.depthSource ?? 'charted',
        controllingDepthM: extra.controllingDepthM ?? 10,
        provenance: extra.provenance ?? `t${tierId}`,
    };
}

// A straight N→S run at a fixed lon, ending/starting at the seam point.
const colNorth = (lon: number, latSeam: number): LatLon[] => [
    [lon, latSeam - 0.002],
    [lon, latSeam - 0.001],
    [lon, latSeam],
];
const colSouth = (lon: number, latSeam: number): LatLon[] => [
    [lon, latSeam],
    [lon, latSeam + 0.001],
    [lon, latSeam + 0.002],
];

describe('glue seam — planted field-bug fixtures', () => {
    it('Brisbane bar 175° → Refusal(double-back)', () => {
        const seam = [153.1, -27.4] as LatLon;
        const a = leg(2, node([153.1, -27.41], 10), node(seam, 10), colNorth(153.1, -27.4));
        const b = leg(3, node(seam, 185), node([153.1, -27.39], 185), colSouth(153.1, -27.4));
        const r = glue(a, b);
        expect(isRefusal(r)).toBe(true);
        if (isRefusal(r)) {
            expect(r.reason).toBe('double-back');
            expect(r.measuredTurnDeg).toBe(175);
        }
    });

    it('Newport approach ±171° → Refusal(double-back)', () => {
        const seam = [153.09, -27.21] as LatLon;
        const a = leg(2, node([153.09, -27.22], 10), node(seam, 10), colNorth(153.09, -27.21));
        const b = leg(3, node(seam, 181), node([153.09, -27.2], 181), colSouth(153.09, -27.21));
        const r = glue(a, b);
        expect(isRefusal(r)).toBe(true);
        if (isRefusal(r)) expect(r.measuredTurnDeg).toBe(171);
    });

    it('Newport-exit (tier-2 bay → tier-3 channel), aligned + between the marks → clean concat, no interior bead', () => {
        const seam = [153.201, -27.3] as LatLon; // between port 153.200 and stbd 153.202
        const cross = { port: [153.2, -27.3] as LatLon, stbd: [153.202, -27.3] as LatLon };
        const a = leg(2, node([153.201, -27.31], 0), node(seam, 0), colNorth(153.201, -27.3));
        const b = leg(3, node(seam, 0, { crossLine: cross }), node([153.201, -27.29], 0), colSouth(153.201, -27.3));
        const r = glue(a, b);
        expect(isRefusal(r)).toBe(false);
        if (!isRefusal(r)) {
            // pure concat: A ++ B[1:], shared vertex dropped once
            expect(r.joined.polyline).toHaveLength(a.polyline.length + b.polyline.length - 1);
            // no interior bead: cumulative distance is monotone (no backtrack)
            const pl = r.joined.polyline;
            for (let i = 2; i < pl.length; i++) {
                const back = (pl[i][1] - pl[i - 1][1]) * (pl[i - 1][1] - pl[i - 2][1]);
                expect(back).toBeGreaterThanOrEqual(0); // never reverses N/S direction
            }
        }
    });
});

describe('glue seam — clauses', () => {
    it('clause 1: a gap > 1 m between exit and entry → Refusal(boundary-gap)', () => {
        const a = leg(2, node([153.0, -27.0], 90), node([153.0, -27.0], 90), [
            [153.0, -27.001],
            [153.0, -27.0],
        ]);
        const b = leg(3, node([153.01, -27.0], 90), node([153.02, -27.0], 90), [
            [153.01, -27.0],
            [153.02, -27.0],
        ]); // ~1 km east
        const r = glue(a, b);
        expect(isRefusal(r) && r.reason).toBe('boundary-gap');
    });

    it('clause 2 cross-line: passing OUTSIDE the marks → Refusal(wrong-side)', () => {
        const seam = [153.199, -27.3] as LatLon; // WEST of port 153.200 → wing (port-outside)
        const cross = { port: [153.2, -27.3] as LatLon, stbd: [153.202, -27.3] as LatLon };
        const a = leg(2, node([153.199, -27.31], 0), node(seam, 0), colNorth(153.199, -27.3));
        const b = leg(3, node(seam, 0, { crossLine: cross }), node([153.199, -27.29], 0), colSouth(153.199, -27.3));
        const r = glue(a, b);
        expect(isRefusal(r) && r.reason).toBe('wrong-side');
    });

    it('clause 3: a red leg meeting a confident-clean leg → Refusal(caution-discontinuity)', () => {
        const seam = [153.0, -27.0] as LatLon;
        const a = leg(2, node([153.0, -27.01], 90), node(seam, 90), [[153.0, -27.01], seam], {
            cautionMask: [false, true],
        });
        const b = leg(3, node(seam, 90), node([153.0, -26.99], 90), [seam, [153.0, -26.99]], {
            cautionMask: [false, false],
        });
        const r = glue(a, b);
        expect(isRefusal(r) && r.reason).toBe('caution-discontinuity');
    });

    it('clause 4 + identity: a valid join is a pure concat that preserves entry identity + min depth', () => {
        const seam = [153.0, -27.0] as LatLon;
        const eA = node([153.0, -27.01], 90);
        const a = leg(2, eA, node(seam, 90), [[153.0, -27.01], seam], { controllingDepthM: 8 });
        const b = leg(3, node(seam, 90), node([153.0, -26.99], 90), [seam, [153.0, -26.99]], {
            controllingDepthM: 4,
            depthSource: 'marks-vouched',
        });
        const r = glue(a, b);
        expect(isRefusal(r)).toBe(false);
        if (!isRefusal(r)) {
            expect(r.joined.entry).toBe(eA); // identity preserved
            expect(r.joined.controllingDepthM).toBe(4); // min
            expect(r.joined.depthSource).toBe('marks-vouched'); // worse of the two
            expect(Object.isFrozen(r.joined)).toBe(true);
        }
    });
});

describe('stitchLegs — fold + refusal propagation', () => {
    it('folds a clean 3-leg route in order', () => {
        const s1 = [153.0, -27.0] as LatLon;
        const s2 = [153.0, -26.99] as LatLon;
        const l1 = leg(3, node([153.0, -27.01], 0), node(s1, 0), [[153.0, -27.01], s1]);
        const l2 = leg(2, node(s1, 0), node(s2, 0), [s1, s2]);
        const l3 = leg(3, node(s2, 0), node([153.0, -26.98], 0), [s2, [153.0, -26.98]]);
        const g = stitchLegs([l1, l2, l3]);
        expect(g.refusal).toBeUndefined();
        expect(g.legs).toHaveLength(3);
        expect(g.polyline).toHaveLength(4); // 6 vertices − 2 shared
    });

    it('stops at the first failed seam, keeping the route up to it', () => {
        const s1 = [153.0, -27.0] as LatLon;
        const l1 = leg(2, node([153.0, -27.01], 10), node(s1, 10), [[153.0, -27.01], s1]);
        const l2 = leg(3, node(s1, 185), node([153.0, -26.99], 185), [s1, [153.0, -26.99]]); // double-back
        const g = stitchLegs([l1, l2]);
        expect(g.refusal?.reason).toBe('double-back');
        expect(g.refusal?.atIndex).toBe(1);
        expect(g.legs).toHaveLength(1); // only the first leg made it in
    });

    it('a tier Refusal in the span list halts the fold with its reason', () => {
        const l1 = leg(2, node([153.0, -27.01], 0), node([153.0, -27.0], 0), [
            [153.0, -27.01],
            [153.0, -27.0],
        ]);
        const g = stitchLegs([l1, { refused: true, reason: 'no-deepwater-corridor' }]);
        expect(g.refusal?.reason).toBe('no-deepwater-corridor');
        expect(g.legs).toHaveLength(1);
    });
});
