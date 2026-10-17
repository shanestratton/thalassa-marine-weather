import React from 'react';
import fs from 'node:fs';
import { act, cleanup, render, renderHook, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OwnedGeoJsonOverlayOptions } from '../components/map/useOwnedGeoJsonOverlay';
const state = vi.hoisted(() => ({
    scope: { userId: 'fictional-A', generation: 1 },
    identities: [] as Array<() => void>,
    policies: [] as Array<() => void>,
    options: null as OwnedGeoJsonOverlayOptions | null,
}));
vi.mock('../services/authIdentityScope', () => ({
    getAuthIdentityScope: () => state.scope,
    isAuthIdentityScopeCurrent: (v: unknown) => v === state.scope,
    subscribeAuthIdentityScope: (fn: () => void) => {
        state.identities.push(fn);
        return () => {
            state.identities = state.identities.filter((x) => x !== fn);
        };
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
    useOwnedGeoJsonOverlay: (_map: unknown, _ready: boolean, options: OwnedGeoJsonOverlayOptions) => {
        state.options = options;
        return options.sourceCurrent() ? 'ready' : 'off';
    },
}));
vi.mock('../services/weather/api/opticalLightningSession', () => ({ openOpticalSession: vi.fn() }));
vi.mock('../components/map/useActiveCyclones', () => ({ useActiveCyclones: () => ({ cyclones: [] }) }));
vi.mock('../services/MobService', () => ({ MobService: { isActive: () => false, subscribe: () => () => {} } }));
import { openOpticalSession, type OpticalSession } from '../services/weather/api/opticalLightningSession';
import {
    decodeOpticalPointer,
    decodeOpticalIndex,
    decodeOpticalTile,
} from '../services/weather/api/opticalLightningContract';
import OpticalLightningLayer from '../components/map/OpticalLightningLayer';
import { useMapHubLayerVisibility } from '../components/map/useMapHubLayerVisibility';
import { buildTacticalState } from '../components/map/buildTacticalState';
import { RadialHelmMenu } from '../components/map/RadialHelmMenu';
const fixture = JSON.parse(fs.readFileSync('tests/fixtures/optical142/fictional-packet.json', 'utf8')),
    pointer = decodeOpticalPointer(JSON.parse(fixture.resources['latest.json']), fixture.now);
const index = decodeOpticalIndex(
    JSON.parse(fixture.resources[`generations/${pointer.generation}/index.json`]),
    pointer,
    fixture.now,
);
const key = Object.keys(index.tiles)[0],
    rows = decodeOpticalTile(
        JSON.parse(fixture.resources[`generations/${pointer.generation}/tile-${key}.json`]),
        key,
        index,
        fixture.now,
    );
function session(): OpticalSession {
    let live = true;
    return {
        index,
        isCurrent: () => live,
        close: vi.fn(() => {
            live = false;
        }),
        readViewport: vi.fn(async () => ({ rows, revision: 1, truncated: false })),
    };
}
const map = {
    getBounds: () => ({ getWest: () => -71, getSouth: () => 9, getEast: () => -69, getNorth: () => 11 }),
    getZoom: () => 6,
    on: vi.fn(),
    off: vi.fn(),
};
const mapRef = { current: map } as never;
beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(Date, 'now').mockReturnValue(fixture.now);
    state.scope = { userId: 'fictional-A', generation: 1 };
    state.identities = [];
    state.policies = [];
    state.options = null;
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
    vi.mocked(openOpticalSession).mockResolvedValue(session());
});
afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
});
describe('142 optical display ownership and menu', () => {
    it('inactive layer adds no page furniture or source I/O', async () => {
        const view = render(<OpticalLightningLayer mapRef={mapRef} mapReady active={false} onCredit={vi.fn()} />);
        await act(async () => undefined);
        expect(openOpticalSession).not.toHaveBeenCalled();
        expect(view.container.childElementCount).toBe(0);
    });
    it('displays bounded original centroids with separate optical/gap credits and no network-pulse properties', async () => {
        const credit = vi.fn();
        render(<OpticalLightningLayer mapRef={mapRef} mapReady active onCredit={credit} />);
        await act(async () => undefined);
        expect(openOpticalSession).toHaveBeenCalledTimes(1);
        const data = state.options!.createData({} as never);
        expect(data.features).toHaveLength(6);
        expect(data.features[0].properties).toEqual({ kind: 'optical-flash', originalAt: fixture.now - 4000 });
        expect(credit.mock.lastCall?.[0]).toMatchObject({ title: 'Satellite optical flashes', warning: true });
        expect(credit.mock.lastCall?.[0].text).toMatch(/not ground-strike positions/);
        expect(credit.mock.lastCall?.[0].text).toMatch(/same physical flash twice/);
    });
    it('late read cannot cross account A/B/A and closes its acquired session', async () => {
        let finish!: (s: OpticalSession) => void;
        vi.mocked(openOpticalSession).mockImplementation(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        render(<OpticalLightningLayer mapRef={mapRef} mapReady active onCredit={vi.fn()} />);
        const acquired = session();
        await act(async () => {
            state.scope = { userId: 'fictional-B', generation: 2 };
            state.identities.forEach((fn) => fn());
            state.scope = { userId: 'fictional-A', generation: 3 };
            finish(acquired);
        });
        expect(acquired.close).toHaveBeenCalled();
        expect(state.options!.sourceCurrent()).toBe(false);
        expect(state.options!.createData({} as never).features).toEqual([]);
    });
    it.each(['policy', 'background', 'offline'] as const)(
        '%s retires without restarting or polling',
        async (reason) => {
            const view = render(<OpticalLightningLayer mapRef={mapRef} mapReady active onCredit={vi.fn()} />);
            await act(async () => undefined);
            await act(async () => {
                if (reason === 'policy') state.policies.forEach((fn) => fn());
                else {
                    if (reason === 'background')
                        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
                    else Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
                    document.dispatchEvent(new Event('visibilitychange'));
                }
            });
            expect(state.options!.sourceCurrent()).toBe(false);
            expect(openOpticalSession).toHaveBeenCalledTimes(1);
            view.unmount();
            expect(state.identities).toEqual([]);
            expect(state.policies).toEqual([]);
        },
    );
    it('starts OFF and unloaded, mounts only after explicit toggle and pauses on Plan', () => {
        const h = renderHook(
            ({ plan }) => useMapHubLayerVisibility({ mapRef: { current: null }, planningSurface: plan }),
            { initialProps: { plan: false } },
        );
        expect(h.result.current.opticalLightningVisible).toBe(false);
        expect(h.result.current.opticalLightningLoaded).toBe(false);
        act(() => h.result.current.setOpticalLightningVisible(true));
        expect(h.result.current.browseOpticalLightningVisible).toBe(true);
        expect(h.result.current.opticalLightningLoaded).toBe(true);
        h.rerender({ plan: true });
        expect(h.result.current.browseOpticalLightningVisible).toBe(false);
    });
    it('has one independent Sky item counted and cleared once', async () => {
        function Menu() {
            const layers = useMapHubLayerVisibility({ mapRef: { current: null }, planningSurface: false });
            return (
                <RadialHelmMenu
                    activeLayers={new Set()}
                    toggleLayer={vi.fn()}
                    selectInGroup={vi.fn()}
                    tacticalState={buildTacticalState({
                        ...layers,
                        weatherInspectMode: false,
                        setWeatherInspectMode: vi.fn(),
                        setPage: vi.fn(),
                        weather: {
                            activeLayers: new Set(),
                            setActiveLayer: vi.fn(),
                            toggleLayer: vi.fn(),
                            mpaVisible: false,
                            setMpaVisible: vi.fn(),
                        },
                    })}
                />
            );
        }
        render(<Menu />);
        fireEvent.click(screen.getByRole('button', { name: 'Open layer menu' }));
        fireEvent.click(await screen.findByRole('menuitem', { name: 'Sky layers' }));
        expect(screen.getAllByRole('menuitemcheckbox', { name: 'Satellite flashes, off' })).toHaveLength(1);
        fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Satellite flashes, off' }));
        expect(screen.getByRole('menuitemcheckbox', { name: 'Satellite flashes, on' })).toHaveAttribute(
            'aria-checked',
            'true',
        );
        fireEvent.click(screen.getByRole('menuitem', { name: 'Clear all · 1 active' }));
        await waitFor(() =>
            expect(screen.getByRole('menuitemcheckbox', { name: 'Satellite flashes, off' })).toHaveAttribute(
                'aria-checked',
                'false',
            ),
        );
    });
});
