import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { destinationBounds, publicMapDestination } from '../src/publicMapDestination';
import { installMusgraveImagery, MUSGRAVE_IMAGERY } from '../src/publicSatelliteCoverage';

const camera = vi.hoisted(() => ({
    fitBounds: vi.fn(),
    flyTo: vi.fn(),
    resize: vi.fn(),
    onStyleData: undefined as undefined | ((event: { target: Parameters<typeof installMusgraveImagery>[0] }) => void),
}));
vi.mock('../src/voyageLogApi', async (original) => ({
    ...(await original<typeof import('../src/voyageLogApi')>()),
    MAPBOX_TOKEN: 'pk.test',
}));
vi.mock('react-map-gl/mapbox', async () => {
    const ReactModule = await import('react');
    const Map = ReactModule.forwardRef<
        unknown,
        { children?: React.ReactNode; mapStyle: string; onStyleData: typeof camera.onStyleData }
    >(({ children, mapStyle, onStyleData }, ref) => {
        camera.onStyleData = onStyleData;
        ReactModule.useImperativeHandle(ref, () => camera);
        return (
            <div data-testid="map" data-style={mapStyle}>
                {children}
            </div>
        );
    });
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

    it('fills the Musgrave imagery gap below labels and keeps it off the ordinary Map style', () => {
        const layers = new Set<string>();
        const sources = new Set<string>();
        const map = {
            getLayer: vi.fn((id: string) => (layers.has(id) ? { id } : undefined)),
            getSource: vi.fn((id: string) => (sources.has(id) ? { id } : undefined)),
            addSource: vi.fn((id: string) => {
                sources.add(id);
            }),
            addLayer: vi.fn((layer: { id: string }, beforeId: string) => {
                if (!layers.has(beforeId)) throw new Error('Insertion target is not loaded');
                layers.add(layer.id);
            }),
        };
        const fireStyleData = () =>
            camera.onStyleData?.({ target: map as unknown as Parameters<typeof installMusgraveImagery>[0] });
        render(<MapContainer {...props} />);
        fireStyleData(); // Style still downloading: do not add before a missing layer.
        expect(map.addSource).not.toHaveBeenCalled();
        layers.add(MUSGRAVE_IMAGERY.beforeId);
        fireStyleData();
        expect(map.addSource).toHaveBeenCalledWith(
            'musgrave-satellite',
            expect.objectContaining({
                type: 'raster',
                bounds: MUSGRAVE_IMAGERY.bounds,
                tileSize: 512,
                minzoom: 10,
                maxzoom: 18,
                tiles: [expect.stringContaining('api.maptiler.com/tiles/satellite-v2/')],
                attribution: expect.stringContaining('https://www.maptiler.com/copyright/'),
            }),
        );
        expect(map.addLayer).toHaveBeenCalledWith(
            expect.objectContaining({ id: 'musgrave-satellite-layer' }),
            MUSGRAVE_IMAGERY.beforeId,
        );
        fireStyleData();
        expect(map.addLayer).toHaveBeenCalledTimes(1);
        fireEvent.click(screen.getByRole('button', { name: 'Map basemap' }));
        layers.clear(); // setStyle removes the old style's additions.
        sources.clear();
        fireStyleData();
        expect(map.addLayer).toHaveBeenCalledTimes(1);
        fireEvent.click(screen.getByRole('button', { name: 'Satellite basemap' }));
        fireStyleData(); // React selected Satellite, but Mapbox still has dark-v11.
        expect(map.addLayer).toHaveBeenCalledTimes(1);
        layers.add(MUSGRAVE_IMAGERY.beforeId);
        fireStyleData();
        expect(map.addLayer).toHaveBeenCalledTimes(2);
    });

    it('keeps the repair local to Musgrave and never requests its tiles over Lady Elliot', () => {
        const [west, south, east, north] = MUSGRAVE_IMAGERY.bounds;
        expect(west).toBeLessThan(152.3896667);
        expect(east).toBeGreaterThan(152.4324);
        expect(south).toBeLessThan(-23.9149833);
        expect(north).toBeGreaterThan(-23.9);
        const tileX = (lon: number, zoom: number) => Math.floor(((lon + 180) / 360) * 2 ** zoom);
        for (let zoom = MUSGRAVE_IMAGERY.minzoom; zoom <= MUSGRAVE_IMAGERY.maxzoom; zoom++) {
            // Even the entire easternmost boundary tile excludes Elliot.
            expect(tileX(152.715, zoom)).toBeGreaterThan(tileX(east, zoom));
        }
    });

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
