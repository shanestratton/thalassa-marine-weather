import { act, cleanup, renderHook } from '@testing-library/react';
import type mapboxgl from 'mapbox-gl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePassageRouteFrame } from '../components/map/usePassageRouteFrame';
type TestPhone = { latitude: number; longitude: number; timestamp: number };

const feeds = vi.hoisted(() => ({
    phone: null as TestPhone | null,
    own: null as null | { lat: number; lon: number; source: 'nmea' | 'gps' },
    phoneListeners: new Set<(point: TestPhone) => void>(),
    nmeaListeners: new Set<() => void>(),
    locationListeners: new Set<() => void>(),
    watch: vi.fn(),
}));
vi.mock('../services/GpsService', () => ({
    GpsService: {
        getLastKnownPosition: () => feeds.phone,
        watchPosition: (...args: unknown[]) => {
            feeds.watch(...args);
            const callback = args[0] as (point: NonNullable<typeof feeds.phone>) => void;
            feeds.phoneListeners.add(callback);
            return () => feeds.phoneListeners.delete(callback);
        },
    },
}));
vi.mock('../services/NmeaStore', () => ({
    NmeaStore: {
        getState: () => ({}),
        subscribe: (callback: () => void) => {
            feeds.nmeaListeners.add(callback);
            return () => feeds.nmeaListeners.delete(callback);
        },
    },
}));
vi.mock('../stores/LocationStore', () => ({
    LocationStore: {
        getState: () => ({}),
        subscribe: (callback: () => void) => {
            feeds.locationListeners.add(callback);
            return () => feeds.locationListeners.delete(callback);
        },
    },
}));
vi.mock('../services/ownshipPosition', () => ({ resolveOwnshipPosition: () => feeds.own }));

const ROUTE = [
    { lat: -25, lon: 150 },
    { lat: -24, lon: 153 },
    { lat: -22, lon: 152 },
];
type Handler = (event?: { originalEvent?: unknown }) => void;
function chart() {
    const handlers = new Map<string, Set<Handler>>();
    const root = document.createElement('main');
    const container = document.createElement('div');
    root.append(container);
    document.body.append(root);
    let width = 430;
    let height = 900;
    container.getBoundingClientRect = () => ({
        width,
        height,
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: width,
        bottom: height,
        toJSON: () => ({}),
    });
    let box = [
        [0, 0],
        [1, 1],
    ];
    let padding = { top: 0, right: 0, bottom: 0, left: 0 };
    const emit = (event: string, data = {}) => handlers.get(event)?.forEach((handler) => handler(data));
    const raw = {
        getContainer: () => container,
        getCenter: () => ({ lng: (box[0][0] + box[1][0]) / 2 }),
        getZoom: () => 8,
        getBearing: () => 0,
        getPitch: () => 0,
        project: vi.fn(([lon, lat]: [number, number]) => ({
            x:
                padding.left +
                ((lon - box[0][0]) / (box[1][0] - box[0][0] || 1)) * (width - padding.left - padding.right),
            y:
                padding.top +
                ((box[1][1] - lat) / (box[1][1] - box[0][1] || 1)) * (height - padding.top - padding.bottom),
        })),
        fitBounds: vi.fn((next: number[][], options: typeof padding & { padding: typeof padding }) => {
            box = next;
            padding = options.padding;
            emit('movestart');
            emit('moveend');
        }),
        on: (event: string, handler: Handler) => {
            if (!handlers.has(event)) handlers.set(event, new Set());
            handlers.get(event)!.add(handler);
        },
        off: (event: string, handler: Handler) => handlers.get(event)?.delete(handler),
    };
    return {
        raw,
        root,
        handlers,
        ref: { current: raw as unknown as mapboxgl.Map },
        emit: (event: string, data = {}) => act(() => emit(event, data)),
        displace: () => {
            box = [
                [20, 20],
                [21, 21],
            ];
        },
        resize: () => {
            width = 393;
            height = 852;
        },
    };
}
const flush = () =>
    act(() => {
        vi.advanceTimersByTime(0);
    });

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-20T00:00:00Z'));
    feeds.phone = null;
    feeds.own = null;
    feeds.watch.mockClear();
});
afterEach(() => {
    cleanup();
    document.querySelectorAll('main').forEach((node) => node.remove());
    vi.useRealTimers();
});

describe('passage route overview camera', () => {
    it('frames the complete followed route and actual off-route position on activation', () => {
        const c = chart();
        feeds.own = { lat: -26, lon: 155, source: 'nmea' };
        renderHook(() => usePassageRouteFrame({ mapRef: c.ref, mapReady: true, enabled: true, route: ROUTE }));
        flush();
        expect(c.raw.fitBounds).toHaveBeenCalledOnce();
        expect(c.raw.fitBounds.mock.calls[0][0]).toEqual([
            [150, -26],
            [155, -22],
        ]);
        expect(c.raw.fitBounds.mock.calls[0][1]).toMatchObject({
            duration: 0,
            retainPadding: false,
            bearing: 0,
            pitch: 0,
        });
    });

    it('does not refit on irrelevant instrument data, age ticks or its own moveend', () => {
        const c = chart();
        renderHook(() => usePassageRouteFrame({ mapRef: c.ref, mapReady: true, enabled: true, route: ROUTE }));
        flush();
        c.raw.project.mockClear();
        act(() => feeds.nmeaListeners.forEach((fn) => fn()));
        flush();
        expect(c.raw.project).not.toHaveBeenCalled();
        c.emit('moveend');
        flush();
        act(() => vi.advanceTimersByTime(10_000));
        expect(c.raw.fitBounds).toHaveBeenCalledOnce();
    });

    it('does not repeatedly fight impossible camera constraints', () => {
        const c = chart();
        c.raw.fitBounds.mockImplementation(() => {});
        renderHook(() => usePassageRouteFrame({ mapRef: c.ref, mapReady: true, enabled: true, route: ROUTE }));
        flush();
        for (let i = 0; i < 8; i++) {
            c.emit('moveend');
            flush();
            act(() => vi.advanceTimersByTime(2000));
        }
        expect(c.raw.fitBounds).toHaveBeenCalledOnce();
    });

    it('frames a date-line route around its adjacent world copy', () => {
        const c = chart();
        feeds.own = { lat: -20, lon: -178, source: 'nmea' };
        renderHook(() =>
            usePassageRouteFrame({
                mapRef: c.ref,
                mapReady: true,
                enabled: true,
                route: [
                    { lat: -20, lon: 179 },
                    { lat: -21, lon: -179 },
                ],
            }),
        );
        flush();
        const [west, east] = c.raw.fitBounds.mock.calls[0][0];
        expect(east[0] - west[0]).toBe(3);
    });

    it('restores overview after a competing programmatic camera move', () => {
        const c = chart();
        const hook = renderHook(() =>
            usePassageRouteFrame({ mapRef: c.ref, mapReady: true, enabled: true, route: ROUTE }),
        );
        flush();
        act(() => vi.advanceTimersByTime(1001));
        c.displace();
        c.emit('movestart');
        c.emit('moveend');
        flush();
        expect(hook.result.current.overviewLocked).toBe(true);
        expect(c.raw.fitBounds).toHaveBeenCalledTimes(2);
    });

    it.each(['movestart', 'zoomstart', 'dragstart'])(
        'lets a genuine %s inspect the chart until Whole route is selected',
        (event) => {
            const c = chart();
            const hook = renderHook(() =>
                usePassageRouteFrame({ mapRef: c.ref, mapReady: true, enabled: true, route: ROUTE }),
            );
            flush();
            c.emit(event, { originalEvent: new Event('pointerdown') });
            c.displace();
            c.emit('moveend');
            act(() => vi.advanceTimersByTime(10_000));
            expect(hook.result.current.overviewLocked).toBe(false);
            expect(c.raw.fitBounds).toHaveBeenCalledOnce();
            act(() => hook.result.current.resumeOverview());
            flush();
            expect(hook.result.current.overviewLocked).toBe(true);
            expect(c.raw.fitBounds).toHaveBeenCalledTimes(2);
        },
    );

    it('tracks GPS outside the overview, preferring boat over phone', () => {
        const c = chart();
        feeds.phone = { latitude: -60, longitude: 100, timestamp: Date.now() };
        feeds.own = { lat: -24, lon: 151, source: 'nmea' };
        renderHook(() => usePassageRouteFrame({ mapRef: c.ref, mapReady: true, enabled: true, route: ROUTE }));
        flush();
        expect(c.raw.fitBounds.mock.calls[0][0]).toEqual([
            [150, -25],
            [153, -22],
        ]);
        feeds.own = { lat: -27, lon: 155, source: 'nmea' };
        act(() => feeds.nmeaListeners.forEach((fn) => fn()));
        flush();
        expect(c.raw.fitBounds.mock.calls[1][0]).toEqual([
            [150, -27],
            [155, -22],
        ]);
    });

    it('uses passive stamped phone fixes but ignores stale cached GPS', () => {
        const c = chart();
        feeds.phone = { latitude: -60, longitude: 100, timestamp: Date.now() - 601_000 };
        renderHook(() => usePassageRouteFrame({ mapRef: c.ref, mapReady: true, enabled: true, route: ROUTE }));
        flush();
        expect(c.raw.fitBounds.mock.calls[0][0]).toEqual([
            [150, -25],
            [153, -22],
        ]);
        expect(feeds.watch.mock.calls[0]).toHaveLength(1);
        act(() => feeds.phoneListeners.forEach((fn) => fn({ latitude: -26, longitude: 154, timestamp: Date.now() })));
        flush();
        expect(c.raw.fitBounds.mock.calls[1][0]).toEqual([
            [150, -26],
            [154, -22],
        ]);
    });

    it('reframes changed geometry and changed layout without remounting feeds', () => {
        const c = chart();
        const hook = renderHook(
            ({ route, layoutKey }) =>
                usePassageRouteFrame({ mapRef: c.ref, mapReady: true, enabled: true, route, layoutKey }),
            { initialProps: { route: ROUTE, layoutKey: 'open' } },
        );
        flush();
        hook.rerender({ route: [...ROUTE, { lat: -20, lon: 155 }], layoutKey: 'open' });
        flush();
        expect(c.raw.fitBounds.mock.calls[1][0]).toEqual([
            [150, -25],
            [155, -20],
        ]);
        hook.rerender({ route: ROUTE, layoutKey: 'closed' });
        flush();
        expect(c.raw.fitBounds).toHaveBeenCalledTimes(3);
        expect(feeds.watch).toHaveBeenCalledOnce();
    });

    it('does not take camera back on collapse during inspection, but a new voyage does', () => {
        const c = chart();
        const hook = renderHook(
            ({ routeKey, layoutKey }) =>
                usePassageRouteFrame({
                    mapRef: c.ref,
                    mapReady: true,
                    enabled: true,
                    route: ROUTE,
                    routeKey,
                    layoutKey,
                }),
            { initialProps: { routeKey: 'voyage-one', layoutKey: 'open' } },
        );
        flush();
        c.emit('dragstart', { originalEvent: new Event('pointerdown') });
        hook.rerender({ routeKey: 'voyage-one', layoutKey: 'closed' });
        flush();
        expect(hook.result.current.overviewLocked).toBe(false);
        expect(c.raw.fitBounds).toHaveBeenCalledOnce();
        hook.rerender({ routeKey: 'voyage-two', layoutKey: 'closed' });
        flush();
        expect(hook.result.current.overviewLocked).toBe(true);
        expect(c.raw.fitBounds).toHaveBeenCalledTimes(2);
    });

    it('refits a resized map and releases all listeners/timers when disabled', () => {
        const c = chart();
        const hook = renderHook(
            ({ enabled }) => usePassageRouteFrame({ mapRef: c.ref, mapReady: true, enabled, route: ROUTE }),
            { initialProps: { enabled: true } },
        );
        flush();
        c.resize();
        c.emit('resize');
        flush();
        expect(c.raw.fitBounds).toHaveBeenCalledTimes(2);
        hook.rerender({ enabled: false });
        expect([...c.handlers.values()].every((handlers) => handlers.size === 0)).toBe(true);
        expect(feeds.nmeaListeners.size + feeds.locationListeners.size + feeds.phoneListeners.size).toBe(0);
        act(() => vi.advanceTimersByTime(10_000));
        expect(c.raw.fitBounds).toHaveBeenCalledTimes(2);
    });

    it('does no camera or GPS work on disabled, unready, or route-less surfaces', () => {
        const c = chart();
        renderHook(() => usePassageRouteFrame({ mapRef: c.ref, mapReady: true, enabled: false, route: ROUTE }));
        renderHook(() => usePassageRouteFrame({ mapRef: c.ref, mapReady: false, enabled: true, route: ROUTE }));
        renderHook(() => usePassageRouteFrame({ mapRef: c.ref, mapReady: true, enabled: true, route: [] }));
        flush();
        expect(feeds.watch).not.toHaveBeenCalled();
        expect(c.raw.fitBounds).not.toHaveBeenCalled();
    });
});
