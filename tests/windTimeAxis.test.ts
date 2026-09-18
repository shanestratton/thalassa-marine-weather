import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type mapboxgl from 'mapbox-gl';
import type { MutableRefObject } from 'react';
import type { WindGrid } from '../services/weather/windGridEncoding';
import { WindStore } from '../stores/WindStore';
import {
    windForecastHourAtFrame,
    windForecastHoursForGrid,
    windFrameForForecastHour,
    windHoursFromNow,
} from '../components/map/windTimeAxis';
import { useWeatherLayers } from '../components/map/useWeatherLayers';
import {
    __resetPassageHudForTests,
    getPassageUnsyncedLayers,
    getPassageWindCoverageHours,
    setPassageAheadMs,
    setPassageHudEnabled,
    setPassageHudOpen,
    startPassageLookAhead,
    stopPassageLookAhead,
} from '../stores/passageHudStore';

vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const mapRef = { current: null } as MutableRefObject<mapboxgl.Map | null>;
const location = { lat: -27.4698, lon: 153.0251 };

function grid(
    totalHours: number,
    metadata: Partial<Pick<WindGrid, 'hourOffsets' | 'stepHours' | 'refTime'>> = {},
): WindGrid {
    const frames = Array.from({ length: totalHours }, () => new Float32Array([1]));
    return {
        u: frames,
        v: frames,
        speed: frames,
        width: 1,
        height: 1,
        lats: [0],
        lons: [0],
        north: 0,
        south: 0,
        west: 0,
        east: 0,
        totalHours,
        ...metadata,
    };
}

describe('wind time axis', () => {
    beforeEach(() => {
        localStorage.clear();
        localStorage.setItem('thalassa_active_layers', JSON.stringify(['wind']));
        WindStore.reset();
    });

    afterEach(() => {
        WindStore.reset();
    });

    it('uses producer metadata, preferring hourOffsets and then stepHours', () => {
        expect(
            windForecastHoursForGrid(
                grid(3, {
                    hourOffsets: [0, 2, 5],
                    stepHours: [0, 3, 6],
                }),
            ),
        ).toEqual([0, 2, 5]);
        expect(windForecastHoursForGrid(grid(3, { stepHours: [0, 3, 6] }))).toEqual([0, 3, 6]);
        expect(
            windForecastHoursForGrid(
                grid(3, {
                    hourOffsets: [0, 2],
                    stepHours: [0, 3, 6],
                }),
            ),
        ).toEqual([0, 3, 6]);
    });

    it('maps a metadata-free 48-frame Open-Meteo grid to 48 sequential hours', () => {
        const axis = windForecastHoursForGrid(grid(48));

        expect(axis).toHaveLength(48);
        expect(axis[9]).toBe(9);
        expect(axis[47]).toBe(47);
        expect(windForecastHourAtFrame(axis, 9.5)).toBe(9.5);
        expect(windHoursFromNow(axis, 9, 0)).toBe(9);
    });

    it('falls back safely when published metadata is malformed', () => {
        expect(windForecastHoursForGrid(grid(4, { hourOffsets: [0, 3, 2, 9] }))).toEqual([0, 1, 2, 3]);
        expect(windForecastHoursForGrid(grid(4, { stepHours: [0, 3, Number.NaN, 9] }))).toEqual([0, 1, 2, 3]);
    });

    it('reactively replaces the timeline when the selected model publishes a new grid', async () => {
        const rendered = renderHook(() => useWeatherLayers(mapRef, false, false, location));

        act(() => {
            WindStore.setGrid(grid(3, { stepHours: [0, 3, 6] }));
        });
        await waitFor(() => {
            expect(rendered.result.current.windReady).toBe(true);
            expect(rendered.result.current.windForecastHours).toEqual([0, 3, 6]);
        });

        act(() => {
            WindStore.setModel('icon');
            WindStore.setGrid(grid(48));
        });
        await waitFor(() => {
            expect(rendered.result.current.windForecastHours).toHaveLength(48);
            expect(rendered.result.current.windForecastHours[9]).toBe(9);
            expect(rendered.result.current.windForecastHours[47]).toBe(47);
            expect(rendered.result.current.windTotalHours).toBe(48);
            expect(rendered.result.current.windNowIdx).toBe(0);
        });
    });
});

describe('which frame shows a given forecast hour — the passage look-ahead’s question', () => {
    const hourly = Array.from({ length: 48 }, (_, i) => i);

    it('is the inverse of windForecastHourAtFrame, fractional frames included', () => {
        for (const hour of [0, 0.25, 6.5, 23, 46.9, 47]) {
            const hit = windFrameForForecastHour(hourly, hour)!;
            expect(hit.beyond).toBe(false);
            expect(windForecastHourAtFrame(hourly, hit.frame)).toBeCloseTo(hour, 6);
        }
    });

    it('lands between the right frames on a grid that is not hourly', () => {
        const gfs = [0, 3, 6, 12, 24];
        expect(windFrameForForecastHour(gfs, 9)).toEqual({ frame: 2.5, beyond: false });
        expect(windFrameForForecastHour(gfs, 18)).toEqual({ frame: 3.5, beyond: false });
    });

    it('SAYS when the grid does not reach that far, rather than handing back its last frame as the answer', () => {
        expect(windFrameForForecastHour(hourly, 47.01)).toEqual({ frame: 47, beyond: true });
        expect(windFrameForForecastHour(hourly, 120)).toEqual({ frame: 47, beyond: true });
    });

    it('has no answer for an empty axis or a nonsense hour', () => {
        expect(windFrameForForecastHour([], 3)).toBeNull();
        expect(windFrameForForecastHour(hourly, Number.NaN)).toBeNull();
    });
});

describe('the passage look-ahead drives the chart’s wind BY THE CLOCK', () => {
    const HOUR = 3_600_000;
    const settle = () => new Promise((resolve) => setTimeout(resolve, 200));

    beforeEach(() => {
        sessionStorage.clear();
        sessionStorage.setItem('thalassa_active_layers', JSON.stringify(['wind']));
        WindStore.reset();
        __resetPassageHudForTests();
        setPassageHudEnabled(true);
        setPassageHudOpen(true);
    });
    afterEach(() => {
        __resetPassageHudForTests();
        WindStore.reset();
        sessionStorage.clear();
    });

    /** A 48-frame hourly grid whose frame 0 was `ageHours` ago — a cached grid, as the chart keeps them. */
    const agedGrid = (ageHours: number) => grid(48, { refTime: new Date(Date.now() - ageHours * HOUR).toISOString() });

    it('+6 h on a grid fetched three hours ago is frame 9 — six hours from NOW, not from the fetch', async () => {
        const rendered = renderHook(() => useWeatherLayers(mapRef, false, false, location));
        act(() => WindStore.setGrid(agedGrid(3)));
        await waitFor(() => expect(rendered.result.current.windReady).toBe(true));
        expect(rendered.result.current.windNowIdx).toBe(3);

        act(() => {
            startPassageLookAhead();
            setPassageAheadMs(6 * HOUR);
        });
        await act(settle);
        expect(rendered.result.current.windHour).toBeCloseTo(9, 1);
    });

    it('reports the hours of field that are really LEFT, so the scrubber marks where the chart’s wind stops', async () => {
        const rendered = renderHook(() => useWeatherLayers(mapRef, false, false, location));
        act(() => WindStore.setGrid(agedGrid(3)));
        await waitFor(() => expect(rendered.result.current.windReady).toBe(true));
        await act(settle);
        // 47 hours on the axis, three of them already behind her.
        expect(getPassageWindCoverageHours()).toBeCloseTo(44, 0);
    });

    it('parks on the last frame past the end of the field — the scrubber, not the particles, says it has ended', async () => {
        const rendered = renderHook(() => useWeatherLayers(mapRef, false, false, location));
        act(() => WindStore.setGrid(agedGrid(0)));
        await waitFor(() => expect(rendered.result.current.windReady).toBe(true));
        act(() => {
            startPassageLookAhead();
            setPassageAheadMs(100 * HOUR);
        });
        await act(settle);
        expect(rendered.result.current.windHour).toBe(47);
        expect(getPassageWindCoverageHours()).toBeLessThan(100);
    });

    it('hands the timeline straight back to Now when the glance ends', async () => {
        const rendered = renderHook(() => useWeatherLayers(mapRef, false, false, location));
        act(() => WindStore.setGrid(agedGrid(3)));
        await waitFor(() => expect(rendered.result.current.windReady).toBe(true));
        act(() => {
            startPassageLookAhead();
            setPassageAheadMs(12 * HOUR);
        });
        await act(settle);
        expect(rendered.result.current.windHour).toBeCloseTo(15, 1);
        act(() => stopPassageLookAhead());
        await act(settle);
        expect(rendered.result.current.windHour).toBe(3);
    });

    it('adding another layer mid-glance does not drop the wind back to Now', async () => {
        const rendered = renderHook(() => useWeatherLayers(mapRef, false, false, location));
        act(() => WindStore.setGrid(agedGrid(0)));
        await waitFor(() => expect(rendered.result.current.windReady).toBe(true));
        act(() => {
            startPassageLookAhead();
            setPassageAheadMs(6 * HOUR);
        });
        await act(settle);
        expect(rendered.result.current.windHour).toBeCloseTo(6, 1);
        // The wind-load effect resets the timeline to frame 0 on every layer-set change.
        act(() => rendered.result.current.toggleLayer('pressure'));
        await act(settle);
        expect(rendered.result.current.windHour).toBeCloseTo(6, 1);
    });

    it('names the layers that are NOT at the scrubbed moment, and stops them animating with no pause button', async () => {
        sessionStorage.setItem('thalassa_active_layers', JSON.stringify(['wind', 'rain']));
        const rendered = renderHook(() => useWeatherLayers(mapRef, false, false, location));
        act(() => rendered.result.current.setRainPlaying(true));
        expect(getPassageUnsyncedLayers()).toEqual([]);
        act(() => startPassageLookAhead());
        await act(settle);
        expect(getPassageUnsyncedLayers()).toEqual(['rain']);
        expect(rendered.result.current.rainPlaying).toBe(false);
        act(() => stopPassageLookAhead());
        await act(settle);
        expect(getPassageUnsyncedLayers()).toEqual([]);
    });

    it('isobars riding the wind timeline are NOT on that list; isobars alone are', async () => {
        sessionStorage.setItem('thalassa_active_layers', JSON.stringify(['wind', 'pressure']));
        const both = renderHook(() => useWeatherLayers(mapRef, false, false, location));
        act(() => startPassageLookAhead());
        await act(settle);
        expect(getPassageUnsyncedLayers()).toEqual([]);
        both.unmount();
        act(() => stopPassageLookAhead());

        sessionStorage.setItem('thalassa_active_layers', JSON.stringify(['pressure']));
        renderHook(() => useWeatherLayers(mapRef, false, false, location));
        act(() => startPassageLookAhead());
        await act(settle);
        expect(getPassageUnsyncedLayers()).toEqual(['pressure']);
    });
});
