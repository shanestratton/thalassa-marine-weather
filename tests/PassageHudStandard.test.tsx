/**
 * The passage HUD is standard (build 124, package HS) — there is no switch.
 *
 * Shane, 2026-10-08, on build 123: "the HUD is not working on the obs page when
 * you pull up a route????", then "I cannot see the setting in preference,
 * however, I don't think that we need a setting for it. It should just be the
 * standard setup for routes. Or tracks on the log page."
 *
 * THE RULE: the HUD follows the route on screen.
 *   - A followed route, or a recording that is running or paused, has its HUD
 *     with nothing to switch on.
 *   - A route pulled up on Obs (Layers → Routes) that is not the followed one is
 *     PREVIEWED: labelled "Preview — not following", looked ahead from its first
 *     point at a departure the skipper chooses in the existing departure dialog,
 *     and it writes NO follow state — no startFollowing, no plan-link rows, no
 *     destination flag (which rides the Passage overlay), nothing for the 24 h
 *     drop to find.
 *   - Clear the pick and the followed route's live strip is back.
 *
 * The routes here are fictional passages in the English Channel and the
 * Caribbean: this is a global app.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../utils/system', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../utils/system')>()),
    triggerHaptic: vi.fn(),
}));
const receiver = vi.hoisted(() => ({
    status: {
        active: true,
        kind: 'nmea',
        label: 'On-board GPS',
        detail: 'Live via the Pi · GPS · 9 sats · HDOP 1.0',
        isNmea: true,
        satellites: 9,
        hdop: 1,
        avgAccuracy: null,
        qualityLabel: null,
        deviceName: 'fixture-pi',
    },
}));
vi.mock('../services/GpsReceiverStatusService', () => ({
    GpsReceiverStatusService: { getStatus: () => receiver.status, refresh: () => Promise.resolve(receiver.status) },
}));
const gps = vi.hoisted(() => ({ watches: 0 }));
vi.mock('../services/GpsService', () => ({
    GpsService: {
        getLastKnownPosition: () => null,
        watchPosition: () => {
            gps.watches += 1;
            return () => {
                gps.watches -= 1;
            };
        },
    },
}));
vi.mock('../services/VoyageService', () => ({ getCachedActiveVoyage: () => null }));
const recording = vi.hoisted(() => ({
    state: {
        isTracking: false,
        isPaused: false,
        isRapidMode: false,
    } as import('../services/shiplog/TrackingStateStore').TrackingState,
}));
vi.mock('../hooks/useHudRecording', () => ({
    useHudRecording: () => recording.state,
    useHudRecordingActivation: () => undefined,
}));
vi.mock('../hooks/usePassageRecordingMetrics', () => ({
    usePassageRecordingMetrics: () => ({
        distanceNm: 4.2,
        recordedAt: Date.now(),
        departedAt: Date.now() - 3_600_000,
        nowMs: Date.now(),
    }),
}));
vi.mock('../stores/settingsStore', () => {
    const state = () => ({ settings: { vessel: { cruisingSpeed: 6, length: 40, type: 'sail' }, units: {} } });
    return {
        useSettingsStore: Object.assign((selector: (s: ReturnType<typeof state>) => unknown) => selector(state()), {
            getState: state,
            subscribe: () => () => undefined,
        }),
    };
});
// The follow side effects a preview must never reach.
const followWrites = vi.hoisted(() => ({
    setPlanLinkWithRetry: vi.fn(async () => true),
    queuePlanLinkIntent: vi.fn(),
    publishFollowedRoute: vi.fn(async () => 'linked'),
    publishFollowedRouteDetailed: vi.fn(async () => ({ result: 'linked' })),
}));
vi.mock('../services/shiplog/planLinkIntent', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../services/shiplog/planLinkIntent')>()),
    setPlanLinkWithRetry: followWrites.setPlanLinkWithRetry,
    queuePlanLinkIntent: followWrites.queuePlanLinkIntent,
}));
vi.mock('../services/shiplog/publishFollowedRoute', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../services/shiplog/publishFollowedRoute')>()),
    publishFollowedRoute: followWrites.publishFollowedRoute,
    publishFollowedRouteDetailed: followWrites.publishFollowedRouteDetailed,
}));
// The forecast service: a steady breeze everywhere, a gentle sea.
const HOUR = 3_600_000;
vi.mock('../services/weather/openMeteoProxy', () => ({
    fetchOpenMeteoPoints: async (
        op: string,
        points: { lat: number; lon: number }[],
        params: Record<string, unknown>,
    ) => {
        const t0 = Math.floor(Date.now() / HOUR) * HOUR;
        const time = Array.from({ length: 169 }, (_h, h) => (t0 + h * HOUR) / 1000);
        const col = (value: number | null) => time.map(() => value);
        if (op === 'marine') {
            return points.map((p) => ({
                latitude: p.lat,
                longitude: p.lon,
                hourly_units: {
                    wave_height_meteofrance_wave: 'm',
                    wave_period_meteofrance_wave: 's',
                    ocean_current_velocity_marine_best_match: 'km/h',
                    ocean_current_direction_marine_best_match: '°',
                },
                hourly: {
                    time,
                    wave_height_meteofrance_wave: col(1.1),
                    wave_period_meteofrance_wave: col(6),
                    wave_direction_meteofrance_wave: col(250),
                    ocean_current_velocity_marine_best_match: col(0.9),
                    ocean_current_direction_marine_best_match: col(90),
                },
            }));
        }
        const models = String(params.models).split(',');
        return points.map(() => {
            const hourly: Record<string, (number | null)[]> = { time };
            for (const model of models) {
                const sfx = models.length > 1 ? `_${model}` : '';
                hourly[`wind_speed_10m${sfx}`] = col(14);
                hourly[`wind_direction_10m${sfx}`] = col(240);
                hourly[`wind_gusts_10m${sfx}`] = col(20);
                hourly[`precipitation${sfx}`] = col(0);
                hourly[`precipitation_probability${sfx}`] = col(10);
            }
            return { hourly };
        });
    },
}));

import { PassageHudPane } from '../components/passage/PassageHudPane';
import { NmeaStore } from '../services/NmeaStore';
import { useFollowRouteStore } from '../stores/followRouteStore';
import * as hudStore from '../stores/passageHudStore';
import {
    __resetPassageHudForTests,
    getPassageGhost,
    getPassageLookAhead,
    setPassageHudOpen,
    setPassageSpeedPref,
} from '../stores/passageHudStore';
import { __resetPassageOverlayForTests, isPassageOverlayOn, setPassageOverlay } from '../stores/chartPassageOverlay';
import { setAuthIdentityScope } from '../services/authIdentityScope';
import { __clearRouteForecastCacheForTests } from '../services/routeForecastSampler';
import { __clearRouteSpreadCacheForTests } from '../services/routeForecastSpread';
import { __clearRouteSeaCacheForTests } from '../services/routeSeaSampler';
import { nextPreviewDeparture } from '../services/passageDeparture';
import { ObsLayerKey, type ObsLayerKeyProps } from '../components/map/ObsLayerKey';
import type { VoyagePlan } from '../types';

/** The API this package adds, read off the namespace so the current code fails per test, not per file. */
type PreviewRoute = { id: string; label: string; points: readonly { lat: number; lon: number }[] };
const setPreview = (route: PreviewRoute | null) =>
    (hudStore as unknown as { setPassageHudPreviewRoute: (r: PreviewRoute | null) => void }).setPassageHudPreviewRoute(
        route,
    );

// A fictional Channel crossing, and a fictional Caribbean hop to follow meanwhile.
const CROSSING: PreviewRoute = {
    id: 'saved-cowes-cherbourg',
    label: 'Cowes → Cherbourg',
    points: [
        { lat: 50.77, lon: -1.3 },
        { lat: 50.3, lon: -1.45 },
        { lat: 49.66, lon: -1.62 },
    ],
};
const FOLLOWED_PLAN = { origin: 'Rodney Bay', destination: 'Bequia', waypoints: [] } as unknown as VoyagePlan;
const FOLLOWED = [
    { lat: 14.08, lon: -60.95 },
    { lat: 13.5, lon: -61.1 },
    { lat: 13.0, lon: -61.24 },
];

const text = (id: string) => screen.getByTestId(id).textContent ?? '';
/** The tab the strip leaves on the chart when its readings are tucked away. */
const closedTab = () => {
    const tab = document.querySelector<HTMLElement>('.thalassa-passage-hud-tab');
    if (!tab) throw new Error('no HUD tab on the chart');
    return tab;
};
const label = (id: string) => screen.getByTestId(id).getAttribute('aria-label') ?? '';

beforeEach(() => {
    localStorage.clear();
    __resetPassageHudForTests();
    __resetPassageOverlayForTests();
    __clearRouteForecastCacheForTests();
    __clearRouteSpreadCacheForTests();
    __clearRouteSeaCacheForTests();
    setPassageSpeedPref('cruise');
    recording.state = { isTracking: false, isPaused: false, isRapidMode: false };
    NmeaStore.clearRemote();
    useFollowRouteStore.getState().stopFollowing();
    followWrites.setPlanLinkWithRetry.mockClear();
    followWrites.queuePlanLinkIntent.mockClear();
    followWrites.publishFollowedRoute.mockClear();
    followWrites.publishFollowedRouteDetailed.mockClear();
    gps.watches = 0;
});

afterEach(() => {
    cleanup();
    try {
        setPreview(null);
    } catch {
        /* the current code has no preview to clear */
    }
    useFollowRouteStore.getState().stopFollowing();
    NmeaStore.clearRemote();
});

// ── No switch ─────────────────────────────────────────────────

const SOURCE_ROOTS = ['App.tsx', 'components', 'stores', 'hooks', 'pages', 'services', 'e2e', 'scripts', 'utils'];
function sourceFiles(path: string): string[] {
    const stat = statSync(path);
    if (stat.isFile()) return /\.(tsx?|mjs|js)$/.test(path) ? [path] : [];
    return readdirSync(path)
        .filter((name) => name !== 'node_modules')
        .flatMap((name) => sourceFiles(join(path, name)));
}

describe('there is no Passage HUD switch anywhere', () => {
    it('the store has no enable switch, and nothing in the app remembers or sets one', () => {
        for (const name of ['setPassageHudEnabled', 'isPassageHudEnabled', 'usePassageHudEnabled']) {
            expect(name in hudStore, `stores/passageHudStore exports ${name}`).toBe(false);
        }
        const offenders = SOURCE_ROOTS.flatMap(sourceFiles).filter((file) => {
            const code = readFileSync(file, 'utf8');
            return code.includes('PassageHudEnabled') || code.includes('thalassa_passage_hud_enabled_v1');
        });
        expect(offenders).toEqual([]);
    });

    it('Obs Layers has no Passage HUD toggle row, and Preferences has no HUD setting', async () => {
        const layer = await import('../components/map/passageHudLayer');
        expect('passageHudLayerSources' in layer).toBe(false);
        const hub = readFileSync('components/map/MapHub.tsx', 'utf8');
        expect(hub).not.toContain('passageHudLayerSources');
        expect(hub).not.toMatch(/id: 'passage-hud'/);
        expect(hub).not.toMatch(/label: 'Passage HUD'/);
        const preferences = readFileSync('components/settings/GeneralTab.tsx', 'utf8');
        expect(preferences).not.toMatch(/Passage HUD|PassageStrip|passageHud/);
    });

    it('the chart steps aside for the strip whenever it is shown, with no switch in the rule', () => {
        const app = readFileSync('App.tsx', 'utf8');
        expect(app).toMatch(/chartVisible && passageHudShown && passageHudOpen && !mapPickerActive && !tracerActive/);
        expect(readFileSync('components/map/ThalassaHelixControl.tsx', 'utf8')).toContain(
            'const showLegend = legendChoice ?? !(hudShown && hudOpen && !embedded);',
        );
    });
});

// ── Followed route and recording ──────────────────────────────

describe('a followed route and a recording show the HUD as before, with nothing to switch on', () => {
    it('a followed route has its HUD tab, and its live strip when opened', () => {
        useFollowRouteStore.getState().startFollowing(FOLLOWED_PLAN, 'voyage-caribbean', FOLLOWED);
        render(<PassageHudPane />);
        fireEvent.click(screen.getByRole('button', { name: 'Show passage instruments' }));
        expect(screen.getByTestId('passage-hud')).toBeVisible();
        expect(screen.getByTestId('passage-hud')).toHaveAttribute('data-subject', 'route');
        expect(label('hud-route')).toContain('Following Rodney Bay → Bequia');
        expect(screen.queryByTestId('hud-preview')).toBeNull();
    });

    it('a running or paused recording has its HUD', () => {
        recording.state = { isTracking: true, isPaused: false, isRapidMode: false, currentVoyageId: 'rec-solent' };
        setPassageHudOpen(true);
        const view = render(<PassageHudPane />);
        expect(screen.getByTestId('passage-hud')).toHaveAttribute('data-subject', 'recording');
        expect(screen.getByTestId('hud-recorded-distance')).toBeVisible();
        recording.state = { ...recording.state, isTracking: false, isPaused: true };
        view.rerender(<PassageHudPane />);
        expect(screen.getByTestId('hud-recorded-distance')).toBeVisible();
    });

    it('with no route, recording or preview there is nothing on the chart', () => {
        setPassageHudOpen(true);
        const { container } = render(<PassageHudPane />);
        expect(container).toBeEmptyDOMElement();
    });
});

// ── Preview ───────────────────────────────────────────────────

describe('a route pulled up on Obs is previewed, clearly labelled', () => {
    beforeEach(() => setPassageHudOpen(true));

    it('shows the preview label, the route and a departure control', () => {
        setPreview(CROSSING);
        render(<PassageHudPane />);
        const pane = screen.getByTestId('passage-hud');
        expect(pane).toHaveAttribute('data-subject', 'preview');
        expect(pane.getAttribute('aria-label')).toBe('Route preview, not following');
        expect(text('hud-preview')).toBe('Preview — not following');
        expect(label('hud-route')).toContain('Cowes → Cherbourg');
        expect(label('hud-route')).toContain('not followed');
        // The crossing is ~66 NM; the strip shows the whole route from its first point.
        expect(text('hud-route')).toMatch(/6[5-8]NM/);
        const departure = screen.getByRole('button', { name: 'Choose a departure to preview Cowes → Cherbourg' });
        expect(departure).toBeEnabled();
        expect(departure).toHaveTextContent('Depart');
        // No GPS is watched for a route she is not on.
        expect(gps.watches).toBe(0);
        // The followed passage's chart button is not offered under a preview.
        expect(screen.queryByTestId('hud-show-passage')).toBeNull();
    });

    it('the departure control opens the existing departure dialog at the next whole hour', () => {
        setPreview(CROSSING);
        render(<PassageHudPane />);
        const before = Date.now();
        fireEvent.click(screen.getByTestId('hud-look-ahead'));
        const dialog = screen.getByRole('dialog', { name: 'When will you leave?' });
        expect(dialog).toBeVisible();
        expect(within(dialog).getByText('Cowes → Cherbourg')).toBeVisible();
        expect(screen.getByRole('button', { name: 'Choose a time' })).toHaveAttribute('aria-pressed', 'true');
        const expected = new Date(nextPreviewDeparture(before));
        const pad = (n: number) => String(n).padStart(2, '0');
        expect(screen.getByLabelText('Departure time')).toHaveValue(
            `${pad(expected.getHours())}:${pad(expected.getMinutes())}`,
        );
        expect(getPassageLookAhead().on).toBe(false);
    });

    it('looks ahead from the route’s first point at the chosen departure', async () => {
        setPreview(CROSSING);
        render(<PassageHudPane />);
        fireEvent.click(screen.getByTestId('hud-look-ahead'));
        fireEvent.click(screen.getByRole('button', { name: /Preview passage/ }));
        expect(getPassageLookAhead().on).toBe(true);
        expect(getPassageLookAhead().departureMs).not.toBeNull();
        await waitFor(() => expect(getPassageGhost()).not.toBeNull());
        expect(getPassageGhost()).toMatchObject({ lat: CROSSING.points[0].lat, lon: CROSSING.points[0].lon });
        expect(getPassageGhost()?.label).toBe('DEPART');
        // Still labelled as a preview while it is a forecast.
        expect(text('hud-preview')).toBe('Preview — not following');
        expect(screen.getByTestId('passage-hud')).toHaveAttribute('data-mode', 'forecast');
        await waitFor(() => expect(text('hud-tws')).toContain('14'));
        expect(text('hud-route')).toMatch(/6[5-8]NM/);
    });

    it('writes no follow state: no follow, no plan link, no flag, nothing for the 24 h drop', async () => {
        const followStoreWrites = vi.fn();
        const unsubscribe = useFollowRouteStore.subscribe(followStoreWrites);
        const setItem = vi.spyOn(Storage.prototype, 'setItem');
        try {
            setPreview(CROSSING);
            render(<PassageHudPane />);
            fireEvent.click(screen.getByTestId('hud-look-ahead'));
            fireEvent.click(screen.getByRole('button', { name: /Preview passage/ }));
            await waitFor(() => expect(getPassageGhost()).not.toBeNull());
            expect(followStoreWrites).not.toHaveBeenCalled();
            expect(useFollowRouteStore.getState()).toMatchObject({ isFollowing: false, voyageId: null });
            expect(followWrites.setPlanLinkWithRetry).not.toHaveBeenCalled();
            expect(followWrites.queuePlanLinkIntent).not.toHaveBeenCalled();
            expect(followWrites.publishFollowedRoute).not.toHaveBeenCalled();
            expect(followWrites.publishFollowedRouteDetailed).not.toHaveBeenCalled();
            // The destination flag and the followed line ride the Passage overlay.
            expect(isPassageOverlayOn()).toBe(false);
            const keys = setItem.mock.calls.map(([key]) => key);
            expect(
                keys.filter((key) => /follow|plan_link|route_authority|voyage_plan|passage_overlay/i.test(key)),
            ).toEqual([]);
        } finally {
            unsubscribe();
            setItem.mockRestore();
        }
    });

    it('takes over from a followed route while it is up, and gives it back when cleared', async () => {
        useFollowRouteStore.getState().startFollowing(FOLLOWED_PLAN, 'voyage-caribbean', FOLLOWED);
        render(<PassageHudPane />);
        expect(label('hud-route')).toContain('Following Rodney Bay → Bequia');
        act(() => setPreview(CROSSING));
        expect(screen.getByTestId('passage-hud')).toHaveAttribute('data-subject', 'preview');
        expect(label('hud-route')).toContain('Cowes → Cherbourg');
        expect(screen.queryByTestId('hud-fix-source')).toBeNull();
        fireEvent.click(screen.getByTestId('hud-look-ahead'));
        fireEvent.click(screen.getByRole('button', { name: /Preview passage/ }));
        await waitFor(() => expect(getPassageGhost()).not.toBeNull());
        expect(getPassageGhost()).toMatchObject({ lat: CROSSING.points[0].lat, lon: CROSSING.points[0].lon });
        act(() => setPreview(null));
        // The glance ended with the preview; the followed route's live strip is back.
        expect(getPassageLookAhead().on).toBe(false);
        expect(getPassageGhost()).toBeNull();
        expect(screen.getByTestId('passage-hud')).toHaveAttribute('data-subject', 'route');
        expect(screen.queryByTestId('hud-preview')).toBeNull();
        expect(label('hud-route')).toContain('Following Rodney Bay → Bequia');
        expect(useFollowRouteStore.getState().voyageId).toBe('voyage-caribbean');
    });

    it('with its readings tucked away, the HUD tab still says Preview, look-ahead or not', async () => {
        setPreview(CROSSING);
        render(<PassageHudPane />);
        fireEvent.click(screen.getByTestId('hud-look-ahead'));
        fireEvent.click(screen.getByRole('button', { name: /Preview passage/ }));
        await waitFor(() => expect(getPassageGhost()).not.toBeNull());
        fireEvent.click(screen.getByRole('button', { name: 'Hide passage instruments' }));
        // The ghost and the scrubber stay on the chart; the tab beside them says whose they are.
        expect(screen.getByTestId('route-time-scrubber')).toBeVisible();
        const tab = closedTab();
        expect(tab).toHaveTextContent('Preview');
        expect(tab).not.toHaveTextContent('HUD');
        expect(tab).toHaveAttribute('aria-label', 'Show route preview, not following');
        act(() => setPreview(null));
        // No preview, and nothing else to show: the pane is gone.
        expect(document.querySelector('.thalassa-passage-hud-tab')).toBeNull();
    });

    it('a followed route’s tucked-away tab still says HUD', () => {
        useFollowRouteStore.getState().startFollowing(FOLLOWED_PLAN, 'voyage-caribbean', FOLLOWED);
        setPassageHudOpen(false);
        render(<PassageHudPane />);
        const tab = closedTab();
        expect(tab).toHaveTextContent('HUD');
        expect(tab).toHaveAttribute('aria-label', 'Show passage instruments');
    });

    it('a preview stands alone without a followed route or recording, and goes when cleared', () => {
        setPreview(CROSSING);
        const view = render(<PassageHudPane />);
        expect(screen.getByTestId('hud-preview')).toBeVisible();
        act(() => setPreview(null));
        expect(view.container).toBeEmptyDOMElement();
    });

    it('the next whole hour on the device clock, at least a quarter of an hour away', () => {
        // Local wall times: in a half-hour zone a whole UTC hour would read 14:30.
        const at = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo, d, h, mi).getTime();
        expect(nextPreviewDeparture(at(2026, 9, 8, 14, 20))).toBe(at(2026, 9, 8, 15, 0));
        expect(nextPreviewDeparture(at(2026, 9, 8, 14, 45))).toBe(at(2026, 9, 8, 15, 0));
        expect(nextPreviewDeparture(at(2026, 9, 8, 14, 50))).toBe(at(2026, 9, 8, 16, 0));
        expect(nextPreviewDeparture(at(2026, 11, 31, 23, 40))).toBe(at(2027, 0, 1, 0, 0));
        const odd = nextPreviewDeparture(at(2026, 9, 8, 9, 7) + 31_337);
        expect(new Date(odd).getMinutes()).toBe(0);
        expect(new Date(odd).getSeconds()).toBe(0);
    });
});

// ── The whole-route overview waits to be asked ───────────────

/** The overview request (build 124 review), read off the namespace so the current code fails per test. */
const overviewAsked = () => (hudStore as unknown as { isPassageOverviewAsked: () => boolean }).isPassageOverviewAsked();

describe('the whole-route overview is the HUD’s to ask for, never a layer toggle’s', () => {
    // Before build 124 the overview engaged only once the skipper switched the
    // HUD on. With no switch, a plain Layers → Passage toggle would have moved
    // the camera: Obs layer toggles never do.
    it('Layers → Passage alone asks for nothing', () => {
        useFollowRouteStore.getState().startFollowing(FOLLOWED_PLAN, 'voyage-caribbean', FOLLOWED);
        setPassageHudOpen(true);
        render(<PassageHudPane />);
        act(() => setPassageOverlay(true));
        expect(isPassageOverlayOn()).toBe(true);
        expect(overviewAsked()).toBe(false);
    });

    it('the HUD’s Route & track asks for it, and turning the overlay off withdraws the ask', () => {
        useFollowRouteStore.getState().startFollowing(FOLLOWED_PLAN, 'voyage-caribbean', FOLLOWED);
        setPassageHudOpen(true);
        render(<PassageHudPane />);
        fireEvent.click(screen.getByTestId('hud-show-passage'));
        expect(isPassageOverlayOn()).toBe(true);
        expect(overviewAsked()).toBe(true);
        act(() => setPassageOverlay(false));
        expect(overviewAsked()).toBe(false);
        // Back on from Layers: still no ask, so still no camera move.
        act(() => setPassageOverlay(true));
        expect(overviewAsked()).toBe(false);
    });

    it('looking ahead along the followed route asks for it; a preview’s departure does not', () => {
        useFollowRouteStore.getState().startFollowing(FOLLOWED_PLAN, 'voyage-caribbean', FOLLOWED);
        setPassageHudOpen(true);
        setPreview(CROSSING);
        render(<PassageHudPane />);
        fireEvent.click(screen.getByTestId('hud-look-ahead'));
        fireEvent.click(screen.getByRole('button', { name: /Preview passage/ }));
        expect(getPassageLookAhead().on).toBe(true);
        expect(overviewAsked()).toBe(false);
        expect(isPassageOverlayOn()).toBe(false);
    });

    it('a recording starting asks for it (as the old switch did), and an account change withdraws it', () => {
        act(() => hudStore.activatePassageHudForRecording('rec-skagerrak'));
        expect(overviewAsked()).toBe(true);
        act(() => {
            setAuthIdentityScope(`fixture-skipper-${Date.now()}`);
        });
        expect(overviewAsked()).toBe(false);
    });

    it('MapHub holds the overview behind the ask', () => {
        const hub = readFileSync('components/map/MapHub.tsx', 'utf8');
        expect(hub).toContain('const passageOverviewAsked = usePassageOverviewAsked();');
        expect(hub).toMatch(
            /const passageOverviewAvailable =\s*passageHudOnChart &&\s*passageOverlay &&\s*passageOverviewAsked &&/,
        );
    });
});

// ── Credits ───────────────────────────────────────────────────

describe('the open strip clears the Sat cloud and lightning credits', () => {
    const credits = [
        {
            name: 'satellite cloud',
            node: <div data-testid="sat-ir-credit">NOAA/NESDIS GMGSI: GOES, Meteosat (EUMETSAT), Himawari (JMA)</div>,
            match: (el: HTMLElement) => el.dataset.testid === 'sat-ir-credit',
        },
        {
            name: 'Blitzortung',
            // As MapHub mounts it: the credits-strip slot around the chip.
            node: (
                <div data-testid="lightning-credit">
                    <div role="contentinfo" aria-label="Lightning data attribution and connection status">
                        Blitzortung.org · CC BY-SA 4.0
                    </div>
                </div>
            ),
            match: (el: HTMLElement) => el.closest('[data-testid="lightning-credit"]') !== null,
        },
    ];

    for (const credit of credits) {
        it(`starts below the ${credit.name} credit and takes the room back when it goes`, async () => {
            useFollowRouteStore.getState().startFollowing(FOLLOWED_PLAN, 'voyage-caribbean', FOLLOWED);
            setPassageHudOpen(true);
            const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
                this: HTMLElement,
            ) {
                if (credit.match(this))
                    return { left: 60, right: 260, top: 92, bottom: 140, width: 200, height: 48 } as DOMRect;
                const clearance = Number.parseFloat(this.style.getPropertyValue('--passage-hud-credit-clearance')) || 0;
                return { left: 0, right: 152, top: 60 + clearance, bottom: 500, width: 152, height: 440 } as DOMRect;
            });
            try {
                const chart = (shown: boolean) => (
                    <main>
                        {shown && credit.node}
                        <PassageHudPane />
                    </main>
                );
                const { rerender } = render(chart(true));
                expect(screen.getByTestId('passage-hud').style.getPropertyValue('--passage-hud-credit-clearance')).toBe(
                    '88px',
                );
                rerender(chart(false));
                await waitFor(() =>
                    expect(
                        screen.getByTestId('passage-hud').style.getPropertyValue('--passage-hud-credit-clearance'),
                    ).toBe('0px'),
                );
            } finally {
                rect.mockRestore();
            }
        });
    }
});

describe('only the credits strip is cleared, never a copy in the layer key', () => {
    // The chart key (ObsLayerKey → Lightning) renders the same Blitzortung chip,
    // with the same label, low in the strip's own column inside the layer
    // panel. Clearing it pushed the strip to the foot of the screen and
    // squeezed it to nothing (review, build 124 HS).
    it('the strip starts below the strip credit, not below the key’s copy of it, and stays there on a re-measure', async () => {
        useFollowRouteStore.getState().startFollowing(FOLLOWED_PLAN, 'voyage-caribbean', FOLLOWED);
        setPassageHudOpen(true);
        const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
            this: HTMLElement,
        ) {
            if (this.closest('[data-testid="lightning-credit"]'))
                return { left: 60, right: 260, top: 92, bottom: 140, width: 200, height: 48 } as DOMRect;
            if (this.closest('.thalassa-chart-controls-panel-body'))
                return { left: 12, right: 300, top: 600, bottom: 690, width: 288, height: 90 } as DOMRect;
            const clearance = Number.parseFloat(this.style.getPropertyValue('--passage-hud-credit-clearance')) || 0;
            return { left: 0, right: 152, top: 60 + clearance, bottom: 500, width: 152, height: 440 } as DOMRect;
        });
        try {
            render(
                <main>
                    <div data-testid="lightning-credit">
                        <div role="contentinfo" aria-label="Lightning data attribution and connection status">
                            Blitzortung.org · CC BY-SA 4.0
                        </div>
                    </div>
                    <div className="thalassa-chart-controls-panel-body">
                        <section>
                            <h3>Lightning</h3>
                            <div role="contentinfo" aria-label="Lightning data attribution and connection status">
                                Blitzortung.org · CC BY-SA 4.0 · Live
                            </div>
                        </section>
                    </div>
                    <PassageHudPane />
                </main>,
            );
            const clearance = () =>
                screen.getByTestId('passage-hud').style.getPropertyValue('--passage-hud-credit-clearance');
            expect(clearance()).toBe('88px');
            act(() => {
                window.dispatchEvent(new Event('resize'));
            });
            await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
            expect(clearance()).toBe('88px');
        } finally {
            rect.mockRestore();
        }
    });

    it('MapHub marks its lightning credit slot, which is what the strip measures', () => {
        const hub = readFileSync('components/map/MapHub.tsx', 'utf8');
        expect(hub).toMatch(/data-testid="lightning-credit"[\s\S]{0,900}<BlitzortungAttribution visible compact \/>/);
        const pane = readFileSync('components/passage/PassageHudPane.tsx', 'utf8');
        expect(pane).toContain('[data-testid="lightning-credit"]');
        expect(pane).not.toContain('[aria-label="Lightning data attribution and connection status"]');
    });
});

// ── Past tracks ───────────────────────────────────────────────

describe('a past track has no HUD, and the chart key says why', () => {
    const keyProps = (overrides: Partial<ObsLayerKeyProps>): ObsLayerKeyProps => ({
        ais: false,
        lightning: false,
        squall: false,
        storms: false,
        tides: false,
        moorings: false,
        anchorages: false,
        marks: false,
        protectedAreas: false,
        route: false,
        track: false,
        passage: false,
        forecastRoute: false,
        verificationStatus: 'idle',
        referenceStatus: 'Cached reference',
        mooringFilter: 'all',
        onMooringFilter: vi.fn(),
        tideStatus: { stationCount: 0, loading: false, error: false, zoomRequired: false },
        ...overrides,
    });

    it('says a sailed track has nothing ahead to look at, and where a look-ahead lives', () => {
        render(<ObsLayerKey {...keyProps({ track: true })} />);
        expect(screen.getByTestId('obs-key-track-no-hud')).toHaveTextContent(
            'A sailed track has no Passage HUD look-ahead: nothing lies ahead on it. Pick a route under Routes to preview one.',
        );
    });

    it('says nothing of the kind for a planned route', () => {
        render(<ObsLayerKey {...keyProps({ route: true })} />);
        expect(screen.queryByTestId('obs-key-track-no-hud')).toBeNull();
    });
});
