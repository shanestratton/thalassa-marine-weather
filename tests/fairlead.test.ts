/**
 * fairlead — lateral-mark channel follower. Algorithm correctness on
 * synthetic channels + a parity check against the real Moreton Bay BC
 * channel marks the spike was proven on (~/Projects/MarinerEE/fairlead_demo.py).
 *
 * The invariants under test: the centreline runs BETWEEN the red and green
 * marks (in the channel, not on the banks), channel identification picks the
 * right channel and ignores the rest, the route is directed outbound from the
 * handoff, and Fairlead bows out (null) when there's no marked channel near.
 */
import { describe, it, expect } from 'vitest';
import {
    parseLateralMarks,
    groupChannels,
    corridorCenterline,
    routeFairlead,
    refineWithFairlead,
    distM,
    type LateralMark,
    type LatLon,
} from '../services/fairlead';

function mark(seq: number, side: 'port' | 'stbd', lat: number, lon: number, key = 'BC'): LateralMark {
    return { seq, side, lat, lon, key, name: `${key}${seq}` };
}

// Real BC channel (Moreton Bay AU SENC) — the spike's proof channel.
const BC: LateralMark[] = [
    mark(1, 'stbd', -27.30965, 153.20804),
    mark(3, 'stbd', -27.31917, 153.20148),
    mark(4, 'port', -27.32003, 153.20392),
    mark(5, 'stbd', -27.32867, 153.19485),
    mark(6, 'port', -27.32983, 153.19708),
    mark(7, 'stbd', -27.33329, 153.19169),
    mark(8, 'port', -27.33455, 153.19378),
    mark(9, 'stbd', -27.34404, 153.18419),
    mark(10, 'port', -27.34521, 153.18634),
    mark(11, 'stbd', -27.34922, 153.18061),
    mark(12, 'port', -27.3501, 153.18312),
    mark(13, 'stbd', -27.3541, 153.17722),
    mark(15, 'stbd', -27.35696, 153.17521),
    mark(19, 'stbd', -27.36122, 153.1712),
    mark(21, 'stbd', -27.3636, 153.17057),
];
const BC1 = { lat: -27.30965, lon: 153.20804 };
const BC21 = { lat: -27.3636, lon: 153.17057 };

describe('parseLateralMarks', () => {
    it('keeps port/starboard by CATLAM, parses key+seq from OBJNAM, drops the rest', () => {
        const feats = [
            { geometry: { type: 'Point', coordinates: [153.2, -27.32] }, properties: { CATLAM: 1, OBJNAM: 'BC4' } },
            {
                geometry: { type: 'Point', coordinates: [153.19, -27.33] },
                properties: { CATLAM: 2, OBJNAM: 'BC7, Coffee Pot West' },
            },
            { geometry: { type: 'Point', coordinates: [153.1, -27.3] }, properties: { CATLAM: 3, OBJNAM: '99' } }, // CATLAM 3 → dropped
            {
                geometry: { type: 'Point', coordinates: [153.1, -27.3] },
                properties: { CATLAM: 1, OBJNAM: 'no-number' },
            }, // no seq → dropped
        ];
        const marks = parseLateralMarks(feats);
        expect(marks).toHaveLength(2);
        expect(marks[0]).toMatchObject({ side: 'port', key: 'BC', seq: 4 });
        expect(marks[1]).toMatchObject({ side: 'stbd', key: 'BC', seq: 7 });
    });
});

describe('groupChannels', () => {
    it('splits two spatially-separate runs that reuse the same numbering', () => {
        // Two "NUM" runs ~15 km apart → two channels, not one.
        const near = [1, 2, 3].map((s) => mark(s, s % 2 ? 'stbd' : 'port', -27.4 + s * 0.001, 153.18, 'NUM'));
        const far = [1, 2, 3].map((s) => mark(s, s % 2 ? 'stbd' : 'port', -27.55 + s * 0.001, 153.18, 'NUM'));
        const channels = groupChannels([...near, ...far]);
        expect(channels).toHaveLength(2);
    });

    it('drops stray pairs (< 3 marks) — not a channel', () => {
        const stray = [mark(1, 'stbd', -27.4, 153.18, 'X'), mark(2, 'port', -27.401, 153.181, 'X')];
        expect(groupChannels(stray)).toHaveLength(0);
    });
});

describe('corridorCenterline', () => {
    it('runs down the middle of a straight channel (between the two mark lines)', () => {
        // Port line at lat -0.001, starboard at lat +0.001, lon increasing.
        const ch: LateralMark[] = [];
        for (let i = 0; i < 6; i++) {
            ch.push(mark(2 * i + 1, 'stbd', 0.001, i * 0.002));
            ch.push(mark(2 * i + 2, 'port', -0.001, i * 0.002 + 0.001));
        }
        const centre = corridorCenterline(ch);
        expect(centre.length).toBeGreaterThan(10);
        // Every centreline point sits ~on the midline (lat ≈ 0), never on a bank.
        for (const p of centre) expect(Math.abs(p.lat)).toBeLessThan(0.0004);
    });
});

/** Perp-ish: min distance from p to the nearest mark of a given side. */
function nearestSide(p: LatLon, marks: LateralMark[], side: 'port' | 'stbd'): number {
    return Math.min(...marks.filter((m) => m.side === side).map((m) => distM(p, m)));
}

describe('routeFairlead — real BC channel', () => {
    it('picks BC, threads a centreline between red and green, directed outbound from the handoff', () => {
        // Handoff near the inner (BC21) end → route should start there, exit at BC1.
        const r = routeFairlead(BC, { lat: -27.362, lon: 153.172 });
        expect(r).not.toBeNull();
        expect(r!.channel[0].key).toBe('BC');
        expect(r!.centerline.length).toBeGreaterThan(10);
        // Directed: first point near BC21, last near BC1.
        expect(distM(r!.centerline[0], BC21)).toBeLessThan(distM(r!.centerline[0], BC1));
        expect(distM(r!.centerline[r!.centerline.length - 1], BC1)).toBeLessThan(400);
        // Mid-channel: a sample point is roughly EQUIDISTANT from the nearest
        // red and the nearest green mark (between them, not hugging a bank),
        // and within the channel scale of both. (Proximity to a single buoy
        // isn't the test — marks are ~1 km apart along the channel and the
        // half-width alone is ~130 m; balance is the mid-channel property.)
        const mid = r!.centerline[Math.floor(r!.centerline.length / 2)];
        const dp = nearestSide(mid, BC, 'port');
        const ds = nearestSide(mid, BC, 'stbd');
        expect(dp).toBeLessThan(400);
        expect(ds).toBeLessThan(400);
        expect(Math.max(dp, ds) / Math.min(dp, ds)).toBeLessThan(2.3); // balanced
    });

    it('reverses direction when the handoff is at the other end', () => {
        const r = routeFairlead(BC, { lat: -27.31, lon: 153.207 }); // near BC1
        expect(r).not.toBeNull();
        expect(distM(r!.centerline[0], BC1)).toBeLessThan(distM(r!.centerline[0], BC21));
    });

    it('returns null when there is no marked channel near the handoff', () => {
        const r = routeFairlead(BC, { lat: -27.0, lon: 153.6 }, { maxHandoffM: 3000 }); // ~50 km away
        expect(r).toBeNull();
    });
});

describe('refineWithFairlead — splice into a route', () => {
    // A coarse grid route roughly transiting the BC channel (near BC1 → near BC21).
    const routeThroughBC: LatLon[] = [
        { lat: -27.3, lon: 153.215 },
        { lat: -27.305, lon: 153.21 },
        { lat: -27.33, lon: 153.19 },
        { lat: -27.365, lon: 153.168 },
        { lat: -27.37, lon: 153.16 },
    ];

    it('replaces the channel segment with the mark-following centreline', () => {
        const r = refineWithFairlead(routeThroughBC, BC);
        expect(r.replacedRange).not.toBeNull();
        expect(r.channelKey).toBe('BC');
        // The spliced route is longer (the dense centreline replaced 1 hop).
        expect(r.polyline.length).toBeGreaterThan(routeThroughBC.length);
        // A midpoint of the spliced segment is balanced between red and green.
        const mid = r.polyline[Math.floor(r.polyline.length / 2)];
        const dp = nearestSide(mid, BC, 'port');
        const ds = nearestSide(mid, BC, 'stbd');
        expect(Math.max(dp, ds) / Math.min(dp, ds)).toBeLessThan(2.4);
    });

    it('leaves a route that traverses no channel unchanged', () => {
        const away: LatLon[] = [
            { lat: -27.0, lon: 153.6 },
            { lat: -26.9, lon: 153.7 },
        ];
        const r = refineWithFairlead(away, BC);
        expect(r.replacedRange).toBeNull();
        expect(r.polyline).toBe(away);
    });

    it('aborts the splice (unchanged) if the centreline would cross land', () => {
        const r = refineWithFairlead(routeThroughBC, BC, () => true); // isLand: everything is land
        expect(r.replacedRange).toBeNull();
        expect(r.polyline).toBe(routeThroughBC);
    });
});
