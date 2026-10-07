import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const routing = vi.hoisted(() => ({
    resolveRoutingPolar: vi.fn(),
    warn: vi.fn(),
}));
vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: routing.warn, error: vi.fn() }),
}));
// The real toEdgePolar; only the resolver's store reads are replaced (W1-03).
vi.mock('../services/routingPolar', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../services/routingPolar')>()),
    resolveRoutingPolar: routing.resolveRoutingPolar,
}));

import { resolveRoutingPolarFrom, toEdgePolar } from '../services/routingPolar';
import { supabase } from '../services/supabase';
import {
    enhanceVoyagePlanWithWeather,
    fetchWeatherRoute,
    getSpatiotemporalPayload,
    mergeWeatherRoute,
} from '../services/weatherRouter';
import type { VoyagePlan } from '../types';
import type { SpatiotemporalPayload } from '../types/spatiotemporal';
import type { VesselProfile } from '../types/vessel';

const vessel: VesselProfile = {
    name: 'Thalassa',
    type: 'power',
    length: 12,
    beam: 4,
    draft: 1.2,
    displacement: 9000,
    // FEET, like every other profile dimension. This said 3, which reads as a
    // sensible 3 m ceiling and is actually 0.91 m — below the 2 m seas in the
    // payload fixture below. That the fixture was authored in metres is the
    // same confusion that produced the bug this file now guards.
    maxWaveHeight: 10,
    maxWindSpeed: 30,
    cruisingSpeed: 6,
};

const voyagePlan: VoyagePlan = {
    origin: 'Brisbane',
    destination: 'Moreton Island',
    departureDate: '2026-07-23',
    originCoordinates: { lat: -27.47, lon: 153.03 },
    destinationCoordinates: { lat: -27.14, lon: 153.36 },
    distanceApprox: '—',
    durationApprox: '—',
    overview: 'Test passage',
    waypoints: [],
};

function payload(totalDurationHours = 27): SpatiotemporalPayload {
    return {
        summary: {
            total_distance_nm: 42.6,
            total_duration_hours: totalDurationHours,
            cost_score: 17,
            computation_ms: 40,
            routing_mode: 'verified_weather_corridor',
            vessel_type: 'power',
            departure_time: '2026-07-23T00:00:00.000Z',
        },
        bounding_box: [153.03, -27.47, 153.36, -27.14],
        track: [
            {
                coordinates: [153.03, -27.47],
                distance_from_start_nm: 0,
                time_offset_hours: 0,
                name: 'Brisbane',
                lateral_offset_nm: 0,
                conditions: {
                    depth_m: -8,
                    wind_spd_kts: 12,
                    wind_gust_kts: 16,
                    wind_dir_deg: 90,
                    wave_ht_m: 0.8,
                    wave_dir_deg: 120,
                    swell_period_s: 6,
                },
            },
            {
                coordinates: [153.2, -27.3],
                distance_from_start_nm: 20,
                time_offset_hours: 4,
                name: '',
                lateral_offset_nm: 0.2,
                conditions: {
                    depth_m: -4,
                    wind_spd_kts: 14.4,
                    wind_gust_kts: 18,
                    wind_dir_deg: 100,
                    wave_ht_m: 2,
                    wave_dir_deg: 130,
                    swell_period_s: 7,
                },
            },
            {
                coordinates: [153.36, -27.14],
                distance_from_start_nm: 42.6,
                time_offset_hours: totalDurationHours,
                name: 'Moreton Island',
                lateral_offset_nm: 0,
                conditions: {
                    depth_m: -6,
                    wind_spd_kts: 10,
                    wind_gust_kts: 14,
                    wind_dir_deg: 110,
                    wave_ht_m: 1,
                    wave_dir_deg: 140,
                    swell_period_s: 7,
                },
            },
        ],
        mesh_stats: {
            total_nodes: 120,
            rows: 24,
            cols: 5,
            corridor_width_nm: 30,
            weather_grid_points: 80,
            forecast_hours: 48,
        },
        weather_sources: {
            wind: {
                model: 'Apple WeatherKit forecastHourly',
                aligned_from: '2026-07-23T00:00:00.000Z',
                horizon_hours: 48,
            },
            waves: {
                model: 'NOAA WaveWatch III',
                cycle: '2026072300',
                valid_from: '2026-07-23T00:00:00.000Z',
                valid_to: '2026-07-25T00:00:00.000Z',
            },
            land_mask: {
                model: 'GEBCO',
                max_cell_nm: 1.25,
                minimum_safe_depth_m: 1 + 1.2 / 3.28084,
            },
        },
    };
}

beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv('VITE_SUPABASE_URL', '');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', '');
});

describe('weatherRouter', () => {
    it('does not attempt a route-weather request when the endpoint is not configured', async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);

        await expect(
            fetchWeatherRoute(
                [
                    { lat: -27.47, lon: 153.03 },
                    { lat: -27.14, lon: 153.36 },
                ],
                '2026-07-23T00:00:00.000Z',
                vessel,
            ),
        ).resolves.toBeNull();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('sends the configured edge function an authenticated, normalized request', async () => {
        vi.stubEnv('VITE_SUPABASE_URL', 'https://thalassa.example');
        vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon-key');
        const routePayload = payload(8);
        const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(routePayload), { status: 200 }));
        vi.stubGlobal('fetch', fetchMock);

        await expect(
            fetchWeatherRoute(
                [
                    { lat: -27.47, lon: 153.03 },
                    { lat: -27.14, lon: 153.36 },
                ],
                '2026-07-23T00:00:00.000Z',
                { ...vessel, type: 'observer', cruisingSpeed: 0, maxWindSpeed: undefined },
            ),
        ).resolves.toEqual(routePayload);

        expect(fetchMock).toHaveBeenCalledWith(
            'https://thalassa.example/functions/v1/route-weather',
            expect.objectContaining({
                method: 'POST',
                headers: expect.objectContaining({ Authorization: 'Bearer anon-key' }),
                body: JSON.stringify({
                    centerline: [
                        { lat: -27.47, lon: 153.03 },
                        { lat: -27.14, lon: 153.36 },
                    ],
                    departure_time: '2026-07-23T00:00:00.000Z',
                    vessel: {
                        type: 'power',
                        cruising_speed_kts: 6,
                        max_wind_kts: 30,
                        // Both dimensions are FEET in the profile and metres on
                        // the wire. This asserted a raw 3 while converting draft
                        // correctly two lines below — so the suite certified the
                        // very bug it should have caught.
                        max_wave_m: 10 / 3.28084,
                        draft_m: 1.2 / 3.28084,
                        polar_data: null,
                    },
                    corridor_width_nm: 30,
                    lateral_steps: 2,
                }),
            }),
        );
    });

    it('rejects malformed or oversized route responses instead of merging untrusted conditions', async () => {
        vi.stubEnv('VITE_SUPABASE_URL', 'https://thalassa.example');
        vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon-key');
        const malformed = payload(8);
        malformed.track[1].time_offset_hours = 9;
        const invalidBounds = payload(8);
        invalidBounds.bounding_box = [153.04, -27.46, 153.35, -27.15];
        const invalidSources = payload(8);
        invalidSources.weather_sources!.waves.valid_to = '2026-07-23T12:00:00.000Z';
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(new Response(JSON.stringify(malformed), { status: 200 }))
            .mockResolvedValueOnce(new Response(JSON.stringify(invalidBounds), { status: 200 }))
            .mockResolvedValueOnce(new Response(JSON.stringify(invalidSources), { status: 200 }))
            .mockResolvedValueOnce(
                new Response(JSON.stringify(payload(8)), {
                    status: 200,
                    headers: { 'Content-Length': String(5 * 1024 * 1024) },
                }),
            );
        vi.stubGlobal('fetch', fetchMock);

        const centerline = [
            { lat: -27.47, lon: 153.03 },
            { lat: -27.14, lon: 153.36 },
        ];
        await expect(fetchWeatherRoute(centerline, '2026-07-23T00:00:00.000Z', vessel)).resolves.toBeNull();
        await expect(fetchWeatherRoute(centerline, '2026-07-23T00:00:00.000Z', vessel)).resolves.toBeNull();
        await expect(fetchWeatherRoute(centerline, '2026-07-23T00:00:00.000Z', vessel)).resolves.toBeNull();
        await expect(fetchWeatherRoute(centerline, '2026-07-23T00:00:00.000Z', vessel)).resolves.toBeNull();
    });

    it('maps a weather route back to voyage UI fields without replacing either endpoint', () => {
        const merged = mergeWeatherRoute(voyagePlan, payload());

        expect(merged.waypoints).toEqual([
            expect.objectContaining({
                name: 'WP-01',
                coordinates: { lat: -27.3, lon: 153.2 },
                depth_m: -4,
                windSpeed: 14,
                waveHeight: 7,
            }),
        ]);
        expect(merged.distanceApprox).toBe('42.6 NM');
        expect(merged.durationApprox).toBe('1 day 3h');
        expect(merged.routeReasoning).toContain('80 forecast points');
        expect(merged.routeReasoning).toContain('Weather-adjusted ETA: 1 day 3h');
        expect(voyagePlan.waypoints).toEqual([]);
    });

    it('does not label a raw centerline with zeroed conditions as a weather route', async () => {
        const enhanced = await enhanceVoyagePlanWithWeather(voyagePlan, vessel, '2026-07-23T00:00:00.000Z');

        expect(enhanced).toBe(voyagePlan);
        expect(getSpatiotemporalPayload(enhanced)).toBeNull();
    });

    it('leaves an unlocatable plan untouched instead of inventing a route', async () => {
        const incomplete = { ...voyagePlan, originCoordinates: undefined, destinationCoordinates: undefined };
        await expect(enhanceVoyagePlanWithWeather(incomplete, vessel, '2026-07-23T00:00:00.000Z')).resolves.toBe(
            incomplete,
        );
    });
});

// W1-03: the edge router is sent the boat's own polar, resolved once, and a
// polar the shared request contract would refuse is dropped (with a warning)
// rather than losing the whole weather route to a 400.
describe('weatherRouter — the polar on the wire', () => {
    const DEPART = '2026-11-01T06:00:00.000Z';
    const sloop: VesselProfile = { ...vessel, name: 'Fair Wind', type: 'sail', cruisingSpeed: 6.5 };
    const marseilleBonifacio = [
        { lat: 43.3, lon: 5.37, name: 'Marseille' },
        { lat: 41.39, lon: 9.16, name: 'Bonifacio' },
    ];
    const imported = resolveRoutingPolarFrom({
        settings: {
            polarSource_type: 'file_import',
            polarBoatModel: 'Fair Wind 2025.pol',
            polarData: {
                windSpeeds: [6, 10, 16, 25],
                angles: [40, 60, 90, 120, 150, 180],
                matrix: [
                    [3.9, 5.2, 6.0, 6.1],
                    [4.6, 6.1, 7.0, 7.3],
                    [5.0, 6.6, 7.6, 8.2],
                    [4.7, 6.4, 7.6, 8.6],
                    [3.9, 5.5, 7.0, 8.4],
                    [3.2, 4.7, 6.2, 7.6],
                ],
            },
        },
        vessel: sloop,
        learned: null,
    });
    const sentBody = (fetchMock: ReturnType<typeof vi.fn>) => JSON.parse(fetchMock.mock.calls[0][1].body as string);

    beforeEach(() => {
        vi.stubEnv('VITE_SUPABASE_URL', 'https://thalassa.example');
        vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon-key');
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(DEPART));
        routing.resolveRoutingPolar.mockReset();
        routing.warn.mockReset();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it("a sailing boat's weather route carries her resolved polar — and the dead vessel_polars table is never read", async () => {
        routing.resolveRoutingPolar.mockResolvedValue(imported);
        vi.mocked(supabase!.auth.getUser).mockResolvedValue({ data: { user: { id: 'skipper-1' } } } as never);
        const fetchMock = vi.fn().mockResolvedValue(new Response('busy', { status: 503 }));
        vi.stubGlobal('fetch', fetchMock);

        const plan = {
            ...voyagePlan,
            origin: 'Marseille',
            destination: 'Bonifacio',
            originCoordinates: marseilleBonifacio[0],
            destinationCoordinates: marseilleBonifacio[1],
        };
        await enhanceVoyagePlanWithWeather(plan, sloop, DEPART);

        expect(routing.resolveRoutingPolar).toHaveBeenCalledWith({ vessel: sloop });
        expect(sentBody(fetchMock).vessel.polar_data).toEqual(toEdgePolar(imported));
        expect(vi.mocked(supabase!.from).mock.calls.map(([table]) => table)).not.toContain('vessel_polars');
    });

    it('the generic polar goes out as null, so the edge keeps its own cruise-scaled fallback', async () => {
        routing.resolveRoutingPolar.mockResolvedValue(
            resolveRoutingPolarFrom({ settings: {}, vessel: sloop, learned: null }),
        );
        const fetchMock = vi.fn().mockResolvedValue(new Response('busy', { status: 503 }));
        vi.stubGlobal('fetch', fetchMock);

        const plan = {
            ...voyagePlan,
            originCoordinates: marseilleBonifacio[0],
            destinationCoordinates: marseilleBonifacio[1],
        };
        await enhanceVoyagePlanWithWeather(plan, sloop, DEPART);

        expect(sentBody(fetchMock).vessel.polar_data).toBeNull();
    });

    it('a power boat is never sent a polar (unchanged)', async () => {
        const fetchMock = vi.fn().mockResolvedValue(new Response('busy', { status: 503 }));
        vi.stubGlobal('fetch', fetchMock);

        const plan = {
            ...voyagePlan,
            originCoordinates: marseilleBonifacio[0],
            destinationCoordinates: marseilleBonifacio[1],
        };
        await enhanceVoyagePlanWithWeather(plan, vessel, DEPART);

        expect(routing.resolveRoutingPolar).not.toHaveBeenCalled();
        expect(sentBody(fetchMock).vessel.polar_data).toBeNull();
    });

    it('a polar the shared contract accepts is sent unchanged', async () => {
        const fetchMock = vi.fn().mockResolvedValue(new Response('busy', { status: 503 }));
        vi.stubGlobal('fetch', fetchMock);

        await fetchWeatherRoute(marseilleBonifacio, DEPART, sloop, toEdgePolar(imported));

        expect(sentBody(fetchMock).vessel.polar_data).toEqual(toEdgePolar(imported));
        expect(routing.warn).not.toHaveBeenCalled();
    });

    it('a polar the shared contract would refuse is dropped to null with a warning, not lost to a 400', async () => {
        const fetchMock = vi.fn().mockResolvedValue(new Response('busy', { status: 503 }));
        vi.stubGlobal('fetch', fetchMock);
        // 31 angle rows: over the contract's 30-row ceiling.
        const angles = Array.from({ length: 31 }, (_, i) => i * 6);
        const tooFine = {
            windSpeeds: [6, 12, 20],
            angles,
            matrix: angles.map((a) => (a < 36 ? [0, 0, 0] : [4, 6, 7])),
        };

        await fetchWeatherRoute(marseilleBonifacio, DEPART, sloop, tooFine);

        expect(sentBody(fetchMock).vessel.polar_data).toBeNull();
        expect(routing.warn).toHaveBeenCalledWith(expect.stringMatching(/polar/i));
    });

    it("checks the polar with the edge contract's own polar rule, without bundling the whole request validator", () => {
        const source = readFileSync(resolve(process.cwd(), 'services/weatherRouter.ts'), 'utf8');
        expect(source).toContain(
            "import { validatePolarData } from '../supabase/functions/_shared/route-weather-safety';",
        );
        expect(source).not.toMatch(/validateWeatherRouteRequest\(/);
    });

    it('a request refused for another reason does not blame (or strip) the polar', async () => {
        const fetchMock = vi.fn().mockResolvedValue(new Response('busy', { status: 503 }));
        vi.stubGlobal('fetch', fetchMock);

        // Ten days out: past the contract's forecast window, polar or no polar.
        await fetchWeatherRoute(marseilleBonifacio, '2026-11-11T06:00:00.000Z', sloop, toEdgePolar(imported));

        expect(sentBody(fetchMock).vessel.polar_data).toEqual(toEdgePolar(imported));
        expect(routing.warn).not.toHaveBeenCalled();
    });
});
