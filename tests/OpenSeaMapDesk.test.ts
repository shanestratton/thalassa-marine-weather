import { readFileSync } from 'node:fs';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type mapboxgl from 'mapbox-gl';
import type { WeatherLayer } from '../components/map/mapConstants';

/**
 * OpenSeaMap's seamarks on the desk (127-DESKMAP B1/B4). Shane 2026-10-10:
 * "the free OpenSeaMap layer with buoys and beacons" — on by default on the
 * web planner, one owner for the raster, and never a buoy drawn twice where a
 * chart draws its own (the Mooloolaba beacon 5 bug, 2026-07-09).
 */

type Box = [number, number, number, number];
const cells = vi.hoisted(() => ({ nav: [] as Array<{ bbox: Box }>, display: [] as Array<{ bbox: Box }> }));
vi.mock('../services/enc/EncCellMetadata', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../services/enc/EncCellMetadata')>()),
    listCells: () => cells.nav,
    listDisplayCells: () => cells.display,
}));

import { useOpenSeaMapRasterHide, type DeskSeamarkInput } from '../components/map/mapHub/useOpenSeaMapRasterHide';
import { getTileUrl, STATIC_TILES } from '../components/map/mapConstants';

// Fictional, public waters: the Solent (England) and Chesapeake Bay (USA).
const SOLENT: Box = [-1.45, 50.7, -1.2, 50.85];
const CHESAPEAKE: Box = [-76.5, 38.9, -76.3, 39.05];
/** A NOAA-shaped cell off a fictional Chesapeake shore. */
const CELL: Box = [-76.45, 38.95, -76.35, 39.0];

type Handler = (event?: unknown) => void;
class SeamarkMap {
    layout = new Map<string, string>([
        ['openseamap-permanent', 'none'],
        ['harbour-seamarks-circle', 'visible'],
    ]);
    writes: Array<[string, string]> = [];
    handlers = new Map<string, Handler[]>();
    bounds: Box = SOLENT;
    zoom = 12;
    getLayer = (id: string) => (this.layout.has(id) ? { id } : undefined);
    getLayoutProperty = (id: string) => this.layout.get(id);
    setLayoutProperty = (id: string, _prop: string, value: string) => {
        this.writes.push([id, value]);
        this.layout.set(id, value);
    };
    getBounds = () => ({
        getWest: () => this.bounds[0],
        getSouth: () => this.bounds[1],
        getEast: () => this.bounds[2],
        getNorth: () => this.bounds[3],
    });
    getZoom = () => this.zoom;
    on = (type: string, handler: Handler) => {
        this.handlers.set(type, [...(this.handlers.get(type) ?? []), handler]);
        return this;
    };
    off = (type: string, handler: Handler) => {
        this.handlers.set(
            type,
            (this.handlers.get(type) ?? []).filter((h) => h !== handler),
        );
        return this;
    };
    fire(type: string, event: Record<string, unknown> = {}) {
        for (const handler of [...(this.handlers.get(type) ?? [])]) handler({ type, ...event });
    }
    visible = () => this.layout.get('openseamap-permanent') === 'visible';
}

interface Props {
    chartsActive?: boolean;
    encActive?: boolean;
    layers?: WeatherLayer[];
    desk?: DeskSeamarkInput;
}
function mount(map: SeamarkMap, initial: Props) {
    const ref = { current: map as unknown as mapboxgl.Map };
    return renderHook(
        ({ chartsActive = false, encActive = false, layers = [], desk }: Props) =>
            useOpenSeaMapRasterHide(ref, true, chartsActive, encActive, new Set(layers), true, desk),
        { initialProps: initial },
    );
}
const desk = (over: Partial<DeskSeamarkInput> = {}): DeskSeamarkInput => ({
    surface: true,
    on: true,
    chartMarks: false,
    encCellCount: cells.nav.length,
    ...over,
});
/** Pan the map and let the coalesced moveend pass (120 ms) run. */
function pan(map: SeamarkMap, to: Box) {
    map.bounds = to;
    act(() => {
        map.fire('moveend');
        vi.advanceTimersByTime(150);
    });
}

beforeEach(() => {
    vi.useFakeTimers();
    cells.nav = [];
    cells.display = [];
});
afterEach(() => vi.useRealTimers());

describe('the desk shows seamarks by default, behind its switch', () => {
    it('desk + seamarks on + no cells: the raster shows', () => {
        const map = new SeamarkMap();
        const { result } = mount(map, { desk: desk() });
        expect(map.visible()).toBe(true);
        expect(result.current.shown).toBe(true);
        expect(result.current.chartInView).toBe(false);
    });

    it('desk with cells loaded but none in view (the Solent, a Chesapeake cell): the raster shows', () => {
        cells.nav = cells.display = [{ bbox: CELL }];
        const map = new SeamarkMap();
        mount(map, { encActive: false, desk: desk({ chartMarks: true }) });
        expect(map.visible()).toBe(true);
    });

    it('tracing with a cell on screen: hidden, so a buoy is never drawn twice; pan off the cell and the buoys return', () => {
        cells.nav = cells.display = [{ bbox: CELL }];
        const map = new SeamarkMap();
        map.bounds = CHESAPEAKE;
        const { result } = mount(map, { desk: desk({ chartMarks: true }) });
        expect(map.visible()).toBe(false);
        expect(result.current.chartInView).toBe(true);
        pan(map, [-76.3, 39.1, -76.1, 39.25]);
        expect(map.visible()).toBe(true);
        expect(result.current.chartInView).toBe(false);
        // A cell edge on screen hides the whole view: a missing OSM buoy is
        // honest, a doubled one is the Mooloolaba bug.
        pan(map, [-76.36, 38.99, -76.2, 39.1]);
        expect(map.visible()).toBe(false);
    });

    // ENC left on in Obs stays on under the planner (useEncAtOpen): the desk's
    // own view test decides there, never the world-wide gate, or no buoy would
    // draw anywhere while the strip and the menu said they show.
    it('with ENC left on in Obs: shown over the Solent, hidden over the Chesapeake cell', () => {
        cells.nav = cells.display = [{ bbox: CELL }];
        const map = new SeamarkMap();
        const { result } = mount(map, { encActive: true, desk: desk({ chartMarks: true }) });
        expect(map.visible()).toBe(true);
        expect(result.current.shown).toBe(true);
        pan(map, CHESAPEAKE);
        expect(map.visible()).toBe(false);
        pan(map, [-58.5, -34.7, -58.2, -34.5]); // the Río de la Plata, Buenos Aires
        expect(map.visible()).toBe(true);
    });

    it('tells the seabed line only when the view crosses z12, so a zoom that changes nothing renders nothing', () => {
        const map = new SeamarkMap();
        map.zoom = 13;
        let renders = 0;
        const ref = { current: map as unknown as mapboxgl.Map };
        const { result } = renderHook(() => {
            renders += 1;
            return useOpenSeaMapRasterHide(ref, true, false, false, new Set(), true, desk());
        });
        expect(result.current.low).toBe(false);
        const settled = renders;
        for (const zoom of [14, 15.5, 16, 17.25, 13.1]) {
            map.zoom = zoom;
            pan(map, SOLENT);
        }
        // React may render once more before it bails out of an unchanged
        // state; a raw zoom in state would render on every one of the five.
        expect(renders - settled).toBeLessThanOrEqual(1);
        map.zoom = 11.5;
        pan(map, SOLENT);
        expect(result.current.low).toBe(true);
    });

    it('with the chart’s marks not drawn (Route Planner map, no tracer), a cell on screen does not hide them', () => {
        cells.nav = cells.display = [{ bbox: CELL }];
        const map = new SeamarkMap();
        map.bounds = CHESAPEAKE;
        const { result } = mount(map, { desk: desk({ chartMarks: false }) });
        expect(map.visible()).toBe(true);
        expect(result.current.chartInView).toBe(true);
    });

    it('a cell that crosses the antimeridian still meets a view on its far side (Fiji)', () => {
        cells.nav = cells.display = [{ bbox: [179.5, -17, 180, -16.5] }];
        const map = new SeamarkMap();
        map.bounds = [-180.3, -16.9, -179.8, -16.6];
        const { result } = mount(map, { desk: desk({ chartMarks: true }) });
        expect(result.current.chartInView).toBe(true);
    });

    it('desk seamarks off: hidden', () => {
        const map = new SeamarkMap();
        const { result } = mount(map, { desk: desk({ on: false }) });
        expect(map.visible()).toBe(false);
        expect(result.current.shown).toBe(false);
    });

    it('picker, embedded and pin maps (no desk surface): hidden, with no listeners', () => {
        const map = new SeamarkMap();
        mount(map, { desk: desk({ surface: false }) });
        expect(map.visible()).toBe(false);
        expect(map.handlers.get('moveend') ?? []).toHaveLength(0);
    });

    it('toggling a plan-layer set (the desk’s wind, 127-DESKMAP-b) never blinks them', () => {
        const map = new SeamarkMap();
        const view = mount(map, { desk: desk() });
        view.rerender({ desk: desk(), layers: ['wind'] });
        view.rerender({ desk: desk(), layers: [] });
        expect(map.visible()).toBe(true);
        expect(map.writes.filter(([id, v]) => id === 'openseamap-permanent' && v === 'none')).toEqual([]);
    });
});

describe('off the desk, today’s rule', () => {
    it('Obs Sea marks with no chart: shown', () => {
        const map = new SeamarkMap();
        mount(map, { layers: ['sea'] });
        expect(map.visible()).toBe(true);
    });

    it('Obs Sea marks + ENC active: hidden (the global gate stays off the desk)', () => {
        const map = new SeamarkMap();
        mount(map, { layers: ['sea'], encActive: true });
        expect(map.visible()).toBe(false);
    });

    it('no Sea marks toggle: hidden', () => {
        const map = new SeamarkMap();
        mount(map, {});
        expect(map.visible()).toBe(false);
    });
});

describe('honest when OpenSeaMap is down', () => {
    const tileError = (status: number) => ({ sourceId: 'openseamap-permanent', error: { status } });

    it('three non-404 errors in 30 s turn the label to "not answering"; a quiet moveend restores it', () => {
        const map = new SeamarkMap();
        const { result } = mount(map, { desk: desk() });
        act(() => {
            map.fire('error', tileError(503));
            map.fire('error', tileError(503));
        });
        expect(result.current.down).toBe(false);
        act(() => map.fire('error', tileError(503)));
        expect(result.current.down).toBe(true);
        act(() => map.fire('moveend'));
        expect(result.current.down).toBe(false);
    });

    it('errors spread over more than 30 s, 404s and other sources never count', () => {
        const map = new SeamarkMap();
        const { result } = mount(map, { desk: desk() });
        act(() => {
            for (let i = 0; i < 3; i++) map.fire('error', tileError(404));
            map.fire('error', { sourceId: 'relief-global-idx', error: { status: 503 } });
            map.fire('error', { sourceId: 'relief-global-idx', error: { status: 503 } });
            map.fire('error', { sourceId: 'relief-global-idx', error: { status: 503 } });
        });
        expect(result.current.down).toBe(false);
        act(() => {
            map.fire('error', tileError(500));
            map.fire('error', tileError(500));
            vi.advanceTimersByTime(31_000);
            map.fire('error', tileError(500));
        });
        expect(result.current.down).toBe(false);
    });

    it('a moveend with fresh errors since the last one keeps it down', () => {
        const map = new SeamarkMap();
        const { result } = mount(map, { desk: desk() });
        act(() => {
            for (let i = 0; i < 3; i++) map.fire('error', tileError(503));
            map.fire('error', tileError(503));
            map.fire('moveend');
        });
        expect(result.current.down).toBe(true);
    });
});

describe('one OpenSeaMap raster, not two (127-DESKMAP B4)', () => {
    const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const weather = strip(readFileSync('components/map/useWeatherLayers.ts', 'utf8'));

    it('the Sea marks toggle has no second raster: no tile URL, no tiles-sea source', () => {
        expect(getTileUrl('sea')).toBeUndefined();
        expect(Object.keys(STATIC_TILES)).not.toContain('sea');
        const tileLayers = weather.match(/const TILE_LAYERS: WeatherLayer\[\] = \[([\s\S]*?)\];/)?.[1] ?? '';
        expect(tileLayers).toContain("'temperature'");
        expect(tileLayers).not.toContain("'sea'");
        expect(weather).not.toMatch(/['`]tiles-sea['`]/);
    });

    it('the Sea marks sync never writes the permanent raster: useOpenSeaMapRasterHide owns it', () => {
        const sync = weather.match(/const seaVisible = [\s\S]*?\]\) \{/)?.[0] ?? '';
        expect(sync).toContain("'harbour-seamarks-circle'");
        expect(sync).not.toContain('openseamap-permanent');
        expect(weather).not.toContain("'openseamap-permanent'");
    });
});
