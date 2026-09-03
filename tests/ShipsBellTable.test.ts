/**
 * The bell table, checked against the printed one.
 *
 * Shane sent the standard watch/bell table and asked for it on the clock, so
 * the grid the app draws must BE that table — not a plausible-looking one.
 * Every cell below is transcribed from it.
 *
 * The Last Dog watch is the row that matters. Printed tables carry two
 * conventions at once: 18:30/19:00/19:30 as five/six/seven bells, and the same
 * three times footnoted as one/two/three. This clock strikes the second — the
 * Royal Navy's — so the table it draws must agree with what it strikes, which
 * the round-trip at the end enforces.
 */
import { describe, expect, it } from 'vitest';
import { WATCH_ORDER, bellTime, bellsAt } from '../utils/shipsBells';

const PRINTED: Record<string, Array<string | null>> = {
    // bells 1..8
    'Middle Watch': ['00:30', '01:00', '01:30', '02:00', '02:30', '03:00', '03:30', '04:00'],
    'Morning Watch': ['04:30', '05:00', '05:30', '06:00', '06:30', '07:00', '07:30', '08:00'],
    'Forenoon Watch': ['08:30', '09:00', '09:30', '10:00', '10:30', '11:00', '11:30', '12:00'],
    'Afternoon Watch': ['12:30', '13:00', '13:30', '14:00', '14:30', '15:00', '15:30', '16:00'],
    'First Dog Watch': ['16:30', '17:00', '17:30', '18:00', null, null, null, null],
    'Last Dog Watch': ['18:30', '19:00', '19:30', null, null, null, null, '20:00'],
    'First Watch': ['20:30', '21:00', '21:30', '22:00', '22:30', '23:00', '23:30', '24:00'],
};

describe("the ship's bell table", () => {
    it('matches the printed table cell for cell', () => {
        for (const watch of WATCH_ORDER) {
            for (let bells = 1; bells <= 8; bells++) {
                expect(bellTime(watch, bells), `${watch}, ${bells} bells`).toBe(PRINTED[watch][bells - 1]);
            }
        }
    });

    it('the two dog watches are the only ones with gaps', () => {
        for (const watch of WATCH_ORDER) {
            const gaps = PRINTED[watch].filter((c) => c === null).length;
            expect(gaps === 0 || watch.includes('Dog'), `${watch} should be full`).toBe(true);
        }
        // The first dog simply stops at four; the last dog SKIPS to eight.
        expect(bellTime('First Dog Watch', 5)).toBeNull();
        expect(bellTime('Last Dog Watch', 5)).toBeNull();
        expect(bellTime('Last Dog Watch', 8)).toBe('20:00');
    });

    it('every cell agrees with what the clock actually strikes at that time', () => {
        // The table and the face must never disagree — a reference that
        // contradicts the instrument beside it is worse than no reference.
        for (const watch of WATCH_ORDER) {
            for (let bells = 1; bells <= 8; bells++) {
                const at = bellTime(watch, bells);
                if (!at) continue;
                const [hh, mm] = at.split(':').map(Number);
                expect(bellsAt(hh % 24, mm), `${at} in the ${watch}`).toBe(bells);
            }
        }
    });

    it('ends the day at 24:00, not 00:00', () => {
        expect(bellTime('First Watch', 8)).toBe('24:00');
    });
});
