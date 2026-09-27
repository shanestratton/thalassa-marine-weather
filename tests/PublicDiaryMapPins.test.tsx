import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VoyageLogEntry } from '../src/voyageLogApi';
import type { VoyageLogTrackPoint } from '../src/voyageLogApi';
const mapMocks = vi.hoisted(() => ({ source: vi.fn(), fitBounds: vi.fn() }));

vi.mock('../src/voyageLogApi', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../src/voyageLogApi')>()),
    MAPBOX_TOKEN: 'pk.test',
}));

vi.mock('../src/geo', () => ({
    bearingDeg: () => 0,
    haversineNm: () => 1,
    nightPolygon: () => null,
}));

vi.mock('react-map-gl/mapbox', async () => {
    const ReactModule = await import('react');
    const Map = ReactModule.forwardRef<unknown, { children?: React.ReactNode }>(({ children }, ref) => {
        ReactModule.useImperativeHandle(ref, () => ({
            fitBounds: mapMocks.fitBounds,
            flyTo: vi.fn(),
            resize: vi.fn(),
        }));
        return <div>{children}</div>;
    });
    Map.displayName = 'MockMap';
    return {
        default: Map,
        AttributionControl: () => null,
        NavigationControl: () => null,
        Layer: () => null,
        Popup: () => null,
        Source: (props: { children?: React.ReactNode }) => {
            mapMocks.source(props);
            return <>{props.children}</>;
        },
        Marker: ({
            children,
            latitude,
            longitude,
        }: {
            children?: React.ReactNode;
            latitude: number;
            longitude: number;
        }) => (
            <div data-testid="map-marker" data-latitude={latitude} data-longitude={longitude}>
                {children}
            </div>
        ),
    };
});

import MapContainer from '../src/components/MapContainer';

const photoEntry = (id: string, latitude: number | null, longitude: number | null): VoyageLogEntry => ({
    id,
    title: id,
    body: 'An afternoon in the islands.',
    mood: 'epic',
    photos: [`https://example.test/${id}.jpg`],
    location_name: 'Whitsundays',
    latitude,
    longitude,
    weather_summary: '',
    weather_data: null,
    tags: [],
    created_at: '2026-09-24T03:00:00Z',
    voyage_id: null,
    author: null,
});

const baseProps = {
    track: [],
    telemetry: { lat: -20.25, lon: 148.85, updated_at: '2026-09-25T00:00:00Z' },
    passageLine: null,
    waypoints: [],
    nearbyVessels: [],
    connectionLost: false,
};

describe('public diary map pins', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-25T00:00:00Z'));
        mapMocks.source.mockClear();
        mapMocks.fitBounds.mockClear();
    });
    afterEach(() => vi.useRealTimers());

    it('shows every positioned photo entry at its saved coordinates and opens the matching story', () => {
        const entries = [
            photoEntry('first-photo-post', -20.4, 149.0),
            photoEntry('later-photo-post', -20.1, 148.9),
            photoEntry('latest-photo-post', -20.2, 148.8),
        ];
        const onEntryClick = vi.fn();
        render(<MapContainer {...baseProps} entries={entries} onEntryClick={onEntryClick} />);

        expect(screen.getAllByRole('button', { name: /^Voyage log entry:/ })).toHaveLength(3);
        for (const entry of entries) {
            const pin = screen.getByRole('button', { name: `Voyage log entry: ${entry.title}` });
            // Photo pins carry an inline SVG camera badge (was the 📷 emoji).
            expect(pin.querySelector('.pv-pin svg')).toBeInTheDocument();
            expect(pin.closest('[data-testid="map-marker"]')).toHaveAttribute('data-latitude', `${entry.latitude}`);
            expect(pin.closest('[data-testid="map-marker"]')).toHaveAttribute('data-longitude', `${entry.longitude}`);
            fireEvent.click(pin);
            expect(onEntryClick).toHaveBeenLastCalledWith(entry);
        }
    });

    it('frames and renders multiple separate trips alongside their diary photos', () => {
        const entries = [photoEntry('south-story', -27, 153), photoEntry('north-story', -20, 148)];
        const track = [
            { voyage_id: 'south-trip', lat: -27, lon: 153, timestamp: '2026-09-18T00:00:00Z' },
            { voyage_id: 'south-trip', lat: -26, lon: 152, timestamp: '2026-09-18T01:00:00Z' },
            { voyage_id: 'north-trip', lat: -21, lon: 149, timestamp: '2026-09-24T00:00:00Z' },
            { voyage_id: 'north-trip', lat: -20, lon: 148, timestamp: '2026-09-24T01:00:00Z' },
        ] as VoyageLogTrackPoint[];
        render(
            <MapContainer
                {...baseProps}
                track={track}
                telemetry={null}
                entries={entries}
                allTrips
                onEntryClick={vi.fn()}
            />,
        );
        const source = mapMocks.source.mock.calls.find(([props]) => props.id === 'voyage-track')?.[0];
        expect(
            source.data.features.map(
                (feature: { geometry: { coordinates: number[][] } }) => feature.geometry.coordinates,
            ),
        ).toEqual([
            [
                [153, -27],
                [152, -26],
            ],
            [
                [149, -21],
                [148, -20],
            ],
        ]);
        expect(screen.getAllByRole('button', { name: /^Voyage log entry:/ })).toHaveLength(2);
        fireEvent.click(screen.getByRole('button', { name: 'Show all trips and diary locations' }));
        expect(mapMocks.fitBounds).toHaveBeenCalledWith(
            [
                [148, -27],
                [153, -20],
            ],
            expect.anything(),
        );
    });

    it('omits missing coordinates despite a location name, photo and boat position, then uses a saved repair', () => {
        const entries = [
            photoEntry('located', -20.4, 149.0),
            photoEntry('missing-both', null, null),
            photoEntry('missing-latitude', null, 148.9),
            photoEntry('missing-longitude', -20.1, null),
        ];
        const onEntryClick = vi.fn();
        const { rerender } = render(<MapContainer {...baseProps} entries={entries} onEntryClick={onEntryClick} />);

        expect(screen.getAllByRole('button', { name: /^Voyage log entry:/ })).toHaveLength(1);
        for (const entry of entries.slice(1)) {
            expect(screen.queryByRole('button', { name: `Voyage log entry: ${entry.title}` })).not.toBeInTheDocument();
        }

        const repaired = { ...entries[1], latitude: -20.28, longitude: 148.92 };
        rerender(<MapContainer {...baseProps} entries={[entries[0], repaired]} onEntryClick={onEntryClick} />);

        const pin = screen.getByRole('button', { name: 'Voyage log entry: missing-both' });
        expect(pin.closest('[data-testid="map-marker"]')).toHaveAttribute('data-latitude', '-20.28');
        expect(pin.closest('[data-testid="map-marker"]')).toHaveAttribute('data-longitude', '148.92');
        fireEvent.click(pin);
        expect(onEntryClick).toHaveBeenLastCalledWith(repaired);
    });
});
