/**
 * zombieMapGuard — a removed map answers null, it does not crash the page.
 *
 * The second-leg routing kill (2026-08-25): mapbox-gl's Map.getLayer() has
 * no liveness guard, so any timer, promise continuation or late hook
 * cleanup querying a removed map threw `reading 'getOwnLayer'` and
 * white-screened the routing page through the MapView boundary. The guard
 * makes the dead-map answer null AND names the caller in the flight trail.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { armZombieMapGuards } from '../components/map/zombieMapGuard';
import { startFlightRecorder } from '../utils/flightRecorder';
import type mapboxgl from 'mapbox-gl';

const makeMap = () => {
    const style: { layers: Record<string, unknown> } | undefined = { layers: { pins: { id: 'pins' } } };
    const map = {
        style: style as unknown,
        getLayer: vi.fn((id: string) => (map.style ? { id } : undefined)),
        getSource: vi.fn(() => ({ setData: vi.fn() })),
        removeLayer: vi.fn(),
        removeSource: vi.fn(),
        setPaintProperty: vi.fn(),
        setLayoutProperty: vi.fn(),
        setFilter: vi.fn(),
        moveLayer: vi.fn(),
        addLayer: vi.fn(),
        addSource: vi.fn(),
        remove() {
            // mapbox's own remove(): the style handle goes away.
            (map as { style?: unknown }).style = undefined;
        },
    };
    return map;
};

beforeEach(() => {
    localStorage.clear();
});

describe('armZombieMapGuards', () => {
    it('delegates untouched while the map is alive', () => {
        const map = makeMap();
        const rawGetLayer = map.getLayer;
        const rawSetPaintRef = map.setPaintProperty;
        armZombieMapGuards(map as unknown as mapboxgl.Map);

        expect((map.getLayer as unknown as (id: string) => unknown)('pins')).toEqual({ id: 'pins' });
        expect(rawGetLayer).toHaveBeenCalledWith('pins');
        const rawSetPaint = rawSetPaintRef;
        (map.setPaintProperty as unknown as (a: string, b: string, c: number) => void)('pins', 'circle-radius', 4);
        expect(rawSetPaint).toHaveBeenCalled();
    });

    it('a removed map answers null and never reaches mapbox internals', () => {
        const map = makeMap();
        const rawGetLayer = map.getLayer;
        const rawRemoveLayer = map.removeLayer;
        armZombieMapGuards(map as unknown as mapboxgl.Map);
        map.remove();

        expect((map.getLayer as unknown as (id: string) => unknown)('pins')).toBeNull();
        expect((map.removeLayer as unknown as (id: string) => unknown)('pins')).toBeNull();
        expect(rawGetLayer).not.toHaveBeenCalled();
        expect(rawRemoveLayer).not.toHaveBeenCalled();
    });

    it('names the caller in the flight trail, once per method', () => {
        startFlightRecorder(); // crumbs no-op until the recorder is armed
        const map = makeMap();
        armZombieMapGuards(map as unknown as mapboxgl.Map);
        map.remove();

        const g = map.getLayer as unknown as (id: string) => unknown;
        g('pins');
        g('pins');
        g('pins');
        const trail = localStorage.getItem('thalassa_flight_trail') ?? '';
        expect(trail).toContain('map:zombie-call');
        expect((trail.match(/map:zombie-call/g) ?? []).length).toBe(1); // deduped per method
    });
});
