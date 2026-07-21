/**
 * flightRecorder — the black box that has to survive the thing it records.
 *
 * The whole point is the verdict: after two wrong diagnoses of the far-location
 * crash, we need the device to say whether the app RELOADED (controlled — a
 * lazyRetry chunk failure looks identical to a crash from the user's seat) or
 * whether the process DIED without running any JS (a WKWebView OOM). These pin
 * that classification, since getting it backwards would send the next
 * investigation down the wrong path again.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { crumb, lastFlightTrail, startFlightRecorder } from '../utils/flightRecorder';

const TRAIL_KEY = 'thalassa_flight_trail';
const CLEAN_EXIT_KEY = 'thalassa_flight_clean_exit';

/** Simulate a process death: crumbs on disk, no pagehide ever fired. */
function priorRunKilled(tags: string[]) {
    localStorage.setItem(TRAIL_KEY, JSON.stringify(tags.map((tag, i) => ({ t: i * 100, tag }))));
    localStorage.removeItem(CLEAN_EXIT_KEY);
}

/** Simulate a controlled reload: crumbs on disk AND pagehide ran. */
function priorRunReloaded(tags: string[]) {
    priorRunKilled(tags);
    localStorage.setItem(CLEAN_EXIT_KEY, '1');
}

describe('flightRecorder verdict', () => {
    beforeEach(() => {
        localStorage.clear();
    });

    it('reports a clean start when there is no prior trail', () => {
        const r = startFlightRecorder();
        expect(r.verdict).toBe('clean-start');
        expect(r.trail).toEqual([]);
    });

    it('calls it PROCESS-DIED when crumbs survived but pagehide never ran', () => {
        // A content-process kill executes no JS, so nothing can mark a clean
        // exit. This is the WKWebView OOM signature.
        priorRunKilled(['boot', 'pick:commit', 'enc:walk-start']);
        const r = startFlightRecorder();
        expect(r.verdict).toBe('process-died');
        expect(r.summary).toContain('enc:walk-start');
    });

    it('calls it CONTROLLED-RELOAD when pagehide ran — not a memory crash', () => {
        priorRunReloaded(['boot', 'pick:commit', 'lazyRetry:reload']);
        const r = startFlightRecorder();
        expect(r.verdict).toBe('controlled-reload');
    });

    it('surfaces the LAST crumb — where it died is the whole answer', () => {
        priorRunKilled(['boot', 'pick:commit', 'shelter:start']);
        expect(startFlightRecorder().summary).toContain('shelter:start');
    });

    it('preserves the prior trail for inspection, oldest first', () => {
        priorRunKilled(['boot', 'pick:commit']);
        startFlightRecorder();
        expect(lastFlightTrail().map((c) => c.tag)).toEqual(['boot', 'pick:commit']);
    });

    it('clears the live trail so one crash is not re-reported forever', () => {
        priorRunKilled(['boot', 'pick:commit']);
        startFlightRecorder();
        expect(localStorage.getItem(TRAIL_KEY)).toBeNull();
        // A second start now sees a fresh run, not the old corpse.
        expect(startFlightRecorder().verdict).toBe('clean-start');
    });
});

describe('crumb recording', () => {
    beforeEach(() => {
        localStorage.clear();
        startFlightRecorder();
    });

    it('records tags and optional info in order', () => {
        crumb('pick:commit', '1100nm');
        crumb('enc:walk-start', '38cells');
        const trail = JSON.parse(localStorage.getItem(TRAIL_KEY)!);
        expect(trail.map((c: { tag: string }) => c.tag)).toEqual(['pick:commit', 'enc:walk-start']);
        expect(trail[0].info).toBe('1100nm');
    });

    it('keeps the crumbs nearest the crash when the buffer overflows', () => {
        for (let i = 0; i < 60; i++) crumb(`t${i}`);
        const trail = JSON.parse(localStorage.getItem(TRAIL_KEY)!);
        expect(trail).toHaveLength(40);
        expect(trail[trail.length - 1].tag).toBe('t59'); // newest kept
        expect(trail[0].tag).toBe('t20'); // oldest dropped
    });

    it('never throws when storage is unavailable — it must not break the app', () => {
        const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw new Error('QuotaExceededError');
        });
        expect(() => crumb('boom')).not.toThrow();
        spy.mockRestore();
    });
});
