/**
 * rainAnalysis — the RainForecastCard's brain, extracted pure.
 *
 * Everything the card asserts ("Rain in 12 min", "No rain expected next
 * 31 min") is derived here from the minute-by-minute feed against a caller-
 * supplied clock, so the honesty rules are testable without React:
 *
 *  - NEVER analyse the past. When every frame in the feed has elapsed the
 *    old code fell back to the raw array, and Math.max(1, negative-minutes)
 *    pinned a false "Rain in 1 min" through every 60-second tick until the
 *    next half-hour refresh (confirmed 2026-08-20; reachable by reopening
 *    the app after an hour backgrounded). An expired feed now returns an
 *    explicit `expired` verdict with no frames and no rain claim.
 *
 *  - Charts render `frames` (future-only), not the raw feed. peakIdx and
 *    firstRainIdx index into `frames`, so the Peak marker cannot drift as
 *    minutes elapse — the old code computed indices on the filtered array
 *    and rendered them against the unfiltered one.
 *
 *  - A dry verdict states the window it ACTUALLY checked. "No rain expected
 *    next 60 min" from a 29-minute-old WeatherKit frame can only vouch for
 *    ~31 minutes; the label is now computed from the live span of the
 *    remaining frames, and provider summaries with countdowns frozen at
 *    fetch time ("Rain starting in 15 min") are never used as headlines.
 */

export interface MinutelyRainPoint {
    time: string;
    intensity: number; // mm/hr
}

export interface RainCategory {
    label: string;
    badgeClass: string;
    color: string;
}

export interface RainAnalysis {
    /** Future-only frames — the ONLY thing charts should render. */
    frames: MinutelyRainPoint[];
    /** True when a feed exists but every frame has elapsed. */
    expired: boolean;
    maxIntensity: number;
    hasRain: boolean;
    firstRainIdx: number;
    isCurrentlyRaining: boolean;
    headline: string;
    subline: string;
    category: RainCategory;
    totalPrecip: number;
    peakIdx: number;
}

/** mm/hr below which a minute is treated as dry (satellite-fusion noise). */
export const RAIN_THRESHOLD = 0.3;
/** mm/hr needed to call the first minute "currently raining". */
export const RAIN_CURRENT_THRESHOLD = 0.5;

/** A provider summary whose countdown was computed at fetch time. It was
 *  right once; repeating it later is how a card lies with a straight face. */
const FROZEN_COUNTDOWN = /\bin\s+~?\d+\s*(min|minute|hour|h)\b/i;

export function getIntensityLabel(mmPerHr: number): string {
    if (mmPerHr >= 7.6) return 'Heavy Rain';
    if (mmPerHr >= 2.5) return 'Moderate Rain';
    if (mmPerHr >= 0.5) return 'Light Rain';
    if (mmPerHr > 0) return 'Drizzle';
    return 'Dry';
}

export function getIntensityCategory(mmPerHr: number): RainCategory {
    if (mmPerHr >= 7.6)
        return {
            label: 'Heavy',
            badgeClass: 'bg-red-500/30 text-red-300 border border-red-400/30',
            color: 'rgba(239, 68, 68, 0.7)',
        };
    if (mmPerHr >= 2.5)
        return {
            label: 'Moderate',
            badgeClass: 'bg-amber-500/25 text-amber-300 border border-amber-400/25',
            color: 'rgba(245, 158, 11, 0.7)',
        };
    if (mmPerHr >= 0.5)
        return {
            label: 'Light',
            badgeClass: 'bg-sky-500/25 text-sky-300 border border-sky-400/25',
            color: 'rgba(59, 130, 246, 0.7)',
        };
    return {
        label: 'Drizzle',
        badgeClass: 'bg-sky-500/20 text-sky-300 border border-sky-400/20',
        color: 'rgba(14, 165, 233, 0.5)',
    };
}

const EMPTY_CATEGORY: RainCategory = { label: 'Clear', badgeClass: '', color: 'rgba(96, 165, 250, 0.5)' };

function noData(headline: string, subline: string, expired: boolean): RainAnalysis {
    // NEVER assert a dry forecast we do not have. hasRain stays false so the
    // chart, badge and "Tap for detail" remain hidden — only the words change.
    return {
        frames: [],
        expired,
        maxIntensity: 0,
        hasRain: false,
        headline,
        subline,
        isCurrentlyRaining: false,
        category: EMPTY_CATEGORY,
        totalPrecip: 0,
        firstRainIdx: -1,
        peakIdx: 0,
    };
}

/**
 * Human window label from remaining minutes: "31 min", "2\u00bd hours", "4 hours".
 * NEVER rounds up — a dry verdict must not claim minutes the feed does not
 * cover (Math.round turned a 3 h 35 m window into "next 4 hours", the exact
 * overstatement this module exists to kill). Flooring to the half hour keeps
 * the label short while only ever UNDERstating, by at most 29 min.
 */
function windowLabel(spanMin: number): string {
    if (spanMin >= 100) {
        const h = Math.floor(spanMin / 60);
        const halves = spanMin - h * 60 >= 30;
        return `${h}${halves ? '\u00bd' : ''} hour${h === 1 && !halves ? '' : 's'}`;
    }
    return `${spanMin} min`;
}

export function analyzeRain(
    data: MinutelyRainPoint[] | undefined,
    opts: {
        rainSummary?: string;
        status?: 'loading' | 'loaded' | 'error';
        now?: number;
    } = {},
): RainAnalysis {
    const { rainSummary, status = 'loaded' } = opts;
    const now = opts.now ?? Date.now();

    if (!data || data.length === 0) {
        return status === 'loading'
            ? noData('Rain Forecast Loading…', 'Checking the last hour', false)
            : noData('Rain Forecast Unavailable', 'No minute-by-minute data here', false);
    }

    // Only frames that are still ahead of us (with a one-minute grace for the
    // frame currently in progress) may inform any claim.
    const frames = data.filter((d) => new Date(d.time).getTime() > now - 60_000);
    if (frames.length === 0) {
        return noData('Rain Data Out Of Date', 'Waiting for a fresh nowcast', true);
    }

    const maxIntensity = Math.max(...frames.map((d) => d.intensity), 0.1);

    // DATA ALWAYS WINS: determine rain from actual minute-by-minute
    // intensities. 0.3 mm/hr ignores satellite-fusion trace noise (virga over
    // clear skies); "currently raining" demands real drizzle.
    const hasRain = frames.some((d) => d.intensity >= RAIN_THRESHOLD);
    const firstRainEntry = frames.find((d) => d.intensity >= RAIN_THRESHOLD);
    const firstRainIdx = frames.findIndex((d) => d.intensity >= RAIN_THRESHOLD);
    const isCurrentlyRaining = (frames[0]?.intensity ?? 0) >= RAIN_CURRENT_THRESHOLD;

    const minutesUntilRain = firstRainEntry
        ? Math.max(1, Math.round((new Date(firstRainEntry.time).getTime() - now) / 60_000))
        : -1;

    const firstDryAfterRain = isCurrentlyRaining
        ? (() => {
              const dryEntry = frames.find((d, i) => i > 0 && d.intensity < RAIN_THRESHOLD);
              if (!dryEntry) return -1;
              return Math.max(1, Math.round((new Date(dryEntry.time).getTime() - now) / 60_000));
          })()
        : -1;

    const peakIdx = frames.reduce((maxI, d, i) => (d.intensity > frames[maxI].intensity ? i : maxI), 0);
    const totalPrecip = frames.reduce((sum, d) => sum + d.intensity / 60, 0);

    // How far ahead the feed can actually vouch for, right now. Frames are
    // one-minute buckets stamped with their BEGIN time, so the checked
    // window extends to the end of the last bucket — without the +1 a fresh
    // 240-frame Rainbow feed would understate itself as "3\u00bd hours".
    const spanMin = Math.max(
        1,
        Math.round((new Date(frames[frames.length - 1].time).getTime() + 60_000 - now) / 60_000),
    );

    let headline = '';
    let subline = '';

    if (!hasRain) {
        // A no-rain verdict must state the window it actually checked — and
        // that window shrinks as the frame ages. The label is computed from
        // the LIVE remaining span, never from the source's nominal horizon
        // ("next 4 hours" off a 30-minute-old frame) and never from a
        // provider summary whose window was worded at fetch time.
        headline = `No rain expected next ${windowLabel(spanMin)}`;
        subline = `Next ${windowLabel(spanMin)}`;
    } else if (isCurrentlyRaining && firstDryAfterRain > 0) {
        headline = `Rain stopping in ${firstDryAfterRain} min`;
        subline = getIntensityLabel(frames[0].intensity);
    } else if (isCurrentlyRaining && firstDryAfterRain === -1) {
        // Every checked frame is wet — but only claim the span we checked.
        // An aged feed with 20 wet minutes left is not "rain for the next
        // hour"; it is rain for 20 minutes and then no information.
        headline = `Rain for the next ${windowLabel(spanMin)}`;
        subline = getIntensityLabel(maxIntensity);
    } else if (minutesUntilRain > 0) {
        headline = `Rain in ${minutesUntilRain} min`;
        subline = getIntensityLabel(firstRainEntry!.intensity);
    } else if (
        rainSummary &&
        !FROZEN_COUNTDOWN.test(rainSummary) &&
        !(/\bno\b/i.test(rainSummary) && /rain|precip/i.test(rainSummary))
    ) {
        headline = rainSummary;
        subline = `Peak: ${Math.round(maxIntensity)} mm/hr`;
    } else {
        headline = 'Precipitation detected';
        subline = `Peak: ${Math.round(maxIntensity)} mm/hr`;
    }

    return {
        frames,
        expired: false,
        maxIntensity,
        hasRain,
        firstRainIdx,
        isCurrentlyRaining,
        headline,
        subline,
        category: getIntensityCategory(maxIntensity),
        totalPrecip,
        peakIdx,
    };
}
