/**
 * dayAgreement — how far apart the comparison models are, one local day at a
 * time, and the one set of thresholds that turns a spread into words (build
 * 123, W1-09).
 *
 * Shared by the Glass day cards' agreement chip and the ten-day comparison
 * (ModelComparisonMatrix): its WIND and DIR day bars are these verdicts, and
 * its other tabs and its headline read these thresholds. The chip can never
 * say "Models agree" over a bar that says otherwise.
 *
 * Wind only in 123:
 *   - Speed: the spread of each model's strongest sustained wind that day.
 *     Agree below max(4 kt, 20 % of the models' median), split above
 *     max(8 kt, 40 %): 6 kt apart is spread in a 10 kt breeze and agreement
 *     in a 35 kt gale.
 *   - Direction: the circular spread, only in the hours the models' median
 *     wind is 8 kt or more (a light-air direction is noise), and only when
 *     there are at least three such hours.
 *   The day's verdict is the worse of the two.
 *
 * Honest about members: a model counts for a day only when it has every hour
 * of it, so the count falls as the runs end (ICON and UKMO near day 7, GEM
 * near day 9.5). Once a day has fewer than the block's peak, the chip and the
 * sheet say "5 of 7 models"; a day with fewer than min(5, peak) members is
 * also "thin" and says "only 4 of 7". One model alone is never "agreement":
 * its verdict is null.
 *
 * Pure: no React, no fetch. Days are the location's own, so a clock change
 * gives a 23- or 25-hour day.
 */
import type { AtmosVar, SpreadBlock } from './ModelSpreadService';

export type AgreementLevel = 'agree' | 'some' | 'split';

/** The comparison's metric tabs (the Glass grid's metric ids). */
export type AgreementMetric =
    | 'wind'
    | 'dir'
    | 'gust'
    | 'wave'
    | 'period'
    | 'uv'
    | 'vis'
    | 'pressure'
    | 'humidity'
    | 'rain'
    | 'temp';

export interface SpreadThreshold {
    /** Agree below max(agree, agreeShare × reference). */
    agree: number;
    /** Split above max(split, splitShare × reference). */
    split: number;
    agreeShare?: number;
    splitShare?: number;
}

/**
 * Per metric, in the comparison's display units: kt, °, kt, m, s, hPa, °C,
 * %, mm, km, index. Only wind scales with its median; the rest are the
 * absolute spreads the comparison shipped with in W1-08.
 */
export const SPREAD_THRESHOLDS: Readonly<Record<AgreementMetric, SpreadThreshold>> = Object.freeze({
    wind: { agree: 4, split: 8, agreeShare: 0.2, splitShare: 0.4 },
    dir: { agree: 20, split: 45 },
    gust: { agree: 5, split: 10 },
    wave: { agree: 0.3, split: 0.8 },
    period: { agree: 1, split: 2.5 },
    pressure: { agree: 2, split: 5 },
    temp: { agree: 1.5, split: 3 },
    humidity: { agree: 8, split: 15 },
    rain: { agree: 0.5, split: 2 },
    vis: { agree: 2, split: 5 },
    uv: { agree: 1, split: 2 },
});

/** Direction is judged only where the models' median wind reaches this. */
export const DIR_MIN_MEDIAN_KT = 8;
/** …and only on a day with at least this many such hours. */
export const DIR_MIN_HOURS = 3;
/** Under this many members a day is "thin": fewer lines can only narrow the
 *  range, so a calm-looking day 9 may just be a day with fewer models. */
export const THIN_BELOW = 5;

export const AGREEMENT_WORDS: Readonly<Record<AgreementLevel, string>> = Object.freeze({
    agree: 'Models agree',
    some: 'Some spread',
    split: 'Models split',
});

/** A glyph per verdict (24-unit stroked paths), so colour is never the only
 *  difference: a tick, an approximately-equals, and a fork. */
export const AGREEMENT_GLYPH: Readonly<Record<AgreementLevel, string>> = Object.freeze({
    agree: 'M5 13l4 4L19 7',
    some: 'M5 9.5c2.3-2 4.7 2 7 0s4.7-2 7 0M5 15.5c2.3-2 4.7 2 7 0s4.7-2 7 0',
    split: 'M12 21v-7M12 14L6 5M12 14l6-9M6 5h3.5M6 5v3.5M18 5h-3.5M18 5v3.5',
});

const RANK: Record<AgreementLevel, number> = { agree: 0, some: 1, split: 2 };

/** The verdict for a spread; `reference` is the value the spread is of (the
 *  models' median) for the metrics that scale with it. */
export function classifySpread(metric: AgreementMetric, spread: number, reference = 0): AgreementLevel {
    const t = SPREAD_THRESHOLDS[metric];
    const ref = Math.abs(reference);
    const agreeBelow = Math.max(t.agree, (t.agreeShare ?? 0) * ref);
    const splitAbove = Math.max(t.split, (t.splitShare ?? 0) * ref);
    return spread < agreeBelow ? 'agree' : spread > splitAbove ? 'split' : 'some';
}

/** Max pairwise circular difference in degrees. */
export function circularSpread(vals: number[]): number {
    let max = 0;
    for (let i = 0; i < vals.length; i++) {
        for (let j = i + 1; j < vals.length; j++) {
            let d = Math.abs(vals[i] - vals[j]) % 360;
            if (d > 180) d = 360 - d;
            if (d > max) max = d;
        }
    }
    return max;
}

export function median(vals: number[]): number {
    const s = [...vals].sort((a, b) => a - b);
    const mid = s.length >> 1;
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** A calendar-date formatter on the location's clock; UTC if the zone is unknown here. */
function dayFormat(timeZone: string): Intl.DateTimeFormat {
    try {
        return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    } catch {
        return new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' });
    }
}

/** Indexes of the first hour of each new local day after the first, in the
 *  location's time zone, so a clock change gives a 23- or 25-hour day. */
export function localDayStarts(times: number[], timeZone: string): number[] {
    const day = dayFormat(timeZone);
    const starts: number[] = [];
    let prev = '';
    times.forEach((t, i) => {
        const d = day.format(t);
        if (i > 0 && d !== prev) starts.push(i);
        prev = d;
    });
    return starts;
}

/** One model's hourly values, in block order. */
export interface ModelValues {
    id: string;
    values: readonly (number | null)[];
}

export interface DayWindAgreement {
    /** The day's hours: [start, end) in the block. */
    start: number;
    end: number;
    /** Models with a value at every hour of the day. */
    members: number;
    /** The most members any day of the block had. */
    peak: number;
    /** Judged with fewer members than the block can field. */
    thin: boolean;
    /** Spread of the members' strongest sustained wind, kt; null under two members. */
    speedSpread: number | null;
    /** The members' weakest and strongest daily maximum, kt. */
    speedRange: [number, number] | null;
    speedMedian: number | null;
    speedLevel: AgreementLevel | null;
    /** Mean circular direction spread over the breezy hours, degrees. */
    dirSpread: number | null;
    /** Hours with the members' median wind at DIR_MIN_MEDIAN_KT or more. */
    dirHours: number;
    dirLevel: AgreementLevel | null;
    /** The day's verdict: the worse of speed and direction; null under two members. */
    level: AgreementLevel | null;
    /** Which part decided it ('wind' on a tie). */
    driver: 'wind' | 'dir' | null;
}

const worse = (a: AgreementLevel, b: AgreementLevel | null) => (b && RANK[b] > RANK[a] ? b : a);

/**
 * Wind agreement for each local day [0, starts[0]), [starts[0], starts[1]), …
 * to `length`. `speed` decides who covers a day (kt); `dir` is matched to it
 * by model id. With no speeds, `dir` decides coverage and every hour is
 * judged (the comparison's DIR tab with nothing to gate on).
 */
export function windAgreementForDays(
    speed: readonly ModelValues[],
    dir: readonly ModelValues[],
    starts: number[],
    length: number,
): DayWindAgreement[] {
    const gate = speed.length > 0;
    const base = gate ? speed : dir;
    const dirOf = new Map(dir.map((m) => [m.id, m.values]));
    const bounds = [0, ...starts, length];
    const days = bounds.slice(1).map((end, d) => {
        const start = bounds[d];
        const covering = base.filter((m) => {
            if (end <= start) return false;
            for (let i = start; i < end; i++) if (m.values[i] == null) return false;
            return true;
        });
        return { start, end, covering };
    });
    const peak = Math.max(0, ...days.map((d) => d.covering.length));

    return days.map(({ start, end, covering }) => {
        const members = covering.length;
        const out: DayWindAgreement = {
            start,
            end,
            members,
            peak,
            thin: members >= 2 && members < Math.min(THIN_BELOW, peak),
            speedSpread: null,
            speedRange: null,
            speedMedian: null,
            speedLevel: null,
            dirSpread: null,
            dirHours: 0,
            dirLevel: null,
            level: null,
            driver: null,
        };
        if (members < 2) return out;

        if (gate) {
            const maxima = covering.map((m) => {
                let max = -Infinity;
                for (let i = start; i < end; i++) max = Math.max(max, m.values[i] as number);
                return max;
            });
            const lo = Math.min(...maxima);
            const hi = Math.max(...maxima);
            out.speedRange = [lo, hi];
            out.speedSpread = hi - lo;
            out.speedMedian = median(maxima);
            out.speedLevel = classifySpread('wind', out.speedSpread, out.speedMedian);
        }

        let sum = 0;
        for (let i = start; i < end; i++) {
            const bearings: number[] = [];
            const speeds: number[] = [];
            for (const m of covering) {
                const b = gate ? dirOf.get(m.id)?.[i] : m.values[i];
                if (b == null) continue;
                bearings.push(b);
                if (gate) speeds.push(m.values[i] as number);
            }
            if (bearings.length < 2) continue;
            if (gate && median(speeds) < DIR_MIN_MEDIAN_KT) continue;
            sum += circularSpread(bearings);
            out.dirHours++;
        }
        if (out.dirHours >= (gate ? DIR_MIN_HOURS : 1)) {
            out.dirSpread = sum / out.dirHours;
            out.dirLevel = classifySpread('dir', out.dirSpread);
        }

        const first = out.speedLevel ?? out.dirLevel;
        if (first) {
            out.level = worse(first, out.speedLevel ? out.dirLevel : null);
            out.driver = out.speedLevel && out.level === out.speedLevel ? 'wind' : 'dir';
        }
        return out;
    });
}

export interface WindDayVerdict extends DayWindAgreement {
    /** The location's calendar date, YYYY-MM-DD. */
    date: string;
    /** The day's first hour, and the end of its last. */
    startMs: number;
    endMs: number;
    /** Every hour of the local day is in the block: today runs from now and
     *  the last day stops at the 240th hour, so neither can stand for a day. */
    whole: boolean;
}

const HOUR_MS = 3_600_000;

/** The ten-day spread's wind verdict for each of the location's days. */
export function windAgreementByDay(block: SpreadBlock<AtmosVar> | null, timeZone: string): WindDayVerdict[] {
    const times = block?.times ?? [];
    if (!block || !times.length) return [];
    const speed = block.models.map((m) => ({ id: m.id, values: m.values.wind_speed_10m }));
    const dir = block.models.map((m) => ({ id: m.id, values: m.values.wind_direction_10m }));
    const starts = localDayStarts(times, timeZone);
    const day = dayFormat(timeZone);
    const last = times.length - 1;
    const startsAtMidnight = day.format(times[0] - HOUR_MS) !== day.format(times[0]);
    const endsAtMidnight = day.format(times[last] + HOUR_MS) !== day.format(times[last]);
    return windAgreementForDays(speed, dir, starts, times.length).map((d, k, all) => ({
        ...d,
        date: day.format(times[d.start]),
        startMs: times[d.start],
        endMs: d.end < times.length ? times[d.end] : times[last] + HOUR_MS,
        whole: (k > 0 || startsAtMidnight) && (k < all.length - 1 || endsAtMidnight),
    }));
}

/** The day holding `ms`, or null outside the answer. */
export function verdictAt(verdicts: readonly WindDayVerdict[], ms: number): WindDayVerdict | null {
    return verdicts.find((v) => ms >= v.startMs && ms < v.endMs) ?? null;
}
