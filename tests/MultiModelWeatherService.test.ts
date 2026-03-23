/**
 * MultiModelWeatherService — Unit tests
 *
 * Tests the pure functions: recommendModels, getModelById, AVAILABLE_MODELS
 * and the queryMultiModel orchestrator with mocked fetch.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    recommendModels,
    getModelById,
    AVAILABLE_MODELS,
    queryMultiModel,
    type WeatherModelId,
} from '../services/weather/MultiModelWeatherService';

// ── recommendModels ──────────────────────────────────────────

describe('recommendModels', () => {
    it('always includes GFS and ECMWF as baseline', () => {
        const models = recommendModels(0, 0);
        expect(models).toContain('gfs');
        expect(models).toContain('ecmwf');
    });

    it('adds ACCESS-G for Australian waters', () => {
        // Sydney: lat -33.868, lon 151.209
        const models = recommendModels(-33.868, 151.209);
        expect(models).toContain('access_g');
    });

    it('does not add ACCESS-G for North Atlantic', () => {
        // Azores: lat 38.7, lon -27.2
        const models = recommendModels(38.7, -27.2);
        expect(models).not.toContain('access_g');
    });

    it('adds ICON for European/Mediterranean waters', () => {
        // Gibraltar: lat 36, lon -5.3
        const models = recommendModels(36, -5.3);
        expect(models).toContain('icon');
    });

    it('adds GEM for Pacific', () => {
        // Mid-Pacific: lat 0, lon -160
        const models = recommendModels(0, -160);
        expect(models).toContain('gem');
    });

    it('does not duplicate models', () => {
        const models = recommendModels(-30, 160); // Australian + Pacific overlap
        const unique = new Set(models);
        expect(unique.size).toBe(models.length);
    });

    it('returns at least 2 models for any location', () => {
        for (const [lat, lon] of [
            [0, 0],
            [-60, 0],
            [70, 100],
            [-45, -170],
        ]) {
            expect(recommendModels(lat, lon).length).toBeGreaterThanOrEqual(2);
        }
    });
});

// ── getModelById ─────────────────────────────────────────────

describe('getModelById', () => {
    it('returns model info for valid ID', () => {
        const model = getModelById('gfs');
        expect(model).toBeDefined();
        expect(model!.name).toBe('GFS');
        expect(model!.provider).toBe('NOAA');
    });

    it('returns undefined for invalid ID', () => {
        expect(getModelById('nonexistent' as WeatherModelId)).toBeUndefined();
    });

    it('finds all AVAILABLE_MODELS by ID', () => {
        for (const model of AVAILABLE_MODELS) {
            expect(getModelById(model.id)).toBe(model);
        }
    });
});

// ── AVAILABLE_MODELS ─────────────────────────────────────────

describe('AVAILABLE_MODELS', () => {
    it('has all expected models', () => {
        const ids = AVAILABLE_MODELS.map((m) => m.id);
        expect(ids).toContain('gfs');
        expect(ids).toContain('ecmwf');
        expect(ids).toContain('icon');
        expect(ids).toContain('access_g');
        expect(ids).toContain('gem');
    });

    it('every model has an openMeteoModel string', () => {
        for (const model of AVAILABLE_MODELS) {
            expect(model.openMeteoModel).toBeTruthy();
            expect(typeof model.openMeteoModel).toBe('string');
        }
    });
});

// ── queryMultiModel ──────────────────────────────────────────

describe('queryMultiModel', () => {
    const mockWindData = {
        hourly: {
            time: ['2024-01-01T00:00', '2024-01-01T01:00'],
            wind_speed_10m: [20, 25],
            wind_direction_10m: [180, 190],
            wind_gusts_10m: [30, 35],
            pressure_msl: [1013, 1012],
        },
    };
    const mockWaveData = {
        hourly: {
            wave_height: [1.5, 2.0],
        },
    };

    beforeEach(() => {
        vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: string | URL | Request) => {
            const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
            if (urlStr.includes('marine')) {
                return new Response(JSON.stringify(mockWaveData), { status: 200 });
            }
            return new Response(JSON.stringify(mockWindData), { status: 200 });
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('returns null for empty waypoints', async () => {
        const result = await queryMultiModel([]);
        expect(result).toBeNull();
    });

    it('returns result with correct structure', async () => {
        const result = await queryMultiModel([{ lat: -33.868, lon: 151.209, name: 'Sydney' }], ['gfs'], 48);

        expect(result).not.toBeNull();
        expect(result!.waypoints.length).toBe(1);
        expect(result!.models.length).toBe(1);
        expect(result!.forecastHours).toBe(48);
        expect(result!.queryTime).toBeTruthy();
        expect(result!.elapsed_ms).toBeGreaterThanOrEqual(0);
    });

    it('includes consensus metrics for each waypoint', async () => {
        const result = await queryMultiModel([{ lat: 0, lon: 0 }], ['gfs', 'ecmwf']);

        expect(result).not.toBeNull();
        const wp = result!.waypoints[0];
        expect(wp.consensus).toBeDefined();
        expect(wp.consensus.confidence).toMatch(/high|medium|low/);
        expect(typeof wp.consensus.windSpeedMean).toBe('number');
        expect(typeof wp.consensus.windSpeedSpread).toBe('number');
    });

    it('decimates waypoints when > 20', async () => {
        const manyWaypoints = Array.from({ length: 30 }, (_, i) => ({
            lat: i,
            lon: i,
        }));

        const result = await queryMultiModel(manyWaypoints, ['gfs']);

        expect(result).not.toBeNull();
        // Should be decimated to 20
        expect(result!.waypoints.length).toBe(20);
    });

    it('handles fetch failure gracefully', async () => {
        vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network error'));

        const result = await queryMultiModel([{ lat: 0, lon: 0 }], ['gfs']);

        // Should return result with empty forecasts, not crash
        expect(result).not.toBeNull();
    });
});
