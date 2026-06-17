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

describe('refineWithFairlead — splice with the three safety gates', () => {
    // A route that runs ALONG the BC channel (tracks its centreline).
    const routeAlongBC: LatLon[] = [
        { lat: -27.305, lon: 153.21 },
        { lat: -27.32, lon: 153.197 },
        { lat: -27.34, lon: 153.183 },
        { lat: -27.365, lon: 153.168 },
    ];

    it('legit along-channel transit in water → splices the centreline', () => {
        const r = refineWithFairlead(routeAlongBC, BC, () => false); // nothing is land
        expect(r.replacedRange).not.toBeNull();
        expect(r.channelKey).toBe('BC');
    });

    it('single-side mouth drift never reaches the route — no double-back spike (the field stepping)', () => {
        // BC starts starboard-only (seq 1 & 3 stbd; first port at seq 4), so
        // corridorCenterline's mouth extrapolation throws one sample out-and-
        // back across the channel entrance — a ~175° reversal the moving-
        // average smoother PINS rather than removes (it pins endpoints). This
        // is the live field "stepping": a double-back zigzag at the fairlead
        // splice. dropSpikes must strip it, so the spliced route carries no
        // near-reversal vertex.
        const r = refineWithFairlead(routeAlongBC, BC, () => false);
        expect(r.replacedRange).not.toBeNull();
        const M_PER_LAT = 110_540;
        let maxTurnDeg = 0;
        for (let i = 1; i < r.polyline.length - 1; i++) {
            const a = r.polyline[i - 1];
            const b = r.polyline[i];
            const c = r.polyline[i + 1];
            const mLon = 111_320 * Math.cos((b.lat * Math.PI) / 180);
            const ax = (b.lon - a.lon) * mLon;
            const ay = (b.lat - a.lat) * M_PER_LAT;
            const cx = (c.lon - b.lon) * mLon;
            const cy = (c.lat - b.lat) * M_PER_LAT;
            const la = Math.hypot(ax, ay);
            const lc = Math.hypot(cx, cy);
            if (la === 0 || lc === 0) continue;
            const cos = Math.max(-1, Math.min(1, (ax * cx + ay * cy) / (la * lc)));
            const deg = (Math.acos(cos) * 180) / Math.PI;
            if (deg > maxTurnDeg) maxTurnDeg = deg;
        }
        expect(maxTurnDeg).toBeLessThan(120);
    });

    it('GATE 1 land-validation: centreline would cross land → unchanged (the regression)', () => {
        // This is the failure that drew straight lines across the canal: the
        // spliced centreline crosses land. With a grid-based isLand it must
        // abort and keep the route, NOT fabricate water.
        const r = refineWithFairlead(routeAlongBC, BC, () => true); // everything is land
        expect(r.replacedRange).toBeNull();
        expect(r.polyline).toBe(routeAlongBC);
    });

    it('GATE 2 open-water scoping: transit before fromIdx → unchanged (stays out of the canal)', () => {
        // fromIdx past the whole (4-point) route → the channel transit starts
        // before the marina exit, so Fairlead must not touch it.
        const r = refineWithFairlead(routeAlongBC, BC, () => false, { fromIdx: 99 });
        expect(r.replacedRange).toBeNull();
    });

    it('GATE 3 strict transit: route only clips the channel ENDS → unchanged', () => {
        // Near BC1 and BC21 but a huge detour through the middle — only the two
        // end marks are near the line, so it is NOT a genuine transit.
        const clipsEnds: LatLon[] = [
            { lat: -27.305, lon: 153.21 }, // ~BC1
            { lat: -27.5, lon: 153.5 }, // miles away
            { lat: -27.365, lon: 153.168 }, // ~BC21
        ];
        const r = refineWithFairlead(clipsEnds, BC, () => false);
        expect(r.replacedRange).toBeNull();
    });

    it('no channel near the route → unchanged', () => {
        const away: LatLon[] = [
            { lat: -27.0, lon: 153.6 },
            { lat: -26.9, lon: 153.7 },
        ];
        const r = refineWithFairlead(away, BC, () => false);
        expect(r.replacedRange).toBeNull();
        expect(r.polyline).toBe(away);
    });
});

describe('refineWithFairlead — multi-channel (the Newport-end fix)', () => {
    // Two DISTINCT channels the one route transits: a short "AA" (Newport-
    // like exit) and a longer "BB" (Brisbane-like), separated by > the 1500 m
    // groupChannels proximity so they never merge. The route runs N→S through
    // both. Pre-fix the fairlead splices only the LONGEST (BB) and leaves AA
    // to the raw disc-router (the field stepping at the Newport end); post-fix
    // it must smooth BOTH.
    const AA: LateralMark[] = [
        mark(1, 'stbd', -27.25, 153.199, 'AA'),
        mark(2, 'port', -27.25, 153.201, 'AA'),
        mark(3, 'stbd', -27.248, 153.199, 'AA'),
        mark(4, 'port', -27.248, 153.201, 'AA'),
        mark(5, 'stbd', -27.246, 153.199, 'AA'),
        mark(6, 'port', -27.246, 153.201, 'AA'),
    ];
    const BB: LateralMark[] = [
        mark(1, 'stbd', -27.23, 153.199, 'BB'),
        mark(2, 'port', -27.23, 153.201, 'BB'),
        mark(3, 'stbd', -27.228, 153.199, 'BB'),
        mark(4, 'port', -27.228, 153.201, 'BB'),
        mark(5, 'stbd', -27.226, 153.199, 'BB'),
        mark(6, 'port', -27.226, 153.201, 'BB'),
        mark(7, 'stbd', -27.224, 153.199, 'BB'),
        mark(8, 'port', -27.224, 153.201, 'BB'),
        mark(9, 'stbd', -27.222, 153.199, 'BB'),
        mark(10, 'port', -27.222, 153.201, 'BB'),
    ];
    const through: LatLon[] = [
        { lat: -27.253, lon: 153.2 },
        { lat: -27.248, lon: 153.2 },
        { lat: -27.238, lon: 153.2 },
        { lat: -27.226, lon: 153.2 },
        { lat: -27.219, lon: 153.2 },
    ];

    it('splices EVERY transited channel, not just the longest', () => {
        const r = refineWithFairlead(through, [...AA, ...BB], () => false);
        expect(r.replacedRange).not.toBeNull();
        // BOTH channels must be in the smoothed route (pre-fix only "BB").
        expect(r.channelKey).toContain('AA');
        expect(r.channelKey).toContain('BB');
    });

    it('a single channel still reports just its key (no regression)', () => {
        const r = refineWithFairlead(through, BB, () => false);
        expect(r.replacedRange).not.toBeNull();
        expect(r.channelKey).toBe('BB');
    });
});
