/**
 * Voyage plans keep chart facts in memory only (127-C-b, C10 stores 3 and 4).
 *
 * An inshore plan worked out on licensed charts is written to the device and
 * to the Log as its line, its distance and number-free notes; the full plan,
 * depths and all, stays in memory for the session. Opened again after a
 * relaunch, the departure planner never treats the route as tide-clear because
 * its tide gates were not kept, and its tide curve is asked for at the 0.25°
 * bucket centre, never at a charted shallow spot. Fictional cells and places:
 * OC-99-ZZTEST off Nouméa (protected), US5XX01M in the Chesapeake (open).
 */
import React from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VesselProfile, VoyagePlan } from '../types';

const m = vi.hoisted(() => ({
    storage: new Map<string, unknown>(),
    saveImmediate: vi.fn(),
    sweep: vi.fn(),
    tide: vi.fn(),
    settings: {
        defaultLocation: undefined,
        defaultLocationCoords: undefined,
        forecastModel: 'gfs',
        satelliteMode: false,
    },
}));

vi.mock('../context/SettingsContext', () => ({
    useSettings: () => ({ settings: m.settings, updateSettings: vi.fn(), loading: false }),
}));
vi.mock('../services/nativeStorage', () => ({
    usesNativeEncryptedLargeStorage: () => false,
    DATA_CACHE_KEY: 'thalassa_weather_cache_v9',
    VOYAGE_CACHE_KEY: 'thalassa_voyage_cache_v2',
    HISTORY_CACHE_KEY: 'thalassa_history_cache_v3',
    saveLargeData: vi.fn(async (key: string, value: unknown) => {
        m.storage.set(key, structuredClone(value));
    }),
    saveLargeDataImmediate: vi.fn(async (key: string, value: unknown) => {
        m.saveImmediate(key, value);
        m.storage.set(key, structuredClone(value));
    }),
    loadLargeData: vi.fn(async (key: string) => {
        if (key.startsWith('thalassa_weather_cache_schema::')) return 'v19.2-WEATHERKIT-FIX';
        return structuredClone(m.storage.get(key) ?? null);
    }),
    loadLargeDataSync: vi.fn((key: string) => {
        if (key.startsWith('thalassa_weather_cache_schema::')) return 'v19.2-WEATHERKIT-FIX';
        return structuredClone(m.storage.get(key) ?? null);
    }),
    deleteLargeData: vi.fn(async (key: string) => {
        m.storage.delete(key);
    }),
    readCacheVersion: vi.fn(async () => 'v19.2-WEATHERKIT-FIX'),
    writeCacheVersion: vi.fn(async () => undefined),
}));
vi.mock('../services/GpsService', () => ({
    GpsService: { getCurrentPosition: vi.fn(async () => null), getCurrentPositionIfGranted: vi.fn(async () => null) },
}));
vi.mock('../services/weatherService', () => ({
    fetchWeatherByStrategy: vi.fn(),
    fetchPrecisionWeather: vi.fn(),
    parseLocation: vi.fn(),
    reverseGeocode: vi.fn(),
}));
vi.mock('../services/EnvironmentService', () => ({ EnvironmentService: { updateFromWeatherData: vi.fn() } }));
vi.mock('../components/Toast', () => ({
    toast: { info: vi.fn(), error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));
vi.mock('../services/routing/DepartureSweepInshore', () => ({ sweepDepartures: m.sweep }));
vi.mock('../services/TideHeightService', () => ({ fetchTideCurve: m.tide, TIDE_CURVE_MAX_DAYS: 14 }));
vi.mock('../services/routing/env/CmemsCurrentField', () => ({ getCurrentField: vi.fn(async () => null) }));

import { WeatherProvider, useWeather } from '../context/WeatherContext';
import { weatherCacheKeysForScope } from '../services/WeatherOrchestrator';
import { getAuthIdentityScope, setAuthIdentityScope } from '../services/authIdentityScope';
import { clearAllCellMetadata, putCell } from '../services/enc/EncCellMetadata';
import { CHART_NOTES_ABOARD, DRY_LINE_ABOARD, TIDE_GATES_ABOARD } from '../services/chartFacts';
import { DRY_RUN_CAVEAT_PREFIX, plannedRouteDryFinding } from '../services/routing/dryRunWords';
import { routeCaveatNotes } from '../services/shiplog/PassagePlanSave';
import { savedInshoreRouteCaveats } from '../components/map/inshoreRouteNotice';
import { DepartureSweepSheet } from '../components/passage/DepartureSweepSheet';
import { useFollowRouteStore } from '../stores/followRouteStore';
import { awaitSettingsLoaded, useSettingsStore } from '../stores/settingsStore';

const DRAFT_FT = 7.87;
const VESSEL: VesselProfile = {
    name: 'Fictional sloop',
    type: 'sail',
    length: 40,
    beam: 13,
    draft: DRAFT_FT,
    displacement: 20000,
    maxWaveHeight: 10,
    cruisingSpeed: 6,
    draftConfirmedFt: DRAFT_FT,
};

const FIGURES = ['1.37', '0.57', '166.4233', '-22.3011', 'Récif Fictif'];
const line: [number, number][] = [
    [166.41, -22.27],
    [166.43, -22.31],
    [166.45, -22.33],
];
function plan(cellsUsed: string[]): VoyagePlan {
    return {
        origin: 'Port Moselle',
        destination: 'Ilot Maitre',
        departureDate: '2026-10-11T07:00:00.000Z',
        originCoordinates: { lat: -22.27, lon: 166.41 },
        destinationCoordinates: { lat: -22.33, lon: 166.45 },
        distanceApprox: '3.1 NM',
        durationApprox: '0.6 hours',
        overview: 'Inshore passage',
        waypoints: [],
        routeGeoJSON: {
            type: 'Feature',
            geometry: { type: 'LineString', coordinates: line },
            properties: {
                source: 'inshore-router',
                distanceNM: 3.1,
                cellsUsed,
                shallowRuns: [
                    {
                        startSeg: 0,
                        endSeg: 1,
                        lengthM: 412,
                        minDepthM: 1.37,
                        midLat: -22.29,
                        midLon: 166.42,
                        minAtLat: -22.3011,
                        minAtLon: 166.4233,
                    },
                ],
                dryRuns: [
                    {
                        startSeg: 1,
                        startT: 0.2,
                        endSeg: 1,
                        endT: 0.6,
                        lengthM: 288,
                        mid: [166.44, -22.32],
                        place: 'Récif Fictif',
                        shallowestM: -0.57,
                        deepestM: 0.4,
                        draftM: 2.4,
                        needM: 2.9,
                        tide: { topM: 1.6, days: 14 },
                    },
                ],
            },
        },
        __inshoreRouting: {
            status: 'success',
            cellsUsed,
            distanceNM: 3.1,
            caveats: [
                `${DRY_RUN_CAVEAT_PREFIX}: the Récif Fictif dries 0.57 m (2.40 m draft + 0.50 m under the keel).`,
            ],
        },
    } as VoyagePlan;
}
const textOf = (value: unknown) => JSON.stringify(value);

let latest: ReturnType<typeof useWeather> | null = null;
function Probe() {
    latest = useWeather();
    return <div data-testid="voyage">{latest.voyagePlan ? 'voyage' : 'none'}</div>;
}

beforeEach(() => {
    localStorage.clear();
    clearAllCellMetadata();
    putCell({
        id: 'OC-99-ZZTEST',
        sourceHO: 'FR',
        edition: 2,
        issued: '2026-08-01',
        importedAt: '2026-09-01T00:00:00.000Z',
        bbox: [166.3, -22.4, 166.5, -22.2],
        geojsonPath: 'enc/OC-99-ZZTEST.json',
        hazardCount: 1,
        usage: 'navigation',
    });
    m.storage.clear();
    m.saveImmediate.mockReset();
    m.sweep.mockReset().mockReturnValue({ options: [], best: null, currentProvenance: 'NONE' });
    m.tide.mockReset().mockResolvedValue(null);
    latest = null;
    setAuthIdentityScope('voyage-owner');
});
afterEach(() => {
    cleanup();
    setAuthIdentityScope(null);
});

describe('the voyage plan on disk', () => {
    it('writes only the allow-listed facts and keeps the full plan in memory for the session', async () => {
        render(
            <WeatherProvider>
                <Probe />
            </WeatherProvider>,
        );
        await waitFor(() => expect(latest).not.toBeNull());
        const full = plan(['OC-99-ZZTEST']);
        await act(async () => {
            latest!.saveVoyagePlan(full);
        });
        expect(latest!.voyagePlan).toBe(full);
        const stored = m.storage.get(weatherCacheKeysForScope(getAuthIdentityScope()).voyage) as VoyagePlan;
        const props = stored.routeGeoJSON!.properties as Record<string, unknown>;
        expect(props.chartFacts).toBe('aboard-only');
        expect(props.shallowRuns).toBeUndefined();
        expect(props.dryRuns).toBeUndefined();
        expect(stored.routeGeoJSON!.geometry.coordinates).toEqual(line);
        for (const figure of FIGURES) expect(textOf(stored), figure).not.toContain(figure);
    });

    it('a boot load re-saves a stored plan that still carries chart facts', async () => {
        const key = weatherCacheKeysForScope(getAuthIdentityScope()).voyage;
        m.storage.set(key, plan(['OC-99-ZZTEST']));
        render(
            <WeatherProvider>
                <Probe />
            </WeatherProvider>,
        );
        await waitFor(() => expect(screen.getByTestId('voyage')).toHaveTextContent('voyage'));
        await waitFor(() => expect(m.saveImmediate).toHaveBeenCalledWith(key, expect.anything()));
        for (const figure of FIGURES) expect(textOf(m.storage.get(key)), figure).not.toContain(figure);
    });

    it("the planner's reset (saveVoyagePlan(null)) never throws and clears the stored plan", async () => {
        // RoutePlanner's mount effect calls useVoyageForm.clearVoyagePlan, which saves null.
        const key = weatherCacheKeysForScope(getAuthIdentityScope()).voyage;
        render(
            <WeatherProvider>
                <Probe />
            </WeatherProvider>,
        );
        await waitFor(() => expect(latest).not.toBeNull());
        await act(async () => {
            latest!.saveVoyagePlan(plan(['OC-99-ZZTEST']));
        });
        expect(() =>
            act(() => {
                latest!.saveVoyagePlan(null as unknown as VoyagePlan);
            }),
        ).not.toThrow();
        expect(latest!.voyagePlan).toBeNull();
        expect(m.storage.get(key)).toBeNull();
    });

    it('a plan already stored number-free is not written again at every launch', async () => {
        const key = weatherCacheKeysForScope(getAuthIdentityScope()).voyage;
        const { chartFreeVoyagePlan } = await import('../services/chartFacts');
        m.storage.set(key, JSON.parse(JSON.stringify(chartFreeVoyagePlan(plan(['OC-99-ZZTEST'])))));
        render(
            <WeatherProvider>
                <Probe />
            </WeatherProvider>,
        );
        await waitFor(() => expect(screen.getByTestId('voyage')).toHaveTextContent('voyage'));
        await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
        expect(m.saveImmediate).not.toHaveBeenCalledWith(key, expect.anything());
    });

    it('a failed boot re-save still shows the stored plan', async () => {
        const key = weatherCacheKeysForScope(getAuthIdentityScope()).voyage;
        m.storage.set(key, plan(['OC-99-ZZTEST']));
        m.saveImmediate.mockImplementation(() => {
            throw new Error('encrypted write could not be verified');
        });
        render(
            <WeatherProvider>
                <Probe />
            </WeatherProvider>,
        );
        await waitFor(() => expect(screen.getByTestId('voyage')).toHaveTextContent('voyage'));
        expect(m.saveImmediate).toHaveBeenCalledWith(key, expect.anything());
    });

    it('an all-NOAA plan is written exactly as it is', async () => {
        render(
            <WeatherProvider>
                <Probe />
            </WeatherProvider>,
        );
        await waitFor(() => expect(latest).not.toBeNull());
        const noaa = plan(['US5XX01M']);
        await act(async () => {
            latest!.saveVoyagePlan(noaa);
        });
        expect(m.storage.get(weatherCacheKeysForScope(getAuthIdentityScope()).voyage)).toEqual(noaa);
    });

    it('a followed plan is persisted without its chart facts too', () => {
        useFollowRouteStore.getState().startFollowing(plan(['OC-99-ZZTEST']), 'voyage-1', [
            { lat: -22.27, lon: 166.41 },
            { lat: -22.33, lon: 166.45 },
        ]);
        const stored = Array.from({ length: localStorage.length }, (_, i) =>
            localStorage.getItem(localStorage.key(i)!),
        );
        const follow = stored.find((value) => value?.includes('voyage-1'));
        expect(follow).toBeTruthy();
        for (const figure of FIGURES) expect(follow, figure).not.toContain(figure);
        useFollowRouteStore.getState().stopFollowing();
    });
});

describe('the Log notes and the follow finding', () => {
    it('routeCaveatNotes writes number-free lines, and the red finding still fires from them', () => {
        const notes = routeCaveatNotes(plan(['OC-99-ZZTEST']));
        for (const figure of FIGURES) expect(notes, figure).not.toContain(figure);
        expect(notes).toContain(DRY_LINE_ABOARD);
        expect(notes).toContain(CHART_NOTES_ABOARD);
        expect(plannedRouteDryFinding(notes)?.tone).toBe('finding');
        // NOAA notes are written as they were.
        expect(routeCaveatNotes(plan(['US5XX01M']))).toContain('dries 0.57 m');
    });

    it("a plan opened again shows the kept lines, not lines rebuilt from what wasn't kept", async () => {
        const { chartFreeVoyagePlan } = await import('../services/chartFacts');
        const kept = chartFreeVoyagePlan(plan(['OC-99-ZZTEST']));
        expect(savedInshoreRouteCaveats(kept)).toEqual(kept.__inshoreRouting!.caveats);
    });
});

describe('the departure planner never sweeps a plan whose tide gates stayed aboard', () => {
    it('says the tide gates need her charts and offers no tide-clear departure', async () => {
        const { chartFreeVoyagePlan } = await import('../services/chartFacts');
        const kept = chartFreeVoyagePlan(plan(['OC-99-ZZTEST']));
        render(<DepartureSweepSheet open onClose={vi.fn()} voyagePlan={kept} vessel={VESSEL} onAccept={vi.fn()} />);
        expect(await screen.findByText(TIDE_GATES_ABOARD)).toBeInTheDocument();
        await act(() => new Promise((resolve) => setTimeout(resolve, 30)));
        expect(m.sweep).not.toHaveBeenCalled();
        expect(screen.queryByText('CLEAR')).toBeNull();
        expect(screen.queryByText(/plan a route first/)).toBeNull();
    });

    it('a route with no tide gates is still swept after a relaunch', async () => {
        await awaitSettingsLoaded();
        useSettingsStore.setState({ settings: { ...useSettingsStore.getState().settings, vessel: VESSEL } });
        const { chartFreeVoyagePlan } = await import('../services/chartFacts');
        const deep = plan(['OC-99-ZZTEST']);
        const props = deep.routeGeoJSON!.properties as Record<string, unknown>;
        props.shallowRuns = [];
        delete props.dryRuns;
        const kept = chartFreeVoyagePlan(deep);
        render(<DepartureSweepSheet open onClose={vi.fn()} voyagePlan={kept} vessel={VESSEL} onAccept={vi.fn()} />);
        await waitFor(() => expect(m.sweep).toHaveBeenCalled());
        expect(screen.queryByText(TIDE_GATES_ABOARD)).toBeNull();
    });

    it('asks for the tide curve at the bucket centre, never at a charted shallow spot', async () => {
        // The sweep waits for a confirmed draft in the settings store.
        await awaitSettingsLoaded();
        useSettingsStore.setState({ settings: { ...useSettingsStore.getState().settings, vessel: VESSEL } });
        render(
            <DepartureSweepSheet
                open
                onClose={vi.fn()}
                voyagePlan={plan(['OC-99-ZZTEST'])}
                vessel={VESSEL}
                onAccept={vi.fn()}
            />,
        );
        await waitFor(() => expect(m.tide).toHaveBeenCalled());
        const [, , , , opts] = m.tide.mock.calls[0];
        expect(opts).toEqual({ days: 14 });
        await waitFor(() => expect(m.sweep).toHaveBeenCalled());
    });
});
