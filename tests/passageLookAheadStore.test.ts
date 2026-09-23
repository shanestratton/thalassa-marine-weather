/**
 * The look-ahead time axis (passage strip, phase 2).
 *
 * One offset, three followers: the strip's forecast cells, the ghost on the
 * chart and the chart's wind timeline. What must never happen: the chart opens
 * on tomorrow's wind because yesterday's glance was remembered; collapsing the
 * instruments resets an active scrubber; the offset runs past seven days or
 * past the end of the axis it was given.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    LOOK_AHEAD_MAX_MS,
    PASSAGE_DEPARTURE_MAX_MS,
    __resetPassageHudForTests,
    getPassageGhost,
    getPassageGhostJoinPath,
    getPassageGhostPath,
    getPassageLookAhead,
    getPassageRainCoverageHours,
    getPassageSpeedPref,
    getPassageUnsyncedLayers,
    getPassageWindCoverageHours,
    publishPassageGhost,
    publishPassageGhostJoinPath,
    publishPassageGhostPath,
    reportPassageRainCoverage,
    reportPassageUnsyncedLayers,
    reportPassageWindCoverage,
    setPassageAheadMs,
    setPassageHudEnabled,
    setPassageHudOpen,
    setPassageLookAheadPlaying,
    setPassageSpeedPref,
    startPassageLookAhead,
    stopPassageLookAhead,
    subscribePassageGhost,
    subscribePassageLookAhead,
} from '../stores/passageHudStore';

const HOUR = 3_600_000;

beforeEach(() => {
    localStorage.clear();
    __resetPassageHudForTests();
    setPassageHudEnabled(true);
    setPassageHudOpen(true);
});

describe('live until asked', () => {
    it('starts live, at now, not playing', () => {
        expect(getPassageLookAhead()).toEqual({ on: false, departureMs: null, aheadMs: 0, playing: false });
    });

    it('enters at NOW — the model’s numbers for this hour, not a jump into the future', () => {
        startPassageLookAhead();
        expect(getPassageLookAhead()).toEqual({ on: true, departureMs: null, aheadMs: 0, playing: false });
    });

    it('is never written to storage: the chart cannot boot into a forecast', () => {
        startPassageLookAhead();
        setPassageAheadMs(30 * HOUR);
        expect(JSON.stringify(localStorage)).not.toMatch(/ahead|look/i);
        __resetPassageHudForTests();
        expect(getPassageLookAhead().on).toBe(false);
    });

    it('moving the offset while live does nothing', () => {
        setPassageAheadMs(6 * HOUR);
        setPassageLookAheadPlaying(true);
        expect(getPassageLookAhead()).toEqual({ on: false, departureMs: null, aheadMs: 0, playing: false });
    });
});

describe('a chosen departure', () => {
    const NOW = Date.parse('2026-09-21T02:00:00Z');

    beforeEach(() => {
        vi.spyOn(Date, 'now').mockReturnValue(NOW);
    });
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it.each([0, 24 * HOUR, 5 * 24 * HOUR])('accepts a departure %i milliseconds from now', (offset) => {
        startPassageLookAhead(NOW + offset);
        expect(getPassageLookAhead()).toEqual({
            on: true,
            departureMs: NOW + offset,
            aheadMs: 0,
            playing: false,
        });
        expect(PASSAGE_DEPARTURE_MAX_MS).toBe(5 * 24 * HOUR);
    });

    it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, 5 * 24 * HOUR + 1])(
        'rejects an invalid departure offset %s without activating a forecast',
        (offset) => {
            const live = getPassageLookAhead();
            startPassageLookAhead(NOW + offset);
            expect(getPassageLookAhead()).toBe(live);
        },
    );

    it('rejects an invalid replacement without changing the current time, playback or subscribers', () => {
        startPassageLookAhead(NOW + HOUR);
        setPassageAheadMs(6 * HOUR);
        setPassageLookAheadPlaying(true);
        const current = getPassageLookAhead();
        const heard = vi.fn();
        const off = subscribePassageLookAhead(heard);
        try {
            startPassageLookAhead(NOW - 1);
            expect(getPassageLookAhead()).toBe(current);
            expect(heard).not.toHaveBeenCalled();
        } finally {
            off();
        }
    });

    it('resets elapsed time and pauses when choosing or reselecting a valid departure', () => {
        startPassageLookAhead();
        setPassageAheadMs(6 * HOUR);
        setPassageLookAheadPlaying(true);
        startPassageLookAhead(NOW + HOUR);
        expect(getPassageLookAhead()).toEqual({ on: true, departureMs: NOW + HOUR, aheadMs: 0, playing: false });
        setPassageAheadMs(2 * HOUR);
        setPassageLookAheadPlaying(true);
        startPassageLookAhead(NOW + HOUR);
        expect(getPassageLookAhead()).toEqual({ on: true, departureMs: NOW + HOUR, aheadMs: 0, playing: false });
    });

    it('notifies readers when only the chosen departure changes', () => {
        startPassageLookAhead(NOW + HOUR);
        const heard = vi.fn();
        const off = subscribePassageLookAhead(heard);
        try {
            startPassageLookAhead(NOW + 2 * HOUR);
            expect(getPassageLookAhead().departureMs).toBe(NOW + 2 * HOUR);
            expect(heard).toHaveBeenCalledTimes(1);
            startPassageLookAhead(NOW + 2 * HOUR);
            expect(heard).toHaveBeenCalledTimes(1);
        } finally {
            off();
        }
    });

    it('keeps legacy start calls idempotent for both rolling and fixed departures', () => {
        for (const departure of [null, NOW + HOUR]) {
            stopPassageLookAhead();
            startPassageLookAhead(departure);
            setPassageAheadMs(3 * HOUR);
            setPassageLookAheadPlaying(true);
            const current = getPassageLookAhead();
            startPassageLookAhead();
            startPassageLookAhead(undefined);
            expect(getPassageLookAhead()).toBe(current);
        }
    });

    it('explicitly resets a fixed or rolling look to Leave now when passed null', () => {
        for (const departure of [NOW + HOUR, null]) {
            startPassageLookAhead(departure);
            setPassageAheadMs(3 * HOUR);
            setPassageLookAheadPlaying(true);
            startPassageLookAhead(null);
            expect(getPassageLookAhead()).toEqual({ on: true, departureMs: null, aheadMs: 0, playing: false });
        }
    });

    it('retains the absolute departure as wall time advances and instruments collapse', () => {
        startPassageLookAhead(NOW + HOUR);
        vi.mocked(Date.now).mockReturnValue(NOW + 2 * HOUR);
        setPassageAheadMs(3 * HOUR);
        setPassageLookAheadPlaying(true);
        setPassageHudOpen(false);
        expect(getPassageLookAhead()).toEqual({
            on: true,
            departureMs: NOW + HOUR,
            aheadMs: 3 * HOUR,
            playing: true,
        });
    });

    it.each([
        ['return to live', stopPassageLookAhead],
        ['disable the HUD', () => setPassageHudEnabled(false)],
        ['reset the session', __resetPassageHudForTests],
    ])('clears the departure when asked to %s', (_name, reset) => {
        startPassageLookAhead(NOW + HOUR);
        setPassageAheadMs(3 * HOUR);
        reset();
        expect(getPassageLookAhead()).toEqual({ on: false, departureMs: null, aheadMs: 0, playing: false });
        expect(JSON.stringify(localStorage)).not.toMatch(/departure|ahead|look/i);
    });
});

describe('the offset', () => {
    beforeEach(() => startPassageLookAhead());

    it('is held inside the axis it is given, and never past seven days', () => {
        setPassageAheadMs(50 * HOUR, 20 * HOUR);
        expect(getPassageLookAhead().aheadMs).toBe(20 * HOUR);
        setPassageAheadMs(-5);
        expect(getPassageLookAhead().aheadMs).toBe(0);
        setPassageAheadMs(400 * HOUR, 9999 * HOUR);
        expect(getPassageLookAhead().aheadMs).toBe(LOOK_AHEAD_MAX_MS);
        expect(LOOK_AHEAD_MAX_MS).toBe(7 * 24 * HOUR);
    });

    it('ignores a nonsense value instead of storing NaN for three followers to choke on', () => {
        setPassageAheadMs(6 * HOUR);
        setPassageAheadMs(Number.NaN);
        expect(getPassageLookAhead().aheadMs).toBe(6 * HOUR);
    });

    it('hands out the SAME snapshot until something changes', () => {
        setPassageAheadMs(6 * HOUR);
        const a = getPassageLookAhead();
        setPassageAheadMs(6 * HOUR);
        expect(getPassageLookAhead()).toBe(a);
        const heard = vi.fn();
        const off = subscribePassageLookAhead(heard);
        setPassageAheadMs(6 * HOUR);
        expect(heard).not.toHaveBeenCalled();
        setPassageAheadMs(7 * HOUR);
        expect(heard).toHaveBeenCalledTimes(1);
        off();
    });
});

describe('minimizing instruments and ending the forecast', () => {
    it('minimizing preserves the forecast time, playback, ghost and preferences for the scrubber', () => {
        startPassageLookAhead();
        setPassageAheadMs(12 * HOUR);
        setPassageLookAheadPlaying(true);
        setPassageSpeedPref('cruise');
        publishPassageGhost({ lat: -25, lon: 153, bearingDeg: 10, label: '+12 h' });
        publishPassageGhostPath([
            { lat: -26, lon: 153 },
            { lat: -25, lon: 153 },
        ]);
        publishPassageGhostJoinPath([
            { lat: -26, lon: 152.9 },
            { lat: -26, lon: 153 },
        ]);
        const look = getPassageLookAhead();
        const ghost = getPassageGhost();
        const path = getPassageGhostPath();
        const join = getPassageGhostJoinPath();
        setPassageHudOpen(false);
        expect(getPassageLookAhead()).toBe(look);
        expect(getPassageGhost()).toBe(ghost);
        expect(getPassageGhostPath()).toBe(path);
        expect(getPassageGhostJoinPath()).toBe(join);
        expect(getPassageSpeedPref()).toBe('cruise');
        setPassageAheadMs(13 * HOUR);
        setPassageHudOpen(true);
        expect(getPassageLookAhead()).toEqual({ on: true, departureMs: null, aheadMs: 13 * HOUR, playing: true });
        expect(getPassageGhost()).toBe(ghost);
    });

    it('disabling the HUD ends the forecast even while the instruments are minimized', () => {
        startPassageLookAhead();
        setPassageAheadMs(12 * HOUR);
        setPassageLookAheadPlaying(true);
        publishPassageGhost({ lat: -25, lon: 153, bearingDeg: 10, label: '+12 h' });
        publishPassageGhostPath([
            { lat: -26, lon: 153 },
            { lat: -25, lon: 153 },
        ]);
        publishPassageGhostJoinPath([
            { lat: -26, lon: 152.9 },
            { lat: -26, lon: 153 },
        ]);
        setPassageHudOpen(false);
        setPassageHudEnabled(false);
        expect(getPassageLookAhead()).toEqual({ on: false, departureMs: null, aheadMs: 0, playing: false });
        expect(getPassageGhost()).toBeNull();
        expect(getPassageGhostPath()).toBeNull();
        expect(getPassageGhostJoinPath()).toBeNull();
    });

    it('back to live resets the offset: the next glance starts from now again', () => {
        startPassageLookAhead();
        setPassageAheadMs(40 * HOUR);
        setPassageLookAheadPlaying(true);
        stopPassageLookAhead();
        startPassageLookAhead();
        expect(getPassageLookAhead()).toEqual({ on: true, departureMs: null, aheadMs: 0, playing: false });
    });
});

describe('the separate forecast approach to the route', () => {
    const route = [
        { lat: -26, lon: 153 },
        { lat: -25, lon: 153 },
    ];
    const join = [{ lat: -26, lon: 152.9 }, route[0]];

    it('notifies the ghost subscriber only when the approach changes, without replacing the route', () => {
        publishPassageGhostPath(route);
        const heard = vi.fn();
        const off = subscribePassageGhost(heard);
        try {
            expect(getPassageGhostJoinPath()).toBeNull();
            publishPassageGhostJoinPath(join);
            expect(getPassageGhostJoinPath()).toBe(join);
            publishPassageGhostJoinPath(join.map((point) => ({ ...point })));
            expect(getPassageGhostJoinPath()).toBe(join);
            expect(heard).toHaveBeenCalledTimes(1);
            publishPassageGhostJoinPath([{ lat: -26, lon: 152.8 }, route[0]]);
            expect(heard).toHaveBeenCalledTimes(2);
            expect(getPassageGhostPath()).toBe(route);
            publishPassageGhostJoinPath(null);
            expect(getPassageGhostJoinPath()).toBeNull();
            expect(getPassageGhostPath()).toBe(route);
        } finally {
            off();
        }
    });

    it('is ephemeral and is cleared when returning live or resetting the store', () => {
        startPassageLookAhead();
        publishPassageGhostJoinPath(join);
        expect(JSON.stringify(localStorage)).not.toMatch(/join|152\.9/i);
        stopPassageLookAhead();
        expect(getPassageGhostJoinPath()).toBeNull();
        publishPassageGhostJoinPath(join);
        __resetPassageHudForTests();
        expect(getPassageGhostJoinPath()).toBeNull();
    });

    it('does not publish a single point as an approach line', () => {
        publishPassageGhostJoinPath(join);
        publishPassageGhostJoinPath([join[0]]);
        expect(getPassageGhostJoinPath()).toBeNull();
    });
});

describe('the ghost and the wind coverage', () => {
    it('tells the chart only when the ghost really moved', () => {
        const heard = vi.fn();
        const off = subscribePassageGhost(heard);
        publishPassageGhost({ lat: -25, lon: 153, bearingDeg: 10, label: '+1 h' });
        publishPassageGhost({ lat: -25, lon: 153, bearingDeg: 10, label: '+1 h' });
        expect(heard).toHaveBeenCalledTimes(1);
        publishPassageGhost({ lat: -24.9, lon: 153, bearingDeg: 10, label: '+2 h' });
        expect(heard).toHaveBeenCalledTimes(2);
        off();
    });

    it('carries how many hours of wind FIELD the chart holds, or null when that layer is off', () => {
        expect(getPassageWindCoverageHours()).toBeNull();
        reportPassageWindCoverage(41.26);
        expect(getPassageWindCoverageHours()).toBe(41.3);
        reportPassageWindCoverage(Number.NaN);
        expect(getPassageWindCoverageHours()).toBeNull();
    });

    it.each([
        ['wind', reportPassageWindCoverage, getPassageWindCoverageHours],
        ['rain', reportPassageRainCoverage, getPassageRainCoverageHours],
    ] as const)('keeps zero %s coverage distinct from unknown coverage', (_name, report, read) => {
        report(0);
        expect(read()).toBe(0);
        report(null);
        expect(read()).toBeNull();
        report(-1);
        expect(read()).toBeNull();
    });

    it('carries the names of the chart layers that are NOT at the scrubbed moment, with a stable snapshot', () => {
        expect(getPassageUnsyncedLayers()).toEqual([]);
        reportPassageUnsyncedLayers(['rain', 'currents']);
        const first = getPassageUnsyncedLayers();
        expect(first).toEqual(['rain', 'currents']);
        reportPassageUnsyncedLayers(['rain', 'currents']);
        expect(getPassageUnsyncedLayers()).toBe(first); // same list → same object → no re-render
        reportPassageUnsyncedLayers([]);
        expect(getPassageUnsyncedLayers()).toEqual([]);
    });
});
