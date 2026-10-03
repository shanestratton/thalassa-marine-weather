/**
 * A cardinal's wrong side, offline (G2, 2026-10-04). On the Pi's cells with
 * no SE-QLD marker file, Newport → Rivergate passed 12 m (newport-shane 5 m)
 * on the WEST side of the Brisbane River mouth's east cardinal, drawn as
 * channel: the charted track was snapped onto with land as its only veto,
 * and its join from the route cut across the cardinal's danger side, while
 * the track itself passes 60 m east of it.
 *
 *   • the line's metres on a cardinal's wrong side are read by the leg
 *     review's rule (within 400 m, the danger's whole half within 90 m, its
 *     hazard quadrant beyond), not on a charted lead the line rides — and
 *     the leg review reads every point by it too (G2 review, 2026-10-04);
 *   • such a segment is caution, named CARDINAL, red over a channel's
 *     yellow, not the tide's to lift, and Save and Plan My Day say why;
 *   • a charted-track snap never adds a metre on a cardinal's wrong side;
 *   • a marker file that does not load leaves the chart's own laterals to
 *     pair (it threw before them, so offline every lateral was a solo disc).
 *
 * Synthetic marks and water — no chart data.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Feature, FeatureCollection } from 'geojson';
import {
    cardinalWrongSideMask,
    cardinalWrongSideMetres,
    snapKeepingCardinalSide,
    type CardinalDisc,
} from '../../services/tier3/cardinalClamp';
import { snapToLeadingLines } from '../../services/leadingLine';
import { collectShallowRuns } from '../../services/engine/shallowRuns';
import { buildNavGrid } from '../../services/engine/navGrid';
import { CAUTION_WHY, type InshoreLayers } from '../../services/engine/types';
import { inshoreRoutePieces, inshoreSegmentStates } from '../../components/map/inshoreRouteState';
import { routeRedStretches } from '../../components/map/routeRedReasons';
import { fetchRegionalMarkers } from '../../services/InshoreRouter';
import { validateTraceLeg, type TracerContext } from '../../services/routeTracer';

const LAT0 = -27.3;
const LON0 = 153.2;
const M_LAT = 111_320;
const KX = 111_320 * Math.cos((LAT0 * Math.PI) / 180);
/** Local metres (x east, y north) → [lon, lat]. */
const at = (x: number, y: number): [number, number] => [LON0 + x / KX, LAT0 + y / M_LAT];
const ll = (x: number, y: number) => ({ lon: LON0 + x / KX, lat: LAT0 + y / M_LAT });
const EAST: CardinalDisc = { lat: LAT0, lon: LON0, dir: 'e', radiusM: 400 };

const sumM = (xs: readonly number[]): number => xs.reduce((m, x) => m + x, 0);

describe("the line's metres on a cardinal's wrong side", () => {
    it('a line 12 m west of an east cardinal is on its wrong side; 60 m east of it is not', () => {
        const west = cardinalWrongSideMetres([at(-12, 300), at(-12, -300)], [EAST]);
        expect(west[0]).toBeGreaterThan(150);
        const east = cardinalWrongSideMetres([at(60, 300), at(60, -300)], [EAST]);
        expect(east).toEqual([0]);
    });

    it('beyond 90 m only the hazard quadrant: 350 m south and 60 m west is a side, 300 m west is not', () => {
        // The river mouth's track passes 60 m east of the mark, then bends
        // south-west into the river 350 m below it: the south quadrant.
        expect(cardinalWrongSideMetres([at(-60, -350), at(-61, -351)], [EAST])).toEqual([0]);
        expect(cardinalWrongSideMetres([at(-300, 0), at(-301, 1)], [EAST])[0]).toBeGreaterThan(0);
        // …and beyond 400 m (CARDINAL_REACH_M) nothing counts.
        expect(cardinalWrongSideMetres([at(-450, 0), at(-451, 1)], [EAST])).toEqual([0]);
    });

    it('a line riding a charted lead past the mark is the lead’s, as in the leg review', () => {
        const lead = { pts: [ll(-12, 600), ll(-12, -600)] };
        expect(cardinalWrongSideMetres([at(-12, 300), at(-12, -300)], [EAST], [lead])).toEqual([0]);
        // Across the lead (not on its heading) it still counts.
        const across = cardinalWrongSideMetres([at(-80, 0), at(-1, 0)], [EAST], [lead]);
        expect(across[0]).toBeGreaterThan(0);
    });

    it('reads the discs from the layers (OBSTRN, as InshoreRouter folds a chart cardinal)', () => {
        const layers = {
            OBSTRN: {
                type: 'FeatureCollection',
                features: [
                    {
                        type: 'Feature',
                        properties: {
                            _class: 'iala-oriented-hazard',
                            _cardinalDir: 'e',
                            _markerLat: LAT0,
                            _markerLon: LON0,
                            _radiusM: 400,
                        },
                        geometry: {
                            type: 'Polygon',
                            coordinates: [[at(0, 400), at(-400, 0), at(0, -400), at(0, 400)]],
                        },
                    },
                ],
            },
        } as unknown as InshoreLayers;
        expect(cardinalWrongSideMask([at(-12, 300), at(-12, -300), at(200, -600)], layers)).toEqual([true, false]);
    });
});

// G2 review (2026-10-04): the router's mask counted every point within the
// disc's radius (400–1000 m, sized to reach the route), the leg review only
// the leg's closest point within 400 m. A leg 600 m west of an east cardinal
// whose disc reaches 900 m was red and refused, and graded clear; a leg whose
// closest point lay 100 m north of one, just east of its meridian, running on
// 290 m west into its hazard quadrant, the same. Now both read one rule
// (cardinalWrongSideAt) at every point of the line, within the review's 400 m.
describe('the router and the leg review read one rule', () => {
    const ctx = (c: CardinalDisc): TracerContext => ({
        grid: null,
        soloLaterals: [],
        markHazards: [],
        cardinals: [c],
        gatePairs: [],
        leads: [],
        canalLanes: [],
        draftM: 2.4,
        draftAssumed: false,
        gateChecksUnavailable: false,
        bbox: [LON0 - 0.05, LAT0 - 0.05, LON0 + 0.05, LAT0 + 0.05],
        resM: 10,
    });
    const both = (c: CardinalDisc, a: [number, number], b: [number, number]) => ({
        maskM: cardinalWrongSideMetres([at(...a), at(...b)], [c])[0],
        review: validateTraceLeg(ll(...a), ll(...b), ctx(c))
            .issues.filter((i) => i.message.includes('cardinal'))
            .map((i) => `${i.severity}: ${i.message}`),
    });

    it('beyond 400 m nothing counts, however far the disc reaches', () => {
        for (const radiusM of [400, 900]) {
            expect(both({ ...EAST, radiusM }, [-600, 500], [-600, -500])).toEqual({ maskM: 0, review: [] });
        }
    });

    it('a leg whose closest point is on the safe side, running on into the hazard quadrant: both say wrong side', () => {
        for (const radiusM of [400, 1000]) {
            const r = both({ ...EAST, radiusM }, [110, 90], [-290, 130]);
            expect(r.maskM).toBeGreaterThan(150);
            expect(r.review).toEqual(['danger: wrong side of the east cardinal — pass east of it']);
        }
    });

    it('a leg on the safe half all along: neither (a shave is the review’s caution, not the mask’s red)', () => {
        const r = both({ ...EAST, radiusM: 1000 }, [0, -50], [300, -50]);
        expect(r.maskM).toBe(0);
        expect(r.review).toEqual(['caution: shaves the east cardinal — give it 90 m']);
    });

    it('a leg through the hazard quadrant 300 m off, its closest point 50 m south: both say wrong side', () => {
        const r = both({ ...EAST, radiusM: 1000 }, [-300, -50], [300, -50]);
        expect(r.maskM).toBeGreaterThan(200);
        expect(r.review).toEqual(['danger: wrong side of the east cardinal — pass east of it']);
    });
});

describe('a segment on a cardinal’s wrong side is red, named, over a channel’s yellow', () => {
    // 10 m water everywhere: nothing else makes the segment caution.
    const box = (x0: number, y0: number, x1: number, y1: number): Feature => ({
        type: 'Feature',
        properties: { acronym: 'DEPARE', DRVAL1: 10, DRVAL2: 15, _scaleRank: 4505 },
        geometry: { type: 'Polygon', coordinates: [[at(x0, y0), at(x1, y0), at(x1, y1), at(x0, y1), at(x0, y0)]] },
    });
    const layers = {
        DEPARE: { type: 'FeatureCollection', features: [box(-2000, -2000, 2000, 2000)] } as FeatureCollection,
    } as InshoreLayers;
    const [w, s] = at(-1500, -1500);
    const [e, n] = at(1500, 1500);
    const grid = buildNavGrid(layers, [w, s, e, n], 50, 2.4, 0.5, 30);
    const polyline: [number, number][] = [at(-12, 600), at(-12, -600), at(400, -1200)];
    const run = (cardinalMask?: boolean[]) =>
        collectShallowRuns({
            layers,
            grid,
            polyline,
            caution: [true, false],
            draftM: 2.4,
            safetyM: 0.5,
            hazardMask: [false, false],
            ...(cardinalMask ? { cardinalMask } : {}),
        });

    it('the reason is CARDINAL, and no tide lifts it', () => {
        const r = run([true, false]);
        expect(r.cautionWhy[0] & CAUTION_WHY.CARDINAL).toBe(CAUTION_WHY.CARDINAL);
        expect(r.tideDepthM[0]).toBeNull();
    });

    it('drawn red over the yellow of a marked channel, with its words', () => {
        const r = run([true, false]);
        const masks = {
            polyline,
            cautionMask: [true, false],
            canalMask: [false, false],
            channelMask: [true, true],
            offshoreMask: [false, false],
            ...r,
        };
        const states = inshoreSegmentStates(masks)!;
        expect(states).toEqual(['danger', 'channel']);
        const stretches = routeRedStretches(polyline, inshoreRoutePieces(polyline, states, [], r.chartedShallowSpans), {
            ...masks,
            tideNeedM: 2.9,
        });
        expect(stretches.map((x) => x.why)).toEqual([
            "passes a cardinal mark on its danger side — keep to the side it's named for",
        ]);
    });
});

describe('a charted-track snap never adds a metre on a cardinal’s wrong side', () => {
    // A route down x = 120, a charted track down x = 60 that bends south-west
    // below the mark: the route's last vertices hug the track's lower piece,
    // so the snap joins from x = 120 (y = 500) to the track at y = -300 —
    // across the mark's west side.
    const route = [
        ll(120, 1500),
        ll(120, 900),
        ll(110, 500),
        ll(-40, -300),
        ll(-200, -500),
        ll(-400, -700),
        ll(-700, -1000),
    ];
    const track = { pts: [ll(60, -150), ll(-700, -910)] };
    const opts = { corridorM: 150, minRunM: 80, maxAngleDeg: 30, followInteriorVertices: true };

    it('the reproduction: the plain snap joins across the cardinal’s west side', () => {
        const plain = snapToLeadingLines(
            route,
            route.map(() => false),
            [track],
            opts,
        );
        expect(plain.snapped).toBe(1);
        const line = plain.polyline.map((p) => [p.lon, p.lat] as [number, number]);
        expect(sumM(cardinalWrongSideMetres(line, [EAST]))).toBeGreaterThan(10);
    });

    it('the guarded snap keeps the route where the join would cross it, and says it refused one', () => {
        const before = sumM(
            cardinalWrongSideMetres(
                route.map((p) => [p.lon, p.lat]),
                [EAST],
            ),
        );
        const guarded = snapKeepingCardinalSide(
            route,
            route.map(() => false),
            [track],
            opts,
            [EAST],
            [],
        );
        expect(guarded.snapped).toBe(0);
        expect(guarded.refused).toBe(1);
        expect(guarded.polyline).toEqual(route);
        expect(
            sumM(
                cardinalWrongSideMetres(
                    guarded.polyline.map((p) => [p.lon, p.lat]),
                    [EAST],
                ),
            ),
        ).toBe(before);
    });

    it('with no cardinal it is the plain snap, exactly', () => {
        const plain = snapToLeadingLines(
            route,
            route.map(() => false),
            [track],
            opts,
        );
        expect(
            snapKeepingCardinalSide(
                route,
                route.map(() => false),
                [track],
                opts,
                [],
                [],
            ),
        ).toEqual({
            ...plain,
            refused: 0,
        });
        // …and with a cardinal no snap goes near, the same.
        const far: CardinalDisc = { ...EAST, lat: LAT0 + 0.2 };
        expect(
            snapKeepingCardinalSide(
                route,
                route.map(() => false),
                [track],
                opts,
                [far],
                [],
            ),
        ).toEqual({
            ...plain,
            refused: 0,
        });
    });
});

describe('a marker file that does not load leaves the chart’s own laterals to pair', () => {
    afterEach(() => vi.restoreAllMocks());
    const mkLat = (i: number) => -26.68 - i * 0.002;
    const laterals = [
        ...[0, 1, 2, 3].map((i) => ({ lat: mkLat(i), lon: 153.132, kind: 'port' as const })),
        ...[0, 1, 2, 3].map((i) => ({ lat: mkLat(i), lon: 153.1331, kind: 'starboard' as const })),
    ];

    it('pairs them, and says the file failed', async () => {
        vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
        const res = await fetchRegionalMarkers(
            'https://example.invalid/g2-offline/nav_markers.geojson',
            [],
            [],
            [],
            laterals,
        );
        expect(res.acceptedPairs.length).toBeGreaterThanOrEqual(3);
        expect(res.markerFileFailed).toBe(true);
    });

    it('a file that loads is not marked failed', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response(JSON.stringify({ type: 'FeatureCollection', features: [] }), { status: 200 }),
        );
        const res = await fetchRegionalMarkers(
            'https://example.invalid/g2-online/nav_markers.geojson',
            [],
            [],
            [],
            laterals,
        );
        expect(res.acceptedPairs.length).toBeGreaterThanOrEqual(3);
        expect(res.markerFileFailed).toBeUndefined();
    });
});
