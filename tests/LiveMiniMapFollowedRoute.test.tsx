import React from 'react';
import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LiveMiniMap } from '../components/LiveMiniMap';
import { FOLLOWED_ROUTE_CORE, FOLLOWED_ROUTE_GLOW } from '../components/map/followedRouteLayer';
import type { ShipLogEntry } from '../types';

const leaflet = vi.hoisted(() => {
    const groups: Array<ReturnType<typeof makeLayer>> = [];

    function makeLayer() {
        const layer = {
            addTo: vi.fn(),
            bringToFront: vi.fn(),
            clearLayers: vi.fn(),
        };
        layer.addTo.mockReturnValue(layer);
        return layer;
    }

    const map = {
        createPane: vi.fn(() => ({ style: {} })),
        fitBounds: vi.fn(),
        getContainer: vi.fn(() => document.createElement('div')),
        invalidateSize: vi.fn(),
        on: vi.fn(),
        remove: vi.fn(),
        setView: vi.fn(),
    };
    map.on.mockReturnValue(map);
    map.setView.mockReturnValue(map);

    const layerGroup = vi.fn(() => {
        const group = makeLayer();
        groups.push(group);
        return group;
    });

    return {
        groups,
        map,
        layerGroup,
        circleMarker: vi.fn(makeLayer),
        divIcon: vi.fn(() => ({})),
        latLngBounds: vi.fn(() => ({})),
        marker: vi.fn(makeLayer),
        polyline: vi.fn(makeLayer),
        tileLayer: vi.fn(makeLayer),
    };
});

vi.mock('../services/PiCacheService', () => ({
    piCache: { leafletTileTemplate: (url: string) => url },
}));

vi.mock('leaflet', () => ({
    default: {
        circleMarker: leaflet.circleMarker,
        divIcon: leaflet.divIcon,
        latLngBounds: leaflet.latLngBounds,
        layerGroup: leaflet.layerGroup,
        map: vi.fn(() => leaflet.map),
        marker: leaflet.marker,
        polyline: leaflet.polyline,
        tileLayer: leaflet.tileLayer,
    },
}));

const entry = (id: string, latitude: number, longitude: number, timestamp: string): ShipLogEntry =>
    ({
        id,
        userId: 'user-1',
        voyageId: 'active-voyage',
        latitude,
        longitude,
        timestamp,
        positionFormatted: '',
        entryType: 'auto',
        source: 'device',
    }) as ShipLogEntry;

describe('LiveMiniMap followed route', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        leaflet.groups.length = 0;
    });

    it('renders the violet route and cyan GPS track as separate polylines', async () => {
        const followedRoute = [
            { lat: -27.6, lon: 152.9 },
            { lat: -27.4, lon: 153.2 },
        ];
        const track = [
            entry('fix-1', -27.5, 153, '2026-07-25T00:00:00.000Z'),
            entry('fix-2', -27.48, 153.03, '2026-07-25T00:01:00.000Z'),
        ];

        render(<LiveMiniMap entries={track} followedRouteCoords={followedRoute} isLive />);

        await waitFor(() => expect(leaflet.polyline).toHaveBeenCalledTimes(4));
        const calls = leaflet.polyline.mock.calls as unknown as Array<
            [[number, number][], { color: string; pane?: string }]
        >;
        const routeCalls = calls.filter(([, options]) =>
            [FOLLOWED_ROUTE_GLOW, FOLLOWED_ROUTE_CORE].includes(options.color),
        );
        const trackCalls = calls.filter(([, options]) => ['#38bdf8', '#7dd3fc'].includes(options.color));

        expect(routeCalls).toHaveLength(2);
        expect(routeCalls.every(([coords]) => coords === routeCalls[0][0])).toBe(true);
        expect(routeCalls[0][0]).toEqual([
            [-27.6, 152.9],
            [-27.4, 153.2],
        ]);
        expect(trackCalls).toHaveLength(2);
        expect(trackCalls[0][0]).toEqual([
            [-27.5, 153],
            [-27.48, 153.03],
        ]);
        expect(calls.some(([coords]) => coords.length === 4)).toBe(false);
        expect(leaflet.marker).toHaveBeenCalledWith(
            [-27.48, 153.03],
            expect.objectContaining({ icon: expect.anything() }),
        );
        expect(leaflet.latLngBounds).toHaveBeenLastCalledWith([
            [-27.6, 152.9],
            [-27.4, 153.2],
            [-27.5, 153],
            [-27.48, 153.03],
        ]);
    });

    it('renders and frames a followed route before any GPS fix exists', async () => {
        const followedRoute = [
            { lat: -27.5, lon: 153 },
            { lat: -23.9, lon: 152.4 },
        ];

        render(<LiveMiniMap entries={[]} followedRouteCoords={followedRoute} isLive />);

        await waitFor(() => expect(leaflet.polyline).toHaveBeenCalledTimes(2));
        expect(leaflet.marker).not.toHaveBeenCalled();
        expect(leaflet.latLngBounds).toHaveBeenCalledWith([
            [-27.5, 153],
            [-23.9, 152.4],
        ]);
        expect(leaflet.map.fitBounds).toHaveBeenCalled();
    });

    it('clears the independent route group when follow mode stops', async () => {
        const followedRoute = [
            { lat: -27.5, lon: 153 },
            { lat: -27.4, lon: 153.1 },
        ];
        const { rerender } = render(<LiveMiniMap entries={[]} followedRouteCoords={followedRoute} isLive />);

        await waitFor(() => expect(leaflet.polyline).toHaveBeenCalledTimes(2));
        const routeGroup = leaflet.groups[0];
        const clearsBeforeStop = routeGroup.clearLayers.mock.calls.length;

        rerender(<LiveMiniMap entries={[]} followedRouteCoords={[]} isLive />);
        await waitFor(() => expect(routeGroup.clearLayers.mock.calls.length).toBeGreaterThan(clearsBeforeStop));
        expect(leaflet.polyline).toHaveBeenCalledTimes(2);
    });
});
