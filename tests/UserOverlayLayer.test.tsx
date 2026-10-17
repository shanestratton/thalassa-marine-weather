import React from 'react';
import { act, render, screen, cleanup } from '@testing-library/react';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
const f = vi.hoisted(() => ({
    scope: { key: 'user:A', generation: 1, userId: 'A' },
    auth: new Set<() => void>(),
    libraryChanged: new Set<() => void>(),
    access: new Set<() => void>(),
    chart: new Set<() => void>(),
    settings: new Set<() => void>(),
    epoch: 1,
    version: 1,
    lon: -0.2,
    at: 1,
    feed: 'gateway-A',
    pair: 'pi-A',
    lan: 'boat-LAN',
    charts: false,
    foreground: true,
    appChanged: null as ((s: { isActive: boolean }) => void) | null,
}));
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => true } }));
vi.mock('@capacitor/app', () => ({
    App: {
        getState: async () => ({ isActive: f.foreground }),
        addListener: async (_n: string, fn: (s: { isActive: boolean }) => void) => {
            f.appChanged = fn;
            return {
                remove: async () => {
                    f.appChanged = null;
                },
            };
        },
    },
}));
vi.mock('../services/authIdentityScope', () => ({
    getAuthIdentityScope: () => f.scope,
    isAuthIdentityScopeCurrent: (s: unknown) => s === f.scope,
    subscribeAuthIdentityScope: (fn: () => void) => {
        f.auth.add(fn);
        return () => f.auth.delete(fn);
    },
}));
vi.mock('../stores/settingsStore', () => ({
    useSettingsStore: {
        getState: () => ({ activeVesselId: 'boat-A' }),
        subscribe: (fn: () => void) => {
            f.settings.add(fn);
            return () => f.settings.delete(fn);
        },
    },
}));
vi.mock('../services/NmeaStore', () => ({
    NmeaStore: {
        getState: () => ({
            instrumentEvidence: { identity: f.feed, via: 'gateway', position: { lat: 0.5, lon: f.lon, at: f.at } },
        }),
    },
}));
vi.mock('../services/GpsService', () => ({ GpsService: { getLastKnownPosition: () => null } }));
vi.mock('../services/PiPairingService', () => ({ getPairing: () => ({ deviceId: f.pair, fingerprint: 'fp' }) }));
vi.mock('../services/enc/piCellSync', () => ({ boatLanBaseNow: () => f.lan }));
vi.mock('../services/enc/EncCellMetadata', () => ({
    getVersion: () => f.version,
    subscribe: (fn: () => void) => {
        f.chart.add(fn);
        return () => f.chart.delete(fn);
    },
}));
vi.mock('../services/enc/chartFind', () => ({
    subscribeChartFindAccess: (fn: () => void) => {
        f.access.add(fn);
        return () => f.access.delete(fn);
    },
}));
vi.mock('../services/userOverlays/chartAreas', () => ({ borrowedEntryChartAreas: () => null }));
vi.mock('../services/userOverlays/audio', () => ({ playOverlayChime: vi.fn(), stopOverlayChime: vi.fn() }));
vi.mock('../services/userOverlays/store', () => ({
    loadUserOverlays: vi.fn(async () => ({
        schema: 1,
        charts: f.charts,
        position: 'boat',
        overlays: [{ id: 'synthetic', label: 'My private area', visible: true, alerts: true }],
    })),
    readUserOverlay: vi.fn(async () => ({
        type: 'FeatureCollection',
        features: [
            {
                type: 'Feature',
                id: 0,
                properties: { label: 'Annotation' },
                geometry: {
                    type: 'Polygon',
                    coordinates: [
                        [
                            [0, 0],
                            [1, 0],
                            [1, 1],
                            [0, 1],
                            [0, 0],
                        ],
                    ],
                },
            },
        ],
    })),
    subscribeUserOverlays: (fn: () => void) => {
        f.libraryChanged.add(fn);
        return () => f.libraryChanged.delete(fn);
    },
    userOverlayGeneration: () => f.epoch,
}));
import UserOverlayLayer from '../components/map/UserOverlayLayer';
import { playOverlayChime } from '../services/userOverlays/audio';
import { readUserOverlay } from '../services/userOverlays/store';
import type mapboxgl from 'mapbox-gl';
function fakeMap() {
    const sources = new Map<string, { setData: ReturnType<typeof vi.fn> }>(),
        layers = new Map<string, unknown>();
    return {
        sources,
        layers,
        map: {
            getSource: (id: string) => sources.get(id),
            addSource: (id: string) => sources.set(id, { setData: vi.fn() }),
            removeSource: (id: string) => sources.delete(id),
            getLayer: (id: string) => layers.get(id),
            addLayer: (l: { id: string }) => layers.set(l.id, l),
            removeLayer: (id: string) => layers.delete(id),
            on: vi.fn(),
            off: vi.fn(),
        } as unknown as mapboxgl.Map,
    };
}
beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(100000);
    f.scope = { key: 'user:A', generation: 1, userId: 'A' };
    f.lon = -0.2;
    f.at = Date.now();
    f.feed = 'gateway-A';
    f.pair = 'pi-A';
    f.lan = 'boat-LAN';
    f.foreground = true;
    f.epoch = 1;
    f.version = 1;
    vi.clearAllMocks();
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
});
afterEach(() => {
    cleanup();
    vi.useRealTimers();
});
async function tick(lon = f.lon, age = 0) {
    f.lon = lon;
    f.at = Date.now() + 1000 - age;
    await act(() => vi.advanceTimersByTimeAsync(1000));
}
it('real foreground layer renders owned data, fires one quiet cue and retires on account swap', async () => {
    const m = fakeMap();
    render(<UserOverlayLayer map={m.map} mapReady active />);
    await act(async () => {});
    expect(m.sources.size).toBe(1);
    await tick(-0.2);
    await tick(0.5);
    expect(screen.getByText(/Entered My private area/)).toBeVisible();
    expect(playOverlayChime).toHaveBeenCalledTimes(1);
    await tick(0.6);
    expect(playOverlayChime).toHaveBeenCalledTimes(1);
    act(() => {
        f.scope = { key: 'user:B', generation: 2, userId: 'B' };
        for (const fn of f.auth) fn();
    });
    expect(screen.queryByText(/Entered My private area/)).toBeNull();
    expect(m.sources.size).toBe(0);
});
it('native pause/restart, stale fixes and changed receiver never fire an inherited entry', async () => {
    const m = fakeMap();
    render(<UserOverlayLayer map={m.map} mapReady active />);
    await act(async () => {});
    await tick(-0.2);
    act(() => f.appChanged?.({ isActive: false }));
    await tick(0.5);
    expect(playOverlayChime).not.toHaveBeenCalled();
    act(() => f.appChanged?.({ isActive: true }));
    await tick(0.5);
    expect(playOverlayChime).not.toHaveBeenCalled();
    await tick(-0.2);
    await tick(0.5, 60000);
    expect(playOverlayChime).not.toHaveBeenCalled();
    f.feed = 'other-vessel';
    await tick(0.5);
    expect(playOverlayChime).not.toHaveBeenCalled();
});
it('late old-account file read cannot republish geometry and unmount clears native listeners', async () => {
    let release!: (v: Awaited<ReturnType<typeof readUserOverlay>>) => void;
    vi.mocked(readUserOverlay).mockImplementationOnce(
        () => new Promise((r) => (release = r)) as ReturnType<typeof readUserOverlay>,
    );
    const m = fakeMap(),
        view = render(<UserOverlayLayer map={m.map} mapReady active />);
    await act(async () => {});
    act(() => {
        f.scope = { key: 'user:B', generation: 2, userId: 'B' };
        f.epoch++;
        for (const fn of f.auth) fn();
    });
    view.unmount();
    await act(async () => {
        release({ type: 'FeatureCollection', features: [] });
    });
    expect(m.sources.size).toBe(0);
    expect(f.appChanged).toBeNull();
    expect(f.auth.size).toBe(0);
    expect(f.libraryChanged.size).toBe(0);
});
