/**
 * For 129-07 (forecast alerts ahead): is this "Forecast: …" alert already
 * covered by an official warning in force at the same place? 129-06 leaves
 * the predicate and its test (tests/OfficialWarningCover.test.ts); 129-07
 * calls it with the official warnings in force at the forecast's position
 * (services/officialWarnings.ts officialInForce) and drops the alerts it
 * covers, since the official warning already says it in the issuer's words.
 *
 * Covered means an official warning of the same type, at least as strong:
 * a Gale Warning covers "Forecast: gale-force" and "strong wind" but not
 * "storm-force"; a Small Craft Advisory covers "strong wind" and "rough
 * seas", never "gale-force". Types and strengths come from the issuer's own
 * vocabulary (supabase/functions/_shared/official-alerts/classify.ts). A
 * legacy text, or a type no warning has (UV), is never covered.
 *
 * The predicate itself is shared with check-weather-alerts (129-07), which
 * drops a push it covers: supabase/functions/_shared/forecast-alerts/cover.ts.
 * This file maps the app's "Forecast: …" texts onto it. Not imported by the
 * app yet, so it adds nothing to the bundle.
 */
import type { OfficialHazard } from '../supabase/functions/_shared/official-alerts/classify';
import { officialCovers, type OfficialForCover } from '../supabase/functions/_shared/forecast-alerts/cover';
import { FORECAST_ALERT_RULES, forecastAlertRule } from './forecastAlerts';

export type { OfficialForCover };

type RuleKey = keyof typeof FORECAST_ALERT_RULES;

/** What each forecast alert reads, on the classifier's scale. */
const FORECAST_HAZARD: Partial<Record<RuleKey, readonly [OfficialHazard, number]>> = {
    stormForce: ['wind', 3],
    galeForce: ['wind', 2],
    strongWind: ['wind', 1],
    strongGusts: ['wind', 1],
    dangerousSeas: ['sea', 2],
    roughSeas: ['sea', 1],
    denseFog: ['fog', 2],
    poorVisibility: ['fog', 1],
    thunderstorms: ['thunderstorm', 1],
    stormRisk: ['thunderstorm', 1],
    extremeHeat: ['heat', 3],
    highHeat: ['heat', 2],
    heat: ['heat', 1],
    freezingSpray: ['cold', 2],
    nearFreezing: ['cold', 1],
};

export function forecastAlertCoveredByOfficial(alert: string, official: readonly OfficialForCover[]): boolean {
    const rule = forecastAlertRule(alert);
    const key = rule && (Object.keys(FORECAST_ALERT_RULES) as RuleKey[]).find((k) => FORECAST_ALERT_RULES[k] === rule);
    return officialCovers(key ? FORECAST_HAZARD[key] : undefined, official);
}
