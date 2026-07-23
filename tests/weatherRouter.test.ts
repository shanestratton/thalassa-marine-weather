import { beforeEach, describe, expect, it, vi } from 'vitest';
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
    maxWaveHeight: 3,
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
            routing_mode: 'stitched_spatiotemporal',
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
                conditions: { depth_m: -8, wind_spd_kts: 12, wind_dir_deg: 90, wave_ht_m: 0.8, swell_period_s: 6 },
            },
            {
                coordinates: [153.2, -27.3],
                distance_from_start_nm: 20,
                time_offset_hours: 4,
                name: '',
                lateral_offset_nm: 0.2,
                conditions: { depth_m: -4, wind_spd_kts: 14.4, wind_dir_deg: 100, wave_ht_m: 2, swell_period_s: 7 },
            },
            {
                coordinates: [153.36, -27.14],
                distance_from_start_nm: 42.6,
                time_offset_hours: totalDurationHours,
                name: 'Moreton Island',
                lateral_offset_nm: 0,
                conditions: { depth_m: -6, wind_spd_kts: 10, wind_dir_deg: 110, wave_ht_m: 1, swell_period_s: 7 },
            },
        ],
        mesh_stats: {
            total_nodes: 120,
            rows: 3,
            cols: 40,
            corridor_width_nm: 30,
            weather_grid_points: 80,
            forecast_hours: 48,
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
                        max_wave_m: 3,
                        polar_data: null,
                    },
                    corridor_width_nm: 30,
                    lateral_steps: 2,
                }),
            }),
        );
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

    it('uses a useful local fallback for a direct plan with no named waypoints', async () => {
        const enhanced = await enhanceVoyagePlanWithWeather(voyagePlan, vessel, '2026-07-23T00:00:00.000Z');
        const fallback = getSpatiotemporalPayload(enhanced);

        expect(fallback).toEqual(
            expect.objectContaining({
                summary: expect.objectContaining({ routing_mode: 'fallback_centerline', vessel_type: 'power' }),
                track: expect.arrayContaining([
                    expect.objectContaining({ name: 'Brisbane', coordinates: [153.03, -27.47] }),
                    expect.objectContaining({ name: 'Moreton Island', coordinates: [153.36, -27.14] }),
                ]),
            }),
        );
        expect(enhanced.distanceApprox).toMatch(/NM$/);
        expect(enhanced.durationApprox).toMatch(/hours$/);
    });

    it('leaves an unlocatable plan untouched instead of inventing a route', async () => {
        const incomplete = { ...voyagePlan, originCoordinates: undefined, destinationCoordinates: undefined };
        await expect(enhanceVoyagePlanWithWeather(incomplete, vessel, '2026-07-23T00:00:00.000Z')).resolves.toBe(
            incomplete,
        );
    });
});
