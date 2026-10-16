import { act, cleanup, render, waitFor } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MapboxVelocityOverlay } from '../components/map/MapboxVelocityOverlay';
import type { WindGrid } from '../services/weather/windGridEncoding';
import { getCloseInWindReadout, subscribeCloseInWindReadout, viewportGridCells } from '../components/map/closeInWind';
import { boatWindChipFor, getBoatWindReadout, subscribeBoatWindReadout } from '../components/map/boatWindReadout';
import { CloseInWindLayer } from '../components/map/CloseInWindLayer';
import type { WindFieldOptions } from '../components/map/MapboxWindField';
import { windGridFrameToVelocityData } from '../components/map/windVelocityFrame';

type MapHandler = () => void;

interface MockField {
    element: HTMLDivElement;
    setData: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
    options: WindFieldOptions;
}
const mocks = vi.hoisted(() => ({
    fields: [] as MockField[],
    importedLayers: [] as {
        id: string;
        setGrid: ReturnType<typeof vi.fn>;
        setForecastHour: ReturnType<typeof vi.fn>;
        setParticlesEnabled: ReturnType<typeof vi.fn>;
    }[],
    logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
    releasePlugin: () => {},
}));
vi.mock('../components/map/MapboxWindField', () => ({
    MapboxWindField: class {
        element = document.createElement('div');
        setData = vi.fn();
        destroy = vi.fn(() => this.element.remove());
        constructor(
            map: { getContainer(): HTMLElement },
            public options: WindFieldOptions,
        ) {
            this.element.dataset.windField = 'true';
            this.element.style.opacity = '0';
            this.element.style.filter = options.filter ?? '';
            map.getContainer().appendChild(this.element);
            mocks.fields.push(this);
        }
    },
}));
vi.mock('../components/map/WindParticleLayer', () => ({
    WindParticleLayer: class {
        setGrid = vi.fn();
        setForecastHour = vi.fn();
        setParticlesEnabled = vi.fn();
        constructor(public id: string) {
            mocks.importedLayers.push(this);
        }
    },
}));
vi.mock('../utils/createLogger', () => ({ createLogger: () => mocks.logger }));

// The boat's instruments, as the overlay reads them: a controllable store.
const nmea = vi.hoisted(() => {
    const empty = () => ({ value: null, lastUpdated: 0, freshness: 'dead' });
    const listeners = new Set<() => void>();
    const store = {
        state: {} as Record<string, unknown>,
        boatFeed: false,
        remoteWindSample: null as null | { kts: number; at: number; via: 'lan' | 'cloud' },
        remoteFeedEndedAt: 0,
        reset() {
            store.state = {
                tws: empty(),
                twd: empty(),
                twaSigned: empty(),
                headingTrue: empty(),
                latitude: empty(),
                longitude: empty(),
                sog: empty(),
                cog: empty(),
                connectionStatus: 'disconnected',
            };
            store.boatFeed = false;
            store.remoteWindSample = null;
            store.remoteFeedEndedAt = 0;
        },
        live(patch: Record<string, number>) {
            const now = Date.now();
            for (const [key, value] of Object.entries(patch)) {
                store.state[key] = { value, lastUpdated: now, freshness: 'live' };
            }
            for (const listener of [...listeners]) listener();
        },
        NmeaStore: {
            getState: () => store.state,
            isBoatFeed: () => store.boatFeed,
            getRemoteWindSample: () => store.remoteWindSample,
            getRemoteFeedEndedAt: () => store.remoteFeedEndedAt,
            subscribe: (listener: () => void) => {
                listeners.add(listener);
                return () => listeners.delete(listener);
            },
        },
        listenerCount: () => listeners.size,
    };
    store.reset();
    return store;
});

vi.mock('../services/NmeaStore', () => ({ NmeaStore: nmea.NmeaStore }));

// Whether the location box follows the boat whose instruments the store holds
// (obsBoatInstruments, Shane 2026-10-06). The boat cases below follow her.
// Ashore the store is empty on Obs, and the followed boat's wind comes from her
// cloud row through the boat chain (followedBoatCloudWind), looked up on the
// chain's own throttle (lookUpFollowedBoatWind) only while Obs is on screen.
// `boat`: the boat the box follows (null crewOwnerId: the own boat; null: the phone).
const instruments = vi.hoisted(() => ({
    followed: true,
    boat: { crewOwnerId: null } as { crewOwnerId: string | null } | null,
    cloud: null as null | { wind: { kt: number; fromDeg: number | null; stale: boolean }; lat: number; lon: number },
    lookUp: vi.fn(async () => {}),
}));
vi.mock('../components/map/obsBoatInstruments', () => ({
    boatInstrumentsFollowed: () => instruments.followed,
    followedBoatSubject: () => instruments.boat,
    followedBoatCloudWind: () => instruments.cloud,
    lookUpFollowedBoatWind: instruments.lookUp,
}));
vi.mock('../services/weatherPosition', () => ({
    WEATHER_FOLLOW_TARGET_EVENT: 'thalassa:weather-follow-target-changed',
}));

interface MapboxHarness {
    container: HTMLDivElement;
    emit: (event: string) => void;
    layers: Map<string, unknown>;
    listenerCount: (event: string) => number;
    listeners: Map<string, Set<MapHandler>>;
    sources: Map<string, { options: unknown; updateImage: ReturnType<typeof vi.fn> }>;
    map: {
        addLayer: ReturnType<typeof vi.fn>;
        addSource: ReturnType<typeof vi.fn>;
        getCenter: ReturnType<typeof vi.fn>;
        getContainer: ReturnType<typeof vi.fn>;
        getLayer: ReturnType<typeof vi.fn>;
        getSource: ReturnType<typeof vi.fn>;
        getStyle: ReturnType<typeof vi.fn>;
        getZoom: ReturnType<typeof vi.fn>;
        isStyleLoaded: ReturnType<typeof vi.fn>;
        off: ReturnType<typeof vi.fn>;
        on: ReturnType<typeof vi.fn>;
        project: ReturnType<typeof vi.fn>;
        removeLayer: ReturnType<typeof vi.fn>;
        removeSource: ReturnType<typeof vi.fn>;
    };
}

function createMapboxHarness(zoom = 5): MapboxHarness {
    const container = document.createElement('div');
    container.dataset.testMapboxVelocity = 'true';
    document.body.appendChild(container);
    const listeners = new Map<string, Set<MapHandler>>();
    const sources = new Map<string, { options: unknown; updateImage: ReturnType<typeof vi.fn> }>();
    const layers = new Map<string, unknown>();
    const map = {
        addLayer: vi.fn(),
        addSource: vi.fn(),
        getCenter: vi.fn(() => ({ lat: -27, lng: 153 })),
        getContainer: vi.fn(() => container),
        getLayer: vi.fn(),
        getSource: vi.fn(),
        getStyle: vi.fn(() => ({ layers: [{ id: 'place-label', type: 'symbol' }] })),
        getZoom: vi.fn(() => zoom),
        isStyleLoaded: vi.fn(() => true),
        off: vi.fn(),
        on: vi.fn(),
        project: vi.fn(() => ({ x: 100, y: 80 })),
        removeLayer: vi.fn(),
        removeSource: vi.fn(),
    };
    map.addSource.mockImplementation((id: string, options: unknown) => {
        sources.set(id, { options, updateImage: vi.fn() });
        return map;
    });
    map.getSource.mockImplementation((id: string) => sources.get(id));
    map.addLayer.mockImplementation((layer: { id: string }) => {
        layers.set(layer.id, layer);
        return map;
    });
    map.getLayer.mockImplementation((id: string) => layers.get(id));
    map.removeLayer.mockImplementation((id: string) => {
        layers.delete(id);
        return map;
    });
    map.removeSource.mockImplementation((id: string) => {
        sources.delete(id);
        return map;
    });
    map.on.mockImplementation((event: string, handler: MapHandler) => {
        const handlers = listeners.get(event) ?? new Set<MapHandler>();
        handlers.add(handler);
        listeners.set(event, handlers);
        return map;
    });
    map.off.mockImplementation((event: string, handler: MapHandler) => {
        const handlers = listeners.get(event);
        handlers?.delete(handler);
        if (handlers?.size === 0) listeners.delete(event);
        return map;
    });

    return {
        container,
        emit: (event: string) => {
            for (const handler of [...(listeners.get(event) ?? [])]) handler();
        },
        layers,
        listenerCount: (event: string) => listeners.get(event)?.size ?? 0,
        listeners,
        map,
        sources,
    };
}

function windGrid(value: number, refTime: string): WindGrid {
    return {
        u: [new Float32Array([value]), new Float32Array([value + 1])],
        v: [new Float32Array([-value]), new Float32Array([-(value + 1)])],
        speed: [new Float32Array([value]), new Float32Array([value + 1])],
        width: 1,
        height: 1,
        lats: [-27],
        lons: [153],
        north: -27,
        south: -27,
        west: 153,
        east: 153,
        totalHours: 2,
        refTime,
    };
}

function invalidGrid(): WindGrid {
    return {
        ...windGrid(99, 'invalid'),
        u: [],
        v: [],
        speed: [],
        totalHours: 0,
    };
}

function heatmapGrid(): WindGrid {
    return {
        u: [new Float32Array([2, 4, 6, 8]), new Float32Array([4, 6, 8, 10])],
        v: [new Float32Array([1, 3, 5, 7]), new Float32Array([3, 5, 7, 9])],
        speed: [new Float32Array([2, 4, 6, 8]), new Float32Array([4, 6, 8, 10])],
        width: 2,
        height: 2,
        lats: [-28, -26],
        lons: [152, 154],
        north: -26,
        south: -28,
        west: 152,
        east: 154,
        totalHours: 2,
        refTime: 'heatmap',
    };
}

afterEach(() => {
    cleanup();
    vi.useRealTimers();
    document.querySelectorAll('[data-test-mapbox-velocity="true"]').forEach((element) => element.remove());
});

describe('MapboxVelocityOverlay React lifecycle', () => {
    it('applies a selected grid in either map/grid arrival order, fractional hours, clears, errors and remounts', () => {
        const h = createMapboxHarness(),
            before = mocks.fields.length;
        const grid = heatmapGrid();
        const view = render(<MapboxVelocityOverlay mapboxMap={null} visible windGrid={grid} />);
        expect(mocks.fields).toHaveLength(before);
        view.rerender(<MapboxVelocityOverlay mapboxMap={h.map as never} visible windGrid={grid} windHour={0.5} />);
        const field = mocks.fields.at(-1)!;
        expect(field.setData).toHaveBeenLastCalledWith(windGridFrameToVelocityData(grid, 0.5));
        view.rerender(<MapboxVelocityOverlay mapboxMap={h.map as never} visible />);
        expect(field.setData).toHaveBeenLastCalledWith(null);
        expect(field.element.style.opacity).toBe('0');
        field.setData.mockImplementationOnce(() => {
            throw new Error('synthetic draw failure');
        });
        view.rerender(<MapboxVelocityOverlay mapboxMap={h.map as never} visible windGrid={grid} />);
        expect(field.setData).toHaveBeenLastCalledWith(null);
        expect(field.element.style.opacity).toBe('0');
        view.rerender(<MapboxVelocityOverlay mapboxMap={h.map as never} visible windGrid={invalidGrid()} />);
        expect(field.setData).toHaveBeenLastCalledWith(null);
        view.unmount();
        expect(field.destroy).toHaveBeenCalledOnce();
        const remount = render(<MapboxVelocityOverlay mapboxMap={h.map as never} visible />);
        expect(mocks.fields.at(-1)!.setData).toHaveBeenLastCalledWith(null);
        remount.rerender(<MapboxVelocityOverlay mapboxMap={h.map as never} visible windGrid={grid} />);
        expect(mocks.fields.at(-1)!.setData).toHaveBeenLastCalledWith(windGridFrameToVelocityData(grid, 0));
    });

    it('mounts only enabled visible particles at supported zoom, and retains thin Light ink when updating hours', () => {
        const h = createMapboxHarness(),
            grid = heatmapGrid(),
            before = mocks.fields.length;
        const props = { mapboxMap: h.map as never, visible: true, windGrid: grid };
        const view = render(<MapboxVelocityOverlay {...props} particlesEnabled={false} />);
        expect(mocks.fields).toHaveLength(before);
        view.rerender(<MapboxVelocityOverlay {...props} palette="light" />);
        const field = mocks.fields.at(-1)!;
        expect(field.options).toMatchObject({ lineWidth: 1.5, palette: 'light', fade: 0.98 });
        expect(field.element.style.filter).toContain('rgba(255, 255, 255');
        view.rerender(<MapboxVelocityOverlay {...props} palette="light" windHour={1} />);
        expect(mocks.fields).toHaveLength(before + 1);
        expect(field.setData).toHaveBeenLastCalledWith(windGridFrameToVelocityData(grid, 1));
        view.rerender(<MapboxVelocityOverlay {...props} palette="dark" />);
        expect(field.destroy).toHaveBeenCalledOnce();
        expect(mocks.fields.at(-1)!.options).toMatchObject({ lineWidth: 1, palette: 'dark' });
        const dark = mocks.fields.at(-1)!;
        view.rerender(<MapboxVelocityOverlay {...props} visible={false} />);
        expect(dark.destroy).toHaveBeenCalledOnce();
        view.rerender(<MapboxVelocityOverlay {...props} />);
        const last = mocks.fields.at(-1)!;
        act(() => {
            h.map.getZoom.mockReturnValue(2);
            h.emit('zoomend');
        });
        expect(last.destroy).toHaveBeenCalledOnce();
    });
    it('keeps imported bitmap data out of Leaflet and boat substitution, scrubs and removes its owned layer', async () => {
        const harness = createMapboxHarness(15),
            grid = { ...heatmapGrid(), importedGrib: true };
        const before = mocks.fields.length;
        const view = render(
            <MapboxVelocityOverlay
                mapboxMap={harness.map as never}
                visible
                windGrid={grid}
                windHour={0}
                boatInstruments
                boatLookUp
            />,
        );
        await waitFor(() => expect(harness.layers.has('imported-grib-wind')).toBe(true));
        const layer = mocks.importedLayers.at(-1)!;
        expect(layer.setGrid).toHaveBeenCalledWith(grid, 0);
        expect(mocks.fields).toHaveLength(before);
        expect(getCloseInWindReadout()).toBeNull();
        view.rerender(
            <MapboxVelocityOverlay
                mapboxMap={harness.map as never}
                visible
                windGrid={grid}
                windHour={0.5}
                particlesEnabled={false}
            />,
        );
        expect(layer.setForecastHour).toHaveBeenLastCalledWith(0.5);
        expect(layer.setParticlesEnabled).toHaveBeenLastCalledWith(false);
        expect(layer.setGrid).toHaveBeenCalledTimes(1);
        view.unmount();
        expect(harness.layers.has('imported-grib-wind')).toBe(false);
        expect(harness.listenerCount('style.load')).toBe(0);
    });
    it('does not add an imported layer after its asynchronous module arrives on a hidden chart', async () => {
        const harness = createMapboxHarness();
        const view = render(
            <MapboxVelocityOverlay
                mapboxMap={harness.map as never}
                visible
                windGrid={{ ...heatmapGrid(), importedGrib: true }}
            />,
        );
        view.unmount();
        await act(async () => {
            await Promise.resolve();
        });
        expect(harness.layers.has('imported-grib-wind')).toBe(false);
    });
});

const AIRLIE = { lat: -20.27, lng: 148.72 };
const KT = 1852 / 3600;

/** A 9x9, 0.25 deg ECMWF-like grid centred on Airlie: `kt` from `fromDeg` everywhere, two hourly frames. */
function airlieGrid(kt = 8, fromDeg = 135, laterKt = kt): WindGrid {
    const frame = (speedKt: number) => {
        const ms = speedKt * KT;
        const rad = (fromDeg * Math.PI) / 180;
        return {
            u: new Float32Array(81).fill(-ms * Math.sin(rad)),
            v: new Float32Array(81).fill(-ms * Math.cos(rad)),
            speed: new Float32Array(81).fill(ms),
        };
    };
    const a = frame(kt);
    const b = frame(laterKt);
    const lats = Array.from({ length: 9 }, (_, i) => AIRLIE.lat - 1 + i * 0.25);
    const lons = Array.from({ length: 9 }, (_, i) => AIRLIE.lng - 1 + i * 0.25);
    return {
        u: [a.u, b.u],
        v: [a.v, b.v],
        speed: [a.speed, b.speed],
        width: 9,
        height: 9,
        lats,
        lons,
        north: lats[8],
        south: lats[0],
        west: lons[0],
        east: lons[8],
        totalHours: 2,
        refTime: 'airlie',
    };
}

/** The harness at a phone's size over Airlie. project() puts every point at (100, 80): on screen. */
function phoneHarness(zoom: number): MapboxHarness {
    const mapbox = createMapboxHarness(zoom);
    Object.defineProperty(mapbox.container, 'clientWidth', { configurable: true, get: () => 390 });
    Object.defineProperty(mapbox.container, 'clientHeight', { configurable: true, get: () => 844 });
    mapbox.map.getCenter.mockReturnValue(AIRLIE);
    return mapbox;
}

/** The zoom at which this phone spans `cells` of the 0.25 deg grid. */
function zoomForCells(cells: number): number {
    const at10 = viewportGridCells(
        { zoom: 10, widthPx: 390, heightPx: 844, centreLat: AIRLIE.lat },
        { dxDeg: 0.25, dyDeg: 0.25 },
    )!;
    return 10 + Math.log2(at10 / cells);
}

const closeInElement = (mapbox: MapboxHarness) =>
    mapbox.container.querySelector('[data-close-in-wind="true"]') as HTMLDivElement | null;

function settleAt(mapbox: MapboxHarness, zoom: number): void {
    act(() => {
        mapbox.map.getZoom.mockReturnValue(zoom);
        mapbox.emit('zoom');
        mapbox.emit('moveend');
        mapbox.emit('zoomend');
    });
}

describe('MapboxVelocityOverlay close-in mode', () => {
    afterEach(() => {
        nmea.reset();
        instruments.followed = true;
        vi.restoreAllMocks();
    });

    it('cross-fades to close-in, parks the geographic engine, holds hysteresis then hands back', async () => {
        const h = phoneHarness(8),
            grid = airlieGrid(),
            before = mocks.fields.length;
        const view = render(<MapboxVelocityOverlay mapboxMap={h.map as never} visible windGrid={grid} />);
        const field = mocks.fields.at(-1)!;
        expect(field.element.style.opacity).toBe('1');
        settleAt(h, zoomForCells(1.2));
        expect(closeInElement(h)).not.toBeNull();
        expect(field.element.style.opacity).toBe('0');
        expect(field.destroy).not.toHaveBeenCalled();
        await waitFor(() => expect(field.destroy).toHaveBeenCalledOnce());
        settleAt(h, zoomForCells(1.8));
        expect(mocks.fields).toHaveLength(before + 1);
        settleAt(h, zoomForCells(3));
        expect(mocks.fields).toHaveLength(before + 2);
        await waitFor(() => expect(closeInElement(h)).toBeNull(), { timeout: 2000 });
        view.unmount();
    });

    it('reads the boat instruments first when live, on screen and at now; the model when scrubbed away', async () => {
        mocks.releasePlugin();
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
        const mapbox = phoneHarness(14);
        nmea.live({ tws: 14, twd: 200, latitude: AIRLIE.lat, longitude: AIRLIE.lng });
        const props = {
            mapboxMap: mapbox.map as never,
            visible: true,
            windGrid: airlieGrid(8, 135, 20),
            boatInstruments: true,
        };
        const view = render(<MapboxVelocityOverlay {...props} windHour={0} windNowIdx={0} />);
        expect(getCloseInWindReadout()).toEqual({ kt: 14, fromDeg: 200, source: 'boat', stale: false });
        // A fresh sample is picked up from the store's own notifications.
        act(() => nmea.live({ tws: 15, twd: 210 }));
        expect(getCloseInWindReadout()).toMatchObject({ kt: 15, fromDeg: 210, source: 'boat' });

        // Scrubbed to the next hour: the model for that hour, never the boat.
        view.rerender(<MapboxVelocityOverlay {...props} windHour={1} windNowIdx={0} />);
        expect(getCloseInWindReadout()).toMatchObject({ source: 'model' });
        expect(getCloseInWindReadout()!.kt).toBeCloseTo(20, 3);

        // Back at now, but the instruments have gone quiet (dead): the model.
        nmea.reset();
        view.rerender(<MapboxVelocityOverlay {...props} windHour={0} windNowIdx={0} />);
        expect(getCloseInWindReadout()).toMatchObject({ source: 'model' });
        expect(getCloseInWindReadout()!.kt).toBeCloseTo(8, 3);
        view.unmount();
        expect(nmea.listenerCount()).toBe(0);
    });

    it('her wind paints the field only in at 14; a pinch out hands it to the model (Shane 2026-10-07)', async () => {
        mocks.releasePlugin();
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
        const mapbox = phoneHarness(14);
        nmea.live({ tws: 14, twd: 200, latitude: AIRLIE.lat, longitude: AIRLIE.lng });
        const props = {
            mapboxMap: mapbox.map as never,
            visible: true,
            windGrid: airlieGrid(8, 135, 20),
            boatInstruments: true,
        };
        const view = render(<MapboxVelocityOverlay {...props} windHour={0} windNowIdx={0} />);
        expect(getCloseInWindReadout()).toEqual({ kt: 14, fromDeg: 200, source: 'boat', stale: false });

        // Out to 13: still close-in, but one marina reading no longer speaks for the screen.
        settleAt(mapbox, 13);
        expect(closeInElement(mapbox)).not.toBeNull();
        expect(getCloseInWindReadout()).toMatchObject({ source: 'model' });
        expect(getCloseInWindReadout()!.kt).toBeCloseTo(8, 3);
        // A fresh sample does not pull her back while the camera is out.
        act(() => nmea.live({ tws: 15, twd: 210 }));
        expect(getCloseInWindReadout()).toMatchObject({ source: 'model' });

        // Back in to a camera that eased to 13.98: hers again.
        settleAt(mapbox, 13.98);
        expect(getCloseInWindReadout()).toMatchObject({ kt: 15, fromDeg: 210, source: 'boat' });
        // A settle a hair under the line does not flick her off...
        settleAt(mapbox, 13.92);
        expect(getCloseInWindReadout()).toMatchObject({ source: 'boat' });
        // ...nor does a scrub away and back at that same camera (review 2026-10-07:
        // the slack belongs to the zoom, not to whichever wind was last shown).
        view.rerender(<MapboxVelocityOverlay {...props} windHour={1} windNowIdx={0} />);
        expect(getCloseInWindReadout()).toMatchObject({ source: 'model' });
        view.rerender(<MapboxVelocityOverlay {...props} windHour={0} windNowIdx={0} />);
        expect(getCloseInWindReadout()).toMatchObject({ source: 'boat' });

        // A flyTo whose arc dips under the line: an instrument tick mid-flight holds her...
        const map = mapbox.map as unknown as { isMoving?: () => boolean };
        map.isMoving = () => true;
        mapbox.map.getZoom.mockReturnValue(13.84);
        act(() => nmea.live({ tws: 16, twd: 215 }));
        expect(getCloseInWindReadout()).toMatchObject({ kt: 16, source: 'boat' });
        // ...and the camera, once settled, decides.
        map.isMoving = () => false;
        settleAt(mapbox, 13.6);
        expect(getCloseInWindReadout()).toMatchObject({ source: 'model' });

        // Past 14, in at the pens, she holds.
        settleAt(mapbox, 17);
        expect(getCloseInWindReadout()).toMatchObject({ source: 'boat' });
        view.unmount();
    });

    it('paints "Boat" only from a wind the model check would accept: dated over the LAN, the socket\'s own on the gateway', async () => {
        mocks.releasePlugin();
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
        const mapbox = phoneHarness(14);
        const props = {
            mapboxMap: mapbox.map as never,
            visible: true,
            windGrid: airlieGrid(8, 135, 20),
            boatInstruments: true,
        };
        // The Pi over the LAN with a TWS it never dated (Signal K's cached
        // value from an instrument that is off, re-stamped on receipt): the model.
        nmea.state.remote = { via: 'lan' };
        nmea.live({ tws: 31, twd: 200, latitude: AIRLIE.lat, longitude: AIRLIE.lng });
        const view = render(<MapboxVelocityOverlay {...props} windHour={0} windNowIdx={0} />);
        expect(getCloseInWindReadout()).toMatchObject({ source: 'model' });
        // The Pi dated it: hers.
        nmea.remoteWindSample = { kts: 31, at: Date.now() - 2_000, via: 'lan' };
        act(() => nmea.live({ tws: 31 }));
        expect(getCloseInWindReadout()).toMatchObject({ kt: 31, source: 'boat' });
        // A dated sample past the Pi's own 20 s line is not hers now.
        nmea.remoteWindSample = { kts: 31, at: Date.now() - 25_000, via: 'lan' };
        act(() => nmea.live({ tws: 31 }));
        expect(getCloseInWindReadout()).toMatchObject({ source: 'model' });
        // A sample for another value (the store moved on) does not date this one.
        nmea.remoteWindSample = { kts: 30, at: Date.now() - 1_000, via: 'lan' };
        act(() => nmea.live({ tws: 31 }));
        expect(getCloseInWindReadout()).toMatchObject({ source: 'model' });

        // The gateway socket takes over: the LAN feed's leftover, stamped before
        // that feed ended, is not the socket's.
        delete nmea.state.remote;
        nmea.state.connectionStatus = 'connected';
        nmea.remoteFeedEndedAt = Date.now() + 1;
        act(() => nmea.live({ tws: 31, twd: 200 }));
        expect(getCloseInWindReadout()).toMatchObject({ source: 'model' });
        // The socket's own sentence, after: hers.
        nmea.remoteFeedEndedAt = Date.now() - 1;
        act(() => nmea.live({ tws: 14, twd: 210 }));
        expect(getCloseInWindReadout()).toMatchObject({ kt: 14, fromDeg: 210, source: 'boat' });
        view.unmount();
    });

    it('a boat off screen does not speak for the water on screen', async () => {
        mocks.releasePlugin();
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
        const mapbox = phoneHarness(14);
        mapbox.map.project.mockImplementation(([lng]: [number, number]) =>
            lng === 150 ? { x: 2000, y: 80 } : { x: 100, y: 80 },
        );
        nmea.live({ tws: 14, twd: 200, latitude: AIRLIE.lat, longitude: 150 });
        const view = render(
            <MapboxVelocityOverlay
                mapboxMap={mapbox.map as never}
                visible
                windGrid={airlieGrid()}
                windHour={0}
                windNowIdx={0}
                boatInstruments
            />,
        );
        expect(getCloseInWindReadout()).toMatchObject({ source: 'model' });
        view.unmount();
    });

    // Shane 2026-10-06: "if the punter selects wind and their is a metric for
    // it, it should show the vessels wind equipment" — when the box is her.
    it('Current Location (the phone) never reads the boat’s instruments, even with her on screen', async () => {
        mocks.releasePlugin();
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
        const mapbox = phoneHarness(14);
        instruments.followed = false;
        nmea.live({ tws: 14, twd: 200, latitude: AIRLIE.lat, longitude: AIRLIE.lng });
        const view = render(
            <MapboxVelocityOverlay
                mapboxMap={mapbox.map as never}
                visible
                windGrid={airlieGrid(8, 135)}
                windHour={0}
                windNowIdx={0}
                boatInstruments
            />,
        );
        expect(getCloseInWindReadout()).toMatchObject({ source: 'model' });
        expect(getCloseInWindReadout()!.kt).toBeCloseTo(8, 3);
        view.unmount();
    });

    it('a place chosen in the box never reads them either', async () => {
        mocks.releasePlugin();
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
        const mapbox = phoneHarness(14);
        nmea.live({ tws: 14, twd: 200, latitude: AIRLIE.lat, longitude: AIRLIE.lng });
        const view = render(
            <MapboxVelocityOverlay
                mapboxMap={mapbox.map as never}
                visible
                windGrid={airlieGrid(8, 135)}
                windHour={0}
                windNowIdx={0}
                boatInstruments={false}
            />,
        );
        expect(getCloseInWindReadout()).toMatchObject({ source: 'model' });
        // Back to Current Location following her: her instruments at once.
        view.rerender(
            <MapboxVelocityOverlay
                mapboxMap={mapbox.map as never}
                visible
                windGrid={airlieGrid(8, 135)}
                windHour={0}
                windNowIdx={0}
                boatInstruments
            />,
        );
        expect(getCloseInWindReadout()).toMatchObject({ source: 'boat', kt: 14 });
        view.unmount();
    });

    it('re-reads at once when the follow target changes', async () => {
        mocks.releasePlugin();
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
        const mapbox = phoneHarness(14);
        nmea.live({ tws: 14, twd: 200, latitude: AIRLIE.lat, longitude: AIRLIE.lng });
        const view = render(
            <MapboxVelocityOverlay
                mapboxMap={mapbox.map as never}
                visible
                windGrid={airlieGrid(8, 135)}
                windHour={0}
                windNowIdx={0}
                boatInstruments
            />,
        );
        expect(getCloseInWindReadout()).toMatchObject({ source: 'boat' });
        instruments.followed = false;
        act(() => {
            window.dispatchEvent(new CustomEvent('thalassa:weather-follow-target-changed'));
        });
        expect(getCloseInWindReadout()).toMatchObject({ source: 'model' });
        view.unmount();
    });

    it('MOB hides it at once, with nothing left fading over the casualty', () => {
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
        const mapbox = phoneHarness(14);
        const props = { mapboxMap: mapbox.map as never, windGrid: airlieGrid(), windHour: 0, windNowIdx: 0 };
        const view = render(<MapboxVelocityOverlay {...props} visible />);
        expect(closeInElement(mapbox)).not.toBeNull();
        view.rerender(<MapboxVelocityOverlay {...props} visible={false} />);
        expect(closeInElement(mapbox)).toBeNull();
        expect(getCloseInWindReadout()).toBeNull();
        expect(mapbox.listeners.size).toBe(0);
        // The skipper's wind comes back by itself when MOB clears.
        view.rerender(<MapboxVelocityOverlay {...props} visible />);
        expect(closeInElement(mapbox)).not.toBeNull();
        view.unmount();
    });

    it('prefers-reduced-motion shows the static arrow field', () => {
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
        const matchMedia = vi.spyOn(window, 'matchMedia').mockImplementation(
            (query: string) =>
                ({
                    matches: query.includes('prefers-reduced-motion'),
                    media: query,
                    addEventListener: vi.fn(),
                    removeEventListener: vi.fn(),
                }) as unknown as MediaQueryList,
        );
        const mapbox = phoneHarness(14);
        const view = render(
            <MapboxVelocityOverlay
                mapboxMap={mapbox.map as never}
                visible
                windGrid={airlieGrid()}
                windHour={0}
                windNowIdx={0}
            />,
        );
        expect(closeInElement(mapbox)?.dataset.motion).toBe('static');
        view.unmount();
        matchMedia.mockRestore();
    });

    it('cannot engage without a measured viewport or a grid to measure against', () => {
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
        const unmeasured = createMapboxHarness(14);
        const a = render(
            <MapboxVelocityOverlay
                mapboxMap={unmeasured.map as never}
                visible
                windGrid={airlieGrid()}
                windHour={0}
                windNowIdx={0}
            />,
        );
        expect(closeInElement(unmeasured)).toBeNull();
        a.unmount();
        const noGrid = phoneHarness(14);
        const b = render(<MapboxVelocityOverlay mapboxMap={noGrid.map as never} visible windHour={0} windNowIdx={0} />);
        expect(closeInElement(noGrid)).toBeNull();
        b.unmount();
    });
});

describe('MapboxVelocityOverlay close-in mode and a model switch', () => {
    afterEach(() => {
        nmea.reset();
        vi.restoreAllMocks();
    });

    it('a cleared grid removes the close-in streaks at once instead of fading the old model out', () => {
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
        const mapbox = phoneHarness(14);
        const props = { mapboxMap: mapbox.map as never, visible: true, windHour: 0, windNowIdx: 0 };
        const view = render(<MapboxVelocityOverlay {...props} windGrid={airlieGrid()} />);
        expect(closeInElement(mapbox)).not.toBeNull();
        view.rerender(<MapboxVelocityOverlay {...props} windGrid={undefined} />);
        expect(closeInElement(mapbox)).toBeNull();
        expect(getCloseInWindReadout()).toBeNull();
        // The new model's grid brings it straight back, sampled from that grid.
        view.rerender(<MapboxVelocityOverlay {...props} windGrid={airlieGrid(12, 90)} />);
        expect(closeInElement(mapbox)).not.toBeNull();
        expect(getCloseInWindReadout()!.kt).toBeCloseTo(12, 3);
        expect(getCloseInWindReadout()!.fromDeg).toBeCloseTo(90, 3);
        view.unmount();
    });
});

describe('MapboxVelocityOverlay close-in: the camera decides, not the cached lattice', () => {
    afterEach(() => {
        nmea.reset();
        vi.restoreAllMocks();
    });

    /** A 3x3 lattice centred on Airlie at `spacingDeg`, 8 kt from the SE: the shapes the chart really caches. */
    function lattice(spacingDeg: number): WindGrid {
        const fine = airlieGrid();
        const axis = (centre: number) => [centre - spacingDeg, centre, centre + spacingDeg];
        const lats = axis(AIRLIE.lat);
        const lons = axis(AIRLIE.lng);
        return {
            ...fine,
            u: fine.u.map((f) => f.slice(0, 9)),
            v: fine.v.map((f) => f.slice(0, 9)),
            speed: fine.speed.map((f) => f.slice(0, 9)),
            width: 3,
            height: 3,
            lats,
            lons,
            south: lats[0],
            north: lats[2],
            west: lons[0],
            east: lons[2],
            refTime: `lattice-${spacingDeg}`,
        };
    }

    it('a pinch out on the old viewport lattice holds close-in, and the refetch does not flip it back', async () => {
        // Review 2026-10-06: a z11+ viewport fetch is a 3x3 lattice ~1.25 screens
        // across. Measured against it, a pinch out of one level read 2.5 cells and
        // exited, leaflet booted, then the refetch at 1.25 cells re-entered.
        mocks.releasePlugin();
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
        const mapbox = phoneHarness(12);
        const mapsBefore = mocks.fields.length;
        const props = { mapboxMap: mapbox.map as never, visible: true, windHour: 0, windNowIdx: 0 };
        const view = render(<MapboxVelocityOverlay {...props} windGrid={lattice(0.08)} />);
        const closeIn = closeInElement(mapbox);
        expect(closeIn).not.toBeNull();
        settleAt(mapbox, 11);
        expect(getCloseInWindReadout()).toMatchObject({ source: 'model' });
        expect(closeInElement(mapbox)).toBe(closeIn);
        // The z11 refetch, then a model's own grid, then the coarse warm grid: no flips.
        view.rerender(<MapboxVelocityOverlay {...props} windGrid={lattice(0.16)} />);
        expect(getCloseInWindReadout()).not.toBeNull();
        view.rerender(<MapboxVelocityOverlay {...props} windGrid={airlieGrid(12, 90)} />);
        expect(getCloseInWindReadout()!.kt).toBeCloseTo(12, 3);
        view.rerender(<MapboxVelocityOverlay {...props} windGrid={lattice(2.083)} />);
        expect(getCloseInWindReadout()).not.toBeNull();
        expect(closeInElement(mapbox)).toBe(closeIn);
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 50));
        });
        expect(mocks.fields.length).toBe(mapsBefore);
        view.unmount();
    });

    it('drops a boat reading that went dead without a store notification', () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
        try {
            vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
            const mapbox = phoneHarness(14);
            nmea.live({ tws: 14, twd: 200, latitude: AIRLIE.lat, longitude: AIRLIE.lng });
            const view = render(
                <MapboxVelocityOverlay
                    mapboxMap={mapbox.map as never}
                    visible
                    windGrid={airlieGrid()}
                    windHour={0}
                    windNowIdx={0}
                    boatInstruments
                />,
            );
            expect(getCloseInWindReadout()).toMatchObject({ source: 'boat', stale: false });
            // No more samples and no notification (no watchdog running): the
            // overlay's own re-check still moves the readout through the tiers.
            act(() => vi.advanceTimersByTime(9_000));
            expect(getCloseInWindReadout()).toMatchObject({ source: 'boat', stale: true });
            act(() => vi.advanceTimersByTime(5_000));
            expect(getCloseInWindReadout()).toMatchObject({ source: 'model' });
            expect(getCloseInWindReadout()!.kt).toBeCloseTo(8, 3);
            view.unmount();
        } finally {
            vi.useRealTimers();
        }
    });
});

/**
 * Shane 2026-10-07, on build 121 at home, the boat in a marina far up the
 * coast with her Pi publishing: "when you use your vessel as your location,
 * the wind in obs at zoom 14 no longer uses the vessels wind data, even if it
 * knows it". Ashore nothing feeds the instrument store on Obs, so the close-in
 * wind takes the followed boat's own row from the boat chain the camera and
 * the marker already read. Fictional values.
 */
describe('MapboxVelocityOverlay close-in: the followed boat’s wind ashore', () => {
    const cloudWind = (kt = 14, fromDeg: number | null = 200) => ({
        wind: { kt, fromDeg, stale: false },
        lat: AIRLIE.lat,
        lon: AIRLIE.lng,
    });

    afterEach(() => {
        nmea.reset();
        instruments.followed = true;
        instruments.cloud = null;
        instruments.lookUp.mockReset();
        instruments.lookUp.mockImplementation(async () => {});
        vi.restoreAllMocks();
    });

    function renderAshore(props: Partial<ComponentProps<typeof MapboxVelocityOverlay>> = {}) {
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
        const mapbox = phoneHarness(14);
        const all = {
            mapboxMap: mapbox.map as never,
            visible: true,
            windGrid: airlieGrid(8, 135, 20),
            windHour: 0,
            windNowIdx: 0,
            boatInstruments: true,
            boatLookUp: true,
            ...props,
        };
        const view = render(<MapboxVelocityOverlay {...all} />);
        return { mapbox, view, all };
    }

    it('an empty store and her cloud row: the boat’s instruments, at her row’s position', () => {
        // The store is disconnected (nothing feeds it on Obs ashore); the gate on it says no.
        instruments.followed = false;
        instruments.cloud = cloudWind();
        const { view } = renderAshore();
        expect(getCloseInWindReadout()).toEqual({ kt: 14, fromDeg: 200, source: 'boat', stale: false });
        view.unmount();
    });

    it('her live store wind beats her cloud row (the LAN or the bus is the fresher lane)', () => {
        nmea.live({ tws: 9, twd: 170, latitude: AIRLIE.lat, longitude: AIRLIE.lng });
        instruments.cloud = cloudWind();
        const { view } = renderAshore();
        expect(getCloseInWindReadout()).toMatchObject({ kt: 9, fromDeg: 170, source: 'boat' });
        view.unmount();
    });

    it('her wind off the store’s cloud lane is never taken: her dated row speaks, else the model', () => {
        // A screen holds the cloud lane; the store stamps that reading with the
        // time the phone received it, so only the chain's dated row may speak.
        nmea.state.remote = { via: 'cloud' };
        nmea.state.connectionStatus = 'remote';
        nmea.live({ tws: 12, twd: 300, latitude: AIRLIE.lat, longitude: AIRLIE.lng });
        const a = renderAshore();
        expect(getCloseInWindReadout()).toMatchObject({ source: 'model' });
        expect(getCloseInWindReadout()!.kt).toBeCloseTo(8, 3);
        // Her row is asked for, since the store's wind does not count.
        expect(instruments.lookUp).toHaveBeenCalled();
        a.view.unmount();
        instruments.cloud = cloudWind();
        const b = renderAshore();
        expect(getCloseInWindReadout()).toEqual({ kt: 14, fromDeg: 200, source: 'boat', stale: false });
        b.view.unmount();
    });

    it('a store wind that is not hers is ignored, and her row still speaks', () => {
        // e.g. crewing: the store holds the own boat's row while the box follows the crewed boat.
        instruments.followed = false;
        nmea.live({ tws: 9, twd: 170, latitude: AIRLIE.lat, longitude: AIRLIE.lng });
        instruments.cloud = cloudWind(22, 90);
        const { view } = renderAshore();
        expect(getCloseInWindReadout()).toMatchObject({ kt: 22, fromDeg: 90, source: 'boat' });
        view.unmount();
    });

    it('her row off screen does not speak for the water on screen', () => {
        instruments.cloud = { ...cloudWind(), lon: 150 };
        const { mapbox, view } = renderAshore();
        mapbox.map.project.mockImplementation(([lng]: [number, number]) =>
            lng === 150 ? { x: 2000, y: 80 } : { x: 100, y: 80 },
        );
        act(() => mapbox.emit('moveend'));
        expect(getCloseInWindReadout()).toMatchObject({ source: 'model' });
        expect(getCloseInWindReadout()!.kt).toBeCloseTo(8, 3);
        view.unmount();
    });

    it('scrubbed off now: the model for that hour, never her row', () => {
        instruments.cloud = cloudWind();
        const { view, all } = renderAshore();
        expect(getCloseInWindReadout()).toMatchObject({ source: 'boat' });
        view.rerender(<MapboxVelocityOverlay {...all} windHour={1} />);
        expect(getCloseInWindReadout()).toMatchObject({ source: 'model' });
        expect(getCloseInWindReadout()!.kt).toBeCloseTo(20, 3);
        view.unmount();
    });

    it('the box on a place (boatInstruments false): the model, and her row is never asked for', async () => {
        instruments.cloud = cloudWind();
        const { view } = renderAshore({ boatInstruments: false });
        expect(getCloseInWindReadout()).toMatchObject({ source: 'model' });
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 20));
        });
        expect(instruments.lookUp).not.toHaveBeenCalled();
        view.unmount();
    });

    it('looks her row up at once and every re-check while Obs is showing; never while it is hidden', () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
        try {
            const { view, all } = renderAshore({ boatLookUp: false });
            act(() => vi.advanceTimersByTime(10_000));
            expect(instruments.lookUp).not.toHaveBeenCalled();
            view.rerender(<MapboxVelocityOverlay {...all} boatLookUp />);
            expect(instruments.lookUp).toHaveBeenCalledTimes(1);
            act(() => vi.advanceTimersByTime(4_000));
            expect(instruments.lookUp).toHaveBeenCalledTimes(3);
            // Another view over the chart (MapHub stays mounted): the lookups stop.
            view.rerender(<MapboxVelocityOverlay {...all} boatLookUp={false} />);
            act(() => vi.advanceTimersByTime(10_000));
            expect(instruments.lookUp).toHaveBeenCalledTimes(3);
            // Wind off: nothing either. (Zoomed out of close-in it still asks: her
            // wind then rides on her icon, W1-WC.)
            view.rerender(<MapboxVelocityOverlay {...all} boatLookUp visible={false} />);
            const before = instruments.lookUp.mock.calls.length;
            act(() => vi.advanceTimersByTime(10_000));
            expect(instruments.lookUp).toHaveBeenCalledTimes(before);
            view.unmount();
        } finally {
            vi.useRealTimers();
        }
    });

    it('aboard, with her own wind live in the store, her cloud row is not read at all', () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
        try {
            nmea.live({ tws: 9, twd: 170, latitude: AIRLIE.lat, longitude: AIRLIE.lng });
            const { view } = renderAshore();
            expect(getCloseInWindReadout()).toMatchObject({ kt: 9, source: 'boat' });
            act(() => {
                vi.advanceTimersByTime(1_900);
                nmea.live({ tws: 9, twd: 170 });
                vi.advanceTimersByTime(100);
            });
            expect(instruments.lookUp).not.toHaveBeenCalled();
            // The store goes quiet (dead): the re-check asks for her row again.
            act(() => vi.advanceTimersByTime(16_000));
            expect(instruments.lookUp).toHaveBeenCalled();
            view.unmount();
        } finally {
            vi.useRealTimers();
        }
    });

    it('picks up her row when a lookup lands, and goes back to the model when it ages out', async () => {
        let land!: () => void;
        instruments.lookUp.mockImplementationOnce(
            () =>
                new Promise<void>((resolve) => {
                    land = resolve;
                }),
        );
        const { view } = renderAshore();
        expect(getCloseInWindReadout()).toMatchObject({ source: 'model' });
        instruments.cloud = cloudWind();
        await act(async () => {
            land();
            await Promise.resolve();
        });
        expect(getCloseInWindReadout()).toMatchObject({ source: 'boat', kt: 14 });
        // Her row past its gate: the chain answers nothing, and the next re-check hands back.
        instruments.cloud = null;
        await waitFor(() => expect(getCloseInWindReadout()).toMatchObject({ source: 'model' }), { timeout: 3_000 });
        view.unmount();
    });

    it('a lookup that lands after the close-in field has gone changes nothing', async () => {
        let land!: () => void;
        instruments.lookUp.mockImplementationOnce(
            () =>
                new Promise<void>((resolve) => {
                    land = resolve;
                }),
        );
        const { view } = renderAshore();
        view.unmount();
        instruments.cloud = cloudWind();
        await act(async () => {
            land();
            await Promise.resolve();
        });
        expect(getCloseInWindReadout()).toBeNull();
        expect(getBoatWindReadout()).toBeNull();
    });
});

/**
 * Build 123, W1-WC. Shane 2026-10-07: "what about if it is just the highest
 * zoom (14) as soon as the punter zooms out from there, then the wind models
 * kick in??", then "go do it", on the recommendation that her reading moves
 * onto her own boat icon once the models take over. The overlay publishes her
 * wind with the field's own reading (boatWindReadout), and her marker shows it
 * wherever the field does not: below 14 in close-in, and in the leaflet field
 * further out. The two must never both claim her wind. Fictional values.
 */
describe('MapboxVelocityOverlay: her wind rides on her icon wherever the field is not showing it', () => {
    const OWN = { kind: 'boat', crewOwnerId: null } as const;
    /** What her marker would show now (the marker's own decision over the published readout). */
    const chip = () => boatWindChipFor(getBoatWindReadout(), OWN, 'kts');
    const fieldIsHers = () => getCloseInWindReadout()?.source === 'boat';

    afterEach(() => {
        nmea.reset();
        instruments.followed = true;
        instruments.boat = { crewOwnerId: null };
        instruments.cloud = null;
        instruments.lookUp.mockReset();
        instruments.lookUp.mockImplementation(async () => {});
        vi.restoreAllMocks();
    });

    function renderAt(zoom: number, props: Partial<ComponentProps<typeof MapboxVelocityOverlay>> = {}) {
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
        const mapbox = phoneHarness(zoom);
        const all = {
            mapboxMap: mapbox.map as never,
            visible: true,
            windGrid: airlieGrid(8, 135, 20),
            windHour: 0,
            windNowIdx: 0,
            boatInstruments: true,
            ...props,
        };
        const view = render(<MapboxVelocityOverlay {...all} />);
        return { mapbox, view, all };
    }

    const herLive = () => nmea.live({ tws: 14, twd: 200, latitude: AIRLIE.lat, longitude: AIRLIE.lng });

    it('zoom 14 with her live: the field is hers, and her icon carries nothing', () => {
        herLive();
        const { view } = renderAt(14);
        expect(getCloseInWindReadout()).toMatchObject({ source: 'boat', kt: 14 });
        expect(getBoatWindReadout()).toEqual({
            wind: { kt: 14, fromDeg: 200, stale: false },
            boat: { crewOwnerId: null },
            fieldShowsHers: true,
        });
        expect(chip()).toBeNull();
        view.unmount();
    });

    it('zoom 13 with her live: the model paints the field, her reading rides on her icon', () => {
        herLive();
        const { view } = renderAt(13);
        expect(getCloseInWindReadout()).toMatchObject({ source: 'model' });
        expect(chip()).toEqual({
            text: '14 kt SSW',
            arrowDeg: 20,
            stale: false,
            label: 'Boat wind 14 knots from south-south-west',
        });
        view.unmount();
    });

    it('zoom 8, the leaflet field: her reading rides on her icon, and keeps up with her instruments', () => {
        herLive();
        const { view } = renderAt(8);
        expect(getCloseInWindReadout()).toBeNull();
        expect(chip()).toMatchObject({ text: '14 kt SSW', arrowDeg: 20 });
        act(() => nmea.live({ tws: 16, twd: 210 }));
        expect(chip()).toMatchObject({ text: '16 kt SSW', arrowDeg: 30 });
        view.unmount();
        expect(getBoatWindReadout()).toBeNull();
        expect(nmea.listenerCount()).toBe(0);
    });

    it('scrubbed away from now: nothing on her icon, in close-in or out; back at now, at once', () => {
        herLive();
        const a = renderAt(13);
        a.view.rerender(<MapboxVelocityOverlay {...a.all} windHour={1} />);
        expect(getBoatWindReadout()).toBeNull();
        a.view.rerender(<MapboxVelocityOverlay {...a.all} windHour={0} />);
        expect(chip()).toMatchObject({ text: '14 kt SSW' });
        a.view.unmount();

        const b = renderAt(8, { windHour: 1 });
        expect(getBoatWindReadout()).toBeNull();
        b.view.rerender(<MapboxVelocityOverlay {...b.all} windHour={0} />);
        expect(chip()).toMatchObject({ text: '14 kt SSW' });
        b.view.unmount();
    });

    it('the box on Current Location or on a chosen place: nothing on any icon', () => {
        herLive();
        instruments.followed = false;
        instruments.boat = null;
        const a = renderAt(8);
        expect(getBoatWindReadout()).toBeNull();
        a.view.unmount();

        instruments.followed = true;
        instruments.boat = { crewOwnerId: null };
        const b = renderAt(8, { boatInstruments: false });
        expect(getBoatWindReadout()).toBeNull();
        b.view.rerender(<MapboxVelocityOverlay {...b.all} boatInstruments />);
        expect(chip()).toMatchObject({ text: '14 kt SSW' });
        // The box moves to the phone: her icon lets go at once.
        instruments.followed = false;
        instruments.boat = null;
        act(() => {
            window.dispatchEvent(new CustomEvent('thalassa:weather-follow-target-changed'));
        });
        expect(getBoatWindReadout()).toBeNull();
        b.view.unmount();
    });

    it('the boat crewed on: her own row’s wind, published as hers, never on the own boat’s icon', () => {
        // The store holds the own boat's wind; the box follows the boat crewed on.
        instruments.followed = false;
        herLive();
        instruments.boat = { crewOwnerId: 'skipper-wind-dancer' };
        instruments.cloud = { wind: { kt: 22, fromDeg: 90, stale: false }, lat: AIRLIE.lat, lon: AIRLIE.lng };
        const { view } = renderAt(8);
        expect(getBoatWindReadout()).toMatchObject({
            wind: { kt: 22, fromDeg: 90 },
            boat: { crewOwnerId: 'skipper-wind-dancer' },
        });
        expect(chip()).toBeNull();
        expect(
            boatWindChipFor(getBoatWindReadout(), { kind: 'boat', crewOwnerId: 'skipper-wind-dancer' }, 'kts'),
        ).toMatchObject({ text: '22 kt E' });
        view.unmount();
    });

    it('her cloud row past its 60 s gate: off her icon at the next re-check', () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
        try {
            instruments.followed = false;
            instruments.cloud = { wind: { kt: 12, fromDeg: 45, stale: false }, lat: AIRLIE.lat, lon: AIRLIE.lng };
            const { view } = renderAt(8);
            expect(chip()).toMatchObject({ text: '12 kt NE' });
            // The chain says her row's wind is no longer hers to speak for.
            instruments.cloud = null;
            act(() => vi.advanceTimersByTime(2_000));
            expect(getBoatWindReadout()).toBeNull();
            view.unmount();
        } finally {
            vi.useRealTimers();
        }
    });

    it('the stale tier is shown, marked stale; dead is gone, with no store notification needed', () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
        try {
            herLive();
            const { view } = renderAt(8);
            expect(chip()).toMatchObject({ text: '14 kt SSW', stale: false });
            act(() => vi.advanceTimersByTime(9_000));
            expect(chip()).toMatchObject({ text: '14 kt SSW', stale: true });
            expect(chip()!.label).toMatch(/\bstale\b/i);
            act(() => vi.advanceTimersByTime(5_000));
            expect(getBoatWindReadout()).toBeNull();
            view.unmount();
        } finally {
            vi.useRealTimers();
        }
    });

    it('in close-in below 14, too, her reading ages off her icon on the re-check', () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
        try {
            herLive();
            const { view } = renderAt(13);
            expect(chip()).toMatchObject({ stale: false });
            act(() => vi.advanceTimersByTime(9_000));
            expect(chip()).toMatchObject({ stale: true });
            act(() => vi.advanceTimersByTime(5_000));
            expect(getBoatWindReadout()).toBeNull();
            expect(getCloseInWindReadout()).toMatchObject({ source: 'model' });
            view.unmount();
        } finally {
            vi.useRealTimers();
        }
    });

    it('calm: Calm, with no arrow', () => {
        nmea.live({ tws: 0.4, latitude: AIRLIE.lat, longitude: AIRLIE.lng });
        const { view } = renderAt(8);
        expect(chip()).toMatchObject({ text: 'Calm', arrowDeg: null, label: 'Boat wind calm' });
        view.unmount();
    });

    it('no direction: a breeze the pickers cannot place is on neither the field nor her icon', () => {
        // TWS with no TWD and no true heading: the close-in field's own pickers
        // refuse it (an arrowless 6 kt would be a guess), so the field shows the
        // model at 14 and her icon shows nothing anywhere: the two agree.
        nmea.live({ tws: 6, latitude: AIRLIE.lat, longitude: AIRLIE.lng });
        const a = renderAt(14);
        expect(getCloseInWindReadout()).toMatchObject({ source: 'model' });
        expect(getBoatWindReadout()).toBeNull();
        a.view.unmount();
        const b = renderAt(8);
        expect(getBoatWindReadout()).toBeNull();
        b.view.unmount();
    });

    it('wind off (or MOB): gone from her icon at once, and back when it returns', () => {
        herLive();
        const { view, all } = renderAt(8);
        expect(chip()).not.toBeNull();
        view.rerender(<MapboxVelocityOverlay {...all} visible={false} />);
        expect(getBoatWindReadout()).toBeNull();
        view.rerender(<MapboxVelocityOverlay {...all} visible />);
        expect(chip()).toMatchObject({ text: '14 kt SSW' });
        view.unmount();
    });

    it('asks for her row in the leaflet field too while Obs is showing, on the shared throttle; never off Obs', () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
        try {
            instruments.followed = false;
            const { view, all } = renderAt(8, { boatLookUp: false });
            act(() => vi.advanceTimersByTime(6_000));
            expect(instruments.lookUp).not.toHaveBeenCalled();
            view.rerender(<MapboxVelocityOverlay {...all} boatLookUp />);
            expect(instruments.lookUp).toHaveBeenCalledTimes(1);
            act(() => vi.advanceTimersByTime(4_000));
            expect(instruments.lookUp).toHaveBeenCalledTimes(3);
            view.unmount();
        } finally {
            vi.useRealTimers();
        }
    });

    it('a pinch 14 → 13 → 14 (and out to the leaflet field): the field and her icon never both claim her wind', () => {
        herLive();
        const seen: string[] = [];
        const look = () => {
            const field = fieldIsHers();
            const icon = chip() !== null;
            seen.push(field && icon ? 'BOTH' : field ? 'field' : icon ? 'icon' : 'neither');
        };
        const unsubscribeField = subscribeCloseInWindReadout(look);
        const unsubscribeIcon = subscribeBoatWindReadout(look);
        const { mapbox, view } = renderAt(14);
        expect(fieldIsHers()).toBe(true);
        expect(chip()).toBeNull();

        // Mid-pinch the camera passes under 14: nothing is judged until it settles.
        const map = mapbox.map as unknown as { isMoving?: () => boolean };
        map.isMoving = () => true;
        mapbox.map.getZoom.mockReturnValue(13.4);
        act(() => nmea.live({ tws: 15, twd: 205 }));
        expect(fieldIsHers()).toBe(true);
        expect(chip()).toBeNull();

        // Settled at 13: the model paints the field; her reading is on her icon.
        map.isMoving = () => false;
        settleAt(mapbox, 13);
        expect(getCloseInWindReadout()).toMatchObject({ source: 'model' });
        expect(chip()).toMatchObject({ text: '15 kt SSW' });

        // Back in to 14: the field takes her wind, and her icon lets go.
        settleAt(mapbox, 14);
        expect(fieldIsHers()).toBe(true);
        expect(chip()).toBeNull();

        // Out to the leaflet field and back in.
        settleAt(mapbox, 8);
        expect(getCloseInWindReadout()).toBeNull();
        expect(chip()).toMatchObject({ text: '15 kt SSW' });
        settleAt(mapbox, 14);
        expect(fieldIsHers()).toBe(true);
        expect(chip()).toBeNull();

        expect(seen).not.toContain('BOTH');
        expect(seen).toContain('field');
        expect(seen).toContain('icon');
        unsubscribeField();
        unsubscribeIcon();
        view.unmount();
    });

    it('a flick out of close-in: the fading field lets go of her wind before her icon takes it', () => {
        herLive();
        // What the close-in canvas is drawing, call by call (the real layer, spied through).
        const setWind = vi.spyOn(CloseInWindLayer.prototype, 'setWind');
        const painted = () => (setWind.mock.calls.at(-1)?.[0] ?? null) as { kt: number; source?: string } | null;
        const { mapbox, view } = renderAt(14);
        expect(painted()).toMatchObject({ source: 'boat', kt: 14 });
        expect(chip()).toBeNull();
        const seen: string[] = [];
        const unsubscribe = subscribeBoatWindReadout(() => {
            if (chip() !== null && painted()?.source === 'boat') seen.push('BOTH');
        });

        // A flick out to the leaflet field: Mapbox ends the zoom while the
        // inertia still carries the camera, so zoomend lands with the map
        // still moving and moveend comes later.
        const map = mapbox.map as unknown as { isMoving?: () => boolean };
        map.isMoving = () => true;
        act(() => {
            mapbox.map.getZoom.mockReturnValue(8);
            mapbox.emit('zoomend');
        });
        // Close-in let go: its field fades out over the leaflet model, and her
        // reading is on her icon.
        expect(closeInElement(mapbox)).not.toBeNull();
        expect(getCloseInWindReadout()).toBeNull();
        expect(chip()).toMatchObject({ text: '14 kt SSW' });
        // The fading field paints the model at the centre, never her reading a second time.
        expect(painted()?.source).not.toBe('boat');
        expect(painted()!.kt).toBeCloseTo(8, 3);
        expect(seen).not.toContain('BOTH');

        map.isMoving = () => false;
        act(() => mapbox.emit('moveend'));
        expect(chip()).toMatchObject({ text: '14 kt SSW' });
        unsubscribe();
        view.unmount();
    });

    it('a flick out while the field shows the model leaves the fading field alone', () => {
        // Her reading is out on her icon at 13; the field there is already the model's.
        herLive();
        const setWind = vi.spyOn(CloseInWindLayer.prototype, 'setWind');
        const { mapbox, view } = renderAt(13);
        expect(getCloseInWindReadout()).toMatchObject({ source: 'model' });
        const calls = setWind.mock.calls.length;
        const map = mapbox.map as unknown as { isMoving?: () => boolean };
        map.isMoving = () => true;
        act(() => {
            mapbox.map.getZoom.mockReturnValue(8);
            mapbox.emit('zoomend');
        });
        expect(closeInElement(mapbox)).not.toBeNull();
        expect(setWind.mock.calls.length).toBe(calls);
        expect(chip()).toMatchObject({ text: '14 kt SSW' });
        view.unmount();
    });
});

// ── The desk's Light base (127-DESKMAP-b) ────────────────────────────────
