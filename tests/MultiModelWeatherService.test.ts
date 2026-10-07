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
import {
    LIVENESS_PROBE_HOURS,
    modelLiveness,
    probeModelLiveness,
    resetModelLivenessForTests,
} from '../services/weather/modelLiveness';

/** Fictional route midpoints, one per ocean the app is used in. */
const MIDPOINTS: Record<string, [number, number]> = {
    med: [36, -5.3],
    caribbean: [13.0, -61.2],
    pacific: [-17.5, -149.6],
    northSea: [56, 3],
    usWest: [37.8, -122.6],
    queensland: [-20.27, 148.72],
    tasman: [-33.868, 151.209],
    fiji: [-17.7, 178.1],
};

/** A proxy reply carrying `values` as this model's 10 m wind for the probe's day. */
function windReply(values: (number | null)[]): Response {
    return new Response(
        JSON.stringify({ hourly: { time: values.map((_, i) => 1_791_331_200 + i * 3600), wind_speed_10m: values } }),
        { status: 200 },
    );
}
const liveDay = () => Array.from({ length: LIVENESS_PROBE_HOURS }, () => 12);
const deadDay = () => Array.from({ length: LIVENESS_PROBE_HOURS }, () => null);

// ── recommendModels ──────────────────────────────────────────

describe('recommendModels', () => {
    beforeEach(() => {
        localStorage.clear();
        resetModelLivenessForTests();
        // Any background liveness probe this starts gets a dead (all-null) day,
        // which is what ACCESS-G has really answered since June 2025.
        vi.spyOn(globalThis, 'fetch').mockImplementation(async () => windReply(deadDay()));
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('always includes GFS and ECMWF as baseline', () => {
        const models = recommendModels(0, 0);
        expect(models).toContain('gfs');
        expect(models).toContain('ecmwf');
    });

    // BOM suspended ACCESS-G open data in June 2025: every value has been null
    // everywhere since. It used to be added for any SW-Pacific midpoint, so
    // AU, NZ and Pacific-island voyage comparisons carried a dead member.
    it.each(['tasman', 'queensland', 'fiji'])('does not offer ACCESS-G at %s while its feed is unproven', (name) => {
        const [lat, lon] = MIDPOINTS[name];
        expect(recommendModels(lat, lon)).not.toContain('access_g');
    });

    it('starts a background probe of the 10 m wind instead, without waiting for it', async () => {
        const fetchSpy = vi.mocked(globalThis.fetch);
        const [lat, lon] = MIDPOINTS.tasman;
        const models = recommendModels(lat, lon); // synchronous — nothing awaited
        expect(models).toEqual(expect.arrayContaining(['gfs', 'ecmwf']));
        await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
        const body = JSON.parse(String((fetchSpy.mock.calls[0][1] as RequestInit).body)) as {
            params: Record<string, string>;
        };
        expect(body.params.models).toBe('bom_access_global');
        expect(body.params.hourly).toBe('wind_speed_10m');
        await vi.waitFor(() => expect(modelLiveness('bom_access_global')).toBe('dead'));
        expect(recommendModels(lat, lon)).not.toContain('access_g');
        // Today's verdict stands: no second probe.
        expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('offers ACCESS-G once today’s probe has seen real wind', async () => {
        vi.mocked(globalThis.fetch).mockImplementation(async () => windReply(liveDay()));
        const [lat, lon] = MIDPOINTS.fiji;
        await probeModelLiveness('bom_access_global', { lat, lon });
        expect(recommendModels(lat, lon)).toContain('access_g');
        expect(recommendModels(...MIDPOINTS.tasman)).toContain('access_g');
    });

    it.each(['med', 'caribbean', 'northSea', 'usWest'])('never adds ACCESS-G at %s', (name) => {
        expect(recommendModels(...MIDPOINTS[name])).not.toContain('access_g');
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

    it('describes ACCESS-G as the global model it is, not an Australian one', () => {
        // It is BOM's GLOBAL model at 0.15° (about 15 km); the old copy said
        // '0.15° Australia' and 'best for Australian waters'.
        const accessG = getModelById('access_g')!;
        expect(accessG.openMeteoModel).toBe('bom_access_global');
        expect(accessG.resolution).toBe('0.15°');
        expect(accessG.description).toMatch(/global/i);
        expect(`${accessG.description} ${accessG.bestFor}`).not.toMatch(/Australian waters|best for Oz/i);
    });

    it('gives ECMWF the grid it is actually fetched on (ecmwf_ifs025 is 0.25°)', () => {
        const ecmwf = getModelById('ecmwf')!;
        expect(ecmwf.openMeteoModel).toBe('ecmwf_ifs025');
        expect(ecmwf.resolution).toBe('0.25°');
        expect(ecmwf.description).not.toMatch(/highest resolution/i);
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
        vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
            const request = JSON.parse(String(init?.body)) as {
                operation: 'forecast' | 'marine';
                params: { latitude: string };
            };
            const count = request.params.latitude.split(',').length;
            const row = request.operation === 'marine' ? mockWaveData : mockWindData;
            return new Response(JSON.stringify(Array.from({ length: count }, () => row)), { status: 200 });
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
