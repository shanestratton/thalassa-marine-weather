import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type mapboxgl from 'mapbox-gl';
import type { MutableRefObject } from 'react';
import type { WindGrid } from '../services/weather/windGridEncoding';
import { WindStore } from '../stores/WindStore';
import { windForecastHourAtFrame, windForecastHoursForGrid, windHoursFromNow } from '../components/map/windTimeAxis';
import { useWeatherLayers } from '../components/map/useWeatherLayers';

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
