/**
 * The browser specs' made-up seabed (e2e/helpers/syntheticChartTiles.ts).
 *
 * desk-wind-layout's Relief + Sat check (A4, 2026-10-12) says the streaks are
 * "white on the dark base". On this fixture that was never true: every sea was
 * 2-22 m, which Relief draws mid-blue, and the sample band was a third Isle of
 * Wight farmland. So the fixture gains one deep, west of Lisbon past a made-up
 * shelf break, and every place another spec reads keeps its shallow seabed.
 */
import { decode } from 'fast-png';
import { describe, expect, it } from 'vitest';
import { depthAt, isLand, reliefTile } from '../e2e/helpers/syntheticChartTiles';
import { depthIndex } from '../components/map/reliefBase';

describe('the fixture’s deep, west of Lisbon', () => {
    it('is past 1,000 m and open water across the view the desk wind spec samples', () => {
        for (let lon = -11.8; lon <= -10.4; lon += 0.1) {
            for (let lat = 38.3; lat <= 38.8; lat += 0.05) {
                expect(isLand(lon, lat), `${lon.toFixed(2)}, ${lat.toFixed(2)} is sea`).toBe(false);
                expect(depthAt(lon, lat), `${lon.toFixed(2)}, ${lat.toFixed(2)}`).toBeGreaterThan(1_000);
            }
        }
    });

    it('is what the relief tiles carry there: a deep index, not the shelf’s', () => {
        // z9 tile 240/196 lies at 11.25-10.55° W, 38.27-38.82° N.
        const png = reliefTile('idx', 9, 240, 196);
        expect(png).not.toBeNull();
        const { width, height, channels, data } = decode(png!);
        const red = (x: number, y: number) => data[(y * width + x) * channels];
        for (const [x, y] of [
            [0, 0],
            [width - 1, 0],
            [width >> 1, height >> 1],
            [0, height - 1],
            [width - 1, height - 1],
        ])
            expect(red(x, y), `pixel ${x}, ${y}`).toBeGreaterThan(depthIndex(1_000));
    });

    it('leaves every place the other specs read on the shallow shelf it had', () => {
        const shelf: Array<[string, number, number]> = [
            ['the Solent (log, track and desk maps)', -1.45, 50.745],
            ['south of the Isle of Wight, Light at z8 (desk-map-light)', -1.3, 50.5],
            ['east of the Isle of Wight, flat water at z13 (desk-map-light)', -1.0, 50.65],
            ['the Light streak band (desk-wind)', -1.7, 50.6],
            ['Chesapeake Bay (desk-map-light), on Lisbon’s latitude', -76.3, 38.97],
            ['off Lisbon, where the desk wind spec asks the models', -9.14, 38.69],
            ['the Whitsundays', 148.75, -20.2],
            ['Fiji, across the antimeridian (track map)', 179.7, -16.75],
            ['Noumea', 166.45, -22.28],
        ];
        for (const [where, lon, lat] of shelf) expect(depthAt(lon, lat), where).toBeLessThan(23);
    });
});
