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
vi.mock('../stores/settingsStore', () => {
    const state = () => ({ settings: { vessel: profile.vessel } });
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
    speedFor: (model: string, station: number) => (model === 'dwd_icon' ? 30 : 10) + station,
}));
vi.mock('../services/weather/openMeteoProxy', () => ({
    fetchOpenMeteoPoints: async (
        _op: string,
        points: { lat: number; lon: number }[],
        params: Record<string, unknown>,
    ) => {
        const model = String(params.models);
        proxy.calls.push({ models: model, points: points.length });
        if (proxy.hold) await proxy.hold;
        if (proxy.offline || proxy.failNext) throw new Error('offline');
        const start = Math.floor(Date.now() / HOUR) * HOUR;
        return points.map((_, station) => ({
            hourly: {
                time: Array.from({ length: proxy.hours }, (_h, h) => (start + h * HOUR) / 1000),
                wind_speed_10m: Array.from({ length: proxy.hours }, () => proxy.speedFor(model, station)),
                wind_direction_10m: Array.from({ length: proxy.hours }, () => 90),
                wind_gusts_10m: Array.from({ length: proxy.hours }, () =>
                    model === 'jma_gsm' ? null : proxy.speedFor(model, station) + 8,
                ),
                precipitation: Array.from({ length: proxy.hours }, () => 1.2),
                precipitation_probability: Array.from({ length: proxy.hours }, () => 60),
            },
        }));
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
} from '../stores/passageHudStore';
import { __resetPassageOverlayForTests, isPassageOverlayOn } from '../stores/chartPassageOverlay';
import { __clearRouteForecastCacheForTests } from '../services/routeForecastSampler';
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
        expect(label('hud-tws')).toMatch(/^Forecast true wind speed .* ECMWF$/);
    });

    it('marks apparent wind as an ESTIMATE, in the label and to a screen reader', async () => {
        underWay();
        render(<PassageHudPane />);
        await lookAhead();
        expect(text('hud-aws')).toContain('AWS est');
        expect(label('hud-aws')).toContain('not measured');
        expect(label('hud-awa')).toContain('not measured');
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
        expect(text('hud-tws')).toBe('TWS13kn');
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
        expect(text('hud-route')).toMatch(/To go5[2-5]NMAT 6\.0 KN/);
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
        expect(proxy.calls).toEqual([{ models: 'ecmwf_ifs025', points: expect.any(Number) }]);
        expect(text('route-scrub-model')).toContain('ECMWF');
        expect(text('route-scrub-credit')).toBe('Forecast data: ECMWF');
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
        expect(text('hud-route')).toBe(`To go${live}NMAT 6.0 KN`);
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

describe('changing the model', () => {
    it('opens a centred dialog from the scrubber, and one tap changes the model for the chart too', async () => {
        underWay();
        render(<PassageHudPane />);
        await lookAhead();
        fireEvent.click(screen.getByTestId('route-scrub-model'));
        const dialog = screen.getByRole('dialog');
        expect(dialog.getAttribute('aria-label')).toBe('Change forecast model');
        expect(dialog.parentElement?.className).toContain('items-center');
        expect(dialog.parentElement?.className).toContain('pb-[calc(4rem+env(safe-area-inset-bottom)+1rem)]');
        expect(dialog.textContent).toContain('(CC-BY-4.0)');
        fireEvent.click(screen.getByTestId('passage-model-icon'));
        expect(WindStore.getState().model).toBe('icon');
        expect(screen.queryByRole('dialog')).toBeNull();
        await waitFor(() => expect(text('route-scrub-model')).toContain('ICON'));
        await waitFor(() => expect(text('hud-tws')).toMatch(/3\d/));
        expect(proxy.calls.map((c) => c.models)).toEqual(['ecmwf_ifs025', 'dwd_icon']);
        expect(text('route-scrub-credit')).toBe('Forecast data: DWD');
    });

    it('NEVER shows the old model’s numbers under the new model’s name while the new ones load', async () => {
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
