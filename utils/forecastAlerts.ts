/**
 * Thalassa's own forecast alerts: the rule table and the one classifier.
 *
 * generateSafetyAlerts (utils/advisory.ts) reads the model forecast against
 * fixed thresholds. Those lines used to wear official product names ("GALE
 * WARNING", "Small Craft Advisory", "STORM WATCH"), which read as if a
 * national weather service had issued them. Nobody issued them: a model run
 * crossed a number. Every line now starts "Forecast:" and names the
 * condition, not a product (build 123, W1-02; gap register must-do #4).
 *
 * Which alerts are CRITICAL (shown in red, never dismissable) is decided here
 * and only here. CompactHeaderRow, AlertsBanner and WarningDetails each used
 * to carry their own copy of the pattern list; one drifting copy is how a gale
 * becomes dismissable on one surface and not another. The texts and the
 * classifier come from the same stems, so they cannot drift apart either.
 *
 * Thresholds live in advisory.ts and are unchanged by the relabel.
 */

export interface ForecastAlertRule {
    /** Every text of this rule begins with this stem. */
    stem: string;
    /** Critical alerts are life/vessel safety: never dismissable. */
    critical: boolean;
    /**
     * What the alert reads. The Forecast alerts page names the served model on
     * a card only where that model forecasts this quantity: sea state comes
     * from a wave model, and visibility and UV can be borrowed from WeatherKit.
     */
    reads: 'wind' | 'sea' | 'visibility' | 'weather' | 'temperature' | 'uv';
}

/**
 * One rule per kind of forecast alert generateSafetyAlerts can raise. The
 * stems are distinct prefixes, and no stem is a prefix of another rule's text.
 */
export const FORECAST_ALERT_RULES = {
    stormForce: { stem: 'Forecast: storm-force', critical: true, reads: 'wind' },
    galeForce: { stem: 'Forecast: gale-force', critical: true, reads: 'wind' },
    strongWind: { stem: 'Forecast: strong wind', critical: false, reads: 'wind' },
    strongGusts: { stem: 'Forecast: strong gusts', critical: false, reads: 'wind' },
    dangerousSeas: { stem: 'Forecast: dangerous seas', critical: true, reads: 'sea' },
    roughSeas: { stem: 'Forecast: rough seas', critical: false, reads: 'sea' },
    denseFog: { stem: 'Forecast: dense fog', critical: true, reads: 'visibility' },
    poorVisibility: { stem: 'Forecast: poor visibility', critical: false, reads: 'visibility' },
    thunderstorms: { stem: 'Forecast: thunderstorms', critical: false, reads: 'weather' },
    heavyRain: { stem: 'Forecast: heavy rain', critical: false, reads: 'weather' },
    /** A stormy day in the next three (was "STORM WATCH"). */
    stormRisk: { stem: 'Forecast: storm risk', critical: true, reads: 'weather' },
    extremeHeat: { stem: 'Forecast: extreme heat', critical: true, reads: 'temperature' },
    highHeat: { stem: 'Forecast: high heat', critical: false, reads: 'temperature' },
    heat: { stem: 'Forecast: heat,', critical: false, reads: 'temperature' },
    freezingSpray: { stem: 'Forecast: freezing spray', critical: true, reads: 'temperature' },
    nearFreezing: { stem: 'Forecast: near-freezing', critical: true, reads: 'temperature' },
    veryHighUv: { stem: 'Forecast: very high UV', critical: false, reads: 'uv' },
} as const satisfies Record<string, ForecastAlertRule>;

/**
 * The patterns the three alert surfaces matched before build 123, kept so the
 * legacy strings still sitting in cached reports ("GALE WARNING: Winds
 * exceeding 34kts") keep their non-dismissable state. Same semantics as
 * before: a case-insensitive substring match.
 */
export const LEGACY_CRITICAL_PATTERNS: readonly string[] = [
    'STORM WARNING',
    'GALE WARNING',
    'DANGEROUS SEAS',
    'FREEZING SPRAY',
    'FREEZE WARNING',
    'EXCESSIVE HEAT',
    'DENSE FOG',
    'STORM WATCH',
    'GALE WATCH',
];

const CRITICAL_STEMS = Object.values(FORECAST_ALERT_RULES)
    .filter((rule) => rule.critical)
    .map((rule) => rule.stem.toLowerCase());

/**
 * Is this forecast alert critical (never dismissable)? True for the critical
 * 'Forecast: …' texts and for every string the old pattern list caught, so a
 * legacy or cached alert never becomes dismissable by the relabel.
 */
export function isCriticalForecastAlert(alert: string): boolean {
    const upper = alert.toUpperCase();
    if (LEGACY_CRITICAL_PATTERNS.some((pattern) => upper.includes(pattern))) return true;
    const lower = alert.toLowerCase();
    return CRITICAL_STEMS.some((stem) => lower.startsWith(stem));
}

/**
 * The rule a 'Forecast: …' text came from, or undefined for anything else (a
 * legacy string from a cached report, say).
 */
export function forecastAlertRule(alert: string): ForecastAlertRule | undefined {
    const lower = alert.toLowerCase();
    return Object.values(FORECAST_ALERT_RULES).find((rule) => lower.startsWith(rule.stem.toLowerCase()));
}
