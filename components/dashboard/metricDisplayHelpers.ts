/**
 * metricDisplayHelpers — Shared rendering logic for pin-to-hero feature.
 *
 * Converts a metric ID (the same IDs used in settings.heroMetric and in
 * the HeroWidgets 5×2 grid) into the primary value + label + unit shown
 * in the hero card. Centralising this means HeroHeader and HeroWidgets
 * stay in sync — same rounding rules, same null handling, same labels.
 */
import { WeatherMetrics, UnitPreferences } from '../../types';
import { convertSpeed, convertLength, convertDistance, convertTemp } from '../../utils';

export interface PinnedMetricDisplay {
    /** Short uppercase label (e.g. "WIND", "HPA", "UV") */
    label: string;
    /** Primary numeric or string value, already rounded for display */
    value: string | number;
    /** Unit suffix (e.g. "kts", "%", "nm"). Empty string if none. */
    unit: string;
}

/**
 * Compute the {label, value, unit} tuple for a given pinnable metric.
 * Returns null for unknown metric IDs (caller should fall back to temp).
 *
 * Kept in sync with PINNABLE_METRICS in MetricPinSheet.tsx — any new
 * pinnable metric added there needs a matching case here.
 */
export function getPinnedMetricDisplay(
    metric: string,
    data: WeatherMetrics,
    units: UnitPreferences,
): PinnedMetricDisplay | null {
    const round = (v: number | null | undefined): number | string =>
        v !== null && v !== undefined && !isNaN(v) ? Math.round(v) : '--';

    switch (metric) {
        case 'wind': {
            const kts = data.windSpeed;
            const conv = kts !== null && kts !== undefined ? convertSpeed(kts, units.speed) : null;
            return {
                label: 'WIND',
                value: conv !== null && conv !== undefined ? Math.round(conv) : '--',
                unit: units.speed || 'kts',
            };
        }
        case 'dir': {
            const d = data.windDirection;
            return { label: 'DIR', value: typeof d === 'string' && d ? d : '--', unit: '' };
        }
        case 'gust': {
            const g = data.windGust;
            const conv = g !== null && g !== undefined ? convertSpeed(g, units.speed) : null;
            return {
                label: 'GUST',
                value: conv !== null && conv !== undefined ? Math.round(conv) : '--',
                unit: units.speed || 'kts',
            };
        }
        case 'wave': {
            const w = data.waveHeight;
            const label = data.swellDirection ? 'SWELL' : 'WAVE';
            const conv = w !== null && w !== undefined ? convertLength(w, units.length) : null;
            return {
                label,
                value: conv !== null && conv !== undefined ? conv : '--',
                unit: units.waveHeight || 'm',
            };
        }
        case 'period': {
            return {
                label: 'PER.',
                value: round(data.swellPeriod),
                unit: 's',
            };
        }
        case 'uv': {
            const uv = data.uvIndex;
            return {
                label: 'UV',
                value: uv !== null && uv !== undefined && !isNaN(uv) ? Math.ceil(uv) : '--',
                unit: '',
            };
        }
        case 'vis': {
            const v = data.visibility;
            if (v === null || v === undefined || isNaN(v)) {
                return { label: 'VIS', value: '--', unit: units.visibility || 'nm' };
            }
            const converted = convertDistance(v, units.visibility || 'nm');
            if (typeof converted === 'string' && converted.includes('+')) {
                return { label: 'VIS', value: converted, unit: units.visibility || 'nm' };
            }
            const num = parseFloat(String(converted));
            return {
                label: 'VIS',
                value: isNaN(num) ? converted : Math.round(num),
                unit: units.visibility || 'nm',
            };
        }
        case 'pressure': {
            return { label: 'HPA', value: round(data.pressure), unit: 'hPa' };
        }
        case 'humidity': {
            return { label: 'HUM', value: round(data.humidity), unit: '%' };
        }
        case 'rain': {
            // Rain is context-sensitive (daily total vs. hourly chance). The
            // caller passes either into `data.precipitation` or picks a more
            // specific field upstream. For the hero card we always show the
            // currently-available precipitation value, rounded.
            return { label: 'RAIN', value: round(data.precipitation), unit: 'mm' };
        }
        default:
            return null;
    }
}

/**
 * Temperature display for the hero slot — shared between the default
 * rendering (heroMetric='temp') and the grid-cell-temp rendering (when
 * a different metric is pinned and temp has moved into the grid).
 */
export function getTemperatureDisplay(data: WeatherMetrics, units: UnitPreferences): PinnedMetricDisplay {
    const t = data.airTemperature;
    const value = t !== null && t !== undefined ? convertTemp(t, units.temp) : '--';
    return {
        label: 'TEMP',
        value,
        unit: `°${units.temp || 'C'}`,
    };
}
