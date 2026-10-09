/**
 * Moving the mark of a watch the PI keeps (126-07a): the guards, as one pure
 * judgement (services/anchorPiMove.ts). The Move anchor sheet asks it live and
 * the keeper asks it again before anything is sent; the keeper is the authority.
 *
 * All must hold:
 *  (a) the Pi's latest fix of the boat is no more than 30 s old;
 *  (b) the Pi reports no alarm: no drag, no lost GPS;
 *  (c) the boat is inside the swing circle around the NEW point;
 *  (d) the NEW point is within the rode's reach, √(rode² − depth²) plus
 *      15 m or the fix accuracy if larger, of where the Pi's watch was FIRST
 *      set. An assignment with no rode or depth (an older Pi) uses the swing
 *      radius instead. (d) stops a mark being walked across the bay behind a
 *      slow drag, one move at a time.
 *
 * Fictional, global fixtures: off Horta in the Azores (west longitudes), off
 * Taveuni in Fiji astride 180°, and off Lyttelton in New Zealand.
 */
import { describe, expect, it } from 'vitest';
import { calculateDistance, destinationPoint } from '../utils/navigationCalculations';
import { judgePiMove, piAnchorMatches, piFixIsFresh, type PiMoveInput } from '../services/anchorPiMove';

type LatLon = { latitude: number; longitude: number };

const NOW = Date.parse('2026-10-10T03:00:00Z');

/** A point `metres` from `from` on a true bearing, wrapped into ±180°. */
function toward(from: LatLon, bearingDeg: number, metres: number): LatLon {
    const p = destinationPoint(from.latitude, from.longitude, bearingDeg, metres / 1852);
    return { latitude: p.lat, longitude: p.lon };
}
const metres = (a: LatLon, b: LatLon) => calculateDistance(a.latitude, a.longitude, b.latitude, b.longitude) * 1852;

// Off Horta: 40 m of rode in 8 m (a 39.2 m reach), a 45 m circle.
const HORTA: LatLon = { latitude: 38.53, longitude: -28.62 };
const REACH = Math.sqrt(40 ** 2 - 8 ** 2);

function horta(overrides: Partial<PiMoveInput> = {}): PiMoveInput {
    // She lies 30 m south-west of where the watch was set; the mark goes 25 m out the same way.
    const boat = toward(HORTA, 220, 30);
    return {
        now: NOW,
        boatFix: { ...boat, timestamp: NOW - 5_000 },
        alarm: false,
        gpsLost: false,
        target: toward(HORTA, 220, 25),
        swingRadiusM: 45,
        centreAtSet: HORTA,
        rodeLength: 40,
        waterDepth: 8,
        ...overrides,
    };
}

describe('judgePiMove', () => {
    it('accepts a move inside every guard', () => {
        expect(REACH).toBeCloseTo(39.2, 1);
        expect(judgePiMove(horta())).toEqual({ ok: true });
    });

    it('refuses a fix 31 s old: an old fix cannot vouch for where she is', () => {
        const fix = horta().boatFix!;
        const verdict = judgePiMove(horta({ boatFix: { ...fix, timestamp: NOW - 31_000 } }));
        expect(verdict).toMatchObject({ ok: false, refusal: 'no-fix' });
        expect(judgePiMove(horta({ boatFix: { ...fix, timestamp: NOW - 30_000 } })).ok).toBe(true);
        expect(judgePiMove(horta({ boatFix: null }))).toMatchObject({ ok: false, refusal: 'no-fix' });
    });

    it('refuses while the Pi reports a drag alarm', () => {
        const verdict = judgePiMove(horta({ alarm: true }));
        expect(verdict).toMatchObject({ ok: false, refusal: 'alarm' });
        if (verdict.ok) throw new Error('accepted');
        expect(verdict.error.startsWith(verdict.lead)).toBe(true);
        expect(verdict.error).toMatch(/re-anchor/i);
    });

    it('refuses while the Pi has lost the boat’s GPS', () => {
        expect(judgePiMove(horta({ gpsLost: true }))).toMatchObject({ ok: false, refusal: 'gps-lost' });
    });

    it('refuses a point that would leave the boat outside the new circle', () => {
        // 50 m past the boat: 80 m from where the watch was set, and 50 m from her.
        const verdict = judgePiMove(horta({ target: toward(HORTA, 220, 80), swingRadiusM: 45 }));
        // In words for any way the point was given: no bearing field on the Position tab.
        expect(verdict).toMatchObject({
            ok: false,
            refusal: 'outside',
            error: expect.stringMatching(/Check where you put the anchor\.$/),
        });
    });

    it('refuses a point more than the rode’s reach plus 15 m from where the watch was set', () => {
        // The boat is 30 m out; a point 55 m out is 25 m from her (inside the circle)
        // but 55 m from the first centre, past 39.2 + 15 = 54.2 m.
        const beyond = toward(HORTA, 220, 55);
        expect(metres(beyond, horta().boatFix!)).toBeLessThan(45);
        const verdict = judgePiMove(horta({ target: beyond }));
        expect(verdict).toMatchObject({ ok: false, refusal: 'beyond-rode' });
        if (verdict.ok) throw new Error('accepted');
        expect(verdict.lead).toMatch(/beyond your rode.s reach from where the watch was set/i);
        // 54 m is inside the reach and its slack.
        expect(judgePiMove(horta({ target: toward(HORTA, 220, 54) })).ok).toBe(true);
    });

    it('measures the reach from where the watch was FIRST set, not from the mark as it is now', () => {
        // Moved once already, 30 m out; a second 25 m step the same way is 55 m
        // from the first centre: the slow walk (d) is there to stop.
        const verdict = judgePiMove(
            horta({ centreAtSet: HORTA, target: toward(HORTA, 220, 55), boatFix: horta().boatFix }),
        );
        expect(verdict).toMatchObject({ ok: false, refusal: 'beyond-rode' });
    });

    it('a fix less accurate than 15 m widens the slack to its accuracy', () => {
        const fix = { ...horta().boatFix!, accuracy: 20 };
        // 58 m out: past 54.2, inside 39.2 + 20 = 59.2.
        expect(judgePiMove(horta({ boatFix: fix, target: toward(HORTA, 220, 58) })).ok).toBe(true);
        expect(judgePiMove(horta({ target: toward(HORTA, 220, 58) })).ok).toBe(false);
    });

    it('refuses NaN anywhere: every comparison is written so NaN fails it', () => {
        const fix = horta().boatFix!;
        for (const input of [
            horta({ target: { latitude: Number.NaN, longitude: -28.62 } }),
            horta({ target: { latitude: 38.53, longitude: Number.NaN } }),
            horta({ boatFix: { ...fix, timestamp: Number.NaN } }),
            horta({ boatFix: { ...fix, latitude: Number.NaN } }),
            horta({ swingRadiusM: Number.NaN }),
            horta({ centreAtSet: { latitude: Number.NaN, longitude: -28.62 } }),
            horta({ rodeLength: Number.NaN }),
            horta({ now: Number.NaN }),
        ]) {
            expect(judgePiMove(input).ok).toBe(false);
        }
        expect(judgePiMove(horta({ centreAtSet: null })).ok).toBe(false);
        expect(judgePiMove(horta({ target: { latitude: 91, longitude: 0 } })).ok).toBe(false);
    });

    it('accepts a move across the antimeridian off Taveuni, Fiji', () => {
        // Set at 179.9999°E, moved 32 m east to 179.9998°W.
        const setAt = { latitude: -16.8, longitude: 179.9999 };
        const target = { latitude: -16.8, longitude: -179.9998 };
        expect(metres(setAt, target)).toBeCloseTo(32, 0);
        const boat = toward(target, 270, 20);
        const verdict = judgePiMove({
            now: NOW,
            boatFix: { ...boat, timestamp: NOW - 2_000 },
            alarm: false,
            gpsLost: false,
            target,
            swingRadiusM: 45,
            centreAtSet: setAt,
            rodeLength: 40,
            waterDepth: 8,
        });
        expect(verdict).toEqual({ ok: true });
    });

    it('with no rode or depth from an older Pi, the swing radius stands in for the reach', () => {
        // 58 m out: past the rode's 54.2 m, inside the 45 m circle's 45 + 15 = 60 m.
        const target = toward(HORTA, 220, 58);
        const boat = toward(HORTA, 220, 40);
        const base = horta({ target, boatFix: { ...boat, timestamp: NOW - 5_000 } });
        expect(judgePiMove(base)).toMatchObject({ ok: false, refusal: 'beyond-rode' });
        const older = { ...base, rodeLength: undefined, waterDepth: undefined };
        expect(judgePiMove(older)).toEqual({ ok: true });
        // …and past 60 m it refuses, saying the circle, not a rode it never had.
        const further = judgePiMove({ ...older, target: toward(HORTA, 220, 61) });
        expect(further).toMatchObject({ ok: false, refusal: 'beyond-circle' });
        if (further.ok) throw new Error('accepted');
        expect(further.lead).not.toMatch(/rode/i);
    });

    it('off Lyttelton, south of 40°S, the same rules in the same words', () => {
        const setAt = { latitude: -43.61, longitude: 172.72 };
        const boat = toward(setAt, 300, 28);
        const verdict = judgePiMove({
            now: NOW,
            boatFix: { ...boat, timestamp: NOW - 1_000 },
            alarm: false,
            gpsLost: false,
            target: toward(setAt, 300, 12),
            swingRadiusM: 38,
            centreAtSet: setAt,
            rodeLength: 35,
            waterDepth: 6,
        });
        expect(verdict.ok).toBe(true);
    });
});

describe('piAnchorMatches', () => {
    it('is the Pi’s report of the anchor within 1 m of the point sent, across 180° too', () => {
        expect(piAnchorMatches(HORTA, HORTA)).toBe(true);
        expect(piAnchorMatches(toward(HORTA, 90, 0.8), HORTA)).toBe(true);
        expect(piAnchorMatches(toward(HORTA, 90, 1.5), HORTA)).toBe(false);
        expect(piAnchorMatches({ latitude: -16.8, longitude: 180 }, { latitude: -16.8, longitude: -180 })).toBe(true);
        expect(piAnchorMatches(null, HORTA)).toBe(false);
        expect(piAnchorMatches({ latitude: Number.NaN, longitude: 0 }, HORTA)).toBe(false);
    });
});

describe('piFixIsFresh: guard (a) alone, which Shore Watch offers the chip by', () => {
    it('is a fix on the globe no more than 30 s old, or ahead of this clock', () => {
        const fix = (ageMs: number) => ({ ...HORTA, timestamp: NOW - ageMs });
        expect(piFixIsFresh(fix(29_000), NOW)).toBe(true);
        expect(piFixIsFresh(fix(30_000), NOW)).toBe(true);
        expect(piFixIsFresh(fix(31_000), NOW)).toBe(false);
        expect(piFixIsFresh(fix(-31_000), NOW)).toBe(false);
        expect(piFixIsFresh({ ...fix(0), timestamp: Number.NaN }, NOW)).toBe(false);
        expect(piFixIsFresh({ latitude: 91, longitude: 0, timestamp: NOW }, NOW)).toBe(false);
        expect(piFixIsFresh(null, NOW)).toBe(false);
        expect(piFixIsFresh(undefined, NOW)).toBe(false);
        // Off Taveuni, astride 180°.
        expect(piFixIsFresh({ latitude: -16.8, longitude: 180, timestamp: NOW }, NOW)).toBe(true);
    });

    it('says the same as judgePiMove’s own fix guard', () => {
        for (const age of [0, 29_000, 30_000, 30_001, 31_000, -30_001]) {
            const input = horta({ boatFix: { ...toward(HORTA, 220, 30), timestamp: NOW - age } });
            const judged = judgePiMove(input);
            expect(judged.ok || judged.refusal !== 'no-fix').toBe(piFixIsFresh(input.boatFix, NOW));
        }
    });
});
