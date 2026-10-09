/**
 * Her own wind at z14 after a visit to another page.
 *
 * Shane 2026-10-09: "at times when you are on the vessel location at zoom 14,
 * the boat instruments do not always show. sometimes it is the model.?? it is
 * very rare, and never on startup, but when you have been to other pages."
 *
 * The path walked here: Obs at z14 on her, her instruments painting the field;
 * another page (the chart <main> goes display:none, App.tsx, and MapHub and
 * the overlay stay mounted); a wind grid is published while the chart is
 * hidden; back to Obs with the camera where it was. The mode decision then
 * read a 0x0 container, so close-in went off and the leaflet model engine took
 * the field. On the way back the map only resizes (moveend, never zoomend), so
 * nothing decided the mode again until the next pinch or grid publish.
 *
 * The fix (125-18): a hidden chart holds the mode it had and keeps her on
 * screen as last measured (the same boat, at the same spot, under the same
 * camera); the chart shown again decides from its resize; the zoom gate's
 * slack survives a mode flip the camera did not cause; and the wind pipeline
 * fetches and publishes nothing for a hidden chart's phantom view.
 *
 * Harness: the fake Mapbox map, leaflet, the instrument store and the
 * followed-boat lookups follow tests/MapboxVelocityOverlayLifecycle.test.tsx.
 * The end-to-end case also runs the real WindStore and WindDataController,
 * with only the Open-Meteo fetch faked. Every position and reading is
 * fictional.
 */
import { act, cleanup, render } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WindGrid } from '../services/weather/windGridEncoding';

const mocks = vi.hoisted(() => {
    const leafletMaps: unknown[] = [];
    const velocityLayer = vi.fn(() => {
        const layer = { _windy: { setData: vi.fn() }, addTo: vi.fn() };
        layer.addTo.mockImplementation((map: { __layers: Set<unknown> }) => {
            map.__layers.add(layer);
            return layer;
        });
        return layer;
    });
    const map = vi.fn(() => {
        const panes = { tilePane: { style: {} }, mapPane: { style: {} } };
        const leafletMap = {
            __layers: new Set<unknown>(),
            getPane: vi.fn((name: keyof typeof panes) => panes[name] ?? null),
            hasLayer: vi.fn(),
            invalidateSize: vi.fn(),
            latLngToContainerPoint: vi.fn(() => ({ x: 100, y: 80 })),
            remove: vi.fn(),
            removeLayer: vi.fn(),
            setView: vi.fn(),
        };
        leafletMap.hasLayer.mockImplementation((layer: unknown) => leafletMap.__layers.has(layer));
        leafletMap.removeLayer.mockImplementation((layer: unknown) => {
            leafletMap.__layers.delete(layer);
            return leafletMap;
        });
        leafletMap.remove.mockImplementation(() => leafletMap.__layers.clear());
        leafletMap.setView.mockReturnValue(leafletMap);
        leafletMaps.push(leafletMap);
        return leafletMap;
    });
    return {
        leaflet: { map, velocityLayer },
        leafletMaps,
        logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    };
});

vi.mock('leaflet', () => ({ default: mocks.leaflet }));
vi.mock('leaflet-velocity-ts', () => ({}));
vi.mock('../utils/createLogger', () => ({ createLogger: () => mocks.logger }));

// The instrument store, empty, as it is on Obs ashore.
const nmea = vi.hoisted(() => {
    const empty = () => ({ value: null, lastUpdated: 0, freshness: 'dead' });
    const listeners = new Set<() => void>();
    const store = {
        state: {} as Record<string, unknown>,
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
        },
        NmeaStore: {
            getState: () => store.state,
            isBoatFeed: () => false,
            getRemoteWindSample: () => null,
            getRemoteFeedEndedAt: () => 0,
            subscribe: (listener: () => void) => {
                listeners.add(listener);
                return () => listeners.delete(listener);
            },
        },
    };
    store.reset();
    return store;
});
vi.mock('../services/NmeaStore', () => ({ NmeaStore: nmea.NmeaStore }));

// Ashore, the box on her: her wind is her own cloud row through the boat chain.
const instruments = vi.hoisted(() => ({
    followed: false,
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

// The wind pipeline's network, faked: any box, any resolution, 8 kt from the SE.
const net = vi.hoisted(() => ({ fetchModelWindGrid: vi.fn() }));
vi.mock('../services/weather/OpenMeteoWindFetcher', () => ({ fetchModelWindGrid: net.fetchModelWindGrid }));
vi.mock('../services/weather/windField', () => ({ fetchWindGrid: vi.fn(), fetchGlobalWindField: vi.fn() }));
vi.mock('../services/weather/GribWindParser', () => ({ loadLocalWindFile: vi.fn() }));
vi.mock('../utils/deadline', () => ({ withDeadline: <T,>(promise: Promise<T>) => promise }));

import { MapboxVelocityOverlay } from '../components/map/MapboxVelocityOverlay';
import { closeInModeFor, getCloseInWindReadout } from '../components/map/closeInWind';
import { getBoatWindReadout } from '../components/map/boatWindReadout';
import { useWindStore, WindStore } from '../stores/WindStore';
import { LocationStore } from '../stores/LocationStore';
import { WindDataController, __windCacheForTest } from '../services/weather/WindDataController';

const AIRLIE = { lat: -20.27, lng: 148.72 };
const KT = 1852 / 3600;
const HOUR = 3_600_000;

interface Box {
    north: number;
    south: number;
    west: number;
    east: number;
}

/** A model grid over `box` at `res` degrees: `kt` from `fromDeg` everywhere, two hourly frames. */
function gridOver(box: Box, res: number, kt = 8, fromDeg = 135): WindGrid {
    const nx = Math.max(2, Math.round((box.east - box.west) / res) + 1);
    const ny = Math.max(2, Math.round((box.north - box.south) / res) + 1);
    const lons = Array.from({ length: nx }, (_, i) => box.west + (i * (box.east - box.west)) / (nx - 1));
    const lats = Array.from({ length: ny }, (_, i) => box.south + (i * (box.north - box.south)) / (ny - 1));
    const ms = kt * KT;
    const rad = (fromDeg * Math.PI) / 180;
    const frame = () => ({
        u: new Float32Array(nx * ny).fill(-ms * Math.sin(rad)),
        v: new Float32Array(nx * ny).fill(-ms * Math.cos(rad)),
        speed: new Float32Array(nx * ny).fill(ms),
    });
    const a = frame();
    const b = frame();
    return {
        u: [a.u, b.u],
        v: [a.v, b.v],
        speed: [a.speed, b.speed],
        width: nx,
        height: ny,
        lats,
        lons,
        north: box.north,
        south: box.south,
        west: box.west,
        east: box.east,
        totalHours: 2,
        refTime: 'ecmwf',
    };
}

/** The ±2 deg fine grid WindDataController warms around the location box. */
const FINE_BOX: Box = { north: AIRLIE.lat + 2, south: AIRLIE.lat - 2, west: AIRLIE.lng - 2, east: AIRLIE.lng + 2 };
const fineGrid = () => gridOver(FINE_BOX, 0.25);

/**
 * The Obs map at z14 on her, on a 390x844 phone. `view.shown` is the chart
 * <main>'s display: false is display:none (another page), where clientWidth
 * and clientHeight read 0. resize() is map.resize() as mapbox-gl 3.19 runs it
 * from useMapInit's ResizeObserver: the transform takes the container's size,
 * or 400x300 when the container measures 0, and it fires movestart, move,
 * resize and moveend, never zoomend.
 */
function obsMap() {
    // moving: Mapbox's isMoving(), for a flick whose zoomend lands while the inertia still carries the camera.
    const view = { shown: true, moving: false };
    const container = document.createElement('div');
    container.dataset.testBoatWindAfterPages = 'true';
    Object.defineProperty(container, 'clientWidth', { configurable: true, get: () => (view.shown ? 390 : 0) });
    Object.defineProperty(container, 'clientHeight', { configurable: true, get: () => (view.shown ? 844 : 0) });
    document.body.appendChild(container);
    const listeners = new Map<string, Set<() => void>>();
    const layers = new Map<string, unknown>();
    const sources = new Map<string, unknown>();
    let zoom = 14;
    let transform = { w: 390, h: 844 };
    const map = {
        addLayer: vi.fn((layer: { id: string }) => {
            layers.set(layer.id, layer);
            return map;
        }),
        addSource: vi.fn((id: string, options: unknown) => {
            sources.set(id, { options, updateImage: vi.fn() });
            return map;
        }),
        getBounds: () => {
            const degPerPx = 360 / (512 * Math.pow(2, zoom));
            const halfLon = (transform.w * degPerPx) / 2;
            const halfLat = (transform.h * degPerPx * Math.cos((AIRLIE.lat * Math.PI) / 180)) / 2;
            return {
                getNorth: () => AIRLIE.lat + halfLat,
                getSouth: () => AIRLIE.lat - halfLat,
                getWest: () => AIRLIE.lng - halfLon,
                getEast: () => AIRLIE.lng + halfLon,
            };
        },
        getCenter: () => AIRLIE,
        getContainer: () => container,
        getLayer: vi.fn((id: string) => layers.get(id)),
        getSource: vi.fn((id: string) => sources.get(id)),
        getStyle: () => ({ layers: [{ id: 'place-label', type: 'symbol' }] }),
        getZoom: () => zoom,
        isMoving: () => view.moving,
        on: (event: string, handler: () => void) => {
            const set = listeners.get(event) ?? new Set();
            set.add(handler);
            listeners.set(event, set);
            return map;
        },
        off: (event: string, handler: () => void) => {
            listeners.get(event)?.delete(handler);
            return map;
        },
        // The camera sits on her, so she (at the marina) is the middle of the
        // view; anything else lands where getBounds says it is.
        project: ([lon, lat]: [number, number]) => {
            const pxPerDeg = (512 * Math.pow(2, zoom)) / 360;
            return {
                x: transform.w / 2 + (lon - AIRLIE.lng) * pxPerDeg,
                y: transform.h / 2 - ((lat - AIRLIE.lat) * pxPerDeg) / Math.cos((AIRLIE.lat * Math.PI) / 180),
            };
        },
        removeLayer: vi.fn((id: string) => {
            layers.delete(id);
            return map;
        }),
        removeSource: vi.fn((id: string) => {
            sources.delete(id);
            return map;
        }),
    };
    const emit = (event: string) => {
        for (const handler of [...(listeners.get(event) ?? [])]) handler();
    };
    const resize = () => {
        transform = view.shown ? { w: 390, h: 844 } : { w: 400, h: 300 };
        emit('movestart');
        emit('move');
        emit('resize');
        emit('moveend');
    };
    /** A pinch or a flyTo landing at `z`: the settle Mapbox fires after a zoom. */
    const settleAt = (z: number) => {
        zoom = z;
        emit('zoom');
        emit('moveend');
        emit('zoomend');
    };
    return { map, view, container, emit, resize, settleAt };
}

type ObsMap = ReturnType<typeof obsMap>;

const closeInElement = (obs: ObsMap) => obs.container.querySelector('[data-close-in-wind="true"]');

/** Her row, fresh, at the marina: 14 kt from 200. */
const herRow = () => ({ wind: { kt: 14, fromDeg: 200, stale: false }, lat: AIRLIE.lat, lon: AIRLIE.lng });

/** Real time passing, with React flushed around it (the overlay's 2 s re-check, the controller's 800 ms moveend debounce). */
async function pass(ms: number): Promise<void> {
    await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, ms));
    });
}

/** What Shane sees at z14 on her: her wind paints the field, and the pill says Boat instruments. */
function expectHerWindPaintsTheField(obs: ObsMap, when = ''): void {
    const at = when ? ` [${when}]` : '';
    expect
        .soft(closeInElement(obs), `the close-in field (not the leaflet model engine) holds the screen${at}`)
        .not.toBeNull();
    expect.soft(getCloseInWindReadout(), `the pill: Wind · 14 kt · Boat · Boat instruments${at}`).toMatchObject({
        source: 'boat',
        kt: 14,
        fromDeg: 200,
    });
    expect.soft(getBoatWindReadout(), `her icon: the field shows her wind, so no chip${at}`).toMatchObject({
        fieldShowsHers: true,
    });
}

beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    nmea.reset();
    instruments.followed = false;
    instruments.boat = { crewOwnerId: null };
    instruments.cloud = herRow();
    instruments.lookUp.mockReset();
    instruments.lookUp.mockImplementation(async () => {});
});

afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.querySelectorAll('[data-test-boat-wind-after-pages="true"]').forEach((element) => element.remove());
});

describe('her z14 wind after another page: the overlay', () => {
    function renderObs(obs: ObsMap, windGrid: WindGrid) {
        const all: ComponentProps<typeof MapboxVelocityOverlay> = {
            mapboxMap: obs.map as never,
            visible: true,
            windGrid,
            windHour: 0,
            windNowIdx: 0,
            boatInstruments: true,
            boatLookUp: true,
        };
        const view = render(<MapboxVelocityOverlay {...all} />);
        const show = (props: Partial<typeof all>) => view.rerender(<MapboxVelocityOverlay {...all} {...props} />);
        return { view, show };
    }

    it('control: another page with no grid published meanwhile, and back: her wind again', async () => {
        const obs = obsMap();
        const grid = fineGrid();
        const { show } = renderObs(obs, grid);
        expectHerWindPaintsTheField(obs);

        act(() => {
            obs.view.shown = false;
            show({ boatLookUp: false });
        });
        act(() => obs.resize());
        await pass(300);

        act(() => {
            obs.view.shown = true;
            show({ boatLookUp: true });
        });
        act(() => obs.resize());
        await pass(2_500);
        expectHerWindPaintsTheField(obs);
    });

    it('a grid published while Obs is hidden (cleared, then the refetched fine grid): her wind again on return', async () => {
        const obs = obsMap();
        const { show } = renderObs(obs, fineGrid());
        expectHerWindPaintsTheField(obs);

        // Another page: the chart <main> goes display:none in the same commit
        // that turns obsShowing (boatLookUp) off; the overlay stays mounted.
        act(() => {
            obs.view.shown = false;
            show({ boatLookUp: false });
        });
        act(() => obs.resize());
        // While hidden the wind pipeline refreshes the same water: the fine
        // slot is past 3 h, so beginWindGridLoad clears the grid, and the
        // refetched fine grid is published (WindDataController).
        act(() => show({ boatLookUp: false, windGrid: undefined }));
        const refetched = fineGrid();
        act(() => show({ boatLookUp: false, windGrid: refetched }));
        await pass(300);
        // The hidden chart decides nothing: close-in holds. (On 9d693139 the
        // 0x0 container decided it off here, and the model took the field.)
        expect(closeInElement(obs)).not.toBeNull();

        // Back to Obs: the camera never moved, and nothing publishes again
        // (the refetched grid already covers her z14 view).
        act(() => {
            obs.view.shown = true;
            show({ boatLookUp: true, windGrid: refetched });
        });
        act(() => obs.resize());
        await pass(2_500);
        expectHerWindPaintsTheField(obs);

        // It is the mode decision, not her lane: any zoomend decides again and she is back.
        act(() => obs.settleAt(14));
        expect(getCloseInWindReadout()).toMatchObject({ source: 'boat', kt: 14 });
    });

    it('a grid swapped while Obs is hidden with no clear (a refinement, or another screen’s setGrid): her wind again on return', async () => {
        const obs = obsMap();
        const { show } = renderObs(obs, fineGrid());
        expectHerWindPaintsTheField(obs);

        act(() => {
            obs.view.shown = false;
            show({ boatLookUp: false });
        });
        act(() => obs.resize());
        const swapped = fineGrid();
        act(() => show({ boatLookUp: false, windGrid: swapped }));
        await pass(300);

        act(() => {
            obs.view.shown = true;
            show({ boatLookUp: true, windGrid: swapped });
        });
        act(() => obs.resize());
        await pass(2_500);
        expectHerWindPaintsTheField(obs);
    });

    it('the chart shown again decides the mode at once: its resize, with no zoomend and no grid publish', async () => {
        // The overlay first decided while the chart was hidden (MapHub mounted
        // behind another page): a 0x0 container could only say "not close-in".
        const obs = obsMap();
        obs.view.shown = false;
        const { show } = renderObs(obs, fineGrid());
        act(() => show({ boatLookUp: false }));
        act(() => obs.resize());
        expect(closeInElement(obs)).toBeNull();

        act(() => {
            obs.view.shown = true;
            show({ boatLookUp: true });
        });
        act(() => obs.resize());
        await pass(300);
        expectHerWindPaintsTheField(obs);
    });

    it('hidden, the 2 s re-check keeps her on screen as last measured; a lost row still hands the field to the model', async () => {
        const obs = obsMap();
        const { show } = renderObs(obs, fineGrid());
        expectHerWindPaintsTheField(obs);

        act(() => {
            obs.view.shown = false;
            show({ boatLookUp: false });
        });
        act(() => obs.resize());
        await pass(2_500);
        // A 0x0 chart is no answer to "is she on screen": the last measured one stands.
        expect(getCloseInWindReadout()).toMatchObject({ source: 'boat', kt: 14 });

        // Her row lost while Shane is away: hidden or not, the field is the model's.
        instruments.cloud = null;
        await pass(2_500);
        expect(getCloseInWindReadout()).toMatchObject({ source: 'model' });
        expect(getBoatWindReadout()).toBeNull();

        // Back to Obs with her row still lost: the model, and it says so.
        act(() => {
            obs.view.shown = true;
            show({ boatLookUp: true });
        });
        act(() => obs.resize());
        await pass(300);
        expect(getCloseInWindReadout()).toMatchObject({ source: 'model' });

        // Her row comes back on the next look-up: hers again.
        instruments.cloud = herRow();
        await pass(2_500);
        expectHerWindPaintsTheField(obs);
    });

    it('hidden, a new follow target (Switch boat) is not held as on screen: the other boat’s wind never paints this water', async () => {
        const obs = obsMap();
        const { show } = renderObs(obs, fineGrid());
        expectHerWindPaintsTheField(obs);

        act(() => {
            obs.view.shown = false;
            show({ boatLookUp: false });
        });
        act(() => obs.resize());
        await pass(300);
        expect(getCloseInWindReadout()).toMatchObject({ source: 'boat', kt: 14 });

        // On another page Shane follows another boat, far away: a fictional row off Lisbon.
        instruments.cloud = { wind: { kt: 22, fromDeg: 320, stale: false }, lat: 38.69, lon: -9.42 };
        act(() => {
            window.dispatchEvent(new Event('thalassa:weather-follow-target-changed'));
        });
        // The answer measured for her is no answer for this boat.
        expect(getCloseInWindReadout()).toMatchObject({ source: 'model' });
        expect(getBoatWindReadout()?.fieldShowsHers ?? false).toBe(false);

        // Back to Obs on the same camera: measured, and that boat is not on this screen.
        act(() => {
            obs.view.shown = true;
            show({ boatLookUp: true });
        });
        act(() => obs.resize());
        await pass(300);
        expect(getCloseInWindReadout()).toMatchObject({ source: 'model' });
        expect(closeInElement(obs)).not.toBeNull();
    });

    it('hidden, her row moving off the screen she was measured on is not held as on screen', async () => {
        const obs = obsMap();
        const { show } = renderObs(obs, fineGrid());
        expectHerWindPaintsTheField(obs);

        act(() => {
            obs.view.shown = false;
            show({ boatLookUp: false });
        });
        act(() => obs.resize());
        await pass(300);
        expect(getCloseInWindReadout()).toMatchObject({ source: 'boat', kt: 14 });

        // A swing of about 10 m at her berth is the same spot: still hers.
        instruments.cloud = { ...herRow(), lat: AIRLIE.lat + 0.0001 };
        await pass(2_500);
        expect(getCloseInWindReadout()).toMatchObject({ source: 'boat', kt: 14 });

        // She motors about 5 km north while Shane is away: off a z14 phone screen.
        instruments.cloud = { ...herRow(), lat: AIRLIE.lat + 0.05 };
        await pass(2_500);
        expect(getCloseInWindReadout()).toMatchObject({ source: 'model' });

        act(() => {
            obs.view.shown = true;
            show({ boatLookUp: true });
        });
        act(() => obs.resize());
        await pass(300);
        expect(getCloseInWindReadout()).toMatchObject({ source: 'model' });
    });

    it('a camera resting at 13.92 (eased in from 14) keeps her wind through a mode flip it did not cause (a model switch)', () => {
        const obs = obsMap();
        const { show } = renderObs(obs, fineGrid());
        act(() => obs.settleAt(13.92));
        expect(getCloseInWindReadout()).toMatchObject({ source: 'boat', kt: 14 });

        // A model switch clears the grid, so close-in goes off, and the new model's grid brings it back.
        act(() => show({ windGrid: undefined }));
        expect(closeInElement(obs)).toBeNull();
        act(() => show({ windGrid: fineGrid() }));
        // The camera never moved, so the slack it had is still its own.
        expectHerWindPaintsTheField(obs);
    });

    it('a camera that left close-in (a flick out to 8) and settles back at 13.92 needs the 13.95 line again', () => {
        const obs = obsMap();
        renderObs(obs, fineGrid());
        expectHerWindPaintsTheField(obs);

        // A flick out: zoomend lands while the inertia still carries the camera.
        obs.view.moving = true;
        act(() => obs.settleAt(8));
        obs.view.moving = false;
        act(() => obs.emit('moveend'));
        expect(getCloseInWindReadout()).toBeNull();

        act(() => obs.settleAt(13.92));
        expect(getCloseInWindReadout()).toMatchObject({ source: 'model' });
        act(() => obs.settleAt(13.96));
        expect(getCloseInWindReadout()).toMatchObject({ source: 'boat', kt: 14 });
    });

    it('wind off, the camera out to 8 and back to 13.92 unwatched, wind on: the 13.95 line again', () => {
        const obs = obsMap();
        const { show } = renderObs(obs, fineGrid());
        expectHerWindPaintsTheField(obs);

        act(() => show({ visible: false }));
        act(() => obs.settleAt(8));
        act(() => obs.settleAt(13.92));
        act(() => show({ visible: true }));
        expect(getCloseInWindReadout()).toMatchObject({ source: 'model' });
        act(() => obs.settleAt(13.96));
        expect(getCloseInWindReadout()).toMatchObject({ source: 'boat', kt: 14 });
    });
});

describe('her z14 wind after another page: end to end with the real wind pipeline', () => {
    function ObsChart({ map, obsShowing }: { map: ObsMap['map']; obsShowing: boolean }) {
        // MapHub's wiring (MapHub.tsx): windGrid from the WindStore, boatLookUp = obsShowing.
        const wind = useWindStore();
        return (
            <MapboxVelocityOverlay
                mapboxMap={map as never}
                visible
                windHour={0}
                windNowIdx={0}
                windGrid={wind.grid ?? undefined}
                boatInstruments
                boatLookUp={obsShowing}
            />
        );
    }

    let obs: ObsMap;

    beforeEach(() => {
        // Only the clock is faked (for the 3 h grid line); timers run for real.
        vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
        vi.setSystemTime(new Date('2026-10-09T09:00:00+10:00'));
        try {
            localStorage.clear();
        } catch {
            // no storage: nothing to clear
        }
        net.fetchModelWindGrid.mockReset();
        net.fetchModelWindGrid.mockImplementation(async (_model: string, box: Box, _hours: number, res: number) =>
            gridOver(box, res),
        );
        // The box follows her: LocationStore is the cached weather location, at the marina.
        LocationStore.setState({ lat: AIRLIE.lat, lon: AIRLIE.lng });
        WindStore.reset();
        __windCacheForTest.clear();
        obs = obsMap();
    });

    afterEach(() => {
        // Unmount first: deactivate clears the store, and nothing should be rendering it then.
        cleanup();
        WindDataController.deactivate(obs.map as never);
        __windCacheForTest.clear();
        WindStore.reset();
    });

    /**
     * Shane's path through the real pipeline. `crossing` says when the fine
     * grid passes its 3 h line: 'on-obs' (he sat on Obs without touching the
     * camera, or the phone slept on Obs, and then he tapped another page),
     * 'away' (it passed while he was on the other page), or 'never'.
     * `panJustBefore`: a pan settles on Obs just before the page change, so
     * its debounced refetch is still pending when the chart is hidden.
     */
    async function walk(crossing: 'on-obs' | 'away' | 'never', panJustBefore = false) {
        // The fine grid around the box, fetched (or rehydrated from the last
        // launch with its own fetchedAt) a minute short of its 3 h line.
        __windCacheForTest.seed({
            grid: fineGrid(),
            bounds: FINE_BOX,
            res: 0.25,
            model: 'ecmwf',
            fetchedAt: Date.now() - (3 * HOUR - 60_000),
        });
        const publishes: Array<{ shown: boolean; lattice: string }> = [];
        let lastGrid = WindStore.getState().grid;
        const unsubscribe = WindStore.subscribe((state) => {
            if (state.grid && state.grid !== lastGrid)
                publishes.push({ shown: obs.view.shown, lattice: `${state.grid.width}x${state.grid.height}` });
            lastGrid = state.grid;
        });
        const leafletEnginesAtStart = () => mocks.leafletMaps.length;
        try {
            // Obs, wind on (useWeatherLayers activates the controller), at her, z14.
            const view = render(<ObsChart map={obs.map} obsShowing />);
            await act(async () => {
                await WindDataController.activate(obs.map as never);
            });
            // The startup camera's settle; the synoptic and world warms land behind it.
            act(() => obs.settleAt(14));
            await pass(1_200);
            expectHerWindPaintsTheField(obs, 'at the start, on Obs');
            const enginesBefore = leafletEnginesAtStart();
            const startPublishes = publishes.length;

            if (crossing === 'on-obs') vi.setSystemTime(Date.now() + 2 * 60_000);
            if (panJustBefore) act(() => obs.emit('moveend'));

            // Another page: display:none in the same commit as obsShowing
            // false, then useMapInit's ResizeObserver resizes the map.
            const fetchesBeforeHiding = net.fetchModelWindGrid.mock.calls.length;
            act(() => {
                obs.view.shown = false;
                view.rerender(<ObsChart map={obs.map} obsShowing={false} />);
            });
            act(() => obs.resize());
            await pass(1_500);
            const hiddenGrids = publishes.slice(startPublishes).filter((p) => !p.shown);
            const hidden = hiddenGrids.length;
            const fetchesBeforeReturn = net.fetchModelWindGrid.mock.calls.length;
            const fetchedHidden = fetchesBeforeReturn - fetchesBeforeHiding;

            if (crossing === 'away') vi.setSystemTime(Date.now() + 2 * 60_000);

            // Back to Obs: the same camera, so only the resize's moveend.
            act(() => {
                obs.view.shown = true;
                view.rerender(<ObsChart map={obs.map} obsShowing />);
            });
            act(() => obs.resize());
            await pass(3_000);
            const onReturn = publishes.slice(startPublishes).filter((p) => p.shown).length;
            const fetchedOnReturn = net.fetchModelWindGrid.mock.calls.length - fetchesBeforeReturn;
            const leafletStarted = mocks.leafletMaps.length - enginesBefore;
            const facts = `fetches while hidden: ${fetchedHidden}; grids published while hidden: ${hidden} (${hiddenGrids.map((p) => p.lattice).join(', ')}); fetches after the return: ${fetchedOnReturn}; grids published after it: ${onReturn}; leaflet model engines started: ${leafletStarted}`;
            return { facts, hidden, onReturn, fetchedHidden, fetchedOnReturn };
        } finally {
            unsubscribe();
        }
    }

    it('the fine grid crosses its 3 h line on Obs, Shane visits another page and comes back: her wind again', async () => {
        const { facts, hidden, onReturn, fetchedHidden, fetchedOnReturn } = await walk('on-obs');
        expectHerWindPaintsTheField(obs, facts);
        // How it arose on 9d693139: the pipeline fetched and published two
        // grids for the hidden chart's phantom 400x300 view (25x25, 17x17)
        // and nothing on the way back. Now a hidden chart's moveend fetches
        // nothing, and the return's moveend refreshes the old grid on screen.
        expect.soft(fetchedHidden, facts).toBe(0);
        expect.soft(hidden, facts).toBe(0);
        expect.soft(fetchedOnReturn, facts).toBeGreaterThan(0);
        expect.soft(onReturn, facts).toBeGreaterThan(0);
        // And a zoomend (a pinch, Find boat) still finds her.
        act(() => obs.settleAt(14));
        expect(getCloseInWindReadout()).toMatchObject({ source: 'boat', kt: 14 });
    });

    it('a pan settled just before the page change: its pending refetch finds the chart hidden and fetches nothing', async () => {
        const { facts, hidden, fetchedHidden, fetchedOnReturn } = await walk('on-obs', true);
        expect.soft(fetchedHidden, facts).toBe(0);
        expect.soft(hidden, facts).toBe(0);
        expect.soft(fetchedOnReturn, facts).toBeGreaterThan(0);
        expectHerWindPaintsTheField(obs, facts);
    });

    it('a fine-grid warm started on Obs that lands while it is hidden publishes nothing there; the return paints it', async () => {
        // The fine slot a minute short of its 3 h line, as in walk().
        __windCacheForTest.seed({
            grid: fineGrid(),
            bounds: FINE_BOX,
            res: 0.25,
            model: 'ecmwf',
            fetchedAt: Date.now() - (3 * HOUR - 60_000),
        });
        // The ±2 deg warm around the box waits for its answer; every other fetch answers at once.
        const warm: { land: (() => void) | null } = { land: null };
        net.fetchModelWindGrid.mockImplementation(async (_model: string, box: Box, _hours: number, res: number) => {
            const fineWarm = res === 0.25 && Math.abs(box.north - box.south - 4) < 1e-6;
            if (!fineWarm) return gridOver(box, res);
            return new Promise<WindGrid>((resolve) => {
                warm.land = () => resolve(gridOver(box, res));
            });
        });
        const publishes: boolean[] = [];
        let lastGrid = WindStore.getState().grid;
        const unsubscribe = WindStore.subscribe((state) => {
            if (state.grid && state.grid !== lastGrid) publishes.push(obs.view.shown);
            lastGrid = state.grid;
        });
        try {
            const view = render(<ObsChart map={obs.map} obsShowing />);
            await act(async () => {
                await WindDataController.activate(obs.map as never);
            });
            act(() => obs.settleAt(14));
            await pass(1_200);
            expectHerWindPaintsTheField(obs, 'at the start, on Obs');

            // The slot passes its line while he sits on Obs; a nudge of the chart settles and starts the warm.
            vi.setSystemTime(Date.now() + 2 * 60_000);
            act(() => obs.emit('moveend'));
            await pass(1_000);
            expect(warm.land, 'the fine warm is under way').not.toBeNull();
            expectHerWindPaintsTheField(obs, 'the warm under way, on Obs');

            // Another page, and the warm lands while the chart is hidden.
            act(() => {
                obs.view.shown = false;
                view.rerender(<ObsChart map={obs.map} obsShowing={false} />);
            });
            act(() => obs.resize());
            await pass(1_000);
            const beforeLanding = publishes.length;
            await act(async () => {
                warm.land?.();
            });
            await pass(300);
            const hiddenOnLanding = publishes.slice(beforeLanding).filter((shown) => !shown).length;
            // On the first cut the landing re-ran fetchOnline for the phantom 400x300 view and published there.
            expect.soft(hiddenOnLanding, 'grids published for the hidden chart as the warm lands').toBe(0);

            // Back to Obs on the same camera: the return's moveend paints the warmed grid from memory.
            const beforeReturn = publishes.length;
            act(() => {
                obs.view.shown = true;
                view.rerender(<ObsChart map={obs.map} obsShowing />);
            });
            act(() => obs.resize());
            await pass(1_500);
            const onReturn = publishes.slice(beforeReturn).filter((shown) => shown).length;
            expect.soft(onReturn, 'the warmed grid published on screen after the return').toBeGreaterThan(0);
            expectHerWindPaintsTheField(obs, 'back on Obs');
        } finally {
            unsubscribe();
        }
    });

    it('control: the 3 h line passes while he is on the other page: the return refetches on screen, her wind', async () => {
        const { facts, hidden, fetchedHidden, fetchedOnReturn } = await walk('away');
        expect(hidden, facts).toBe(0);
        expect(fetchedHidden, facts).toBe(0);
        expect(fetchedOnReturn, facts).toBeGreaterThan(0);
        expectHerWindPaintsTheField(obs, facts);
    });

    it('control: no 3 h line crossed: her wind, and nothing fetched while hidden', async () => {
        // (The world-floor warm still rides the next settled moveend: the return's, no longer the hidden one's.)
        const { facts, hidden, fetchedHidden } = await walk('never');
        expect(hidden, facts).toBe(0);
        expect(fetchedHidden, facts).toBe(0);
        expectHerWindPaintsTheField(obs, facts);
    });
});

describe('what the bug rode on (still true: the overlay never asks it of a hidden chart)', () => {
    it('an unmeasured (display:none) container decides close-in off even from close-in at z14', () => {
        const grid = fineGrid();
        expect(closeInModeFor(true, { zoom: 14, widthPx: 390, heightPx: 844, centreLat: AIRLIE.lat }, grid)).toBe(true);
        expect(closeInModeFor(true, { zoom: 14, widthPx: 0, heightPx: 0, centreLat: AIRLIE.lat }, grid)).toBe(false);
    });
});
