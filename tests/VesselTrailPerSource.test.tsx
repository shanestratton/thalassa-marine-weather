/**
 * The chart's wake trail is one receiver's story (Shane 2026-09-09: looking
 * at the boat's weather from home, "you get a thin blue line between both
 * spots"). The ownship arbiter paints the boat while her feed is fresh and
 * falls back to the phone when it is not; the trail used to join the two,
 * drawing a chord from her berth to the skipper's house. Now a change of
 * source starts the trail (and the swing envelope) again, and once the boat
 * has spoken the phone never draws either.
 */
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useVesselTracker } from '../components/map/useVesselTracker';

type Metric = { value: number | null; lastUpdated: number };

const mocks = vi.hoisted(() => {
    const gpsCallbacks: Array<(pos: Record<string, unknown>) => void> = [];
    const nmeaCallbacks: Array<() => void> = [];
    return {
        gpsCallbacks,
        nmeaCallbacks,
        watchPosition: vi.fn((cb: (pos: Record<string, unknown>) => void) => {
            gpsCallbacks.push(cb);
            return vi.fn();
        }),
        nmea: {} as Record<string, Metric>,
        anchorState: 'idle',
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    };
});

vi.mock('mapbox-gl', () => {
    class Marker {
        element: HTMLElement;
        setLngLat = vi.fn().mockReturnThis();
        addTo = vi.fn().mockReturnThis();
        remove = vi.fn();
        constructor(opts: { element: HTMLElement }) {
            this.element = opts.element;
        }
    }
    return { default: { Marker }, Marker };
});
vi.mock('../services/GpsService', () => ({
    GpsService: { watchPosition: mocks.watchPosition, getCurrentPosition: vi.fn().mockResolvedValue(null) },
}));
vi.mock('../services/BgGeoManager', () => ({ BgGeoManager: { getLastPosition: vi.fn(() => null) } }));
vi.mock('../services/NmeaGpsProvider', () => ({
    NmeaGpsProvider: {
        onPosition: (cb: () => void) => {
            mocks.nmeaCallbacks.push(cb);
            return () => {};
        },
        start: vi.fn(),
    },
}));
vi.mock('../services/NmeaListenerService', () => ({ NmeaListenerService: { getSavedConfig: () => null } }));
vi.mock('../services/NmeaStore', () => ({ NmeaStore: { getState: () => mocks.nmea, start: vi.fn() } }));
vi.mock('../services/AnchorWatchService', () => ({
    AnchorWatchService: { getSnapshot: () => ({ state: mocks.anchorState }) },
}));
vi.mock('../services/GpsReceiverStatusService', () => ({ formatAge: (ms: number) => `${Math.round(ms / 1000)}s` }));
vi.mock('../utils/createLogger', () => ({ createLogger: () => mocks.logger }));

// Shane's house (Newport canal estate) and her berth (Scarborough marina): ~2 NM apart.
const HOUSE = { lat: -27.212, lon: 153.09 };
const BERTH = { lat: -27.195, lon: 153.108 };

type LonLat = [number, number];

function makeMap() {
    const sources = new Map<string, { setData: ReturnType<typeof vi.fn> }>();
    const layers = new Map<string, { id: string }>();
    return {
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
        flyTo: vi.fn(),
        sources,
    };
}

/** Every LineString the trail source was ever given, as lon/lat pairs. */
function trailLines(map: ReturnType<typeof makeMap>): LonLat[][] {
    const out: LonLat[][] = [];
    for (const [id, src] of map.sources) {
        if (!id.includes('trail')) continue;
        for (const call of src.setData.mock.calls) {
            const fc = call[0] as { features: Array<{ geometry: { type: string; coordinates: LonLat[] } }> };
            for (const f of fc.features) if (f.geometry.type === 'LineString') out.push(f.geometry.coordinates);
        }
    }
    return out;
}

function swingRings(map: ReturnType<typeof makeMap>): LonLat[][] {
    const out: LonLat[][] = [];
    for (const [id, src] of map.sources) {
        if (!id.includes('swing')) continue;
        for (const call of src.setData.mock.calls) {
            const fc = call[0] as { features: Array<{ geometry: { type: string; coordinates: unknown } }> };
            for (const f of fc.features) {
                if (f.geometry.type === 'Polygon') out.push((f.geometry.coordinates as LonLat[][])[0]);
                if (f.geometry.type === 'Point') out.push([f.geometry.coordinates as LonLat]);
            }
        }
    }
    return out;
}

const near = (pt: LonLat, at: { lat: number; lon: number }) =>
    Math.abs(pt[1] - at.lat) < 0.005 && Math.abs(pt[0] - at.lon) < 0.005;

function mount() {
    const map = makeMap();
    const mapRef = { current: map as never };
    renderHook(() => useVesselTracker(mapRef, true, true));
    const phone = (lat: number, lon: number) =>
        act(() => {
            mocks.gpsCallbacks.at(-1)?.({
                latitude: lat,
                longitude: lon,
                accuracy: 5,
                altitude: null,
                heading: 90,
                speed: 1.5,
                timestamp: Date.now(),
            });
        });
    const boat = (lat: number, lon: number, ageMs = 0, sogKts = 3) => {
        const t = Date.now() - ageMs;
        mocks.nmea = {
            latitude: { value: lat, lastUpdated: t },
            longitude: { value: lon, lastUpdated: t },
            sog: { value: sogKts, lastUpdated: t },
            cog: { value: 45, lastUpdated: t },
        };
        act(() => {
            mocks.nmeaCallbacks.at(-1)?.();
        });
    };
    const boatQuiet = () => {
        const old = Date.now() - 30 * 60_000;
        mocks.nmea = {
            latitude: { value: BERTH.lat, lastUpdated: old },
            longitude: { value: BERTH.lon, lastUpdated: old },
        };
    };
    return { map, phone, boat, boatQuiet };
}

describe('vessel trail — one receiver per trail', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.gpsCallbacks.length = 0;
        mocks.nmeaCallbacks.length = 0;
        mocks.nmea = {};
        mocks.anchorState = 'idle';
    });
    afterEach(() => cleanup());

    it('never joins a phone fix at the house to the boat at her berth', () => {
        const t = mount();
        // Phone only, at home: a short walk draws a phone trail.
        t.phone(HOUSE.lat, HOUSE.lon);
        t.phone(HOUSE.lat + 0.0005, HOUSE.lon);
        // The Pi comes up: the boat speaks from her berth.
        t.boat(BERTH.lat, BERTH.lon);
        t.boat(BERTH.lat + 0.0005, BERTH.lon + 0.0005);
        // The Pi drops out for a moment and the phone paints again, then she is back.
        t.boatQuiet();
        t.phone(HOUSE.lat + 0.001, HOUSE.lon);
        t.boat(BERTH.lat + 0.001, BERTH.lon);
        t.boat(BERTH.lat + 0.0015, BERTH.lon + 0.0005);

        const lines = trailLines(t.map);
        expect(lines.length).toBeGreaterThan(0);
        for (const line of lines) {
            const atHouse = line.some((p) => near(p, HOUSE));
            const atBerth = line.some((p) => near(p, BERTH));
            expect(atHouse && atBerth).toBe(false); // no chord, ever
        }
    });

    it('once the boat has spoken, the phone moves the arrow but draws no wake', () => {
        const t = mount();
        t.boat(BERTH.lat, BERTH.lon);
        t.boat(BERTH.lat + 0.0005, BERTH.lon);
        const before = trailLines(t.map).length;
        t.boatQuiet();
        t.phone(HOUSE.lat, HOUSE.lon);
        t.phone(HOUSE.lat + 0.0005, HOUSE.lon);
        t.phone(HOUSE.lat + 0.001, HOUSE.lon);
        const lines = trailLines(t.map);
        expect(lines.length).toBe(before); // nothing new drawn from the phone
        expect(lines.flat().some((p) => near(p, HOUSE))).toBe(false);
    });

    it('a boat with no instruments keeps her phone-drawn wake, as before', () => {
        const t = mount();
        t.phone(HOUSE.lat, HOUSE.lon);
        t.phone(HOUSE.lat + 0.0005, HOUSE.lon);
        t.phone(HOUSE.lat + 0.001, HOUSE.lon);
        const lines = trailLines(t.map);
        expect(lines.at(-1)?.length).toBe(3);
    });

    it('the swing envelope at anchor is hers alone — a phone ashore never widens it', () => {
        const t = mount();
        mocks.anchorState = 'watching';
        // She lies to her anchor; a few fixes wander around the berth.
        t.boat(BERTH.lat, BERTH.lon, 0, 0);
        t.boat(BERTH.lat + 0.0002, BERTH.lon + 0.0001, 0, 0);
        t.boat(BERTH.lat - 0.0001, BERTH.lon + 0.0002, 0, 0);
        const ringsBefore = swingRings(t.map).length;
        expect(ringsBefore).toBeGreaterThan(0);
        // The skipper rows ashore; the boat feed goes quiet; the phone paints from the house.
        t.boatQuiet();
        t.phone(HOUSE.lat, HOUSE.lon);
        t.phone(HOUSE.lat + 0.0003, HOUSE.lon);
        for (const ring of swingRings(t.map)) {
            expect(ring.some((p) => near(p, HOUSE))).toBe(false);
        }
    });
});
