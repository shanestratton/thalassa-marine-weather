/** Join fresh UTC marine values to retained wx forecasts by valid time. */
type Obj = Record<string, unknown>;
const object = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const HOUR = 3_600_000;
export function utcMarineLookup(data: unknown) {
    const hours = new Map<
        number,
        { wave_height: number | null; wave_period: number | null; wave_direction: number | null }
    >();
    if (
        object(data) &&
        data.utc_offset_seconds === 0 &&
        object(data.hourly) &&
        object(data.hourly_units) &&
        Array.isArray(data.hourly.time) &&
        data.hourly.time.length <= 384
    ) {
        const hourly = data.hourly,
            units = data.hourly_units;
        const times = (hourly.time as unknown[]).map((value) =>
            typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:00(?::00)?Z?$/.test(value)
                ? Date.parse(value.endsWith('Z') ? value : value + 'Z')
                : NaN,
        );
        if (times.every((at, i) => Number.isFinite(at) && at % HOUR === 0 && (!i || at - times[i - 1] === HOUR))) {
            const value = (field: string, expected: string, max: number, i: number) => {
                const list = hourly[field],
                    v = Array.isArray(list) && list.length === times.length ? list[i] : null;
                return units[field] === expected && finite(v) && v >= 0 && v <= max ? v : null;
            };
            times.forEach((at, i) =>
                hours.set(at, {
                    wave_height: value('wave_height', 'm', 100, i),
                    wave_period: value('wave_period', 's', 100, i),
                    wave_direction: value('wave_direction', '°', 360, i),
                }),
            );
        }
    }
    return {
        at: (time: string) => hours.get(Date.parse(time)) ?? null,
        maximumForDay: (day: string): number | null => {
            const start = Date.parse(day + 'T00:00:00Z'),
                heights = Array.from({ length: 24 }, (_, i) => hours.get(start + i * HOUR)?.wave_height);
            return heights.every(finite) ? Math.max(...heights) : null;
        },
    };
}
