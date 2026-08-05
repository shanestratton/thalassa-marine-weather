import React from 'react';
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NearbyVessel, VoyageLogTelemetry } from '../src/voyageLogApi';

vi.mock('../src/voyageLogApi', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../src/voyageLogApi')>();
    return { ...actual, MAPBOX_TOKEN: 'pk.test' };
});

vi.mock('../src/geo', () => ({
    bearingDeg: () => 0,
    haversineNm: () => 1,
    nightPolygon: () => null,
}));

vi.mock('react-map-gl/mapbox', async () => {
    const ReactModule = await import('react');
    const Map = ReactModule.forwardRef<unknown, { children?: React.ReactNode }>(({ children }, ref) => {
        ReactModule.useImperativeHandle(ref, () => ({
            fitBounds: vi.fn(),
            flyTo: vi.fn(),
            resize: vi.fn(),
        }));
        return <div data-testid="mock-map">{children}</div>;
    });
    Map.displayName = 'MockMap';

    return {
        default: Map,
        Layer: () => null,
        Marker: ({ children }: { children?: React.ReactNode }) => <div data-testid="map-marker">{children}</div>,
        NavigationControl: () => null,
        Popup: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
        Source: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
    };
});

import MapContainer from '../src/components/MapContainer';

const NOW = Date.parse('2026-08-04T10:00:00.000Z');

const TELEMETRY: VoyageLogTelemetry = {
    sog: 5,
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
};

const NEARBY: NearbyVessel = {
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
};

describe('public voyage map freshness', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(NOW);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('stops the live pulse, marks AIS last-known, and expires unsafe frozen contacts', async () => {
        const { container } = render(
            <MapContainer
                track={[]}
                telemetry={TELEMETRY}
                entries={[]}
                passageLine={null}
                waypoints={[]}
                nearbyVessels={[NEARBY]}
                connectionLost={false}
                onEntryClick={vi.fn()}
            />,
        );

        expect(container.querySelector('.animate-ping')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'AIS contact Nearby, updated just now' })).toBeInTheDocument();

        await act(async () => {
            await vi.advanceTimersByTimeAsync(10 * 60_000);
        });

        expect(container.querySelector('.animate-ping')).not.toBeInTheDocument();
        expect(screen.getByText('Last known · 10 min ago')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'AIS contact Nearby, last known 10 min ago' })).toHaveClass(
            'opacity-45',
        );

        await act(async () => {
            await vi.advanceTimersByTimeAsync(110 * 60_000);
        });

        expect(screen.queryByRole('button', { name: /AIS contact Nearby/i })).not.toBeInTheDocument();
    });
});
