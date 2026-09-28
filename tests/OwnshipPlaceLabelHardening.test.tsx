/**
 * The own-ship place-label fade, hardened (batch 12 verify, four reviewers).
 *
 * At a Gladstone berth the base style's 'Gladstone' printed through the
 * own-ship dot and its chip ("Gla◯to Stopped"). useVesselTracker fades that
 * ONE settlement label with a feature-state switch inside the base place
 * layers' opacity. The reviewers found the ways it still failed or cost too
 * much; each is pinned here against a fake map that behaves like mapbox-gl
 * 3.19 where it matters:
 *
 *  - an unchanged paint value is a no-op, and a change to or from a
 *    feature-state value is a full base-source re-parse ("relayout");
 *  - queryRenderedFeatures returns the placed labels whose boxes touch the
 *    query box, on visible layers only;
 *  - 'idle' and 'moveend' are real listener sets, isMoving() is settable.
 */
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    armOwnshipPlaceLabels,
    isBasePlaceLabelLayer,
    isSettlementPlaceFeature,
    ownshipChipSignature,
    ownshipPlaceLabelWasReset,
    syncOwnshipPlaceLabel,
    useVesselTracker,
    withOwnshipLabelFade,
} from '../components/map/useVesselTracker';
import { hideIsobarLayers, showIsobarLayers } from '../components/map/isobarLayerSetup';
import { readsOwnshipFade } from '../components/map/ownshipLabelFade';

const mocks = vi.hoisted(() => ({
    markers: [] as Array<{ element: HTMLElement; lngLat: [number, number] | null }>,
    gpsCallbacks: [] as Array<(pos: Record<string, unknown>) => void>,
    /** What Marker.setLngLat smart-wraps a fix to (identity unless a test says otherwise). */
    wrap: (lngLat: [number, number]): [number, number] => lngLat,
    anchorState: 'idle',
    logger: { info: () => {}, warn: () => {}, error: () => {} },
}));

vi.mock('mapbox-gl', () => {
    class Marker {
        element: HTMLElement;
        lngLat: [number, number] | null = null;
        constructor(opts: { element: HTMLElement }) {
            this.element = opts.element;
            mocks.markers.push(this);
        }
        setLngLat(lngLat: [number, number]) {
            this.lngLat = mocks.wrap(lngLat);
            return this;
        }
        getLngLat() {
            return this.lngLat ? { lng: this.lngLat[0], lat: this.lngLat[1] } : null;
        }
        addTo() {
            return this;
        }
        remove() {}
    }
    return { default: { Marker }, Marker };
});
vi.mock('../services/GpsService', () => ({
    GpsService: {
        watchPosition: (cb: (pos: Record<string, unknown>) => void) => {
            mocks.gpsCallbacks.push(cb);
            return () => {};
        },
        getCurrentPosition: vi.fn(),
    },
}));
vi.mock('../services/BgGeoManager', () => ({ BgGeoManager: { getLastPosition: () => null } }));
vi.mock('../services/AnchorWatchService', () => ({
    AnchorWatchService: {
        getSnapshot: () => ({ state: mocks.anchorState, gpsSource: 'native' }),
        subscribe: (callback: () => void) => {
            callback();
            return () => {};
        },
    },
}));
vi.mock('../services/AnchorWatchSyncService', () => ({
    AnchorWatchSyncService: {
        getState: () => ({ role: 'vessel', sessionCode: null }),
        onStateChange: () => () => {},
    },
}));
vi.mock('../services/ShoreWatchAlarmService', () => ({
    ShoreWatchAlarmService: {
        getSnapshot: () => ({ sessionCode: null, position: null, stale: true, cause: null }),
        subscribe: () => () => {},
    },
}));
vi.mock('../services/NmeaGpsProvider', () => ({ NmeaGpsProvider: { onPosition: () => () => {}, start: vi.fn() } }));
vi.mock('../services/NmeaListenerService', () => ({ NmeaListenerService: { getSavedConfig: () => null } }));
vi.mock('../services/NmeaStore', () => ({
    NmeaStore: { getState: () => ({}), start: vi.fn(), subscribe: () => () => {} },
}));
vi.mock('../utils/createLogger', () => ({ createLogger: () => mocks.logger }));

const T0 = new Date('2026-09-28T00:00:00Z').getTime();
const STATE = 'thalassaOwnshipHidden';
const SETTLEMENT_LAYERS = ['settlement-subdivision-label', 'settlement-minor-label', 'settlement-major-label'];

type Box = { left: number; top: number; right: number; bottom: number };
interface PlacedLabel {
    id: number;
    layer: string;
    name: string;
    properties?: Record<string, unknown>;
    /** Anchor, lon/lat. */
    at: [number, number];
    /** Placed glyph box, map pixels. */
    box: Box;
}

const touches = (a: Box, b: Box) => a.left <= b.right && a.right >= b.left && a.top <= b.bottom && a.bottom >= b.top;
/** Data-driven, as far as these layers go: reads feature state or a feature property. */
const dataDriven = (value: unknown) => /"feature-state"|"get"/.test(JSON.stringify(value ?? null));

/**
 * dark-v11's three settlement layers (their real starting opacities, read off
 * the live style), a POI layer and an ENC label, on a map whose projection is
 * x = lng * 10, y = lat * 10.
 */
function labelMap() {
    const styleLayers: Array<Record<string, unknown> & { id: string }> = [
        ...SETTLEMENT_LAYERS.map((id) => ({ id, type: 'symbol', source: 'composite', 'source-layer': 'place_label' })),
        { id: 'poi-label', type: 'symbol', source: 'composite', 'source-layer': 'poi_label' },
        { id: 'enc-vec-lndare-label', type: 'symbol', source: 'enc-vec-points' },
    ];
    const appLayers = new Map<string, { id: string }>();
    const sources = new Map<string, { setData: ReturnType<typeof vi.fn> }>();
    const paint = new Map<string, unknown>([
        ['settlement-minor-label|icon-opacity', ['step', ['zoom'], 1, 8, 0]],
        ['settlement-major-label|icon-opacity', ['step', ['zoom'], 1, 8, 0]],
        // useMapInit's load pass inks every label layer white on a dark halo
        // (read off the live style: plain constants, text-field unformatted).
        ...[...SETTLEMENT_LAYERS, 'poi-label'].flatMap(
            (id): Array<[string, unknown]> => [
                [`${id}|text-color`, '#ffffff'],
                [`${id}|text-halo-color`, 'rgba(0, 0, 0, 0.9)'],
            ],
        ),
    ]);
    const layout = new Map<string, unknown>();
    const state = new Map<string, Record<string, unknown>>();
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    const placed: PlacedLabel[] = [];
    /**
     * Every paint change that makes mapbox re-parse the whole composite
     * source: to or from a data-driven value, or a text-color change on a
     * layer whose text-field can override it per section (hasPaintOverride).
     */
    const relayouts: string[] = [];
    /** Every paint write that actually changed a value (mapbox drops the rest). */
    const changes: string[] = [];
    const sim = { moving: false, zoom: 10, tilesLoaded: true };
    const stateKey = (t: { source: string; sourceLayer?: string; id: string | number }) =>
        `${t.source}|${t.sourceLayer ?? ''}|${t.id}`;
    const visible = (id: string) => (layout.get(`${id}|visibility`) ?? 'visible') !== 'none';

    const map = {
        getStyle: vi.fn(() => ({ layers: [...styleLayers, ...appLayers.values()] })),
        getLayer: (id: string) => styleLayers.find((layer) => layer.id === id) ?? appLayers.get(id),
        addLayer: vi.fn((layer: { id: string }) => {
            appLayers.set(layer.id, layer);
        }),
        removeLayer: (id: string) => {
            appLayers.delete(id);
        },
        getSource: (id: string) => (id === 'composite' ? {} : sources.get(id)),
        addSource: vi.fn((id: string) => {
            sources.set(id, { setData: vi.fn() });
        }),
        removeSource: (id: string) => {
            sources.delete(id);
        },
        addImage: vi.fn(),
        hasImage: () => false,
        getPaintProperty: (id: string, property: string) => paint.get(`${id}|${property}`),
        setPaintProperty: vi.fn((id: string, property: string, value: unknown) => {
            const key = `${id}|${property}`;
            const old = paint.get(key);
            // Style.setPaintProperty: deep-equal returns early.
            if (JSON.stringify(old ?? null) === JSON.stringify(value ?? null)) return;
            const overridable =
                property === 'text-color' &&
                JSON.stringify(layout.get(`${id}|text-field`) ?? null).includes('text-color');
            if (dataDriven(old) || dataDriven(value) || overridable) relayouts.push(key);
            changes.push(key);
            paint.set(key, value);
        }),
        getLayoutProperty: (id: string, property: string) => layout.get(`${id}|${property}`),
        setLayoutProperty: vi.fn((id: string, property: string, value: unknown) => {
            layout.set(`${id}|${property}`, value);
        }),
        isStyleLoaded: () => true,
        isSourceLoaded: () => sim.tilesLoaded,
        isMoving: () => sim.moving,
        getZoom: () => sim.zoom,
        project: ([lng, lat]: [number, number]) => ({ x: lng * 10, y: lat * 10 }),
        queryRenderedFeatures: vi.fn((box: [[number, number], [number, number]], options: { layers: string[] }) => {
            const query = { left: box[0][0], top: box[0][1], right: box[1][0], bottom: box[1][1] };
            return placed
                .filter((label) => options.layers.includes(label.layer) && visible(label.layer))
                .filter((label) => touches(label.box, query))
                .map((label) => ({
                    id: label.id,
                    source: 'composite',
                    sourceLayer: 'place_label',
                    layer: { id: label.layer },
                    properties: label.properties ?? { class: 'settlement', type: 'city', name: label.name },
                    geometry: { type: 'Point', coordinates: label.at },
                }));
        }),
        setFeatureState: vi.fn((target: { source: string; sourceLayer?: string; id: number }, value: object) => {
            state.set(stateKey(target), { ...state.get(stateKey(target)), ...value });
        }),
        removeFeatureState: vi.fn((target: { source: string; sourceLayer?: string; id: number }) => {
            state.delete(stateKey(target));
        }),
        getFeatureState: (target: { source: string; sourceLayer?: string; id: number }) =>
            state.get(stateKey(target)) ?? {},
        on: (type: string, fn: (...args: unknown[]) => void) => {
            if (!listeners.has(type)) listeners.set(type, new Set());
            listeners.get(type)!.add(fn);
        },
        once: vi.fn((type: string, fn: (...args: unknown[]) => void) => {
            // Map.off(type, fn) must find it, as mapbox's _oneTimeListeners does.
            const wrapped = Object.assign(
                (...args: unknown[]) => {
                    listeners.get(type)?.delete(wrapped);
                    fn(...args);
                },
                { original: fn },
            );
            if (!listeners.has(type)) listeners.set(type, new Set());
            listeners.get(type)!.add(wrapped);
        }),
        off: (type: string, fn: (...args: unknown[]) => void) => {
            for (const l of [...(listeners.get(type) ?? [])]) {
                if (l === fn || (l as { original?: unknown }).original === fn) listeners.get(type)!.delete(l);
            }
        },
        flyTo: vi.fn(),
    };
    const fire = (type: string) => {
        for (const fn of [...(listeners.get(type) ?? [])]) fn({ type });
    };
    const hidden = (id: number) => state.get(`composite|place_label|${id}`)?.[STATE] === true;
    return { map, asMap: map as never, placed, relayouts, changes, sim, layout, paint, listeners, fire, hidden };
}

type LabelMap = ReturnType<typeof labelMap>;

/** 'Gladstone', drawn right under the dot and the badge at the fix (50, 50). */
const GLADSTONE: PlacedLabel = {
    id: 2478073150,
    layer: 'settlement-minor-label',
    name: 'Gladstone',
    at: [50.5, 50],
    box: { left: 480, top: 494, right: 560, bottom: 508 },
};

// jsdom lays nothing out. The marker is centred on (0, 0) in client pixels,
// so the chip rects measured against it are their offsets from the dot.
function stubLayout() {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
        const rect = (left: number, top: number, width: number, height: number) =>
            ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top }) as DOMRect;
        if (this.classList.contains('vessel-tracker-marker')) return rect(-24, -24, 48, 48);
        if (this.classList.contains('vessel-sog-badge')) return rect(18, -9, 7 * (this.textContent?.length ?? 0), 18);
        if (this.classList.contains('vessel-age-chip')) {
            return this.style.display === 'none' ? rect(0, 0, 0, 0) : rect(-40, -36, 80, 22);
        }
        return rect(0, 0, 0, 0);
    });
}

function mount(fake: LabelMap = labelMap(), initial: { mapReady?: boolean; visible?: boolean } = {}) {
    const mapRef = { current: fake.map as never };
    const view = renderHook(
        ({ mapReady, visible }: { mapReady: boolean; visible: boolean }) => useVesselTracker(mapRef, mapReady, visible),
        { initialProps: { mapReady: initial.mapReady ?? true, visible: initial.visible ?? true } },
    );
    const fix = (lng = 50, lat = 50, over: Record<string, unknown> = {}) =>
        act(() => {
            mocks.gpsCallbacks.at(-1)?.({
                latitude: lat,
                longitude: lng,
                accuracy: 5,
                altitude: null,
                heading: null,
                speed: 0,
                timestamp: Date.now(),
                ...over,
            });
        });
    const tick = (ms: number) =>
        act(() => {
            vi.advanceTimersByTime(ms);
        });
    const fire = (type: string) => act(() => fake.fire(type));
    /** A pan: moving, then settled, then the map goes idle. */
    const pan = () => {
        fake.sim.moving = true;
        tick(200);
        fake.sim.moving = false;
        fire('moveend');
        fire('idle');
    };
    const element = () => mocks.markers.at(-1)!.element;
    return {
        ...fake,
        view,
        fix,
        tick,
        fire,
        pan,
        element,
        queries: () => fake.map.queryRenderedFeatures.mock.calls.length,
    };
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    mocks.markers.length = 0;
    mocks.gpsCallbacks.length = 0;
    mocks.wrap = (lngLat) => lngLat;
    mocks.anchorState = 'idle';
    stubLayout();
});

afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('arming: the one feature-state switch happens at load, never mid-session', () => {
    it('arms every settlement layer when the tracker mounts, before any fix or fade', () => {
        const t = mount();
        // No fix yet, nothing faded: the layers are armed anyway.
        expect(t.map.setPaintProperty).toHaveBeenCalledTimes(6);
        for (const id of SETTLEMENT_LAYERS) {
            expect(readsOwnshipFade(t.paint.get(`${id}|text-opacity`))).toBe(true);
            expect(readsOwnshipFade(t.paint.get(`${id}|icon-opacity`))).toBe(true);
        }
        // Never the POI or an ENC label.
        expect(t.paint.get('poi-label|text-opacity')).toBeUndefined();
        expect(t.paint.get('enc-vec-lndare-label|text-opacity')).toBeUndefined();
        // The zoom curve on the icon keeps its zoom at the top.
        expect(t.paint.get('settlement-minor-label|icon-opacity')).toEqual(
            withOwnshipLabelFade(['step', ['zoom'], 1, 8, 0]),
        );
    });

    it('then fades, pans six times and restores with no further paint writes at all', () => {
        const t = mount();
        t.placed.push(GLADSTONE);
        t.fix();
        expect(t.hidden(GLADSTONE.id)).toBe(true);
        const writes = t.map.setPaintProperty.mock.calls.length;
        const relayouts = t.relayouts.length;
        for (let i = 0; i < 6; i++) t.pan();
        expect(t.map.setPaintProperty.mock.calls.length).toBe(writes);
        expect(t.relayouts.length).toBe(relayouts);
        // Zoomed far out the name is elsewhere: released, still no paint write.
        t.sim.zoom = 4;
        t.placed.length = 0;
        t.pan();
        expect(t.hidden(GLADSTONE.id)).toBe(false);
        expect(t.map.setPaintProperty.mock.calls.length).toBe(writes);
        // And nothing was ever flattened back to a constant.
        for (const id of SETTLEMENT_LAYERS) expect(readsOwnshipFade(t.paint.get(`${id}|text-opacity`))).toBe(true);
    });

    it('arms on the next tick when the style was still loading at mount', () => {
        const fake = labelMap();
        const real = fake.map.setPaintProperty.getMockImplementation()!;
        let loading = true;
        fake.map.setPaintProperty.mockImplementation((id: string, property: string, value: unknown) => {
            if (loading) throw new Error('Style is not done loading');
            real(id, property, value);
        });
        const t = mount(fake);
        expect(readsOwnshipFade(t.paint.get('settlement-major-label|text-opacity'))).toBe(false);
        loading = false;
        t.fix();
        t.tick(1000);
        expect(readsOwnshipFade(t.paint.get('settlement-major-label|text-opacity'))).toBe(true);
    });

    it('is idempotent: a second arm writes nothing', () => {
        const fake = labelMap();
        expect(armOwnshipPlaceLabels(fake.asMap)).toBe(true);
        const calls = fake.map.setPaintProperty.mock.calls.length;
        expect(armOwnshipPlaceLabels(fake.asMap)).toBe(true);
        expect(fake.map.setPaintProperty.mock.calls.length).toBe(calls);
    });

    it('arms at load with own-ship hidden (off, or the Plan page up), so showing it later costs no re-parse', () => {
        const t = mount(labelMap(), { visible: false });
        for (const id of SETTLEMENT_LAYERS) expect(readsOwnshipFade(t.paint.get(`${id}|text-opacity`))).toBe(true);
        const relayouts = t.relayouts.length;
        expect(relayouts).toBe(SETTLEMENT_LAYERS.length * 2); // text + icon, once each

        // The skipper goes to the chart: own-ship shows, and Gladstone fades
        // with one feature's state, no paint change at all.
        t.view.rerender({ mapReady: true, visible: true });
        t.placed.push(GLADSTONE);
        t.fix();
        t.fire('idle');
        expect(t.hidden(GLADSTONE.id)).toBe(true);
        expect(t.relayouts.length).toBe(relayouts);

        // Hidden again and shown again: still nothing.
        t.view.rerender({ mapReady: true, visible: false });
        t.view.rerender({ mapReady: true, visible: true });
        expect(t.relayouts.length).toBe(relayouts);
    });

    it('does not touch the style before the map is ready', () => {
        const t = mount(labelMap(), { mapReady: false, visible: false });
        expect(t.map.setPaintProperty).not.toHaveBeenCalled();
        t.view.rerender({ mapReady: true, visible: false });
        for (const id of SETTLEMENT_LAYERS) expect(readsOwnshipFade(t.paint.get(`${id}|text-opacity`))).toBe(true);
    });
});

describe('the isobar basemap pass keeps the fade and costs nothing when unchanged', () => {
    const otherSymbolWrites = (t: LabelMap, value: number) =>
        t.map.setPaintProperty.mock.calls.filter(
            ([id, property, v]) => !SETTLEMENT_LAYERS.includes(id) && property === 'text-opacity' && v === value,
        ).length;

    it('hideIsobarLayers (every weather pass with pressure off) leaves the faded Gladstone faded, with no write', () => {
        const t = mount();
        t.placed.push(GLADSTONE);
        t.fix();
        expect(t.hidden(GLADSTONE.id)).toBe(true);
        const settlementWrites = () =>
            t.map.setPaintProperty.mock.calls.filter(([id]) => SETTLEMENT_LAYERS.includes(id)).length;
        const before = settlementWrites();
        const relayouts = t.relayouts.length;

        for (let pass = 0; pass < 3; pass++) hideIsobarLayers(t.map as never, new Map());

        expect(settlementWrites()).toBe(before);
        expect(t.relayouts.length).toBe(relayouts);
        expect(ownshipPlaceLabelWasReset(t.asMap)).toBe(false);
        for (const id of SETTLEMENT_LAYERS) {
            expect(JSON.stringify(t.paint.get(`${id}|text-opacity`))).toContain(STATE);
        }
        // Every other symbol layer still gets exactly its 1.0, every pass.
        expect(t.paint.get('poi-label|text-opacity')).toBe(1.0);
        expect(t.paint.get('enc-vec-lndare-label|text-opacity')).toBe(1.0);
        expect(otherSymbolWrites(t, 1.0)).toBe(6);
    });

    const GHOST_INK = 'rgba(255, 255, 255, 0.3)';
    const GHOST_HALO = 'rgba(0, 0, 0, 0.27)';
    const settlementChanges = (t: LabelMap) => t.changes.filter((key) => SETTLEMENT_LAYERS.includes(key.split('|')[0]));

    it('the standalone chart ghosts town names by ink: zero re-parses across solo, overlay and off', () => {
        const t = mount();
        t.placed.push(GLADSTONE);
        t.fix();
        expect(t.hidden(GLADSTONE.id)).toBe(true);
        const armed = SETTLEMENT_LAYERS.map((id) => t.paint.get(`${id}|text-opacity`));
        expect(armed[0]).toEqual(withOwnshipLabelFade(1));
        const relayouts = t.relayouts.length;
        const saved = new Map();
        const expectArmedOpacity = () =>
            SETTLEMENT_LAYERS.forEach((id, i) => expect(t.paint.get(`${id}|text-opacity`)).toEqual(armed[i]));
        const expectInk = (color: string, halo: string) =>
            SETTLEMENT_LAYERS.forEach((id) => {
                expect(t.paint.get(`${id}|text-color`)).toBe(color);
                expect(t.paint.get(`${id}|text-halo-color`)).toBe(halo);
            });

        // Pressure alone: the synoptic chart. Town names ghost to 30% by their
        // ink; their opacity (and the fade in it) is never written.
        showIsobarLayers(t.map as never, saved, false);
        expectInk(GHOST_INK, GHOST_HALO);
        expectArmedOpacity();
        expect(t.paint.get('poi-label|text-opacity')).toBe(0.3);
        // Every later pass of the weather effect changes nothing at all.
        const changesInSolo = settlementChanges(t).length;
        showIsobarLayers(t.map as never, saved, false);
        showIsobarLayers(t.map as never, saved, false);
        expect(settlementChanges(t).length).toBe(changesInSolo);

        // Wind on: pressure becomes an overlay and the basemap is handed back.
        showIsobarLayers(t.map as never, saved, true);
        expectInk('#ffffff', 'rgba(0, 0, 0, 0.9)');
        expectArmedOpacity();
        // Wind off: solo again. Pressure off: all back.
        showIsobarLayers(t.map as never, saved, false);
        expectInk(GHOST_INK, GHOST_HALO);
        hideIsobarLayers(t.map as never, saved);
        expectInk('#ffffff', 'rgba(0, 0, 0, 0.9)');
        expectArmedOpacity();
        expect(t.paint.get('poi-label|text-opacity')).toBe(1.0);

        // Not one composite re-parse in any of it, and Gladstone stayed faded.
        expect(t.relayouts.length).toBe(relayouts);
        expect(t.hidden(GLADSTONE.id)).toBe(true);
        expect(ownshipPlaceLabelWasReset(t.asMap)).toBe(false);
    });

    it('an unarmed town layer (own-ship off) is ghosted the same way, so a later arm never wraps the ghost', () => {
        const fake = labelMap();
        hideIsobarLayers(fake.map as never, new Map());
        expect(fake.paint.get('settlement-major-label|text-opacity')).toBe(1.0);
        showIsobarLayers(fake.map as never, new Map(), false);
        expect(fake.paint.get('settlement-major-label|text-opacity')).toBe(1.0);
        expect(fake.paint.get('settlement-major-label|text-color')).toBe(GHOST_INK);
        expect(fake.paint.get('poi-label|text-opacity')).toBe(0.3);
        expect(fake.relayouts).toEqual([]);

        // The tracker arms while the synoptic chart is up: it wraps 1, not 0.3.
        armOwnshipPlaceLabels(fake.asMap);
        expect(fake.paint.get('settlement-major-label|text-opacity')).toEqual(withOwnshipLabelFade(1));
        const afterArm = fake.relayouts.length;
        hideIsobarLayers(fake.map as never, new Map());
        expect(fake.paint.get('settlement-major-label|text-color')).toBe('#ffffff');
        expect(fake.relayouts.length).toBe(afterArm);
    });

    it('an armed layer an older pass left at fade(0.3) is handed back to fade(1), and ghosted once, not twice', () => {
        const fake = labelMap();
        fake.paint.set('settlement-minor-label|text-opacity', withOwnshipLabelFade(0.3));
        showIsobarLayers(fake.map as never, new Map(), false);
        expect(fake.paint.get('settlement-minor-label|text-opacity')).toEqual(withOwnshipLabelFade(1));
        expect(fake.paint.get('settlement-minor-label|text-color')).toBe(GHOST_INK);
        expect(fake.relayouts).toEqual(['settlement-minor-label|text-opacity']);
    });

    it('scales hsl and short-hex ink too, and puts back exactly what was there', () => {
        const fake = labelMap();
        fake.paint.set('settlement-subdivision-label|text-color', 'hsl(0, 0%, 100%)');
        fake.paint.set('settlement-subdivision-label|text-halo-color', '#000c');
        fake.paint.delete('settlement-major-label|text-halo-color'); // unset: the spec's transparent halo
        showIsobarLayers(fake.map as never, new Map(), false);
        expect(fake.paint.get('settlement-subdivision-label|text-color')).toBe(GHOST_INK);
        expect(fake.paint.get('settlement-subdivision-label|text-halo-color')).toBe('rgba(0, 0, 0, 0.24)');
        expect(fake.paint.get('settlement-major-label|text-halo-color')).toBe('rgba(0, 0, 0, 0)');
        hideIsobarLayers(fake.map as never, new Map());
        expect(fake.paint.get('settlement-subdivision-label|text-color')).toBe('hsl(0, 0%, 100%)');
        expect(fake.paint.get('settlement-subdivision-label|text-halo-color')).toBe('#000c');
        expect(fake.paint.get('settlement-major-label|text-halo-color')).toBeUndefined();
        expect(fake.relayouts).toEqual([]);
    });

    it('leaves a town layer drawn rather than re-parse: ink that is an expression, or a text-field that overrides text-color', () => {
        const fake = labelMap();
        armOwnshipPlaceLabels(fake.asMap);
        const relayouts = fake.relayouts.length;
        const byClass = ['match', ['get', 'class'], 'settlement', '#ffffff', '#cccccc'];
        fake.paint.set('settlement-minor-label|text-color', byClass);
        fake.layout.set('settlement-major-label|text-field', ['format', ['get', 'name'], { 'text-color': '#ff0000' }]);

        showIsobarLayers(fake.map as never, new Map(), false);
        expect(fake.paint.get('settlement-minor-label|text-color')).toEqual(byClass);
        expect(fake.paint.get('settlement-minor-label|text-halo-color')).toBe('rgba(0, 0, 0, 0.9)');
        expect(fake.paint.get('settlement-major-label|text-color')).toBe('#ffffff');
        expect(fake.paint.get('settlement-major-label|text-halo-color')).toBe('rgba(0, 0, 0, 0.9)');
        // The plain one still ghosts.
        expect(fake.paint.get('settlement-subdivision-label|text-color')).toBe(GHOST_INK);
        hideIsobarLayers(fake.map as never, new Map());
        expect(fake.relayouts.length).toBe(relayouts);
    });
});

describe('the settle look', () => {
    it("the 1.5 s fallback looks without cancelling the pending 'idle' look, and keeps ONE idle listener", () => {
        const t = mount();
        t.fix();
        t.fire('idle'); // the first-fix settle
        const idle = () => t.listeners.get('idle')?.size ?? 0;
        expect(idle()).toBe(0);

        // Three pans in a row with an animated layer on: 'idle' never comes.
        for (let i = 0; i < 3; i++) t.fire('moveend');
        expect(idle()).toBe(1);
        const before = t.queries();
        t.tick(1500);
        expect(t.queries()).toBeGreaterThan(before); // the provisional look
        expect(idle()).toBe(1); // ...and the idle look still waits

        // 'Gladstone' is placed only after that look: idle finds it.
        t.placed.push(GLADSTONE);
        t.fire('idle');
        expect(t.hidden(GLADSTONE.id)).toBe(true);
        expect(idle()).toBe(0);
    });

    it('measures 1.5 s from the LAST settle, not the first', () => {
        const t = mount();
        t.fix();
        t.fire('idle');
        t.fire('moveend');
        t.tick(1000);
        t.fire('moveend');
        const before = t.queries();
        t.tick(1000);
        expect(t.queries()).toBe(before);
        t.tick(500);
        expect(t.queries()).toBeGreaterThan(before);
    });

    it('the fallback never looks mid-gesture; the next moveend does', () => {
        const t = mount();
        t.fix();
        t.fire('idle');
        t.fire('moveend');
        t.sim.moving = true; // the next pan started within 1.5 s
        const before = t.queries();
        t.tick(1500);
        t.tick(1000);
        expect(t.queries()).toBe(before);
        t.sim.moving = false;
        t.fire('moveend');
        t.tick(1500);
        expect(t.queries()).toBeGreaterThan(before);
    });

    it('looks once more when the base label tiles arrive after a provisional look', () => {
        const t = mount();
        t.fix();
        t.fire('idle');
        t.sim.tilesLoaded = false;
        t.fire('moveend');
        t.tick(1500); // provisional look: nothing placed yet
        expect(t.hidden(GLADSTONE.id)).toBe(false);
        t.tick(1000);
        t.placed.push(GLADSTONE);
        t.sim.tilesLoaded = true;
        t.tick(1000);
        expect(t.hidden(GLADSTONE.id)).toBe(true);
    });

    it('re-fades a label whose state was dropped on a static map that never idles again', () => {
        const t = mount();
        t.placed.push(GLADSTONE);
        t.fix();
        t.fire('idle'); // the first-fix settle; the map is static from here
        expect(t.hidden(GLADSTONE.id)).toBe(true);

        // Something drops the state (a style swap, say). No 'idle' will come:
        // the 1 s ticker notices every second, and must not keep pushing the
        // 1.5 s fallback back.
        act(() => t.map.removeFeatureState({ source: 'composite', sourceLayer: 'place_label', id: GLADSTONE.id }));
        expect(ownshipPlaceLabelWasReset(t.asMap)).toBe(true);
        t.tick(3000);
        expect(t.hidden(GLADSTONE.id)).toBe(true);
        expect(ownshipPlaceLabelWasReset(t.asMap)).toBe(false);

        // And then it rests: ten quiet seconds write no state and look no more.
        const sets = t.map.setFeatureState.mock.calls.length;
        const queries = t.queries();
        t.tick(10_000);
        expect(t.map.setFeatureState.mock.calls.length).toBe(sets);
        expect(t.queries()).toBe(queries);
    });
});

describe('what own-ship covers', () => {
    // 'Gladstone' ~30 px above the fix: clear of the dot and the badge, under
    // the age chip only.
    const ABOVE: PlacedLabel = { ...GLADSTONE, at: [50, 47], box: { left: 470, top: 462, right: 530, bottom: 478 } };

    it('re-looks when the age chip appears over a town, though the badge still says Anchored', () => {
        mocks.anchorState = 'watching';
        const t = mount();
        t.placed.push(ABOVE);
        t.fix();
        t.fire('idle');
        expect(t.element().querySelector('.vessel-sog-badge')!.textContent).toBe('Anchored');
        expect(t.hidden(ABOVE.id)).toBe(false);

        // Fixes stop. Past the phone's live gate the chip shows the fix age.
        t.tick(46_000);
        const chip = t.element().querySelector<HTMLElement>('.vessel-age-chip')!;
        expect(chip.style.display).toBe('block');
        expect(t.element().querySelector('.vessel-sog-badge')!.textContent).toBe('Anchored');
        expect(t.hidden(ABOVE.id)).toBe(true);
    });

    it("counts the chip's words, not each second's digits, as its footprint", () => {
        const el = document.createElement('div');
        el.innerHTML =
            '<div class="vessel-sog-badge">Last fix 46 s</div><div class="vessel-age-chip" style="display:none"></div>';
        const a = ownshipChipSignature(el);
        el.querySelector('.vessel-sog-badge')!.textContent = 'Last fix 47 s';
        expect(ownshipChipSignature(el)).toBe(a);
        el.querySelector('.vessel-sog-badge')!.textContent = 'Last fix 1 min';
        const b = ownshipChipSignature(el);
        expect(b).not.toBe(a);
        (el.querySelector('.vessel-age-chip') as HTMLElement).style.display = 'block';
        expect(ownshipChipSignature(el)).not.toBe(b);
    });

    it('does not hide a name in the empty corner of a box around the dot and its chips', () => {
        mocks.anchorState = 'watching';
        const t = mount();
        // Up and right of the dot: inside a union box of chip + badge, but
        // touching neither, nor the dot.
        t.placed.push({ ...GLADSTONE, at: [56, 47], box: { left: 548, top: 462, right: 600, bottom: 478 } });
        t.fix();
        t.tick(46_000);
        t.fire('moveend');
        t.fire('idle');
        expect(t.element().querySelector<HTMLElement>('.vessel-age-chip')!.style.display).toBe('block');
        expect(t.queries()).toBeGreaterThan(0);
        expect(t.hidden(GLADSTONE.id)).toBe(false);
    });

    it('re-looks when the base changes with no camera move (Hybrid hides the names, Map shows them again)', () => {
        const t = mount();
        t.placed.push(GLADSTONE);
        t.fix();
        t.fire('idle');
        expect(t.hidden(GLADSTONE.id)).toBe(true);

        for (const id of SETTLEMENT_LAYERS) t.layout.set(`${id}|visibility`, 'none');
        t.tick(1000);
        t.fire('idle');
        expect(t.hidden(GLADSTONE.id)).toBe(false);

        for (const id of SETTLEMENT_LAYERS) t.layout.set(`${id}|visibility`, 'visible');
        t.tick(1000);
        t.fire('idle');
        expect(t.hidden(GLADSTONE.id)).toBe(true);
    });
});

describe('per-fix cost', () => {
    it('a fix that moves the dot less than a pixel does no query at all', () => {
        const t = mount();
        t.placed.push(GLADSTONE);
        t.fix();
        t.fire('idle');
        const before = t.queries();
        // Berth jitter: ~1 m, far under a pixel at this zoom.
        for (let i = 0; i < 10; i++) t.fix(50 + (i % 2) * 0.00001, 50 - (i % 3) * 0.00001);
        t.tick(3000);
        expect(t.queries()).toBe(before);
        // A real move of a few pixels looks again.
        t.fix(50.3, 50);
        expect(t.queries()).toBeGreaterThan(before);
    });

    it('never places or updates the inert collision obstacle', () => {
        const t = mount();
        for (let i = 0; i < 5; i++) t.fix(50 + i * 0.1, 50);
        t.tick(5000);
        expect(t.map.addSource.mock.calls.map(([id]) => id)).not.toContain('vessel-ownship-obstacle');
        expect(t.map.addImage).not.toHaveBeenCalled();
    });
});

describe('antimeridian: the marker is measured where it is drawn', () => {
    it("queries around the marker's smart-wrapped position, not the raw fix", () => {
        // The camera sits east of 180: Mapbox draws a -179.9 fix at 180.1.
        mocks.wrap = ([lng, lat]) => [lng < 0 ? lng + 360 : lng, lat];
        const t = mount();
        t.fix(-179.9, 50);
        const [box] = t.map.queryRenderedFeatures.mock.calls[0];
        const x = (box[0][0] + box[1][0]) / 2;
        expect(x).toBeCloseTo(1801, 0);
    });

    it('ranks a label across the line by its distance in the same world copy', () => {
        const fake = labelMap();
        // Own-ship drawn at 180.1°. 'Near' is anchored at -179.95° (really
        // 0.15° away); 'Far' at 179.5° is 0.6° away.
        fake.placed.push(
            {
                id: 1,
                layer: 'settlement-minor-label',
                name: 'Near',
                at: [-179.95, 50],
                box: { left: 1790, top: 490, right: 1820, bottom: 510 },
            },
            {
                id: 2,
                layer: 'settlement-minor-label',
                name: 'Far',
                at: [179.5, 50],
                box: { left: 1780, top: 490, right: 1800, bottom: 510 },
            },
        );
        syncOwnshipPlaceLabel(fake.asMap, [180.1, 50]);
        expect(fake.hidden(1)).toBe(true);
        expect(fake.hidden(2)).toBe(false);
    });
});

describe('hysteresis: GPS jitter never swaps two names under the chip', () => {
    const two = (aAt: number, bAt: number) => {
        const fake = labelMap();
        fake.placed.push(
            {
                id: 1,
                layer: 'settlement-minor-label',
                name: 'Gladstone',
                at: [aAt, 50],
                box: { left: 480, top: 490, right: 540, bottom: 510 },
            },
            {
                id: 2,
                layer: 'settlement-subdivision-label',
                name: 'Clinton',
                at: [bAt, 50],
                box: { left: 470, top: 490, right: 530, bottom: 510 },
            },
        );
        return fake;
    };

    it('keeps the faded label while it still touches, until another is clearly nearer', () => {
        const fake = two(50.8, 51.0); // Gladstone 8 px, Clinton 10 px
        syncOwnshipPlaceLabel(fake.asMap, [50, 50]);
        expect(fake.hidden(1)).toBe(true);

        // Jitter: Clinton now 5 px, Gladstone 8 px. Nearer, but not clearly.
        fake.placed[1].at = [50.5, 50];
        syncOwnshipPlaceLabel(fake.asMap, [50, 50]);
        expect(fake.hidden(1)).toBe(true);
        expect(fake.hidden(2)).toBe(false);
        expect(fake.map.removeFeatureState).not.toHaveBeenCalled();

        // Clearly nearer (0 px vs 20 px): it switches.
        fake.placed[0].at = [52, 50];
        fake.placed[1].at = [50, 50];
        syncOwnshipPlaceLabel(fake.asMap, [50, 50]);
        expect(fake.hidden(1)).toBe(false);
        expect(fake.hidden(2)).toBe(true);
    });

    it('keeps a faded name faded while its edge drifts just outside the entry pad, then lets it go', () => {
        // The dot at (500, 500) with its glow reaches x 514; the entry pad is
        // 4 px (518), the exit pad 12 px (526).
        const fake = labelMap();
        fake.placed.push({
            id: 7,
            layer: 'settlement-minor-label',
            name: 'Gladstone',
            at: [52, 50],
            box: { left: 516, top: 494, right: 580, bottom: 508 },
        });
        syncOwnshipPlaceLabel(fake.asMap, [50, 50]);
        expect(fake.hidden(7)).toBe(true);
        // Jitter: the box edge is 8 px clear, past the entry pad. No blink.
        fake.placed[0].box = { left: 522, top: 494, right: 586, bottom: 508 };
        syncOwnshipPlaceLabel(fake.asMap, [50, 50]);
        expect(fake.hidden(7)).toBe(true);
        expect(fake.map.removeFeatureState).not.toHaveBeenCalled();
        // Back at the edge and out again: still the same fade, still no writes.
        fake.placed[0].box = { left: 517, top: 494, right: 581, bottom: 508 };
        syncOwnshipPlaceLabel(fake.asMap, [50, 50]);
        fake.placed[0].box = { left: 523, top: 494, right: 587, bottom: 508 };
        syncOwnshipPlaceLabel(fake.asMap, [50, 50]);
        expect(fake.hidden(7)).toBe(true);
        expect(fake.map.removeFeatureState).not.toHaveBeenCalled();
        // Clearly clear (26 px): the name is drawn again.
        fake.placed[0].box = { left: 540, top: 494, right: 604, bottom: 508 };
        syncOwnshipPlaceLabel(fake.asMap, [50, 50]);
        expect(fake.hidden(7)).toBe(false);
        // A name that only ever reaches the exit pad is never faded to begin with.
        const fresh = labelMap();
        fresh.placed.push({
            id: 8,
            layer: 'settlement-minor-label',
            name: 'Clinton',
            at: [52, 50],
            box: { left: 522, top: 494, right: 586, bottom: 508 },
        });
        syncOwnshipPlaceLabel(fresh.asMap, [50, 50]);
        expect(fresh.hidden(8)).toBe(false);
    });

    it('switches as soon as the faded label no longer touches own-ship', () => {
        const fake = two(50.2, 51.5);
        syncOwnshipPlaceLabel(fake.asMap, [50, 50]);
        expect(fake.hidden(1)).toBe(true);
        fake.placed[0].box = { left: 900, top: 900, right: 950, bottom: 920 };
        syncOwnshipPlaceLabel(fake.asMap, [50, 50]);
        expect(fake.hidden(1)).toBe(false);
        expect(fake.hidden(2)).toBe(true);
    });
});

describe('town and suburb names only', () => {
    it('never arms or fades an island layer or an island feature', () => {
        expect(isBasePlaceLabelLayer({ id: 'place_island', type: 'symbol', source: 'openmaptiles' })).toBe(false);
        expect(isBasePlaceLabelLayer({ id: 'place-islet-label', type: 'symbol', source: 'composite' })).toBe(false);
        expect(isBasePlaceLabelLayer({ id: 'place_label_other', type: 'symbol', source: 'openmaptiles' })).toBe(true);
        expect(isBasePlaceLabelLayer({ id: 'settlement-minor-label', type: 'symbol', source: 'composite' })).toBe(true);

        expect(isSettlementPlaceFeature({ class: 'settlement', type: 'city' })).toBe(true);
        expect(isSettlementPlaceFeature({ class: 'settlement_subdivision', type: 'suburb' })).toBe(true);
        expect(isSettlementPlaceFeature({ class: 'town' })).toBe(true);
        expect(isSettlementPlaceFeature({ class: 'neighbourhood' })).toBe(true);
        expect(isSettlementPlaceFeature({ class: 'island' })).toBe(false);
        expect(isSettlementPlaceFeature({ class: 'islet' })).toBe(false);
        expect(isSettlementPlaceFeature({ class: 'settlement', type: 'island' })).toBe(false);
        expect(isSettlementPlaceFeature({ class: 'archipelago' })).toBe(false);
        expect(isSettlementPlaceFeature({})).toBe(false);
    });

    it('leaves an islet under the dot drawn and fades the town beside it', () => {
        const fake = labelMap();
        fake.placed.push(
            {
                id: 1,
                layer: 'settlement-minor-label',
                name: 'Turtle Islet',
                properties: { class: 'islet', name: 'Turtle Islet' },
                at: [50, 50],
                box: { left: 480, top: 490, right: 540, bottom: 510 },
            },
            { ...GLADSTONE, id: 2 },
        );
        syncOwnshipPlaceLabel(fake.asMap, [50, 50]);
        expect(fake.hidden(1)).toBe(false);
        expect(fake.hidden(2)).toBe(true);
    });
});
