import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type mapboxgl from 'mapbox-gl';
import type { MutableRefObject } from 'react';

vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { useWeatherLayers } from '../components/map/useWeatherLayers';

const STORAGE_KEY = 'thalassa_active_layers';
const LOCATION = { lat: -27.4698, lon: 153.0251 };
const mapRef = { current: null } as MutableRefObject<mapboxgl.Map | null>;

function sortedLayers(layers: Set<string>): string[] {
    return [...layers].sort();
}

function storedLayers(): string[] {
    return [...(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as string[])].sort();
}

describe('useWeatherLayers plan-mode boundary', () => {
    beforeEach(() => {
        localStorage.clear();
    });

    it('suppresses Chart layers on Plan and restores the same user selection on return', async () => {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(['wind']));
        const rendered = renderHook(
            ({ planMode }: { planMode: boolean }) => useWeatherLayers(mapRef, false, false, LOCATION, planMode),
            { initialProps: { planMode: false } },
        );

        act(() => {
            rendered.result.current.toggleLayer('rain');
        });
        await waitFor(() => {
            expect(sortedLayers(rendered.result.current.userLayers)).toEqual(['rain', 'wind']);
            expect(storedLayers()).toEqual(['rain', 'wind']);
        });

        rendered.rerender({ planMode: true });

        expect(sortedLayers(rendered.result.current.activeLayers)).toEqual([]);
        expect(sortedLayers(rendered.result.current.userLayers)).toEqual(['rain', 'wind']);
        expect(storedLayers()).toEqual(['rain', 'wind']);

        rendered.rerender({ planMode: false });

        expect(sortedLayers(rendered.result.current.activeLayers)).toEqual(['rain', 'wind']);
        expect(sortedLayers(rendered.result.current.userLayers)).toEqual(['rain', 'wind']);
        expect(storedLayers()).toEqual(['rain', 'wind']);
    });

    it('does not persist the suppressed empty set when the app unmounts on Plan', async () => {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(['rain', 'wind']));
        const planning = renderHook(() => useWeatherLayers(mapRef, false, false, LOCATION, true));

        expect(sortedLayers(planning.result.current.activeLayers)).toEqual([]);
        expect(sortedLayers(planning.result.current.userLayers)).toEqual(['rain', 'wind']);
        await waitFor(() => expect(storedLayers()).toEqual(['rain', 'wind']));

        planning.unmount();

        const chart = renderHook(() => useWeatherLayers(mapRef, false, false, LOCATION, false));
        expect(sortedLayers(chart.result.current.activeLayers)).toEqual(['rain', 'wind']);
        expect(sortedLayers(chart.result.current.userLayers)).toEqual(['rain', 'wind']);
        expect(storedLayers()).toEqual(['rain', 'wind']);
    });
});
