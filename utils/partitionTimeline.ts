import type { HourlyForecast, MarineModelSnapshot } from '../types/weather';
import { admittedComfortMarine } from './marineComfort';
const KEYS = ['total', 'windSea', 'swell', 'secondarySwell'] as const;
/** Exact point/receipt/valid-clock cohort only. Missing hours break paths;
 * different forecast cohorts are never joined into a plausible-looking line. */
export function partitionTimeline(
    hours: readonly HourlyForecast[],
    selected: MarineModelSnapshot | undefined,
    now = Date.now(),
) {
    const source = admittedComfortMarine(selected, false, now);
    if (
        !source?.requested ||
        hours.length > 240 ||
        hours.some(
            (h, i) =>
                !Number.isFinite(Date.parse(h.time)) || (i > 0 && Date.parse(h.time) <= Date.parse(hours[i - 1].time)),
        )
    )
        return null;
    const rows = hours.filter((h) => {
        const m = admittedComfortMarine(h.marine, false, now);
        return (
            !!m &&
            m.fetchedAtMs === source.fetchedAtMs &&
            m.waveValidAtMs === Date.parse(h.time) &&
            m.requested?.latitude === source.requested!.latitude &&
            m.requested.longitude === source.requested!.longitude
        );
    });
    if (rows.length < 2) return null;
    const start = Date.parse(rows[0].time),
        end = Date.parse(rows.at(-1)!.time);
    const height = (row: HourlyForecast, key: (typeof KEYS)[number]) => {
        const value = row.marine?.parts?.[key]?.hM;
        return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 50 ? value : null;
    };
    const maximum = Math.max(0.1, ...rows.flatMap((row) => KEYS.map((key) => height(row, key) ?? 0)));
    const paths = KEYS.map((key) => {
        let prior: number | null = null,
            path = '';
        for (const row of rows) {
            const t = Date.parse(row.time),
                value = height(row, key);
            if (value === null) {
                prior = null;
                continue;
            }
            path += `${prior !== null && t - prior === 3600000 ? 'L' : 'M'}${(4 + ((t - start) / (end - start)) * 312).toFixed(2)},${(96 - (value / maximum) * 92).toFixed(2)} `;
            prior = t;
        }
        return { key, path: path.trim() };
    });
    return { start, end, maximum, paths };
}
