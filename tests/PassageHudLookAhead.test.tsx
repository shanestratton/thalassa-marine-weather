/**
 * The passage strip, phase 2 — LOOK AHEAD.
 *
 * Shane 2026-09-17: "it needs to show the vessel going along the route as its
 * normal cruising speed - found in the setting vessel profile section - and all
 * of the wind and rain etc should alter as the yacht progresses along the
 * route." 2026-09-18: the ghost starts from where she IS; dashes for what is
 * not known; a button to change the model; seven days.
 *
 * What would mislead a skipper here: a forecast wearing a live reading's face;
 * a ghost that leaves from the route's first point instead of from the boat;
 * one model's numbers shown for a moment under another model's name; the last
 * hour of a forecast held past its end; a glance that outlives the strip and
 * leaves the chart showing tomorrow.
 */
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
        detail: 'Live via the Pi · GPS · 11 sats · HDOP 0.9',
        isNmea: true,
        satellites: 11,
        hdop: 0.8,
        avgAccuracy: null,
        qualityLabel: null,
        deviceName: 'calypso',
    },
}));
vi.mock('../services/GpsReceiverStatusService', () => ({
    GpsReceiverStatusService: {
        getStatus: () => receiver.status,
        refresh: () => Promise.resolve(receiver.status),
    },
}));
vi.mock('../services/GpsService', () => ({
    GpsService: { getLastKnownPosition: () => null, watchPosition: () => () => undefined },
}));
vi.mock('../services/VoyageService', () => ({ getCachedActiveVoyage: () => null }));

// Man overboard — raised from this page, the MOB page or the watch.
const mob = vi.hoisted(() => ({
    subs: new Set<(s: { active: unknown }) => void>(),
    raise: () => mob.subs.forEach((cb) => cb({ active: { fixLat: -27.5, fixLon: 153 } })),
}));
vi.mock('../services/MobService', () => ({
    MobService: {
        subscribe: (cb: (s: { active: unknown }) => void) => {
            mob.subs.add(cb);
            cb({ active: null });
            return () => mob.subs.delete(cb);
        },
    },
}));

// The vessel profile — "found in the setting vessel profile section".
const profile = vi.hoisted(() => ({
    vessel: { cruisingSpeed: 6, length: 42, type: 'sail' } as
        | { cruisingSpeed?: number; length?: number; type?: string }
        | undefined,
}));
const unitsPref = vi.hoisted(() => ({ waveHeight: 'm' as 'm' | 'ft' }));
vi.mock('../stores/settingsStore', () => {
    const state = () => ({ settings: { vessel: profile.vessel, units: { waveHeight: unitsPref.waveHeight } } });
    const useSettingsStore = Object.assign((selector: (s: ReturnType<typeof state>) => unknown) => selector(state()), {
        getState: state,
        subscribe: () => () => undefined,
    });
    return { useSettingsStore };
});

// The forecast service: every request recorded, every reply the test's to shape.
const HOUR = 3_600_000;
const proxy = vi.hoisted(() => ({
    calls: [] as { models: string; points: number }[],
    hours: 169,
    offline: false,
    hold: null as null | Promise<void>,
    failNext: false,
    /** The five-model request fails; the strip must fall back to its one model. */
    spreadFails: false,
    // ── the sea (phase 4) ──
    seaCalls: [] as { models: string; points: number }[],
    seaFails: false,
    /** Keyed by distance along the route, NOT by station index: the station layout is not this test's business. */
    waveFor: (_station: number, p: { alongNm?: number }): number | null => 1.4 + (p.alongNm ?? 0) * 0.01,
    currentKmh: 1.852 as number | null,
    setDeg: 0 as number | null,
    /** Where the service says its answer came from; a few km off is just the grid. */
    snapFor: (_station: number, p: { lat: number; lon: number }): { lat: number; lon: number } | null => ({
        lat: p.lat + 0.02,
        lon: p.lon + 0.02,
    }),
    speedFor: (model: string, station: number) => (model === 'dwd_icon' ? 30 : 10) + station,
    dirFor: (_model: string) => 90 as number,
}));
vi.mock('../services/weather/openMeteoProxy', () => ({
    fetchOpenMeteoPoints: async (
        _op: string,
        points: { lat: number; lon: number }[],
        params: Record<string, unknown>,
    ) => {
        if (_op === 'marine') {
            proxy.seaCalls.push({ models: String(params.models), points: points.length });
            if (proxy.offline || proxy.seaFails) throw new Error('offline');
            const t0 = Math.floor(Date.now() / HOUR) * HOUR;
            const col = (value: number | null) => Array.from({ length: proxy.hours }, () => value);
            return points.map((p, station) => {
                const wave = proxy.waveFor(station, p as { alongNm?: number });
                const echo = proxy.snapFor(station, p);
                return {
                    ...(echo ? { latitude: echo.lat, longitude: echo.lon } : {}),
                    hourly_units: {
                        wave_height_meteofrance_wave: 'm',
                        wave_period_meteofrance_wave: 's',
                        ocean_current_velocity_marine_best_match: 'km/h',
                        ocean_current_direction_marine_best_match: '°',
                    },
                    hourly: {
                        time: Array.from({ length: proxy.hours }, (_h, h) => (t0 + h * HOUR) / 1000),
                        wave_height_meteofrance_wave: col(wave),
                        wave_period_meteofrance_wave: col(wave === null ? null : 7),
                        wave_direction_meteofrance_wave: col(wave === null ? null : 120),
                        ocean_current_velocity_meteofrance_wave: col(null),
                        ocean_current_direction_meteofrance_wave: col(null),
                        ocean_current_velocity_marine_best_match: col(proxy.currentKmh),
                        ocean_current_direction_marine_best_match: col(proxy.setDeg),
                    },
                };
            });
        }
        const asked = String(params.models);
        const models = asked.split(',');
        proxy.calls.push({ models: asked, points: points.length });
        if (proxy.hold) await proxy.hold;
        if (proxy.offline || proxy.failNext) throw new Error('offline');
        if (models.length > 1 && proxy.spreadFails) throw new Error('Weather service request failed (400)');
        const start = Math.floor(Date.now() / HOUR) * HOUR;
        const fill = (value: (h: number) => number | null) => Array.from({ length: proxy.hours }, (_h, h) => value(h));
        return points.map((_, station) => {
            const hourly: Record<string, (number | null)[]> = { time: fill((h) => (start + h * HOUR) / 1000) };
            for (const model of models) {
                // One model is answered unsuffixed, several are suffixed — as the service does.
                const sfx = models.length > 1 ? `_${model}` : '';
                hourly[`wind_speed_10m${sfx}`] = fill(() => proxy.speedFor(model, station));
                hourly[`wind_direction_10m${sfx}`] = fill(() => proxy.dirFor(model));
                hourly[`wind_gusts_10m${sfx}`] = fill(() =>
                    model === 'jma_gsm' || model === 'ecmwf_aifs025_single' ? null : proxy.speedFor(model, station) + 8,
                );
                hourly[`precipitation${sfx}`] = fill(() => 1.2);
                hourly[`precipitation_probability${sfx}`] = fill(() => 60);
            }
            return { hourly };
        });
    },
}));

import { PassageHudPane } from '../components/passage/PassageHudPane';
import { PASSAGE_MODEL_CHOICES } from '../components/passage/PassageModelModal';
import { NmeaStore, type RemoteInstrumentSnapshot } from '../services/NmeaStore';
import { useFollowRouteStore } from '../stores/followRouteStore';
import { WindStore } from '../stores/WindStore';
import {
    __resetPassageHudForTests,
    getPassageGhost,
    getPassageGhostPath,
    getPassageLookAhead,
    reportPassageWindCoverage,
    setPassageAheadMs,
    setPassageHudEnabled,
    setPassageHudOpen,
    setPassageSpeedPref,
} from '../stores/passageHudStore';
import { __resetPassageOverlayForTests, isPassageOverlayOn } from '../stores/chartPassageOverlay';
import { __clearRouteForecastCacheForTests } from '../services/routeForecastSampler';
import { __clearRouteSpreadCacheForTests } from '../services/routeForecastSpread';
import { __clearRouteSeaCacheForTests } from '../services/routeSeaSampler';
import { consumeMapFit, peekMapFit } from '../stores/MapFitTargetStore';
import type { VoyagePlan } from '../types';

const snapshot = (over: Partial<RemoteInstrumentSnapshot> = {}): RemoteInstrumentSnapshot => ({
    source: 'pi',
    via: 'lan',
    deviceLabel: 'calypso',
    reportedAt: Date.now() - 1_000,
    lat: -27.5,
    lon: 153,
    sogKts: 6.1,
    cogDeg: 0,
    headingDeg: 0,
    stwKts: 5.8,
    twsKts: 14.2,
    twaDeg: -48,
    twdDeg: 350,
    awsKts: 17.6,
    awaDeg: -33,
    depthM: 12.4,
    heelDeg: -9,
    pitchDeg: 1,
    waterTempC: 22.5,
    rudderDeg: 2,
    rpm: null,
    voltageV: 13.1,
    ...over,
});

const PLAN = { origin: 'Newport', destination: 'Gladstone', waypoints: [] } as unknown as VoyagePlan;
// 60 NM due north, then ~53 NM due east. She is 30 NM up the first leg.
const ROUTE = [
    { lat: -28, lon: 153 },
    { lat: -27, lon: 153 },
    { lat: -27, lon: 154 },
];

const text = (id: string) => screen.getByTestId(id).textContent ?? '';
const label = (id: string) => screen.getByTestId(id).getAttribute('aria-label') ?? '';

const underWay = () =>
    act(() => {
        void NmeaStore.ingestRemote(snapshot());
        useFollowRouteStore.getState().startFollowing(PLAN, 'voyage-1', ROUTE);
    });
/** Under fake timers the boat's last sample ages out in 13 s: give her a fresh one and a reckoning tick. */
const boatStillReporting = async () => {
    act(() => void NmeaStore.ingestRemote(snapshot()));
    await act(async () => {
        await vi.advanceTimersByTimeAsync(2_100);
    });
};
const lookAhead = async () => {
    fireEvent.click(screen.getByTestId('hud-look-ahead'));
    await waitFor(() => expect(text('hud-tws')).not.toContain('—'));
};

beforeEach(() => {
    localStorage.clear();
    __resetPassageHudForTests();
    __resetPassageOverlayForTests();
    __clearRouteForecastCacheForTests();
    __clearRouteSpreadCacheForTests();
    WindStore.reset();
    setPassageHudEnabled(true);
    setPassageHudOpen(true);
    NmeaStore.clearRemote();
    useFollowRouteStore.getState().stopFollowing();
    profile.vessel = { cruisingSpeed: 6, length: 42, type: 'sail' };
    proxy.calls.length = 0;
    proxy.hours = 169;
    proxy.offline = false;
    proxy.hold = null;
    proxy.failNext = false;
    proxy.spreadFails = false;
    proxy.seaCalls.length = 0;
    proxy.seaFails = false;
    proxy.waveFor = (_station, p) => 1.4 + (p.alongNm ?? 0) * 0.01;
    proxy.currentKmh = 1.852;
    proxy.setDeg = 0;
    proxy.snapFor = (_station, p) => ({ lat: p.lat + 0.02, lon: p.lon + 0.02 });
    unitsPref.waveHeight = 'm';
    __clearRouteSeaCacheForTests();
    proxy.speedFor = (model: string, station: number) => (model === 'dwd_icon' ? 30 : 10) + station;
    proxy.dirFor = () => 90;
    // Phase 2's tests pin the FLAT cruising-speed plan, which is still a mode
    // (and what Shane first asked for). "By the wind" has its own tests below.
    setPassageSpeedPref('cruise');
    consumeMapFit();
    mob.subs.clear();
});

afterEach(() => {
    cleanup();
    NmeaStore.clearRemote();
    useFollowRouteStore.getState().stopFollowing();
});

describe('asking to look ahead', () => {
    it('needs a route to look along', () => {
        render(<PassageHudPane />);
        const button = screen.getByTestId('hud-look-ahead') as HTMLButtonElement;
        expect(button.disabled).toBe(true);
        expect(label('hud-look-ahead')).toContain('follow a route first');
    });

    it('needs a cruising speed, and says where to set one', () => {
        profile.vessel = undefined;
        underWay();
        render(<PassageHudPane />);
        expect((screen.getByTestId('hud-look-ahead') as HTMLButtonElement).disabled).toBe(true);
        expect(label('hud-look-ahead')).toContain('set a cruising speed in Settings, Vessel');
    });

    it('falls back on the hull’s own speed when the profile has a length but no speed', () => {
        profile.vessel = { length: 36, type: 'sail' };
        underWay();
        render(<PassageHudPane />);
        expect((screen.getByTestId('hud-look-ahead') as HTMLButtonElement).disabled).toBe(false);
    });

    it('draws the route it is about to ride — the same explicit ON as the button beside it', async () => {
        underWay();
        render(<PassageHudPane />);
        expect(isPassageOverlayOn()).toBe(false);
        await lookAhead();
        expect(isPassageOverlayOn()).toBe(true);
    });
});

describe('a forecast never wears a live reading’s face', () => {
    it('LIVE says LIVE; looking ahead says FCST and how far, in the forecast’s own colour', async () => {
        underWay();
        render(<PassageHudPane />);
        expect(text('hud-mode')).toBe('Live');
        expect(screen.getByTestId('passage-hud').getAttribute('data-mode')).toBe('live');
        await lookAhead();
        expect(text('hud-mode')).toBe('FcstNOW');
        expect(screen.getByTestId('hud-mode').className).toContain('text-amber-300');
        expect(screen.getByTestId('passage-hud').getAttribute('data-mode')).toBe('forecast');
        expect(screen.getByLabelText('Passage forecast, looking ahead along the route')).toBeTruthy();
    });

    it('takes the instruments OFF the strip: there is no forecast SOG, COG, lane or GPS', async () => {
        underWay();
        render(<PassageHudPane />);
        await lookAhead();
        for (const id of ['hud-sog', 'hud-cog', 'hud-lane', 'hud-gps', 'hud-fix-source']) {
            expect(screen.queryByTestId(id)).toBeNull();
        }
        expect(screen.getByTestId('hud-tws').getAttribute('data-freshness')).toBe('forecast');
        expect(label('hud-tws')).toMatch(/^Forecast true wind speed \d+ knots, ECMWF\./);
    });

    it('marks apparent wind as an ESTIMATE, in the label and to a screen reader', async () => {
        underWay();
        render(<PassageHudPane />);
        await lookAhead();
        expect(text('hud-aws')).toContain('AW est');
        expect(label('hud-aws')).toContain('not measured');
        expect(label('hud-aws')).toContain('P is port, S is starboard');
        // One cell since phase 4: the angle rides under the speed.
        expect(screen.getByTestId('hud-aws').contains(screen.getByTestId('hud-awa'))).toBe(true);
    });

    it('the boat’s own 27 knots is nowhere on a strip that is showing the model’s 13', async () => {
        // Review caught the first version of this asserting against '14.2' — a
        // string the strip can never render (>= 10 kn is shown whole), so it could
        // not fail. 27 live against the mock's ~13 forecast can.
        act(() => {
            void NmeaStore.ingestRemote(snapshot({ twsKts: 27.4 }));
            useFollowRouteStore.getState().startFollowing(PLAN, 'voyage-1', ROUTE);
        });
        render(<PassageHudPane />);
        expect(text('hud-tws')).toBe('TWS27kn');
        await lookAhead();
        expect(text('hud-tws')).toMatch(/^TWS13kn/);
        expect(screen.getByTestId('passage-hud').textContent).not.toContain('27');
    });
});

describe('the rest of the passage is put on screen, once', () => {
    it('frames from the BOAT to the destination on the way in — not the water already sailed', async () => {
        underWay();
        render(<PassageHudPane />);
        await lookAhead();
        const target = consumeMapFit()!;
        const [minLon, minLat, maxLon, maxLat] = target.bbox;
        expect(minLat).toBeCloseTo(-27.5, 2); // where she is, not -28 where the route began
        expect(maxLat).toBeCloseTo(-27, 2);
        expect(minLon).toBeCloseTo(153, 2);
        expect(maxLon).toBeCloseTo(154, 2);
    });

    it('never moves the camera again while she scrubs: the skipper’s own pan and zoom win', async () => {
        underWay();
        render(<PassageHudPane />);
        await lookAhead();
        consumeMapFit();
        act(() => setPassageAheadMs(3 * HOUR));
        act(() => setPassageAheadMs(9 * HOUR));
        expect(peekMapFit()).toBeNull();
    });
});

describe('the line the ghost rides', () => {
    it('is the water STILL TO SAIL — from abeam of the boat, not from the route’s first point', async () => {
        underWay();
        render(<PassageHudPane />);
        expect(getPassageGhostPath()).toBeNull(); // nothing on the chart while live
        await lookAhead();
        const path = getPassageGhostPath()!;
        expect(path).toHaveLength(3);
        expect(path[0].lat).toBeCloseTo(-27.5, 3);
        expect(path[1]).toEqual(ROUTE[1]);
        expect(path[2]).toEqual(ROUTE[2]);
    });

    it('is taken off the chart the moment the glance ends', async () => {
        underWay();
        render(<PassageHudPane />);
        await lookAhead();
        fireEvent.click(screen.getByTestId('hud-look-ahead'));
        expect(getPassageGhostPath()).toBeNull();
    });
});

describe('the ghost leaves from where she IS', () => {
    it('stands on the boat at NOW — 30 NM up the route, not back at its first point', async () => {
        underWay();
        render(<PassageHudPane />);
        await lookAhead();
        const ghost = getPassageGhost()!;
        expect(ghost.lat).toBeCloseTo(-27.5, 2);
        expect(ghost.lon).toBeCloseTo(153, 3);
        expect(ghost.label).toBe('NOW');
    });

    it('stays UNDER the boat at NOW as she sails on — not up to a mile astern because the label rounds', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        try {
            underWay();
            render(<PassageHudPane />);
            await lookAhead();
            // 0.3 NM further up the leg: "83 NM to go" does not change, the boat has.
            act(() => void NmeaStore.ingestRemote(snapshot({ lat: -27.495 })));
            await act(async () => {
                await vi.advanceTimersByTimeAsync(2_100);
            });
            expect(getPassageGhost()!.lat).toBeCloseTo(-27.495, 3);
        } finally {
            vi.useRealTimers();
        }
    });

    it('runs ahead at the vessel profile’s cruising speed: five hours at 6 kn is the next waypoint', async () => {
        underWay();
        render(<PassageHudPane />);
        await lookAhead();
        act(() => setPassageAheadMs(5 * HOUR));
        const ghost = getPassageGhost()!;
        expect(ghost.lat).toBeCloseTo(-27, 2);
        expect(ghost.label).toBe('+5 h');
        // …and ten hours has her round the corner, heading east.
        act(() => setPassageAheadMs(10 * HOUR));
        const east = getPassageGhost()!;
        expect(east.lon).toBeGreaterThan(153.4);
        expect(east.bearingDeg).toBeGreaterThan(85);
        expect(east.bearingDeg).toBeLessThan(95);
    });

    it('a faster boat’s ghost is further on at the same moment', async () => {
        profile.vessel = { cruisingSpeed: 12 };
        underWay();
        render(<PassageHudPane />);
        await lookAhead();
        act(() => setPassageAheadMs(2.5 * HOUR));
        expect(getPassageGhost()!.lat).toBeCloseTo(-27, 2);
    });

    it('what is left to go is counted from the GHOST, at the speed it says', async () => {
        underWay();
        render(<PassageHudPane />);
        await lookAhead();
        act(() => setPassageAheadMs(5 * HOUR));
        expect(text('hud-route')).toMatch(/To go5[2-5]NM6\.0KN CRUISE/);
        expect(label('hud-route')).toContain('A plan, not a measurement.');
    });

    it('the axis ends when she arrives — 83 NM at 6 kn is about 14 hours, not seven days', async () => {
        underWay();
        render(<PassageHudPane />);
        await lookAhead();
        const max = Number(screen.getByTestId('route-scrub-track').getAttribute('aria-valuemax'));
        expect(max).toBeGreaterThan(13.5 * 60);
        expect(max).toBeLessThan(14.3 * 60);
        act(() => setPassageAheadMs(100 * HOUR, 100 * HOUR));
        // The strip pulls a runaway offset back to the end of its own axis.
        expect(getPassageLookAhead().aheadMs).toBeLessThan(14.3 * HOUR);
        expect(getPassageGhost()!.lon).toBeCloseTo(154, 2);
    });
});

describe('the wind she will sail INTO', () => {
    it('is the model’s wind at the ghost’s place: it changes as she moves along the route', async () => {
        underWay();
        render(<PassageHudPane />);
        await lookAhead();
        const first = Number.parseFloat(text('hud-tws').replace('TWS', ''));
        act(() => setPassageAheadMs(12 * HOUR));
        const later = Number.parseFloat(text('hud-tws').replace('TWS', ''));
        // The mock blows harder at each station further up the route.
        expect(later).toBeGreaterThan(first + 3);
        expect(text('hud-twd')).toContain('090°');
        expect(text('hud-rain')).toBe('Rain 60%1.2mm');
    });

    it('asks the service for the model the chart’s wind layer is on, by name', async () => {
        underWay();
        render(<PassageHudPane />);
        await lookAhead();
        // ONE request, for all five by name — the pinned model is in it.
        expect(proxy.calls).toHaveLength(1);
        expect(proxy.calls[0].models.split(',')).toContain('ecmwf_ifs025');
        expect(proxy.calls[0].models.split(',')).toHaveLength(5);
        expect(text('route-scrub-model')).toContain('ECMWF');
        // …and whoever's numbers are in the band is credited, the pinned model's provider first.
        expect(text('route-scrub-credit')).toBe(
            'Forecast data: DWD, ECMWF, UK Met Office, JMA, Météo-France, Open-Meteo',
        );
    });

    it('past the end of the forecast is dashes and the words — never the last hour held', async () => {
        proxy.hours = 6;
        underWay();
        render(<PassageHudPane />);
        await lookAhead();
        act(() => setPassageAheadMs(12 * HOUR));
        expect(text('hud-tws')).toContain('—');
        expect(text('hud-twd')).toContain('—');
        expect(text('hud-aws')).toContain('—');
        expect(text('hud-forecast-note')).toBe('PAST FORECAST');
    });

    it('offline is dashes and NO FORECAST, with the ghost still riding the route', async () => {
        proxy.offline = true;
        underWay();
        render(<PassageHudPane />);
        fireEvent.click(screen.getByTestId('hud-look-ahead'));
        await waitFor(() => expect(text('hud-forecast-note')).toBe('NO FORECAST'));
        expect(text('hud-tws')).toContain('—');
        expect(getPassageGhost()).not.toBeNull();
    });
});

describe('a boat that is OFF her line', () => {
    // 10 NM east of the first leg, abeam of the 30 NM mark.
    const offLine = () =>
        act(() => {
            void NmeaStore.ingestRemote(snapshot({ lat: -27.5, lon: 153.188 }));
            useFollowRouteStore.getState().startFollowing(PLAN, 'voyage-1', ROUTE);
        });

    it('LIVE and FCST agree at NOW: the way back to the line is part of the plan', async () => {
        offLine();
        render(<PassageHudPane />);
        const live = text('hud-route').match(/(\d+)NM/)![1];
        await lookAhead();
        expect(text('hud-route')).toBe(`To go${live}NM6.0KN CRUISE`);
        expect(Number(live)).toBeGreaterThan(90); // 83 along + ~10 back
    });

    it('the ghost waits on the line while the way back is sailed, then runs', async () => {
        offLine();
        render(<PassageHudPane />);
        await lookAhead();
        act(() => setPassageAheadMs(1 * HOUR)); // 6 NM sailed of a ~10 NM way back
        expect(getPassageGhost()!.lat).toBeCloseTo(-27.5, 2);
        act(() => setPassageAheadMs(5 * HOUR)); // 30 sailed, ~20 of it along the line
        expect(getPassageGhost()!.lat).toBeGreaterThan(-27.25);
        expect(getPassageGhost()!.lat).toBeLessThan(-27.1);
    });

    it('abeam of the far end from miles off is NOT "0.0 to go" on a dead slider', async () => {
        act(() => {
            void NmeaStore.ingestRemote(snapshot({ lat: -26.85, lon: 154.05 })); // ~9 NM past the end
            useFollowRouteStore.getState().startFollowing(PLAN, 'voyage-1', ROUTE);
        });
        render(<PassageHudPane />);
        await lookAhead();
        const max = Number(screen.getByTestId('route-scrub-track').getAttribute('aria-valuemax'));
        expect(max).toBeGreaterThan(60); // more than an hour of axis, in minutes
        expect(text('hud-route')).not.toContain('0.0NM');
        expect(label('hud-route')).not.toContain('arrived');
    });
});

describe('losing the fix mid-glance', () => {
    it('holds the axis: the strip and scrubber keep saying the moment the chart’s wind is standing at', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        try {
            underWay();
            render(<PassageHudPane />);
            await lookAhead();
            act(() => setPassageAheadMs(6 * HOUR));
            expect(text('hud-mode')).toBe('Fcst+6 h');
            // The Pi drops and there is no phone fix: instruments go dead.
            act(() => NmeaStore.clearRemote());
            await act(async () => {
                await vi.advanceTimersByTimeAsync(20_000);
            });
            expect(text('hud-forecast-note')).toBe('NO FIX');
            // NOT pulled back to NOW: the wind on the chart is still at +6 h.
            expect(text('hud-mode')).toBe('Fcst+6 h');
            expect(getPassageLookAhead().aheadMs).toBe(6 * HOUR);
            expect(screen.getByTestId('route-scrub-track').getAttribute('aria-valuenow')).toBe(String(6 * 60));
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('a forecast that could not be refreshed wears its age', () => {
    it('keeps the old run offshore — and SAYS how old it is, instead of passing it off as this hour’s', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        try {
            underWay();
            render(<PassageHudPane />);
            await lookAhead();
            expect(screen.queryByTestId('hud-forecast-note')).toBeNull();
            proxy.failNext = true; // the signal goes
            await act(async () => {
                await vi.advanceTimersByTimeAsync(3 * 3_600_000 + 10 * 60_000);
            });
            await boatStillReporting(); // the instruments are on the boat's LAN, not the internet
            expect(text('hud-tws')).toMatch(/TWS\d+/); // still the old run's number…
            expect(text('hud-forecast-note')).toBe('3 H OLD'); // …wearing its age
        } finally {
            vi.useRealTimers();
        }
    });

    it('a healthy hourly refresh never flashes an age', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        try {
            underWay();
            render(<PassageHudPane />);
            await lookAhead();
            for (let i = 0; i < 40; i++) {
                await act(async () => {
                    await vi.advanceTimersByTimeAsync(2 * 60_000);
                });
                await boatStillReporting();
                expect(screen.queryByTestId('hud-forecast-note')).toBeNull();
            }
            expect(proxy.calls.length).toBeGreaterThanOrEqual(2); // it did go back for a fresh run
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('man overboard', () => {
    it('ends the glance at once: no ghost, no dashed line, the instruments back on the strip', async () => {
        underWay();
        render(<PassageHudPane />);
        await lookAhead();
        act(() => setPassageAheadMs(6 * HOUR));
        act(() => mob.raise());
        expect(getPassageLookAhead().on).toBe(false);
        expect(getPassageGhost()).toBeNull();
        expect(getPassageGhostPath()).toBeNull();
        expect(text('hud-mode')).toBe('Live');
        expect(text('hud-sog')).toContain('6.1');
    });
});

describe('the credit can never come out nameless', () => {
    it('every model on offer names who made its data', () => {
        expect(PASSAGE_MODEL_CHOICES.length).toBeGreaterThanOrEqual(5);
        for (const choice of PASSAGE_MODEL_CHOICES) {
            expect(choice.provider.trim().length).toBeGreaterThan(1);
            expect(choice.label.trim().length).toBeGreaterThan(1);
            expect(choice.openMeteoModel).toMatch(/^[a-z0-9_]+$/);
        }
    });
});

describe('where the models disagree, it says so', () => {
    it('the headline stays the chart’s ONE model; the others’ range sits under it, with how many answered', async () => {
        underWay();
        render(<PassageHudPane />);
        await lookAhead();
        // ECMWF (pinned) ~13; ICON blows 20 kn harder in this mock: 13 to 33 across all five.
        expect(text('hud-tws')).toMatch(/^TWS13kn/);
        expect(text('hud-tws-spread')).toBe('12–33');
        expect(screen.getByTestId('hud-tws-spread').className).toContain('text-red-400');
        expect(text('hud-models-split')).toBe('MODELS SPLIT');
        // Rounded OUTWARD for a screen reader too, so it holds the headline as the visible range does.
        expect(label('hud-tws')).toContain('5 of 5 models say 12 to 33 knots — the models disagree');
    });

    it('says how many answered ONLY when someone did not — "4/5" is the news, "5/5" is not', async () => {
        const normal = proxy.speedFor;
        proxy.speedFor = (model, station) =>
            model === 'jma_gsm' ? (null as unknown as number) : normal(model, station);
        underWay();
        render(<PassageHudPane />);
        await lookAhead();
        expect(text('hud-tws-spread')).toBe('12–33 4/5');
        expect(label('hud-tws')).toContain('4 of 5 models say');
    });

    it('the range always HOLDS the headline: rounded outward, never "6–9" under 9.4', async () => {
        proxy.speedFor = (model) => (model === 'ecmwf_ifs025' ? 9.4 : 5.9);
        underWay();
        render(<PassageHudPane />);
        await lookAhead();
        expect(text('hud-tws')).toMatch(/^TWS9\.4kn/);
        expect(text('hud-tws-spread')).toBe('5–10');
    });

    it('when they agree the range is quiet and nothing shouts', async () => {
        proxy.speedFor = (_model, station) => 12 + station;
        underWay();
        render(<PassageHudPane />);
        await lookAhead();
        expect(screen.getByTestId('hud-tws-spread').className).toContain('text-gray-400');
        expect(screen.queryByTestId('hud-models-split')).toBeNull();
        expect(label('hud-tws')).toContain('the models agree');
    });

    it('agreeing on speed but not on where it blows from is still a split', async () => {
        proxy.speedFor = () => 18;
        proxy.dirFor = (model) => (model === 'jma_gsm' ? 170 : 90);
        underWay();
        render(<PassageHudPane />);
        await lookAhead();
        expect(text('hud-tws-spread')).toBe('18–18');
        expect(text('hud-models-split')).toBe('MODELS SPLIT');
        // The SPEED range has nothing wrong with it and is not painted red; the
        // disagreement is named where it is — on the direction.
        expect(screen.getByTestId('hud-tws-spread').className).toContain('text-gray-400');
        expect(text('hud-twd-spread')).toBe('80° apart');
        expect(screen.getByTestId('hud-twd-spread').className).toContain('text-red-400');
        expect(label('hud-twd')).toContain('80 degrees apart on direction');
        // …and the scrubber's band marks it red although the range is zero knots wide.
        expect(screen.getAllByTestId('route-scrub-band-split').length).toBeGreaterThan(0);
    });

    it('the two WARNINGS stand outside the scrolling cells — whatever overflows is a cell, never a warning', async () => {
        underWay();
        render(<PassageHudPane />);
        await lookAhead();
        const scroller = screen.getByTestId('passage-hud').querySelector('.overflow-y-auto')!;
        expect(scroller.contains(screen.getByTestId('hud-tws'))).toBe(true);
        expect(scroller.contains(screen.getByTestId('hud-models-split'))).toBe(false);
        act(() => setPassageAheadMs(1 * HOUR));
        proxy.hours = 2;
    });

    it('draws the band on the scrubber — red where they are split — and credits everyone in it', async () => {
        underWay();
        render(<PassageHudPane />);
        await lookAhead();
        expect(screen.getByTestId('route-scrub-band')).toBeTruthy();
        expect(screen.getAllByTestId('route-scrub-band-split').length).toBeGreaterThan(0);
        expect(text('route-scrub-credit')).toBe(
            'Forecast data: DWD, ECMWF, UK Met Office, JMA, Météo-France, Open-Meteo',
        );
    });

    it('past the forecast there is no range either — a band is not drawn across nothing', async () => {
        proxy.hours = 6;
        underWay();
        render(<PassageHudPane />);
        await lookAhead();
        act(() => setPassageAheadMs(12 * HOUR));
        expect(screen.queryByTestId('hud-tws-spread')).toBeNull();
        expect(screen.queryByTestId('hud-models-split')).toBeNull();
        expect(text('hud-forecast-note')).toBe('PAST FORECAST');
    });
});

describe('by the wind: the ghost slows on the nose', () => {
    // Northbound up the first leg (course 000°).
    const byTheWind = () => setPassageSpeedPref('polar');

    it('says HOW she is making her way, and at what speed — not a flat "at 6 kn"', async () => {
        byTheWind();
        proxy.speedFor = () => 16;
        proxy.dirFor = () => 90; // a beam reach
        underWay();
        render(<PassageHudPane />);
        await lookAhead();
        expect(text('hud-route')).toMatch(/KN SAIL$/);
        expect(label('hud-route')).toContain('under sail');
    });

    it('on the nose takes longer than dead astern over the same water: the axis itself gets longer', async () => {
        // She has 30 NM of northing left, then 53 NM due east. The second leg is a
        // beam reach either way; only the first differs — and the first cut of
        // this test got that wrong, which is how easily a route fools the eye.
        byTheWind();
        proxy.speedFor = () => 18;
        proxy.dirFor = () => 180; // a southerly: dead astern up the first leg
        underWay();
        const astern = render(<PassageHudPane />);
        await lookAhead();
        expect(text('hud-route')).toMatch(/KN SAIL$/);
        const asternMax = Number(screen.getByTestId('route-scrub-track').getAttribute('aria-valuemax'));
        astern.unmount();

        __clearRouteForecastCacheForTests();
        __clearRouteSpreadCacheForTests();
        proxy.dirFor = () => 0; // a northerly: dead on the nose
        render(<PassageHudPane />);
        await lookAhead();
        expect(text('hud-route')).toMatch(/KN TACK$/);
        const noseMax = Number(screen.getByTestId('route-scrub-track').getAttribute('aria-valuemax'));
        expect(noseMax).toBeGreaterThan(asternMax * 1.05);
    });

    it('in light air she motors, at her cruising speed, and says MOTOR', async () => {
        byTheWind();
        proxy.speedFor = () => 2;
        underWay();
        render(<PassageHudPane />);
        await lookAhead();
        expect(text('hud-route')).toMatch(/6\.0KN MOTOR$/);
        expect(label('hud-route')).toContain('under engine');
    });

    it('the apparent-wind estimate uses the speed the PLAN has her doing, not the flat one', async () => {
        byTheWind();
        proxy.speedFor = () => 2; // motoring at 6 into next to nothing
        proxy.dirFor = () => 0;
        underWay();
        render(<PassageHudPane />);
        await lookAhead();
        // 2 kn true on the nose + her own 6 (less the small headwind loss) ≈ 8 apparent
        expect(text('hud-aws')).toMatch(/^AW est[78]\.\dkn/);
    });

    it('past the wind forecast her speed is ASSUMED, and both the strip and the scrubber say so', async () => {
        byTheWind();
        proxy.hours = 4;
        proxy.speedFor = () => 16;
        underWay();
        render(<PassageHudPane />);
        await lookAhead();
        act(() => setPassageAheadMs(8 * HOUR));
        expect(text('hud-route')).toMatch(/6\.0KN NO WX$/);
        expect(label('hud-route')).toContain('assumed, because there is no wind forecast');
        expect(text('route-scrub-note')).toBe('No wind forecast here — 6.0 kn assumed');
    });

    it('a power vessel is planned at her cruising speed whatever the setting says', async () => {
        byTheWind();
        profile.vessel = { cruisingSpeed: 18, length: 40, type: 'power' };
        proxy.speedFor = () => 25;
        proxy.dirFor = () => 0;
        underWay();
        render(<PassageHudPane />);
        await lookAhead();
        expect(text('hud-route')).toMatch(/18KN CRUISE$|18\.0KN CRUISE$/);
    });

    it('LIVE and FCST still agree at NOW, by the wind too', async () => {
        byTheWind();
        underWay();
        render(<PassageHudPane />);
        const live = text('hud-route').match(/(\d+)NM/)![1];
        await lookAhead();
        expect(text('hud-route')).toMatch(new RegExp(`^To go${live}NM`));
    });
});

describe('what the review of phase 3 caught', () => {
    const byTheWind = () => setPassageSpeedPref('polar');

    it('changing model does NOT drag a parked offset back to the flat-speed arrival', async () => {
        byTheWind();
        proxy.speedFor = () => 18;
        proxy.dirFor = () => 0; // on the nose: by the wind the passage is LONGER than 83 NM / 6 kn
        underWay();
        render(<PassageHudPane />);
        await lookAhead();
        const maxMin = Number(screen.getByTestId('route-scrub-track').getAttribute('aria-valuemax'));
        expect(maxMin).toBeGreaterThan(14.2 * 60); // past the flat-speed arrival
        const parked = (maxMin - 20) * 60_000;
        act(() => setPassageAheadMs(parked));
        expect(getPassageLookAhead().aheadMs).toBe(parked);
        act(() => WindStore.setModel('icon'));
        await waitFor(() => expect(text('route-scrub-model')).toContain('ICON'));
        expect(getPassageLookAhead().aheadMs).toBe(parked);
    });

    it('…nor while a model has to LOAD: the axis holds, the offset is not rewritten', async () => {
        byTheWind();
        proxy.spreadFails = true;
        proxy.speedFor = () => 18;
        proxy.dirFor = () => 0;
        underWay();
        render(<PassageHudPane />);
        await lookAhead();
        const maxMin = Number(screen.getByTestId('route-scrub-track').getAttribute('aria-valuemax'));
        const parked = (maxMin - 20) * 60_000;
        act(() => setPassageAheadMs(parked));
        let release!: () => void;
        proxy.hold = new Promise<void>((resolve) => (release = resolve));
        act(() => WindStore.setModel('icon'));
        expect(text('hud-forecast-note')).toBe('LOADING');
        expect(getPassageLookAhead().aheadMs).toBe(parked);
        expect(Number(screen.getByTestId('route-scrub-track').getAttribute('aria-valuemax'))).toBe(maxMin);
        await act(async () => {
            release();
            await Promise.resolve();
        });
        await waitFor(() => expect(screen.queryByTestId('hud-forecast-note')).toBeNull());
        expect(getPassageLookAhead().aheadMs).toBe(parked);
    });

    it('tacking, the apparent wind is worked on her CLOSE-HAULED heading — not "0°S" dead along a line she is not steering', async () => {
        byTheWind();
        proxy.speedFor = () => 18;
        proxy.dirFor = () => 0; // dead on the nose up the first leg
        underWay();
        render(<PassageHudPane />);
        await lookAhead();
        expect(text('hud-route')).toMatch(/KN TACK$/);
        const awa = text('hud-awa');
        expect(awa).not.toContain('0°S');
        expect(awa).toMatch(/^\d{2}°$/); // an angle, and no P or S: the side alternates
        expect(label('hud-aws')).toContain('close-hauled on either tack');
        // …and the speed in it is her way through the water, which is more than she is making good.
        const aws = Number.parseFloat(text('hud-aws').replace('AW est', ''));
        expect(aws).toBeGreaterThan(18);
    });

    it('at the END she is ARRIVED — not "0.0KN SAIL" with an apparent wind for a boat standing still', async () => {
        byTheWind();
        proxy.speedFor = () => 16;
        underWay();
        render(<PassageHudPane />);
        await lookAhead();
        fireEvent.keyDown(screen.getByTestId('route-scrub-track'), { key: 'End' });
        expect(text('hud-route')).toMatch(/ARRIVED$/);
        expect(text('hud-route')).not.toContain('0.0KN');
        expect(text('hud-aws')).toContain('—');
        expect(label('hud-route')).toContain('arrived');
    });

    it('parked at the END she STAYS at the end as the plan is re-walked — and Play offers to start again', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        try {
            byTheWind();
            proxy.speedFor = () => 16;
            underWay();
            render(<PassageHudPane />);
            await lookAhead();
            fireEvent.keyDown(screen.getByTestId('route-scrub-track'), { key: 'End' });
            for (let i = 0; i < 4; i++) {
                await act(async () => {
                    await vi.advanceTimersByTimeAsync(30_000);
                });
                await boatStillReporting();
                expect(text('hud-route')).toMatch(/ARRIVED$/);
            }
            expect(screen.getByTestId('route-scrub-play').getAttribute('aria-label')).toBe('Play again from now');
        } finally {
            vi.useRealTimers();
        }
    });

    it('a STALE five-model bundle never stands in for the headline: the strip goes back for its one model', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        try {
            underWay();
            render(<PassageHudPane />);
            await lookAhead();
            expect(proxy.calls).toHaveLength(1);
            proxy.spreadFails = true; // the five-model request starts being refused; one model still answers
            await act(async () => {
                await vi.advanceTimersByTimeAsync(64 * 60_000);
            });
            await boatStillReporting();
            // It asked for the ONE model and got it: fresh numbers, no age note, and no old range under them.
            expect(proxy.calls.some((c) => c.models === 'ecmwf_ifs025')).toBe(true);
            expect(screen.queryByTestId('hud-forecast-note')).toBeNull();
            expect(screen.queryByTestId('hud-tws-spread')).toBeNull();
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('choosing how the ghost makes her way', () => {
    it('the dialog offers both, says plainly what "by the wind" assumes, and the choice is remembered', async () => {
        setPassageSpeedPref('polar');
        underWay();
        render(<PassageHudPane />);
        await lookAhead();
        fireEvent.click(screen.getByTestId('route-scrub-model'));
        const wind = screen.getByTestId('passage-speed-polar');
        const flat = screen.getByTestId('passage-speed-cruise');
        expect(wind.getAttribute('aria-pressed')).toBe('true');
        expect(wind.textContent).toContain('generic cruising polar');
        expect(wind.textContent).toContain('scaled so a fair reaching breeze gives her 6.0 kn');
        expect(wind.textContent).toContain('motors under 4 kn of wind');
        expect(wind.textContent).toContain('An estimate.');
        expect(flat.textContent).toContain('Cruising speed — 6.0 kn');
        fireEvent.click(flat);
        expect(localStorage.getItem('thalassa_passage_speed_mode_v1')).toBe('cruise');
        expect(flat.getAttribute('aria-pressed')).toBe('true');
        expect(text('hud-route')).toMatch(/6\.0KN CRUISE$/);
    });

    it('a power vessel is not offered "by the wind"', async () => {
        profile.vessel = { cruisingSpeed: 18, length: 40, type: 'power' };
        underWay();
        render(<PassageHudPane />);
        await lookAhead();
        fireEvent.click(screen.getByTestId('route-scrub-model'));
        expect((screen.getByTestId('passage-speed-polar') as HTMLButtonElement).disabled).toBe(true);
        expect(screen.getByTestId('passage-speed-cruise').getAttribute('aria-pressed')).toBe('true');
    });
});

describe('the sea she will be in (phase 4)', () => {
    it('shows the wave height at the ghost, the period beside it, and names whose model it is', async () => {
        underWay();
        render(<PassageHudPane />);
        await lookAhead();
        // 30 NM along a fixture that rises 0.01 m a mile from 1.4 m: 1.7 m, however the stations fall.
        await waitFor(() => expect(text('hud-sea')).toBe('Sea 7s1.7m'));
        expect(label('hud-sea')).toBe(
            'Forecast sea 1.7 metres, 7 second period, from 120 true, Météo-France wave model',
        );
        expect(screen.getByTestId('hud-sea').getAttribute('data-freshness')).toBe('forecast');
    });

    it('the sea changes as she moves along the route', async () => {
        underWay();
        render(<PassageHudPane />);
        await lookAhead();
        await waitFor(() => expect(text('hud-sea')).toMatch(/m$/));
        const first = Number.parseFloat(text('hud-sea').replace(/^Sea \d+s/, ''));
        act(() => setPassageAheadMs(12 * HOUR));
        const later = Number.parseFloat(text('hud-sea').replace(/^Sea \d+s/, ''));
        expect(later).toBeGreaterThan(first);
    });

    it('in the skipper’s own unit: the series is METRES, and 1.5 m is 4.9 ft — never "1.5 ft"', async () => {
        unitsPref.waveHeight = 'ft';
        proxy.waveFor = () => 1.5;
        underWay();
        render(<PassageHudPane />);
        await lookAhead();
        await waitFor(() => expect(text('hud-sea')).toBe('Sea 7s4.9ft'));
        expect(label('hud-sea')).toContain('4.9 feet');
    });

    it('the current is where it SETS, marked approximate, fair or foul — and says what it cannot see', async () => {
        proxy.currentKmh = 1.852; // one knot
        proxy.setDeg = 0; // setting north; she is heading north up the first leg
        underWay();
        render(<PassageHudPane />);
        await lookAhead();
        await waitFor(() => expect(text('hud-set')).toBe('Set 000°~1.0knFAIR'));
        expect(label('hud-set')).toContain('about 1.0 knots, setting toward 000 true, fair on this course');
        expect(label('hud-set')).toContain('tidal streams in passages and off headlands run much harder than it shows');
        expect(label('hud-set')).toContain('not applied to the arrival time');
    });

    it('against her it is FOUL, in amber; abeam it is neither', async () => {
        proxy.setDeg = 180;
        underWay();
        const first = render(<PassageHudPane />);
        await lookAhead();
        await waitFor(() => expect(text('hud-set-along')).toBe('FOUL'));
        expect(screen.getByTestId('hud-set-along').className).toContain('text-amber-300');
        first.unmount();
        __clearRouteSeaCacheForTests();
        proxy.setDeg = 90;
        render(<PassageHudPane />);
        await lookAhead();
        await waitFor(() => expect(text('hud-set')).toMatch(/^Set 090°~1\.0kn$/));
        expect(screen.queryByTestId('hud-set-along')).toBeNull();
    });

    it('the current NEVER moves the arrival: a five-mile model that under-reads passages does not set the ETA', async () => {
        proxy.currentKmh = 0;
        underWay();
        const still = render(<PassageHudPane />);
        await lookAhead();
        await waitFor(() => expect(text('hud-set')).toContain('0.0'));
        const max = screen.getByTestId('route-scrub-track').getAttribute('aria-valuemax');
        still.unmount();
        __clearRouteSeaCacheForTests();
        proxy.currentKmh = 9.26; // five knots dead astern
        proxy.setDeg = 0;
        render(<PassageHudPane />);
        await lookAhead();
        await waitFor(() => expect(text('hud-set')).toContain('~5.0'));
        expect(screen.getByTestId('route-scrub-track').getAttribute('aria-valuemax')).toBe(max);
    });

    it('off a berth the service could only answer from open water it says INSHORE — no swell painted onto a marina', async () => {
        // The first station's answer really came from ~13 km away, as Gladstone marina's did.
        proxy.snapFor = (station, p) =>
            station === 0 ? { lat: p.lat + 0.12, lon: p.lon } : { lat: p.lat + 0.02, lon: p.lon };
        // Following from the very start of the route, where that station is.
        act(() => {
            void NmeaStore.ingestRemote(snapshot({ lat: -27.98, lon: 153 }));
            useFollowRouteStore.getState().startFollowing(PLAN, 'voyage-1', ROUTE);
        });
        render(<PassageHudPane />);
        await lookAhead();
        await waitFor(() => expect(text('hud-sea-reason')).toBe('INSHORE'));
        expect(text('hud-sea')).toContain('—');
        expect(text('hud-set')).toContain('—');
        expect(label('hud-sea')).toContain('could only answer for open water');
        // Ten miles on she is in the open-water station's own half of the gap.
        act(() => setPassageAheadMs(2 * HOUR));
        expect(screen.queryByTestId('hud-sea-reason')).toBeNull();
        expect(text('hud-sea')).toMatch(/m$/);
    });

    it('no sea data is dashes and NO DATA — and the wind never waited on it', async () => {
        proxy.seaFails = true;
        underWay();
        render(<PassageHudPane />);
        await lookAhead(); // resolves on the WIND cell
        await waitFor(() => expect(text('hud-sea-reason')).toBe('NO DATA'));
        expect(text('hud-sea')).toContain('—');
        expect(text('hud-tws')).toMatch(/^TWS1\dkn/);
        // …and nobody is credited for numbers that are not on screen.
        expect(text('route-scrub-credit')).toBe('Forecast data: DWD, ECMWF, UK Met Office, JMA');
    });

    it('one marine request per route: changing the WIND model does not ask for the sea again', async () => {
        underWay();
        render(<PassageHudPane />);
        await lookAhead();
        await waitFor(() => expect(text('hud-sea')).toMatch(/m$/));
        expect(proxy.seaCalls).toEqual([{ models: 'meteofrance_wave,best_match', points: expect.any(Number) }]);
        act(() => WindStore.setModel('icon'));
        await waitFor(() => expect(text('route-scrub-model')).toContain('ICON'));
        expect(text('hud-sea')).toMatch(/m$/); // still there, no LOADING flash
        expect(proxy.seaCalls).toHaveLength(1);
    });

    it('the sea sits ABOVE rain and apparent wind: what she will be in outranks an estimate of an estimate', async () => {
        underWay();
        render(<PassageHudPane />);
        await lookAhead();
        const order = [...screen.getByTestId('passage-hud').querySelectorAll('[data-testid]')]
            .map((el) => el.getAttribute('data-testid'))
            .filter((id) => ['hud-twd', 'hud-sea', 'hud-set', 'hud-rain', 'hud-aws'].includes(id ?? ''));
        expect(order).toEqual(['hud-twd', 'hud-sea', 'hud-set', 'hud-rain', 'hud-aws']);
    });

    it('arrived, the sea at the destination is still shown — and a stopped boat has no FAIR or FOUL', async () => {
        underWay();
        render(<PassageHudPane />);
        await lookAhead();
        await waitFor(() => expect(text('hud-set-along')).toBe('FAIR'));
        fireEvent.keyDown(screen.getByTestId('route-scrub-track'), { key: 'End' });
        expect(text('hud-route')).toMatch(/ARRIVED$/);
        expect(text('hud-sea')).toMatch(/m$/);
        expect(label('hud-sea')).toContain('Forecast sea');
        expect(screen.queryByTestId('hud-set-along')).toBeNull();
    });

    it('a dash NEVER stands without words: a hole in the wave run reads NO DATA, not a bare dash', async () => {
        proxy.waveFor = () => null; // currents, but no waves at all
        underWay();
        render(<PassageHudPane />);
        await lookAhead();
        await waitFor(() => expect(text('hud-set')).toContain('~1.0'));
        expect(text('hud-sea')).toContain('—');
        expect(text('hud-sea-reason')).toBe('NO DATA'); // and NOT "PAST FCST" at +0 h
    });

    it('a route that never leaves the river says INSHORE throughout — an answer, not a failure', async () => {
        proxy.snapFor = (_station, p) => ({ lat: p.lat + 0.12, lon: p.lon }); // every station ~13 km off
        underWay();
        render(<PassageHudPane />);
        await lookAhead();
        await waitFor(() => expect(text('hud-sea-reason')).toBe('INSHORE'));
        act(() => setPassageAheadMs(6 * HOUR));
        expect(text('hud-sea-reason')).toBe('INSHORE');
        // Nobody is credited for a sea that is not on screen…
        expect(text('route-scrub-credit')).toBe('Forecast data: DWD, ECMWF, UK Met Office, JMA');
        // …and it was ONE request: kept for the hour, not retried as though it had failed.
        expect(proxy.seaCalls).toHaveLength(1);
    });

    it('a sea series that could not be refreshed WEARS ITS AGE, as the wind’s does', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        try {
            underWay();
            render(<PassageHudPane />);
            await lookAhead();
            await waitFor(() => expect(text('hud-sea')).toMatch(/m$/));
            expect(screen.queryByTestId('hud-sea-reason')).toBeNull();
            proxy.seaFails = true; // the marine request starts failing; the wind still refreshes
            await act(async () => {
                await vi.advanceTimersByTimeAsync(3 * 3_600_000 + 10 * 60_000);
            });
            await boatStillReporting();
            expect(text('hud-sea')).toMatch(/m/); // the old run's number is still there…
            expect(text('hud-sea-reason')).toBe('3 H OLD'); // …wearing its age
            expect(label('hud-sea')).toContain('fetched 3 h old');
            expect(label('hud-set')).toContain('fetched 3 h old');
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('changing the model', () => {
    it('opens a centred dialog from the scrubber, and one tap changes the model for the chart too', async () => {
        underWay();
        render(<PassageHudPane />);
        await lookAhead();
        fireEvent.click(screen.getByTestId('route-scrub-model'));
        const dialog = screen.getByRole('dialog');
        expect(dialog.getAttribute('aria-label')).toBe('Forecast model and ghost speed');
        expect(dialog.parentElement?.className).toContain('items-center');
        expect(dialog.parentElement?.className).toContain('pb-[calc(4rem+env(safe-area-inset-bottom)+1rem)]');
        expect(dialog.textContent).toContain('(CC-BY-4.0)');
        fireEvent.click(screen.getByTestId('passage-model-icon'));
        expect(WindStore.getState().model).toBe('icon');
        expect(screen.queryByRole('dialog')).toBeNull();
        await waitFor(() => expect(text('route-scrub-model')).toContain('ICON'));
        // Anchored on the HEADLINE: the range under it ("12–33") contains a 3 too,
        // and the first version of this assertion could not fail (review).
        await waitFor(() => expect(text('hud-tws')).toMatch(/^TWS3\dkn/));
        // INSTANT, and free: ICON came in the same five-model reply. No second request.
        expect(proxy.calls).toHaveLength(1);
        expect(text('route-scrub-credit')).toBe(
            'Forecast data: DWD, ECMWF, UK Met Office, JMA, Météo-France, Open-Meteo',
        );
    });

    it('if the five-model request fails, the strip still gets its ONE model — the spread is extra, never a precondition', async () => {
        proxy.spreadFails = true;
        underWay();
        render(<PassageHudPane />);
        await lookAhead();
        expect(text('hud-tws')).toMatch(/TWS1\d/);
        expect(proxy.calls.map((c) => c.models.split(',').length)).toEqual([5, 1]);
        expect(proxy.calls[1].models).toBe('ecmwf_ifs025');
        expect(screen.queryByTestId('hud-tws-spread')).toBeNull(); // no spread to show, and none invented
        expect(screen.queryByTestId('route-scrub-band')).toBeNull();
        expect(text('route-scrub-credit')).toBe('Forecast data: ECMWF, Météo-France, Open-Meteo');
    });

    it('NEVER shows the old model’s numbers under the new model’s name while the new ones load', async () => {
        proxy.spreadFails = true; // the single-model path: the only one on which a model change has to LOAD
        underWay();
        render(<PassageHudPane />);
        await lookAhead();
        expect(text('hud-tws')).toMatch(/1\d/);
        let release!: () => void;
        proxy.hold = new Promise<void>((resolve) => (release = resolve));
        act(() => WindStore.setModel('icon'));
        expect(text('route-scrub-model')).toContain('ICON');
        expect(text('hud-tws')).toContain('—');
        expect(text('hud-forecast-note')).toBe('LOADING');
        await act(async () => {
            release();
            await Promise.resolve();
        });
        await waitFor(() => expect(text('hud-tws')).toMatch(/3\d/));
    });

    it('a model with no gust forecast says so — it does not show a dash that looks like a failure', async () => {
        act(() => WindStore.setModel('jma'));
        underWay();
        render(<PassageHudPane />);
        await lookAhead();
        expect(text('hud-gust')).toContain('N/A');
        expect(label('hud-gust')).toBe('JMA does not publish a gust forecast');
    });
});

describe('where the chart’s wind field stops', () => {
    it('is said on the scrubber once the ghost has sailed past it', async () => {
        profile.vessel = { cruisingSpeed: 1 }; // a long, slow passage: 83 hours of axis
        underWay();
        render(<PassageHudPane />);
        await lookAhead();
        act(() => reportPassageWindCoverage(46));
        act(() => setPassageAheadMs(60 * HOUR));
        expect(text('route-scrub-note')).toBe('Chart wind ends +46 h — numbers continue');
    });
});

describe('the glance ends', () => {
    it('LIVE on the strip goes straight back', async () => {
        underWay();
        render(<PassageHudPane />);
        await lookAhead();
        fireEvent.click(screen.getByTestId('hud-look-ahead'));
        expect(getPassageLookAhead().on).toBe(false);
        expect(getPassageGhost()).toBeNull();
        expect(text('hud-mode')).toBe('Live');
        expect(text('hud-sog')).toContain('6.1');
        expect(screen.queryByTestId('route-time-scrubber')).toBeNull();
    });

    it('leaving the chart ends it: the next thing on screen is live', async () => {
        underWay();
        const view = render(<PassageHudPane />);
        await lookAhead();
        act(() => setPassageAheadMs(9 * HOUR));
        view.unmount();
        expect(getPassageLookAhead()).toEqual({ on: false, aheadMs: 0, playing: false });
        expect(getPassageGhost()).toBeNull();
    });

    it('so does stopping the route', async () => {
        underWay();
        render(<PassageHudPane />);
        await lookAhead();
        act(() => useFollowRouteStore.getState().stopFollowing());
        expect(getPassageLookAhead().on).toBe(false);
        expect(text('hud-mode')).toBe('Live');
    });

    it('and so does the strip standing down behind a storm card or the planner', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        try {
            underWay();
            render(<PassageHudPane />);
            await lookAhead();
            // What index.css does to the strip for those surfaces.
            screen.getByTestId('passage-hud').style.display = 'none';
            act(() => {
                vi.advanceTimersByTime(1100);
            });
            expect(getPassageLookAhead().on).toBe(false);
        } finally {
            vi.useRealTimers();
        }
    });
});
