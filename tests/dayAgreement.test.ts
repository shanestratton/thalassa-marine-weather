/**
 * Model agreement by the location's own day (build 123, W1-09).
 *
 * One thresholds module serves the Glass day cards' agreement chip AND the
 * ten-day comparison's day bars, so the chip can never say "Models agree"
 * over a bar that says otherwise. Wind only in 123: the spread of each
 * model's strongest sustained wind that day (agree below max(4 kt, 20 %),
 * split above max(8 kt, 40 %)), and the direction spread wherever the
 * models' median wind is 8 kt or more.
 *
 * Fictional numbers throughout, on the seven comparison models, at places
 * round the world: the Med, the Caribbean, the Pacific, the North Sea, a US
 * coast, Newfoundland's half-hour zone and Queensland.
 */
import { describe, expect, it } from 'vitest';
import { COMPARE_MODELS } from '../services/weather/forecastModels';
import {
    AGREEMENT_WORDS,
    SPREAD_THRESHOLDS,
    classifySpread,
    localDayStarts,
    verdictAt,
    windAgreementByDay,
    windAgreementForDays,
    type WindDayVerdict,
} from '../services/weather/dayAgreement';
import { agreementByDay } from '../components/dashboard/ModelComparisonMatrix';

const H = 3_600_000;
type Fn = (k: number, i: number, t: number) => number | null;

/** A ten-day answer from the seven comparison models (COMPARE_MODELS order:
 *  ICON, ECMWF, AIFS, UKMO, JMA, GFS, GEM), each value a function of the
 *  model's index k, the hour index i and the hour's epoch ms t. */
function blockOf(t0: number, hours: number, speed: Fn, dir: Fn = () => 220) {
    const times = Array.from({ length: hours }, (_, i) => t0 + i * H);
    return {
        times,
        models: COMPARE_MODELS.map((m, k) => ({
            id: m.id,
            label: m.label,
            provider: m.provider,
            hex: m.hex,
            values: {
                wind_speed_10m: times.map((t, i) => speed(k, i, t)),
                wind_direction_10m: times.map((t, i) => dir(k, i, t)),
            },
        })),
    } as never;
}

/** The hour of day on the place's own clock. */
const hourIn = (t: number, timeZone: string) =>
    Number(new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hourCycle: 'h23' }).format(t));

const byDate = (verdicts: WindDayVerdict[], date: string) => verdicts.find((v) => v.date === date)!;

describe('the thresholds module both the chip and the comparison read', () => {
    it('wind: agree below max(4 kt, 20 %), split above max(8 kt, 40 %) of the median', () => {
        expect(classifySpread('wind', 3.9, 10)).toBe('agree');
        expect(classifySpread('wind', 4, 10)).toBe('some');
        expect(classifySpread('wind', 8, 10)).toBe('some');
        expect(classifySpread('wind', 8.1, 10)).toBe('split');
        // A gale: 20 % of 35 kt is 7 kt and 40 % is 14 kt, so a 6 kt spread
        // in 35 kt is agreement where the same 6 kt in a 10 kt breeze is not.
        expect(classifySpread('wind', 6.9, 35)).toBe('agree');
        expect(classifySpread('wind', 7, 35)).toBe('some');
        expect(classifySpread('wind', 14, 35)).toBe('some');
        expect(classifySpread('wind', 14.1, 35)).toBe('split');
        expect(classifySpread('wind', 6, 10)).toBe('some');
    });

    it('direction and the comparison’s other metrics are absolute, as the comparison had them', () => {
        expect(classifySpread('dir', 19.9)).toBe('agree');
        expect(classifySpread('dir', 45)).toBe('some');
        expect(classifySpread('dir', 45.1)).toBe('split');
        expect(SPREAD_THRESHOLDS.gust).toEqual({ agree: 5, split: 10 });
        expect(SPREAD_THRESHOLDS.wave).toEqual({ agree: 0.3, split: 0.8 });
        expect(SPREAD_THRESHOLDS.pressure).toEqual({ agree: 2, split: 5 });
        // A reference value changes nothing where there is no relative rule.
        expect(classifySpread('wave', 0.5, 100)).toBe('some');
    });

    it('has one set of words for the three verdicts', () => {
        expect(AGREEMENT_WORDS).toEqual({ agree: 'Models agree', some: 'Some spread', split: 'Models split' });
    });
});

describe('windAgreementByDay — the location’s own days', () => {
    it('cuts the answer at the Med’s own midnights, the clocks-back day 25 hours long (Marseille)', () => {
        // 14:00 CEST on Tue 20 Oct; France goes back an hour on Sun 25 Oct.
        const t0 = Date.UTC(2026, 9, 20, 12);
        const verdicts = windAgreementByDay(
            blockOf(t0, 240, (k) => 12 + 0.5 * k),
            'Europe/Paris',
        );
        expect(verdicts.map((v) => v.date)).toEqual([
            '2026-10-20',
            '2026-10-21',
            '2026-10-22',
            '2026-10-23',
            '2026-10-24',
            '2026-10-25',
            '2026-10-26',
            '2026-10-27',
            '2026-10-28',
            '2026-10-29',
            '2026-10-30',
        ]);
        const sunday = byDate(verdicts, '2026-10-25');
        expect(sunday.end - sunday.start).toBe(25);
        expect(hourIn(sunday.startMs, 'Europe/Paris')).toBe(0);
        // Today runs from now and the last day stops at 240 h: neither is a
        // whole day, so neither can stand for one.
        expect(verdicts.map((v) => v.whole)).toEqual([
            false,
            true,
            true,
            true,
            true,
            true,
            true,
            true,
            true,
            true,
            false,
        ]);
        // 3 kt between the seven, in a 13 kt breeze.
        expect(verdicts.every((v) => v.level === 'agree' && v.members === 7)).toBe(true);
    });

    it('judges the day by each model’s strongest hour, not by when it comes (BVI)', () => {
        // Midnight in the BVI (UTC−4), so today is whole too. Every model
        // peaks at 25 kt, an hour later each; on Sat 10 Oct GFS peaks at 37.
        const t0 = Date.UTC(2026, 9, 8, 4);
        const tz = 'America/Tortola';
        const verdicts = windAgreementByDay(
            blockOf(t0, 240, (k, i, t) => {
                const peak = hourIn(t, tz) === 12 + k;
                if (!peak) return 15;
                return k === 5 && i >= 48 && i < 72 ? 37 : 25;
            }),
            tz,
        );
        expect(verdicts[0]).toMatchObject({ date: '2026-10-08', whole: true, level: 'agree', speedSpread: 0 });
        expect(byDate(verdicts, '2026-10-09')).toMatchObject({ level: 'agree', speedSpread: 0, speedMedian: 25 });
        // 12 kt apart at a 25 kt median: past both 8 kt and 40 %.
        expect(byDate(verdicts, '2026-10-10')).toMatchObject({
            level: 'split',
            speedLevel: 'split',
            driver: 'wind',
            speedSpread: 12,
            speedRange: [25, 37],
        });
    });

    it('calls 35–41 kt agreement in a gale, where 6 kt in a breeze is spread (North Sea)', () => {
        // German Bight, Europe/Berlin.
        const t0 = Date.UTC(2026, 9, 7, 22); // midnight CEST
        const gale = windAgreementByDay(
            blockOf(t0, 72, (k) => 35 + k),
            'Europe/Berlin',
        );
        expect(gale[0]).toMatchObject({ level: 'agree', speedSpread: 6, speedMedian: 38 });
        const breeze = windAgreementByDay(
            blockOf(t0, 72, (k) => 10 + k),
            'Europe/Berlin',
        );
        expect(breeze[0]).toMatchObject({ level: 'some', speedSpread: 6 });
    });

    it('splits on direction in a breeze, and ignores direction in light airs (Cape Cod)', () => {
        // Midnight EDT on Thu 8 Oct, off Cape Cod.
        const t0 = Date.UTC(2026, 9, 8, 4);
        const tz = 'America/New_York';
        const day = (i: number) => Math.floor(i / 24);
        const verdicts = windAgreementByDay(
            blockOf(
                t0,
                120,
                (k, i, t) => {
                    if (day(i) === 2) return 4; // light airs all day
                    // Day 3: light, but for two hours of breeze.
                    if (day(i) === 3) return [10, 11].includes(hourIn(t, tz)) ? 12 : 4;
                    return 16;
                },
                (k, i) => {
                    if (day(i) === 0) return 200 + k; // within 6°
                    return 180 + 15 * k; // 90° from first to last
                },
            ),
            tz,
        );
        expect(verdicts[0]).toMatchObject({ level: 'agree', dirLevel: 'agree', dirHours: 24 });
        // The same speed everywhere: direction alone splits the day.
        expect(verdicts[1]).toMatchObject({
            level: 'split',
            speedLevel: 'agree',
            dirLevel: 'split',
            driver: 'dir',
            dirSpread: 90,
        });
        // Under 8 kt a model's direction is noise: not judged at all.
        expect(verdicts[2]).toMatchObject({ level: 'agree', dirLevel: null, dirHours: 0, driver: 'wind' });
        // Two hours of breeze are not a direction to agree on.
        expect(verdicts[3]).toMatchObject({ dirLevel: null, dirHours: 2 });
    });
});

describe('members: fewer models reach the late days, and the count says so', () => {
    // Each model's run ends where it did through the proxy at Fiji on
    // 2026-10-07: UKMO after 155 h, ICON after 167 h, GEM after 227 h.
    const LAST: Record<string, number> = {
        ukmo_global_deterministic_10km: 154,
        dwd_icon: 166,
        gem_seamless: 226,
    };
    const ends = (k: number, i: number, v: number) => (i > (LAST[COMPARE_MODELS[k].id] ?? 239) ? null : v);
    const t0 = Date.UTC(2026, 9, 7, 14); // 02:00 on 8 Oct in Fiji (UTC+12)

    it('counts only the models that cover every hour of the day, and marks the late days thin (Fiji)', () => {
        const verdicts = windAgreementByDay(
            blockOf(t0, 240, (k, i) => ends(k, i, 14 + 0.5 * k)),
            'Pacific/Fiji',
        );
        const members = verdicts.map((v) => v.members);
        // Today is partial but every model covers it; a model whose run ends
        // during a day does not count for that day.
        expect(members).toEqual([7, 7, 7, 7, 7, 7, 6, 5, 5, 4, 4]);
        expect(verdicts.map((v) => v.thin)).toEqual([
            false,
            false,
            false,
            false,
            false,
            false,
            false,
            false,
            false,
            true,
            true,
        ]);
        expect(verdicts.every((v) => v.peak === 7)).toBe(true);
    });

    it('never calls a day with one model agreement (Fiji, one model left)', () => {
        const verdicts = windAgreementByDay(
            blockOf(t0, 240, (k, i) => (k === 1 || i < 100 ? 14 : null)),
            'Pacific/Fiji',
        );
        const last = verdicts[verdicts.length - 2];
        expect(last).toMatchObject({ members: 1, level: null, speedLevel: null, dirLevel: null, driver: null });
        expect(verdicts.some((v) => v.members < 2 && v.level !== null)).toBe(false);
    });
});

describe('verdictAt — the Glass row finds its own day', () => {
    it('maps the Whitsundays’ local noon to that day, whatever the phone’s clock', () => {
        const t0 = Date.UTC(2026, 9, 7, 20); // 06:00 on 8 Oct in Queensland
        const verdicts = windAgreementByDay(
            blockOf(t0, 240, (k) => 18 + k),
            'Australia/Brisbane',
        );
        expect(verdictAt(verdicts, Date.parse('2026-10-10T12:00:00+10:00'))?.date).toBe('2026-10-10');
        expect(verdictAt(verdicts, Date.parse('2026-10-08T05:00:00+10:00'))).toBeNull(); // before the answer
        expect(verdictAt(verdicts, Date.parse('2026-10-30T12:00:00+10:00'))).toBeNull();
    });

    it('finds the half-hour zone’s days (Newfoundland, UTC−2:30)', () => {
        const t0 = Date.UTC(2026, 9, 8, 3); // 00:30 NDT on 8 Oct
        const starts = localDayStarts(
            Array.from({ length: 72 }, (_, i) => t0 + i * H),
            'America/St_Johns',
        );
        expect(starts).toEqual([24, 48]);
        const verdicts = windAgreementByDay(
            blockOf(t0, 72, () => 12),
            'America/St_Johns',
        );
        expect(verdicts.map((v) => v.date)).toEqual(['2026-10-08', '2026-10-09', '2026-10-10']);
    });
});

describe('the comparison’s WIND and DIR day bars are the chip’s own verdicts', () => {
    const series = (values: (k: number, i: number) => number | null, n = 7) =>
        Array.from({ length: n }, (_, k) => ({
            id: COMPARE_MODELS[k].id,
            label: COMPARE_MODELS[k].label,
            provider: COMPARE_MODELS[k].provider,
            hex: COMPARE_MODELS[k].hex,
            values: Array.from({ length: 72 }, (_, i) => values(k, i)),
        }));

    it('rates the gale the chip calls agreement as agreement on the WIND tab', () => {
        const gale = series((k) => 35 + k);
        const bars = agreementByDay(gale, [24, 48], 72, 'wind');
        const chip = windAgreementForDays(gale, [], [24, 48], 72);
        expect(chip.map((d) => d.speedLevel)).toEqual(['agree', 'agree', 'agree']);
        expect(bars.map((d) => d.level)).toEqual(['high', 'high', 'high']);
    });

    it('rates direction only where the breeze is up, on the DIR tab as on the chip', () => {
        const speeds = series((k, i) => (i < 24 ? 16 : 3));
        const dirs = series((k) => 180 + 15 * k);
        const chip = windAgreementForDays(speeds, dirs, [24, 48], 72);
        const bars = agreementByDay(dirs, [24, 48], 72, 'dir', speeds);
        expect(chip.map((d) => d.dirLevel)).toEqual(['split', null, null]);
        expect(bars.map((d) => d.level)).toEqual(['low', 'none', 'none']);
        expect(bars[1]).toMatchObject({ calm: true, members: 7 });
    });
});
