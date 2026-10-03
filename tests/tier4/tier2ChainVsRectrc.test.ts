/**
 * Finding B (real-chart check, 2026-10-03): with the SE-QLD marker file
 * loaded, the Brisbane River's Hamilton reach bend left the 9.1 m dredged
 * channel and crossed ~250 m of 2 m water outside the chart's green beacon.
 * The tier-2 leg's lateral chain had snapped 2 km upstream, and a chain
 * claims the whole leg, so the RECTRC never shaped the bend; the bend's
 * green is the chart's alone (the regional file lacks it) and its gate was
 * in no chain. Synthetic geometry only (the repo is public).
 *
 * The river: reach 1 runs south down x = 0 to the bend B = (0, 0), reach 2
 * runs south-west from B. Water within 100 m of that centreline is 10 m
 * deep; the rest of the grid is CAUTION (2 m). The RECTRC is charted as two
 * 2-point pieces meeting at B, one of them digitised backwards.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NavGrid } from '../../services/inshoreRouterEngine';
import {
    joinedTracks,
    routeTier4,
    tier2RedLoad,
    tier2TieM,
    TIER2_HAZARD_RED_WEIGHT,
    type LoneGate,
    type Tier4Context,
} from '../../services/tier4/tier4Router';
import { isUnvouchedCell } from '../../services/engine/safetyAudit';
import { UNKNOWN_OPEN } from '../../services/engine/constants';
import { channelChainsFromMidpoints } from '../../services/engine/tierPipeline';
import { chartAreaIndexFor } from '../../services/routing/leadLandClip';
import { buildNavGrid } from '../../services/engine/navGrid';
import { fetchRegionalMarkers } from '../../services/InshoreRouter';
import { isRefusal, type BoundaryNode, type LatLon, type Leg } from '../../services/routing/legContract';
import type { TierSpan } from '../../services/routing/segmentRoute';

const M_PER_LAT = 110_540;
const LAT0 = -27.25;
const LON0 = 153.02;
const M_PER_LON = 111_320 * Math.cos((LAT0 * Math.PI) / 180);
const CELL_M = 50;

/** Local metres (x east, y north) → [lon, lat]. */
const at = (x: number, y: number): LatLon => [LON0 + x / M_PER_LON, LAT0 + y / M_PER_LAT];
const ll = (x: number, y: number): { lat: number; lon: number } => {
    const [lon, lat] = at(x, y);
    return { lat, lon };
};
const xy = ([lon, lat]: readonly [number, number]): [number, number] => [
    (lon - LON0) * M_PER_LON,
    (lat - LAT0) * M_PER_LAT,
];

const BEND: [number, number] = [0, 0];
const REACH2_END: [number, number] = [-1000, -1000];
const CHANNEL_HALF_M = 100;
const CAUTION = -1;

function distToSeg(p: [number, number], a: [number, number], b: [number, number]): number {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}
/** Metres from the channel's centreline. */
const offChannelM = (p: [number, number]): number =>
    Math.min(distToSeg(p, [0, 2600], BEND), distToSeg(p, BEND, [-1400, -1400]));

/** x −1600…800, y −1600…2600 at 50 m, each cell's depth from its centre. */
function gridOf(depthAt: (c: [number, number]) => number): NavGrid {
    const minX = -1600;
    const minY = -1600;
    const width = 48;
    const height = 84;
    const [minLon, minLat] = at(minX, minY);
    const cells = new Float32Array(width * height);
    for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++)
            cells[y * width + x] = depthAt([minX + (x + 0.5) * CELL_M, minY + (y + 0.5) * CELL_M]);
    return {
        width,
        height,
        minLat,
        minLon,
        dLat: CELL_M / M_PER_LAT,
        dLon: CELL_M / M_PER_LON,
        cells,
        preferred: new Uint8Array(width * height),
    };
}
/** The dredged channel deep, the rest CAUTION. */
const riverGrid = (): NavGrid => gridOf((c) => (offChannelM(c) <= CHANNEL_HALF_M ? 10 : CAUTION));

const node = (p: LatLon, kind: BoundaryNode['kind']): BoundaryNode => ({
    at: p,
    headingDeg: 0,
    kind,
    depthM: 10,
    snapped: true,
});
const span = (full: readonly LatLon[]): TierSpan => ({
    tier: 2,
    entry: node(full[0], 'mark-portal'),
    exit: node(full[full.length - 1], 'last-lead'),
    fromIdx: 0,
    toIdx: full.length - 1,
    caution: false,
});

/** The RECTRC: reach 1 as charted, reach 2 digitised from its far end back to the bend. */
const RECTRC = [{ pts: [ll(0, 2400), ll(...BEND)] }, { pts: [ll(...REACH2_END), ll(...BEND)] }];

const asLL = (line: readonly LatLon[]) => line.map(([lon, lat]) => ({ lat, lon }));
const nearestM = (line: readonly LatLon[], p: [number, number]): number => {
    let best = Infinity;
    for (let i = 0; i + 1 < line.length; i++) best = Math.min(best, distToSeg(p, xy(line[i]), xy(line[i + 1])));
    return best;
};
function legOf(r: ReturnType<typeof routeTier4>): Leg {
    expect(isRefusal(r)).toBe(false);
    return r as Leg;
}

describe('finding B — a lateral chain never beats a RECTRC leg that carries less red', () => {
    // The A* slice: down reach 1, then across the inside of the bend over 2 m
    // water (180–260 m off the centreline), back into reach 2.
    const slice: LatLon[] = [
        at(0, 2400),
        at(10, 1600),
        at(10, 1200),
        at(5, 800),
        at(-180, 150),
        at(-260, 0),
        at(-500, -420),
        at(...REACH2_END),
    ];
    // The regional file's chain: three gates down reach 1, none at the bend.
    const reach1Chain = { pts: [ll(0, 1600), ll(0, 1200), ll(0, 800)] };

    it('reproduces the bend: the chain alone keeps the A* slice across the shallows', () => {
        const grid = riverGrid();
        const leg = legOf(
            routeTier4(span(slice), slice, { grid, recommendedTracks: [], marks: [], channelChains: [reach1Chain] }),
        );
        expect(leg.provenance).toBe('tier2:chain×1');
        expect(tier2RedLoad(grid, asLL(leg.polyline)).redM).toBeGreaterThan(300);
        expect(nearestM(leg.polyline, BEND)).toBeGreaterThan(CHANNEL_HALF_M);
    });

    it('rides the RECTRC through the bend where the chain does not reach, keeping the chain', () => {
        const grid = riverGrid();
        const leg = legOf(
            routeTier4(span(slice), slice, {
                grid,
                recommendedTracks: RECTRC,
                marks: [],
                channelChains: [reach1Chain],
            }),
        );
        expect(leg.provenance).toMatch(/^tier2:chain×1\+rectrc×\d+$/);
        expect(tier2RedLoad(grid, asLL(leg.polyline)).redM).toBe(0);
        // Through the bend on the centreline, and still through every chain gate.
        expect(nearestM(leg.polyline, BEND)).toBeLessThan(5);
        for (const g of reach1Chain.pts) expect(nearestM(leg.polyline, xy([g.lon, g.lat]))).toBeLessThan(1);
        for (const p of leg.polyline) expect(offChannelM(xy(p))).toBeLessThanOrEqual(CHANNEL_HALF_M);
    });

    it('drops a chain that leaves the channel for the RECTRC leg, which carries less red', () => {
        // A mis-paired chain 150 m east of the centreline: over the shallows.
        const offChain = { pts: [ll(150, 1600), ll(150, 1200), ll(150, 800), ll(150, 400)] };
        const straight: LatLon[] = [at(0, 2400), at(120, 1600), at(120, 1200), at(120, 800), at(60, 300), at(...BEND)];
        const grid = riverGrid();
        const chainOnly = legOf(
            routeTier4(span(straight), straight, {
                grid,
                recommendedTracks: [],
                marks: [],
                channelChains: [offChain],
            }),
        );
        expect(chainOnly.provenance).toMatch(/^tier2:chain×/);
        const chainRed = tier2RedLoad(grid, asLL(chainOnly.polyline)).redM;
        expect(chainRed).toBeGreaterThan(500);

        const leg = legOf(
            routeTier4(span(straight), straight, {
                grid,
                recommendedTracks: RECTRC,
                marks: [],
                channelChains: [offChain],
            }),
        );
        expect(leg.provenance).toMatch(/^tier2:rectrc×\d+$/);
        expect(tier2RedLoad(grid, asLL(leg.polyline)).redM).toBeLessThan(chainRed);
        expect(tier2RedLoad(grid, asLL(leg.polyline)).redM).toBe(0);
    });

    it('a tie keeps the chain: a leg the chain already holds in the channel is unchanged', () => {
        const straight: LatLon[] = [at(0, 2400), at(10, 1600), at(10, 1200), at(5, 800), at(...BEND)];
        const grid = riverGrid();
        const without = legOf(
            routeTier4(span(straight), straight, {
                grid,
                recommendedTracks: [],
                marks: [],
                channelChains: [reach1Chain],
            }),
        );
        const withTrack = legOf(
            routeTier4(span(straight), straight, {
                grid,
                recommendedTracks: RECTRC,
                marks: [],
                channelChains: [reach1Chain],
            }),
        );
        expect(withTrack.provenance).toMatch(/^tier2:chain×\d+$/);
        expect(withTrack.provenance).toBe(without.provenance);
        expect(withTrack.polyline).toEqual(without.polyline);
    });

    it('weighs charted water below draft + safety the grid cells miss', () => {
        // One 50 m cell of deep water with a 2 m strip charted across it: the
        // cell centre reads deep, the line crosses 30 m charted at 2 m.
        const grid = riverGrid();
        const band = (x0: number, x1: number, y0: number, y1: number, drval1: number) => ({
            type: 'Feature' as const,
            properties: { acronym: 'DEPARE', DRVAL1: drval1, DRVAL2: drval1 + 3 },
            geometry: {
                type: 'Polygon' as const,
                coordinates: [[at(x0, y0), at(x1, y0), at(x1, y1), at(x0, y1), at(x0, y0)]],
            },
        });
        const bands = chartAreaIndexFor({
            DEPARE: {
                features: [band(-60, 60, 1000, 1030, 2), band(-60, 60, 1030, 1400, 10), band(-60, 60, 600, 1000, 10)],
            },
        }).depth;
        const line = [ll(0, 700), ll(0, 1300)];
        expect(tier2RedLoad(grid, line).redM).toBe(0);
        const red = tier2RedLoad(grid, line, { chart: { bands, floorM: 2.9 } }).redM;
        expect(red).toBeGreaterThan(25);
        expect(red).toBeLessThan(35);
        expect(tier2RedLoad(grid, line, { chart: { bands, floorM: 1.5 } }).redM).toBe(0);
    });
});

describe('finding B — the bend gate the regional file lacks (merge, not replace)', () => {
    afterEach(() => vi.restoreAllMocks());

    // The bend's gate: the chart's green on the outside, its red on the inside, 200 m apart.
    const bendGate: LoneGate = { ...ll(...BEND), halfWidthM: 100 };

    it('threads a lone gate a chain-snapped leg passes outside, with no RECTRC charted', () => {
        // The chain ends 400 m above the bend; the A* slice then chords the
        // inside of the bend, 240 m from the gate's middle.
        const slice: LatLon[] = [at(0, 2400), at(10, 1600), at(10, 1200), at(5, 400), at(-1200, -1200)];
        const chain = { pts: [ll(0, 1600), ll(0, 1200), ll(0, 400)] };
        const grid = riverGrid();
        const ctx: Tier4Context = { grid, recommendedTracks: [], marks: [], channelChains: [chain] };
        const without = legOf(routeTier4(span(slice), slice, ctx));
        expect(without.provenance).toBe('tier2:chain×1');
        expect(nearestM(without.polyline, BEND)).toBeGreaterThan(200);
        expect(tier2RedLoad(grid, asLL(without.polyline)).redM).toBeGreaterThan(200);

        const leg = legOf(routeTier4(span(slice), slice, { ...ctx, loneGates: [bendGate] }));
        expect(leg.provenance).toBe('tier2:chain×1+lonegate×1');
        expect(nearestM(leg.polyline, BEND)).toBeLessThan(1);
        expect(tier2RedLoad(grid, asLL(leg.polyline)).redM).toBe(0);
    });

    it('leaves a lone gate out of reach, or one the leg already threads, alone', () => {
        const grid = riverGrid();
        const chain = { pts: [ll(0, 1600), ll(0, 1200), ll(0, 400)] };
        const slice: LatLon[] = [at(0, 2400), at(10, 1600), at(10, 1200), at(5, 400), at(-1200, -1200)];
        const ctx: Tier4Context = { grid, recommendedTracks: [], marks: [], channelChains: [chain] };
        // A gate 600 m off in a parallel channel.
        const far = legOf(routeTier4(span(slice), slice, { ...ctx, loneGates: [{ ...ll(600, 0), halfWidthM: 100 }] }));
        expect(far.provenance).toBe('tier2:chain×1');
        // A gate the leg already passes within its middle half.
        const onLine = legOf(
            routeTier4(span(slice), slice, { ...ctx, loneGates: [{ ...ll(0, 1000), halfWidthM: 100 }] }),
        );
        expect(onLine.provenance).toBe('tier2:chain×1');
    });

    it('keeps a lone gate no chain reaches out of every chain, and attaches one near a chain end', () => {
        const mid = (x: number, y: number, chainId: number, chainOrder: number, w = 200) => ({
            properties: {
                _class: 'channel_midpoint',
                _chainId: chainId,
                _chainOrder: chainOrder,
                _pairDistanceM: w,
            },
            geometry: { type: 'Point', coordinates: at(x, y) },
        });
        const route: LatLon[] = [at(0, 2400), at(0, 400), at(-800, -800)];
        const { channelChains, loneGates } = channelChainsFromMidpoints(
            [
                mid(0, 1600, 1, 0),
                mid(0, 1200, 1, 1),
                mid(0, 800, 1, 2),
                mid(0, -200, 2, 0, 210), // 1 km from the chain's end: lone
                mid(0, 2300, 3, 0, 180), // 700 m from its start: attached
            ],
            route,
        );
        expect(channelChains).toHaveLength(1);
        expect(channelChains[0].pts).toHaveLength(4);
        expect(loneGates).toHaveLength(1);
        expect(xy([loneGates[0].lon, loneGates[0].lat]).map(Math.round)).toEqual([0, -200]);
        expect(loneGates[0].halfWidthM).toBe(105);
    });

    it("pairs the chart's own bend gate alongside the regional file's chain", async () => {
        // The regional file: two pairs on reach 1 (port west, starboard east).
        const pt = (x: number, y: number, cls: string) => ({
            type: 'Feature',
            properties: { _class: cls },
            geometry: { type: 'Point', coordinates: at(x, y) },
        });
        const file = {
            type: 'FeatureCollection',
            features: [
                pt(-100, 1600, 'port'),
                pt(100, 1600, 'starboard'),
                pt(-100, 1200, 'port'),
                pt(100, 1200, 'starboard'),
            ],
        };
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response(JSON.stringify(file), { status: 200, headers: { 'content-type': 'application/json' } }),
        );
        // The chart's marks: the bend's red (inside) and green (outside), which
        // the file lacks, and a copy of one of the file's buoys (deduped).
        const [rLon, rLat] = at(-70, 70);
        const [gLon, gLat] = at(70, -70);
        const [dLon, dLat] = at(-95, 1605);
        const res = await fetchRegionalMarkers(
            'https://regions.test/finding-b/nav_markers.geojson',
            [],
            [],
            [],
            [
                { lat: rLat, lon: rLon, kind: 'port' },
                { lat: gLat, lon: gLon, kind: 'starboard' },
                { lat: dLat, lon: dLon, kind: 'port' },
            ],
        );
        const mids = (res.midpoints as { properties: { _chainId: number }; geometry: { coordinates: LatLon } }[]).map(
            (m) => ({ chain: m.properties._chainId, at: xy(m.geometry.coordinates).map(Math.round) }),
        );
        expect(mids).toEqual(
            expect.arrayContaining([
                { chain: expect.any(Number), at: [0, 1600] },
                { chain: expect.any(Number), at: [0, 1200] },
                { chain: expect.any(Number), at: [0, 0] },
            ]),
        );
        expect(mids).toHaveLength(3);
        // The bend's gate is its own one-gate cluster, so tier-2 sees it as lone.
        const route: LatLon[] = [at(0, 2400), at(5, 400), at(-800, -800)];
        const { loneGates } = channelChainsFromMidpoints(res.midpoints as never, route);
        expect(loneGates.map((g) => xy([g.lon, g.lat]).map(Math.round))).toEqual([[0, 0]]);
    });
});

describe('finding B fix-up — what the arbitration weighs (review, 2026-10-03)', () => {
    // The first test's A* slice: down reach 1, then across the inside of the
    // bend over 2 m water, back into reach 2. The chain stops at y = 800.
    const slice: LatLon[] = [
        at(0, 2400),
        at(10, 1600),
        at(10, 1200),
        at(5, 800),
        at(-180, 150),
        at(-260, 0),
        at(-500, -420),
        at(...REACH2_END),
    ];
    const reach1Chain = { pts: [ll(0, 1600), ll(0, 1200), ll(0, 800)] };
    const maxTurnDeg = (line: readonly LatLon[]): number => {
        let worst = 0;
        for (let i = 1; i + 1 < line.length; i++) {
            const [ax, ay] = xy(line[i - 1]);
            const [bx, by] = xy(line[i]);
            const [cx, cy] = xy(line[i + 1]);
            const u = [bx - ax, by - ay];
            const v = [cx - bx, cy - by];
            const cos = (u[0] * v[0] + u[1] * v[1]) / (Math.hypot(u[0], u[1]) * Math.hypot(v[0], v[1]));
            worst = Math.max(worst, (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI);
        }
        return worst;
    };

    /** The river grid with every cell within `r` m of the bend blocked (not land). */
    const bendBlocked = (r: number): { grid: NavGrid; disc: number[] } => {
        const grid = riverGrid();
        grid.landBlocked = new Uint8Array(grid.width * grid.height);
        const disc: number[] = [];
        for (let y = 0; y < grid.height; y++)
            for (let x = 0; x < grid.width; x++) {
                const c: [number, number] = [-1600 + (x + 0.5) * CELL_M, -1600 + (y + 0.5) * CELL_M];
                if (Math.hypot(c[0], c[1]) > r) continue;
                grid.cells[y * grid.width + x] = NaN;
                disc.push(y * grid.width + x);
            }
        return { grid, disc };
    };
    const rideThroughBend = [ll(0, 800), ll(...BEND), ll(...REACH2_END)];

    it('never swaps the chain for a RECTRC leg over water no tide clears', () => {
        // The RECTRC crosses 200 m no tide clears at the bend (blocked, not
        // land); the chain's slice chords the inside over 2 m a tide clears.
        // Fewer red metres would pick the RECTRC; the engine would then clip
        // or refuse the route there.
        const { grid, disc } = bendBlocked(100);
        grid.noTideClears = new Uint8Array(grid.width * grid.height);
        for (const i of disc) grid.noTideClears[i] = 1;
        const through = tier2RedLoad(grid, rideThroughBend);
        expect(through.noTideM).toBeGreaterThan(150);
        expect(through.noTideM).toBe(through.redM);

        const ctx: Tier4Context = { grid, recommendedTracks: RECTRC, marks: [], channelChains: [reach1Chain] };
        const leg = legOf(routeTier4(span(slice), slice, ctx));
        expect(leg.provenance).toBe('tier2:chain×1');
        const load = tier2RedLoad(grid, asLL(leg.polyline));
        expect(load.noTideM).toBe(0);
        expect(load.redM).toBeGreaterThan(300);
    });

    it("still rides the RECTRC through a hazard's keep-out (red, not a veto)", () => {
        // The real Hamilton reach (2026-10-03): below the bend the RECTRC
        // crosses a mark's avoidance disc and an obstruction's buffer. A
        // keep-out is red like 2 m water, never a veto on the charted track,
        // so the ride with less red still wins.
        const { grid } = bendBlocked(100);
        const through = tier2RedLoad(grid, rideThroughBend);
        expect(through.noTideM).toBe(0);
        expect(through.redM).toBeGreaterThan(150);
        const leg = legOf(
            routeTier4(span(slice), slice, {
                grid,
                recommendedTracks: RECTRC,
                marks: [],
                channelChains: [reach1Chain],
            }),
        );
        expect(leg.provenance).toMatch(/^tier2:chain×1\+rectrc×\d+$/);
        expect(nearestM(leg.polyline, BEND)).toBeLessThan(5);
    });

    it('weighs uncharted water as red under the strict policy', () => {
        // The dredged channel round the bend is uncharted (no evidence): the
        // engine draws it red under the strict policy. Riding the RECTRC
        // round the bend crosses more of it than the chain's slice crosses
        // 2 m water, so the chain keeps the leg.
        const grid = gridOf((c) =>
            offChannelM(c) > CHANNEL_HALF_M ? CAUTION : Math.hypot(c[0], c[1]) <= 900 ? UNKNOWN_OPEN : 10,
        );
        grid.unvouched = new Uint8Array(grid.width * grid.height);
        for (let i = 0; i < grid.cells.length; i++) if (grid.cells[i] === UNKNOWN_OPEN) grid.unvouched[i] = 1;
        const isUnvouched = (idx: number): boolean => isUnvouchedCell(grid, idx);
        const rideLine = [ll(0, 800), ll(...BEND), ll(...REACH2_END)];
        expect(tier2RedLoad(grid, rideLine).redM).toBe(0);
        const rideRed = tier2RedLoad(grid, rideLine, { isUnvouched }).redM;
        expect(rideRed).toBeGreaterThan(1500);

        const ctx: Tier4Context = {
            grid,
            recommendedTracks: RECTRC,
            marks: [],
            channelChains: [reach1Chain],
            isUnvouched,
        };
        const leg = legOf(routeTier4(span(slice), slice, ctx));
        expect(leg.provenance).toBe('tier2:chain×1');
        const trackLeg = [ll(0, 2400), ll(...BEND), ll(...REACH2_END)];
        expect(tier2RedLoad(grid, asLL(leg.polyline), { isUnvouched }).redM).toBeLessThan(
            tier2RedLoad(grid, trackLeg, { isUnvouched }).redM - tier2TieM(grid),
        );
        // Permissive (no predicate): that water is not red, and the RECTRC wins.
        const permissive = legOf(routeTier4(span(slice), slice, { ...ctx, isUnvouched: undefined }));
        expect(permissive.provenance).toMatch(/rectrc×/);
    });

    it("keeps the chain's gate-centred leg over one cell of 2 m on its line", () => {
        // A straight dredged channel down x = 0; one 50 m CAUTION cell on the
        // centreline at y = 1000; the RECTRC charted 60 m to the east, still
        // inside the channel. One cell's defect is a tie, so the chain keeps
        // every gate centred.
        const grid = gridOf((c) =>
            Math.abs(c[0]) > CHANNEL_HALF_M
                ? CAUTION
                : Math.abs(c[1] - 1025) < 25 && Math.abs(c[0]) < 50
                  ? CAUTION
                  : 10,
        );
        expect(tier2TieM(grid)).toBeGreaterThan(70);
        const chain = { pts: [ll(0, 1600), ll(0, 1200), ll(0, 800), ll(0, 400), ll(0, 0)] };
        const straight: LatLon[] = [
            at(0, 2400),
            at(10, 1600),
            at(-5, 1200),
            at(10, 800),
            at(5, 400),
            at(5, 0),
            at(0, -800),
        ];
        const track = [{ pts: [ll(60, 2600), ll(60, -1000)] }];
        const ctx: Tier4Context = { grid, recommendedTracks: track, marks: [], channelChains: [chain] };
        const leg = legOf(routeTier4(span(straight), straight, ctx));
        expect(leg.provenance).toMatch(/^tier2:chain×\d+$/);
        for (const g of chain.pts) expect(nearestM(leg.polyline, xy([g.lon, g.lat]))).toBeLessThan(1);
        const red = tier2RedLoad(grid, asLL(leg.polyline)).redM;
        expect(red).toBeGreaterThan(40);
        expect(red).toBeLessThan(tier2TieM(grid));
    });

    it('does not thread a lone gate inside a sharp chain corner', () => {
        // All deep water; an L-shaped chain (east along y = 0, then south);
        // a lone gate inside the corner. Threading it would turn the leg 124°
        // at the corner, past the de-spike limit.
        const grid = gridOf(() => 10);
        const chain = {
            pts: [ll(-1200, 0), ll(-800, 0), ll(-400, 0), ll(0, 0), ll(0, -400), ll(0, -800), ll(0, -1200)],
        };
        const el: LatLon[] = [
            at(-1400, 5),
            at(-1200, 10),
            at(-800, 10),
            at(-400, 10),
            at(10, -10),
            at(10, -400),
            at(10, -800),
            at(5, -1200),
            at(0, -1400),
        ];
        const ctx: Tier4Context = { grid, recommendedTracks: [], marks: [], channelChains: [chain] };
        const without = legOf(routeTier4(span(el), el, ctx));
        expect(without.provenance).toBe('tier2:chain×1');
        const leg = legOf(routeTier4(span(el), el, { ...ctx, loneGates: [{ ...ll(-100, -150), halfWidthM: 100 }] }));
        expect(leg.provenance).toBe('tier2:chain×1');
        expect(maxTurnDeg(leg.polyline)).toBeLessThanOrEqual(120);
    });

    it("threads a lone gate only where the leg crosses the gate's line", () => {
        // All deep water; a chain straight down x = 0. A side channel's
        // entrance gate 180 m east: its marks lie north–south (axis 180°),
        // along the leg, so reaching it is a detour and back. The same gate
        // with its marks east–west is crossed, and threaded.
        const grid = gridOf(() => 10);
        const chain = { pts: [ll(0, 2000), ll(0, 1600), ll(0, 1200), ll(0, 800), ll(0, 400)] };
        const down: LatLon[] = [
            at(0, 2400),
            at(10, 2000),
            at(10, 1600),
            at(10, 1200),
            at(10, 800),
            at(10, 400),
            at(0, 0),
        ];
        const ctx: Tier4Context = { grid, recommendedTracks: [], marks: [], channelChains: [chain] };
        const side: LoneGate = { ...ll(180, 1000), halfWidthM: 60, axisDeg: 180 };
        expect(legOf(routeTier4(span(down), down, { ...ctx, loneGates: [side] })).provenance).toBe('tier2:chain×1');
        const across = legOf(routeTier4(span(down), down, { ...ctx, loneGates: [{ ...side, axisDeg: 90 }] }));
        expect(across.provenance).toBe('tier2:chain×1+lonegate×1');
        expect(nearestM(across.polyline, [180, 1000])).toBeLessThan(1);
    });
});

describe('finding B fix-up — lone gates from the pairing', () => {
    afterEach(() => vi.restoreAllMocks());

    const fileOf = (features: { x: number; y: number; cls: string }[]) => ({
        type: 'FeatureCollection',
        features: features.map(({ x, y, cls }) => ({
            type: 'Feature',
            properties: { _class: cls },
            geometry: { type: 'Point', coordinates: at(x, y) },
        })),
    });
    const mockFile = (file: unknown) =>
        vi
            .spyOn(globalThis, 'fetch')
            .mockResolvedValue(
                new Response(JSON.stringify(file), { status: 200, headers: { 'content-type': 'application/json' } }),
            );
    const route: LatLon[] = [at(0, 2400), at(5, 400), at(-800, -800)];

    it('is never a phantom gate: one regional and one chart mark 40 m apart', async () => {
        // The regional file calls a buoy port; the chart calls its copy,
        // 40 m east, starboard. They pair, but that one buoy is no gate.
        mockFile(fileOf([{ x: 0, y: 0, cls: 'port' }]));
        const [sLon, sLat] = at(40, 0);
        const res = await fetchRegionalMarkers(
            'https://regions.test/fixup-b/phantom.geojson',
            [],
            [],
            [],
            [{ lat: sLat, lon: sLon, kind: 'starboard' }],
        );
        const mids = res.midpoints as { properties: { _mixedSource?: boolean } }[];
        expect(mids).toHaveLength(1);
        expect(mids[0].properties._mixedSource).toBe(true);
        expect(channelChainsFromMidpoints(res.midpoints as never, route).loneGates).toEqual([]);
    });

    it("keeps the chart's own two-mark gate lone, with its port→starboard axis", async () => {
        mockFile(fileOf([]));
        const [rLon, rLat] = at(-70, 70);
        const [gLon, gLat] = at(70, -70);
        const res = await fetchRegionalMarkers(
            'https://regions.test/fixup-b/chart-gate.geojson',
            [],
            [],
            [],
            [
                { lat: rLat, lon: rLon, kind: 'port' },
                { lat: gLat, lon: gLon, kind: 'starboard' },
            ],
        );
        const mids = res.midpoints as { properties: { _mixedSource?: boolean; _axisDeg?: number } }[];
        expect(mids).toHaveLength(1);
        expect(mids[0].properties._mixedSource).toBe(false);
        const { loneGates } = channelChainsFromMidpoints(res.midpoints as never, route);
        expect(loneGates).toHaveLength(1);
        expect(loneGates[0].axisDeg).toBeGreaterThan(134);
        expect(loneGates[0].axisDeg).toBeLessThan(136);
    });
});

describe('joinedTracks', () => {
    it('joins RECTRC pieces that meet, reversing a piece digitised backwards', () => {
        const out = joinedTracks(RECTRC);
        expect(out).toHaveLength(3);
        expect(out[0].pts.map((p) => xy([p.lon, p.lat]).map(Math.round))).toEqual([
            [0, 2400],
            [0, 0],
            [-1000, -1000],
        ]);
        expect(out.slice(1)).toEqual(RECTRC);
    });

    it('does not join across a turn sharper than 60°, nor ends further than 10 m apart', () => {
        const sharp = [{ pts: [ll(0, 1000), ll(0, 0)] }, { pts: [ll(0, 0), ll(-1000, -200)] }];
        expect(joinedTracks(sharp)).toEqual(sharp);
        const gap = [{ pts: [ll(0, 1000), ll(0, 0)] }, { pts: [ll(0, -20), ll(0, -1000)] }];
        expect(joinedTracks(gap)).toEqual(gap);
    });
});

// Round-3 fix-up (2026-10-03): tier2RedLoad weighed every red metre the same,
// and under the strict policy counted water no chart gives a depth for as 0 m
// wherever a lateral chain's discs vouched for it (isUnvouchedCell: a mark's
// preferred cell is vouched) — so a chain over uncharted water tied a charted
// lead and kept the leg.
describe('round-3 fix-up — what a red metre weighs (2026-10-03)', () => {
    /** Cell index of a point (x, y) in local metres. */
    const cellOf = (grid: NavGrid, x: number, y: number): number =>
        Math.floor((y + 1600) / CELL_M) * grid.width + Math.floor((x + 1600) / CELL_M);

    it("a charted hazard's keep-out weighs TIER2_HAZARD_RED_WEIGHT; a mark's disc and 2 m water once", () => {
        const grid = riverGrid();
        grid.obstnBlocked = new Uint8Array(grid.width * grid.height);
        grid.markDiscBlocked = new Uint8Array(grid.width * grid.height);
        // Down reach 1 at x = 10: an obstruction's keep-out over y 1000–1200,
        // a mark's disc over y 1400–1600 (both blocked cells).
        for (let y = 1025; y < 1200; y += CELL_M) {
            const i = cellOf(grid, 10, y);
            grid.cells[i] = NaN;
            grid.obstnBlocked[i] = 1;
        }
        for (let y = 1425; y < 1600; y += CELL_M) {
            const i = cellOf(grid, 10, y);
            grid.cells[i] = NaN;
            grid.obstnBlocked[i] = 1;
            grid.markDiscBlocked[i] = 1;
        }
        const load = tier2RedLoad(grid, [ll(10, 900), ll(10, 1700)]);
        expect(TIER2_HAZARD_RED_WEIGHT).toBe(2);
        expect(load.hazardM).toBeGreaterThan(195);
        expect(load.hazardM).toBeLessThan(205);
        // 200 m × 2 (the keep-out) + 200 m (the disc).
        expect(load.redM).toBeGreaterThan(590);
        expect(load.redM).toBeLessThan(610);
        expect(load.noTideM).toBe(0);
        // 2 m water (CAUTION) weighs once.
        const shallow = tier2RedLoad(grid, [ll(300, 900), ll(300, 1100)]);
        expect(shallow.hazardM).toBe(0);
        expect(shallow.redM).toBeCloseTo(200, 0);
    });

    // Fix-up review (2026-10-03): a hazard charted deep enough for the keel
    // (VALSOU >= draft + UKC) is buffered like any other, but the final audit
    // exempts it, so the engine never draws its keep-out red for it — weighing
    // it double let a RECTRC ride past a deep wreck lose to a chain over
    // charted-shallow water.
    it('a keep-out only a hazard charted deep enough closed weighs once, not double', () => {
        const grid = riverGrid();
        grid.obstnBlocked = new Uint8Array(grid.width * grid.height);
        grid.deepHazardOnly = new Uint8Array(grid.width * grid.height);
        for (let y = 1025; y < 1200; y += CELL_M) {
            const i = cellOf(grid, 10, y);
            grid.cells[i] = NaN;
            grid.obstnBlocked[i] = 1;
            grid.deepHazardOnly[i] = 1;
        }
        const load = tier2RedLoad(grid, [ll(10, 900), ll(10, 1300)]);
        expect(load.hazardM).toBe(0);
        expect(load.redM).toBeGreaterThan(195);
        expect(load.redM).toBeLessThan(205);
    });

    it('navGrid marks the cells only a deep-charted hazard closed (deepHazardOnly)', () => {
        const point = (x: number, y: number, valsou?: number) => ({
            type: 'Feature' as const,
            properties: { acronym: 'WRECKS', ...(valsou === undefined ? {} : { VALSOU: valsou }) },
            geometry: { type: 'Point' as const, coordinates: at(x, y) },
        });
        const [x0, y0, x1, y1] = [-600, -600, 600, 600];
        const deep = {
            type: 'Feature' as const,
            properties: { acronym: 'DEPARE', DRVAL1: 10, DRVAL2: 15 },
            geometry: {
                type: 'Polygon' as const,
                coordinates: [[at(x0, y0), at(x1, y0), at(x1, y1), at(x0, y1), at(x0, y0)]],
            },
        };
        const layers = (...wrecks: ReturnType<typeof point>[]) =>
            ({
                DEPARE: { type: 'FeatureCollection', features: [deep] },
                WRECKS: { type: 'FeatureCollection', features: wrecks },
            }) as never;
        const bbox = [...at(x0, y0), ...at(x1, y1)] as [number, number, number, number];
        const build = (...wrecks: ReturnType<typeof point>[]) =>
            buildNavGrid(layers(...wrecks), bbox, 50, 2.4, 0.5, 30);
        const count = (m: Uint8Array | undefined) => (m ? m.reduce((n, v) => n + v, 0) : 0);
        // A wreck sounded 10 m: every cell it closes is deep-only.
        const alone = build(point(0, 0, 10));
        expect(count(alone.obstnBlocked)).toBeGreaterThan(0);
        expect(count(alone.deepHazardOnly)).toBe(count(alone.obstnBlocked));
        // A wreck sounded 1 m, or with no sounding: none is.
        expect(build(point(0, 0, 1)).deepHazardOnly).toBeUndefined();
        expect(build(point(0, 0)).deepHazardOnly).toBeUndefined();
        // A shallow wreck beside the deep one, either order: the cells it
        // also closes are not deep-only, the deep one's others still are.
        for (const both of [build(point(0, 0, 10), point(40, 0, 1)), build(point(40, 0, 1), point(0, 0, 10))]) {
            const shallowOnly = build(point(40, 0, 1));
            let shared = 0;
            for (let i = 0; i < both.cells.length; i++) {
                if (shallowOnly.obstnBlocked![i] === 1) expect(both.deepHazardOnly?.[i] ?? 0).toBe(0);
                else if (alone.obstnBlocked![i] === 1) {
                    expect(both.deepHazardOnly![i]).toBe(1);
                    shared++;
                }
            }
            expect(shared).toBeGreaterThan(0);
        }
    });

    it('a chain over water no chart gives a depth for never ties a charted lead (strict policy)', () => {
        // The inside of the bend, where the chain's A* slice cuts across, is
        // water a mark vouches for (preferred) but no chart gives a depth for
        // (UNKNOWN_OPEN, no evidence); the RECTRC round the bend is charted
        // 10 m. isUnvouchedCell calls the slice's water vouched (a mark's
        // preferred cell), so before the fix-up both legs carried 0 m of red
        // and the tie kept the chain.
        const inside = (c: [number, number]): boolean =>
            offChannelM(c) > CHANNEL_HALF_M && c[0] < 0 && c[1] > -600 && c[1] < 900;
        const grid = gridOf((c) => (offChannelM(c) <= CHANNEL_HALF_M ? 10 : inside(c) ? UNKNOWN_OPEN : CAUTION));
        grid.unvouched = new Uint8Array(grid.width * grid.height);
        for (let y = 0; y < grid.height; y++)
            for (let x = 0; x < grid.width; x++) {
                const i = y * grid.width + x;
                if (grid.cells[i] !== UNKNOWN_OPEN) continue;
                grid.unvouched[i] = 1;
                grid.preferred[i] = 1;
            }
        const isUnvouched = (idx: number): boolean => isUnvouchedCell(grid, idx);
        const slice: LatLon[] = [
            at(0, 2400),
            at(10, 1600),
            at(10, 1200),
            at(5, 800),
            at(-180, 150),
            at(-260, 0),
            at(-500, -420),
            at(...REACH2_END),
        ];
        // The precondition: the engine's own rule reads none of it red.
        expect(tier2RedLoad(grid, asLL(slice), { isUnvouched }).redM).toBeLessThan(tier2TieM(grid));
        const strict = tier2RedLoad(grid, asLL(slice), { isUnvouched, strictUncharted: true });
        expect(strict.redM).toBeGreaterThan(400);
        const ctx: Tier4Context = {
            grid,
            recommendedTracks: RECTRC,
            marks: [],
            channelChains: [{ pts: [ll(0, 1600), ll(0, 1200), ll(0, 800)] }],
            isUnvouched,
            strictUncharted: true,
        };
        const leg = legOf(routeTier4(span(slice), slice, ctx));
        expect(leg.provenance).toMatch(/rectrc×/);
        expect(nearestM(leg.polyline, BEND)).toBeLessThan(5);
        // Permissive (no strict flag): the tie keeps the chain, as before.
        const permissive = legOf(
            routeTier4(span(slice), slice, { ...ctx, isUnvouched: undefined, strictUncharted: undefined }),
        );
        expect(permissive.provenance).toBe('tier2:chain×1');
    });

    it('with chart bands: a stretch no band covers is red under the strict policy, outside the grid too', () => {
        const grid = gridOf(() => 10);
        // One 10–15 m band over x −100…100 (the channel down reach 1).
        const chart = {
            bands: chartAreaIndexFor({
                DEPARE: {
                    type: 'FeatureCollection',
                    features: [
                        {
                            type: 'Feature',
                            properties: { acronym: 'DEPARE', DRVAL1: 10, DRVAL2: 15 },
                            geometry: {
                                type: 'Polygon',
                                coordinates: [[at(-100, 0), at(100, 0), at(100, 2600), at(-100, 2600), at(-100, 0)]],
                            },
                        },
                    ],
                },
            } as never).depth,
            floorM: 2.9,
        };
        const line = [ll(0, 1000), ll(400, 1000)];
        expect(tier2RedLoad(grid, line, { chart }).redM).toBe(0);
        const strict = tier2RedLoad(grid, line, { chart, strictUncharted: true }).redM;
        expect(strict).toBeGreaterThan(295);
        expect(strict).toBeLessThan(305);
        // Off the grid's east edge (x > 800) with no bands at all: red.
        expect(tier2RedLoad(grid, [ll(700, 1000), ll(1000, 1000)], { strictUncharted: true }).redM).toBeGreaterThan(
            195,
        );
        expect(tier2RedLoad(grid, [ll(700, 1000), ll(1000, 1000)]).redM).toBe(0);
    });
});
