import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type mapboxgl from 'mapbox-gl';
import type { InstrumentEvidence } from '../services/instruments/measurements';
const f = vi.hoisted(() => ({
    scope: {
        userId: '11111111-1111-4111-8111-111111111111',
        key: 'user:11111111-1111-4111-8111-111111111111',
        generation: 1,
    },
    pair: {
        deviceId: '22222222-2222-4222-8222-222222222222',
        publicKeySpki: 'x'.repeat(124),
        pairedAt: '2026-10-17T00:00:00.000Z',
    },
    evidence: undefined as InstrumentEvidence | undefined,
    boat: '33333333-3333-4333-8333-333333333333',
    listeners: new Set<(next: { activeVesselId: string }, prev: { activeVesselId: string }) => void>(),
    chartGate: vi.fn(() => null),
}));
vi.mock('../services/authIdentityScope', () => ({
    getAuthIdentityScope: () => f.scope,
    isAuthIdentityScopeCurrent: (scope: unknown) => scope === f.scope,
    subscribeAuthIdentityScope: () => () => {},
}));
vi.mock('../services/PiPairingService', () => ({ getPairing: () => f.pair }));
vi.mock('../services/PiCacheService', () => ({ piCache: { lanBaseUrlNow: () => 'https://192.0.2.1:3443' } }));
vi.mock('../services/piTls', () => ({ isPinnedTransportAvailable: () => true }));
vi.mock('../services/enc/piCellSync', () => ({ boatLanBaseNow: f.chartGate }));
vi.mock('../services/NmeaStore', () => ({ NmeaStore: { getState: () => ({ instrumentEvidence: f.evidence }) } }));
vi.mock('../stores/settingsStore', () => ({
    useSettingsStore: {
        getState: () => ({ activeVesselId: f.boat }),
        subscribe: (fn: (next: { activeVesselId: string }, prev: { activeVesselId: string }) => void) => {
            f.listeners.add(fn);
            return () => f.listeners.delete(fn);
        },
    },
}));
vi.mock('../services/chartAnnotations/store', () => ({
    loadAnnotations: async () => ({ schema: 1, revision: 0, annotations: [] }),
    subscribeAnnotations: () => () => {},
    saveAnnotation: vi.fn(),
    changeAnnotation: vi.fn(),
    removeAnnotation: vi.fn(),
}));
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => false } }));
vi.mock('mapbox-gl', () => ({ default: { Marker: class {} } }));
import Tools from '../components/map/drawing/ChartDrawingTools';
const T = Date.UTC(2026, 9, 17);
function map() {
    const canvas = document.createElement('canvas');
    canvas.getBoundingClientRect = () => ({
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 400,
        bottom: 780,
        width: 400,
        height: 780,
        toJSON() {},
    });
    const sources = new Map<
        string,
        { _data: { features: unknown[] }; setData: (data: { features: unknown[] }) => void }
    >();
    return {
        sources,
        map: {
            getCanvas: () => canvas,
            getSource: (id: string) => sources.get(id),
            addSource: (id: string, options: { data: { features: unknown[] } }) => {
                const source = {
                    _data: options.data,
                    setData(data: { features: unknown[] }) {
                        this._data = data;
                    },
                };
                sources.set(id, source);
            },
            removeSource: (id: string) => sources.delete(id),
            getLayer: () => true,
            addLayer: () => {},
            removeLayer: () => {},
            on: () => {},
            off: () => {},
            isStyleLoaded: () => true,
            unproject: () => ({ lat: 0.01, lng: 0.01 }),
            panBy: () => {},
        } as unknown as mapboxgl.Map,
    };
}
async function openRuler(m: ReturnType<typeof map>) {
    render(<Tools map={m.map} mapReady active canDraw open onClose={() => {}} />);
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Set boat EBL / VRM' }));
}
async function fresh(via: InstrumentEvidence['via'] = 'lan') {
    const publish = () => {
        f.evidence = {
            via,
            identity: 'physical-receiver',
            position: { lat: 0, lon: 0, at: Date.now() },
            readings: {
                headingTrue: {
                    at: Date.now(),
                    value: 90,
                    reference: 'true',
                    unit: 'degrees',
                    source: 'physical-heading',
                },
            },
        };
    };
    publish();
    await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
    });
    await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
    });
    publish();
    await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
    });
}
beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T);
    f.evidence = undefined;
    f.chartGate.mockClear();
    f.boat = '33333333-3333-4333-8333-333333333333';
});
afterEach(() => {
    cleanup();
    vi.useRealTimers();
});
it('fresh paired LAN ruler works while the licensed chart gate is off, then retires on vessel change', async () => {
    const m = map();
    await openRuler(m);
    await fresh();
    fireEvent.click(screen.getByRole('button', { name: 'Use map centre for ruler' }));
    expect(m.sources.get('user-boat-ruler')?._data.features).toHaveLength(2);
    expect(screen.getByText(/EBL .*degrees true; VRM/)).toHaveTextContent('paired Pi boat receiver');
    expect(f.chartGate).not.toHaveBeenCalled();
    await act(async () => {
        const previous = { activeVesselId: f.boat };
        f.boat = 'another-boat';
        for (const listener of f.listeners) listener({ activeVesselId: f.boat }, previous);
    });
    expect(m.sources.get('user-boat-ruler')?._data.features).toHaveLength(0);
});
it('cloud or direct Signal K positions cannot set a boat ruler', async () => {
    const m = map();
    await openRuler(m);
    await fresh('cloud');
    fireEvent.click(screen.getByRole('button', { name: 'Use map centre for ruler' }));
    expect(m.sources.get('user-boat-ruler')?._data.features).toHaveLength(0);
    expect(screen.getByText(/Fresh boat position unavailable/)).toBeVisible();
    await fresh('signalk');
    fireEvent.click(screen.getByRole('button', { name: 'Use map centre for ruler' }));
    expect(m.sources.get('user-boat-ruler')?._data.features).toHaveLength(0);
});
