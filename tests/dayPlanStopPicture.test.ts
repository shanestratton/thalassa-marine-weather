/**
 * Plan Your Day, build 132 (132-PYD-9): the stop page's route picture and
 * shelter rose, worked out (services/dayPlanner/stopPicture.ts).
 *
 * Shane's roadmap: "A small map on each stop (land from OpenStreetMap, a dot
 * at the start, a pin at the stop, the wind) with the routed line on it once
 * routed, never a straight line. A small rose beside the shelter word shows
 * which way the land shelters her." Its risk: "Outside Queensland the land
 * layer may be empty: the picture must say so, not look like open sea."
 *
 * Land is read from OpenStreetMap's own rule, land on the left of the coast,
 * so these fictional coasts are drawn both ways round. Fictional places only.
 */
import { describe, expect, it } from 'vitest';
import type { Segment } from '../services/weather/shelter/shelterGeometry';
import {
    COAST_REACH_DEG,
    pictureFrame,
    pictureLand,
    pictureNote,
    pictureXY,
    roseReach,
    rosePath,
    roseWords,
} from '../services/dayPlanner/stopPicture';

const START = { lat: -20, lon: 149 };
/** About 11 NM east of the start. */
const STOP = { lat: -20, lon: 149.2 };

/** A coast as OpenStreetMap draws it: one way, [lon, lat] in its order, as two-point segments. */
const way = (...points: [number, number][]): Segment[] => points.slice(1).map((p, i) => [points[i], p]);

/** A square island, anticlockwise (land on the left), `r` degrees each side of its centre. */
const island = (lon: number, lat: number, r: number) =>
    way([lon - r, lat - r], [lon + r, lat - r], [lon + r, lat + r], [lon - r, lat + r], [lon - r, lat - r]);

/** Is this point of the picture (its 200 x 100 units) drawn as land? From the land path's rows. */
function landAt(d: string, x: number, y: number): boolean {
    for (const [, a, top, w] of d.matchAll(/M([\d.]+) ([\d.]+)h([\d.]+)v2\.2h-?[\d.]+z/g))
        if (+top <= y && y < +top + 2 && +a <= x && x <= +a + +w) return true;
    return false;
}

function land(coast: Segment[] | null, points = [STOP]) {
    return pictureLand(pictureFrame(START, points), coast);
}

describe('the frame: her start, the stop and the routed line, in 200 x 100', () => {
    /** Every mark inside the middle: room for the pin over the stop, and the band at the foot left for words. */
    const inMarks = ([x, y]: [number, number]) => x >= 6 && x <= 194 && y >= 12 && y <= 78;

    it('holds both, clear of the pin room and the band of words, wherever the stop lies', () => {
        for (const stop of [STOP, { lat: -19.8, lon: 149 }, { lat: -20.3, lon: 148.7 }, { lat: -20.01, lon: 149.01 }]) {
            const frame = pictureFrame(START, [stop]);
            expect(inMarks(pictureXY(frame, START))).toBe(true);
            expect(inMarks(pictureXY(frame, stop))).toBe(true);
        }
    });

    it('is never under 3 NM across, so a short hop is not drawn as a smear', () => {
        expect(200 / pictureFrame(START, [{ lat: -20.002, lon: 149.002 }]).scale).toBe(0.05);
    });

    it('takes in the routed line, wherever it bends', () => {
        const bend = { lat: -20.25, lon: 149.1 };
        const frame = pictureFrame(START, [STOP, START, bend, STOP]);
        for (const p of [START, bend, STOP]) expect(inMarks(pictureXY(frame, p))).toBe(true);
    });

    it('draws a stop across the antimeridian beside her start, not half a world away', () => {
        const start = { lat: -16.8, lon: 179.98 };
        const stop = { lat: -16.8, lon: -179.95 };
        const frame = pictureFrame(start, [stop]);
        const [sx] = pictureXY(frame, start);
        const [px] = pictureXY(frame, stop);
        expect(px).toBeGreaterThan(sx);
        expect(px).toBeLessThanOrEqual(197);
    });
});

describe('the land: OpenStreetMap only, and never guessed', () => {
    it('no coastline: nothing drawn as land, and it says so (never open sea)', () => {
        const none = land(null);
        expect(none).toEqual({ kind: 'none' });
        expect(pictureNote(none)).toEqual({
            shown: 'Land not loaded',
            said: "Land not drawn: the coastline didn't load",
        });
    });

    it('still loading: grey and said as loading, never as a failure the app does not know of yet', () => {
        // In Queensland the atlas's stops are open while the coastline can take up to 30 s to answer.
        const loading = pictureLand(pictureFrame(START, [STOP]), 'loading');
        expect(loading).toEqual({ kind: 'loading' });
        expect(pictureNote(loading)).toEqual({
            shown: 'Land loading…',
            said: 'Land not drawn yet: the coastline is still loading',
        });
    });

    it('a coastline that maps no coast in the picture says so too', () => {
        expect(land([])).toEqual({ kind: 'empty' });
        // A coast far off, crossing neither the picture's rows nor its middle.
        const far = land(way([140, -25], [140.1, -25]));
        expect(far).toEqual({ kind: 'empty' });
        expect(pictureNote(far)).toEqual({
            shown: 'No coast mapped here',
            said: 'No coastline mapped here: land may be missing',
        });
    });

    it('an island between her start and the stop is drawn filled, the water round it left as sea', () => {
        const drawn = land(island(149.1, -20, 0.02));
        expect(drawn.kind).toBe('land');
        const d = drawn.kind === 'land' ? drawn.d : '';
        // Between them, in the middle of the marks (45 units down).
        expect(landAt(d, 100, 45)).toBe(true);
        expect(landAt(d, 60, 45)).toBe(false);
        expect(landAt(d, 100, 20)).toBe(false);
        expect(landAt(d, 100, 70)).toBe(false);
        expect(pictureNote(drawn).shown).toBe('Land © OpenStreetMap');
    });

    it('a mainland coast has its land on its left: drawn north it is land to the west, drawn south to the east', () => {
        const north = land(way([149.15, -21], [149.15, -19]));
        const south = land(way([149.15, -19], [149.15, -21]));
        if (north.kind !== 'land' || south.kind !== 'land') throw new Error('no land');
        expect([landAt(north.d, 40, 45), landAt(north.d, 180, 45)]).toEqual([true, false]);
        expect([landAt(south.d, 40, 45), landAt(south.d, 180, 45)]).toEqual([false, true]);
    });

    it('a picture all land (the coast beyond it, to the north, running west) is drawn all land', () => {
        const all = land(way([149.6, -19.5], [148.4, -19.5]));
        if (all.kind !== 'land') throw new Error('no land');
        for (const [x, y] of [
            [3, 3],
            [100, 50],
            [197, 97],
        ])
            expect(landAt(all.d, x, y)).toBe(true);
    });

    it('past the ground the coastline was asked for (27 NM round the start) it is grey, and says so', () => {
        const near = land(island(149.1, -20, 0.02));
        expect(near.kind === 'land' && near.edge).toBeNull();
        // A stop 40 NM off: the far side of the picture is past the coastline's reach.
        const far = land(island(149.1, -20, 0.02), [{ lat: -20, lon: 149 + 0.75 }]);
        expect(far.kind === 'land' && far.edge).toMatch(/^M0 0H200V100H0z M/);
        expect(pictureNote(far)).toEqual({
            shown: 'Land © OpenStreetMap, to 27 NM',
            said: 'Land © OpenStreetMap, drawn to 27 NM from the start',
        });
        expect(COAST_REACH_DEG * 60).toBeCloseTo(27, 6);
    });
});

describe('the shelter rose', () => {
    /** Land within a mile from north round to east; open water (15 NM, the cap) everywhere else. */
    const NE_LEE = Array.from({ length: 36 }, (_, i) => (i <= 9 ? 0.5 : 15));

    it('reads the land table as the anchorage verdict does: a full lee within 1 NM, nothing at 10 NM or more', () => {
        expect(roseReach([0.2, 1, 5.5, 10, 15])).toEqual([1, 1, 0.5, 0, 0]);
    });

    it('draws a wedge toward each bearing the land shelters her from, and none toward open water', () => {
        expect(rosePath(NE_LEE).match(/M8 8/g)).toHaveLength(10);
        expect(rosePath(new Array(36).fill(15))).toBe('');
        // North is up: the 0° wedge reaches the top of the rose.
        expect(rosePath(NE_LEE)).toMatch(/^M8 8L7\.39 1\.03A7\.00 7\.00 0 0 1 8\.61 1\.03z/);
    });

    it('says which way, in the points of the compass', () => {
        expect(roseWords(NE_LEE)).toBe('Shelter rose: land close to the N, NE, E');
        expect(roseWords(new Array(36).fill(15))).toBe('Shelter rose: no land close by');
        expect(roseWords(new Array(36).fill(0.3))).toBe('Shelter rose: land close to the N, NE, E, SE, S, SW, W, NW');
    });
});
