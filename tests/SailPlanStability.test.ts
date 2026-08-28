/**
 * Shane 2026-08-28, aged nearly sixty: "we need to make it so that we dont
 * need to change the sail layout every 5 seconds… unless it actually requires
 * a sail to go down or up, then i think we should be a little more lenient. i
 * dont want to have to be running around like a blue assed fly trying to keep
 * the boat trimmed perfectly."
 *
 * `sailPlanFor` is pure and has hard edges. A 26-tonne cutter yaws several
 * degrees on every wave, so the true wind angle crossed a band edge
 * constantly and the advice flipped with it. The advice was never wrong — it
 * was being asked the question far too often.
 *
 * The asymmetry below is seamanship, not tuning: quick to call for less sail,
 * slow to call for more, slowest of all for a change that moves no sail.
 */
import { describe, expect, it } from 'vitest';
import {
    EASE_DWELL_MS,
    REDUCE_DWELL_MS,
    TRIM_DWELL_MS,
    movesASail,
    sailAreaRank,
    sailPlanFor,
    stabiliseSailPlan,
    type SailPlanHold,
} from '../services/sailing/sereneSailing';

const T0 = 1_700_000_000_000;
/** Beating is [30,55); its rows step at 12/18/23/28/36/45. */
const BEAT = 45;
const step = (hold: SailPlanHold | null, gust: number, twa: number, at: number) =>
    stabiliseSailPlan(hold, gust, twa, at) as SailPlanHold;

describe('sailAreaRank', () => {
    it('ranks the reefing ladder in the order a sail actually comes down', () => {
        const rank = (main: string, yankee: string) => sailAreaRank({ to: 0, main, yankee, stay: false, note: '' });
        expect(rank('Full', 'Full')).toBeGreaterThan(rank('Reef 1', 'Full'));
        expect(rank('Reef 1', 'Full')).toBeGreaterThan(rank('Reef 2', 'Rolled to two-thirds'));
        expect(rank('Reef 2', 'Rolled to two-thirds')).toBeGreaterThan(rank('Reef 3', 'Furled'));
        expect(rank('Reef 3', 'Furled')).toBeGreaterThan(rank('Down', 'Furled'));
    });

    it('ignores the staysail, which is a balance sail and not a reefing step', () => {
        const base = { to: 0, main: 'Full', yankee: 'Full', note: '' };
        expect(sailAreaRank({ ...base, stay: false })).toBe(sailAreaRank({ ...base, stay: true }));
    });
});

describe('movesASail', () => {
    it('is true when the staysail goes up, even with main and yankee unchanged', () => {
        const a = { to: 0, main: 'Full', yankee: 'Full', stay: false as const, note: '' };
        expect(movesASail(a, { ...a, stay: true })).toBe(true);
    });

    it('is false when only the band and its trim differ', () => {
        const a = { to: 0, main: 'Full', yankee: 'Full', stay: true as const, note: '' };
        expect(movesASail(a, { ...a, to: 99, note: 'different prose' })).toBe(false);
    });
});

describe('holding a plan', () => {
    it('adopts the first answer immediately — there is nothing to be stable about yet', () => {
        const hold = step(null, 15, BEAT, T0);
        expect(hold.plan.band.band).toBe('Beating');
        expect(hold.plan.row.to).toBe(18);
        expect(hold.pending).toBeNull();
    });

    it('returns null while there is no wind to reason from', () => {
        expect(stabiliseSailPlan(null, null, BEAT, T0)).toBeNull();
        expect(stabiliseSailPlan(null, 15, null, T0)).toBeNull();
    });

    it('does not flicker when she breathes across a band edge', () => {
        // Beating ends at 55. A yaw to 58 is not a change of point of sail,
        // it is a wave.
        let hold = step(null, 15, 54, T0);
        for (let i = 1; i <= 40; i++) {
            hold = step(hold, 15, i % 2 ? 58 : 53, T0 + i * 5_000);
        }
        expect(hold.plan.band.band).toBe('Beating');
        expect(hold.pending).toBeNull();
    });

    it('does not flicker when the gust proxy sits on a row edge', () => {
        // Row edge at 18 kt. 19 is not a new sail plan, it is a puff.
        let hold = step(null, 17, BEAT, T0);
        for (let i = 1; i <= 40; i++) {
            hold = step(hold, i % 2 ? 19 : 17, BEAT, T0 + i * 5_000);
        }
        expect(hold.plan.row.to).toBe(18);
    });
});

describe('calling for LESS sail', () => {
    it('waits, but not long — being overpowered is not something to sit on', () => {
        let hold = step(null, 15, BEAT, T0); // Full/Full
        // Genuine build, well past the row edge plus its margin.
        hold = step(hold, 25, BEAT, T0 + 1_000);
        expect(hold.plan.row.to).toBe(18); // not yet
        expect(hold.pending).not.toBeNull();

        hold = step(hold, 25, BEAT, T0 + 1_000 + REDUCE_DWELL_MS - 1);
        expect(hold.plan.row.to).toBe(18); // still holding

        hold = step(hold, 25, BEAT, T0 + 1_000 + REDUCE_DWELL_MS);
        expect(hold.plan.row.to).toBe(28);
        expect(sailAreaRank(hold.plan.row)).toBeLessThan(6);
        expect(hold.pending).toBeNull();
    });

    it('is quicker to reduce than to add — the asymmetry is the point', () => {
        expect(REDUCE_DWELL_MS).toBeLessThan(EASE_DWELL_MS);
        expect(EASE_DWELL_MS).toBeLessThan(TRIM_DWELL_MS);
    });
});

describe('calling for MORE sail', () => {
    it('is patient, because shaking out into a lull is the running about', () => {
        let hold = step(null, 25, BEAT, T0); // Reef 2 / rolled yankee
        expect(hold.plan.row.to).toBe(28);

        hold = step(hold, 10, BEAT, T0 + 1_000);
        expect(hold.plan.row.to).toBe(28);

        // A full minute of lull is not yet enough.
        hold = step(hold, 10, BEAT, T0 + 61_000);
        expect(hold.plan.row.to).toBe(28);

        hold = step(hold, 10, BEAT, T0 + 1_000 + EASE_DWELL_MS);
        expect(hold.plan.row.to).toBe(12);
        expect(sailAreaRank(hold.plan.row)).toBe(6);
    });

    it('restarts the clock if the lull turns into something else', () => {
        let hold = step(null, 25, BEAT, T0);
        hold = step(hold, 10, BEAT, T0 + 1_000); // pending: full sail
        const firstPending = hold.pending;
        expect(firstPending).not.toBeNull();

        hold = step(hold, 20, BEAT, T0 + 40_000); // now wanting something else
        expect(hold.pending?.since).toBe(T0 + 40_000);
        expect(hold.plan.row.to).toBe(28); // and still showing the held plan
    });

    it('forgets a pending change the moment she settles back where she was', () => {
        let hold = step(null, 25, BEAT, T0);
        hold = step(hold, 10, BEAT, T0 + 1_000);
        expect(hold.pending).not.toBeNull();

        hold = step(hold, 25, BEAT, T0 + 20_000);
        expect(hold.pending).toBeNull();
        expect(hold.plan.row.to).toBe(28);
    });
});

describe('a change that moves no sail at all', () => {
    it('waits longest — chasing the perfect car position is not practical sailing', () => {
        // Beating at 15 kt and Beam reach at 15 kt carry the SAME canvas:
        // full main, full yankee, staysail worth a try. Only the traveller
        // and car positions differ.
        const beating = sailPlanFor(15, BEAT);
        const beam = sailPlanFor(15, 85);
        expect(movesASail(beating!.row, beam!.row)).toBe(false);

        let hold = step(null, 15, BEAT, T0);
        hold = step(hold, 15, 85, T0 + 1_000);
        expect(hold.plan.band.band).toBe('Beating');

        hold = step(hold, 15, 85, T0 + 1_000 + EASE_DWELL_MS);
        expect(hold.plan.band.band).toBe('Beating'); // still — this is trim

        hold = step(hold, 15, 85, T0 + 1_000 + TRIM_DWELL_MS);
        expect(hold.plan.band.band).toBe('Beam reach');
    });
});

describe('what has NOT changed', () => {
    it('never edits the advice, only how often it is asked for', () => {
        // Every string is the handover's, verbatim. The stabiliser returns
        // rows straight out of SAILPLAN.
        const direct = sailPlanFor(25, BEAT);
        const held = step(null, 25, BEAT, T0);
        expect(held.plan.row).toBe(direct!.row);
        expect(held.plan.row.note).toBe(direct!.row.note);
    });
});
