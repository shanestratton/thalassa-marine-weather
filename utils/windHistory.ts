/** Source-time wind peaks. These are sampled peaks, not a synthetic gust forecast. */
export const WIND_HISTORY_WINDOW_MS = 60 * 60 * 1000;
export const WIND_GUST_WINDOW_MS = 10 * 60 * 1000;
export const WIND_HISTORY_SUMMARY_MAX_AGE_MS = 60_000;
const MAX_SAMPLES = 7_200;
const CLOCK_SKEW_MS = 1_000;

export interface WindHistoryPeak {
    kts: number;
    at: number;
}

export interface WindHistorySummary {
    asOf: number;
    since: number;
    latestAt: number;
    sampleCount: number;
    source: string;
    max1h: WindHistoryPeak | null;
    gust10m: WindHistoryPeak | null;
}

function validTime(value: unknown, now: number): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= now + CLOCK_SKEW_MS;
}

export function isWindSpeed(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 150;
}

/** Strict wire validation: never turn missing, malformed or stale peaks into zero. */
export function parseWindHistorySummary(extra: unknown, now = Date.now()): WindHistorySummary | null {
    if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return null;
    const data = extra as Record<string, unknown>;
    if (data.wind_history_v !== 1) return null;
    const asOf = data.wind_history_at_ms;
    const since = data.wind_history_since_ms;
    const latestAt = data.wind_history_latest_ms;
    const sampleCount = data.wind_history_samples_1h;
    const source = data.wind_history_source;
    if (
        !validTime(asOf, now) ||
        !validTime(since, now) ||
        !validTime(latestAt, now) ||
        since > latestAt ||
        latestAt > asOf + CLOCK_SKEW_MS ||
        since < asOf - WIND_HISTORY_WINDOW_MS ||
        now - asOf > WIND_HISTORY_SUMMARY_MAX_AGE_MS ||
        typeof sampleCount !== 'number' ||
        !Number.isSafeInteger(sampleCount) ||
        sampleCount < 1 ||
        sampleCount > MAX_SAMPLES ||
        typeof source !== 'string' ||
        !source.trim() ||
        source.length > 120 ||
        /\p{Cc}/u.test(source)
    )
        return null;
    const peak = (speed: unknown, at: unknown, window: number): WindHistoryPeak | null | false => {
        if (speed == null && at == null) return null;
        if (!isWindSpeed(speed) || !validTime(at, now) || at < since || at > latestAt || at <= asOf - window)
            return false;
        return { kts: speed, at };
    };
    const max1h = peak(data.wind_max_1h_kts, data.wind_max_1h_at_ms, WIND_HISTORY_WINDOW_MS);
    const gust10m = peak(data.wind_gust_10m_kts, data.wind_gust_10m_at_ms, WIND_GUST_WINDOW_MS);
    if (
        !max1h ||
        gust10m === false ||
        (gust10m && gust10m.kts > max1h.kts) ||
        (!gust10m && latestAt > asOf - WIND_GUST_WINDOW_MS)
    )
        return null;
    return { asOf, since, latestAt, sampleCount, source: source.trim(), max1h, gust10m };
}

/** Validate typed snapshots too: the collector boundary is not an assertion of trust. */
export function validateWindHistorySummary(summary: WindHistorySummary, now = Date.now()): WindHistorySummary | null {
    return parseWindHistorySummary(
        {
            wind_history_v: 1,
            wind_history_at_ms: summary.asOf,
            wind_history_since_ms: summary.since,
            wind_history_latest_ms: summary.latestAt,
            wind_history_samples_1h: summary.sampleCount,
            wind_history_source: summary.source,
            wind_max_1h_kts: summary.max1h?.kts,
            wind_max_1h_at_ms: summary.max1h?.at,
            wind_gust_10m_kts: summary.gust10m?.kts,
            wind_gust_10m_at_ms: summary.gust10m?.at,
        },
        now,
    );
}

/** Bounded ingestion history; page mounts have no bearing on when collection starts. */
export class WindHistoryBuffer {
    private samples: WindHistoryPeak[] = [];
    private lastAt = 0;

    clear(): void {
        this.samples = [];
        this.lastAt = 0;
    }

    add(kts: unknown, at: number, now = Date.now()): boolean {
        this.prune(now);
        if (!isWindSpeed(kts) || !validTime(at, now) || at <= now - WIND_HISTORY_WINDOW_MS || at <= this.lastAt)
            return false;
        this.lastAt = at;
        this.samples.push({ kts, at });
        if (this.samples.length > MAX_SAMPLES) this.samples.splice(0, this.samples.length - MAX_SAMPLES);
        return true;
    }

    /** A verified Pi peak is a real observation even if we missed its neighbours. */
    addKnownPeak(peak: WindHistoryPeak | null, now = Date.now()): void {
        this.prune(now);
        if (!peak || !isWindSpeed(peak.kts) || !validTime(peak.at, now) || peak.at <= now - WIND_HISTORY_WINDOW_MS)
            return;
        let low = 0;
        let high = this.samples.length;
        while (low < high) {
            const mid = Math.floor((low + high) / 2);
            if (this.samples[mid].at < peak.at) low = mid + 1;
            else high = mid;
        }
        if (this.samples[low]?.at === peak.at) return;
        this.samples.splice(low, 0, { ...peak });
        this.lastAt = Math.max(this.lastAt, peak.at);
        if (this.samples.length > MAX_SAMPLES) this.samples.splice(0, this.samples.length - MAX_SAMPLES);
    }

    summary(source: string, now = Date.now(), afterExclusive = 0): WindHistorySummary | null {
        this.prune(now);
        if (!this.samples.length) return null;
        let max1h: WindHistoryPeak | null = null;
        let gust10m: WindHistoryPeak | null = null;
        let since = 0;
        let latestAt = 0;
        let sampleCount = 0;
        for (const sample of this.samples) {
            if (sample.at <= afterExclusive) continue;
            if (!since) since = sample.at;
            latestAt = sample.at;
            sampleCount++;
            // On ties prefer the latest real observation, never the latest receipt.
            if (!max1h || sample.kts >= max1h.kts) max1h = sample;
            if (sample.at > now - WIND_GUST_WINDOW_MS && (!gust10m || sample.kts >= gust10m.kts)) gust10m = sample;
        }
        if (!sampleCount) return null;
        return {
            asOf: now,
            since,
            latestAt,
            sampleCount,
            source,
            max1h: max1h ? { ...max1h } : null,
            gust10m: gust10m ? { ...gust10m } : null,
        };
    }

    private prune(now: number): void {
        let expired = 0;
        while (expired < this.samples.length && this.samples[expired].at <= now - WIND_HISTORY_WINDOW_MS) expired++;
        if (expired) this.samples.splice(0, expired);
    }
}

/** Old summary values cannot be re-stamped by repeated downloads of a cached row. */
export function freshWindHistorySummary(
    summary: WindHistorySummary | null,
    now = Date.now(),
): WindHistorySummary | null {
    if (!summary) return null;
    const valid = validateWindHistorySummary(summary, now);
    if (
        !valid ||
        (valid.max1h && valid.max1h.at <= now - WIND_HISTORY_WINDOW_MS) ||
        (valid.gust10m && valid.gust10m.at <= now - WIND_GUST_WINDOW_MS)
    )
        return null;
    return valid;
}
