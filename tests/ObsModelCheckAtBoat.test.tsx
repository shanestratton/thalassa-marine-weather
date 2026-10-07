/**
 * Obs → weather panel → Wind: "Her wind vs the models".
 *
 * Shane 2026-10-07, answering the recommendation "a simple version - her live
 * wind against each model's forecast for this hour at her position, ranked,
 * with a clear caveat that one reading is a snapshot, not a verdict. It only
 * needs what the phone already has": "go with your recommendation big Claude".
 *
 * Real here: MapWeatherControls and its auto-hide, the lazy card and its
 * container loop, the instrument store, the boat chain and the weather follow
 * target, the account scope and the shared binders. Faked: the gateway socket
 * and the side services the store starts, the Pi cache, the cloud-row lookup
 * (counted, never sent) and the forecast proxy (fetchOpenMeteoPoints, counted,
 * and held when a test needs a reply to land late). Every id, position and
 * reading is fictional; the boat is in Chesapeake Bay.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import React, { useState } from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NmeaSample } from '../types';

// The gateway socket, as the store subscribes to it.
const socket = vi.hoisted(() => {
    const samples = new Set<(sample: unknown) => void>();
    const state = { status: 'disconnected' as string };
    return {
        state,
        emitSample: (sample: unknown) => samples.forEach((cb) => cb(sample)),
        NmeaListenerService: {
            getStatus: () => state.status,
            getSavedConfig: () => null,
            onSample: (cb: (sample: unknown) => void) => {
                samples.add(cb);
                return () => samples.delete(cb);
            },
            onStatusChange: () => () => {},
        },
    };
});
vi.mock('../services/NmeaListenerService', () => ({ NmeaListenerService: socket.NmeaListenerService }));
vi.mock('../services/NmeaGpsProvider', () => ({
    NmeaGpsProvider: { start: vi.fn(), stop: vi.fn(), getPosition: () => null, onPosition: () => () => {} },
}));
vi.mock('../services/AisStore', () => ({ AisStore: { start: vi.fn(), stop: vi.fn() } }));
vi.mock('../services/AisHubService', () => ({ AisHubService: { init: vi.fn(), destroy: vi.fn() } }));
vi.mock('../services/PiCacheService', () => ({
    piCache: {
        getBaseUrl: () => null,
        getStatus: () => ({ reachable: false, diaryRelayConfigured: false, diaryRelayOwnerId: null }),
    },
}));
vi.mock('../services/weatherPosition', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../services/weatherPosition')>();
    return { ...actual, lookUpFollowedBoatCloudRow: vi.fn(async () => {}) };
});
const proxy = vi.hoisted(() => ({ calls: 0, hours: [] as number[], held: false, release: [] as (() => void)[] }));
vi.mock('../services/weather/openMeteoProxy', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../services/weather/openMeteoProxy')>();
    return {
        ...actual,
        fetchOpenMeteoPoints: vi.fn(async (_op: string, points: unknown[]) => {
            proxy.calls += 1;
            if (proxy.held) await new Promise<void>((resolve) => proxy.release.push(resolve));
            const constant = (kt: number) => proxy.hours.map(() => kt);
            return points.map(() => ({
                hourly: {
                    time: proxy.hours.map((ms) => ms / 1000),
                    wind_speed_10m_dwd_icon: constant(13),
                    wind_direction_10m_dwd_icon: constant(200),
                    wind_speed_10m_ecmwf_ifs025: constant(15),
                    wind_direction_10m_ecmwf_ifs025: constant(205),
                    wind_speed_10m_ecmwf_aifs025_single: constant(14.5),
                    wind_direction_10m_ecmwf_aifs025_single: constant(210),
                    wind_speed_10m_ukmo_global_deterministic_10km: constant(20),
                    wind_direction_10m_ukmo_global_deterministic_10km: constant(190),
                    wind_speed_10m_jma_gsm: constant(9),
                    wind_direction_10m_jma_gsm: constant(220),
                },
            }));
        }),
    };
});

import { MapWeatherControls } from '../components/map/MapWeatherControls';
// Loaded up front, so the lazy card resolves in microtasks under fake timers.
import '../components/map/ModelCheckAtBoat';
import { __clearModelCheckCacheForTests } from '../components/map/boatModelCheck';
import type { useWeatherLayers } from '../components/map/useWeatherLayers';
import { NmeaStore } from '../services/NmeaStore';
import { setAuthIdentityScope } from '../services/authIdentityScope';
import { reloadSharedBindersFromStorage } from '../services/vessel/sharedBinders';
import {
    __resetWeatherPositionForTests,
    lookUpFollowedBoatCloudRow,
    setWeatherFollowTarget,
} from '../services/weatherPosition';
import { startPassageLookAhead, stopPassageLookAhead } from '../stores/passageHudStore';

const OWNER = 'skipper-osprey-7c1d';
const SKIPPER = 'skipper-heron-2b9e';
/** Fictional: Chesapeake Bay, off Annapolis. */
const BAY = { lat: 38.95, lon: -76.42 };
/** Fictional: off Cape Hatteras, some 230 NM from the bay. */
const HATTERAS = { lat: 35.2, lon: -75.2 };
const START = Date.UTC(2026, 9, 7, 12, 15, 0);
const HOUR = 3_600_000;
const ROW = 'Compare her wind with the models now';

type WeatherControlsWeather = ReturnType<typeof useWeatherLayers>;
function windGrid(totalHours = 3) {
    const frames = Array.from({ length: totalHours }, () => new Float32Array([1]));
    return {
        u: frames,
        v: frames,
        speed: frames,
        width: 1,
        height: 1,
        lats: [0],
        lons: [0],
        north: 0,
        south: 0,
        west: 0,
        east: 0,
        totalHours,
    };
}
function weather(overrides: Record<string, unknown> = {}): WeatherControlsWeather {
    return {
        activeLayers: new Set(['wind']),
        windForecastHours: [0, 3, 6],
        windForecastHoursRef: { current: [0, 3, 6] },
        windNowIdx: 0,
        windNowIdxRef: { current: 0 },
        windHour: 0,
        windTotalHours: 3,
        windPlaying: false,
        windReady: true,
        setWindHour: vi.fn(),
        setWindPlaying: vi.fn(),
        windModel: 'icon',
        setWindModel: vi.fn(),
        windState: { loading: false, error: null, grid: windGrid() },
        rainFrameIndex: 0,
        setRainFrameIndex: vi.fn(),
        rainPlaying: false,
        setRainPlaying: vi.fn(),
        rainReady: true,
        rainFrameCount: 2,
        rainNowIdxRef: { current: 0 },
        unifiedFramesRef: {
            current: [
                { type: 'radar', timeMs: START, label: '12:15' },
                { type: 'forecast', timeMs: START + 600_000, label: '+10m' },
            ],
        },
        ...overrides,
    } as unknown as WeatherControlsWeather;
}

/** The chart's own owner of the hidden flag, so the 6 s auto-hide really hides. */
function Obs({ embedded = false, layers = ['wind'] }: { embedded?: boolean; layers?: string[] }) {
    const [hidden, setHidden] = useState(false);
    return (
        <MapWeatherControls
            weather={weather({ activeLayers: new Set(layers) })}
            visible
            embedded={embedded}
            controlsHidden={hidden}
            onControlsHiddenChange={setHidden}
        />
    );
}

function sample(tws: number | null, at: { lat: number; lon: number } = BAY): NmeaSample {
    return {
        timestamp: Date.now(),
        tws,
        twa: null,
        stw: 5.6,
        heading: null,
        rpm: null,
        rudder: null,
        rudderSwing: null,
        voltage: null,
        depth: null,
        sog: 5.8,
        cog: 10,
        waterTemp: null,
        latitude: at.lat,
        longitude: at.lon,
    } as NmeaSample;
}
const emit = (tws: number | null) => act(() => socket.emitSample(sample(tws)));

async function flush() {
    await act(async () => {
        for (let i = 0; i < 10; i++) await Promise.resolve();
    });
}
async function advance(ms: number) {
    await act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
    });
}
const dialog = () => screen.getByRole('dialog', { name: 'Her wind vs the models' });

describe('Her wind vs the models: the entry row', () => {
    beforeEach(() => {
        localStorage.clear();
        setAuthIdentityScope(OWNER);
        reloadSharedBindersFromStorage();
        __resetWeatherPositionForTests();
        __clearModelCheckCacheForTests();
        setWeatherFollowTarget('boat');
    });
    afterEach(() => {
        cleanup();
        stopPassageLookAhead();
        setAuthIdentityScope(null);
    });

    it('is offered only while Current Location follows a boat: hers, or the one crewed on', () => {
        act(() => setWeatherFollowTarget('phone'));
        const view = render(<Obs />);
        expect(screen.queryByRole('button', { name: ROW })).not.toBeInTheDocument();
        view.unmount();

        act(() => setWeatherFollowTarget('boat'));
        render(<Obs />);
        const row = screen.getByRole('button', { name: ROW });
        expect(row).toHaveTextContent('Her wind vs the models');
        expect(row).toHaveAttribute('aria-haspopup', 'dialog');
        expect(row).toHaveAttribute('aria-expanded', 'false');
        cleanup();

        act(() => setWeatherFollowTarget('crew', { ownerId: SKIPPER, fallback: 'boat' }));
        render(<Obs />);
        expect(screen.getByRole('button', { name: ROW })).toBeInTheDocument();
    });

    it('comes and goes with the follow target and with the account', () => {
        act(() => setWeatherFollowTarget('phone'));
        render(<Obs />);
        expect(screen.queryByRole('button', { name: ROW })).not.toBeInTheDocument();
        act(() => setWeatherFollowTarget('boat'));
        expect(screen.getByRole('button', { name: ROW })).toBeInTheDocument();
        // Another account on this phone follows its own choice: the phone.
        act(() => setAuthIdentityScope('skipper-gannet-41aa'));
        expect(screen.queryByRole('button', { name: ROW })).not.toBeInTheDocument();
    });

    it('sits under the Wind timeline only: not on the Rain tab, not while looking ahead, not embedded', () => {
        render(<Obs layers={['wind', 'rain']} />);
        expect(screen.getByRole('button', { name: ROW })).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Control Rain' }));
        expect(screen.queryByRole('button', { name: ROW })).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Control Wind' }));
        const panel = screen.getByRole('region', { name: 'Weather controls' });
        const row = within(panel).getByRole('button', { name: ROW });
        // After the timeline, so the timeline stays above the fold.
        const slider = within(panel).getByRole('slider', { name: 'Wind timeline' });
        expect(slider.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

        act(() => startPassageLookAhead());
        expect(screen.queryByRole('button', { name: ROW })).not.toBeInTheDocument();
        act(() => stopPassageLookAhead());
        expect(screen.getByRole('button', { name: ROW })).toBeInTheDocument();
        cleanup();

        render(<Obs embedded />);
        expect(screen.queryByRole('button', { name: ROW })).not.toBeInTheDocument();
    });
});

describe('Her wind vs the models: the card', () => {
    beforeEach(() => {
        localStorage.clear();
        setAuthIdentityScope(OWNER);
        reloadSharedBindersFromStorage();
        __resetWeatherPositionForTests();
        __clearModelCheckCacheForTests();
        setWeatherFollowTarget('boat');
        socket.state.status = 'disconnected';
        proxy.calls = 0;
        proxy.held = false;
        proxy.release = [];
        proxy.hours = [-2, -1, 0, 1, 2].map((h) => Date.UTC(2026, 9, 7, 12) + h * HOUR);
        vi.mocked(lookUpFollowedBoatCloudRow).mockClear();
    });
    afterEach(() => {
        cleanup();
        NmeaStore.stop();
        NmeaStore.clearRemote();
        socket.state.status = 'disconnected';
        setAuthIdentityScope(null);
        vi.useRealTimers();
    });

    it('opens outside the panel, and the panel does not auto-hide under it', async () => {
        vi.useFakeTimers({ now: START });
        render(<Obs />);
        // The control: with nothing open the panel hides itself after 6 s.
        await advance(7_000);
        expect(screen.queryByRole('region', { name: 'Weather controls' })).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Show weather controls' }));

        fireEvent.click(screen.getByRole('button', { name: ROW }));
        await flush();
        expect(dialog()).toBeInTheDocument();
        expect(dialog().closest('section[aria-label="Weather controls"]')).toBeNull();
        expect(screen.getByRole('button', { name: ROW })).toHaveAttribute('aria-expanded', 'true');
        await advance(7_000);
        expect(screen.getByRole('region', { name: 'Weather controls' })).toBeInTheDocument();
        expect(dialog()).toBeInTheDocument();
        // Nothing to compare (no instruments, no row): the refusal, and no request.
        expect(dialog()).toHaveTextContent('No wind reading from her right now, so there is nothing to compare.');
        expect(proxy.calls).toBe(0);
    });

    it('Escape and ✕ close it, and focus goes back to the row', async () => {
        render(<Obs />);
        const row = screen.getByRole('button', { name: ROW });
        for (const close of ['escape', 'button'] as const) {
            row.focus();
            fireEvent.click(row);
            expect(await screen.findByRole('dialog', { name: 'Her wind vs the models' })).toBeInTheDocument();
            if (close === 'escape') fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
            else fireEvent.click(within(dialog()).getByRole('button', { name: 'Close' }));
            await flush();
            expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
            expect(row).toHaveFocus();
        }
    });

    it('averages her gateway wind, asks the models once, and refuses when she goes quiet', async () => {
        vi.useFakeTimers({ now: START });
        socket.state.status = 'connected';
        NmeaStore.start();
        emit(14);
        render(<Obs />);
        fireEvent.click(screen.getByRole('button', { name: ROW }));
        await flush();
        await flush();
        expect(vi.mocked(lookUpFollowedBoatCloudRow)).toHaveBeenCalledTimes(1);
        expect(proxy.calls).toBe(1);
        expect(dialog()).toHaveTextContent('One reading is a snapshot, not a verdict.');
        expect(dialog()).toHaveTextContent('Boat instruments ·');
        const list = within(dialog()).getByRole('list', { name: 'Models, closest first' });
        expect(within(list).getAllByRole('listitem')).toHaveLength(5);
        expect(within(list).queryAllByRole('button')).toHaveLength(0);
        expect(dialog()).toHaveTextContent('Forecast data: DWD, ECMWF, UK Met Office, JMA (CC-BY-4.0) via Open-Meteo');

        // A new gateway aggregate every 5 s for a minute.
        for (let i = 1; i <= 12; i++) {
            await advance(5_000);
            emit(i % 2 ? 15 : 14);
            if (i === 6) expect(vi.mocked(lookUpFollowedBoatCloudRow)).toHaveBeenCalledTimes(2);
        }
        await advance(2_000);
        expect(dialog()).toHaveTextContent('1 min of her wind is a snapshot, not a verdict.');
        expect(dialog()).toHaveTextContent('1-min average to');
        // Re-checked thirty times in the minute, and still one request.
        expect(proxy.calls).toBe(1);

        // She goes quiet: the gateway's TWS dies at 13 s and the buffer goes with it.
        await advance(12_000);
        expect(dialog()).toHaveTextContent(/Her last wind reading is 1[34] s old\./);
        expect(dialog()).toHaveTextContent('One reading is a snapshot, not a verdict.');
        expect(within(dialog()).queryByRole('list')).not.toBeInTheDocument();
        expect(dialog()).not.toHaveTextContent('Forecast data:');
        // And back: one fresh reading is a snapshot again, from the series held.
        emit(16);
        await advance(2_000);
        expect(dialog()).toHaveTextContent('One reading is a snapshot, not a verdict.');
        expect(within(dialog()).getByRole('list', { name: 'Models, closest first' })).toBeInTheDocument();
        expect(proxy.calls).toBe(1);
    });

    it('a reply asked for where she was is never ranked against where she is now', async () => {
        vi.useFakeTimers({ now: START });
        socket.state.status = 'connected';
        NmeaStore.start();
        proxy.held = true;
        emit(14);
        render(<Obs />);
        fireEvent.click(screen.getByRole('button', { name: ROW }));
        await flush();
        expect(proxy.calls).toBe(1);
        expect(dialog()).toHaveTextContent('Getting the models at her position…');
        // Stands in for the follow moving to a boat far off (Switch boat, a crewing
        // ending): her next reading is 230 NM from the one the request was for.
        await advance(1_000);
        act(() => socket.emitSample(sample(15, HATTERAS)));
        await advance(1_000);
        expect(proxy.calls).toBe(2);
        // The first reply lands while the second is still out: nothing is ranked on it.
        await act(async () => proxy.release[0]());
        await flush();
        expect(dialog()).toHaveTextContent('Getting the models at her position…');
        expect(within(dialog()).queryByRole('list')).not.toBeInTheDocument();
        expect(dialog()).not.toHaveTextContent('Forecast data:');
        // Her own reply ranks her.
        await act(async () => proxy.release[1]());
        await flush();
        expect(within(dialog()).getByRole('list', { name: 'Models, closest first' })).toBeInTheDocument();
        expect(dialog()).toHaveTextContent('Forecast data:');
    });

    it('ⓘ trades the comparison for the details, credit and all; closing leaves no timer running', async () => {
        vi.useFakeTimers({ now: START });
        socket.state.status = 'connected';
        NmeaStore.start();
        emit(14);
        render(<Obs />);
        fireEvent.click(screen.getByRole('button', { name: ROW }));
        await flush();
        await flush();
        const how = within(dialog()).getByRole('button', { name: 'How this works' });
        expect(how).toHaveAttribute('aria-pressed', 'false');
        expect(dialog()).toHaveTextContent('Forecast data:');
        fireEvent.click(how);
        expect(how).toHaveAttribute('aria-pressed', 'true');
        expect(dialog()).toHaveTextContent('Only the five global models are checked.');
        expect(dialog()).not.toHaveTextContent('Forecast data:');
        expect(within(dialog()).queryByRole('list')).not.toBeInTheDocument();
        fireEvent.click(how);
        expect(dialog()).toHaveTextContent('Forecast data:');

        fireEvent.click(within(dialog()).getByRole('button', { name: 'Close' }));
        await flush();
        cleanup();
        NmeaStore.stop();
        // jsdom queues a 0 ms selectionchange task on every focus(); let it run.
        await advance(1);
        expect(vi.getTimerCount()).toBe(0);
    });
});

describe('Her wind vs the models: the source contract', () => {
    const source = readFileSync(resolve(process.cwd(), 'components/map/MapWeatherControls.tsx'), 'utf8');

    it('the card is a lazy chunk declared at module scope, never a static import', () => {
        expect(source).toMatch(/^const ModelCheckAtBoat = lazyRetry\(/m);
        expect(source).toContain("'ModelCheckAtBoat'");
        expect(source).not.toMatch(/from '\.\/ModelCheckAtBoat'/);
    });

    it('the card chains to nothing in the chart chunk, so its lazy chunk stays small', () => {
        // closeInWind and obsBoatInstruments live in MapHub's chunk; importing either
        // made Rollup hoist MapHub's whole import list into the card (about 4.6 KB).
        for (const file of [
            'components/map/boatModelCheck.ts',
            'components/map/ModelCheckAtBoat.tsx',
            'components/map/useFollowedBoatKey.ts',
        ]) {
            const text = readFileSync(resolve(process.cwd(), file), 'utf8');
            expect(text, file).not.toMatch(/from '[^']*\/(closeInWind|obsBoatInstruments|CloudTelemetryService)'/);
        }
    });

    it('its hooks sit above the early return, and the auto-hide stands down while it is open', () => {
        const early = source.indexOf('if (!visible) return null;');
        expect(early).toBeGreaterThan(0);
        expect(source.indexOf('useFollowedBoatKey()')).toBeGreaterThan(0);
        expect(source.indexOf('useFollowedBoatKey()')).toBeLessThan(early);
        expect(source.indexOf('useState(false)')).toBeLessThan(early);
        expect(source).toMatch(/enabled: visible && !embedded && surfaceAvailable && !checkOpen,/);
    });
});
