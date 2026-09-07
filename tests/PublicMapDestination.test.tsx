import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { destinationBounds, publicMapDestination } from '../src/publicMapDestination';

const camera = vi.hoisted(() => ({ fitBounds: vi.fn(), flyTo: vi.fn(), resize: vi.fn() }));
vi.mock('../src/voyageLogApi', async (original) => ({
    ...(await original<typeof import('../src/voyageLogApi')>()),
    MAPBOX_TOKEN: 'pk.test',
}));
vi.mock('react-map-gl/mapbox', async () => {
    const ReactModule = await import('react');
    const Map = ReactModule.forwardRef<unknown, { children?: React.ReactNode; mapStyle: string }>(
        ({ children, mapStyle }, ref) => {
            ReactModule.useImperativeHandle(ref, () => camera);
            return (
                <div data-testid="map" data-style={mapStyle}>
                    {children}
                </div>
            );
        },
    );
    Map.displayName = 'MockMap';
    return {
        default: Map,
        AttributionControl: () => null,
        NavigationControl: () => null,
        Layer: () => null,
        Marker: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
        Popup: () => null,
        Source: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
    };
});
import MapContainer from '../src/components/MapContainer';

const end: [number, number] = [152.4, -23.9];
const line: [number, number][] = [[153.1, -27.2], end];
const destination = { name: 'Lady Musgrave', lon: end[0], lat: end[1] };
const props = {
    track: [],
    entries: [],
    passageLine: line,
    destination,
    waypoints: [],
    nearbyVessels: [],
    connectionLost: false,
    onEntryClick: vi.fn(),
    focusKey: 'trip-a',
};

describe('public destination exploration', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.clearAllMocks();
    });
    afterEach(() => vi.useRealTimers());

    it('uses the selected route endpoint, never a contradictory destination name or coordinate', () => {
        expect(publicMapDestination(line, destination)).toEqual({ center: end, name: 'Lady Musgrave' });
        expect(publicMapDestination(line, { name: 'Wrong island', lat: -18, lon: 146 })).toEqual({
            center: end,
            name: 'Destination',
        });
        expect(publicMapDestination(null, destination)?.center).toEqual(end);
        expect(publicMapDestination(null, { name: 'Invalid', lat: NaN, lon: 146 })).toBeNull();
        expect(publicMapDestination(null, null)).toBeNull();
    });

    it('fits reef context rather than a single overzoomed point', () => {
        const bounds = destinationBounds(end);
        expect(bounds[0][1]).toBeLessThan(end[1]);
        expect(bounds[1][1]).toBeGreaterThan(end[1]);
        expect((bounds[1][1] - bounds[0][1]) * 60).toBeCloseTo(4.4);
        // Qld's published Lady Musgrave island light position. The actual
        // passage endpoint is north of the reef; a 1.5 NM close-up cut it off.
        // https://www.legislation.qld.gov.au/view/whole/html/2026-04-17/sl-2019-0076
        const arrival = destinationBounds([152.3966503685058, -23.880992851466743]);
        expect(arrival[0][0]).toBeLessThan(152.3896667);
        expect(arrival[1][0]).toBeGreaterThan(152.3896667);
        expect(arrival[0][1]).toBeLessThan(-23.9081667);
        expect(arrival[1][1]).toBeGreaterThan(-23.9081667);
    });

    it('keeps explicit exploration when route geometry arrives late', async () => {
        const { rerender } = render(<MapContainer {...props} passageLine={null} />);
        fireEvent.click(screen.getByRole('button', { name: 'Satellite close-up of Lady Musgrave' }));
        camera.fitBounds.mockClear();
        rerender(<MapContainer {...props} />);
        await act(async () => {
            await vi.advanceTimersByTimeAsync(1000);
        });
        expect(camera.fitBounds).not.toHaveBeenCalled();
    });

    it('opens satellite detail, leaves exploration alone during polling, and can return to the whole voyage', async () => {
        const { rerender } = render(<MapContainer {...props} />);
        await act(async () => {
            await vi.advanceTimersByTimeAsync(150);
        });
        camera.fitBounds.mockClear();
        fireEvent.click(screen.getByRole('button', { name: 'Map basemap' }));
        expect(screen.getByRole('button', { name: 'Map basemap' })).toHaveAttribute('aria-pressed', 'true');
        fireEvent.click(screen.getByRole('button', { name: 'Satellite close-up of Lady Musgrave' }));
        expect(camera.fitBounds).toHaveBeenLastCalledWith(
            destinationBounds(end),
            expect.objectContaining({ maxZoom: 15 }),
        );
        expect(screen.getByTestId('map')).toHaveAttribute('data-style', 'mapbox://styles/mapbox/satellite-streets-v12');
        camera.fitBounds.mockClear();
        rerender(<MapContainer {...props} passageLine={[...line]} />);
        await act(async () => {
            await vi.advanceTimersByTimeAsync(1000);
        });
        expect(camera.fitBounds).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole('button', { name: /Show the whole voyage/ }));
        expect(camera.fitBounds).toHaveBeenCalledWith(
            [
                [152.4, -27.2],
                [153.1, -23.9],
            ],
            expect.objectContaining({ maxZoom: 14 }),
        );
    });
});
