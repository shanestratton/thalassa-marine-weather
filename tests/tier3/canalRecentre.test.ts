/**
 * recentreCanalRedOnEnc — pull the canal RED onto the ENC channel medial axis.
 *
 * Newport end (docs/AI_COLLAB.md 2026-06-25): the canal red is snapped to the OSM
 * canal lines, which sit ~8 m off the ENC channel the chart renders, so the red
 * looks like it hugs the west wall. This re-centres the red onto the LNDARE channel
 * midpoint — but ONLY the red, only a two-walled channel, never the yellow or open
 * water. Synthetic, CI-able (no Pi/Mapbox).
 */
import { describe, it, expect } from 'vitest';
import type { Polygon } from 'geojson';
import { recentreCanalRedOnEnc } from '../../services/engine/tierPipeline';

const M_PER_LAT = 110_540;
const mPerLon = (lat: number): number => 111_320 * Math.cos((lat * Math.PI) / 180);

/** A rectangular LNDARE land block as {geom,bbox} the function consumes. */
function landBlock(
    lonLo: number,
    latLo: number,
    lonHi: number,
    latHi: number,
): {
    geom: Polygon;
    bbox: [number, number, number, number];
} {
    return {
        geom: {
            type: 'Polygon',
            coordinates: [
                [
                    [lonLo, latLo],
                    [lonHi, latLo],
                    [lonHi, latHi],
                    [lonLo, latHi],
                    [lonLo, latLo],
                ],
            ],
        },
        bbox: [lonLo, latLo, lonHi, latHi],
    };
}

describe('recentreCanalRedOnEnc — ENC-channel centring (Newport main channel)', () => {
    // A ~56 m-wide N–S channel: land west of lon 153.00000, land east of lon 153.00057.
    const WEST = 153.0;
    const EAST = 153.00057;
    const CENTRE = (WEST + EAST) / 2; // 153.000285
    const land = [landBlock(152.997, -27.22, WEST, -27.19), landBlock(EAST, -27.22, 153.003, -27.19)];
    const offCentreLon = WEST + 0.0002; // ~20 m from the west wall → ~8 m west of centre

    const offFromCentreM = (lon: number, lat: number): number => (lon - CENTRE) * mPerLon(lat);

    it('pulls an 8 m-west red route onto the channel centreline', () => {
        const lats = [-27.21, -27.208, -27.206, -27.204, -27.202];
        const poly = lats.map((lat) => [offCentreLon, lat] as [number, number]);
        const red = poly.map(() => true);
        const yellow = poly.map(() => false);

        const rawWorst = Math.max(...poly.map(([lon, lat]) => Math.abs(offFromCentreM(lon, lat))));
        expect(rawWorst).toBeGreaterThan(6); // really is ~8 m off to start

        const { polyline, redMask } = recentreCanalRedOnEnc(poly, red, yellow, land);
        // Every output vertex must ride the channel centreline (the run may DP-collapse
        // to a centred straight line — fewer points, still dead centre).
        const offs = polyline.map(([lon, lat]) => Math.abs(offFromCentreM(lon, lat)));
        const worst = Math.max(...offs);
        // eslint-disable-next-line no-console
        console.log(
            `[recentre] raw worst=${rawWorst.toFixed(1)}m → out worst=${worst.toFixed(1)}m (n=${polyline.length})`,
        );
        expect(worst).toBeLessThan(3);
        expect(redMask.every(Boolean)).toBe(true);
    });

    it('NEVER moves a yellow vertex (gates stay put)', () => {
        const poly: [number, number][] = [
            [offCentreLon, -27.21],
            [offCentreLon, -27.206], // yellow — must not move
            [offCentreLon, -27.202],
        ];
        const red = [true, false, true];
        const yellow = [false, true, false];
        const { polyline } = recentreCanalRedOnEnc(poly, red, yellow, land);
        const yellowOut = polyline.find(([, lat]) => Math.abs(lat - -27.206) < 1e-6);
        expect(yellowOut).toBeDefined();
        expect(yellowOut![0]).toBeCloseTo(offCentreLon, 9); // exactly where it was
    });

    it('leaves OPEN water alone (no two-sided wall within reach)', () => {
        // Walls ~300 m apart → wider than MAX_HALF_M, so the march never bounds it.
        const wide = [landBlock(152.99, -27.22, 152.999, -27.19), landBlock(153.004, -27.22, 153.01, -27.19)];
        const poly: [number, number][] = [
            [153.0015, -27.21],
            [153.0015, -27.206],
            [153.0015, -27.202],
        ];
        const { polyline } = recentreCanalRedOnEnc(
            poly,
            poly.map(() => true),
            poly.map(() => false),
            wide,
        );
        // The points must NOT be shifted off the original axis (collinear DP-collapse
        // is fine — geometry is preserved, just fewer vertices).
        for (const [lon] of polyline) expect(lon).toBeCloseTo(153.0015, 9);
        expect(polyline[0][1]).toBeCloseTo(-27.21, 9);
        expect(polyline[polyline.length - 1][1]).toBeCloseTo(-27.202, 9);
    });

    it('snaps the red onto the BUOY CHAIN when there is no land (marks down the channel middle)', () => {
        // The Newport main-channel case: no LNDARE, but a buoy chain runs down the middle
        // (the lateral marks). Route offset ~30 m west of the chain → must snap onto it.
        const chainLon = 153.0006;
        const chain = {
            pts: [
                { lat: -27.21, lon: chainLon },
                { lat: -27.205, lon: chainLon },
                { lat: -27.2, lon: chainLon },
            ],
        };
        const offLon = chainLon - 0.0003; // ~30 m west of the chain
        const poly: [number, number][] = [
            [offLon, -27.21],
            [offLon, -27.207],
            [offLon, -27.204],
            [offLon, -27.201],
        ];
        const off = (lon: number, lat: number): number => Math.abs((lon - chainLon) * mPerLon(lat));
        const rawWorst = Math.max(...poly.map(([lon, lat]) => off(lon, lat)));
        expect(rawWorst).toBeGreaterThan(25); // ~30 m off to start

        const { polyline } = recentreCanalRedOnEnc(
            poly,
            poly.map(() => true),
            poly.map(() => false),
            [], // no LNDARE — forces the buoy-chain snap
            [chain],
        );
        const worst = Math.max(...polyline.map(([lon, lat]) => off(lon, lat)));
        // eslint-disable-next-line no-console
        console.log(`[recentre-chain] raw worst=${rawWorst.toFixed(1)}m → out worst=${worst.toFixed(1)}m`);
        expect(worst).toBeLessThan(5);
    });
});
