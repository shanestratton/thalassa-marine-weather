import type { WeatherModel } from '../../types';
import { getForecastModelInfo, OFFSHORE_MODELS } from './forecastModels';

/**
 * The display name of whatever served the Glass, from the pipeline's model
 * tag ('om:dwd_icon+wk', 'wx:ecmwf_ifs025', 'spitfire+sg',
 * 'stormglass_ecmwf+fallback:…'). The tag is an internal id and was being
 * read aloud verbatim ("showing om:dwd_icon+wk"). Null when the tag names no
 * single model (Auto blends, 'Loading...'), so the name simply omits it
 * rather than guessing. A tag that is already a plain name passes through.
 *
 * Shared by the Glass's model pill (StatusBadges) and the Forecast alerts
 * cards (WarningDetails), so the two never name different models.
 */
export function servedModelDisplayName(tag: string | null | undefined): string | null {
    if (!tag) return null;
    if (/\bspitfire\b/i.test(tag)) return 'Spitfire';
    const grid = /(?:^|\+)(?:om|wx):([a-z0-9_]+)/.exec(tag) ?? /^(?:openmeteo|wx)_([a-z0-9_]+)/.exec(tag);
    if (grid) return getForecastModelInfo(grid[1] as WeatherModel)?.label ?? null;
    const sg = /^stormglass_([a-z]+)/.exec(tag);
    if (sg) return OFFSHORE_MODELS.find((m) => m.id === sg[1])?.label ?? null;
    // Anything else with id punctuation is an internal blend tag, not a name.
    if (/[:_+]|\.\.\.$/.test(tag) || tag === tag.toLowerCase()) return null;
    return tag;
}
