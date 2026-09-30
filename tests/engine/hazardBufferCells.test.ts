/**
 * A charted point hazard blocks every cell its buffer touches (fix-up,
 * 2026-09-30).
 *
 * navGrid Pass 3 tested each cell's CENTRE against the 30 m obstruction
 * buffer. A 50 m cell's half-diagonal is 35.4 m, so a wreck charted exactly at
 * a cell corner blocked no cell at all, and a route passed 25 m from it —
 * inside its own buffer. Decision 7's tails now run through shallow water,
 * where rocks and wrecks cluster.
 */
import type { Feature, FeatureCollection } from 'geojson';
import { describe, expect, it } from 'vitest';
import { buildNavGrid } from '../../services/engine/navGrid';
import type { InshoreLayers } from '../../services/engine/types';

const fc = (...features: Feature[]): FeatureCollection => ({ type: 'FeatureCollection', features });
const point = (lon: number, lat: number, props: Record<string, unknown>): Feature => ({
    type: 'Feature',
    properties: props,
    geometry: { type: 'Point', coordinates: [lon, lat] },
});
const BBOX: [number, number, number, number] = [152.49, -27.92, 152.53, -27.88];
const deep: Feature = {
    type: 'Feature',
    properties: { acronym: 'DEPARE', DRVAL1: 10, DRVAL2: 20 },
    geometry: {
        type: 'Polygon',
        coordinates: [
            [
                [152.49, -27.92],
                [152.53, -27.92],
                [152.53, -27.88],
                [152.49, -27.88],
                [152.49, -27.92],
            ],
        ],
    },
};

describe('Pass 3 — a point hazard blocks every cell its buffer touches', () => {
    const empty = buildNavGrid({ DEPARE: fc(deep) } as InshoreLayers, BBOX, 50, 2.4, 1, 30);
    // A cell corner well inside the grid.
    const cx = 30;
    const cy = 30;
    const cornerLon = empty.minLon + cx * empty.dLon;
    const cornerLat = empty.minLat + cy * empty.dLat;

    for (const layer of ['WRECKS', 'UWTROC', 'OBSTRN'] as const) {
        it(`${layer} at a cell corner blocks the four cells that share it`, () => {
            const g = buildNavGrid(
                { DEPARE: fc(deep), [layer]: fc(point(cornerLon, cornerLat, { acronym: layer })) } as InshoreLayers,
                BBOX,
                50,
                2.4,
                1,
                30,
            );
            for (const [x, y] of [
                [cx - 1, cy - 1],
                [cx, cy - 1],
                [cx - 1, cy],
                [cx, cy],
            ]) {
                expect(Number.isNaN(g.cells[y * g.width + x]), `cell ${x},${y}`).toBe(true);
            }
            // …and not cells its 30 m buffer never reaches.
            expect(Number.isNaN(g.cells[(cy + 1) * g.width + (cx + 1)])).toBe(false);
        });
    }

    it('a hazard mid-cell blocks its own cell and the neighbours within 30 m of it', () => {
        const lon = empty.minLon + (cx + 0.5) * empty.dLon;
        const lat = empty.minLat + (cy + 0.5) * empty.dLat;
        const g = buildNavGrid(
            { DEPARE: fc(deep), WRECKS: fc(point(lon, lat, { acronym: 'WRECKS' })) } as InshoreLayers,
            BBOX,
            50,
            2.4,
            1,
            30,
        );
        const blocked = (x: number, y: number) => Number.isNaN(g.cells[y * g.width + x]);
        expect(blocked(cx, cy)).toBe(true);
        // 25 m to each edge neighbour's square, 35.4 m to a diagonal one.
        expect(blocked(cx + 1, cy) && blocked(cx - 1, cy) && blocked(cx, cy + 1) && blocked(cx, cy - 1)).toBe(true);
        expect(blocked(cx + 1, cy + 1)).toBe(false);
    });
});
