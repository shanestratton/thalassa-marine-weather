/**
 * Weather Pipeline Integration Tests
 *
 * Tests the full data flow from WindGrid → createWindFieldFromGrid → WindField
 * and ModelSource[] → createEnsembleWindField → ensemble metrics.
 */

import { describe, it, expect } from 'vitest';
import type { WindGrid } from '../services/weather/windField';
import {
    createWindFieldFromGrid,
    createEnsembleWindField,
    type ModelSource,
} from '../services/weather/WindFieldAdapter';
import { recommendModels, getModelById, AVAILABLE_MODELS } from '../services/weather/MultiModelWeatherService';

// ── Helper: build a minimal WindGrid ─────────────────────────

function makeGrid(
    speed: number,
    dirDeg: number, // meteorological "from" direction
    opts: Partial<WindGrid> = {},
): WindGrid {
    const height = 3;
    const width = 3;
    const totalHours = 2;

    // Convert "from" direction to U/V (blowing-TO convention used by grid)
    const dirRad = ((dirDeg + 180) * Math.PI) / 180;
    const speedMs = speed / 1.94384; // kts → m/s
    const uVal = speedMs * Math.sin(dirRad);
    const vVal = speedMs * Math.cos(dirRad);

    const u: Float32Array[] = [];
    const v: Float32Array[] = [];
    const spd: Float32Array[] = [];

    for (let h = 0; h < totalHours; h++) {
        const uArr = new Float32Array(height * width);
        const vArr = new Float32Array(height * width);
        const sArr = new Float32Array(height * width);
        for (let i = 0; i < height * width; i++) {
            uArr[i] = uVal;
            vArr[i] = vVal;
            sArr[i] = speedMs;
        }
        u.push(uArr);
        v.push(vArr);
        spd.push(sArr);
    }

    return {
        u,
        v,
        speed: spd,
        width,
        height,
        lats: [-34, -33, -32],
        lons: [150, 151, 152],
        north: -32,
        south: -34,
        west: 150,
        east: 152,
        totalHours,
        ...opts,
    };
}

// ── createWindFieldFromGrid ──────────────────────────────────

describe('createWindFieldFromGrid', () => {
    it('returns null wind outside grid bounds', () => {
        const grid = makeGrid(15, 180);
        const wf = createWindFieldFromGrid(grid);
        // Query lat 0, lon 0 — way outside -34 to -32, 150 to 152
        expect(wf.getWind(0, 0, 0)).toBeNull();
    });

    it('returns wind inside grid bounds', () => {
        const grid = makeGrid(15, 180); // 15 kts from south
        const wf = createWindFieldFromGrid(grid);
        const wind = wf.getWind(-33, 151, 0);
        expect(wind).not.toBeNull();
        expect(wind!.speed).toBeGreaterThan(0);
    });

    it('preserves approximate speed', () => {
        const grid = makeGrid(20, 180);
        const wf = createWindFieldFromGrid(grid);
        const wind = wf.getWind(-33, 151, 0);
        expect(wind).not.toBeNull();
        // Should be approximately 20 kts (m/s → kts roundtrip may lose precision)
        expect(wind!.speed).toBeCloseTo(20, 0);
    });

    it('preserves approximate direction', () => {
        const grid = makeGrid(15, 270); // from west
        const wf = createWindFieldFromGrid(grid);
        const wind = wf.getWind(-33, 151, 0);
        expect(wind).not.toBeNull();
        // Direction should be approximately 270°
        expect(Math.abs(wind!.direction - 270)).toBeLessThan(5);
    });

    it('interpolates between time steps', () => {
        const grid = makeGrid(15, 180);
        const wf = createWindFieldFromGrid(grid);
        const wind = wf.getWind(-33, 151, 0.5); // half-hour
        expect(wind).not.toBeNull();
        expect(wind!.speed).toBeGreaterThan(0);
    });
});

// ── createEnsembleWindField ──────────────────────────────────

describe('createEnsembleWindField', () => {
    it('returns null when no sources provided', () => {
        const { windField } = createEnsembleWindField([]);
        expect(windField.getWind(-33, 151, 0)).toBeNull();
    });

    it('returns wind from a single model', () => {
        const sources: ModelSource[] = [
            {
                name: 'GFS',
                grid: makeGrid(15, 180),
            },
        ];
        const { windField } = createEnsembleWindField(sources);
        const wind = windField.getWind(-33, 151, 0);
        expect(wind).not.toBeNull();
        expect(wind!.speed).toBeCloseTo(15, 0);
    });

    it('averages speed across two models', () => {
        const sources: ModelSource[] = [
            { name: 'GFS', grid: makeGrid(10, 180) },
            { name: 'ECMWF', grid: makeGrid(20, 180) },
        ];
        const { windField } = createEnsembleWindField(sources);
        const wind = windField.getWind(-33, 151, 0);
        expect(wind).not.toBeNull();
        expect(wind!.speed).toBeCloseTo(15, 0);
    });

    it('getEnsembleWind provides spread metrics', () => {
        const sources: ModelSource[] = [
            { name: 'GFS', grid: makeGrid(10, 180) },
            { name: 'ECMWF', grid: makeGrid(20, 190) },
            { name: 'ICON', grid: makeGrid(15, 170) },
        ];
        const { getEnsembleWind } = createEnsembleWindField(sources);
        const ensemble = getEnsembleWind(-33, 151, 0);
        expect(ensemble).not.toBeNull();
        expect(ensemble!.models.length).toBe(3);
        expect(ensemble!.spread).toBeGreaterThan(0);
        expect(ensemble!.directionSpread).toBeGreaterThanOrEqual(0);
        expect(['high', 'medium', 'low']).toContain(ensemble!.confidence);
    });

    it('getEnsembleWind returns null outside grid', () => {
        const sources: ModelSource[] = [{ name: 'GFS', grid: makeGrid(15, 180) }];
        const { getEnsembleWind } = createEnsembleWindField(sources);
        expect(getEnsembleWind(0, 0, 0)).toBeNull();
    });

    it('respects model weights', () => {
        const sources: ModelSource[] = [
            { name: 'GFS', grid: makeGrid(10, 180), weight: 2.0 },
            { name: 'ECMWF', grid: makeGrid(20, 180), weight: 1.0 },
        ];
        const { getEnsembleWind } = createEnsembleWindField(sources);
        const ensemble = getEnsembleWind(-33, 151, 0);
        expect(ensemble).not.toBeNull();
        // Weighted: (10*2 + 20*1) / 3 ≈ 13.3 kts
        expect(ensemble!.speed).toBeLessThan(15); // Skewed towards 10
    });
});

// ── Model Recommendation Pipeline ────────────────────────────

describe('Model recommendation → lookup pipeline', () => {
    it('recommended models resolve to valid entries', () => {
        const ids = recommendModels(-33.868, 151.209);
        for (const id of ids) {
            const model = getModelById(id);
            expect(model).toBeDefined();
            expect(model!.openMeteoModel).toBeTruthy();
        }
    });

    it('Australian waters include ACCESS-G', () => {
        const ids = recommendModels(-33.868, 151.209);
        expect(ids).toContain('access_g');
    });

    it('all model IDs are unique', () => {
        const ids = AVAILABLE_MODELS.map((m) => m.id);
        expect(new Set(ids).size).toBe(ids.length);
    });
});
