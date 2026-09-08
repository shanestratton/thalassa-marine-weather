/**
 * Sea-water temperature page helpers (Shane 2026-09-09: "add a sea water temp
 * page, with all of the beautiful trimmings as the other pages have").
 *
 * The bus gives °C ($--MTW, or the Pi's environment.water.temperature). The
 * page shows it in the skipper's unit and reads its TENDENCY over the 15-min
 * record the panel keeps — warming water off a bar, a cold eddy on a bank —
 * with the same honesty rule as the barometer: a short record says so.
 */
import { celsiusToFahrenheit } from '../../utils/units';

export type TempUnit = 'C' | 'F';

/** Display value in the skipper's unit, one decimal. */
export function formatSeaTemp(celsius: number | null | undefined, unit: TempUnit): string {
    if (celsius === null || celsius === undefined || !Number.isFinite(celsius)) return '--';
    const v = unit === 'F' ? celsiusToFahrenheit(celsius) : celsius;
    return v.toFixed(1);
}

/** A delta (°C) in the skipper's unit, signed, one decimal. */
export function formatSeaTempDelta(deltaC: number, unit: TempUnit): string {
    const v = unit === 'F' ? (deltaC * 9) / 5 : deltaC;
    return `${v >= 0 ? '+' : ''}${v.toFixed(1)}`;
}

export interface SeaTempTrend {
    direction: 'warming' | 'cooling' | 'steady';
    /** Change over the record, °C (last − first). */
    deltaC: number;
    label: string;
    /** The sentence under the pill — plain, and honest about a short record. */
    read: string;
}

/** Below this much movement over the record the water is called steady. */
export const SEA_TEMP_STEADY_C = 0.2;
/** Fewer samples than this and there is no trend worth naming. */
export const SEA_TEMP_MIN_SAMPLES = 6;

export function seaTempTrend(history: readonly number[], unit: TempUnit = 'C'): SeaTempTrend | null {
    if (history.length < SEA_TEMP_MIN_SAMPLES) return null;
    const deltaC = history[history.length - 1] - history[0];
    const direction = deltaC >= SEA_TEMP_STEADY_C ? 'warming' : deltaC <= -SEA_TEMP_STEADY_C ? 'cooling' : 'steady';
    const shown = formatSeaTempDelta(deltaC, unit);
    const label = direction === 'warming' ? 'Warming' : direction === 'cooling' ? 'Cooling' : 'Steady';
    const read =
        direction === 'steady'
            ? 'Holding steady over the last quarter hour.'
            : direction === 'warming'
              ? `Up ${shown}° over the last quarter hour — warmer water under her.`
              : `Down ${shown.replace('-', '')}° over the last quarter hour — cooler water under her, often a bank, an eddy or a river mouth.`;
    return { direction, deltaC, label, read };
}
