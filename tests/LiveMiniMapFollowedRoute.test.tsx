/**
 * The followed route and the GPS track on the little Log map, now Mapbox GL
 * on Relief + Sat (125-13a). Same promises as the Leaflet map made: the
 * violet route and the cyan track are separate lines (the route beneath),
 * a weather refresh of the route never redraws the track, the live boat dot
 * sits on the latest fix, and the frame takes in both.
 */
import React from 'react';
import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeMapboxMap, installFakeIntersectionObserver } from './helpers/fakeMapboxGl';
import { FOLLOWED_ROUTE_CORE, FOLLOWED_ROUTE_GLOW } from '../components/map/followedRouteLayer';
import type { ShipLogEntry } from '../types';

vi.mock('../services/PiCacheService', () => ({
    piCache: { canDisplayProxiedTiles: () => false, passthroughTileUrl: () => null },
}));

vi.mock('mapbox-gl', async () => {
    const { fakeMapboxGl } = await import('./helpers/fakeMapboxGl');
    return { default: fakeMapboxGl };
});

import LiveMiniMapGL from '../components/LiveMiniMapGL';

type Line = { type: 'Feature'; geometry: { type: 'LineString'; coordinates: [number, number][] } | null };
type Points = {
    type: 'FeatureCollection';
    features: Array<{ properties: { role: string }; geometry: { coordinates: [number, number] } }>;
};

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

const lastMap = () => FakeMapboxMap.instances[FakeMapboxMap.instances.length - 1];
const lineOf = (map: FakeMapboxMap, source: string) =>
    ((map.getSource(source)?.data as Line | undefined)?.geometry?.coordinates ?? []) as [number, number][];
const pointsOf = (map: FakeMapboxMap) => (map.getSource('log-points')?.data as Points | undefined)?.features ?? [];
const paintOf = (map: FakeMapboxMap, layer: string) => map.getLayer(layer)?.paint ?? {};

let restoreObserver = () => {};

beforeEach(() => {
    FakeMapboxMap.instances.length = 0;
    restoreObserver = installFakeIntersectionObserver();
    vi.stubEnv('VITE_MAPBOX_ACCESS_TOKEN', 'pk.fixture');
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(360);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(220);
});

afterEach(() => {
    restoreObserver();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('LiveMiniMap followed route', () => {
    it('renders the violet route and cyan GPS track as separate lines, the route beneath', () => {
        const followedRoute = [
            { lat: -27.6, lon: 152.9 },
            { lat: -27.4, lon: 153.2 },
        ];
        const track = [
            entry('fix-1', -27.5, 153, '2026-07-25T00:00:00.000Z'),
            entry('fix-2', -27.48, 153.03, '2026-07-25T00:01:00.000Z'),
        ];

        render(<LiveMiniMapGL entries={track} followedRouteCoords={followedRoute} isLive />);
        const map = lastMap();
        map.loadStyle();

        expect(lineOf(map, 'log-route')).toEqual([
            [152.9, -27.6],
            [153.2, -27.4],
        ]);
        expect(lineOf(map, 'log-track')).toEqual([
            [153, -27.5],
            [153.03, -27.48],
        ]);
        expect(paintOf(map, 'log-route-glow')['line-color']).toBe(FOLLOWED_ROUTE_GLOW);
        expect(paintOf(map, 'log-route-core')['line-color']).toBe(FOLLOWED_ROUTE_CORE);
        expect(paintOf(map, 'log-route-glow')['line-width']).toBe(10);
        expect(paintOf(map, 'log-route-core')['line-width']).toBe(3);
        expect(paintOf(map, 'log-track-glow')['line-color']).toEqual(['get', 'glow']);
        expect(paintOf(map, 'log-track-core')['line-color']).toEqual(['get', 'core']);
        const trackProps = (map.getSource('log-track')!.data as { properties: Record<string, string> }).properties;
        expect(trackProps).toEqual({ glow: '#38bdf8', core: '#7dd3fc' });

        const ids = map.layers.map((layer) => layer.id);
        expect(ids.indexOf('log-route-core')).toBeLessThan(ids.indexOf('log-track-glow'));
        expect(ids.indexOf('log-track-core')).toBeLessThan(ids.indexOf('log-points'));

        // The live boat is the latest fix; the start dot the first.
        const roles = pointsOf(map).map((f) => [f.properties.role, f.geometry.coordinates]);
        expect(roles).toEqual([
            ['start', [153, -27.5]],
            ['boat', [153.03, -27.48]],
        ]);

        // Framed on the route and the track together.
        const [bounds] = map.fitBounds.mock.calls[map.fitBounds.mock.calls.length - 1];
        expect(bounds).toEqual([
            [152.9, -27.6],
            [153.2, -27.4],
        ]);
    });

    it('renders and frames a followed route before any GPS fix exists', () => {
        const followedRoute = [
            { lat: -27.5, lon: 153 },
            { lat: -23.9, lon: 152.4 },
        ];

        render(<LiveMiniMapGL entries={[]} followedRouteCoords={followedRoute} isLive />);
        const map = lastMap();
        expect(map.options.bounds).toEqual([
            [152.4, -27.5],
            [153, -23.9],
        ]);
        map.loadStyle();
        expect(lineOf(map, 'log-route')).toHaveLength(2);
        expect(lineOf(map, 'log-track')).toEqual([]);
        expect(pointsOf(map)).toEqual([]);
        expect(map.fitBounds).toHaveBeenCalled();
    });

    it('clears the route when follow mode stops, and never redraws the track for it', () => {
        const followedRoute = [
            { lat: -27.5, lon: 153 },
            { lat: -27.4, lon: 153.1 },
        ];
        // One identity for "no fixes yet", as the Log page passes it (logPageTypes).
        const noFixes: ShipLogEntry[] = [];
        const { rerender } = render(<LiveMiniMapGL entries={noFixes} followedRouteCoords={followedRoute} isLive />);
        const map = lastMap();
        map.loadStyle();
        expect(lineOf(map, 'log-route')).toHaveLength(2);
        const trackWrites = map.getSource('log-track')!.setData as ReturnType<typeof vi.fn>;
        const before = trackWrites.mock.calls.length;

        rerender(<LiveMiniMapGL entries={noFixes} followedRouteCoords={[]} isLive />);
        expect(lineOf(map, 'log-route')).toEqual([]);
        expect(trackWrites.mock.calls.length).toBe(before);
    });

    it('a planned route card draws violet with its end dot, and stays put once framed', () => {
        const planned = [
            { ...entry('p1', 36.53, -4.62, '2026-10-01T08:00:00Z'), source: 'planned_route' },
            { ...entry('p2', 36.42, -4.95, '2026-10-01T09:00:00Z'), source: 'planned_route' },
            { ...entry('p3', 36.13, -5.35, '2026-10-01T12:00:00Z'), source: 'planned_route' },
        ] as ShipLogEntry[];
        const { rerender } = render(<LiveMiniMapGL entries={planned} height={140} />);
        const map = lastMap();
        map.loadStyle();
        const props = (map.getSource('log-track')!.data as { properties: Record<string, string> }).properties;
        expect(props).toEqual({ glow: '#a78bfa', core: '#c4b5fd' });
        expect(pointsOf(map).map((f) => f.properties.role)).toEqual(['start', 'end']);
        const fits = map.fitBounds.mock.calls.length;
        rerender(<LiveMiniMapGL entries={[...planned]} height={140} />);
        expect(map.fitBounds.mock.calls.length).toBe(fits);
    });
});
