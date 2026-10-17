import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OwnedGeoJsonOverlayOptions } from '../components/map/useOwnedGeoJsonOverlay';
const state = vi.hoisted(() => ({
    scope: { userId: 'fictional-A', generation: 1 },
    blocked: false,
    identities: [] as Array<() => void>,
    policies: [] as Array<() => void>,
    options: null as OwnedGeoJsonOverlayOptions | null,
}));
vi.mock('../services/weather/openMeteoProxy', () => ({ fetchWeatherFunction: vi.fn() }));
vi.mock('../services/authIdentityScope', () => ({
    getAuthIdentityScope: () => state.scope,
    isAuthIdentityScopeCurrent: (scope: unknown) => scope === state.scope,
    subscribeAuthIdentityScope: (fn: () => void) => {
        state.identities.push(fn);
        return () => {
            state.identities = state.identities.filter((x) => x !== fn);
        };
    },
}));
vi.mock('../services/networkPolicy', () => ({
    assertNetworkAllowed: () => {
        if (state.blocked) throw new Error('Satellite mode');
    },
}));
vi.mock('../stores/settingsStore', () => ({
    useSettingsStore: {
        subscribe: (fn: () => void) => {
            state.policies.push(fn);
            return () => {
                state.policies = state.policies.filter((x) => x !== fn);
            };
        },
    },
}));
vi.mock('../components/map/useOwnedGeoJsonOverlay', () => ({
    useOwnedGeoJsonOverlay: (_ref: unknown, _ready: boolean, options: OwnedGeoJsonOverlayOptions) => {
        state.options = options;
        return options.sourceCurrent() ? 'ready' : 'off';
    },
}));
import LicensedLightningLayer from '../components/map/LicensedLightningLayer';
import { fetchWeatherFunction } from '../services/weather/openMeteoProxy';
const reader = vi.mocked(fetchWeatherFunction);
const mapRef = { current: { getCenter: () => ({ lat: -27, lng: 154 }) } } as never;
const snapshot = () => {
    const now = Date.now() - 1000;
    return {
        schema: 1,
        provider: 'xweather',
        latitude: -27,
        longitude: 154,
        radiusNm: 20,
        receivedAt: now,
        windowStart: now - 300000,
        truncated: false,
        pulses: [{ id: 'fictional-pulse', lat: -27, lon: 154, time: now - 1000, type: 'cg', polarity: 'negative' }],
    };
};
beforeEach(() => {
    vi.clearAllMocks();
    state.scope = { userId: 'fictional-A', generation: 1 };
    state.blocked = false;
    state.identities = [];
    state.policies = [];
    state.options = null;
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    reader.mockResolvedValue(snapshot());
});
afterEach(() => {
    cleanup();
    vi.useRealTimers();
});
describe('Licensed lightning explicit layer lifetime', () => {
    it('does no provider work or page rendering while inactive', async () => {
        const credit = vi.fn();
        const view = render(<LicensedLightningLayer mapRef={mapRef} mapReady active={false} onCredit={credit} />);
        await act(async () => undefined);
        expect(reader).not.toHaveBeenCalled();
        expect(view.container.childElementCount).toBe(0);
    });
    it('opens one scoped query, retains original times and adds no page furniture', async () => {
        const credit = vi.fn();
        const view = render(<LicensedLightningLayer mapRef={mapRef} mapReady active onCredit={credit} />);
        await act(async () => undefined);
        expect(reader).toHaveBeenCalledTimes(1);
        expect(reader.mock.calls[0][0]).toBe('licensed-lightning');
        const data = state.options!.createData({} as never);
        expect(data.features).toHaveLength(1);
        expect(data.features[0].properties!.originalAt).toBeLessThan(Date.now());
        expect(view.container.childElementCount).toBe(0);
        expect(credit.mock.lastCall?.[0].text).toContain('An empty result does not mean clear');
    });
    it('retires a pending response on account change and never reuses it for the next account', async () => {
        let resolve!: (value: unknown) => void;
        reader.mockImplementation(
            () =>
                new Promise((r) => {
                    resolve = r;
                }),
        );
        render(<LicensedLightningLayer mapRef={mapRef} mapReady active onCredit={() => undefined} />);
        const signal = reader.mock.calls[0][3] as AbortSignal;
        await act(async () => {
            state.scope = { userId: 'fictional-B', generation: 2 };
            state.identities.forEach((fn) => fn());
            resolve(snapshot());
        });
        expect(signal.aborted).toBe(true);
        expect(state.options!.sourceCurrent()).toBe(false);
        expect(state.options!.createData({} as never).features).toHaveLength(0);
        expect(reader).toHaveBeenCalledTimes(1);
    });
    it('retires on a network-policy change and does not restart when policy is lifted', async () => {
        render(<LicensedLightningLayer mapRef={mapRef} mapReady active onCredit={() => undefined} />);
        await act(async () => undefined);
        expect(state.options!.sourceCurrent()).toBe(true);
        await act(async () => {
            state.blocked = true;
            state.policies.forEach((fn) => fn());
        });
        expect(state.options!.sourceCurrent()).toBe(false);
        await act(async () => {
            state.blocked = false;
            state.policies.forEach((fn) => fn());
        });
        expect(reader).toHaveBeenCalledTimes(1);
        expect(state.options!.sourceCurrent()).toBe(false);
    });
    it('retires on backgrounding and removes listeners on unmount', async () => {
        const view = render(<LicensedLightningLayer mapRef={mapRef} mapReady active onCredit={() => undefined} />);
        await act(async () => undefined);
        await act(async () => {
            Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
            document.dispatchEvent(new Event('visibilitychange'));
        });
        expect(state.options!.sourceCurrent()).toBe(false);
        view.unmount();
        expect(state.identities).toHaveLength(0);
        expect(state.policies).toHaveLength(0);
    });
    it('expires observations without replacing their clocks or refreshing the provider', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1792230000000);
        reader.mockResolvedValue(snapshot());
        render(<LicensedLightningLayer mapRef={mapRef} mapReady active onCredit={() => undefined} />);
        await act(async () => undefined);
        expect(state.options!.createData({} as never).features).toHaveLength(1);
        await act(async () => {
            vi.advanceTimersByTime(300000);
        });
        expect(state.options!.createData({} as never).features).toHaveLength(0);
        expect(reader).toHaveBeenCalledTimes(1);
    });
});
