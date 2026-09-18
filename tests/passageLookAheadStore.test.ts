/**
 * The look-ahead time axis (passage strip, phase 2).
 *
 * One offset, three followers: the strip's forecast cells, the ghost on the
 * chart and the chart's wind timeline. What must never happen: the chart opens
 * on tomorrow's wind because yesterday's glance was remembered; a hidden strip
 * leaves the chart's own time controls stood down; the offset runs past seven
 * days or past the end of the axis it was given.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    LOOK_AHEAD_MAX_MS,
    __resetPassageHudForTests,
    getPassageGhost,
    getPassageLookAhead,
    getPassageUnsyncedLayers,
    getPassageWindCoverageHours,
    publishPassageGhost,
    reportPassageUnsyncedLayers,
    reportPassageWindCoverage,
    setPassageAheadMs,
    setPassageHudEnabled,
    setPassageHudOpen,
    setPassageLookAheadPlaying,
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
        expect(getPassageLookAhead()).toEqual({ on: false, aheadMs: 0, playing: false });
    });

    it('enters at NOW — the model’s numbers for this hour, not a jump into the future', () => {
        startPassageLookAhead();
        expect(getPassageLookAhead()).toEqual({ on: true, aheadMs: 0, playing: false });
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
        expect(getPassageLookAhead()).toEqual({ on: false, aheadMs: 0, playing: false });
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

describe('the glance ends with the strip', () => {
    it('hiding the strip goes back to live and takes the ghost off the chart', () => {
        startPassageLookAhead();
        setPassageAheadMs(12 * HOUR);
        publishPassageGhost({ lat: -25, lon: 153, bearingDeg: 10, label: '+12 h' });
        setPassageHudOpen(false);
        expect(getPassageLookAhead().on).toBe(false);
        expect(getPassageGhost()).toBeNull();
    });

    it('so does switching the strip off in Preferences', () => {
        startPassageLookAhead();
        setPassageHudEnabled(false);
        expect(getPassageLookAhead().on).toBe(false);
    });

    it('back to live resets the offset: the next glance starts from now again', () => {
        startPassageLookAhead();
        setPassageAheadMs(40 * HOUR);
        setPassageLookAheadPlaying(true);
        stopPassageLookAhead();
        startPassageLookAhead();
        expect(getPassageLookAhead()).toEqual({ on: true, aheadMs: 0, playing: false });
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
