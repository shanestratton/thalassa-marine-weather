/**
 * useAnchorSwingLayer — anchor datum + geodesic swing ring on the chart
 * (2026-08-03 life-safety module).
 *
 * buildFeatures is module-private, so its semantics are pinned through
 * the hook with a mock map: the FeatureCollection written to the
 * anchor-swing source is the observable surface.
 *
 * Pins:
 *  - idle / no anchor / zero radius → empty FC (nothing on the chart)
 *  - watching → 64-segment closed ring polygon + anchor point, amber
 *  - alarm → the same features with alarm:true (red styling drives off it)
 *  - the ring is geodesic: every vertex is swingRadius metres from the
 *    anchor (independent haversine reference, ±1%)
 *  - basemap swap (style.load) heals layers from the RETAINED snapshot
 *    via a deferred macrotask — GPS can be silent exactly when it matters
 *  - z-order re-assertion: apply() moveLayers fill → line → point
 */
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAnchorSwingLayer } from '../components/map/useAnchorSwingLayer';
import type { AnchorWatchSnapshot } from '../services/AnchorWatchService';

const SOURCE_ID = 'anchor-swing-src';
const FILL_ID = 'anchor-swing-fill';
const LINE_ID = 'anchor-swing-line';
const POINT_ID = 'anchor-swing-point';

const mocks = vi.hoisted(() => {
    const listeners = new Set<(snap: unknown) => void>();
    const state = { snapshot: null as unknown };
    return {
        listeners,
        state,
        // Mirrors the real service contract: subscribe fires the listener
        // immediately with the current snapshot and returns an unsubscriber.
        subscribe: vi.fn((listener: (snap: unknown) => void) => {
            listeners.add(listener);
            listener(state.snapshot);
            return () => listeners.delete(listener);
        }),
        getSnapshot: vi.fn(() => state.snapshot),
    };
});

vi.mock('../services/AnchorWatchService', () => ({
    AnchorWatchService: {
        subscribe: mocks.subscribe,
        getSnapshot: mocks.getSnapshot,
    },
}));

function snap(over: Partial<AnchorWatchSnapshot> = {}): AnchorWatchSnapshot {
    return {
        state: 'watching',
        anchorPosition: { latitude: -27, longitude: 153, timestamp: 1_000 },
        vesselPosition: null,
        swingRadius: 30,
        distanceFromAnchor: 12,
        maxDistanceRecorded: 14,
        bearingToAnchor: 90,
        config: { rodeLength: 40, waterDepth: 5, scopeRatio: 5, rodeType: 'chain', safetyMargin: 10 },
        positionHistory: [],
        alarmTriggeredAt: null,
        alarmCause: null,
        watchStartedAt: 1_000,
        gpsAccuracy: 5,
        gpsQuality: 'precision',
        gpsQualityLabel: 'Precision GPS',
        guardianStatus: 'idle',
        ...over,
    };
}

type Handler = () => void;

function makeMap() {
    const listeners = new Map<string, Set<Handler>>();
    const onceListeners = new Map<string, Set<Handler>>();
    const sources = new Map<string, { setData: ReturnType<typeof vi.fn> }>();
    const layers = new Map<string, { id: string }>();
    const moveCalls: string[] = [];
    const add = (registry: Map<string, Set<Handler>>, event: string, handler: Handler) => {
        const handlers = registry.get(event) ?? new Set<Handler>();
        handlers.add(handler);
        registry.set(event, handlers);
    };
    const map = {
        isStyleLoaded: vi.fn(() => true),
        addSource: vi.fn((id: string) => {
            sources.set(id, { setData: vi.fn() });
        }),
        getSource: vi.fn((id: string) => sources.get(id)),
        addLayer: vi.fn((layer: { id: string }) => {
            layers.set(layer.id, layer);
        }),
        getLayer: vi.fn((id: string) => layers.get(id)),
        removeLayer: vi.fn((id: string) => {
            layers.delete(id);
        }),
        removeSource: vi.fn((id: string) => {
            sources.delete(id);
        }),
        moveLayer: vi.fn((id: string) => {
            moveCalls.push(id);
        }),
        on: vi.fn((event: string, handler: Handler) => add(listeners, event, handler)),
        once: vi.fn((event: string, handler: Handler) => add(onceListeners, event, handler)),
        off: vi.fn((event: string, handler: Handler) => {
            listeners.get(event)?.delete(handler);
            onceListeners.get(event)?.delete(handler);
        }),
    };
    const emitMapEvent = (event: string) => {
        for (const handler of [...(listeners.get(event) ?? [])]) handler();
        const once = onceListeners.get(event);
        if (once) {
            onceListeners.delete(event);
            for (const handler of [...once]) handler();
        }
    };
    return { map, listeners, onceListeners, sources, layers, moveCalls, emitMapEvent };
}

type Harness = ReturnType<typeof makeMap>;

function mount(harness: Harness, initial: AnchorWatchSnapshot) {
    mocks.state.snapshot = initial;
    const mapRef = { current: harness.map as never };
    return renderHook(() => useAnchorSwingLayer(mapRef, true));
}

function emitSnapshot(next: AnchorWatchSnapshot) {
    mocks.state.snapshot = next;
    act(() => {
        for (const listener of [...mocks.listeners]) listener(next);
    });
}

function writtenFC(harness: Harness): GeoJSON.FeatureCollection {
    const source = harness.sources.get(SOURCE_ID);
    const data = source?.setData.mock.calls.at(-1)?.[0] as GeoJSON.FeatureCollection | undefined;
    if (!data) throw new Error('No FeatureCollection was written to the anchor-swing source');
    return data;
}

/** Independent haversine reference — deliberately not the source's formula. */
function refHaversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6_371_000;
    const toRad = (deg: number) => (deg * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

beforeEach(() => {
    mocks.listeners.clear();
    mocks.state.snapshot = snap({ state: 'idle', anchorPosition: null });
    mocks.subscribe.mockClear();
    mocks.getSnapshot.mockClear();
});

afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

describe('useAnchorSwingLayer', () => {
    it('shows nothing while idle, then draws the guard ring + anchor datum when the watch arms', () => {
        const h = makeMap();
        mount(h, snap({ state: 'idle', anchorPosition: null }));

        // Layers exist from mount, but an idle watch writes an EMPTY FC.
        expect(h.layers.has(FILL_ID)).toBe(true);
        expect(h.layers.has(LINE_ID)).toBe(true);
        expect(h.layers.has(POINT_ID)).toBe(true);
        expect(writtenFC(h).features).toEqual([]);

        emitSnapshot(snap());
        const fc = writtenFC(h);
        expect(fc.features).toHaveLength(2);

        const [ringFeature, anchorFeature] = fc.features;
        expect(ringFeature.geometry.type).toBe('Polygon');
        expect(ringFeature.properties).toEqual({ alarm: false });
        const ring = (ringFeature.geometry as GeoJSON.Polygon).coordinates[0];
        expect(ring).toHaveLength(65); // 64 segments, closed
        expect(ring[0][0]).toBeCloseTo(ring[64][0], 9);
        expect(ring[0][1]).toBeCloseTo(ring[64][1], 9);

        expect(anchorFeature.geometry.type).toBe('Point');
        expect((anchorFeature.geometry as GeoJSON.Point).coordinates).toEqual([153, -27]);
        expect(anchorFeature.properties).toEqual({ alarm: false, isAnchor: true });
    });

    it('builds a geodesic ring: every vertex within 1% of the 30m swing radius at lat -27', () => {
        const h = makeMap();
        mount(h, snap({ swingRadius: 30 }));

        const ringFeature = writtenFC(h).features[0];
        const ring = (ringFeature.geometry as GeoJSON.Polygon).coordinates[0];
        expect(ring).toHaveLength(65);
        for (const [lon, lat] of ring) {
            const distM = refHaversineM(-27, 153, lat, lon);
            expect(distM).toBeGreaterThan(30 * 0.99);
            expect(distM).toBeLessThan(30 * 1.01);
        }
        // A screen-pixel circle would collapse here: the ring must span
        // real degrees of longitude/latitude around the anchor.
        const lons = ring.map(([lon]) => lon);
        const lats = ring.map(([, lat]) => lat);
        expect(Math.max(...lons)).toBeGreaterThan(153);
        expect(Math.min(...lons)).toBeLessThan(153);
        expect(Math.max(...lats)).toBeGreaterThan(-27);
        expect(Math.min(...lats)).toBeLessThan(-27);
    });

    it('flips both features to alarm:true when the watch alarms', () => {
        const h = makeMap();
        mount(h, snap());

        emitSnapshot(snap({ state: 'alarm', alarmTriggeredAt: 5_000, alarmCause: 'drag', distanceFromAnchor: 55 }));
        const fc = writtenFC(h);
        expect(fc.features).toHaveLength(2);
        expect(fc.features[0].properties).toEqual({ alarm: true });
        expect(fc.features[1].properties).toEqual({ alarm: true, isAnchor: true });
    });

    it('renders nothing for a zero swing radius, a missing anchor, or an idle state', () => {
        const h = makeMap();
        mount(h, snap());
        expect(writtenFC(h).features).toHaveLength(2);

        emitSnapshot(snap({ swingRadius: 0 }));
        expect(writtenFC(h).features).toEqual([]);

        emitSnapshot(snap({ anchorPosition: null }));
        expect(writtenFC(h).features).toEqual([]);

        emitSnapshot(snap({ state: 'idle' }));
        expect(writtenFC(h).features).toEqual([]);
    });

    it('heals after a basemap swap from the retained snapshot, deferred one macrotask and deduped', () => {
        vi.useFakeTimers();
        const h = makeMap();
        mount(h, snap());
        expect(writtenFC(h).features).toHaveLength(2);

        // setStyle wipes every custom source and layer.
        h.layers.clear();
        h.sources.clear();

        // Two rapid style.load events (hybrid → satellite bounce) must
        // coalesce into ONE deferred heal, and nothing may touch the style
        // synchronously inside event dispatch.
        h.emitMapEvent('style.load');
        h.emitMapEvent('style.load');
        expect(h.sources.has(SOURCE_ID)).toBe(false);

        act(() => {
            vi.advanceTimersByTime(0);
        });

        // Rebuilt from the RETAINED snapshot — no new GPS fix or service
        // emission occurred. A blind or stationary watch stays drawn.
        expect(h.layers.has(FILL_ID)).toBe(true);
        expect(h.layers.has(LINE_ID)).toBe(true);
        expect(h.layers.has(POINT_ID)).toBe(true);
        const healedSource = h.sources.get(SOURCE_ID);
        expect(healedSource?.setData).toHaveBeenCalledTimes(1);
        expect(writtenFC(h).features).toHaveLength(2);
    });

    it('defers to map idle while the style is still booting instead of mutating it mid-boot', () => {
        vi.useFakeTimers();
        const h = makeMap();
        h.map.isStyleLoaded.mockReturnValue(false);
        mount(h, snap());

        // Nothing touched the booting style; the heal is armed on idle.
        expect(h.map.addSource).not.toHaveBeenCalled();
        expect(h.map.addLayer).not.toHaveBeenCalled();
        expect(h.onceListeners.get('idle')?.size).toBe(1);

        h.map.isStyleLoaded.mockReturnValue(true);
        h.emitMapEvent('idle');
        act(() => {
            vi.advanceTimersByTime(0);
        });

        expect(h.layers.has(FILL_ID)).toBe(true);
        expect(writtenFC(h).features).toHaveLength(2);
    });

    it('re-asserts z-order on every apply: moveLayer fill → line → point', () => {
        const h = makeMap();
        mount(h, snap());

        // Point last = topmost; weather rasters and late ENC mounts must
        // not bury the swing circle.
        expect(h.moveCalls.slice(-3)).toEqual([FILL_ID, LINE_ID, POINT_ID]);

        h.moveCalls.length = 0;
        emitSnapshot(snap({ distanceFromAnchor: 20 }));
        expect(h.moveCalls).toEqual([FILL_ID, LINE_ID, POINT_ID]);
    });

    it('removes its layers and listeners on unmount', () => {
        const h = makeMap();
        const view = mount(h, snap());
        expect(h.listeners.get('style.load')?.size).toBe(1);
        expect(mocks.listeners.size).toBe(1);

        view.unmount();
        expect(h.layers.size).toBe(0);
        expect(h.sources.size).toBe(0);
        expect(h.listeners.get('style.load')?.size ?? 0).toBe(0);
        expect(mocks.listeners.size).toBe(0);
    });
});
