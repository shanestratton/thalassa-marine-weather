/**
 * The ENC merge window on a turned chart (127-11a, audit A7).
 *
 * The chart merges its S-57 cells for a window round the view (getBounds x
 * 2.5) and re-merges only when the view leaves it: the merge is the
 * expensive step of the island kill chain (WebContent's 2 GB cap). getBounds
 * on a turned chart is the box round the turned view, so a window made at 45°
 * covered about 2.3x the area of a north-up one on a portrait phone, and a
 * turn alone could carry the view out of a window made north-up. In a
 * turning mode (and not plotting) the window is a square on the camera,
 * side max(1.05 x the view's diagonal, 2.5 x sqrt(w x h)): today's area, and
 * any bearing fits inside it. North up and plotting keep today's window.
 *
 * The positions are fictional (a Chesapeake-like bay).
 */
import { act, cleanup, renderHook } from '@testing-library/react';
import type mapboxgl from 'mapbox-gl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ merge: vi.fn() }));
vi.mock('../services/enc/EncHazardService', () => ({
    GLAZE_MIN_ZOOM: 10,
    getMergedVectorData: mocks.merge,
    hasAnyDisplayCells: () => true,
    setMergeInteractionProbe: vi.fn(),
    subscribe: () => () => {},
    subscribeGeometryUpgrades: () => () => {},
}));
vi.mock('../components/map/EncVectorLayer', () => ({
    attachEncFeatureClickHandlers: vi.fn(),
    detachEncFeatureClickHandlers: vi.fn(),
    mountEncVectorLayer: vi.fn(),
    refreshEncAsyncLayers: vi.fn(),
    refreshEncVectorData: vi.fn(),
    setEncChartDetail: vi.fn(),
    setEncOverviewMode: vi.fn(),
    setEncVectorVisibility: vi.fn(),
    unmountEncVectorLayer: vi.fn(),
    updateEncDepthStyle: vi.fn(),
}));

import { useEncVectorLayer, windowFor } from '../components/map/useEncVectorLayer';
import { setChartOrientation } from '../components/map/chartOrientation';

const W = 390;
const H = 844;
const ZOOM = 11;
const BAY = { lng: -76.4, lat: 38.6 };

const worldPx = (zoom: number) => 512 * Math.pow(2, zoom);
const mercX = (lng: number, zoom: number) => ((lng + 180) / 360) * worldPx(zoom);
const mercY = (lat: number, zoom: number) =>
    (0.5 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / (2 * Math.PI)) * worldPx(zoom);
const lngOf = (x: number, zoom: number) => (x / worldPx(zoom)) * 360 - 180;
const latOf = (y: number, zoom: number) =>
    (360 / Math.PI) * Math.atan(Math.exp((0.5 - y / worldPx(zoom)) * 2 * Math.PI)) - 90;

/** A chart whose getBounds is Mapbox's: the box round the four corners of the (turned) view. */
function chart(w = W, h = H) {
    const cam = { x: mercX(BAY.lng, ZOOM), y: mercY(BAY.lat, ZOOM), zoom: ZOOM, bearing: 0 };
    const handlers = new Map<string, Set<() => void>>();
    const container = document.createElement('div');
    Object.defineProperty(container, 'clientWidth', { configurable: true, get: () => w });
    Object.defineProperty(container, 'clientHeight', { configurable: true, get: () => h });
    const corners = () => {
        const a = (cam.bearing * Math.PI) / 180;
        return [
            [-w / 2, -h / 2],
            [w / 2, -h / 2],
            [w / 2, h / 2],
            [-w / 2, h / 2],
        ].map(([dx, dy]) => ({
            // Screen offsets back to north-up: turned by +bearing.
            x: cam.x + dx * Math.cos(a) - dy * Math.sin(a),
            y: cam.y + dx * Math.sin(a) + dy * Math.cos(a),
        }));
    };
    const map = {
        getZoom: () => cam.zoom,
        getBearing: () => cam.bearing,
        getCenter: () => ({ lng: lngOf(cam.x, cam.zoom), lat: latOf(cam.y, cam.zoom) }),
        getContainer: () => container,
        getBounds: () => {
            const c = corners();
            const xs = c.map((p) => p.x);
            const ys = c.map((p) => p.y);
            const west = lngOf(Math.min(...xs), cam.zoom);
            const east = lngOf(Math.max(...xs), cam.zoom);
            const north = latOf(Math.min(...ys), cam.zoom);
            const south = latOf(Math.max(...ys), cam.zoom);
            return { getWest: () => west, getEast: () => east, getSouth: () => south, getNorth: () => north };
        },
        isMoving: () => false,
        on: (event: string, fn: () => void) => {
            if (!handlers.has(event)) handlers.set(event, new Set());
            handlers.get(event)!.add(fn);
        },
        off: (event: string, fn: () => void) => handlers.get(event)?.delete(fn),
        once: vi.fn(),
    };
    return {
        map: map as unknown as mapboxgl.Map,
        cam,
        settle: () => handlers.get('moveend')?.forEach((fn) => fn()),
    };
}

/** A window's size in screen pixels at the chart's zoom. */
function windowPx(win: [number, number, number, number], zoom = ZOOM) {
    return {
        w: mercX(win[2], zoom) - mercX(win[0], zoom),
        h: mercY(win[1], zoom) - mercY(win[3], zoom),
    };
}

function inside(map: mapboxgl.Map, win: [number, number, number, number]) {
    const b = map.getBounds()!;
    return b.getWest() >= win[0] && b.getSouth() >= win[1] && b.getEast() <= win[2] && b.getNorth() <= win[3];
}

async function flush(ms = 300) {
    await act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
    });
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.merge.mockResolvedValue({ cellCount: 3, DEPARE: { features: [{}] }, DEPARE_GLAZE: { features: [] } });
});
afterEach(() => {
    setChartOrientation({ turning: false, target: null });
    cleanup();
    vi.useRealTimers();
});

describe('windowFor', () => {
    it('north up: exactly today’s window (getBounds x 2.5 about its centre)', () => {
        const { map } = chart();
        const b = map.getBounds()!;
        const cx = (b.getWest() + b.getEast()) / 2;
        const cy = (b.getSouth() + b.getNorth()) / 2;
        const hw = ((b.getEast() - b.getWest()) / 2) * 2.5;
        const hh = ((b.getNorth() - b.getSouth()) / 2) * 2.5;
        expect(windowFor(map)).toEqual([cx - hw, Math.max(cy - hh, -85), cx + hw, Math.min(cy + hh, 85)]);
    });

    it('plotting keeps today’s window even in a turning mode', () => {
        const { map, cam } = chart();
        const today = windowFor(map, true);
        setChartOrientation({ turning: true, target: 30 });
        cam.bearing = 30;
        const b = map.getBounds()!;
        const cx = (b.getWest() + b.getEast()) / 2;
        const cy = (b.getSouth() + b.getNorth()) / 2;
        const hw = ((b.getEast() - b.getWest()) / 2) * 2.5;
        const hh = ((b.getNorth() - b.getSouth()) / 2) * 2.5;
        expect(windowFor(map, true)).toEqual([cx - hw, Math.max(cy - hh, -85), cx + hw, Math.min(cy + hh, 85)]);
        expect(today).not.toEqual(windowFor(map, true));
    });

    it('in a turning mode: one square of today’s area, holding the view at every bearing', () => {
        const { map, cam } = chart();
        setChartOrientation({ turning: true, target: 0 });
        const side = Math.max(1.05 * Math.hypot(W, H), 2.5 * Math.sqrt(W * H));
        const first = windowFor(map);
        for (let bearing = 0; bearing < 360; bearing += 15) {
            cam.bearing = bearing;
            const win = windowFor(map);
            const px = windowPx(win);
            expect(px.w).toBeCloseTo(side, 6);
            expect(px.h).toBeCloseTo(side, 6);
            // Today's north-up area, whatever the bearing (was ~2.3x at 45°).
            expect((px.w * px.h) / (2.5 * W * 2.5 * H)).toBeCloseTo(1, 6);
            expect(win).toEqual(first);
            expect(inside(map, win)).toBe(true);
        }
    });

    it('a wide desk window gets a square that still holds its diagonal', () => {
        const { map, cam } = chart(1440, 900);
        setChartOrientation({ turning: true, target: 45 });
        cam.bearing = 45;
        const px = windowPx(windowFor(map));
        expect(px.w).toBeGreaterThanOrEqual(1.05 * Math.hypot(1440, 900) - 1e-6);
        expect(inside(map, windowFor(map))).toBe(true);
    });
});

describe('turning alone never starts a merge', () => {
    it('a pan inside the window, then a turn to 90, 180 and 270: no new merge', async () => {
        const c = chart();
        setChartOrientation({ turning: true, target: 0 });
        renderHook(() => useEncVectorLayer({ current: c.map }, true, true));
        await flush();
        const merges = mocks.merge.mock.calls.length;
        expect(merges).toBeGreaterThan(0);
        // 250 px east: still inside the window it merged, north up.
        c.cam.x += 250;
        act(() => c.settle());
        await flush();
        expect(mocks.merge.mock.calls.length).toBe(merges);
        for (const bearing of [90, 180, 270]) {
            c.cam.bearing = bearing;
            act(() => c.settle());
            await flush();
        }
        expect(mocks.merge.mock.calls.length).toBe(merges);
    });
});
