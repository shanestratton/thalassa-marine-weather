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

import { ghostPathCoordinates, useRouteGhostMarker } from '../components/map/useRouteGhostMarker';
import {
    __resetPassageHudForTests,
    publishPassageGhost,
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
        });
        act(() => stopPassageLookAhead());
        expect(markers.made[0].removed).toBe(true);
        expect(map.layers.size).toBe(0);
        expect(map.sources.size).toBe(0);
    });
});

describe('the line it rides', () => {
    it('is drawn dashed, from the boat to the destination, only while asked for', () => {
        mount();
        act(() => publishPassageGhostPath(PATH));
        const layer = map.layers.get('passage-ghost-path-line') as { paint: Record<string, unknown> };
        expect(layer.paint['line-dasharray']).toEqual([2, 2]);
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
        expect(map.layers.has('passage-ghost-path-line')).toBe(true);
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
        });
        view.rerender({ r: false });
        expect(map.layers.size).toBe(0);
        expect(markers.made[0].removed).toBe(true);
        expect(map.handlers.get('rotate')?.size ?? 0).toBe(0);
        expect(map.handlers.get('styledata')?.size ?? 0).toBe(0);
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
