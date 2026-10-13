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

describe('the overview waits for the HUD to ask (build 124: the HUD has no switch)', () => {
    // MapHub's gate: passageHudOnChart && passageOverlay && passageOverviewAsked
    // && following … (pinned in tests/PassageHudStandard.test.tsx). Before the
    // switch went, the overview engaged only after the skipper turned the HUD
    // on; now a plain Layers → Passage toggle must still not move the camera.
    type OverviewStore = {
        __resetPassageHudForTests: () => void;
        askPassageOverview: () => void;
        usePassageOverviewAsked: () => boolean;
    };
    it('Layers → Passage alone frames nothing; the HUD’s own ask frames the route', async () => {
        const overlay = await import('../stores/chartPassageOverlay');
        const hud = (await import('../stores/passageHudStore')) as unknown as OverviewStore;
        overlay.__resetPassageOverlayForTests();
        hud.__resetPassageHudForTests();
        const c = chart();
        renderHook(() => {
            const on = overlay.usePassageOverlay();
            const asked = hud.usePassageOverviewAsked();
            return usePassageRouteFrame({ mapRef: c.ref, mapReady: true, enabled: on && asked, route: ROUTE });
        });
        act(() => overlay.setPassageOverlay(true));
        flush();
        c.emit('moveend');
        flush();
        expect(c.raw.fitBounds).not.toHaveBeenCalled();
        act(() => hud.askPassageOverview());
        flush();
        expect(c.raw.fitBounds).toHaveBeenCalledOnce();
        // Overlay off withdraws the ask; back on from Layers, the camera stays put.
        act(() => overlay.setPassageOverlay(false));
        act(() => overlay.setPassageOverlay(true));
        c.displace();
        c.emit('moveend');
        flush();
        expect(c.raw.fitBounds).toHaveBeenCalledOnce();
        overlay.__resetPassageOverlayForTests();
        hud.__resetPassageHudForTests();
    });
});

/**
 * A turned chart and the passage overview (127-11a, audit A8). Mapbox's
 * fitBounds turns the chart to bearing 0 unless told otherwise, and the
 * overview re-fits on each settle that leaves the route out of view: with
 * `bearing: 0` a Track-up chart would be snapped north by every fit and
 * turned back by its mode, for ever. Every fit keeps the mode's bearing now
 * (chartFitBearing). The mode's controller is 127-11b; here a stand-in turns
 * the chart back to its target 100 ms after any settle that is off it.
 */
describe('passage route overview on a turned chart', () => {
    const TARGET = 47;
    /** A fictional north-south passage up a Norwegian-like coast, tall and narrow: turned, it leaves the frame. */
    const COAST = [
        { lat: 66.0, lon: 13.0 },
        { lat: 68.2, lon: 13.6 },
        { lat: 70.4, lon: 14.1 },
    ];
    function turnedChart(target: number | null = TARGET) {
        const handlers = new Map<string, Set<Handler>>();
        const root = document.createElement('main');
        const container = document.createElement('div');
        root.append(container);
        document.body.append(root);
        const width = 430;
        const height = 900;
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
        // A flat chart: x east, y south, scaled by k and turned by -bearing about `at` on screen.
        const cam = { lon: 151.5, lat: -23.5, k: 50, bearing: 0, at: { x: width / 2, y: height / 2 } };
        const turn = (dx: number, dy: number, deg: number) => {
            const a = (-deg * Math.PI) / 180;
            return { x: dx * Math.cos(a) - dy * Math.sin(a), y: dx * Math.sin(a) + dy * Math.cos(a) };
        };
        let moves = 0;
        const emit = (event: string, data = {}) => handlers.get(event)?.forEach((handler) => handler(data));
        const raw = {
            getContainer: () => container,
            getCenter: () => ({ lng: cam.lon, lat: cam.lat }),
            getZoom: () => 8,
            getBearing: () => cam.bearing,
            getPitch: () => 0,
            project: ([lon, lat]: [number, number]) => {
                const d = turn((lon - cam.lon) * cam.k, -(lat - cam.lat) * cam.k, cam.bearing);
                return { x: cam.at.x + d.x, y: cam.at.y + d.y };
            },
            fitBounds: vi.fn(
                (
                    [[west, south], [east, north]]: number[][],
                    options: {
                        padding: { top: number; right: number; bottom: number; left: number };
                        bearing?: number;
                    },
                ) => {
                    moves += 1;
                    const p = options.padding;
                    cam.bearing = options.bearing ?? 0;
                    cam.lon = (west + east) / 2;
                    cam.lat = (south + north) / 2;
                    const corners = [
                        [west, south],
                        [east, south],
                        [east, north],
                        [west, north],
                    ].map(([lon, lat]) => turn(lon - cam.lon, -(lat - cam.lat), cam.bearing));
                    const ex = Math.max(...corners.map((c) => Math.abs(c.x))) * 2;
                    const ey = Math.max(...corners.map((c) => Math.abs(c.y))) * 2;
                    cam.k = Math.min((width - p.left - p.right) / ex, (height - p.top - p.bottom) / ey);
                    cam.at = {
                        x: p.left + (width - p.left - p.right) / 2,
                        y: p.top + (height - p.top - p.bottom) / 2,
                    };
                    emit('movestart');
                    emit('moveend');
                },
            ),
            on: (event: string, handler: Handler) => {
                if (!handlers.has(event)) handlers.set(event, new Set());
                handlers.get(event)!.add(handler);
            },
            off: (event: string, handler: Handler) => handlers.get(event)?.delete(handler),
        };
        // The mode's stand-in: back to its bearing 100 ms after a settle that is off it.
        raw.on('moveend', () => {
            if (target === null || Math.abs(cam.bearing - target) < 0.5) return;
            setTimeout(() => {
                moves += 1;
                cam.bearing = target;
                emit('movestart', { thalassaOrientation: true });
                emit('rotate', { thalassaOrientation: true });
                emit('moveend', { thalassaOrientation: true });
            }, 100);
        });
        return { raw, ref: { current: raw as unknown as mapboxgl.Map }, moves: () => moves };
    }

    afterEach(async () => {
        const { setChartOrientation } = await import('../components/map/chartOrientation');
        setChartOrientation({ turning: false, target: null });
    });

    it('Track up at 47°: every fit keeps 47°, and 30 s of steady inputs is at most 2 camera moves', async () => {
        const { setChartOrientation } = await import('../components/map/chartOrientation');
        setChartOrientation({ turning: true, target: TARGET });
        const c = turnedChart();
        renderHook(() => usePassageRouteFrame({ mapRef: c.ref, mapReady: true, enabled: true, route: COAST }));
        flush();
        for (let t = 0; t < 30_000; t += 500) {
            act(() => {
                vi.advanceTimersByTime(500);
            });
        }
        expect(c.raw.fitBounds).toHaveBeenCalled();
        // No ping-pong between the fit and the mode.
        expect(c.moves()).toBeLessThanOrEqual(2);
        for (const [, options] of c.raw.fitBounds.mock.calls) expect(options).toMatchObject({ bearing: TARGET });
    });

    it('north up: the fit says bearing 0, as it always has', () => {
        const c = turnedChart(null);
        renderHook(() => usePassageRouteFrame({ mapRef: c.ref, mapReady: true, enabled: true, route: COAST }));
        flush();
        expect(c.raw.fitBounds.mock.calls[0][1]).toMatchObject({ bearing: 0 });
    });
});

/**
 * The overview and keeping her on screen (127-11b) never take the camera in
 * turn. Following a route in a turning mode with the overview asked for, the
 * overview frames her at one end of the route, outside the middle 60% of the
 * view. Keeping her on screen would ease her to the lower third, the far end
 * would leave the frame, and the overview would refit at that moveend: a
 * slide and a snap back every 20 s for the whole passage.
 */
describe('the whole-route overview and keeping her on screen, together', () => {
    /** A fictional 12 NM northbound leg in a bay like the Chesapeake's; she is at its start. */
    const LEG = [
        { lat: 38.6, lon: -76.4 },
        { lat: 38.8, lon: -76.38 },
    ];
    function chartWithCamera() {
        const handlers = new Map<string, Set<Handler>>();
        const root = document.createElement('main');
        const container = document.createElement('div');
        root.append(container);
        document.body.append(root);
        const width = 390;
        const height = 844;
        Object.defineProperty(container, 'clientWidth', { value: width });
        Object.defineProperty(container, 'clientHeight', { value: height });
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
        const cam = { lon: -76.39, lat: 38.7, k: 2000, at: { x: width / 2, y: height / 2 } };
        const emit = (event: string, data = {}) => handlers.get(event)?.forEach((handler) => handler(data));
        const moved = (data = {}) => {
            emit('movestart', data);
            emit('moveend', data);
        };
        const raw = {
            getContainer: () => container,
            getCenter: () => ({ lng: cam.lon, lat: cam.lat }),
            getZoom: () => 12,
            getBearing: () => 0,
            getPitch: () => 0,
            isMoving: () => false,
            loaded: () => true,
            project: ([lon, lat]: [number, number]) => ({
                x: cam.at.x + (lon - cam.lon) * cam.k,
                y: cam.at.y - (lat - cam.lat) * cam.k,
            }),
            fitBounds: vi.fn(
                (
                    [[west, south], [east, north]]: number[][],
                    { padding: p }: { padding: { top: number; right: number; bottom: number; left: number } },
                ) => {
                    cam.lon = (west + east) / 2;
                    cam.lat = (south + north) / 2;
                    cam.k = Math.min(
                        (width - p.left - p.right) / Math.max(east - west, 1e-6),
                        (height - p.top - p.bottom) / Math.max(north - south, 1e-6),
                    );
                    cam.at = { x: p.left + (width - p.left - p.right) / 2, y: p.top + (height - p.top - p.bottom) / 2 };
                    moved();
                },
            ),
            /** Keeping her on screen: her at the centre, offset down the screen. */
            easeTo: vi.fn((options: { center?: [number, number]; offset?: [number, number] }, data = {}) => {
                if (options.center) {
                    [cam.lon, cam.lat] = options.center;
                    cam.at = { x: width / 2 + (options.offset?.[0] ?? 0), y: height / 2 + (options.offset?.[1] ?? 0) };
                }
                moved(data);
            }),
            jumpTo: vi.fn(),
            on: (event: string, handler: Handler) => {
                if (!handlers.has(event)) handlers.set(event, new Set());
                handlers.get(event)!.add(handler);
            },
            off: (event: string, handler: Handler) => handlers.get(event)?.delete(handler),
        };
        return { raw, ref: { current: raw as unknown as mapboxgl.Map } };
    }

    it('Heading up under way with the overview locked: no move to keep her on screen, and no refit loop', async () => {
        const { orientChart, orientationKey } = await import('../components/map/chartOrientation');
        const { publishOwnshipMotion } = await import('../components/map/ownshipMotion');
        const c = chartWithCamera();
        const her = LEG[0];
        feeds.own = { ...her, source: 'nmea' };
        renderHook(() => usePassageRouteFrame({ mapRef: c.ref, mapReady: true, enabled: true, route: LEG }));
        flush();
        expect(c.raw.fitBounds).toHaveBeenCalledOnce();
        localStorage.setItem(orientationKey('obs'), 'heading');
        const controller = orientChart(c.ref.current, 'obs', () => ({}));
        try {
            const metric = (value: number) => ({ value, lastUpdated: Date.now(), freshness: 'live' });
            for (let t = 0; t < 70_000; t += 5_000) {
                act(() => {
                    vi.advanceTimersByTime(5_000);
                    publishOwnshipMotion({
                        lane: 'bus',
                        lat: her.lat,
                        lon: her.lon,
                        at: Date.now(),
                        heading: null,
                        speed: null,
                        instruments: { headingTrue: metric(0), cog: metric(0), sog: metric(6) },
                        maxAgeMs: 13_000,
                    } as never);
                });
            }
            const recentres = c.raw.easeTo.mock.calls.filter(([options]) => options.center !== undefined);
            expect(recentres).toEqual([]);
            // One fit when the overview took the chart; the camera then stays put.
            expect(c.raw.fitBounds).toHaveBeenCalledOnce();
        } finally {
            controller.stop();
            publishOwnshipMotion(null);
            localStorage.clear();
        }
    });
});
