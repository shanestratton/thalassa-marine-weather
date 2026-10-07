/**
 * Obs's close-in wind follows the boat the location box follows, from
 * whichever lane carries her wind: her bus, her Pi over the LAN, or, ashore,
 * her own cloud row.
 *
 * Shane 2026-10-07, on TestFlight build 121 at home, the boat in a marina far
 * up the coast with her Pi online and publishing: "when you use your vessel as
 * your location, the wind in obs at zoom 14 no longer uses the vessels wind
 * data, even if it knows it".
 *
 * The close-in wind read the boat only through the instrument store, and on
 * Obs ashore nothing feeds that store (the cloud lane is held only by the
 * Instrument Panel, the Vessel hub and the open System status modal). The
 * camera and the marker already read her row through the boat chain every
 * 30 s; the wind now reads the same row.
 *
 * Real here: the overlay, the instrument store, the cloud telemetry service,
 * the wire parser, the boat chain and the weather follow target, the shared
 * binders and the account scope. Faked: Supabase (the rows), the Pi cache, the
 * gateway socket and the side services the store starts, and leaflet. Every
 * id, name, position and reading is fictional.
 */
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NmeaSample } from '../types';
import type { WindGrid } from '../services/weather/windGridEncoding';

const db = vi.hoisted(() => ({
    rows: [] as Record<string, unknown>[],
    userId: null as string | null,
    reads: 0,
}));
vi.mock('../services/supabase', () => {
    const query = (rows: () => Record<string, unknown>[]) => ({
        eq: (column: string, value: unknown) => query(() => rows().filter((row) => row[column] === value)),
        order: () => ({
            limit: async () => {
                db.reads += 1;
                return { data: rows(), error: null };
            },
        }),
    });
    return {
        supabase: { from: () => ({ select: () => query(() => db.rows) }) },
        getCurrentUserId: async () => db.userId,
    };
});

// The gateway socket, as the store subscribes to it.
const socket = vi.hoisted(() => {
    const samples = new Set<(sample: unknown) => void>();
    const statuses = new Set<(status: string) => void>();
    const state = { status: 'disconnected' as string };
    return {
        state,
        emitSample: (sample: unknown) => samples.forEach((cb) => cb(sample)),
        setStatus: (status: string) => {
            state.status = status;
            statuses.forEach((cb) => cb(status));
        },
        NmeaListenerService: {
            getStatus: () => state.status,
            getSavedConfig: () => null,
            onSample: (cb: (sample: unknown) => void) => {
                samples.add(cb);
                return () => samples.delete(cb);
            },
            onStatusChange: (cb: (status: string) => void) => {
                statuses.add(cb);
                return () => statuses.delete(cb);
            },
        },
    };
});
vi.mock('../services/NmeaListenerService', () => ({ NmeaListenerService: socket.NmeaListenerService }));
vi.mock('../services/NmeaGpsProvider', () => ({
    NmeaGpsProvider: { start: vi.fn(), stop: vi.fn(), getPosition: () => null, onPosition: () => () => {} },
}));
vi.mock('../services/AisStore', () => ({ AisStore: { start: vi.fn(), stop: vi.fn() } }));
vi.mock('../services/AisHubService', () => ({ AisHubService: { init: vi.fn(), destroy: vi.fn() } }));
vi.mock('../services/PiTelemetryService', () => ({ PiTelemetryService: { isPresent: () => false } }));
vi.mock('../services/networkPolicy', () => ({ satelliteModeActive: () => false }));
vi.mock('../services/PiCacheService', () => ({
    piCache: {
        getBaseUrl: () => null,
        getStatus: () => ({ reachable: false, diaryRelayConfigured: false, diaryRelayOwnerId: null }),
    },
}));
vi.mock('leaflet', () => ({ default: {} }));
vi.mock('leaflet-velocity-ts', () => ({}));
vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { MapboxVelocityOverlay } from '../components/map/MapboxVelocityOverlay';
import { getCloseInWindReadout } from '../components/map/closeInWind';
import { boatWindChipFor, getBoatWindReadout } from '../components/map/boatWindReadout';
import { NmeaStore } from '../services/NmeaStore';
import { CloudTelemetryService } from '../services/CloudTelemetryService';
import { setAuthIdentityScope } from '../services/authIdentityScope';
import { reloadSharedBindersFromStorage } from '../services/vessel/sharedBinders';
import { __resetWeatherPositionForTests, setWeatherFollowTarget } from '../services/weatherPosition';

const OWNER = 'skipper-kittiwake';
const SKIPPER = 'skipper-wind-dancer';
/** The own boat, in a marina a long way up the coast from the phone. */
const MARINA = { lat: -20.27, lng: 148.72 };
/** The boat this account crews on, somewhere else again. */
const OFFSHORE = { lat: -19.1, lng: 147.6 };
const KT = 1852 / 3600;

/** One Pi cloud row, as vessel_telemetry holds it. `windAt` null = the Pi could not date the wind. */
function piRow(
    owner: string,
    at: { lat: number; lng: number },
    wind: { tws: number | null; twd: number | null; twa?: number | null; windAt?: number | null; ageMs?: number },
): Record<string, unknown> {
    const now = Date.now();
    const age = wind.ageMs ?? 2_000;
    const extra: Record<string, unknown> = { position_at: now - age };
    const windAt = wind.windAt === undefined ? now - age - 1_000 : wind.windAt;
    if (windAt !== null) {
        extra.wind_tws_at_ms = windAt;
        extra.wind_tws_source = 'ydwg-tcp.YD';
    }
    return {
        owner_id: owner,
        boat_id: `boat-${owner}`,
        source: 'pi',
        device_label: 'Pi',
        reported_at: new Date(now - age).toISOString(),
        lat: at.lat,
        lon: at.lng,
        sog_kts: 0,
        cog_deg: null,
        heading_deg: null,
        stw_kts: null,
        tws_kts: wind.tws,
        twa_deg: wind.twa ?? null,
        twd_deg: wind.twd,
        aws_kts: null,
        awa_deg: null,
        depth_m: null,
        heel_deg: null,
        pitch_deg: null,
        water_temp_c: null,
        rudder_deg: null,
        rpm: null,
        voltage_v: null,
        extra,
    };
}

/** The selected model: 8 kt from the SE over both boats, 0.25 deg, two hours. */
function modelGrid(): WindGrid {
    const ms = 8 * KT;
    const rad = (135 * Math.PI) / 180;
    const n = 41;
    const frame = () => ({
        u: new Float32Array(n * n).fill(-ms * Math.sin(rad)),
        v: new Float32Array(n * n).fill(-ms * Math.cos(rad)),
        speed: new Float32Array(n * n).fill(ms),
    });
    const a = frame();
    const b = frame();
    const lats = Array.from({ length: n }, (_, i) => -25 + i * 0.25);
    const lons = Array.from({ length: n }, (_, i) => 143 + i * 0.25);
    return {
        u: [a.u, b.u],
        v: [a.v, b.v],
        speed: [a.speed, b.speed],
        width: n,
        height: n,
        lats,
        lons,
        north: lats[n - 1],
        south: lats[0],
        west: lons[0],
        east: lons[n - 1],
        totalHours: 2,
        refTime: 'model',
    };
}

/** A 390x844 phone at `zoom` (z14 by default) centred on `centre`; anything within a few hundred metres is on screen. */
function phoneMap(centre: { lat: number; lng: number }, zoom = 14) {
    const container = document.createElement('div');
    container.dataset.testObsWind = 'true';
    Object.defineProperty(container, 'clientWidth', { configurable: true, get: () => 390 });
    Object.defineProperty(container, 'clientHeight', { configurable: true, get: () => 844 });
    document.body.appendChild(container);
    const listeners = new Map<string, Set<() => void>>();
    const map = {
        addLayer: vi.fn(),
        addSource: vi.fn(),
        getCenter: () => centre,
        getContainer: () => container,
        getLayer: vi.fn(),
        getSource: vi.fn(),
        getStyle: () => ({ layers: [{ id: 'place-label', type: 'symbol' }] }),
        getZoom: () => zoom,
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
        project: ([lng, lat]: [number, number]) =>
            Math.abs(lng - centre.lng) < 0.01 && Math.abs(lat - centre.lat) < 0.01
                ? { x: 195, y: 422 }
                : { x: -5_000, y: -5_000 },
        removeLayer: vi.fn(),
        removeSource: vi.fn(),
    };
    return map;
}

function renderObs(centre: { lat: number; lng: number }, props: { boatInstruments?: boolean } = {}, zoom = 14) {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    return render(
        <MapboxVelocityOverlay
            mapboxMap={phoneMap(centre, zoom) as never}
            visible
            windGrid={modelGrid()}
            windHour={0}
            windNowIdx={0}
            boatInstruments={props.boatInstruments ?? true}
            boatLookUp
        />,
    );
}

const readout = () => getCloseInWindReadout();

/** Let the lookups and the re-check run, then say what the pill reads. */
async function settled(): Promise<ReturnType<typeof readout>> {
    await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 60));
    });
    return readout();
}

function sample(patch: Partial<NmeaSample>): NmeaSample {
    return {
        timestamp: Date.now(),
        tws: null,
        twa: null,
        stw: null,
        heading: null,
        rpm: null,
        rudder: null,
        rudderSwing: null,
        voltage: null,
        depth: null,
        sog: null,
        cog: null,
        waterTemp: null,
        latitude: null,
        longitude: null,
        ...patch,
    } as NmeaSample;
}

describe('Obs close-in wind: the followed boat’s own wind, from whichever lane carries it', () => {
    beforeEach(() => {
        localStorage.clear();
        db.userId = OWNER;
        db.reads = 0;
        db.rows = [
            piRow(OWNER, MARINA, { tws: 14, twd: 200, twa: -40 }),
            piRow(SKIPPER, OFFSHORE, { tws: 22, twd: 90, twa: 60 }),
        ];
        setAuthIdentityScope(OWNER);
        reloadSharedBindersFromStorage();
        __resetWeatherPositionForTests();
        socket.state.status = 'disconnected';
        setWeatherFollowTarget('boat');
    });

    afterEach(() => {
        cleanup();
        NmeaStore.stop();
        NmeaStore.clearRemote();
        socket.state.status = 'disconnected';
        setAuthIdentityScope(null);
        vi.restoreAllMocks();
        document.querySelectorAll('[data-test-obs-wind="true"]').forEach((element) => element.remove());
    });

    it('ashore, box on her, Obs alone (Shane’s case): her own row’s wind, and the store is left alone', async () => {
        renderObs(MARINA);
        await waitFor(() => expect(readout()).toEqual({ kt: 14, fromDeg: 200, source: 'boat', stale: false }));
        // Obs reads her row through the chain; it does not hold the cloud lane,
        // so nothing else starts taking her position for the phone's.
        expect(NmeaStore.getState().connectionStatus).toBe('disconnected');
        expect(NmeaStore.getState().remote).toBeNull();
        expect(CloudTelemetryService.getLatest()).toBeNull();
    });

    it('ashore, box on the boat crewed on: her skipper’s row, never the own row', async () => {
        setWeatherFollowTarget('crew', { ownerId: SKIPPER, fallback: 'boat' });
        renderObs(OFFSHORE);
        await waitFor(() => expect(readout()).toEqual({ kt: 22, fromDeg: 90, source: 'boat', stale: false }));
    });

    it('crewing with the cloud lane held for the own boat: the crewed boat’s wind, never the store’s', async () => {
        // Both boats in the same marina, so a wrong boat's wind would be on screen.
        db.rows = [
            piRow(OWNER, MARINA, { tws: 14, twd: 200 }),
            piRow(SKIPPER, { lat: MARINA.lat + 0.001, lng: MARINA.lng }, { tws: 22, twd: 90 }),
        ];
        setWeatherFollowTarget('crew', { ownerId: SKIPPER, fallback: 'boat' });
        CloudTelemetryService.retain();
        try {
            await waitFor(() => expect(NmeaStore.getState().remote?.via).toBe('cloud'));
            expect(CloudTelemetryService.getLatest()?.ownerId).toBe(OWNER);
            renderObs(MARINA);
            await waitFor(() => expect(readout()).toMatchObject({ kt: 22, fromDeg: 90, source: 'boat' }));
        } finally {
            CloudTelemetryService.release();
        }
    });

    it('a row five minutes old is not her wind now: the model', async () => {
        db.rows = [piRow(OWNER, MARINA, { tws: 14, twd: 200, ageMs: 300_000 })];
        renderObs(MARINA);
        await waitFor(() => expect(db.reads).toBeGreaterThan(0));
        expect(await settled()).toMatchObject({ source: 'model' });
        expect(readout()!.kt).toBeCloseTo(8, 3);
    });

    it('a fresh row whose wind sample is past the cloud lane’s 60 s gate: the model', async () => {
        db.rows = [piRow(OWNER, MARINA, { tws: 14, twd: 200, windAt: Date.now() - 61_000 })];
        renderObs(MARINA);
        await waitFor(() => expect(db.reads).toBeGreaterThan(0));
        expect(await settled()).toMatchObject({ source: 'model' });
    });

    it('a row with no wind, or wind the Pi could not date (Signal K’s cached value): the model', async () => {
        db.rows = [piRow(OWNER, MARINA, { tws: null, twd: null })];
        const a = renderObs(MARINA);
        await waitFor(() => expect(db.reads).toBeGreaterThan(0));
        expect(await settled()).toMatchObject({ source: 'model' });
        a.unmount();

        __resetWeatherPositionForTests();
        db.reads = 0;
        db.rows = [piRow(OWNER, MARINA, { tws: 14, twd: 200, windAt: null })];
        renderObs(MARINA);
        await waitFor(() => expect(db.reads).toBeGreaterThan(0));
        expect(await settled()).toMatchObject({ source: 'model' });
    });

    it('box on Current Location: the model, and Obs reads no row for the wind', async () => {
        setWeatherFollowTarget('phone');
        renderObs(MARINA);
        expect(await settled()).toMatchObject({ source: 'model' });
        expect(db.reads).toBe(0);
    });

    it('box on a chosen place: the model, and no row is read', async () => {
        renderObs(MARINA, { boatInstruments: false });
        expect(await settled()).toMatchObject({ source: 'model' });
        expect(db.reads).toBe(0);
    });

    it('the cloud lane held (the Instrument Panel open): her dated row still speaks, held or released', async () => {
        CloudTelemetryService.retain();
        try {
            await waitFor(() => expect(NmeaStore.getState().remote?.via).toBe('cloud'));
            renderObs(MARINA);
            await waitFor(() => expect(readout()).toMatchObject({ kt: 14, fromDeg: 200, source: 'boat' }));
        } finally {
            CloudTelemetryService.release();
        }
        // Released: the store is empty again, and Obs still reads her row.
        expect(NmeaStore.getState().remote).toBeNull();
        await waitFor(() => expect(readout()).toMatchObject({ kt: 14, source: 'boat' }), { timeout: 3_000 });
    });

    it('an undated wind with the cloud lane held: the model, not the store’s re-stamped reading', async () => {
        // The wind instrument off at the marina, the Pi still up: Signal K's
        // cached value, which the Pi cannot date. The store stamps it with the
        // time the phone received it, so it would read live there; the pill
        // must not flip to it whenever System status or the Vessel hub opens.
        db.rows = [piRow(OWNER, MARINA, { tws: 12, twd: 300, windAt: null })];
        CloudTelemetryService.retain();
        try {
            await waitFor(() => expect(NmeaStore.getState().remote?.via).toBe('cloud'));
            expect(NmeaStore.getState().tws.value).toBe(12);
            renderObs(MARINA);
            expect(await settled()).toMatchObject({ source: 'model' });
            expect(readout()!.kt).toBeCloseTo(8, 3);
        } finally {
            CloudTelemetryService.release();
        }
        expect(await settled()).toMatchObject({ source: 'model' });
    });

    it('aboard, the Pi over the boat LAN: a wind the Pi never dated is not shown as hers', async () => {
        const now = Date.now();
        // Signal K's cached value from an instrument that is off reaches the
        // store re-stamped on receipt; only the Pi's own sample time proves it.
        NmeaStore.ingestRemote({
            source: 'pi',
            via: 'lan',
            deviceLabel: 'Pi',
            reportedAt: now,
            lat: MARINA.lat,
            lon: MARINA.lng,
            sogKts: 0,
            cogDeg: null,
            headingDeg: null,
            stwKts: null,
            twsKts: 9,
            twaDeg: null,
            twdDeg: 170,
            awsKts: null,
            awaDeg: null,
            depthM: null,
            heelDeg: null,
            pitchDeg: null,
            waterTempC: null,
            rudderDeg: null,
            rpm: null,
            voltageV: null,
        });
        renderObs(MARINA);
        expect(readout()?.source).not.toBe('boat');
    });

    it('aboard, the Pi over the boat LAN: the LAN’s wind beats her cloud row', async () => {
        const now = Date.now();
        NmeaStore.ingestRemote({
            source: 'pi',
            via: 'lan',
            deviceLabel: 'Pi',
            reportedAt: now,
            windSampleAt: now - 1_000,
            windSampleSource: 'masthead',
            lat: MARINA.lat,
            lon: MARINA.lng,
            sogKts: 0,
            cogDeg: null,
            headingDeg: null,
            stwKts: null,
            twsKts: 9,
            twaDeg: null,
            twdDeg: 170,
            awsKts: null,
            awaDeg: null,
            depthM: null,
            heelDeg: null,
            pitchDeg: null,
            waterTempC: null,
            rudderDeg: null,
            rpm: null,
            voltageV: null,
        });
        renderObs(MARINA);
        expect(readout()).toMatchObject({ kt: 9, fromDeg: 170, source: 'boat' });
        expect(await settled()).toMatchObject({ kt: 9, fromDeg: 170, source: 'boat' });
        // Her wind is already here: no cloud read for a row that cannot show.
        expect(db.reads).toBe(0);
    });

    // ── Build 123, W1-WC: out where the model paints the field, her reading rides on her icon ──

    it('ashore at z8 (the leaflet field), box on her: her own row’s wind is published for her icon', async () => {
        renderObs(MARINA, {}, 8);
        await waitFor(() =>
            expect(getBoatWindReadout()).toEqual({
                wind: { kt: 14, fromDeg: 200, stale: false },
                boat: { crewOwnerId: null },
                fieldShowsHers: false,
            }),
        );
        // No close-in at z8: the field is the model's, and her icon carries her reading.
        expect(readout()).toBeNull();
        expect(boatWindChipFor(getBoatWindReadout(), { kind: 'boat', crewOwnerId: null }, 'kts')).toMatchObject({
            text: '14 kt SSW',
        });
        // Read through the chain, as in close-in: the store is left alone.
        expect(NmeaStore.getState().remote).toBeNull();
    });

    it('at z14 the same row paints the field, and her icon carries nothing', async () => {
        renderObs(MARINA);
        await waitFor(() => expect(readout()).toMatchObject({ source: 'boat', kt: 14 }));
        expect(getBoatWindReadout()).toMatchObject({ fieldShowsHers: true });
        expect(boatWindChipFor(getBoatWindReadout(), { kind: 'boat', crewOwnerId: null }, 'kts')).toBeNull();
    });

    it('ashore at z8, box on the boat crewed on: her skipper’s row, published as that boat’s', async () => {
        setWeatherFollowTarget('crew', { ownerId: SKIPPER, fallback: 'boat' });
        renderObs(OFFSHORE, {}, 8);
        await waitFor(() =>
            expect(getBoatWindReadout()).toMatchObject({
                wind: { kt: 22, fromDeg: 90 },
                boat: { crewOwnerId: SKIPPER },
            }),
        );
        expect(boatWindChipFor(getBoatWindReadout(), { kind: 'boat', crewOwnerId: null }, 'kts')).toBeNull();
    });

    it('ashore at z8, her row’s wind sample past the cloud lane’s 60 s gate: nothing for her icon', async () => {
        db.rows = [piRow(OWNER, MARINA, { tws: 14, twd: 200, windAt: Date.now() - 61_000 })];
        renderObs(MARINA, {}, 8);
        await waitFor(() => expect(db.reads).toBeGreaterThan(0));
        await settled();
        expect(getBoatWindReadout()).toBeNull();
    });

    it('ashore at z8, box on Current Location: nothing for any icon, and no row is read', async () => {
        setWeatherFollowTarget('phone');
        renderObs(MARINA, {}, 8);
        await settled();
        expect(getBoatWindReadout()).toBeNull();
        expect(db.reads).toBe(0);
    });

    it('a boat in the Solent, west of Greenwich (fictional): her row’s wind on her icon, in the user’s unit', async () => {
        const SOLENT = { lat: 50.77, lng: -1.3 };
        db.rows = [piRow(OWNER, SOLENT, { tws: 10, twd: 292 })];
        renderObs(SOLENT, {}, 8);
        await waitFor(() => expect(getBoatWindReadout()).toMatchObject({ wind: { kt: 10, fromDeg: 292 } }));
        expect(boatWindChipFor(getBoatWindReadout(), { kind: 'boat', crewOwnerId: null }, 'kmh')).toMatchObject({
            text: '19 km/h WNW',
            label: 'Boat wind 19 kilometres per hour from west-north-west',
        });
    });

    it('aboard, a gateway socket: the bus’s wind', async () => {
        NmeaStore.start();
        socket.setStatus('connected');
        socket.emitSample(sample({ tws: 11, twd: 180, latitude: MARINA.lat, longitude: MARINA.lng }));
        renderObs(MARINA);
        expect(readout()).toMatchObject({ kt: 11, fromDeg: 180, source: 'boat' });
        expect(await settled()).toMatchObject({ kt: 11, source: 'boat' });
        expect(db.reads).toBe(0);
    });
});
