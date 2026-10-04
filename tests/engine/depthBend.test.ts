/**
 * A route that turns off the straight line for deeper water says why (Shane,
 * 2026-10-04, an Auto route out of Port of Airlie: "i am unsure why waypoints
 * 5,6,7 would go that way and not straight ahead").
 *
 * Measured on the Pi's cells (2026-10-04): from the marina channel's seaward
 * end every heading crosses a 2–5 m band, charted 2.0 m where the boat needs
 * 2.9 m. The nearest water charted deep enough is a 3.6–5 m band 0.9 km NW;
 * straight on, the 5–10 m band is 1.2 km off. The route takes the short way
 * across the band — NW, north up the 3.6 m band, NE into 5–10 m. Re-measured
 * once the route squared through the outer pair (gateOutsideThread.test.ts):
 * from the square-off, 864 m over 2.0 m water where the straight line on has
 * 1,428 m, for 1,089 m more sailing (5.9 min at 6 kn; Whitehaven 1,027 m,
 * Shane's own pin 1,117 m), its 3.6 m water reached sooner than straight on
 * reaches any. By the chart the bend is the safer line (DECIDED 2026-10-04):
 * the same worst state (the channel's own 1.8 m sets the tide), never
 * shallower, less water under the keel's need. So the router keeps it, and
 * the route notes now say why, where, and what it costs, in one plain line
 * (engine/stringPull depthBendOf; 20–46 ms over a whole app route).
 *
 * Synthetic charts in a local metric frame round (LON0, LAT0): a deep basin
 * at the departure inside a 2–5 m band, a 3.6–5 m pocket NW of it, a 5–10 m
 * band to the north. Need 2.9 m (2.4 m draft + 0.5 m UKC).
 */
import type { Feature, FeatureCollection } from 'geojson';
import { describe, expect, it } from 'vitest';
import { routeInshore, type RouteRequest, type RouteResult } from '../../services/inshoreRouterEngine';
import { buildNavGrid } from '../../services/engine/navGrid';
import { depthBendOf, lineExposureReader } from '../../services/engine/stringPull';
import type { InshoreLayers } from '../../services/engine/types';
import { inshoreRouteCaveats } from '../../components/map/inshoreRouteNotice';
import { chartAreaIndexFor, chartedDepthAt } from '../../services/routing/leadLandClip';

const LAT0 = -21.6;
const LON0 = 150.4;
const KY = 111_320;
const KX = 111_320 * Math.cos((LAT0 * Math.PI) / 180);
/** [lon, lat] of a point `x` m east and `y` m north of (LON0, LAT0). */
const at = (x: number, y: number): [number, number] => [LON0 + x / KX, LAT0 + y / KY];
const metres = ([lon, lat]: readonly [number, number]): [number, number] => [(lon - LON0) * KX, (lat - LAT0) * KY];
const fc = (...features: Feature[]): FeatureCollection => ({ type: 'FeatureCollection', features });
const ring = (x0: number, y0: number, x1: number, y1: number): [number, number][] => [
    at(x0, y0),
    at(x1, y0),
    at(x1, y1),
    at(x0, y1),
    at(x0, y0),
];
const area = (rings: [number, number][][], props: Record<string, unknown>): Feature => ({
    type: 'Feature',
    properties: props,
    geometry: { type: 'Polygon', coordinates: rings },
});
const band = (d1: number, d2: number) => ({ acronym: 'DEPARE', DRVAL1: d1, DRVAL2: d2 });

const BASIN = [-200, -200, 200, 150] as const;
const POCKET = [-1300, 450, -500, 1250] as const;
/** The 2–5 m band round the basin and the pocket, the 5–10 m band north of
 *  it; `island` puts land across the straight line (and out of the band). */
const chart = (island = false): InshoreLayers => {
    const holes = [ring(...BASIN), ring(...POCKET)];
    if (island) holes.push(ring(-250, 500, 600, 1000));
    return {
        DEPARE: fc(
            area([ring(-6000, -6000, 6000, 1250), ...holes], band(2, 5)),
            area([ring(...BASIN)], band(5, 10)),
            area([ring(...POCKET)], band(3.6, 5)),
            area([ring(-6000, 1250, 6000, 6000)], band(5, 10)),
        ),
        LNDARE: island ? fc(area([ring(-250, 500, 600, 1000)], { acronym: 'LNDARE' })) : fc(),
    } as InshoreLayers;
};
const FROM: [number, number] = [0, 0];
const TO: [number, number] = [900, 2600];
const req = (): RouteRequest => {
    const [fromLon, fromLat] = at(...FROM);
    const [toLon, toLat] = at(...TO);
    return { fromLat, fromLon, toLat, toLon, draftM: 2.4, safetyM: 0.5, resolutionM: 50, obstructionBufferM: 60 };
};
const ok = (r: ReturnType<typeof routeInshore>): RouteResult => {
    if ('error' in r) throw new Error(`${r.code}: ${r.error}`);
    return r;
};
const isVertex = (p: readonly [number, number], line: readonly [number, number][]): boolean =>
    line.some((q) => q[0] === p[0] && q[1] === p[1]);

describe('a turn for deeper water says why (Port of Airlie, 2026-10-04)', () => {
    it('crosses the 2 m band the short way, to the 3.6 m pocket, and names the bend', () => {
        const r = ok(routeInshore(chart(), req()));
        // The router's choice, kept: it reaches the pocket (NW of the basin).
        expect(r.polyline.some((p) => metres(p)[0] < -400 && metres(p)[1] > 400)).toBe(true);
        const bend = r.depthBend;
        expect(bend).toBeDefined();
        if (!bend) return;
        expect(isVertex(bend.at, r.polyline) && isVertex(bend.via, r.polyline) && isVertex(bend.to, r.polyline)).toBe(
            true,
        );
        expect(bend.needM).toBeCloseTo(2.9, 5);
        // It reaches the pocket's 3.6 m; straight on is the band's 2.0 m. And
        // sooner: ~0.6 km on, where straight on reaches 5 m ~1.2 km on.
        expect(bend.deepM).toBe(3.6);
        expect(bend.overM).toBe(2);
        expect(bend.sooner).toBe(true);
        // Straight on is ~1.1 km of the 2 m band; the bend ~0.5 km of it.
        expect(bend.straightM).toBeGreaterThan(850);
        expect(bend.routeM).toBeLessThan(700);
        expect(bend.straightM - bend.routeM).toBeGreaterThanOrEqual(300);
        // For a few hundred metres more sailing.
        expect(bend.extraM).toBeGreaterThan(0);
        expect(bend.extraM).toBeLessThan(800);
        // It leaves the straight line north-west, for the pocket.
        const [vx, vy] = metres(bend.via);
        const [ax, ay] = metres(bend.at);
        expect(vx - ax).toBeLessThan(0);
        expect(vy - ay).toBeGreaterThan(0);
    });

    it('says it in one plain line of the route notes', () => {
        const bend = {
            at: at(0, 150),
            via: at(-500, 600),
            to: at(900, 2600),
            routeM: 462,
            straightM: 1104,
            extraM: 273,
            needM: 2.9,
        };
        // Where: the turn's position, as Review lists a waypoint's.
        const where = 'At 21°35.919′S 150°24.000′E the route bends north-west';
        expect(inshoreRouteCaveats({ depthBend: { ...bend, deepM: 3.6, overM: 2, sooner: true } })).toEqual([
            `${where} to reach charted 3.6 m water sooner: 270 m further, but 460 m over 2.0 m water instead of 1.1 km straight on.`,
        ]);
        // "Sooner" only where the bend's deep water comes first.
        expect(inshoreRouteCaveats({ depthBend: { ...bend, deepM: 3.6, overM: 2, sooner: false } })).toEqual([
            `${where} to reach charted 3.6 m water: 270 m further, but 460 m over 2.0 m water instead of 1.1 km straight on.`,
        ]);
        // Where the chart gives no depths to name (a grid-only chart).
        expect(inshoreRouteCaveats({ depthBend: bend })).toEqual([
            `${where} off the straight line to cross less water charted under the 2.9 m you need: 270 m further, but 460 m of it instead of 1.1 km straight on.`,
        ]);
    });

    it('says "sooner" only where the bend reaches deep water first', () => {
        // Straight on crosses 60 m of the 2 m band into a 5 m strip, then
        // more than a kilometre of the band; the bend crosses 375 m of it into
        // 5 m water to the west and runs north in it: far less of the band,
        // but its deep water comes 375 m on, not 60 m.
        const holes = [ring(-30, 60, 30, 400), ring(-6000, -6000, -300, 6000)];
        const layers = {
            DEPARE: fc(
                area([ring(-6000, -6000, 6000, 6000), ...holes], band(2, 5)),
                ...holes.map((h) => area([h], band(5, 10))),
            ),
        } as InshoreLayers;
        const line: [number, number][] = [at(0, 0), at(-400, 300), at(-400, 1500), at(0, 1800)];
        const [w, s] = at(-3000, -3000);
        const [e, n] = at(3000, 4000);
        const grid = buildNavGrid(layers, [w, s, e, n], 50, 2.4, 0.5, 60);
        const depths = chartAreaIndexFor(layers).depth;
        const bend = depthBendOf(line, {
            exposureOf: lineExposureReader({
                layers,
                grid,
                draftM: 2.4,
                safetyM: 0.5,
                obstructionBufferM: 60,
                strictUncharted: false,
            }),
            needM: 2.9,
            depthAt: (lon, lat) => chartedDepthAt(depths, lon, lat),
        });
        expect(bend).not.toBeNull();
        expect(bend!.at).toEqual(line[0]);
        expect(bend!.straightM - bend!.routeM).toBeGreaterThan(600);
        expect(bend!.deepM).toBe(5);
        expect(bend!.overM).toBe(2);
        expect(bend!.sooner).toBe(false);
    });

    it('is no depth bend where the straight line is as deep', () => {
        const deep: InshoreLayers = {
            DEPARE: fc(area([ring(-6000, -6000, 6000, 6000)], band(10, 20))),
        } as InshoreLayers;
        const r = ok(routeInshore(deep, req()));
        expect(r.depthBend).toBeUndefined();
    });

    it('is no depth bend where the straight line meets land too', () => {
        // The same bend, hand drawn (basin → pocket → north band → pin), read
        // against the chart with and without an island across the straight line.
        const line: [number, number][] = [at(0, 100), at(-550, 500), at(-550, 1200), at(900, 2600)];
        const bendOn = (layers: InshoreLayers) => {
            const [w, s] = at(-3000, -3000);
            const [e, n] = at(3000, 4000);
            const grid = buildNavGrid(layers, [w, s, e, n], 50, 2.4, 0.5, 60);
            return depthBendOf(line, {
                exposureOf: lineExposureReader({
                    layers,
                    grid,
                    draftM: 2.4,
                    safetyM: 0.5,
                    obstructionBufferM: 60,
                    strictUncharted: false,
                }),
            });
        };
        expect(bendOn(chart())).not.toBeNull();
        expect(bendOn(chart(true))).toBeNull();
    });
});
