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
        // The session mirror is what a same-session remount restores
        // (2026-08-21); each test starts as a fresh process would.
        sessionStorage.clear();
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
        // A COLD start is wind-only regardless of the localStorage selection
        // (Shane 2026-08-04), so a Plan-mode mount in a fresh session must
        // persist ['wind'] — the USER selection — never the suppressed empty
        // ACTIVE set. The chart remounting IN THE SAME SESSION then restores
        // that same selection from the session mirror (Shane 2026-08-21).
        localStorage.setItem(STORAGE_KEY, JSON.stringify(['rain', 'wind']));
        const planning = renderHook(() => useWeatherLayers(mapRef, false, false, LOCATION, true));

        expect(sortedLayers(planning.result.current.activeLayers)).toEqual([]);
        expect(sortedLayers(planning.result.current.userLayers)).toEqual(['wind']);
        await waitFor(() => expect(storedLayers()).toEqual(['wind']));

        planning.unmount();

        const chart = renderHook(() => useWeatherLayers(mapRef, false, false, LOCATION, false));
        expect(sortedLayers(chart.result.current.activeLayers)).toEqual(['wind']);
        expect(sortedLayers(chart.result.current.userLayers)).toEqual(['wind']);
        expect(storedLayers()).toEqual(['wind']);
    });

    it('ignores a stored localStorage selection on a COLD start — wind only', () => {
        // localStorage survives restarts; honouring it here would be layer
        // state haunting a later boot. Only the session mirror restores.
        localStorage.setItem(STORAGE_KEY, JSON.stringify(['rain', 'pressure', 'wind']));
        const chart = renderHook(() => useWeatherLayers(mapRef, false, false, LOCATION, false));

        expect(sortedLayers(chart.result.current.userLayers)).toEqual(['wind']);
    });

    it("restores the punter's selection on a SAME-SESSION remount", async () => {
        // Shane 2026-08-21: "if the punter has adjusted things (like ais on
        // and wind off for example) can it persist after going to another
        // screen?" — the session mirror is that persistence. An in-session
        // remount (tab switch on the shipped build, error-boundary recovery
        // at HEAD) reopens exactly what they had.
        const first = renderHook(() => useWeatherLayers(mapRef, false, false, LOCATION, false));
        act(() => {
            first.result.current.toggleLayer('rain');
        });
        await waitFor(() => expect(sortedLayers(first.result.current.userLayers)).toEqual(['rain', 'wind']));
        first.unmount();

        const second = renderHook(() => useWeatherLayers(mapRef, false, false, LOCATION, false));
        expect(sortedLayers(second.result.current.userLayers)).toEqual(['rain', 'wind']);
    });
});
