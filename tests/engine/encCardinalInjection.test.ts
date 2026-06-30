/**
 * encCardinalsToHazards — feed ENC chart cardinals (BOYCAR/BCNCAR) into the router's hazard
 * path with their CATCAM direction, so an East cardinal is avoided on its EAST (safe) side
 * instead of being display-only (Shane: two East cardinals ended up on opposite sides). End
 * to end: CATCAM → _osmClass='cardinal_<nesw>' → orientHazardsTowardLand blocks the hazard side.
 */
import { describe, it, expect } from 'vitest';
import { encCardinalsToHazards, orientHazardsTowardLand } from '../../services/InshoreRouter';

type EncF = {
    geometry?: { type?: string; coordinates?: [number, number] } | null;
    properties?: Record<string, unknown> | null;
};
const card = (lon: number, lat: number, catcam: unknown): EncF => ({
    geometry: { type: 'Point', coordinates: [lon, lat] },
    properties: { CATCAM: catcam },
});
const landNorthOf = (lon: number, lat: number): { geometry: { type: string; coordinates: number[][][] } } => ({
    geometry: {
        type: 'Polygon',
        coordinates: [
            [
                [lon - 0.01, lat + 0.01],
                [lon + 0.01, lat + 0.01],
                [lon + 0.01, lat + 0.02],
                [lon - 0.01, lat + 0.02],
                [lon - 0.01, lat + 0.01],
            ],
        ],
    },
});

describe('encCardinalsToHazards', () => {
    it('maps CATCAM 1/2/3/4 → cardinal_n/e/s/w direct-hazards', () => {
        const out = encCardinalsToHazards(
            [card(153, -27, 1), card(153.01, -27, 2), card(153.02, -27, 3), card(153.03, -27, 4)],
            new Set(),
        );
        expect(out.map((h) => h.properties._osmClass)).toEqual([
            'cardinal_n',
            'cardinal_e',
            'cardinal_s',
            'cardinal_w',
        ]);
        expect(out.every((h) => h.properties._class === 'direct-hazard')).toBe(true);
    });

    it('SKIPS missing/invalid CATCAM (never defaults a direction — a wrong one blocks the wrong side)', () => {
        const out = encCardinalsToHazards(
            [
                card(153, -27, 0),
                card(153.01, -27, 5),
                card(153.02, -27, null),
                card(153.03, -27, undefined),
                card(153.04, -27, NaN),
            ],
            new Set(),
        );
        expect(out.length).toBe(0);
    });

    it('skips non-Point geometry', () => {
        const out = encCardinalsToHazards(
            [{ geometry: { type: 'Polygon', coordinates: [0, 0] }, properties: { CATCAM: 2 } }],
            new Set(),
        );
        expect(out.length).toBe(0);
    });

    it('dedups against an OSM hazard at the same spot (one buoy → one disc)', () => {
        const lon = 153.1;
        const lat = -27.2;
        const key = `${lat.toFixed(4)}|${lon.toFixed(4)}`;
        expect(encCardinalsToHazards([card(lon, lat, 2)], new Set([key])).length).toBe(0);
    });

    it('dedups duplicate ENC cardinals at the same spot', () => {
        expect(encCardinalsToHazards([card(153.1, -27.2, 2), card(153.1, -27.2, 2)], new Set()).length).toBe(1);
    });

    it('end-to-end: an East cardinal blocks the WEST side (route passes east)', () => {
        const lon = 153.1;
        const lat = -27.3;
        const haz = encCardinalsToHazards([card(lon, lat, 2)], new Set()); // CATCAM 2 = East
        expect(haz.length).toBe(1);
        const out = orientHazardsTowardLand(haz, [landNorthOf(lon, lat)]) as {
            properties: Record<string, unknown>;
            geometry: { coordinates: [number, number][][] };
        }[];
        const ring = out[0].geometry.coordinates[0];
        const meanLon = ring.reduce((s, [l]) => s + l, 0) / ring.length;
        expect(out[0].properties._cardinalOriented).toBe(true);
        expect(meanLon).toBeLessThan(lon); // disc centred WEST = hazard side of an East cardinal
    });
});
