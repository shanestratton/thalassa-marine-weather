import { describe, expect, it } from 'vitest';
import { buildNavGrid } from '../services/engine/navGrid';
import type { InshoreLayers } from '../services/engine/types';
import type { FeatureCollection } from 'geojson';

// A small marina basin (leisure=marina, authoritative 5 m water) with two
// parallel finger-pontoon rows ~44 m apart and a fairway lane between them.
const BBOX: [number, number, number, number] = [153.1288, -26.6862, 153.1312, -26.6838];

const marina: FeatureCollection = {
    type: 'FeatureCollection',
    features: [
        {
            type: 'Feature',
            properties: { leisure: 'marina', DRVAL1: 5.0, DRVAL2: 5.0, _source: 'osm' },
            geometry: {
                type: 'Polygon',
                coordinates: [
                    [
                        [153.129, -26.686],
                        [153.131, -26.686],
                        [153.131, -26.684],
                        [153.129, -26.684],
                        [153.129, -26.686],
                    ],
                ],
            },
        },
    ],
};

const berths: FeatureCollection = {
    type: 'FeatureCollection',
    features: [
        {
            type: 'Feature',
            properties: { man_made: 'pier', name: 'A' },
            geometry: {
                type: 'LineString',
                coordinates: [
                    [153.1294, -26.6852],
                    [153.1306, -26.6852],
                ],
            },
        },
        {
            type: 'Feature',
            properties: { man_made: 'pier', name: 'B' },
            geometry: {
                type: 'LineString',
                coordinates: [
                    [153.1294, -26.6848],
                    [153.1306, -26.6848],
                ],
            },
        },
    ],
};

const layers = (withBerths: boolean): InshoreLayers => ({
    DEPARE: marina,
    ...(withBerths ? { BERTH: berths } : {}),
});

const cellIdx = (grid: ReturnType<typeof buildNavGrid>, lon: number, lat: number): number => {
    const x = Math.floor((lon - grid.minLon) / grid.dLon);
    const y = Math.floor((lat - grid.minLat) / grid.dLat);
    return y * grid.width + x;
};
const isLand = (grid: ReturnType<typeof buildNavGrid>, lon: number, lat: number): boolean =>
    grid.landBlocked ? grid.landBlocked[cellIdx(grid, lon, lat)] === 1 : false;

const ON_BERTH = { lon: 153.13, lat: -26.6852 }; // on finger A
const IN_LANE = { lon: 153.13, lat: -26.685 }; // fairway between A and B

describe('marina berth carve (fine-res only)', () => {
    it('hard-blocks the pontoon rows at fine resolution, keeps the fairway lane open', () => {
        const grid = buildNavGrid(layers(true), BBOX, 12, 2.4, 0.5, 60);
        expect(isLand(grid, ON_BERTH.lon, ON_BERTH.lat)).toBe(true); // pontoon = land
        expect(isLand(grid, IN_LANE.lon, IN_LANE.lat)).toBe(false); // lane stays navigable
    });

    it('carves the pontoon rows at coarse resolution too — the tier-2 fairlead reach', () => {
        const grid = buildNavGrid(layers(true), BBOX, 50, 2.4, 0.5, 60);
        // A riverside marina reach is routed by tier-2 fairlead on the COARSE
        // grid, which validates its lateral-mark path against the land mask — so
        // the pontoons must block HERE too, else the route drives over the pens
        // (Mooloolaba 2026-07-06). Endpoint snapToNavigable keeps a berth-start
        // reachable even where a tight basin collapses at 50 m.
        expect(isLand(grid, ON_BERTH.lon, ON_BERTH.lat)).toBe(true);
    });

    it('no berths ⇒ the pontoon cells stay open (today’s behaviour, no regression)', () => {
        const grid = buildNavGrid(layers(false), BBOX, 12, 2.4, 0.5, 60);
        expect(isLand(grid, ON_BERTH.lon, ON_BERTH.lat)).toBe(false);
    });
});
