import { act, cleanup, renderHook } from '@testing-library/react';
import type mapboxgl from 'mapbox-gl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRouteTrackLayer, type RouteTrackVariant } from '../components/map/useRouteTrackLayer';
import type { RouteOrTrack } from '../services/shiplog/RoutesAndTracks';
import { startPassageLookAhead, stopPassageLookAhead } from '../stores/passageHudStore';

const markers = vi.hoisted(() => ({
    all: [] as Array<{ setLngLat: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> }>,
}));
vi.mock('mapbox-gl', () => ({
    default: {
        Marker: class {
            setLngLat = vi.fn(() => this);
            addTo = vi.fn(() => this);
            remove = vi.fn();
            constructor() {
                markers.all.push(this);
            }
        },
    },
}));

type Feature = GeoJSON.Feature<GeoJSON.LineString>;
function chart() {
    const sources = new Map<string, { data: Feature; setData: ReturnType<typeof vi.fn> }>();
    const layers: mapboxgl.AnyLayer[] = [];
    const handlers = new Map<string, Set<() => void>>();
    let ready = true;
    const raw = {
        isStyleLoaded: () => ready,
        getSource: (id: string) => sources.get(id),
        addSource: vi.fn((id: string, definition: { data: Feature }) => {
            if (sources.has(id)) throw new Error('Duplicate source');
            const source = {
                data: definition.data,
                setData: vi.fn((data: Feature) => {
                    source.data = data;
                }),
            };
            sources.set(id, source);
        }),
        removeSource: vi.fn((id: string) => sources.delete(id)),
        getLayer: (id: string) => layers.find((layer) => layer.id === id),
        addLayer: vi.fn((layer: mapboxgl.AnyLayer) => {
            if (layers.some((existing) => existing.id === layer.id)) throw new Error('Duplicate layer');
            layers.push(layer);
        }),
        removeLayer: vi.fn((id: string) => {
            const index = layers.findIndex((layer) => layer.id === id);
            if (index >= 0) layers.splice(index, 1);
        }),
        getStyle: () => ({ layers }),
        moveLayer: vi.fn((id: string) => {
            const index = layers.findIndex((layer) => layer.id === id);
            const [layer] = layers.splice(index, 1);
            layers.push(layer);
        }),
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
        beginStyleSwap: () => {
            ready = false;
            sources.clear();
            layers.length = 0;
        },
        finishStyleSwap: () => {
            ready = true;
            act(() => handlers.get('style.load')?.forEach((handler) => handler()));
        },
    };
}

function item(
    id = 'passage-1',
    points = [
        { lat: -27, lon: 153 },
        { lat: -26, lon: 154 },
    ],
): RouteOrTrack {
    return {
        id,
        label: 'Passage',
        sublabel: '',
        points,
        bbox: [153, -27, 154, -26],
        timestamp: 0,
        distanceNm: 80,
        isLocal: true,
        kind: 'sea',
    };
}

beforeEach(() => {
    markers.all.length = 0;
    stopPassageLookAhead();
});
afterEach(() => {
    cleanup();
    stopPassageLookAhead();
});

describe('route and track chart lifecycle', () => {
    it.each<RouteTrackVariant>(['route', 'track'])(
        'preserves the look-ahead view when the %s mounts or changes selection',
        (variant) => {
            const c = chart();
            startPassageLookAhead();
            const hook = renderHook(
                ({ selected }) => useRouteTrackLayer({ mapRef: c.ref, mapReady: true, variant, selected }),
                { initialProps: { selected: item() } },
            );
            hook.rerender({ selected: item('passage-2') });
            expect(c.layers).toHaveLength(2);
            expect(c.raw.fitBounds).not.toHaveBeenCalled();
            stopPassageLookAhead();
            c.emit('idle');
            expect(c.raw.fitBounds).not.toHaveBeenCalled();
            hook.rerender({ selected: item('picker-selection') });
            expect(c.raw.fitBounds).toHaveBeenCalledOnce();
        },
    );

    it.each<RouteTrackVariant>(['route', 'track'])(
        'draws the %s solid, updates same-id geometry and endpoints without fitting again',
        (variant) => {
            const c = chart();
            const initial = item();
            const hook = renderHook(
                ({ selected }) => useRouteTrackLayer({ mapRef: c.ref, mapReady: true, variant, selected }),
                {
                    initialProps: { selected: initial },
                },
            );
            const line = c.raw.getLayer(`routetrack-${variant}-line`) as mapboxgl.LineLayer;
            expect(line.paint?.['line-color']).toBe(variant === 'route' ? '#a855f7' : '#fbbf24');
            expect(line.paint).not.toHaveProperty('line-dasharray');
            expect(c.raw.fitBounds).toHaveBeenCalledOnce();

            const updated = item(initial.id, [...initial.points, { lat: -25, lon: 155 }]);
            hook.rerender({ selected: updated });
            const source = c.sources.get(`routetrack-${variant}-source`)!;
            expect(source.data.geometry.coordinates).toEqual([
                [153, -27],
                [154, -26],
                [155, -25],
            ]);
            expect(source.setData).toHaveBeenCalledOnce();
            expect(markers.all).toHaveLength(2);
            expect(markers.all[1].setLngLat).toHaveBeenLastCalledWith([155, -25]);
            expect(c.raw.fitBounds).toHaveBeenCalledOnce();
            expect(c.handlers.get('idle')?.size).toBe(1);
        },
    );

    it('fits explicit selection changes and selecting again after clearing', () => {
        const c = chart();
        const hook = renderHook(
            ({ selected }: { selected: RouteOrTrack | null }) =>
                useRouteTrackLayer({ mapRef: c.ref, mapReady: true, variant: 'route', selected }),
            {
                initialProps: { selected: item() as RouteOrTrack | null },
            },
        );
        hook.rerender({ selected: item('passage-2') });
        expect(c.raw.fitBounds).toHaveBeenCalledTimes(2);
        hook.rerender({ selected: null });
        expect(c.sources.size).toBe(0);
        expect(c.layers).toHaveLength(0);
        expect(markers.all.every((marker) => marker.remove.mock.calls.length === 1)).toBe(true);
        expect(c.handlers.get('idle')?.size).toBe(0);
        expect(c.handlers.get('style.load')?.size).toBe(0);
        hook.rerender({ selected: item('passage-2') });
        expect(c.raw.fitBounds).toHaveBeenCalledTimes(3);
    });

    it('restores latest geometry after repeated style swaps without another fit, marker, or listener', () => {
        const c = chart();
        const hook = renderHook(
            ({ selected }) => useRouteTrackLayer({ mapRef: c.ref, mapReady: true, variant: 'track', selected }),
            {
                initialProps: { selected: item() },
            },
        );
        c.beginStyleSwap();
        hook.rerender({
            selected: item('passage-1', [
                { lat: -27, lon: 153 },
                { lat: -24, lon: 156 },
            ]),
        });
        c.finishStyleSwap();
        c.finishStyleSwap();
        expect(c.sources.get('routetrack-track-source')?.data.geometry.coordinates).toEqual([
            [153, -27],
            [156, -24],
        ]);
        expect(c.layers).toHaveLength(2);
        expect(markers.all).toHaveLength(2);
        expect(markers.all[1].setLngLat).toHaveBeenLastCalledWith([156, -24]);
        expect(c.raw.fitBounds).toHaveBeenCalledOnce();
        expect(c.handlers.get('idle')?.size).toBe(1);
        expect(c.handlers.get('style.load')?.size).toBe(1);
        hook.unmount();
        expect(c.handlers.get('idle')?.size).toBe(0);
        expect(c.handlers.get('style.load')?.size).toBe(0);
        expect(markers.all.every((marker) => marker.remove.mock.calls.length === 1)).toBe(true);
    });

    it('keeps route and track above late weather and ENC without an idle promotion loop', () => {
        const c = chart();
        renderHook(() => {
            useRouteTrackLayer({ mapRef: c.ref, mapReady: true, variant: 'route', selected: item('route') });
            useRouteTrackLayer({ mapRef: c.ref, mapReady: true, variant: 'track', selected: item('track') });
        });
        c.emit('idle');
        expect(c.raw.moveLayer).not.toHaveBeenCalled();
        c.raw.addLayer({ id: 'weather-raster', type: 'background' });
        c.raw.addLayer({ id: 'enc-depth', type: 'background' });
        c.emit('idle');
        expect(c.raw.moveLayer).toHaveBeenCalledTimes(4);
        expect(c.layers.slice(-4).map((layer) => layer.id)).toEqual([
            'routetrack-route-glow',
            'routetrack-route-line',
            'routetrack-track-glow',
            'routetrack-track-line',
        ]);
        c.emit('idle');
        c.emit('idle');
        expect(c.raw.moveLayer).toHaveBeenCalledTimes(4);
        expect(c.raw.fitBounds).toHaveBeenCalledTimes(2);
    });

    it('does not refit a selection when map readiness is restored', () => {
        const c = chart();
        const selected = item();
        const hook = renderHook(
            ({ mapReady }) => useRouteTrackLayer({ mapRef: c.ref, mapReady, variant: 'route', selected }),
            {
                initialProps: { mapReady: true },
            },
        );
        hook.rerender({ mapReady: false });
        hook.rerender({ mapReady: true });
        expect(c.raw.fitBounds).toHaveBeenCalledOnce();
        expect(c.layers).toHaveLength(2);
        expect(c.handlers.get('idle')?.size).toBe(1);
    });
});
