/**
 * What check-weather-alerts and the app agree on for forecast alerts that
 * look ahead (129-07). Tiny and dependency-free, so the app's Settings →
 * Alerts reads it without taking the server's decisions into its bundle.
 *
 * The function reports FORECAST_ALERTS_VERSION in every run's status row
 * (held migration 20261014190000_weather_alert_status). The app shows the
 * look-ahead choice, the "Good window opens" switch and the per-position
 * status only once weather_alert_status() answers with at least this
 * version: a build that ships before the deploy never offers a choice
 * nothing honours.
 */

/** 1 was the current-conditions check (v35, 13 Oct). 2 looks ahead with 2-of-3 agreement. */
export const FORECAST_ALERTS_VERSION = 2;

/** How far ahead the skipper can ask the background check to look, in hours. */
export const LOOKAHEAD_CHOICES = [6, 12, 24] as const;
export type LookaheadHours = (typeof LOOKAHEAD_CHOICES)[number];
/** Shane, 13 Oct: "go with your recommendations": 24 h. */
export const DEFAULT_LOOKAHEAD_HOURS: LookaheadHours = 24;

/** The stored choice, or the default for anything else (unset, stale, malformed). */
export function lookaheadHours(value: unknown): LookaheadHours {
    return (LOOKAHEAD_CHOICES as readonly unknown[]).includes(value)
        ? (value as LookaheadHours)
        : DEFAULT_LOOKAHEAD_HOURS;
}
