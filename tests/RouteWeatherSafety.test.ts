import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    findWW3TemporalBracket,
    interpolateWaveConditions,
    requiredWW3ForecastHours,
    sampleWW3Shard,
    validateWW3Metadata,
    validateWW3Shard,
    WW3ValidationError,
} from '../supabase/functions/_shared/ww3';
import {
    alignWeatherKitHours,
    densifyCenterlineForMesh,
    MAX_CENTERLINE_POINTS,
    RouteWeatherSafetyError,
    validateWeatherRouteRequest,
} from '../supabase/functions/_shared/route-weather-safety';

const CYCLE = '2026072400';
const CYCLE_MS = Date.UTC(2026, 6, 24, 0);
const NOW_MS = Date.UTC(2026, 6, 24, 5);

function metadata(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
    return {
        schema_version: 2,
        model: 'NOAA_WW3',
        cycle: CYCLE,
        valid_from: '2026-07-24T00:00:00.000Z',
        valid_to: '2026-07-24T06:00:00.000Z',
        hours_available: [0, 3, 6],
        total_hours: 3,
        bucket: 'ww3-cache',
        file_pattern: `ww3_${CYCLE}_f{HHH}.json`,
        updated_at: '2026-07-24T04:30:00.000Z',
        ...overrides,
    };
}

function shard(
    forecastHour = 0,
    options: {
        explicitAxes?: boolean;
        ascendingLatitude?: boolean;
        missingPeriodIndex?: number;
        heightOffset?: number;
    } = {},
): Record<string, unknown> {
    const nlat = 3;
    const nlon = 360;
    const ascending = options.ascendingLatitude ?? false;
    const lats = ascending ? [-1, 0, 1] : [1, 0, -1];
    const waveHeight = new Array<number>(nlat * nlon);
    const peakPeriod = new Array<number>(nlat * nlon).fill(8 + forecastHour);
    const direction = new Array<number>(nlat * nlon).fill(350);

    for (let row = 0; row < nlat; row++) {
        for (let column = 0; column < nlon; column++) {
            const index = row * nlon + column;
            waveHeight[index] = (options.heightOffset ?? 0) + (lats[row] + 1) * 2 + (column % 10) / 10;
        }
    }
    if (options.missingPeriodIndex !== undefined) {
        peakPeriod[options.missingPeriodIndex] = -9999;
    }

    const explicit = options.explicitAxes ?? false;
    return {
        ...(explicit ? { schema_version: 2, model: 'NOAA_WW3' } : {}),
        cycle: CYCLE,
        forecast_hour: forecastHour,
        valid_time: new Date(CYCLE_MS + forecastHour * 60 * 60 * 1000).toISOString(),
        missing_value: -9999,
        grid: {
            nlat,
            nlon,
            lat_min: -1,
            lat_max: 1,
            lon_min: 0,
            lon_max: 359,
            resolution_deg: explicit ? 1 : -1,
            ...(explicit
                ? {
                      lat_first: lats[0],
                      lat_last: lats[lats.length - 1],
                      lon_first: 0,
                      lon_last: 359,
                      lat_step: ascending ? 1 : -1,
                      lon_step: 1,
                  }
                : {}),
        },
        data: {
            wave_ht_m: waveHeight,
            peak_period_s: peakPeriod,
            wave_dir_deg: direction,
        },
    };
}

function validRequest(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
    return {
        centerline: [
            { lat: -27.47, lon: 153.03, name: 'Brisbane' },
            { lat: -27.14, lon: 153.36, name: 'Moreton Island' },
        ],
        departure_time: '2026-07-24T06:00:00.000Z',
        vessel: {
            type: 'power',
            cruising_speed_kts: 7,
            max_wind_kts: 35,
            max_wave_m: 3,
        },
        corridor_width_nm: 30,
        lateral_steps: 2,
        ...overrides,
    };
}

describe('WW3 cache validation and sampling', () => {
    it('validates fresh metadata and derives exact temporal brackets', () => {
        const parsed = validateWW3Metadata(metadata(), NOW_MS);
        expect(findWW3TemporalBracket(parsed, CYCLE_MS + 90 * 60 * 1000)).toEqual({
            lowerHour: 0,
            upperHour: 3,
            fraction: 0.5,
        });
        expect(requiredWW3ForecastHours(parsed, CYCLE_MS + 60 * 60 * 1000, 4)).toEqual([0, 3, 6]);
    });

    it('rejects stale, gapped, inconsistent, or redirected metadata', () => {
        expect(() => validateWW3Metadata(metadata(), CYCLE_MS + 19 * 60 * 60 * 1000)).toThrow(
            /stale or from the future/,
        );
        expect(() =>
            validateWW3Metadata(
                metadata({ hours_available: [0, 9], total_hours: 2, valid_to: '2026-07-24T09:00:00.000Z' }),
                NOW_MS,
            ),
        ).toThrow(/unsafe temporal gap/);
        expect(() => validateWW3Metadata(metadata({ total_hours: 4 }), NOW_MS)).toThrow(/does not match/);
        expect(() => validateWW3Metadata(metadata({ bucket: 'attacker-controlled' }), NOW_MS)).toThrow(
            /unexpected storage bucket/,
        );
        expect(() => validateWW3Metadata(metadata({ schema_version: 99 }), NOW_MS)).toThrow(/unsupported schema/);
        expect(() => validateWW3Metadata(metadata({ model: 'unknown' }), NOW_MS)).toThrow(/unexpected model/);
    });

    it('samples legacy north-to-south rows and wraps negative longitude onto 0–359', () => {
        const parsed = validateWW3Shard(shard(), CYCLE, 0);
        const sample = sampleWW3Shard(parsed, 0, -1);

        // Latitude 0 is row 1; longitude -1 is the cyclic 359° column.
        expect(sample?.wave_ht_m).toBeCloseTo(2.9, 8);
        expect(sample?.peak_period_s).toBe(8);
        expect(sample?.wave_dir_deg).toBeCloseTo(350, 8);
    });

    it('supports explicit south-to-north axes and bilinear antimeridian interpolation', () => {
        const raw = shard(0, { explicitAxes: true, ascendingLatitude: true });
        const data = (raw.data as { wave_ht_m: number[] }).wave_ht_m;
        // Make the four cells around lat=0.5, lon=359.5 periodic and obvious.
        data[1 * 360 + 359] = 2;
        data[1 * 360] = 4;
        data[2 * 360 + 359] = 6;
        data[2 * 360] = 8;

        const parsed = validateWW3Shard(raw, CYCLE, 0);
        expect(sampleWW3Shard(parsed, 0.5, -0.5)?.wave_ht_m).toBeCloseTo(5, 6);
    });

    it('rejects missing core cells and malformed dimensions rather than returning calm seas', () => {
        const missing = validateWW3Shard(shard(0, { missingPeriodIndex: 1 * 360 + 10 }), CYCLE, 0);
        expect(sampleWW3Shard(missing, 0, 10)).toBeNull();

        const malformed = shard();
        (malformed.grid as { nlon: number }).nlon = 361;
        expect(() => validateWW3Shard(malformed, CYCLE, 0)).toThrow(/longitude axis|exactly 1083 cells/);

        const missingV2Direction = shard(0, { explicitAxes: true });
        delete (missingV2Direction.data as Record<string, unknown>).wave_dir_deg;
        expect(() => validateWW3Shard(missingV2Direction, CYCLE, 0)).toThrow(/wave_dir_deg/);
    });

    it('interpolates wave time and direction through north without a 180° jump', () => {
        expect(
            interpolateWaveConditions(
                { wave_ht_m: 1, peak_period_s: 6, wave_dir_deg: 350 },
                { wave_ht_m: 3, peak_period_s: 10, wave_dir_deg: 10 },
                0.5,
            ),
        ).toEqual({
            wave_ht_m: 2,
            peak_period_s: 8,
            wave_dir_deg: 0,
        });
    });

    it('does not provide a temporal bracket outside advertised model coverage', () => {
        const parsed = validateWW3Metadata(metadata(), NOW_MS);
        expect(findWW3TemporalBracket(parsed, CYCLE_MS - 1)).toBeNull();
        expect(findWW3TemporalBracket(parsed, CYCLE_MS + 7 * 60 * 60 * 1000)).toBeNull();
        expect(() => requiredWW3ForecastHours(parsed, CYCLE_MS + 5 * 60 * 60 * 1000, 2)).toThrow(WW3ValidationError);
    });
});

describe('WeatherKit departure alignment', () => {
    const hours = [
        { forecastStart: '2026-07-24T00:00:00.000Z', windSpeed: 18.52, windGust: 27.78, windDirection: 350 },
        { forecastStart: '2026-07-24T01:00:00.000Z', windSpeed: 37.04, windGust: 46.3, windDirection: 10 },
        { forecastStart: '2026-07-24T02:00:00.000Z', windSpeed: 55.56, windGust: 64.82, windDirection: 30 },
    ];

    it('indexes hour zero from the requested departure, not from now or array index zero', () => {
        const aligned = alignWeatherKitHours(hours, Date.UTC(2026, 6, 24, 0, 30), 1);
        expect(aligned[0].windSpeed).toBeCloseTo(15, 8);
        expect(aligned[0].windGust).toBeCloseTo(20, 8);
        expect(aligned[0].windDir).toBeCloseTo(0, 8);
        expect(aligned[1].windSpeed).toBeCloseTo(25, 8);
        expect(aligned[1].windGust).toBeCloseTo(30, 8);
        expect(aligned[1].windDir).toBeCloseTo(20, 8);
    });

    it('fails when WeatherKit cannot bracket either end instead of extending a last sample', () => {
        expect(() => alignWeatherKitHours(hours, Date.UTC(2026, 6, 23, 23, 30), 1)).toThrow(/does not cover/);
        expect(() => alignWeatherKitHours(hours, Date.UTC(2026, 6, 24, 1, 30), 1)).toThrow(/does not cover/);
    });

    it('rejects missing values and unsafe timestamp gaps', () => {
        expect(() =>
            alignWeatherKitHours(
                [hours[0], { forecastStart: '2026-07-24T01:00:00.000Z', windDirection: 10 }, hours[2]],
                CYCLE_MS,
                1,
            ),
        ).toThrow(RouteWeatherSafetyError);
        expect(() =>
            alignWeatherKitHours(
                [
                    hours[0],
                    { forecastStart: '2026-07-24T03:00:00.000Z', windSpeed: 20, windGust: 25, windDirection: 10 },
                ],
                CYCLE_MS,
                1,
            ),
        ).toThrow(/unsafe time gap/);
        expect(() =>
            alignWeatherKitHours(
                [
                    hours[0],
                    { forecastStart: '2026-07-24T01:00:00.000Z', windSpeed: 20, windGust: 10, windDirection: 10 },
                ],
                CYCLE_MS,
                1,
            ),
        ).toThrow(/below sustained wind/);
    });
});

describe('route-weather request validation', () => {
    it('accepts and normalizes a bounded finite request', () => {
        expect(validateWeatherRouteRequest(validRequest(), NOW_MS)).toEqual(
            expect.objectContaining({
                departure_time: '2026-07-24T06:00:00.000Z',
                vessel: expect.objectContaining({ type: 'power', cruising_speed_kts: 7, draft_m: 2.5 }),
            }),
        );
    });

    it.each([
        [
            'NaN coordinate',
            {
                centerline: [
                    { lat: Number.NaN, lon: 153 },
                    { lat: -27, lon: 154 },
                ],
            },
        ],
        [
            'infinite vessel limit',
            { vessel: { type: 'power', cruising_speed_kts: 7, max_wind_kts: Infinity, max_wave_m: 3 } },
        ],
        ['fractional lateral steps', { lateral_steps: 2.5 }],
        [
            'invalid vessel draft',
            { vessel: { type: 'power', cruising_speed_kts: 7, max_wind_kts: 35, max_wave_m: 3, draft_m: -1 } },
        ],
        ['timezone-free departure', { departure_time: '2026-07-24T06:00:00' }],
        [
            'antimeridian span',
            {
                centerline: [
                    { lat: 0, lon: 179 },
                    { lat: 0, lon: -179 },
                ],
            },
        ],
    ])('rejects %s', (_label, override) => {
        expect(() => validateWeatherRouteRequest(validRequest(override), NOW_MS)).toThrow(RouteWeatherSafetyError);
    });

    it('caps centerline and polar-matrix allocation', () => {
        const tooMany = Array.from({ length: MAX_CENTERLINE_POINTS + 1 }, (_, index) => ({
            lat: -30 + index * 0.001,
            lon: 150,
        }));
        expect(() => validateWeatherRouteRequest(validRequest({ centerline: tooMany }), NOW_MS)).toThrow(/at most/);

        expect(() =>
            validateWeatherRouteRequest(
                validRequest({
                    vessel: {
                        type: 'sail',
                        cruising_speed_kts: 7,
                        max_wind_kts: 35,
                        max_wave_m: 3,
                        polar_data: {
                            windSpeeds: [5, 10],
                            angles: [45, 90],
                            matrix: [[4, 5]],
                        },
                    },
                }),
                NOW_MS,
            ),
        ).toThrow(/row count/);
    });
});

describe('route-weather mesh densification', () => {
    it('adds intermediate forecast rows along a sparse passage', () => {
        const dense = densifyCenterlineForMesh(
            [
                { lat: 0, lon: 0, name: 'Departure' },
                { lat: 0, lon: 1, name: 'Arrival' },
            ],
            20,
            10,
        );

        expect(dense.length).toBeGreaterThan(2);
        expect(dense.length).toBeLessThanOrEqual(20);
        expect(dense[0].name).toBe('Departure');
        expect(dense.at(-1)?.name).toBe('Arrival');
        for (let index = 1; index < dense.length; index++) {
            expect(Math.abs(dense[index].lon - dense[index - 1].lon)).toBeLessThan(0.18);
        }
    });

    it('retains supplied turns while adapting spacing to the hard row budget', () => {
        const turn = { lat: 0, lon: 1, name: 'Required turn' };
        const centerline = [{ lat: 0, lon: 0 }, turn, { lat: 0, lon: 2 }];
        const dense = densifyCenterlineForMesh(centerline, 9, 10);

        expect(dense.length).toBeLessThanOrEqual(9);
        expect(dense).toContainEqual(turn);
        for (let index = 1; index < dense.length; index++) {
            expect(Math.abs(dense[index].lon - dense[index - 1].lon)).toBeLessThan(0.34);
        }
        expect(() => densifyCenterlineForMesh(centerline, 2)).toThrow(/mesh limit/);
        expect(() =>
            densifyCenterlineForMesh(
                [
                    { lat: 0, lon: 0 },
                    { lat: 0, lon: 10 },
                    { lat: 10, lon: 10 },
                ],
                5,
                10,
            ),
        ).toThrow(/forecast rows within/);
    });
});

describe('route-weather fail-safe source guards', () => {
    const source = readFileSync(resolve(process.cwd(), 'supabase/functions/route-weather/index.ts'), 'utf8');
    const precache = readFileSync(resolve(process.cwd(), 'backend/ww3_precache.py'), 'utf8');
    const weatherKitProxy = readFileSync(
        resolve(process.cwd(), 'supabase/functions/fetch-weatherkit/index.ts'),
        'utf8',
    );
    const clientRouter = readFileSync(resolve(process.cwd(), 'services/weatherRouter.ts'), 'utf8');

    it('contains no raw-GRIB/discard or invented-sea fallback', () => {
        expect(source).not.toContain('filter_wave_multi');
        expect(source).not.toContain('Pierson-Moskowitz');
        expect(source).not.toContain('using wind-only routing');
        expect(source).toContain('validateWW3Shard');
        expect(source).toContain('wave_forecast_unavailable');
    });

    it('cannot disable land, double skipper limits, or synthesize a direct route on A* failure', () => {
        expect(source).not.toContain('retrying with land disabled');
        expect(source).not.toContain('relaxed vessel limits');
        expect(source).not.toContain('using direct centerline');
        expect(source).toContain("code: 'no_safe_route'");
        expect(clientRouter).not.toContain('fallback_centerline');
        expect(clientRouter).not.toContain('wind_spd_kts: 0');
    });

    it('keeps elevation request-local and protects simplified shortcuts and forecast horizon', () => {
        expect(source).not.toContain('_elevationCache');
        expect(source).toContain('densifyCenterlineForMesh(centerline, maxMeshRows)');
        expect(source).toContain('const minimumSafeDepthM = vessel.draft_m + 1');
        expect(source).toContain('node.depth_m = elev');
        expect(source).toContain('const traversal = evaluateEdgeTraversal(');
        expect(source).toContain('const MAX_SLICE_DISTANCE_NM = 2');
        expect(source).toContain('const MAX_SLICE_DURATION_H = 0.5');
        expect(source).toContain('arrivalWeather = interpolateWeather(');
        expect(source).toContain('wave.wave_dir_deg === undefined');
        expect(source).toContain('const waveAngle = trueWindAngle(courseBearing, weather.waveDirection)');
        expect(source).toContain('Math.max(tws, gust) > vessel.max_wind_kts');
        expect(source).not.toContain('return Math.max(speed, 0.1)');
        expect(source).toContain('vessel.cruising_speed_kts / TAYANA55_MAX_POLAR_SPEED_KTS');
        expect(source).toContain('if (!vessel.polar_data) return vessel.cruising_speed_kts');
        expect(source).toContain('interpolatePolar(polars, angle, tws, !vessel.polar_data)');
        expect(source).toContain('current.gCost > gCost[current.nodeId]');
        expect(source).not.toContain('gCost[current.nodeId] + 0.001');
        expect(source).toContain('col - 1');
        expect(source).not.toContain('Connect to ALL nodes in the next row');
        expect(source).toContain('const verifiedPath = result.path');
        expect(source).not.toContain('simplifyPath(result.path');
        expect(source).toContain('segmentCrossesLand(elevationGrid');
        expect(source).toContain('newGTime > weatherGrid.hoursAvailable');
    });

    it('rate-limits the expensive route and reserves the WeatherKit fan-out for an exact service-role call', () => {
        expect(source).toContain("requireAuthenticatedOrPublicQuota(req, 'route_weather'");
        expect(source).toContain("'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey'");
        expect(source).toContain('apikey: serviceRoleKey');
        expect(weatherKitProxy).toContain('isTrustedInternalCall');
        expect(weatherKitProxy).toContain('`Bearer ${serviceRoleKey}`');
        expect(weatherKitProxy).toContain("requireAuthenticatedOrPublicQuota(req, 'weatherkit'");
    });

    it('publishes explicit orientation and missing-value metadata from the pre-cache pipeline', () => {
        expect(precache).toContain("'schema_version': 2");
        expect(precache).toContain("'missing_value': MISSING_VALUE");
        expect(precache).toContain("'lat_first':");
        expect(precache).toContain("'lat_step':");
        expect(precache).toContain("'lon_first':");
        expect(precache).toContain("'lon_step':");
        expect(precache).not.toContain('nan=0.0');
        expect(precache).toContain('filter_gfswave.pl');
        expect(precache).toContain('gfswave.t{cycle_hour}z.global.0p25');
        expect(precache).not.toContain('filter_wave_multi.pl');
        expect(precache).toContain('MAX_GRIB_BYTES');
        expect(precache).toContain('if successful_hours == FORECAST_HOURS and not dry_run:');
        expect(precache).toContain('return len(failed_hours) == 0 and metadata_ok');
    });
});

describe('WW3 browser cache client integration', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.useFakeTimers();
        vi.setSystemTime(NOW_MS);
        vi.stubEnv('VITE_SUPABASE_URL', 'https://thalassa.example');
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllEnvs();
        vi.unstubAllGlobals();
    });

    it('temporally brackets two validated shards instead of selecting a nearest frame', async () => {
        const fetchMock = vi.fn(async (input: string | URL | Request) => {
            const url = String(input);
            if (url.includes('/ww3_latest.json')) {
                return new Response(JSON.stringify(metadata()));
            }
            if (url.endsWith('_f000.json')) {
                return new Response(JSON.stringify(shard(0)));
            }
            if (url.endsWith('_f003.json')) {
                return new Response(JSON.stringify(shard(3, { heightOffset: 3 })));
            }
            return new Response(null, { status: 404 });
        });
        vi.stubGlobal('fetch', fetchMock);

        const { sampleWaveAt } = await import('../services/ww3CacheClient');
        const sample = await sampleWaveAt(0, -1, 1.5);

        expect(sample?.wave_ht_m).toBeCloseTo(4.4, 8);
        expect(sample?.peak_period_s).toBeCloseTo(9.5, 8);
        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual(
            expect.arrayContaining([expect.stringContaining('_f000.json'), expect.stringContaining('_f003.json')]),
        );
    });

    it('normalizes north-to-south and 0–359 shards for the south-to-north, −180–179 render grid', async () => {
        const fetchMock = vi.fn(async (input: string | URL | Request) => {
            const url = String(input);
            if (url.includes('/ww3_latest.json')) {
                return new Response(JSON.stringify(metadata()));
            }
            if (url.endsWith('_f000.json')) {
                return new Response(JSON.stringify(shard(0)));
            }
            if (url.endsWith('_f003.json')) {
                return new Response(JSON.stringify(shard(3)));
            }
            return new Response(null, { status: 404 });
        });
        vi.stubGlobal('fetch', fetchMock);

        const { fetchWW3Grid } = await import('../services/ww3CacheClient');
        const grid = await fetchWW3Grid(3);

        expect(grid).toEqual(
            expect.objectContaining({
                lats: [-1, 0, 1],
                south: -1,
                north: 1,
                west: -180,
                east: 179,
                totalHours: 2,
                stepHours: [0, 3],
                refTime: '2026-07-24T00:00:00.000Z',
            }),
        );
        expect(grid?.speed[0]).toHaveLength(1080);
        expect(grid?.landMask).toHaveLength(1080);
        expect(grid?.landMask?.some((cell) => cell !== 0)).toBe(false);
    });
});
