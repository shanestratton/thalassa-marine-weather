import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeIntersectionObserver, FakeMapboxMap, installFakeIntersectionObserver } from '../helpers/fakeMapboxGl';
import type { SightingItem } from '../../components/sightings/sightingsFormat';
const h = vi.hoisted(() => ({
    markers: [] as Array<{ element: HTMLElement; coordinate: number[]; removed: boolean }>,
}));
vi.mock('mapbox-gl', async () => {
    const { fakeMapboxGl } = await import('../helpers/fakeMapboxGl');
    class Marker {
        coordinate: number[] = [];
        removed = false;
        element: HTMLElement;
        constructor({ element }: { element: HTMLElement }) {
            this.element = element;
            element.setAttribute('role', 'img');
            h.markers.push(this);
        }
        setLngLat(coordinate: number[]) {
            this.coordinate = coordinate;
            return this;
        }
        addTo(map: FakeMapboxMap) {
            map.getContainer().append(this.element);
            return this;
        }
        remove() {
            this.removed = true;
            this.element.remove();
            return this;
        }
    }
    return { default: { ...fakeMapboxGl, Marker } };
});
vi.mock('../../services/PiCacheService', () => ({ piCache: { canDisplayProxiedTiles: () => false } }));
import { SightingsMap, sightingsMapPoints } from '../../components/sightings/SightingsMap';
import { LOG_MAP_FALLBACK_STYLE } from '../../components/map/logMap';
const item = (id: string, longitude = 179.8, observerId = 'mine'): SightingItem => ({
    id,
    longitude,
    latitude: -17,
    observerId,
    group: 'whale',
    scientificName: null,
    vernacularName: id,
    count: 1,
    hasCalf: false,
    eventDate: '2026-10-16T00:00:00Z',
    visibility: 'crew',
    observerDisplay: null,
    positionSource: 'bus',
    vesselOwnerId: 'mine',
    voyageId: null,
    local: null,
    server: null,
    publicRow: null,
    syncState: null,
});
let restoreObserver: () => void;
beforeEach(() => {
    restoreObserver = installFakeIntersectionObserver();
    vi.stubEnv('VITE_MAPBOX_ACCESS_TOKEN', 'pk.synthetic-sightings');
    FakeMapboxMap.instances.length = 0;
    FakeMapboxMap.failWebGL = false;
    h.markers.length = 0;
});
afterEach(() => {
    cleanup();
    restoreObserver();
    vi.unstubAllEnvs();
    vi.useRealTimers();
});

describe('private Sightings map on the shared basemap', () => {
    it('keeps exact mine/crew positions in local markers, frames the date line and restores selection through style changes', () => {
        const mine = item('Private whale'),
            crew = item('Crew turtle', -179.8, 'crew');
        const onOpen = vi.fn();
        const invalid = [null, NaN, Infinity, 91].map((latitude, i) => ({ ...item(`bad${i}`), latitude }));
        const view = render(
            <SightingsMap items={[mine, crew, ...invalid]} myUserId="mine" isOffline={false} onOpen={onOpen} />,
        );
        const map = FakeMapboxMap.instances[0];
        expect(h.markers).toHaveLength(2);
        expect(h.markers.map((m) => m.coordinate[0])).toEqual([179.8, 180.2]);
        const bounds = map.fitBounds.mock.calls.at(-1)![0] as number[][];
        expect(bounds[1][0] - bounds[0][0]).toBeCloseTo(0.4);
        expect(map.fitBounds.mock.calls.at(-1)![1]).toMatchObject({
            maxZoom: 12,
            animate: false,
            retainPadding: false,
        });
        const buttons = view.container.querySelectorAll<HTMLButtonElement>('[data-sighting-id]');
        expect(buttons[0].style.width).toBe('44px');
        expect(buttons[0].dataset.sightingOwner).toBe('mine');
        expect(buttons[1].dataset.sightingOwner).toBe('crew');
        expect((buttons[0].firstChild as HTMLElement).style.background).toBe('rgb(14, 165, 233)');
        expect((buttons[1].firstChild as HTMLElement).style.background).toBe('rgb(3, 105, 161)');
        fireEvent.click(screen.getByRole('button', { name: 'Show Private whale' }));
        act(() => map.loadStyle());
        act(() => map.loadStyle());
        expect(view.container.querySelectorAll('[data-sighting-id]')).toHaveLength(2);
        expect([...map.sources.values()].every((source) => source.spec.type !== 'geojson')).toBe(true);
        fireEvent.click(screen.getByRole('button', { name: /^Private whale / }));
        expect(onOpen).toHaveBeenCalledWith(mine);
        view.unmount();
        expect(map.remove).toHaveBeenCalledTimes(1);
        expect(h.markers.every((m) => m.removed)).toBe(true);
    });
    it('opens only the latest selected item and clears removed records and account selection', () => {
        const first = item('first'),
            onOpen = vi.fn();
        const view = render(<SightingsMap items={[first]} myUserId="mine" isOffline={false} onOpen={onOpen} />);
        fireEvent.click(screen.getByRole('button', { name: 'Show first' }));
        const changed = { ...first, vernacularName: 'updated' };
        view.rerender(<SightingsMap items={[changed]} myUserId="mine" isOffline={false} onOpen={onOpen} />);
        fireEvent.click(screen.getByRole('button', { name: /^updated / }));
        expect(onOpen).toHaveBeenLastCalledWith(changed);
        view.rerender(<SightingsMap items={[changed]} myUserId="other" isOffline={false} onOpen={onOpen} />);
        expect(screen.queryByRole('button', { name: /^updated / })).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'Show updated' }));
        view.rerender(<SightingsMap items={[]} myUserId="other" isOffline={false} onOpen={onOpen} />);
        expect(view.container.querySelector('[data-sighting-id]')).toBeNull();
        expect(screen.queryByText('updated')).toBeNull();
    });
    it('draws markers offline with no token, remote style, raster sources or stale online map', () => {
        const view = render(
            <SightingsMap items={[item('offline')]} myUserId="mine" isOffline={false} onOpen={vi.fn()} />,
        );
        const online = FakeMapboxMap.instances[0];
        view.rerender(<SightingsMap items={[item('offline')]} myUserId="mine" isOffline={true} onOpen={vi.fn()} />);
        const offline = FakeMapboxMap.instances[1];
        act(() => offline.loadStyle([{ id: 'background', type: 'background' }], { composite: false }));
        expect(online.remove).toHaveBeenCalledTimes(1);
        expect(offline.options).toMatchObject({ style: LOG_MAP_FALLBACK_STYLE, accessToken: '' });
        expect(offline.sources.size).toBe(0);
        expect(offline.container.dataset.logMapStyle).toBe('fallback');
        expect(screen.getByRole('status').textContent).toContain('Offline map');
        expect(view.container.querySelectorAll('[data-sighting-id]')).toHaveLength(1);
    });
    it('keeps exact local markers on source-free sea when the online build has no imagery token', () => {
        vi.stubEnv('VITE_MAPBOX_ACCESS_TOKEN', '');
        const view = render(
            <SightingsMap items={[item('no token')]} myUserId="mine" isOffline={false} onOpen={vi.fn()} />,
        );
        const map = FakeMapboxMap.instances[0];
        expect(map.options).toMatchObject({ style: LOG_MAP_FALLBACK_STYLE, accessToken: '' });
        act(() => map.loadStyle([{ id: 'background', type: 'background' }], { composite: false }));
        expect(map.sources.size).toBe(0);
        expect(view.container.querySelectorAll('[data-sighting-id]')).toHaveLength(1);
        expect(screen.getByRole('status').textContent).toContain('Map tiles unavailable');
    });
    it('fails gracefully without WebGL and keeps the list navigation available', () => {
        FakeMapboxMap.failWebGL = true;
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        expect(() =>
            render(<SightingsMap items={[item('no gpu')]} myUserId="mine" isOffline={false} onOpen={vi.fn()} />),
        ).not.toThrow();
        expect(screen.getByRole('status').textContent).toContain('sightings remain in the list');
        expect(h.markers).toHaveLength(0);
        warn.mockRestore();
    });
    it('releases its extra context off screen and rebuilds just once when visible again', () => {
        vi.useFakeTimers();
        render(<SightingsMap items={[item('visible')]} myUserId="mine" isOffline={true} onOpen={vi.fn()} />);
        const first = FakeMapboxMap.instances[0];
        act(() => FakeIntersectionObserver.show(false));
        act(() => vi.advanceTimersByTime(1501));
        expect(first.remove).toHaveBeenCalledTimes(1);
        act(() => FakeIntersectionObserver.show(true));
        act(() => vi.advanceTimersByTime(251));
        expect(FakeMapboxMap.instances).toHaveLength(2);
        expect(h.markers.filter((marker) => !marker.removed)).toHaveLength(1);
    });
    it('finds the minimum circular span for unordered world points and rejects invalid longitudes', () => {
        const input = [item('a', -170), item('b', 0), item('c', 170), item('bad', 181)];
        const points = sightingsMapPoints(input),
            longitudes = points.map((point) => point.position[0]);
        expect(points).toHaveLength(3);
        expect(Math.max(...longitudes) - Math.min(...longitudes)).toBe(190);
        expect(input[0].longitude).toBe(-170);
        const western = sightingsMapPoints([item('west', -1.33), item('east', -1.297)]);
        expect(western.map((point) => point.position[0])).toEqual([-1.33, -1.297]);
    });
});
