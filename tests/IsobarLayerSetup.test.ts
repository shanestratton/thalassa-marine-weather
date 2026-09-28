import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    hideIsobarLayers,
    initIsobarLayers,
    ISOBAR_LAYER_IDS,
    showIsobarLayers,
    SYNOPTIC_ONLY_LAYER_IDS,
} from '../components/map/isobarLayerSetup';

/** Width of a line layer at the zoom-5 stop of its interpolate expression. */
function widthAtZoom5(paint: Record<string, unknown> | undefined): number {
    const expr = paint?.['line-width'] as unknown[];
    // ['interpolate', ['linear'], ['zoom'], 2, w2, 5, w5, 8, w8]
    const value = expr[6];
    return typeof value === 'number' ? value : NaN;
}

type FakeLayer = {
    id: string;
    type: string;
    source?: string;
    'source-layer'?: string;
    layout?: Record<string, unknown>;
    paint?: Record<string, unknown>;
};

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
/** Reads feature data, as far as these layers go. */
const dataDriven = (value: unknown) => /"(get|feature-state)"/.test(JSON.stringify(value ?? null));

const LAND_GHOST = 'rgba(20, 20, 20, 0.35)';
const CONTINENT_OPACITY = ['interpolate', ['linear'], ['zoom'], 0, 0.8, 1.5, 0.5, 2.5, 0];

/**
 * The layers the standalone chart treats, as the live dark-v11 chart has them
 * (read off window.__thalassaMap at Gladstone), plus the app's own labels
 * with the opacities they are given on purpose.
 */
const baseLayers = (): FakeLayer[] => [
    { id: 'land', type: 'background', paint: { 'background-color': '#0e0e0e' } },
    { id: 'national-park', type: 'fill', source: 'composite', paint: { 'fill-color': '#333b45' } },
    { id: 'landuse', type: 'fill', source: 'composite', paint: { 'fill-color': '#333b45' } },
    // fill-color unset: the spec default. The ghost must put "unset" back.
    { id: 'land-structure-polygon', type: 'fill', source: 'composite' },
    { id: 'water', type: 'fill', source: 'composite', paint: { 'fill-color': '#000000' } },
    { id: 'building', type: 'fill', source: 'composite', paint: { 'fill-color': 'hsl(0, 0%, 12%)' } },
    { id: 'water-point-label', type: 'symbol', source: 'composite' },
    { id: 'state-label', type: 'symbol', source: 'composite', paint: { 'text-opacity': 0.5 } },
    { id: 'continent-label', type: 'symbol', source: 'composite', paint: { 'text-opacity': CONTINENT_OPACITY } },
    { id: 'poi-label', type: 'symbol', source: 'composite' },
    {
        id: 'settlement-major-label',
        type: 'symbol',
        source: 'composite',
        paint: { 'text-color': '#ffffff', 'text-halo-color': 'rgba(0, 0, 0, 0.9)' },
    },
    // EncVectorLayer.ts: labels and soundings at 0.85, derived contour labels at 0.75.
    { id: 'enc-vec-soundg', type: 'symbol', source: 'enc-vec-soundg', paint: { 'text-opacity': 0.85 } },
    { id: 'enc-vec-depcnt-derived-label', type: 'symbol', source: 'enc-vec-depcnt', paint: { 'text-opacity': 0.75 } },
    // useBuoyageDirectionLayer.ts and encCautionMounts.ts.
    { id: 'thalassa-buoyage-direction-arrow', type: 'symbol', source: 'buoyage', paint: { 'text-opacity': 0.58 } },
    { id: 'enc-caution-mounts', type: 'symbol', source: 'enc-caution', paint: { 'text-opacity': 0.9 } },
];

/**
 * A map that behaves like mapbox-gl 3.19's Style where this module cares:
 *  - an unchanged paint or layout value is a no-op (Style.set*Property's
 *    deepEqual);
 *  - any layout change, any addLayer and any paint change to or from a
 *    data-driven value queues a reload of the layer's whole source
 *    (Style._updateLayer), recorded in `reloads`;
 *  - while a reload is queued, isStyleLoaded() is false until the next frame
 *    (Style.loaded() while _changes holds an updated source cache): frame();
 *  - the frame after any style change fires 'styledata' (Style.update), to
 *    real on/off listener sets.
 */
function mapboxLike(layers: FakeLayer[] = baseLayers()) {
    const order: string[] = [];
    const byId = new Map<string, FakeLayer>();
    const values = new Map<string, unknown>();
    const sources = new Set(['composite']);
    const reloads: string[] = [];
    const listeners = new Map<string, Set<() => void>>();
    let dirty = false;
    let changed = false;
    const emit = (type: string) => {
        for (const fn of [...(listeners.get(type) ?? [])]) fn();
    };
    const reload = (id: string) => {
        const source = byId.get(id)?.source;
        if (!source) return;
        reloads.push(`${source}|${id}`);
        dirty = true;
    };
    const put = (layer: FakeLayer) => {
        byId.set(layer.id, layer);
        order.push(layer.id);
        for (const [k, v] of Object.entries(layer.paint ?? {})) values.set(`${layer.id}|paint|${k}`, v);
        for (const [k, v] of Object.entries(layer.layout ?? {})) values.set(`${layer.id}|layout|${k}`, v);
        changed = true;
    };
    layers.forEach(put);
    changed = false;
    const set = (kind: 'paint' | 'layout') => (id: string, property: string, value: unknown) => {
        if (!byId.has(id)) return; // mapbox: an error event, no write
        const key = `${id}|${kind}|${property}`;
        const old = values.get(key);
        if (same(old, value)) return;
        if (kind === 'layout' || dataDriven(old) || dataDriven(value)) reload(id);
        if (value === undefined || value === null) values.delete(key);
        else values.set(key, value);
        changed = true;
    };
    const map = {
        getStyle: vi.fn(() => ({
            layers: order.map((id) => {
                const { type, source } = byId.get(id)!;
                return { id, type, source };
            }),
        })),
        getLayer: (id: string) => byId.get(id),
        addLayer: vi.fn((layer: FakeLayer) => {
            put(layer);
            reload(layer.id);
        }),
        removeLayer: (id: string) => {
            byId.delete(id);
            order.splice(order.indexOf(id), 1);
            for (const key of [...values.keys()]) if (key.startsWith(`${id}|`)) values.delete(key);
            changed = true;
        },
        getSource: (id: string) => (sources.has(id) ? { setData: vi.fn() } : undefined),
        addSource: vi.fn((id: string) => {
            sources.add(id);
        }),
        hasImage: () => false,
        addImage: vi.fn(),
        getPaintProperty: (id: string, property: string) => values.get(`${id}|paint|${property}`),
        setPaintProperty: vi.fn(set('paint')),
        getLayoutProperty: (id: string, property: string) => values.get(`${id}|layout|${property}`),
        setLayoutProperty: vi.fn(set('layout')),
        isStyleLoaded: () => !dirty,
        on: vi.fn((type: string, fn: () => void) => {
            if (!listeners.has(type)) listeners.set(type, new Set());
            listeners.get(type)!.add(fn);
        }),
        off: vi.fn((type: string, fn: () => void) => {
            listeners.get(type)?.delete(fn);
        }),
    };
    /** The next render frame: queued reloads applied, and styledata if anything changed. */
    const frame = () => {
        dirty = false;
        if (!changed) return;
        changed = false;
        emit('styledata');
    };
    return {
        map,
        reloads,
        paint: (id: string, property: string) => values.get(`${id}|paint|${property}`),
        visibility: (id: string) => values.get(`${id}|layout|visibility`),
        frame,
        emit,
        listenerCount: (type: string) => listeners.get(type)?.size ?? 0,
        /** Frames and timers until the map is quiet: every coalesced styledata walk has run. */
        settle: () => {
            for (let i = 0; i < 10; i++) {
                frame();
                vi.advanceTimersByTime(200);
            }
        },
    };
}

type MapboxLike = ReturnType<typeof mapboxLike>;

/**
 * One pass of useWeatherLayers' main effect as far as the pressure chart goes:
 * hide when pressure is off; otherwise init, show (solo or overlay), the
 * pressure wash updateIsobars adds on its first frame, and, on the first solo
 * chart, the coastal vignette on the base source.
 */
function weatherPass(fake: MapboxLike, saved: Map<string, unknown>, active: string[]) {
    const map = fake.map as never;
    if (!active.includes('pressure')) {
        hideIsobarLayers(map, saved as never);
        return;
    }
    const overlay = active.length > 1;
    initIsobarLayers(map);
    showIsobarLayers(map, saved as never, overlay);
    if (!fake.map.getLayer('pressure-heatmap-layer')) {
        fake.map.addLayer({
            id: 'pressure-heatmap-layer',
            type: 'raster',
            source: 'pressure-heatmap',
            layout: { visibility: overlay ? 'none' : 'visible' },
        });
    }
    if (!overlay && !fake.map.getLayer('coastal-vignette') && fake.map.getSource('composite')) {
        fake.map.addLayer({
            id: 'coastal-vignette',
            type: 'line',
            source: 'composite',
            'source-layer': 'water',
            paint: { 'line-color': '#000814', 'line-width': 6, 'line-blur': 8, 'line-opacity': 0.6 },
        });
    }
}

/** Every land fill and label exactly as baseLayers() loads it. */
function expectBasemapAsLoaded(fake: MapboxLike) {
    for (const layer of baseLayers()) {
        for (const property of ['fill-color', 'text-opacity', 'text-color', 'text-halo-color']) {
            expect([layer.id, property, fake.paint(layer.id, property)]).toEqual([
                layer.id,
                property,
                layer.paint?.[property],
            ]);
        }
    }
}

/** The standalone chart's basemap is on: charcoal land, ghosted labels. */
function expectGhosted(fake: MapboxLike) {
    for (const id of ['national-park', 'landuse', 'land-structure-polygon', 'building']) {
        expect([id, fake.paint(id, 'fill-color')]).toEqual([id, LAND_GHOST]);
    }
    expect(fake.paint('water', 'fill-color')).toBe('#000000');
    for (const id of [
        'water-point-label',
        'state-label',
        'continent-label',
        'poi-label',
        'enc-vec-soundg',
        'enc-vec-depcnt-derived-label',
        'thalassa-buoyage-direction-arrow',
        'enc-caution-mounts',
    ]) {
        expect([id, fake.paint(id, 'text-opacity')]).toEqual([id, 0.3]);
    }
    // Town names ghost by ink, never by opacity.
    expect(fake.paint('settlement-major-label', 'text-color')).toBe('rgba(255, 255, 255, 0.3)');
    expect(fake.paint('settlement-major-label', 'text-opacity')).toBeUndefined();
}

// The late-layer watch coalesces styledata on a timer: every test drives time.
beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
});

const stubCanvas = () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,');
};

describe('isobar layer setup', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    const buildInitMap = () => {
        const layers: Array<Record<string, unknown>> = [];
        const map = {
            getSource: vi.fn(() => undefined),
            addSource: vi.fn(),
            getLayer: vi.fn(() => undefined),
            addLayer: vi.fn((layer: Record<string, unknown>) => layers.push(layer)),
            hasImage: vi.fn(() => false),
            addImage: vi.fn(),
        };
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
        vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,');
        return { layers, map };
    };

    it('gives major contours and sparse H/L centres visual priority', () => {
        const { layers, map } = buildInitMap();
        initIsobarLayers(map as never);

        const minor = layers.find((layer) => layer.id === 'isobar-lines');
        const major = layers.find((layer) => layer.id === 'isobar-major-lines');
        const labels = layers.find((layer) => layer.id === 'isobar-labels');
        const centers = layers.find((layer) => layer.id === 'isobar-center-labels');

        expect(minor?.filter).toEqual(['all', ['==', ['get', 'isMajor'], false], ['!=', ['get', 'isDetail'], true]]);
        expect(major?.filter).toEqual(['==', ['get', 'isMajor'], true]);
        expect(widthAtZoom5(major?.paint as Record<string, unknown>)).toBeGreaterThan(
            widthAtZoom5(minor?.paint as Record<string, unknown>),
        );
        // EVERY isobar carries its value now, not every second one — the
        // 4 hPa interval is the synoptic standard and labelling only the
        // multiples of 8 made the chart read as an 8 hPa chart (2026-08-21,
        // checked against BOM's live MSLP analysis). The major/minor WEIGHT
        // distinction above stays: heavier line every 8 hPa, value on all.
        expect(labels?.filter).toEqual(['all', ['has', 'label'], ['!=', ['get', 'isDetail'], true]]);
        expect(layers.find((layer) => layer.id === 'isobar-detail-lines')).toMatchObject({
            minzoom: 3,
            filter: ['==', ['get', 'isDetail'], true],
        });
        expect(layers.find((layer) => layer.id === 'isobar-detail-labels')).toMatchObject({ minzoom: 3 });
        expect((centers?.layout as Record<string, boolean>)['text-allow-overlap']).toBe(true);
    });

    it('lays a dark blurred shadow beneath the whole contour stack and badges the centres', () => {
        const { layers, map } = buildInitMap();
        initIsobarLayers(map as never);

        const ids = layers.map((layer) => layer.id);
        // The shadow must be created FIRST so every contour renders above it.
        expect(ids.indexOf('isobar-shadow')).toBeGreaterThanOrEqual(0);
        expect(ids.indexOf('isobar-shadow')).toBeLessThan(ids.indexOf('isobar-lines'));
        expect(ids.indexOf('isobar-shadow')).toBeLessThan(ids.indexOf('isobar-major-lines'));

        const shadow = layers.find((layer) => layer.id === 'isobar-shadow');
        expect((shadow?.paint as Record<string, number>)['line-blur']).toBeGreaterThan(0);

        // H/L centres carry the glass-badge icon, matched per centre type.
        const centers = layers.find((layer) => layer.id === 'isobar-center-labels');
        expect((centers?.layout as Record<string, unknown>)['icon-image']).toEqual([
            'match',
            ['get', 'type'],
            'H',
            'pressure-badge-h',
            'pressure-badge-l',
        ]);
    });

    it('hides the synoptic-only furniture and hands the basemap back in overlay mode', () => {
        stubCanvas();
        const fake = mapboxLike();
        const saved = new Map<string, unknown>();
        weatherPass(fake, saved, ['pressure']);
        fake.frame();
        expect(fake.paint('landuse', 'fill-color')).toBe(LAND_GHOST);

        // Wind on: pressure becomes an overlay.
        weatherPass(fake, saved, ['pressure', 'wind']);

        // Contours and centres visible; heatmap/barbs/arrows stay hidden.
        for (const id of ISOBAR_LAYER_IDS) {
            const synopticOnly = (SYNOPTIC_ONLY_LAYER_IDS as readonly string[]).includes(id);
            // Unset is visible, as mapbox reads it (no write when it is already).
            expect(fake.visibility(id) ?? 'visible').toBe(synopticOnly ? 'none' : 'visible');
        }
        // The vignette is dimmed, never hidden (a hide re-parses the base).
        expect(fake.paint('coastal-vignette', 'line-opacity')).toBe(0);
        expect(fake.visibility('coastal-vignette')).toBeUndefined();

        // The overlay never keeps the charcoal-land treatment: every land fill
        // and label is back to exactly what it was, on this same pass.
        expectBasemapAsLoaded(fake);
    });

    it('keeps the full synoptic treatment when pressure stands alone', () => {
        const visibility = new Map<string, string>();
        const paintWrites = new Map<string, unknown>();
        const map = {
            getLayer: vi.fn((id: string) => ({ id })),
            setLayoutProperty: vi.fn((id: string, _prop: string, value: string) => visibility.set(id, value)),
            setPaintProperty: vi.fn((id: string, prop: string, value: unknown) =>
                paintWrites.set(`${id}:${prop}`, value),
            ),
            isStyleLoaded: vi.fn(() => true),
            getStyle: vi.fn(() => ({
                layers: [
                    { id: 'landcover', type: 'fill' },
                    { id: 'place-city', type: 'symbol' },
                ],
            })),
            getPaintProperty: vi.fn(() => '#123456'),
        };
        const savedLandColors = new Map<string, unknown>();

        showIsobarLayers(map as never, savedLandColors as never, false);

        expect(visibility.get('pressure-heatmap-layer')).toBe('visible');
        expect(visibility.get('wind-barb-layer')).toBe('visible');
        expect(paintWrites.get('landcover:fill-color')).toBe('rgba(20, 20, 20, 0.35)');
        expect(paintWrites.get('place-city:text-opacity')).toBe(0.3);
        expect(savedLandColors.get('landcover')).toBe('#123456');
    });
});

describe('the standalone chart on a map that settles a frame late (mapbox-gl 3.19)', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('ghosts on the very pass that turns pressure on: the first time (layers added) and every time after', () => {
        stubCanvas();
        const fake = mapboxLike();
        const saved = new Map<string, unknown>();
        weatherPass(fake, saved, ['rain']);
        fake.frame();

        weatherPass(fake, saved, ['pressure']);
        // The adds and visibility writes left the style unsettled for this
        // frame, exactly when the treatment has to land. Nothing re-runs the
        // weather effect while pressure stays solo.
        expect(fake.map.isStyleLoaded()).toBe(false);
        expectGhosted(fake);
        fake.frame();

        weatherPass(fake, saved, []);
        fake.frame();
        // Again from off: the only change is visibility none -> visible.
        weatherPass(fake, saved, ['pressure']);
        expect(fake.map.isStyleLoaded()).toBe(false);
        expectGhosted(fake);
        // And from the overlay (wind off, pressure stays).
        fake.frame();
        weatherPass(fake, saved, ['pressure', 'wind']);
        fake.frame();
        weatherPass(fake, saved, ['pressure']);
        expect(fake.map.isStyleLoaded()).toBe(false);
        expectGhosted(fake);
    });

    it('hands every value back on the pass that turns pressure off, and on the pass that adds a host layer', () => {
        stubCanvas();
        const fake = mapboxLike();
        const saved = new Map<string, unknown>();
        // However the ghost got there: here a third solo pass with nothing
        // left to settle (the only pass the pre-fix code ghosted on).
        for (let pass = 0; pass < 3; pass++) {
            weatherPass(fake, saved, ['pressure']);
            fake.frame();
        }
        expectGhosted(fake);

        weatherPass(fake, saved, []);
        expect(fake.map.isStyleLoaded()).toBe(false); // the hides unsettled it
        expectBasemapAsLoaded(fake);
        expect(saved.size).toBe(0);

        fake.frame();
        weatherPass(fake, saved, ['pressure']);
        fake.frame();
        weatherPass(fake, saved, ['pressure', 'wind']);
        expect(fake.map.isStyleLoaded()).toBe(false);
        expectBasemapAsLoaded(fake);
    });

    it('never touches a label or land layer on the weather passes where pressure was never on', () => {
        stubCanvas();
        const fake = mapboxLike();
        const saved = new Map<string, unknown>();
        for (const active of [[], ['rain'], ['wind'], ['rain', 'wind'], []]) {
            weatherPass(fake, saved, active);
            fake.frame();
        }
        expect(fake.map.setPaintProperty).not.toHaveBeenCalled();
        expectBasemapAsLoaded(fake);

        // Nor after a ghost has come and gone: pressure off, then rain passes.
        weatherPass(fake, saved, ['pressure']);
        fake.frame();
        weatherPass(fake, saved, []);
        fake.frame();
        const writes = fake.map.setPaintProperty.mock.calls.length;
        for (let pass = 0; pass < 3; pass++) {
            weatherPass(fake, saved, ['rain']);
            fake.frame();
        }
        expect(fake.map.setPaintProperty.mock.calls.length).toBe(writes);
        expectBasemapAsLoaded(fake);
    });

    it('survives layers coming and going under the ghost, and leaves what their owners wrote since', () => {
        stubCanvas();
        const fake = mapboxLike();
        const saved = new Map<string, unknown>();
        weatherPass(fake, saved, ['pressure']);
        fake.frame();

        // While the chart is up: AIS names arrive (no weather pass runs), the
        // ENC soundings go (cells unloaded), and the derived contour labels
        // are re-added by EncVectorLayer with a fresh value. Pressure goes off
        // inside the late-layer watch's settle time, so its walk never runs:
        // the restore alone has to cope.
        fake.map.addLayer({ id: 'ais-targets-label', type: 'symbol', source: 'ais', paint: { 'text-opacity': 0.9 } });
        fake.map.removeLayer('enc-vec-soundg');
        fake.map.removeLayer('enc-vec-depcnt-derived-label');
        fake.map.addLayer({
            id: 'enc-vec-depcnt-derived-label',
            type: 'symbol',
            source: 'enc-vec-depcnt',
            paint: { 'text-opacity': 0.7 },
        });
        fake.frame();

        expect(() => weatherPass(fake, saved, [])).not.toThrow();
        expect(fake.paint('ais-targets-label', 'text-opacity')).toBe(0.9);
        expect(fake.map.getLayer('enc-vec-soundg')).toBeUndefined();
        expect(fake.paint('enc-vec-depcnt-derived-label', 'text-opacity')).toBe(0.7);
        expect(fake.paint('enc-caution-mounts', 'text-opacity')).toBe(0.9);
        expect(fake.paint('poi-label', 'text-opacity')).toBeUndefined();
        expect(fake.paint('land-structure-polygon', 'fill-color')).toBeUndefined();

        // A later solo pass ghosts a layer added in the meantime, and pressure
        // off hands it back too.
        fake.frame();
        weatherPass(fake, saved, ['pressure']);
        fake.frame();
        weatherPass(fake, saved, ['pressure']);
        expect(fake.paint('ais-targets-label', 'text-opacity')).toBe(0.3);
        fake.frame();
        weatherPass(fake, saved, []);
        expect(fake.paint('ais-targets-label', 'text-opacity')).toBe(0.9);
    });

    it('leaves drawn, rather than re-parse its source, a label or land fill whose value reads feature data', () => {
        stubCanvas();
        const byClass = ['match', ['get', 'class'], 'park', '#1f2a1f', '#333b45'];
        const byState = ['case', ['boolean', ['feature-state', 'hover'], false], 1, 0.8];
        const fake = mapboxLike([
            ...baseLayers(),
            { id: 'landcover', type: 'fill', source: 'composite', paint: { 'fill-color': byClass } },
            { id: 'road-label', type: 'symbol', source: 'composite', paint: { 'text-opacity': byState } },
        ]);
        const saved = new Map<string, unknown>();
        weatherPass(fake, saved, []);
        fake.frame();
        const reloads = fake.reloads.filter((r) => r.startsWith('composite|')).length;
        weatherPass(fake, saved, ['pressure']);
        fake.frame();
        weatherPass(fake, saved, []);
        expect(fake.paint('landcover', 'fill-color')).toEqual(byClass);
        expect(fake.paint('road-label', 'text-opacity')).toEqual(byState);
        // Only the vignette's one add touched the base source.
        expect(fake.reloads.filter((r) => r.startsWith('composite|')).slice(reloads)).toEqual([
            'composite|coastal-vignette',
        ]);
    });

    it('does nothing, and throws nothing, before the style JSON is in', () => {
        const fake = mapboxLike();
        fake.map.getStyle.mockImplementation(() => {
            throw new Error('Style is not done loading');
        });
        const saved = new Map<string, unknown>();
        expect(() => showIsobarLayers(fake.map as never, saved as never, false)).not.toThrow();
        expect(fake.map.setPaintProperty).not.toHaveBeenCalled();
        expect(() => hideIsobarLayers(fake.map as never, saved as never)).not.toThrow();
    });

    it('ghosts the lot once the style JSON arrives, if pressure went solo before it did', () => {
        const fake = mapboxLike();
        fake.map.getStyle.mockImplementationOnce(() => {
            throw new Error('Style is not done loading');
        });
        const saved = new Map<string, unknown>();
        showIsobarLayers(fake.map as never, saved as never, false);
        expect(fake.map.setPaintProperty).not.toHaveBeenCalled();

        // mapbox fires styledata as the style finishes loading.
        fake.emit('styledata');
        vi.advanceTimersByTime(120);
        expectGhosted(fake);

        hideIsobarLayers(fake.map as never, saved as never);
        expectBasemapAsLoaded(fake);
    });
});

describe('layers that mount while the standalone chart is up', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    /** EncVectorLayer's first mount on the zoom into chart cover: labels and soundings at 0.85. */
    const mountEnc = (fake: MapboxLike) => {
        fake.map.addLayer({
            id: 'enc-vec-lights-label',
            type: 'symbol',
            source: 'enc-vec-lights',
            paint: { 'text-opacity': 0.85 },
        });
        fake.map.addLayer({
            id: 'enc-vec-soundg-late',
            type: 'symbol',
            source: 'enc-vec-soundg',
            paint: { 'text-opacity': 0.85 },
        });
        fake.map.addLayer({
            id: 'enc-vec-depare',
            type: 'fill',
            source: 'enc-vec-depare',
            paint: { 'fill-color': '#dde' },
        });
    };

    it('ghosts a label layer that mounts after the toggle pass, once its styledata burst settles, and hands it back at pressure off', () => {
        stubCanvas();
        const fake = mapboxLike();
        const saved = new Map<string, unknown>();
        weatherPass(fake, saved, ['pressure']);
        fake.settle();
        expectGhosted(fake);
        const composite = fake.reloads.filter((r) => r.startsWith('composite|')).length;

        // Nothing re-runs the weather effect while pressure stays solo.
        mountEnc(fake);
        fake.map.addLayer({ id: 'ais-targets-label', type: 'symbol', source: 'ais', paint: { 'text-opacity': 0.9 } });
        fake.frame(); // the burst's styledata
        expect(fake.paint('enc-vec-lights-label', 'text-opacity')).toBe(0.85);
        vi.advanceTimersByTime(119);
        expect(fake.paint('enc-vec-lights-label', 'text-opacity')).toBe(0.85);
        vi.advanceTimersByTime(1);
        expect(fake.paint('enc-vec-lights-label', 'text-opacity')).toBe(0.3);
        expect(fake.paint('enc-vec-soundg-late', 'text-opacity')).toBe(0.3);
        expect(fake.paint('ais-targets-label', 'text-opacity')).toBe(0.3);
        // Not a land fill: the depth area keeps its colour.
        expect(fake.paint('enc-vec-depare', 'fill-color')).toBe('#dde');
        expectGhosted(fake);
        fake.settle();
        expect(fake.reloads.filter((r) => r.startsWith('composite|')).length).toBe(composite);

        weatherPass(fake, saved, []);
        expect(fake.paint('enc-vec-lights-label', 'text-opacity')).toBe(0.85);
        expect(fake.paint('enc-vec-soundg-late', 'text-opacity')).toBe(0.85);
        expect(fake.paint('ais-targets-label', 'text-opacity')).toBe(0.9);
        expectBasemapAsLoaded(fake);
        expect(fake.listenerCount('styledata')).toBe(0);
    });

    it('coalesces styledata: one walk per burst, one per 120 ms at most in a stream, none on a quiet map', () => {
        stubCanvas();
        const fake = mapboxLike();
        const saved = new Map<string, unknown>();
        weatherPass(fake, saved, ['pressure']);
        fake.settle();
        const walks = fake.map.getStyle.mock.calls.length;
        const writes = fake.map.setPaintProperty.mock.calls.length;

        // A burst: tile loads, a setData, a layer add, within the settle time.
        for (let i = 0; i < 6; i++) {
            fake.emit('styledata');
            vi.advanceTimersByTime(20);
        }
        vi.advanceTimersByTime(200);
        expect(fake.map.getStyle.mock.calls.length).toBe(walks + 1);
        // A stream that outlasts it is walked at most once per 120 ms, never per event.
        for (let i = 0; i < 24; i++) {
            fake.emit('styledata');
            vi.advanceTimersByTime(20);
        }
        vi.advanceTimersByTime(200);
        expect(fake.map.getStyle.mock.calls.length).toBe(walks + 1 + 4);
        // Nothing new mounted: nothing written.
        expect(fake.map.setPaintProperty.mock.calls.length).toBe(writes);

        // Nothing mounted in any of it, so nothing was written, and a quiet
        // map is not walked at all.
        expect(fake.map.setPaintProperty.mock.calls.length).toBe(writes);
        fake.settle();
        expect(fake.map.getStyle.mock.calls.length).toBe(walks + 5);
        expect(fake.map.on).toHaveBeenCalledTimes(1);
    });

    it('writes each late layer once: an owner that answers styledata with its own value keeps it, and the loop dies', () => {
        stubCanvas();
        const fake = mapboxLike();
        const saved = new Map<string, unknown>();
        weatherPass(fake, saved, ['pressure']);
        fake.settle();

        // An owner with a MapHub-style conditional re-assert on styledata.
        const reassert = () => {
            if (fake.map.getLayer('route-labels') && fake.paint('route-labels', 'text-opacity') !== 0.8) {
                fake.map.setPaintProperty('route-labels', 'text-opacity', 0.8);
            }
        };
        fake.map.on('styledata', reassert);
        fake.map.addLayer({ id: 'route-labels', type: 'symbol', source: 'route', paint: { 'text-opacity': 0.8 } });
        fake.settle();

        const writes = fake.map.setPaintProperty.mock.calls.filter(([id]) => id === 'route-labels');
        expect(writes).toEqual([
            ['route-labels', 'text-opacity', 0.3], // the watch, once
            ['route-labels', 'text-opacity', 0.8], // the owner, once
        ]);
        // Quiet: another round of frames and timers writes nothing more.
        const all = fake.map.setPaintProperty.mock.calls.length;
        fake.settle();
        expect(fake.map.setPaintProperty.mock.calls.length).toBe(all);

        // The next toggle-pass restore leaves the owner's value alone.
        weatherPass(fake, saved, []);
        expect(fake.paint('route-labels', 'text-opacity')).toBe(0.8);
        expectBasemapAsLoaded(fake);
    });

    it('a layer that goes and mounts again while the chart is up is ghosted again', () => {
        stubCanvas();
        const fake = mapboxLike();
        const saved = new Map<string, unknown>();
        weatherPass(fake, saved, ['pressure']);
        fake.settle();
        expect(fake.paint('enc-vec-soundg', 'text-opacity')).toBe(0.3);

        // Cells unloaded (hasAnyDisplayCells went false), then back on a later pass.
        fake.map.removeLayer('enc-vec-soundg');
        fake.settle();
        fake.map.addLayer({
            id: 'enc-vec-soundg',
            type: 'symbol',
            source: 'enc-vec-soundg',
            paint: { 'text-opacity': 0.85 },
        });
        fake.settle();
        expect(fake.paint('enc-vec-soundg', 'text-opacity')).toBe(0.3);

        weatherPass(fake, saved, []);
        expect(fake.paint('enc-vec-soundg', 'text-opacity')).toBe(0.85);
    });

    it('is taken down when the chart becomes an overlay, and when pressure goes off', () => {
        stubCanvas();
        const fake = mapboxLike();
        const saved = new Map<string, unknown>();
        weatherPass(fake, saved, ['pressure']);
        fake.settle();
        expect(fake.listenerCount('styledata')).toBe(1);

        weatherPass(fake, saved, ['pressure', 'wind']);
        expect(fake.listenerCount('styledata')).toBe(0);
        mountEnc(fake);
        fake.settle();
        expect(fake.paint('enc-vec-lights-label', 'text-opacity')).toBe(0.85);
        expectBasemapAsLoaded(fake);

        // Solo again (the toggle pass ghosts what is there), then off with a
        // walk pending: the pending walk never runs.
        weatherPass(fake, saved, ['pressure']);
        expect(fake.listenerCount('styledata')).toBe(1);
        expect(fake.paint('enc-vec-lights-label', 'text-opacity')).toBe(0.3);
        fake.map.addLayer({ id: 'ais-targets-label', type: 'symbol', source: 'ais', paint: { 'text-opacity': 0.9 } });
        fake.frame();
        weatherPass(fake, saved, []);
        expect(fake.listenerCount('styledata')).toBe(0);
        fake.settle();
        expect(fake.paint('ais-targets-label', 'text-opacity')).toBe(0.9);
        expect(fake.paint('enc-vec-lights-label', 'text-opacity')).toBe(0.85);
        expectBasemapAsLoaded(fake);

        // Repeated solo passes keep ONE listener.
        weatherPass(fake, saved, ['pressure']);
        weatherPass(fake, saved, ['pressure']);
        expect(fake.listenerCount('styledata')).toBe(1);
    });
});

describe('visibility writes only when they change something', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('a pressure-off pass on an already hidden chart makes no layout call at all, nor a repeat solo pass', () => {
        stubCanvas();
        const fake = mapboxLike();
        const saved = new Map<string, unknown>();
        weatherPass(fake, saved, ['pressure']);
        fake.settle();
        const calls = () => fake.map.setLayoutProperty.mock.calls.length;

        let before = calls();
        weatherPass(fake, saved, ['pressure']);
        expect(calls()).toBe(before);

        weatherPass(fake, saved, []);
        fake.settle();
        // The pass that turns it off hides what was showing: the contours,
        // barbs, arrows and wash (movement tracks were never shown).
        expect(
            fake.map.setLayoutProperty.mock.calls
                .slice(before)
                .map(([id]) => id)
                .sort(),
        ).toEqual(ISOBAR_LAYER_IDS.filter((id) => fake.map.getLayer(id)).sort());

        before = calls();
        for (const active of [[], ['rain'], ['wind'], []]) {
            weatherPass(fake, saved, active);
            fake.settle();
        }
        expect(calls()).toBe(before);
        for (const id of ISOBAR_LAYER_IDS) {
            if (fake.map.getLayer(id)) expect([id, fake.visibility(id)]).toEqual([id, 'none']);
        }
    });
});

describe('the coastal vignette never re-parses the base map', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('after its one add, only its opacity changes: 0.6 solo, 0 as an overlay and off', () => {
        stubCanvas();
        const fake = mapboxLike();
        const saved = new Map<string, unknown>();
        const composite = () => fake.reloads.filter((r) => r.startsWith('composite|'));
        weatherPass(fake, saved, []);
        fake.frame();
        expect(composite()).toEqual([]);

        weatherPass(fake, saved, ['pressure']);
        fake.frame();
        expect(composite()).toEqual(['composite|coastal-vignette']); // the caller's addLayer, once
        expect(fake.paint('coastal-vignette', 'line-opacity')).toBe(0.6);

        const toggles: Array<[string[], number]> = [
            [['pressure', 'wind'], 0],
            [['pressure'], 0.6],
            [[], 0],
            [['rain'], 0],
            [['pressure'], 0.6],
            [['pressure', 'rain'], 0],
            [['pressure'], 0.6],
            [[], 0],
        ];
        for (const [active, opacity] of toggles) {
            weatherPass(fake, saved, active);
            fake.frame();
            expect([active, composite()]).toEqual([active, ['composite|coastal-vignette']]);
            expect([active, fake.paint('coastal-vignette', 'line-opacity')]).toEqual([active, opacity]);
        }
        // No visibility write on it, and no other base re-parse, in any of it:
        // the ghost's own writes are all constant to constant.
        expect(fake.map.setLayoutProperty.mock.calls.filter(([id]) => id === 'coastal-vignette')).toEqual([]);
        expect(fake.visibility('coastal-vignette')).toBeUndefined();
        expect(composite()).toEqual(['composite|coastal-vignette']);
        expect(ISOBAR_LAYER_IDS as readonly string[]).not.toContain('coastal-vignette');
        expect(SYNOPTIC_ONLY_LAYER_IDS as readonly string[]).not.toContain('coastal-vignette');
    });
});
