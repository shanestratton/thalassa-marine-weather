/**
 * sereneSailing — the ported Serene Summer sailing brain.
 *
 * These pin the HANDOVER's do-not-remove invariants (see the module header):
 * the downwind refusal, the wide dead bands, the discrete car, and the
 * runners rule — plus the band arithmetic that picks sail plans.
 */
import { describe, expect, it } from 'vitest';
import {
    CAR,
    HEEL_POSITIVE_IS_STBD,
    KITE,
    SAILPLAN,
    heelBand,
    helmBalance,
    helmVerdict,
    kiteAdvice,
    reefDescribe,
    sailPlanFor,
    shoalRate,
    trueWindFrom,
    type SailingWind,
} from '../services/sailing/sereneSailing';

const wind = (over: Partial<SailingWind> = {}): SailingWind => ({
    awa: 40,
    aws: 15,
    twa: 45,
    tws: 14,
    sog: 6.5,
    stw: 6.8,
    hdg: 30,
    helm: { mean: 2, max: 4, activity: 1 },
    ...over,
});

describe('helmBalance — the do-not-remove gates', () => {
    it('refuses without way on, without wind, or without an angle', () => {
        expect(helmBalance(wind({ sog: 0.5, stw: 0.8 }))).toMatchObject({ ok: false });
        expect(helmBalance(wind({ aws: 3 }))).toMatchObject({ ok: false });
        expect(helmBalance(wind({ awa: null }))).toMatchObject({ ok: false });
        expect(helmBalance(null)).toBeNull();
        expect(helmBalance(wind({ helm: null }))).toBeNull();
    });

    it('REFUSES to judge downwind (off < 70) — the mean averages to zero in a quartering sea', () => {
        const verdict = helmBalance(wind({ twa: 150, awa: 150 }));
        expect(verdict).toMatchObject({ ok: false, downwind: true });
        expect((verdict as { why: string }).why).toContain('off the wind');
    });

    it('the dead bands are wide on purpose — 1.2° of sensor zero raises no alarm', () => {
        // Wind on starboard (awa 40): weather helm = -mean. mean -2 → wh 2 → balanced.
        const balanced = helmBalance(wind({ helm: { mean: -2, max: 3, activity: 1 } }));
        expect(balanced).toMatchObject({ ok: true, state: 'balanced' });
    });

    it('grades weather helm by tack-corrected sign with plain-words advice', () => {
        // Wind on starboard: mean -9 → wh 9 → serious over.
        const over = helmBalance(wind({ helm: { mean: -9, max: 12, activity: 2 } }));
        expect(over).toMatchObject({ ok: true, state: 'over', level: 'serious', tack: 'starboard' });
        expect((over as { fix: string }).fix).toContain('87°');

        // Wind on port (awa 320): mean -3 → wh -3 → lee helm warning.
        const under = helmBalance(wind({ awa: 320, twa: 315, helm: { mean: -3, max: 4, activity: 1 } }));
        expect(under).toMatchObject({ ok: true, state: 'under', level: 'warning', tack: 'port' });
    });
});

describe('helmVerdict and heelBand wording', () => {
    it('speaks the boat plainly', () => {
        expect(helmVerdict(0.5).word).toBe('Balanced');
        expect(helmVerdict(6).note).toContain('asking for a reef');
        expect(helmVerdict(10).word).toBe('Fighting her');
        expect(heelBand(15).word).toBe('Working');
        expect(heelBand(35).word).toBe('Reef her');
    });
});

describe('sailPlanFor — band and gust row selection', () => {
    it('selects by degrees off the wind with gust-exclusive upper bounds', () => {
        const beat = sailPlanFor(15, 40)!;
        expect(beat.band.band).toBe('Beating');
        expect(beat.row.main).toBe(beat.band.rows.find((r) => 15 < r.to)!.main);

        const run = sailPlanFor(25, 170)!;
        expect(run.band.band).toBe('Running');

        // 350° twa = 10° off the wind → head to wind, clamps to Beating.
        expect(sailPlanFor(10, 350)!.headToWind).toBe(true);
    });

    it('every staysail row demands the runners — rigging, not preference', () => {
        for (const band of SAILPLAN as Array<{ rows: Array<{ stay: unknown; runners?: boolean }> }>) {
            for (const row of band.rows) {
                if (row.stay === true || row.stay === 'storm') {
                    expect(row.runners).toBe(true);
                }
            }
        }
    });

    it('the yankee car stays discrete — three positions, set-and-forget', () => {
        expect(Object.keys(CAR).sort()).toEqual(['full', 'rolled', 'set']);
    });
});

describe('reefDescribe', () => {
    it('speaks the Leisure Furl language — battens, not slab reefs', () => {
        const beat = sailPlanFor(20, 45)!;
        const words = reefDescribe(beat.row, false);
        expect(`${words.m} ${words.rest}`.toLowerCase()).toMatch(/batten|full main/);
    });
});

describe('kiteAdvice', () => {
    it('never at night, never above the shorthanded gust ceiling, never at the wrong angle', () => {
        expect(kiteAdvice(10, 100, true)!.ok).toBe(false);
        expect(kiteAdvice(KITE.gustMax + 3, 100, false)!.ok).toBe(false);
        expect(kiteAdvice(10, 170, false)!.why).toContain('Wrong angle');
        const go = kiteAdvice(12, 100, false)!;
        expect(go.ok).toBe(true);
        expect(go.down).toContain('FIRST THOUGHT');
    });
});

describe('shoalRate', () => {
    const now = 1_000_000_000_000;
    const track = (slopePerMin: number, start = 20) =>
        Array.from({ length: 10 }, (_, i) => ({
            t: now / 1000 - (9 - i) * 30,
            d: start + slopePerMin * ((i - 9) * 0.5) * -1 * -1,
        })).map((p, i) => ({ t: p.t, d: start + slopePerMin * ((i * 30) / 60) }));

    it('is honest about a thin trace and projects keel-down time when shoaling', () => {
        expect(shoalRate([], 0, now).text).toBe('—');
        expect(shoalRate(track(0), 0, now).text).toBe('Steady');
        expect(shoalRate(track(0.5), 0, now).text).toContain('Deepening');
        const shoaling = shoalRate(track(-1.5, 10), -1.46, now);
        expect(shoaling.text).toContain('Shoaling');
        expect(shoaling.note).toContain('keel down in about');
    });
});

describe('trueWindFrom', () => {
    it('recovers true wind from apparent and boat speed', () => {
        // Dead run check: apparent aft, boat speed subtracts.
        const run = trueWindFrom(180, 10, 5)!;
        expect(run.tws).toBeCloseTo(15, 0);
        expect(Math.round(run.twa)).toBe(180);
    });
});

describe('handover carriage', () => {
    it('the unverified heel sign keeps its CHECK ON THE FIRST BEAT comment', () => {
        expect(HEEL_POSITIVE_IS_STBD).toBe(true);
        const { readFileSync } = require('node:fs') as typeof import('node:fs');
        const { resolve } = require('node:path') as typeof import('node:path');
        const src = readFileSync(resolve(process.cwd(), 'services/sailing/sereneSailing.ts'), 'utf8');
        expect(src).toContain('CHECK ON THE FIRST BEAT');
        expect(src).toContain('DEPTH_MEASURED_OFFSET = -1.46');
    });
});
