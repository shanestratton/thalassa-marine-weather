import React from 'react';
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VoyageLogData, VoyageLogTelemetry } from '../src/voyageLogApi';

const mocks = vi.hoisted(() => ({
    fetchVoyageLog: vi.fn(),
    parseVoyageLogParams: vi.fn(() => ({ handle: 'calypso' })),
}));

vi.mock('../src/voyageLogApi', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../src/voyageLogApi')>();
    return {
        ...actual,
        fetchVoyageLog: mocks.fetchVoyageLog,
        parseVoyageLogParams: mocks.parseVoyageLogParams,
    };
});

vi.mock('../src/components/TopNav', () => ({
    default: ({ connectionLost }: { connectionLost: boolean }) => (
        <div data-testid="top-status">{connectionLost ? 'connection-lost' : 'connection-current'}</div>
    ),
}));

vi.mock('../src/components/MapContainer', () => ({
    default: ({
        track,
        nearbyVessels,
        connectionLost,
    }: {
        track: unknown[];
        nearbyVessels: unknown[];
        connectionLost: boolean;
    }) => (
        <div data-testid="map-state">
            {connectionLost ? 'last-known' : 'current'} · track {track.length} · nearby {nearbyVessels.length}
        </div>
    ),
}));

vi.mock('../src/components/DiarySidebar', () => ({
    default: ({ telemetry, connectionLost }: { telemetry: VoyageLogTelemetry | null; connectionLost: boolean }) => (
        <div data-testid="diary-state">
            {telemetry ? 'telemetry-retained' : 'no-telemetry'} · {connectionLost ? 'last-known' : 'current'}
        </div>
    ),
}));

vi.mock('../src/components/VoyageProgressBar', () => ({ VoyageProgressBar: () => null }));
vi.mock('../src/components/PhotoLightbox', () => ({ PhotoLightbox: () => null }));

import ThalassaDashboard from '../src/ThalassaDashboard';

const NOW = Date.parse('2026-08-04T10:00:00.000Z');

const DATA: VoyageLogData = {
    vessel: { name: 'Calypso', type: 'sail', model: 'Beneteau' },
    scope: 'personal',
    destination: null,
    trips: [
        {
            id: 'trip-1',
            kind: 'track',
            label: 'Moreton Bay',
            started_at: new Date(NOW - 60_000).toISOString(),
            ended_at: null,
            active: true,
            point_count: 1,
            distance_nm: 0,
            has_route: false,
        },
    ],
    selected_trip: 'trip-1',
    entries: [],
    track: [
        {
            lat: -27,
            lon: 153,
            timestamp: new Date(NOW).toISOString(),
            speed_kts: 6,
            course_deg: 90,
            heading_deg: 90,
            pressure: 1012,
            wind_speed_apparent: 10,
            wind_angle_apparent: 45,
            wind_speed_true: 8,
            wind_direction_true: 120,
            depth_m: 20,
            air_temp: 25,
            water_temp: 24,
            wave_height: 1,
        },
    ],
    waypoints: [],
    telemetry: {
        sog: 6,
        cog: 90,
        heading: 90,
        baro: 1012,
        baro_trend: 'steady',
        aws: 10,
        awa: 45,
        tws: 8,
        twd: 120,
        depth: 20,
        air_temp: 25,
        water_temp: 24,
        wave_height: 1,
        lat: -27,
        lon: 153,
        updated_at: new Date(NOW).toISOString(),
        is_last_known: false,
    },
    nearby_vessels: [
        {
            mmsi: '503000001',
            name: 'Nearby',
            lat: -27.01,
            lon: 153.01,
            cog: 180,
            sog: 8,
            heading: 180,
            ship_type: 'cargo',
            call_sign: null,
            destination: null,
            nav_status: null,
            updated_at: new Date(NOW).toISOString(),
        },
    ],
    passage: null,
    generated_at: new Date(NOW).toISOString(),
};

async function flushReact(): Promise<void> {
    await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
    });
}

describe('public voyage dashboard polling honesty', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(NOW);
        mocks.fetchVoyageLog.mockReset();
        mocks.parseVoyageLogParams.mockReturnValue({ handle: 'calypso' });
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('retains map data but marks it last-known when a background poll fails, then recovers', async () => {
        mocks.fetchVoyageLog
            .mockResolvedValueOnce(DATA)
            .mockRejectedValueOnce(new Error('offline'))
            .mockResolvedValue(DATA);

        render(<ThalassaDashboard />);
        await flushReact();

        expect(screen.getByTestId('top-status')).toHaveTextContent('connection-current');
        expect(screen.getByTestId('map-state')).toHaveTextContent('current · track 1 · nearby 1');

        await act(async () => {
            await vi.advanceTimersByTimeAsync(60_000);
        });

        expect(screen.getByTestId('top-status')).toHaveTextContent('connection-lost');
        expect(screen.getByTestId('map-state')).toHaveTextContent('last-known · track 1 · nearby 1');
        expect(screen.getByTestId('diary-state')).toHaveTextContent('telemetry-retained · last-known');

        await act(async () => {
            await vi.advanceTimersByTimeAsync(60_000);
        });

        expect(screen.getByTestId('top-status')).toHaveTextContent('connection-current');
        expect(screen.getByTestId('map-state')).toHaveTextContent('current · track 1 · nearby 1');
    });
});
