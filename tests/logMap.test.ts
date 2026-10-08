/**
 * The Mapbox GL helper behind the Log page's maps (125-13a; 125-13b reuses
 * it for the big track map). Shane 2026-10-09: "on the log page, can we
 * replace the little and the big map with our relief + sat ?? remove the old
 * satellite map".
 *
 * Pinned here, without WebGL (the browser spec renders it for real):
 *  - the base is Relief + Sat, drawn by reliefBase inside dark-v11, with the
 *    layers seaBaseLayers('reliefSat') names visible and the rest hidden;
 *  - land imagery is mapbox.satellite under the opaque water, never the old
 *    satellite-streets raster or Esri;
 *  - tiles follow Obs's Pi rule (useMapInit) exactly. That rule is dormant
 *    while PiCacheService.PI_TILE_PROXY_USABLE is false (canDisplayProxiedTiles
 *    is then never true), so the Pi cases below force it on: they pin the
 *    rule for the day it flips, not an offline map today;
 *  - padded framing never leaves its padding on the map (retainPadding: false);
 *  - no WebGL context: no map and no throw, the caller's box handed back plain;
 *  - credits are a compact ⓘ, and every source carries its licence credit;
 *  - memory: tile cache capped, no preserveDrawingBuffer;
 *  - a style that never arrives (no internet, nothing cached) falls back to
 *    a plain sea, so the track still draws;
 *  - a track across the antimeridian frames as one short line.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeAttributionControl, FakeMapboxMap } from './helpers/fakeMapboxGl';

const pi = vi.hoisted(() => ({
    display: false,
    passthroughTileUrl: vi.fn(
        (url: string): string | null => `https://pi.fixture.test/api/passthrough-tile?url=${encodeURIComponent(url)}`,
    ),
}));

vi.mock('../services/PiCacheService', () => ({
    piCache: {
        canDisplayProxiedTiles: () => pi.display,
        passthroughTileUrl: (url: string) => pi.passthroughTileUrl(url),
    },
}));

vi.mock('mapbox-gl', async () => {
    const { fakeMapboxGl } = await import('./helpers/fakeMapboxGl');
    return { default: fakeMapboxGl };
});

import {
    createLogMap,
    fitLogMap,
    installLogMapBase,
    LAND_IMAGERY_SOURCE,
    LOG_MAP_BASE,
    LOG_MAP_FALLBACK_STYLE,
    LOG_MAP_STYLE,
    LOG_MAP_TILE_CACHE,
    LOG_SEAMARK_LAYER,
    logMapBounds,
    logMapTransformRequest,
    unwrapLongitudes,
} from '../components/map/logMap';
import { LAND_IMAGERY_LAYER, RELIEF_ATTRIBUTION, seaBaseLayers } from '../components/map/reliefBase';

const OLD_SATELLITE = /satellite-streets|arcgisonline|World_Imagery/;
const RELIEF_TILE = 'https://tiles.thalassatiles.com/v1/relief-global/idx/9/251/169.png';
const SEAMARK_TILE = 'https://tiles.openseamap.org/seamark/14/8170/5470.png';
const SATELLITE_TILE = 'https://api.mapbox.com/v4/mapbox.satellite/14/8170/5470@2x.jpg90?access_token=pk.test';

function newMap(overrides: Partial<Parameters<typeof createLogMap>[0]> = {}) {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const map = createLogMap({
        container,
        token: 'pk.test',
        gestures: 'card',
        view: { center: [-1.3, 50.75], zoom: 12 },
        ...overrides,
    }) as unknown as FakeMapboxMap;
    return map;
}

beforeEach(() => {
    FakeMapboxMap.instances.length = 0;
    FakeMapboxMap.attempts = 0;
    FakeMapboxMap.failWebGL = false;
    pi.display = false;
    pi.passthroughTileUrl.mockClear();
    vi.useRealTimers();
});

describe('Log map tiles: Obs’s Pi rule, dormant until PI_TILE_PROXY_USABLE flips', () => {
    it('sends relief and seamark tiles through the Pi when the map can display them', () => {
        pi.display = true;
        for (const url of [RELIEF_TILE, SEAMARK_TILE]) {
            const routed = logMapTransformRequest(url, 'Tile');
            expect(routed.url).toMatch(/^https:\/\/pi\.fixture\.test\/api\/passthrough-tile\?url=/);
            expect(decodeURIComponent(routed.url.split('url=')[1])).toBe(url);
        }
    });

    it('leaves Mapbox’s own tiles, styles and local hosts direct, as useMapInit does', () => {
        pi.display = true;
        expect(logMapTransformRequest(SATELLITE_TILE, 'Tile').url).toBe(SATELLITE_TILE);
        expect(logMapTransformRequest(RELIEF_TILE, 'Style').url).toBe(RELIEF_TILE);
        const lan = 'http://192.168.1.20:8080/tiles/12/3/4.png';
        expect(logMapTransformRequest(lan, 'Tile').url).toBe(lan);
        expect(pi.passthroughTileUrl).toHaveBeenCalledTimes(0);
    });

    it('goes direct while proxied tiles cannot be displayed, or the Pi gives no URL', () => {
        expect(logMapTransformRequest(RELIEF_TILE, 'Tile').url).toBe(RELIEF_TILE);
        pi.display = true;
        pi.passthroughTileUrl.mockReturnValueOnce(null);
        expect(logMapTransformRequest(SEAMARK_TILE, 'Tile').url).toBe(SEAMARK_TILE);
    });

    it('hands that rule to Mapbox as the map’s transformRequest', () => {
        const map = newMap();
        expect(map.options.transformRequest).toBe(logMapTransformRequest);
    });
});

describe('Relief + Sat, drawn by reliefBase inside dark-v11', () => {
    it('opens dark-v11 and shows exactly the Relief + Sat layers once the style is in', () => {
        const map = newMap();
        expect(map.options.style).toBe(LOG_MAP_STYLE);
        expect(LOG_MAP_STYLE).toBe('mapbox://styles/mapbox/dark-v11');
        expect(LOG_MAP_BASE).toBe('reliefSat');
        map.loadStyle();
        const expected = seaBaseLayers('reliefSat');
        expect(expected.length).toBeGreaterThan(5);
        for (const [id, visible] of expected) {
            expect(map.visibility(id), id).toBe(visible ? 'visible' : 'none');
        }
        expect(map.visibility(LAND_IMAGERY_LAYER)).toBe('visible');
        // Land imagery sits UNDER the opaque water fill: no photo seams at sea.
        const ids = map.layers.map((layer) => layer.id);
        expect(ids.indexOf(LAND_IMAGERY_LAYER)).toBeLessThan(ids.indexOf('water'));
    });

    it('takes its land imagery from mapbox.satellite, never the old satellite tiles', () => {
        const map = newMap();
        map.loadStyle();
        const imagery = map.getSource(LAND_IMAGERY_SOURCE)!;
        expect(imagery.spec.tiles).toEqual([
            'https://api.mapbox.com/v4/mapbox.satellite/{z}/{x}/{y}@2x.jpg90?access_token=pk.test',
        ]);
        expect(map.getLayer(LAND_IMAGERY_LAYER)?.source).toBe(LAND_IMAGERY_SOURCE);
        for (const url of map.tileUrls()) expect(url).not.toMatch(OLD_SATELLITE);
    });

    it('credits every source it adds: imagery, relief (with Not for navigation) and seamarks', () => {
        const map = newMap();
        map.loadStyle();
        expect(map.getSource(LAND_IMAGERY_SOURCE)!.spec.attribution).toMatch(/Mapbox[\s\S]*Maxar/);
        const relief = [...map.sources.entries()].filter(([id]) => id.startsWith('relief-'));
        expect(relief.length).toBeGreaterThan(0);
        for (const [, source] of relief) expect(source.spec.attribution).toBe(RELIEF_ATTRIBUTION);
        expect(RELIEF_ATTRIBUTION).toContain('Not for navigation');
        const seamarks = map.getSource(map.getLayer(LOG_SEAMARK_LAYER)!.source!)!;
        expect(seamarks.spec.attribution).toMatch(/OpenSeaMap/);
        expect(seamarks.spec.tiles).toEqual(['https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png']);
    });

    it('hides roads, buildings and road labels, and keeps place names', () => {
        const map = newMap();
        map.loadStyle();
        for (const id of ['road-primary', 'building', 'road-label', 'poi-label']) {
            expect(map.visibility(id), id).toBe('none');
        }
        expect(map.visibility('settlement-major-label')).toBe('visible');
    });

    it('is idempotent: a second install adds nothing twice', () => {
        const map = newMap();
        map.loadStyle();
        const count = map.layers.length;
        expect(() => installLogMapBase(map as never, 'pk.test')).not.toThrow();
        expect(map.layers.length).toBe(count);
    });
});

describe('createLogMap: compact credits, memory and gestures', () => {
    it('collapses the credits to Mapbox’s compact ⓘ and keeps the wordmark', () => {
        const card = newMap();
        expect(card.options.attributionControl).toBe(false);
        const credits = card.controls.find(({ control }) => control instanceof FakeAttributionControl)!;
        expect((credits.control as FakeAttributionControl).options).toEqual({ compact: true });
        // On a card the bottom corners carry the card's own buttons.
        expect(credits.position).toBe('top-right');
        expect(card.options.logoPosition).toBe('top-left');
        const free = newMap({ gestures: 'free' });
        expect(free.controls.find(({ control }) => control instanceof FakeAttributionControl)!.position).toBe(
            'bottom-right',
        );
        expect(free.options.logoPosition).toBe('bottom-right');
    });

    it('caps the tile cache and never keeps the drawing buffer', () => {
        const card = newMap();
        const free = newMap({ gestures: 'free' });
        expect(card.options.maxTileCacheSize).toBe(LOG_MAP_TILE_CACHE.card);
        expect(free.options.maxTileCacheSize).toBe(LOG_MAP_TILE_CACHE.free);
        expect(LOG_MAP_TILE_CACHE.card).toBeLessThanOrEqual(8);
        expect(LOG_MAP_TILE_CACHE.free).toBeLessThanOrEqual(20);
        for (const map of [card, free]) expect(map.options.preserveDrawingBuffer).not.toBe(true);
    });

    it('a card map is a picture (tap to open); the fullscreen map pans and pinches, north-up', () => {
        const card = newMap();
        expect(card.options.interactive).toBe(false);
        const free = newMap({ gestures: 'free' });
        expect(free.options).toMatchObject({
            interactive: true,
            dragPan: true,
            scrollZoom: true,
            dragRotate: false,
            touchPitch: false,
            pitchWithRotate: false,
            doubleClickZoom: false,
            boxZoom: false,
            keyboard: false,
        });
        expect(free.touchZoomRotate!.disableRotation).toHaveBeenCalled();
    });

    it('opens on the bounds it is given, or a centre, with the token as its own (never the global)', () => {
        const fitted = newMap({
            view: {
                bounds: [
                    [-1.4, 50.7],
                    [-1.2, 50.8],
                ],
                padding: 16,
                maxZoom: 14,
            },
        });
        expect(fitted.options.bounds).toEqual([
            [-1.4, 50.7],
            [-1.2, 50.8],
        ]);
        expect(fitted.options.fitBoundsOptions).toEqual({ padding: 16, maxZoom: 14, retainPadding: false });
        expect(fitted.options.accessToken).toBe('pk.test');
    });
});

describe('Framing never leaves its padding on the map (tests/cameraPaddingGuard.test.ts)', () => {
    // Mapbox GL 3 keeps a camera call's padding unless it says retainPadding:
    // false; kept, every later frame and the map's bounds would be off-centre.
    it('the first frame and every later fit release their padding', () => {
        const map = newMap({
            view: {
                bounds: [
                    [174.7, -36.9],
                    [174.9, -36.8],
                ],
            },
        });
        expect(map.options.fitBoundsOptions).toMatchObject({ padding: 16, retainPadding: false });
        Object.defineProperties(map.container, { clientWidth: { value: 360 }, clientHeight: { value: 200 } });
        // Auckland's Waitematā, a fictional boat.
        const fitted = fitLogMap(map as never, [
            [174.76, -36.84],
            [174.82, -36.85],
        ]);
        expect(fitted).toBe(true);
        expect(map.fitBounds).toHaveBeenCalledTimes(1);
        expect(map.fitBounds.mock.calls[0][1]).toMatchObject({ padding: 16, animate: false, retainPadding: false });
    });
});

describe('No WebGL in this web view: no map, and nothing thrown into the Log page', () => {
    // mapbox-gl 3.19 throws "Failed to initialize WebGL." from its constructor
    // when the web view gives it no context (Lockdown Mode switches WebGL off).
    it('returns null, hands the box back plain, and says why in a warning that survives production', () => {
        FakeMapboxMap.failWebGL = true;
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const container = document.createElement('div');
        let made: unknown = 'not called';
        expect(() => {
            made = createLogMap({
                container,
                token: 'pk.test',
                gestures: 'card',
                view: { center: [10.75, 59.9], zoom: 11 },
            });
        }).not.toThrow();
        expect(made).toBeNull();
        expect(FakeMapboxMap.attempts).toBe(1);
        expect(container.classList.contains('mapboxgl-map')).toBe(false);
        expect(container.childElementCount).toBe(0);
        expect(warn).toHaveBeenCalledWith(
            '[LogMap]',
            expect.stringMatching(/Log map not drawn: Mapbox could not start/),
            expect.any(Error),
        );
        warn.mockRestore();
    });
});

describe('No internet and no cached style: a plain sea, so the track still draws', () => {
    it('falls back once when the style fails, and runs the overlays on the fallback', () => {
        const onStyle = vi.fn();
        const map = newMap({ onStyle });
        map.fire('error', { error: new Error('Failed to fetch') });
        expect(map.styleSet).toEqual([LOG_MAP_FALLBACK_STYLE]);
        // Tile errors name a source and never swap the style.
        map.fire('error', { error: new Error('tile'), sourceId: 'relief-global-idx' });
        expect(map.styleSet).toHaveLength(1);
        map.loadStyle([{ id: 'background', type: 'background', paint: {} }], { composite: false });
        expect(onStyle).toHaveBeenCalledTimes(1);
        expect(map.container.dataset.logMapStyle).toBe('fallback');
    });

    it('falls back when the style never answers (a stalled link at sea)', () => {
        vi.useFakeTimers();
        const map = newMap();
        vi.advanceTimersByTime(7_999);
        expect(map.styleSet).toHaveLength(0);
        vi.advanceTimersByTime(2);
        expect(map.styleSet).toEqual([LOG_MAP_FALLBACK_STYLE]);
    });

    it('never falls back after the real style is in', () => {
        vi.useFakeTimers();
        const onStyle = vi.fn();
        const map = newMap({ onStyle });
        map.loadStyle();
        vi.advanceTimersByTime(60_000);
        map.fire('error', { error: new Error('A valid Mapbox access token is required') });
        expect(map.styleSet).toHaveLength(0);
        expect(onStyle).toHaveBeenCalledTimes(1);
        expect(map.container.dataset.logMapStyle).toBe('relief-sat');
    });
});

describe('Anywhere on the planet: a track across the antimeridian is one short line', () => {
    it('unwraps longitudes so Fiji’s 180th meridian does not span the world', () => {
        const fiji: [number, number][] = [
            [179.6, -16.8],
            [179.95, -16.9],
            [-179.9, -17.0],
            [-179.7, -17.1],
        ];
        const line = unwrapLongitudes(fiji);
        expect(line.map(([lon]) => Number(lon.toFixed(2)))).toEqual([179.6, 179.95, 180.1, 180.3]);
        const bounds = logMapBounds(line)!;
        expect(bounds[1][0] - bounds[0][0]).toBeCloseTo(0.7, 5);
    });

    it('leaves an ordinary track alone (the Solent, the Aegean)', () => {
        const solent: [number, number][] = [
            [-1.31, 50.76],
            [-1.27, 50.78],
        ];
        expect(unwrapLongitudes(solent)).toEqual(solent);
        expect(logMapBounds(solent)).toEqual([
            [-1.31, 50.76],
            [-1.27, 50.78],
        ]);
        expect(logMapBounds([[25.37, 37.45]])).toEqual([
            [25.37, 37.45],
            [25.37, 37.45],
        ]);
        expect(logMapBounds([])).toBeNull();
    });
});
