/**
 * The little Log map on Relief + Sat (125-13a). Shane 2026-10-09: "on the log
 * page, can we replace the little and the big map with our relief + sat ??
 * remove the old satellite map".
 *
 *  - Mapbox GL, on reliefBase's Relief + Sat, through the lazy LiveMiniMap
 *    wrapper (the Log page's chunk does not carry it);
 *  - the old satellite tiles (satellite-streets, Esri) are never asked for,
 *    and Leaflet is not imported;
 *  - built once per visit while on screen, removed when it leaves or unmounts
 *    (the iOS WebContent cap: Obs keeps its own map alive hidden); a card
 *    flung past is never built, and the newest of several crossings wins;
 *  - no WebGL (Lockdown Mode): a plain box, never an error over the Log page;
 *  - daylight: the light box and faint vignette the Leaflet maps had;
 *  - a tap opens it, a tap on the credits does not.
 */
import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeIntersectionObserver, FakeMapboxMap, installFakeIntersectionObserver } from './helpers/fakeMapboxGl';
import type { ShipLogEntry } from '../types';

vi.mock('../services/PiCacheService', () => ({
    piCache: { canDisplayProxiedTiles: () => false, passthroughTileUrl: () => null },
}));

vi.mock('mapbox-gl', async () => {
    const { fakeMapboxGl } = await import('./helpers/fakeMapboxGl');
    return { default: fakeMapboxGl };
});

// Leaflet is the old map. Importing it at all is the regression.
vi.mock('leaflet', () => {
    throw new Error('LiveMiniMap must not import Leaflet');
});

import LiveMiniMapGL from '../components/LiveMiniMapGL';
import { LiveMiniMap } from '../components/LiveMiniMap';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { LAND_IMAGERY_LAYER, seaBaseLayers } from '../components/map/reliefBase';

const OLD_SATELLITE = /satellite-streets|arcgisonline|World_Imagery/;

const fix = (id: string, latitude: number, longitude: number, minute: number): ShipLogEntry =>
    ({
        id,
        userId: 'fixture-user',
        voyageId: 'fixture-voyage',
        latitude,
        longitude,
        timestamp: new Date(Date.UTC(2026, 9, 9, 6, minute)).toISOString(),
        positionFormatted: '',
        entryType: 'auto',
        source: 'device',
    }) as ShipLogEntry;

// The Solent: Cowes out past Gurnard, a fictional boat.
const SOLENT = [fix('s1', 50.765, -1.297, 0), fix('s2', 50.772, -1.31, 5), fix('s3', 50.779, -1.33, 10)];

const sized = (width: number, height: number) => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(width);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(height);
};

const lastMap = () => FakeMapboxMap.instances[FakeMapboxMap.instances.length - 1];

let restoreObserver = () => {};

beforeEach(() => {
    FakeMapboxMap.instances.length = 0;
    FakeMapboxMap.attempts = 0;
    FakeMapboxMap.failWebGL = false;
    restoreObserver = installFakeIntersectionObserver();
    vi.stubEnv('VITE_MAPBOX_ACCESS_TOKEN', 'pk.fixture');
    sized(360, 200);
});

afterEach(() => {
    restoreObserver();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe('The little Log map on Relief + Sat', () => {
    it('draws reliefBase’s Relief + Sat layers, visible exactly as seaBaseLayers says', () => {
        render(<LiveMiniMapGL entries={SOLENT} isLive />);
        const map = lastMap();
        expect(map.options.style).toBe('mapbox://styles/mapbox/dark-v11');
        map.loadStyle();
        for (const [id, visible] of seaBaseLayers('reliefSat')) {
            expect(map.visibility(id), id).toBe(visible ? 'visible' : 'none');
        }
        expect(map.visibility(LAND_IMAGERY_LAYER)).toBe('visible');
    });

    it('never asks for the old satellite tiles, and carries no Leaflet', () => {
        render(<LiveMiniMapGL entries={SOLENT} isLive />);
        const map = lastMap();
        map.loadStyle();
        expect(map.tileUrls().length).toBeGreaterThan(3);
        for (const url of map.tileUrls()) expect(url).not.toMatch(OLD_SATELLITE);
        for (const path of ['components/LiveMiniMapGL.tsx', 'components/LiveMiniMap.tsx', 'components/map/logMap.ts']) {
            const source = readFileSync(path, 'utf8');
            expect(source, path).not.toMatch(/from 'leaflet'|logMapTiles|satellite-streets|arcgisonline/);
        }
    });

    it('is built once per visit, not on every re-render or GPS poll', () => {
        const { rerender } = render(<LiveMiniMapGL entries={SOLENT.slice(0, 2)} isLive />);
        lastMap().loadStyle();
        rerender(<LiveMiniMapGL entries={SOLENT} isLive />);
        rerender(<LiveMiniMapGL entries={[...SOLENT, fix('s4', 50.781, -1.35, 15)]} isLive />);
        expect(FakeMapboxMap.instances).toHaveLength(1);
        const track = lastMap().getSource('log-track')!;
        expect(track.setData).toHaveBeenCalled();
    });

    it('removes the map when it unmounts', () => {
        const { unmount } = render(<LiveMiniMapGL entries={SOLENT} isLive />);
        const map = lastMap();
        expect(map.remove).not.toHaveBeenCalled();
        unmount();
        expect(map.remove).toHaveBeenCalledTimes(1);
    });

    it('exists only while on screen, with a short grace so a scroll flick does not rebuild it', () => {
        vi.useFakeTimers();
        FakeIntersectionObserver.visibleOnObserve = false;
        render(<LiveMiniMapGL entries={SOLENT} isLive />);
        expect(FakeMapboxMap.instances).toHaveLength(0);

        // Scrolled into view: built once it has stayed there a moment.
        act(() => FakeIntersectionObserver.show(true));
        expect(FakeMapboxMap.instances).toHaveLength(0);
        act(() => vi.advanceTimersByTime(250));
        expect(FakeMapboxMap.instances).toHaveLength(1);
        const first = lastMap();

        // Off screen for a moment, back again: the same map.
        act(() => FakeIntersectionObserver.show(false));
        act(() => vi.advanceTimersByTime(500));
        act(() => FakeIntersectionObserver.show(true));
        act(() => vi.advanceTimersByTime(5_000));
        expect(first.remove).not.toHaveBeenCalled();
        expect(FakeMapboxMap.instances).toHaveLength(1);

        // Gone for good: removed, and rebuilt only when it is seen again.
        act(() => FakeIntersectionObserver.show(false));
        act(() => vi.advanceTimersByTime(2_000));
        expect(first.remove).toHaveBeenCalledTimes(1);
        act(() => FakeIntersectionObserver.show(true));
        act(() => vi.advanceTimersByTime(250));
        expect(FakeMapboxMap.instances).toHaveLength(2);
    });

    it('on screen when the page opens on it: drawn at once, no wait', () => {
        vi.useFakeTimers();
        render(<LiveMiniMapGL entries={SOLENT} isLive />);
        expect(FakeMapboxMap.instances).toHaveLength(1);
    });

    it('a card flung past in the voyage list is never built (no billed load, no WebGL context)', () => {
        vi.useFakeTimers();
        FakeIntersectionObserver.visibleOnObserve = false;
        render(<LiveMiniMapGL entries={SOLENT} />);
        for (let pass = 0; pass < 3; pass++) {
            act(() => FakeIntersectionObserver.show(true));
            act(() => vi.advanceTimersByTime(120));
            act(() => FakeIntersectionObserver.show(false));
            act(() => vi.advanceTimersByTime(2_000));
        }
        expect(FakeMapboxMap.attempts).toBe(0);
    });

    it('crossings handed over together (in, then out): the newest wins and the map goes', () => {
        vi.useFakeTimers();
        render(<LiveMiniMapGL entries={SOLENT} isLive />);
        const map = lastMap();
        // Off and back in one callback: still on screen, the same map.
        act(() => FakeIntersectionObserver.deliver(false, true));
        act(() => vi.advanceTimersByTime(5_000));
        expect(map.remove).not.toHaveBeenCalled();
        // In, then out, in one callback: off screen, removed after the grace.
        act(() => FakeIntersectionObserver.deliver(true, false));
        act(() => vi.advanceTimersByTime(1_499));
        expect(map.remove).not.toHaveBeenCalled();
        act(() => vi.advanceTimersByTime(2));
        expect(map.remove).toHaveBeenCalledTimes(1);
        expect(FakeMapboxMap.instances).toHaveLength(1);
    });

    it('opens on the boat’s track, not a fixed harbour, and frames it as the old map did', () => {
        render(<LiveMiniMapGL entries={SOLENT} isLive />);
        const map = lastMap();
        const [[west, south], [east, north]] = map.options.bounds as [[number, number], [number, number]];
        expect([west, south, east, north]).toEqual([-1.33, 50.765, -1.297, 50.779]);
        expect(map.options.fitBoundsOptions).toEqual({ padding: 16, maxZoom: 14, retainPadding: false });
    });

    it('opens on the live fix when there is no track yet, and on the world when there is nothing', () => {
        render(<LiveMiniMapGL entries={[]} initialCenter={{ lat: 37.94, lon: 23.64 }} isLive />);
        expect(lastMap().options).toMatchObject({ center: [23.64, 37.94], zoom: 13 });
        render(<LiveMiniMapGL entries={[]} isLive />);
        expect(lastMap().options).toMatchObject({ center: [0, 20], zoom: 1 });
    });

    it('a tap on the card opens it; a tap on the credits does not', () => {
        const onTap = vi.fn();
        const { container } = render(<LiveMiniMapGL entries={SOLENT} onTap={onTap} />);
        const map = lastMap();
        expect(map.options.interactive).toBe(false);
        fireEvent.click(map.getCanvasContainer());
        expect(onTap).toHaveBeenCalledTimes(1);
        const credits = document.createElement('div');
        credits.className = 'mapboxgl-ctrl mapboxgl-ctrl-attrib';
        map.getContainer().appendChild(credits);
        fireEvent.click(credits);
        expect(onTap).toHaveBeenCalledTimes(1);
        expect(container.querySelector('.thalassa-log-gl-map')).not.toBeNull();
    });

    it('fullscreen: pans and pinches, a clean tap shrinks it, and the first touch stops the auto-follow', () => {
        const onTap = vi.fn();
        const { rerender } = render(<LiveMiniMapGL entries={SOLENT} isLive freeZoom onTap={onTap} />);
        const map = lastMap();
        expect(map.options.interactive).toBe(true);
        map.loadStyle();
        map.fire('click');
        expect(onTap).toHaveBeenCalledTimes(1);
        const fits = () => map.fitBounds.mock.calls.length + map.jumpTo.mock.calls.length;
        rerender(<LiveMiniMapGL entries={[...SOLENT, fix('s4', 50.781, -1.35, 15)]} isLive freeZoom onTap={onTap} />);
        const before = fits();
        expect(before).toBeGreaterThan(0);
        fireEvent.touchStart(map.getContainer());
        rerender(
            <LiveMiniMapGL
                entries={[...SOLENT, fix('s4', 50.781, -1.35, 15), fix('s5', 50.783, -1.37, 20)]}
                isLive
                freeZoom
                onTap={onTap}
            />,
        );
        expect(fits()).toBe(before);
    });

    it('no WebGL (Lockdown Mode): a plain box that still taps open, the Log page around it intact, no retry this visit', () => {
        vi.useFakeTimers();
        FakeMapboxMap.failWebGL = true;
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const onTap = vi.fn();
        const { container, getByRole } = render(
            <ErrorBoundary boundaryName="LogPage">
                <LiveMiniMapGL entries={SOLENT} isLive onTap={onTap} />
                <button type="button">Stop</button>
            </ErrorBoundary>,
        );
        expect(getByRole('button', { name: 'Stop' })).toBeTruthy();
        const box = container.querySelector<HTMLElement>('.thalassa-log-gl-map')!;
        expect(box).not.toBeNull();
        expect(box.childElementCount).toBe(0);
        expect(box.classList.contains('mapboxgl-map')).toBe(false);
        expect(warn).toHaveBeenCalledWith('[LogMap]', expect.stringMatching(/could not start/), expect.any(Error));
        fireEvent.click(box);
        expect(onTap).toHaveBeenCalledTimes(1);
        // Scrolled away and back: Mapbox is not asked again this visit.
        act(() => FakeIntersectionObserver.show(false));
        act(() => vi.advanceTimersByTime(2_000));
        act(() => FakeIntersectionObserver.show(true));
        act(() => vi.advanceTimersByTime(1_000));
        expect(FakeMapboxMap.attempts).toBe(1);
        fireEvent.click(box);
        expect(onTap).toHaveBeenCalledTimes(2);
    });

    it('daylight: the light box and the faint vignette, as the Leaflet Log maps had', () => {
        const css = readFileSync('styles/daylight.css', 'utf8');
        const rule = (selector: string) => {
            const at = css.indexOf(`${selector} {`);
            return at < 0 ? '' : css.slice(at, css.indexOf('}', at));
        };
        expect(rule(':root.display-light .thalassa-log-gl-map')).toMatch(/background:\s*#f1f5f9/);
        expect(rule(':root.display-light .thalassa-log-gl-map::after')).toMatch(
            /box-shadow:\s*inset 0 0 20px rgba\(15, 23, 42, 0\.1\)/,
        );
        // The box takes its colour from those rules, never a dark inline one.
        const { container } = render(<LiveMiniMap entries={SOLENT} isLive />);
        expect(container.querySelector<HTMLElement>('.thalassa-log-gl-map')!.style.background).toBe('');
        const app = readFileSync('index.css', 'utf8');
        expect(app).toMatch(/\.thalassa-log-gl-map \{[^}]*background: #0b1220/);
    });

    it('without a Mapbox token draws no map, and says nothing alarming', () => {
        vi.stubEnv('VITE_MAPBOX_ACCESS_TOKEN', '');
        const { container } = render(<LiveMiniMapGL entries={SOLENT} isLive />);
        expect(FakeMapboxMap.instances).toHaveLength(0);
        expect(container.querySelector('.live-mini-map')).not.toBeNull();
    });
});

describe('LiveMiniMap loads its Mapbox map lazily', () => {
    it('keeps the card’s size while the map chunk loads, then draws the same map', async () => {
        const { container } = render(<LiveMiniMap entries={SOLENT} height={140} isLive />);
        const box = container.querySelector<HTMLElement>('.live-mini-map')!;
        expect(box.style.height).toBe('140px');
        await waitFor(() => expect(FakeMapboxMap.instances).toHaveLength(1));
    });

    it('the wrapper imports the Mapbox map only through import()', () => {
        const wrapper = readFileSync('components/LiveMiniMap.tsx', 'utf8');
        expect(wrapper).toMatch(/import\('\.\/LiveMiniMapGL'\)/);
        expect(wrapper).not.toMatch(/from '\.\/LiveMiniMapGL'|from 'mapbox-gl'|from '\.\/map\/logMap'/);
    });
});
