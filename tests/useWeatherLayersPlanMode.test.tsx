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

/**
 * sessionStorage, not localStorage. The localStorage write was removed on
 * 2026-09-05 — it was never read back, and it was one line away from
 * resurrecting the cross-launch persistence Shane had just asked to be rid of.
 * The tests that seed localStorage below now assert something stronger than
 * before: a stale key there is not merely outranked, it is inert.
 */
function storedLayers(): string[] {
    return [...(JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? '[]') as string[])].sort();
}

describe('useWeatherLayers plan-mode boundary', () => {
    beforeEach(() => {
        localStorage.clear();
        // The session mirror is what a same-session remount restores
        // (2026-08-21); each test starts as a fresh process would.
        sessionStorage.clear();
    });

    it('suppresses Chart layers on Plan and restores the same user selection on return', async () => {
        // Cold start is now EMPTY (Inspect is the opening mode), so the
        // punter's selection here is exactly what they turned on.
        const rendered = renderHook(
            ({ planMode }: { planMode: boolean }) => useWeatherLayers(mapRef, false, false, LOCATION, planMode),
            { initialProps: { planMode: false } },
        );

        act(() => {
            rendered.result.current.toggleLayer('rain');
        });
        await waitFor(() => {
            expect(sortedLayers(rendered.result.current.userLayers)).toEqual(['rain']);
            expect(storedLayers()).toEqual(['rain']);
        });

        rendered.rerender({ planMode: true });

        expect(sortedLayers(rendered.result.current.activeLayers)).toEqual([]);
        expect(sortedLayers(rendered.result.current.userLayers)).toEqual(['rain']);
        expect(storedLayers()).toEqual(['rain']);

        rendered.rerender({ planMode: false });

        expect(sortedLayers(rendered.result.current.activeLayers)).toEqual(['rain']);
        expect(sortedLayers(rendered.result.current.userLayers)).toEqual(['rain']);
        expect(storedLayers()).toEqual(['rain']);
    });

    it('does not persist the suppressed empty set when the app unmounts on Plan', async () => {
        // A COLD start opens EMPTY now, so the interesting half of this test
        // is the SECOND assertion: the suppressed empty ACTIVE set and the
        // empty USER selection must stay distinguishable. Turn a layer on
        // first, or the two are the same set and the test proves nothing.
        localStorage.setItem(STORAGE_KEY, JSON.stringify(['rain', 'wind']));
        const planning = renderHook(() => useWeatherLayers(mapRef, false, false, LOCATION, true));

        expect(sortedLayers(planning.result.current.activeLayers)).toEqual([]);
        expect(sortedLayers(planning.result.current.userLayers)).toEqual([]);

        act(() => {
            planning.result.current.toggleLayer('rain');
        });
        // Suppressed on Plan, but the SELECTION is what gets stored.
        expect(sortedLayers(planning.result.current.activeLayers)).toEqual([]);
        await waitFor(() => expect(storedLayers()).toEqual(['rain']));

        planning.unmount();

        const chart = renderHook(() => useWeatherLayers(mapRef, false, false, LOCATION, false));
        expect(sortedLayers(chart.result.current.activeLayers)).toEqual(['rain']);
        expect(sortedLayers(chart.result.current.userLayers)).toEqual(['rain']);
        expect(storedLayers()).toEqual(['rain']);
    });

    it('ignores a stored localStorage selection on a COLD start — opens with none', () => {
        // localStorage survives restarts; honouring it here would be layer
        // state haunting a later boot, which is exactly what Shane asked to be
        // rid of on 2026-09-05. Nothing writes this key any more either, so a
        // value in it can only be a leftover from an older build — and it must
        // stay inert rather than resurrect itself.
        localStorage.setItem(STORAGE_KEY, JSON.stringify(['rain', 'pressure', 'wind']));
        const chart = renderHook(() => useWeatherLayers(mapRef, false, false, LOCATION, false));

        expect(sortedLayers(chart.result.current.userLayers)).toEqual([]);
    });

    it('never writes localStorage again — the loaded gun is unloaded', async () => {
        const chart = renderHook(() => useWeatherLayers(mapRef, false, false, LOCATION, false));
        act(() => {
            chart.result.current.toggleLayer('rain');
        });
        await waitFor(() => expect(storedLayers()).toEqual(['rain']));
        expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
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
        await waitFor(() => expect(sortedLayers(first.result.current.userLayers)).toEqual(['rain']));
        first.unmount();

        const second = renderHook(() => useWeatherLayers(mapRef, false, false, LOCATION, false));
        expect(sortedLayers(second.result.current.userLayers)).toEqual(['rain']);
    });
});
