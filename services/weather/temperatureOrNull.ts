/**
 * A temperature the source did not supply travels as null, never as 0 °C
 * (UX scorecard run 6, F-invented-zeros). Every renderer already turns null
 * into '--': convertTemp, the hero's finite-number checks, the deep-dive
 * chart's num().
 *
 * HourlyForecast.temperature and ForecastDay.highTemp / lowTemp are still
 * declared `number` in types/weather.ts, although Open-Meteo has always put
 * null there at runtime for a model that lacks the field. This helper is the
 * one place that gap lives, so the producers stay honest without a
 * repo-wide retype. Delete it once those three fields are widened to
 * `number | null`.
 */
export const temperatureOrNull = (value: number | null | undefined): number =>
    (typeof value === 'number' && Number.isFinite(value) ? value : null) as number;
