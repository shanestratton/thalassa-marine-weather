/**
 * The planner's OWN layers (127-DESKMAP-b). Shane 2026-10-10: "can we include
 * the wind layer on the desktop.?? as an option??", and 2026-07-23: "any layer
 * that is on in the charts page, shows up on the planning page ... we need our
 * layer to show through". The desk's Wind switch paints wind on the planner
 * through `planLayers`; Obs's own selection (`userLayers`) never reaches the
 * planner, and the desk's pick never writes it.
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type mapboxgl from 'mapbox-gl';
import type { MutableRefObject } from 'react';
import type { WeatherLayer } from '../components/map/mapConstants';

vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../services/weather/WindDataController', () => ({
    WindDataController: { activate: vi.fn(async () => undefined), deactivate: vi.fn() },
}));

import { useWeatherLayers } from '../components/map/useWeatherLayers';

const LOCATION = { lat: 50.76, lon: -1.4 }; // the Solent
const SESSION_KEY = 'thalassa_active_layers';
const WIND = new Set<WeatherLayer>(['wind']);
const NONE = new Set<WeatherLayer>();

/** A Mapbox stand-in that records every camera write. */
function fakeMap() {
    const calls: string[] = [];
    const layers = new Map<string, { layout: Record<string, unknown> }>([
        ['openseamap-permanent', { layout: { visibility: 'visible' } }],
    ]);
    const map = {
        calls,
        // useMapInit's published AU+NZ fit, below wind's own z3 floor.
        __ausNzMinZoom: 2.4,
        getZoom: () => 9,
        getCenter: () => ({ lng: LOCATION.lon, lat: LOCATION.lat }),
        getBounds: () => ({ getWest: () => -2, getEast: () => -1, getSouth: () => 50, getNorth: () => 51 }),
        isMoving: () => false,
        isZooming: () => false,
        isEasing: () => false,
        isStyleLoaded: () => true,
        getStyle: () => ({ layers: [] }),
        getLayer: (id: string) => layers.get(id),
        getSource: () => undefined,
        getLayoutProperty: (id: string, prop: string) => layers.get(id)?.layout[prop],
        setLayoutProperty: vi.fn((id: string, prop: string, value: unknown) => {
            calls.push(`setLayoutProperty:${id}:${prop}:${String(value)}`);
        }),
        on: () => map,
        off: () => map,
        once: () => map,
    } as Record<string, unknown> & { calls: string[] };
    for (const write of ['flyTo', 'easeTo', 'jumpTo', 'fitBounds', 'setMinZoom', 'setMaxZoom', 'setMaxBounds'])
        map[write] = vi.fn(() => {
            calls.push(write);
            return map;
        });
    return map;
}

function render(planMode: boolean, planLayers: Set<WeatherLayer> | undefined, mapReady = false) {
    const map = fakeMap();
    const mapRef = { current: mapReady ? map : null } as unknown as MutableRefObject<mapboxgl.Map | null>;
    const hook = renderHook(
        ({ plan, layers }: { plan: boolean; layers: Set<WeatherLayer> | undefined }) =>
            useWeatherLayers(mapRef, mapReady, false, LOCATION, plan, undefined, true, layers),
        { initialProps: { plan: planMode, layers: planLayers } },
    );
    return { ...hook, map };
}

const sorted = (layers: ReadonlySet<string>) => [...layers].sort();

describe('useWeatherLayers: the planner’s own layers', () => {
    beforeEach(() => {
        sessionStorage.clear();
        localStorage.clear();
    });
    afterEach(() => vi.restoreAllMocks());

    it('paints the planner’s wind while planning; Obs’s own selection never shows through', () => {
        const view = render(false, undefined);
        act(() => view.result.current.toggleLayer('rain'));
        act(() => view.result.current.toggleLayer('wind'));
        act(() => view.result.current.toggleLayer('pressure'));
        expect(sorted(view.result.current.activeLayers)).toEqual(['pressure', 'rain', 'wind']);

        // Planning, nothing picked on the desk: empty, as today.
        view.rerender({ plan: true, layers: undefined });
        expect(sorted(view.result.current.activeLayers)).toEqual([]);
        view.rerender({ plan: true, layers: NONE });
        expect(sorted(view.result.current.activeLayers)).toEqual([]);

        // The desk's Wind on: wind alone, never Obs's rain or pressure.
        view.rerender({ plan: true, layers: WIND });
        expect(sorted(view.result.current.activeLayers)).toEqual(['wind']);
        expect(sorted(view.result.current.userLayers)).toEqual(['pressure', 'rain', 'wind']);

        // Back on Obs: exactly as left; the planner's set means nothing there.
        view.rerender({ plan: false, layers: WIND });
        expect(sorted(view.result.current.activeLayers)).toEqual(['pressure', 'rain', 'wind']);
    });

    // Review 2026-10-10: Obs and the planner share one MapHub and one wind
    // timeline, so with wind on both sides nothing reset it on the way back:
    // the desk's start (or a scrub) painted as Obs's live wind for minutes.
    it('crossing between Obs and the desk hands the shared wind timeline back to now, both ways', () => {
        const view = render(false, undefined);
        act(() => view.result.current.toggleLayer('wind'));
        act(() => view.result.current.setWindHour(3));
        expect(view.result.current.windHour).toBe(3);

        // Obs's scrub never opens the desk.
        view.rerender({ plan: true, layers: WIND });
        expect(view.result.current.windHour).toBe(0);
        // The desk's start hand-off, or a hand on its scrubber...
        act(() => view.result.current.setWindHour(20));
        expect(view.result.current.windHour).toBe(20);
        // ...never paints as Obs's live wind.
        view.rerender({ plan: false, layers: WIND });
        expect(sorted(view.result.current.activeLayers)).toEqual(['wind']);
        expect(view.result.current.windHour).toBe(0);
    });

    it('a desk wind toggle never writes the session layer key', () => {
        const view = render(true, NONE);
        const writes = vi.spyOn(Storage.prototype, 'setItem');
        view.rerender({ plan: true, layers: WIND });
        view.rerender({ plan: true, layers: NONE });
        view.rerender({ plan: true, layers: WIND });
        expect(writes.mock.calls.filter(([key]) => key === SESSION_KEY)).toEqual([]);
        expect(sessionStorage.getItem(SESSION_KEY)).toBe('[]');
        expect(localStorage.getItem(SESSION_KEY)).toBeNull();
    });

    it('turning the desk’s wind on and off never moves the camera, clamps its zoom or touches the seamarks', () => {
        const view = render(true, NONE, true);
        const settled = [...view.map.calls];
        view.rerender({ plan: true, layers: WIND });
        view.rerender({ plan: true, layers: NONE });
        view.rerender({ plan: true, layers: WIND });
        const after = view.map.calls.slice(settled.length);
        expect(after.filter((call) => /^(flyTo|easeTo|jumpTo|fitBounds)$/.test(call))).toEqual([]);
        // The zoom floor stays the planner's own: wind's z3 floor would pull a
        // wide desk view (here z2.4 allowed) in by itself.
        expect(view.map.setMinZoom).toHaveBeenCalledWith(2.4);
        expect(view.map.setMinZoom).not.toHaveBeenCalledWith(3);
        expect(after.filter((call) => call.includes('openseamap-permanent'))).toEqual([]);
    });
});
