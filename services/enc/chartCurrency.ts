/**
 * chartCurrency — how OLD is the chart edition in view?
 *
 * The attribution chip coloured its confidence dot by CATZOC (survey
 * QUALITY) only, so an 11-year-old edition wore the same emerald dot as a
 * fresh survey (mission audit). But an ENC edition is only current between
 * re-issues if kept up to date via Notices to Mariners — and we hold the
 * edition's issue date, not its NtM status. So a stale edition date is a
 * genuine "verify current updates" signal a mariner should see.
 *
 * Pure + unit-tested (nowMs injected so there's no clock dependency).
 */

/** An edition this many years past its issue date is flagged for a
 *  currency check — comfortably beyond a typical HO re-issue cycle, so it
 *  doesn't cry wolf on a normal 1–3-year-old chart. */
export const CHART_STALE_YEARS = 5;

const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;

/**
 * Age in years of an ENC edition's issue date at `nowMs`. Accepts an ISO
 * date ("2025-12-02") or a bare "YYYY"/"YYYY-MM". Returns null for a
 * missing/placeholder/unparseable date (the caller shows no age rather
 * than a wrong one), and clamps a future date to 0.
 */
export function chartAgeYears(issued: string | undefined | null, nowMs: number): number | null {
    if (!issued) return null;
    const norm = issued.length === 4 ? `${issued}-01-01` : issued.length === 7 ? `${issued}-01` : issued;
    const t = Date.parse(norm);
    if (!Number.isFinite(t)) return null;
    const years = (nowMs - t) / MS_PER_YEAR;
    return years < 0 ? 0 : years;
}

/** True when the edition is old enough to warrant a Notices-to-Mariners /
 *  currency check. Null age (unknown) is NOT treated as stale. */
export function isChartStale(ageYears: number | null): boolean {
    return ageYears != null && ageYears >= CHART_STALE_YEARS;
}

/** Compact age read for the chip, e.g. "8 yr" / "10 mo" / null when
 *  unknown or brand-new (< 1 month — no point shouting "0 yr"). */
export function chartAgeLabel(ageYears: number | null): string | null {
    if (ageYears == null) return null;
    if (ageYears < 1 / 12) return null;
    if (ageYears < 1) return `${Math.round(ageYears * 12)} mo`;
    return `${Math.round(ageYears)} yr`;
}
