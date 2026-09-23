import { act, cleanup, renderHook } from '@testing-library/react';
import type mapboxgl from 'mapbox-gl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { passageWaypointData, usePassageWaypointLayer } from '../components/map/usePassageWaypointLayer';
import { useRouteGhostMarker } from '../components/map/useRouteGhostMarker';
import { useRouteTrackLayer } from '../components/map/useRouteTrackLayer';
import type { RouteOrTrack } from '../services/shiplog/RoutesAndTracks';
import {
    __resetPassageHudForTests,
    publishPassageGhostJoinPath,
    publishPassageGhostPath,
} from '../stores/passageHudStore';

const markerMade = vi.hoisted(() => vi.fn());
vi.mock('mapbox-gl', () => ({
    default: {
        Marker: class {
            constructor() {
                markerMade();
            }
            setLngLat() {
                return this;
            }
            addTo() {
                return this;
            }
            remove() {}
        },
    },
}));

type Data = GeoJSON.FeatureCollection | GeoJSON.Feature;
function chart() {
    const sources = new Map<string, { data: Data; setData: ReturnType<typeof vi.fn> }>();
    const layers: mapboxgl.AnyLayer[] = [];
    const handlers = new Map<string, Set<() => void>>();
    const raw = {
        loaded: true,
        isStyleLoaded: () => raw.loaded,
        getSource: (id: string) => sources.get(id),
        addSource: vi.fn((id: string, definition: { data: Data }) => {
            const source = { data: definition.data, setData: vi.fn((data: Data) => void (source.data = data)) };
            sources.set(id, source);
        }),
        removeSource: vi.fn((id: string) => sources.delete(id)),
        getLayer: (id: string) => layers.find((layer) => layer.id === id),
        addLayer: vi.fn((layer: mapboxgl.AnyLayer) => layers.push(layer)),
        removeLayer: vi.fn((id: string) => {
            const at = layers.findIndex((layer) => layer.id === id);
            if (at >= 0) layers.splice(at, 1);
        }),
        getStyle: () => ({ layers }),
        moveLayer: vi.fn((id: string, beforeId?: string) => {
            const at = layers.findIndex((layer) => layer.id === id);
            const [layer] = layers.splice(at, 1);
            const before = beforeId ? layers.findIndex((candidate) => candidate.id === beforeId) : -1;
            layers.splice(before < 0 ? layers.length : before, 0, layer);
        }),
        getBearing: () => 0,
        fitBounds: vi.fn(),
        on: (event: string, handler: () => void) => {
            if (!handlers.has(event)) handlers.set(event, new Set());
            handlers.get(event)!.add(handler);
        },
        off: (event: string, handler: () => void) => handlers.get(event)?.delete(handler),
    };
    return {
        raw,
        sources,
        layers,
        handlers,
        ref: { current: raw as unknown as mapboxgl.Map },
        emit: (event: string) => act(() => handlers.get(event)?.forEach((handler) => handler())),
        swap: () => {
            sources.clear();
            layers.length = 0;
        },
    };
}

const ROUTE = [
    { lat: -27, lon: 153 },
    { lat: -26.5, lon: 153.1 },
    { lat: -26.25, lon: 153.15 },
    { lat: -26, lon: 153.2 },
];
const SOURCE = 'passage-waypoints';
const DOTS = 'passage-waypoint-dots';
const NUMBERS = 'passage-waypoint-numbers';

beforeEach(() => {
    markerMade.mockClear();
    __resetPassageHudForTests();
});
afterEach(() => {
    cleanup();
    __resetPassageHudForTests();
});

describe('followed-route waypoints', () => {
    it('keeps original one-based numbers and stable feature IDs while omitting the A/B endpoints', () => {
        const route = Object.freeze(ROUTE.map((point) => Object.freeze({ ...point })));
        const data = passageWaypointData(route);
        expect(data.features.map((feature) => [feature.id, feature.properties.number])).toEqual([
            [1, 2],
            [2, 3],
        ]);
        expect(data.features.map((feature) => feature.geometry.coordinates)).toEqual([
            [153.1, -26.5],
            [153.15, -26.25],
        ]);
        const moved = passageWaypointData([route[0], { lat: -26.6, lon: 153.11 }, ...route.slice(2)]);
        expect(moved.features.map((feature) => feature.id)).toEqual([1, 2]);
    });

    it('does not duplicate endpoint markers or renumber later points after an invalid coordinate', () => {
        const data = passageWaypointData([ROUTE[0], ROUTE[0], { lat: NaN, lon: 153 }, ROUTE[2], ROUTE[3]]);
        expect(data.features.map((feature) => feature.properties.number)).toEqual([4]);
        expect(passageWaypointData([]).features).toEqual([]);
        expect(passageWaypointData([ROUTE[0], ROUTE[3]]).features).toEqual([]);
    });

    it('draws purple overview dots and collision-aware numbers only at closer zooms, without fitting the map', () => {
        const c = chart();
        renderHook(() => usePassageWaypointLayer({ mapRef: c.ref, mapReady: true, enabled: true, routeCoords: ROUTE }));
        const dots = c.raw.getLayer(DOTS) as mapboxgl.CircleLayer;
        const numbers = c.raw.getLayer(NUMBERS) as mapboxgl.SymbolLayer;
        expect(dots.type).toBe('circle');
        expect(dots.paint?.['circle-color']).toBe('#a855f7');
        expect(numbers.minzoom).toBe(11);
        expect(numbers.layout?.['text-field']).toEqual(['to-string', ['get', 'number']]);
        expect(numbers.layout?.['text-allow-overlap']).toBe(false);
        expect(numbers.layout?.['text-ignore-placement']).toBe(false);
        expect(markerMade).not.toHaveBeenCalled();
        expect(c.raw.fitBounds).not.toHaveBeenCalled();
    });

    it('renders thousands of points in one source and two layers, without DOM markers or idle rewrites', () => {
        const c = chart();
        const dense = Array.from({ length: 4002 }, (_, i) => ({ lat: -27 + i * 0.00001, lon: 153 + i * 0.00001 }));
        renderHook(() => usePassageWaypointLayer({ mapRef: c.ref, mapReady: true, enabled: true, routeCoords: dense }));
        const source = c.sources.get(SOURCE)!;
        expect((source.data as GeoJSON.FeatureCollection).features).toHaveLength(4000);
        expect(c.sources.size).toBe(1);
        expect(c.layers).toHaveLength(2);
        c.emit('idle');
        c.emit('styledata');
        expect(source.setData).not.toHaveBeenCalled();
        expect(markerMade).not.toHaveBeenCalled();
    });

    it('updates replacement geometry in the same source and restores it through repeated basemap changes', () => {
        const c = chart();
        const hook = renderHook(
            ({ routeCoords }) => usePassageWaypointLayer({ mapRef: c.ref, mapReady: true, enabled: true, routeCoords }),
            { initialProps: { routeCoords: ROUTE } },
        );
        const replacement = [ROUTE[0], { lat: -26.4, lon: 153.11 }, ...ROUTE.slice(2)];
        hook.rerender({ routeCoords: replacement });
        const data = c.sources.get(SOURCE)!.data as GeoJSON.FeatureCollection<GeoJSON.Point>;
        expect(data.features[0].id).toBe(1);
        expect(data.features[0].geometry.coordinates).toEqual([153.11, -26.4]);
        expect(c.raw.addSource).toHaveBeenCalledOnce();
        c.swap();
        c.emit('style.load');
        c.swap();
        c.emit('styledata');
        expect(c.sources.get(SOURCE)!.data).toEqual(data);
        c.raw.removeLayer(NUMBERS);
        c.emit('idle');
        expect(c.layers.map((layer) => layer.id)).toEqual([DOTS, NUMBERS]);
        expect(c.handlers.get('idle')?.size).toBe(1);
    });

    it('waits for the style and cleans up on disable, unfollow, or unmount', () => {
        const c = chart();
        c.raw.loaded = false;
        const hook = renderHook(
            ({ enabled, routeCoords }) =>
                usePassageWaypointLayer({ mapRef: c.ref, mapReady: true, enabled, routeCoords }),
            { initialProps: { enabled: true, routeCoords: ROUTE } },
        );
        expect(c.sources.size).toBe(0);
        c.raw.loaded = true;
        c.emit('style.load');
        expect(c.sources.size).toBe(1);
        hook.rerender({ enabled: false, routeCoords: ROUTE });
        expect(c.sources.size).toBe(0);
        expect(c.layers).toHaveLength(0);
        hook.rerender({ enabled: true, routeCoords: ROUTE });
        hook.rerender({ enabled: true, routeCoords: [] });
        expect(c.sources.size).toBe(0);
        hook.rerender({ enabled: true, routeCoords: ROUTE });
        hook.unmount();
        expect(c.sources.size).toBe(0);
        expect([...c.handlers.values()].every((listeners) => listeners.size === 0)).toBe(true);
    });

    it('stays above late imagery with route, track and ghost layers without a promotion loop', () => {
        const c = chart();
        const selected = (id: string): RouteOrTrack => ({
            id,
            label: id,
            sublabel: '',
            points: ROUTE,
            bbox: [153, -27, 153.2, -26],
            timestamp: 0,
            distanceNm: 60,
            isLocal: true,
            kind: 'sea',
        });
        renderHook(() => {
            usePassageWaypointLayer({ mapRef: c.ref, mapReady: true, enabled: true, routeCoords: ROUTE });
            useRouteGhostMarker(c.ref, true);
            useRouteTrackLayer({ mapRef: c.ref, mapReady: true, variant: 'route', selected: selected('route') });
            useRouteTrackLayer({ mapRef: c.ref, mapReady: true, variant: 'track', selected: selected('track') });
        });
        act(() => {
            publishPassageGhostPath(ROUTE);
            publishPassageGhostJoinPath([{ lat: -27, lon: 152.9 }, ROUTE[0]]);
        });
        c.emit('idle');
        c.raw.addLayer({ id: 'rain-late-frame', type: 'background' });
        c.raw.addLayer({ id: 'squall-radar', type: 'background' });
        c.emit('styledata');
        c.emit('idle');
        const order = c.layers.map((layer) => layer.id);
        expect(order.indexOf(DOTS)).toBeGreaterThan(order.indexOf('squall-radar'));
        expect(order.indexOf(NUMBERS)).toBeGreaterThan(order.indexOf(DOTS));
        expect(order.indexOf('passage-ghost-join-path-line')).toBeGreaterThan(order.indexOf(NUMBERS));
        expect(order.indexOf('routetrack-route-line')).toBeGreaterThan(order.indexOf(NUMBERS));
        const moves = c.raw.moveLayer.mock.calls.length;
        c.emit('idle');
        c.emit('styledata');
        c.emit('idle');
        expect(c.raw.moveLayer).toHaveBeenCalledTimes(moves);
    });
});
