/**
 * The ghost on the chart, and the line it rides (passage strip, phase 2).
 *
 * Measured on the real chart page, the first ghost sailed up a chart with no
 * line under it: the Obs chart stopped drawing the followed route on its own
 * account on 2026-08-03, and the Passage overlay only draws one it can match
 * to an active voyage. So the look-ahead draws its own, for as long as the
 * glance lasts — and must take it away again, survive a basemap switch, and
 * never draw the long way round the planet.
 */
import { renderHook, act } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MutableRefObject } from 'react';
import type mapboxgl from 'mapbox-gl';

const markers = vi.hoisted(() => ({ made: [] as FakeMarker[] }));
interface FakeMarker {
    element: HTMLElement;
    lngLat: [number, number] | null;
    added: boolean;
    removed: boolean;
}
vi.mock('mapbox-gl', () => {
    class Marker {
        private self: FakeMarker;
        constructor(opts: { element: HTMLElement }) {
            this.self = { element: opts.element, lngLat: null, added: false, removed: false };
            markers.made.push(this.self);
        }
        setLngLat(ll: [number, number]) {
            this.self.lngLat = ll;
            return this;
        }
        addTo() {
            this.self.added = true;
            return this;
        }
        remove() {
            this.self.removed = true;
        }
    }
    return { default: { Marker }, Marker };
});

import { createRouteGhostEl, ghostPathCoordinates, useRouteGhostMarker } from '../components/map/useRouteGhostMarker';
import { useRouteTrackLayer } from '../components/map/useRouteTrackLayer';
import type { RouteOrTrack } from '../services/shiplog/RoutesAndTracks';
import {
    __resetPassageHudForTests,
    publishPassageGhost,
    publishPassageGhostJoinPath,
    publishPassageGhostPath,
    startPassageLookAhead,
    stopPassageLookAhead,
} from '../stores/passageHudStore';

function fakeMap() {
    const sources = new Map<string, { data: unknown }>();
    const layers = new Map<string, Record<string, unknown>>();
    const handlers = new Map<string, Set<() => void>>();
    const map = {
        bearing: 0,
        styleLoaded: true,
        getBearing: () => map.bearing,
        isStyleLoaded: () => map.styleLoaded,
        getSource: (id: string) => {
            const s = sources.get(id);
            return s ? { setData: (d: unknown) => (s.data = d) } : undefined;
        },
        addSource: (id: string, spec: { data: unknown }) => void sources.set(id, { data: spec.data }),
        removeSource: (id: string) => void sources.delete(id),
        getLayer: (id: string) => layers.get(id),
        addLayer: (spec: { id: string }) => void layers.set(spec.id, spec),
        removeLayer: (id: string) => void layers.delete(id),
        getStyle: () => ({ layers: [...layers].map(([id, layer]) => ({ ...layer, id })) }),
        moveLayer: vi.fn((id: string, beforeId?: string) => {
            const layer = layers.get(id);
            if (!layer) throw new Error(`Missing layer ${id}`);
            layers.delete(id);
            const entries = [...layers];
            const before = beforeId ? entries.findIndex(([key]) => key === beforeId) : -1;
            entries.splice(before < 0 ? entries.length : before, 0, [id, layer]);
            layers.clear();
            for (const [key, value] of entries) layers.set(key, value);
        }),
        fitBounds: vi.fn(),
        on: (ev: string, fn: () => void) => {
            if (!handlers.has(ev)) handlers.set(ev, new Set());
            handlers.get(ev)!.add(fn);
        },
        off: (ev: string, fn: () => void) => void handlers.get(ev)?.delete(fn),
        fire: (ev: string) => handlers.get(ev)?.forEach((fn) => fn()),
        /** What a basemap switch does to custom layers. */
        swapStyle: () => {
            sources.clear();
            layers.clear();
        },
        sources,
        layers,
        handlers,
    };
    return map;
}

const PATH = [
    { lat: -23.6, lon: 151.4 },
    { lat: -22, lon: 150.6 },
    { lat: -21.1, lon: 149.25 },
];
const GHOST = { lat: -23, lon: 151.1, bearingDeg: 330, label: '+6 h' };
const JOIN = [{ lat: -23.6, lon: 151.2 }, PATH[0]];

let map: ReturnType<typeof fakeMap>;
const mount = (ready = true) => {
    const ref = { current: map as unknown as mapboxgl.Map } as MutableRefObject<mapboxgl.Map | null>;
    return renderHook(({ r }) => useRouteGhostMarker(ref, r), { initialProps: { r: ready } });
};

beforeEach(() => {
    __resetPassageHudForTests();
    markers.made.length = 0;
    map = fakeMap();
});
afterEach(() => __resetPassageHudForTests());

describe('the ghost', () => {
    it('keeps Mapbox’s absolute marker positioning so normal flow cannot push the hull off the route', async () => {
        const actualMapbox = await vi.importActual<typeof import('mapbox-gl')>('mapbox-gl');
        const css = document.createElement('style');
        css.textContent = readFileSync('node_modules/mapbox-gl/dist/mapbox-gl.css', 'utf8');
        document.head.appendChild(css);
        const { root, chip } = createRouteGhostEl();
        const marker = new actualMapbox.default.Marker({ element: root, anchor: 'center' });
        document.body.appendChild(root);
        try {
            expect(root.classList.contains('mapboxgl-marker')).toBe(true);
            const style = getComputedStyle(root);
            expect(style.position).toBe('absolute');
            expect(style.left).toBe('0px');
            expect(style.top).toBe('0px');
            expect(getComputedStyle(chip).position).toBe('absolute');
        } finally {
            marker.remove();
            root.remove();
            css.remove();
        }
    });

    it('is not on the chart at all while live', () => {
        mount();
        expect(markers.made).toHaveLength(0);
        expect(map.layers.size).toBe(0);
    });

    it('appears where the strip says, turned onto the route, wearing its offset', () => {
        mount();
        act(() => publishPassageGhost(GHOST));
        expect(markers.made).toHaveLength(1);
        const m = markers.made[0];
        expect(m.added).toBe(true);
        expect(m.lngLat).toEqual([151.1, -23]);
        expect(m.element.textContent).toBe('+6 h');
        expect(m.element.querySelector('svg')!.style.transform).toBe('rotate(330deg)');
    });

    it('moves the SAME marker as the scrubber moves — it does not pile them up', () => {
        mount();
        act(() => publishPassageGhost(GHOST));
        act(() => publishPassageGhost({ ...GHOST, lat: -22.5, label: '+11 h' }));
        expect(markers.made).toHaveLength(1);
        expect(markers.made[0].lngLat).toEqual([151.1, -22.5]);
        expect(markers.made[0].element.textContent).toBe('+11 h');
    });

    it('keeps pointing along the route when the skipper rotates the chart, and its label stays level', () => {
        mount();
        act(() => publishPassageGhost(GHOST));
        map.bearing = 90;
        act(() => map.fire('rotate'));
        const m = markers.made[0];
        expect(m.element.querySelector('svg')!.style.transform).toBe('rotate(240deg)');
        expect(m.element.style.transform).toBe(''); // only the hull turns
    });

    // 127-11a, audit A12: a damped orientation turn fires 'rotate' every
    // frame for a second; each one only re-turns the hull, never touches the
    // path sources or moves the marker.
    it('a turn of the chart re-turns the hull only: no source is read or written, the marker stays put', () => {
        mount();
        act(() => {
            startPassageLookAhead();
            publishPassageGhost(GHOST);
            publishPassageGhostPath(PATH);
        });
        const m = markers.made[0];
        // setLngLat stores a fresh array: the same one afterwards means it was not called.
        const placed = m.lngLat;
        const getSource = vi.spyOn(map, 'getSource');
        map.bearing = 45;
        act(() => map.fire('rotate'));
        expect(m.element.querySelector('svg')!.style.transform).toBe('rotate(285deg)');
        expect(getSource).not.toHaveBeenCalled();
        expect(m.lngLat).toBe(placed);
        act(() => stopPassageLookAhead());
    });

    it('cannot be mistaken for the boat, and takes no taps from the chart', () => {
        mount();
        act(() => publishPassageGhost(GHOST));
        const el = markers.made[0].element;
        expect(el.getAttribute('aria-hidden')).toBe('true');
        expect(el.style.pointerEvents).toBe('none');
        expect(el.querySelector('path')!.getAttribute('stroke-dasharray')).toBeTruthy();
    });

    it('goes when the glance ends', () => {
        mount();
        act(() => {
            startPassageLookAhead();
            publishPassageGhost(GHOST);
            publishPassageGhostPath(PATH);
            publishPassageGhostJoinPath(JOIN);
        });
        act(() => stopPassageLookAhead());
        expect(markers.made[0].removed).toBe(true);
        expect(map.layers.size).toBe(0);
        expect(map.sources.size).toBe(0);
    });
});

describe('the line it rides', () => {
    it('is drawn solid purple, from the boat to the destination, only while asked for', () => {
        mount();
        act(() => publishPassageGhostPath(PATH));
        const layer = map.layers.get('passage-ghost-path-line') as { paint: Record<string, unknown> };
        expect(layer.paint['line-color']).toBe('#a855f7');
        expect(layer.paint['line-dasharray']).toBeUndefined();
        const data = map.sources.get('passage-ghost-path')!.data as GeoJSON.Feature<GeoJSON.LineString>;
        expect(data.geometry.coordinates).toEqual([
            [151.4, -23.6],
            [150.6, -22],
            [149.25, -21.1],
        ]);
        act(() => publishPassageGhostPath(null));
        expect(map.layers.size).toBe(0);
    });

    it('shortens as she advances, in the same source — no second line left behind', () => {
        mount();
        act(() => publishPassageGhostPath(PATH));
        act(() => publishPassageGhostPath([{ lat: -22.8, lon: 151 }, ...PATH.slice(1)]));
        expect(map.sources.size).toBe(1);
        const data = map.sources.get('passage-ghost-path')!.data as GeoJSON.Feature<GeoJSON.LineString>;
        expect(data.geometry.coordinates[0]).toEqual([151, -22.8]);
    });

    it('comes back after a basemap switch throws every custom layer away', () => {
        mount();
        act(() => publishPassageGhostPath(PATH));
        map.swapStyle();
        expect(map.layers.size).toBe(0);
        act(() => map.fire('styledata'));
        const layer = map.layers.get('passage-ghost-path-line') as { paint: Record<string, unknown> };
        expect(layer.paint['line-color']).toBe('#a855f7');
        expect(layer.paint['line-dasharray']).toBeUndefined();
    });

    it('restores the purple line when a style update removes its layer but keeps its source', () => {
        mount();
        act(() => publishPassageGhostPath(PATH));
        map.removeLayer('passage-ghost-path-line');
        act(() => map.fire('styledata'));
        expect(map.sources.size).toBe(1);
        const layer = map.layers.get('passage-ghost-path-line') as { paint: Record<string, unknown> };
        expect(layer.paint['line-color']).toBe('#a855f7');
        expect(layer.paint['line-dasharray']).toBeUndefined();
    });

    it('waits for a style that is still loading instead of throwing at it', () => {
        map.styleLoaded = false;
        mount();
        act(() => publishPassageGhostPath(PATH));
        expect(map.layers.size).toBe(0);
        map.styleLoaded = true;
        act(() => map.fire('styledata'));
        expect(map.layers.has('passage-ghost-path-line')).toBe(true);
    });

    it('is taken off the chart with the hook — a planning surface owns the map then', () => {
        const view = mount();
        act(() => {
            publishPassageGhost(GHOST);
            publishPassageGhostPath(PATH);
            publishPassageGhostJoinPath(JOIN);
        });
        view.rerender({ r: false });
        expect(map.layers.size).toBe(0);
        expect(markers.made[0].removed).toBe(true);
        expect(map.handlers.get('rotate')?.size ?? 0).toBe(0);
        expect(map.handlers.get('styledata')?.size ?? 0).toBe(0);
        expect(map.handlers.get('idle')?.size ?? 0).toBe(0);
    });

    it('never goes the long way round the planet at the antimeridian', () => {
        expect(
            ghostPathCoordinates([
                { lat: -17, lon: 178 },
                { lat: -17, lon: -179 },
                { lat: -16, lon: -177 },
            ]),
        ).toEqual([
            [178, -17],
            [181, -17],
            [183, -16],
        ]);
        expect(
            ghostPathCoordinates([
                { lat: -17, lon: -179 },
                { lat: -17, lon: 179 },
            ]),
        ).toEqual([
            [-179, -17],
            [-181, -17],
        ]);
    });

    it('is nothing for a path that is not a line', () => {
        mount();
        act(() => publishPassageGhostPath([{ lat: -23, lon: 151 }]));
        expect(map.layers.size).toBe(0);
    });
});

describe('the unchecked forecast approach', () => {
    it('stays above late rain and squall layers even when its geometry is unchanged', () => {
        mount();
        act(() => {
            publishPassageGhostPath(PATH);
            publishPassageGhostJoinPath(JOIN);
        });
        const route = map.sources.get('passage-ghost-path')!.data;
        const join = map.sources.get('passage-ghost-join-path')!.data;
        map.addLayer({ id: 'rain-frame-1' });
        map.addLayer({ id: 'squall-radar' });
        act(() => map.fire('styledata'));
        expect([...map.layers.keys()].slice(-2)).toEqual(['passage-ghost-path-line', 'passage-ghost-join-path-line']);
        expect(map.sources.get('passage-ghost-path')!.data).toBe(route);
        expect(map.sources.get('passage-ghost-join-path')!.data).toBe(join);
        expect(map.moveLayer).toHaveBeenCalledTimes(2);
        act(() => {
            map.fire('styledata');
            map.fire('idle');
            map.fire('idle');
        });
        expect(map.moveLayer).toHaveBeenCalledTimes(2);
    });

    it('shares foreground priority with the full route and track without a promotion loop', () => {
        const ref = { current: map as unknown as mapboxgl.Map };
        const selected = (id: string): RouteOrTrack => ({
            id,
            label: id,
            sublabel: '',
            points: PATH,
            bbox: [149.25, -23.6, 151.4, -21.1],
            timestamp: 0,
            distanceNm: 100,
            isLocal: true,
            kind: 'sea',
        });
        renderHook(() => {
            useRouteGhostMarker(ref, true);
            useRouteTrackLayer({ mapRef: ref, mapReady: true, variant: 'route', selected: selected('route') });
            useRouteTrackLayer({ mapRef: ref, mapReady: true, variant: 'track', selected: selected('track') });
        });
        act(() => {
            publishPassageGhostPath(PATH);
            publishPassageGhostJoinPath(JOIN);
            map.fire('idle');
        });
        map.moveLayer.mockClear();
        map.addLayer({ id: 'rain-frame-1' });
        map.addLayer({ id: 'squall-radar' });
        act(() => {
            map.fire('idle');
            map.fire('styledata');
        });
        expect([...map.layers.keys()].slice(-6)).toEqual([
            'passage-ghost-path-line',
            'passage-ghost-join-path-line',
            'routetrack-route-glow',
            'routetrack-route-line',
            'routetrack-track-glow',
            'routetrack-track-line',
        ]);
        const moves = map.moveLayer.mock.calls.length;
        act(() => {
            map.fire('idle');
            map.fire('styledata');
            map.fire('idle');
        });
        expect(map.moveLayer).toHaveBeenCalledTimes(moves);

        // If the full route has already been raised, preserve its priority
        // while repairing a forecast path that was left beneath the rain.
        map.moveLayer('rain-frame-1', 'routetrack-route-glow');
        act(() => map.fire('styledata'));
        expect([...map.layers.keys()].slice(-6)).toEqual([
            'passage-ghost-path-line',
            'passage-ghost-join-path-line',
            'routetrack-route-glow',
            'routetrack-route-line',
            'routetrack-track-glow',
            'routetrack-track-line',
        ]);
    });

    it('is dashed amber in its own source and leaves the solid purple route geometry untouched', () => {
        mount();
        act(() => publishPassageGhostPath(PATH));
        const route = map.sources.get('passage-ghost-path')!.data;
        act(() => publishPassageGhostJoinPath(JOIN));
        const join = map.sources.get('passage-ghost-join-path')!.data as GeoJSON.Feature<GeoJSON.LineString>;
        const layer = map.layers.get('passage-ghost-join-path-line') as { paint: Record<string, unknown> };
        expect(layer.paint['line-color']).toBe('#fbbf24');
        expect(layer.paint['line-dasharray']).toEqual([2, 2]);
        expect(join.geometry.coordinates).toEqual([
            [151.2, -23.6],
            [151.4, -23.6],
        ]);
        expect(map.sources.get('passage-ghost-path')!.data).toBe(route);
        const purple = map.layers.get('passage-ghost-path-line') as { paint: Record<string, unknown> };
        expect(purple.paint['line-color']).toBe('#a855f7');
        expect(purple.paint['line-dasharray']).toBeUndefined();
        act(() => publishPassageGhostJoinPath(null));
        expect(map.sources.has('passage-ghost-join-path')).toBe(false);
        expect(map.layers.has('passage-ghost-join-path-line')).toBe(false);
        expect(map.sources.get('passage-ghost-path')!.data).toBe(route);
    });

    it('moves only the approach source when the actual fix changes', () => {
        mount();
        act(() => {
            publishPassageGhostPath(PATH);
            publishPassageGhostJoinPath(JOIN);
        });
        const route = map.sources.get('passage-ghost-path')!.data;
        act(() => publishPassageGhostJoinPath([{ lat: -23.6, lon: 151.3 }, PATH[0]]));
        expect(map.sources.size).toBe(2);
        const join = map.sources.get('passage-ghost-join-path')!.data as GeoJSON.Feature<GeoJSON.LineString>;
        expect(join.geometry.coordinates[0]).toEqual([151.3, -23.6]);
        expect(map.sources.get('passage-ghost-path')!.data).toBe(route);
    });

    it('restores the separate approach and route after a basemap switch or missing approach layer', () => {
        mount();
        act(() => {
            publishPassageGhostPath(PATH);
            publishPassageGhostJoinPath(JOIN);
        });
        map.swapStyle();
        act(() => map.fire('styledata'));
        expect(map.sources.size).toBe(2);
        expect(map.layers.size).toBe(2);
        map.removeLayer('passage-ghost-join-path-line');
        act(() => map.fire('styledata'));
        const layer = map.layers.get('passage-ghost-join-path-line') as { paint: Record<string, unknown> };
        expect(layer.paint['line-dasharray']).toEqual([2, 2]);
        const purple = map.layers.get('passage-ghost-path-line') as { paint: Record<string, unknown> };
        expect(purple.paint['line-dasharray']).toBeUndefined();
    });

    it('keeps a dateline-crossing approach local to the route', () => {
        mount();
        act(() =>
            publishPassageGhostJoinPath([
                { lat: -17.5, lon: 179.9 },
                { lat: -17.5, lon: -179.9 },
            ]),
        );
        const join = map.sources.get('passage-ghost-join-path')!.data as GeoJSON.Feature<GeoJSON.LineString>;
        expect(join.geometry.coordinates[1][0] - join.geometry.coordinates[0][0]).toBeCloseTo(0.2, 9);
    });
});
