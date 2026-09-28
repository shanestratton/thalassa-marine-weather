import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MutableRefObject } from 'react';
import type mapboxgl from 'mapbox-gl';
import { useWeatherLayers } from '../components/map/useWeatherLayers';

const mock = vi.hoisted(() => ({ fetch: vi.fn(), frame: vi.fn() }));
vi.mock('../services/weather/isobars', () => ({
    generateIsobars: mock.fetch,
    generateIsobarsFromGrid: mock.frame,
    FORECAST_HOURS: 48,
}));
vi.mock('../components/map/isobarLayerSetup', () => ({
    initIsobarLayers: vi.fn(),
    hideIsobarLayers: vi.fn(),
    showIsobarLayers: vi.fn(),
    promoteNavLayers: vi.fn(),
    RAINVIEWER_COLOR_RAMP: '',
}));
vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const HOUR = 3_600_000;
const RUN = Date.parse('2026-09-27T00:00:00Z');
const feature = (run: number, frame: number) => ({
    type: 'FeatureCollection',
    features: [{ type: 'Feature', properties: { run, frame }, geometry: { type: 'Point', coordinates: [0, 0] } }],
});
const makeFrame = (run: number, frame: number) => ({
    contours: feature(run, frame),
    centers: feature(run, frame),
    barbs: feature(run, frame),
    arrows: feature(run, frame),
    tracks: feature(run, frame),
    heatmapDataUrl: null,
    heatmapBounds: null,
});
const makeData = (run = RUN) => ({
    grid: {
        refTime: new Date(run).toISOString(),
        totalHours: 22,
        subFrameStepHours: 2,
        keyframeFhrs: [0, 6],
        source: 'gfs',
    },
    result: makeFrame(run, 0),
});
const setData = vi.fn();
const mapMethods: Record<string, unknown> = {
    getSource: () => ({ setData }),
    getLayer: () => undefined,
    getStyle: () => ({ layers: [], sources: {} }),
    getZoom: () => 3,
    getCenter: () => ({ lat: -27, lng: 153 }),
    isStyleLoaded: () => true,
    getBounds: () => ({ getWest: () => 150, getEast: () => 156, getNorth: () => -24, getSouth: () => -30 }),
};
const map = new Proxy(mapMethods, { get: (object, key) => object[String(key)] ?? vi.fn() });
const mapRef = { current: map } as unknown as MutableRefObject<mapboxgl.Map | null>;

async function flush() {
    await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
    });
}
const mount = () => renderHook(() => useWeatherLayers(mapRef, true, true, { lat: -27, lon: 153 }));

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(RUN + 6 * HOUR);
    sessionStorage.clear();
    sessionStorage.setItem('thalassa_active_layers', JSON.stringify(['pressure']));
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    mock.fetch.mockReset().mockResolvedValue(makeData());
    mock.frame.mockReset().mockImplementation((grid, hour) => makeFrame(Date.parse(grid.refTime), hour));
    setData.mockClear();
});
afterEach(() => {
    vi.useRealTimers();
});

describe('mounted pressure refresh state machine', () => {
    it('reuses a fresh grid and revalidates after TTL without allowing an older model to replace it', async () => {
        const hook = mount();
        await flush();
        expect(mock.fetch).toHaveBeenCalledTimes(1);
        expect(hook.result.current.pressureRefTime).toBe(new Date(RUN).toISOString());
        act(() => window.dispatchEvent(new Event('focus')));
        await flush();
        expect(mock.fetch).toHaveBeenCalledTimes(1);
        mock.fetch.mockResolvedValue(makeData(RUN - 6 * HOUR));
        await act(async () => {
            await vi.advanceTimersByTimeAsync(30 * 60_000);
        });
        expect(mock.fetch).toHaveBeenCalledTimes(2);
        expect(hook.result.current.pressureError).toContain('older forecast');
        expect(hook.result.current.pressureRefTime).toBe(new Date(RUN).toISOString());
        expect(hook.result.current.pressureFetchedAtMs).toBe(RUN + 6 * HOUR);
        hook.unmount();
    });

    it('after days backgrounded, hides an expired now field and recovers on the next successful refresh', async () => {
        const hook = mount();
        await flush();
        expect(hook.result.current.pressureValidTimeMs).toBe(RUN + 6 * HOUR);
        Object.defineProperty(document, 'visibilityState', { value: 'hidden' });
        vi.setSystemTime(RUN + 72 * HOUR);
        mock.fetch.mockResolvedValue(null);
        act(() => window.dispatchEvent(new Event('focus')));
        await flush();
        expect(mock.fetch).toHaveBeenCalledTimes(1);
        Object.defineProperty(document, 'visibilityState', { value: 'visible' });
        act(() => document.dispatchEvent(new Event('visibilitychange')));
        await flush();
        expect(mock.fetch).toHaveBeenCalledTimes(2);
        expect(hook.result.current.pressureTimeUnavailable).toContain('no longer covers now');
        expect(hook.result.current.pressureValidTimeMs).toBeNull();
        expect(setData.mock.calls.at(-1)?.[0].features).toEqual([]);
        mock.fetch.mockResolvedValue(makeData(RUN + 66 * HOUR));
        await act(async () => {
            await vi.advanceTimersByTimeAsync(60_000);
        });
        expect(hook.result.current.pressureError).toBeNull();
        expect(hook.result.current.pressureTimeUnavailable).toBeNull();
        expect(hook.result.current.pressureRefTime).toBe(new Date(RUN + 66 * HOUR).toISOString());
        hook.unmount();
    });

    it('preserves a deliberate valid time through run replacement and ignores a disabled-layer late response', async () => {
        const hook = mount();
        await flush();
        await act(async () => {
            await vi.advanceTimersByTimeAsync(29 * 60_000);
        });
        act(() => hook.result.current.setForecastHour(8)); // old run +16h
        mock.fetch.mockResolvedValue(makeData(RUN + 6 * HOUR));
        await act(async () => {
            await vi.advanceTimersByTimeAsync(60_000);
        });
        expect(hook.result.current.forecastHour).toBe(5); // new run +10h
        expect(hook.result.current.pressureValidTimeMs).toBe(RUN + 16 * HOUR);

        let finish!: (value: ReturnType<typeof makeData>) => void;
        mock.fetch.mockImplementation(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        await act(async () => {
            await vi.advanceTimersByTimeAsync(30 * 60_000);
        });
        expect(hook.result.current.pressureLoading).toBe(true);
        act(() => hook.result.current.toggleLayer('pressure'));
        await act(async () => {
            finish(makeData(RUN + 6 * HOUR));
        });
        expect(hook.result.current.pressureSource).toBeNull();
        expect(hook.result.current.pressureValidTimeMs).toBeNull();
        hook.unmount();
    });

    it('deduplicates foreground events during a request and retries a failed initial load', async () => {
        let finish!: (value: null) => void;
        mock.fetch.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        const hook = mount();
        act(() => {
            window.dispatchEvent(new Event('focus'));
            window.dispatchEvent(new Event('online'));
            document.dispatchEvent(new Event('visibilitychange'));
        });
        expect(mock.fetch).toHaveBeenCalledTimes(1);
        await act(async () => finish(null));
        expect(hook.result.current.pressureError).toContain('unavailable');
        await act(async () => {
            await vi.advanceTimersByTimeAsync(60_000);
        });
        expect(mock.fetch).toHaveBeenCalledTimes(2);
        expect(hook.result.current.pressureError).toBeNull();
        hook.unmount();
    });
});
