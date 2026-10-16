import {
    CURRENT_FIELDS,
    DAILY_FIELDS,
    FIELD_UNITS,
    HOURLY_FIELDS,
    MODELS,
} from '../../supabase/functions/wx-publisher/contract';
export function wxFixture(model = 'dwd_icon', runAt = '2026-10-16T06:00:00Z') {
    const start = Date.parse('2026-10-16T00:00:00Z');
    const hourly: Record<string, unknown[]> = {
        time: Array.from({ length: 72 }, (_, i) => new Date(start + i * 3600_000).toISOString()),
    };
    for (const field of HOURLY_FIELDS) hourly[field] = Array(72).fill(null);
    hourly.wind_speed_10m = Array.from({ length: 72 }, (_, i) => 10 + i);
    hourly.wind_direction_10m = Array(72).fill(90);
    hourly.temperature_2m = Array(72).fill(20);
    hourly.relative_humidity_2m = Array(72).fill(70);
    hourly.pressure_msl = Array(72).fill(1010);
    hourly.cloud_cover = Array(72).fill(30);
    hourly.precipitation = Array(72).fill(0);
    const daily: Record<string, unknown[]> = { time: ['2026-10-16', '2026-10-17', '2026-10-18'] };
    for (const field of DAILY_FIELDS) daily[field] = Array(3).fill(null);
    daily.temperature_2m_max = [25, 26, 27];
    daily.temperature_2m_min = [15, 16, 17];
    const current: Record<string, unknown> = { time: runAt, interval: 900 };
    for (const field of CURRENT_FIELDS) current[field] = null;
    current.wind_speed_10m = 200;
    current.wind_direction_10m = 270;
    current.temperature_2m = 30;
    const units = (fields: readonly string[]) =>
        ({ time: 'iso8601', ...Object.fromEntries(fields.map((field) => [field, FIELD_UNITS[field]])) }) as Record<
            string,
            string
        >;
    return {
        runAt,
        payload: {
            latitude: -27.25,
            longitude: 153,
            timezone: 'UTC',
            utc_offset_seconds: 0,
            current,
            hourly,
            daily,
            current_units: { ...units(CURRENT_FIELDS), interval: 'seconds' },
            hourly_units: units(HOURLY_FIELDS),
            daily_units: units(DAILY_FIELDS),
            thalassa_provenance: {
                version: 2,
                source: 'wx',
                model,
                cell_selection: 'sea',
                sampling: 'cell-centre',
                cell_id: '-2725_15300',
                cell_degrees: 0.25,
                latitude: -27.125,
                longitude: 153.125,
                run_at: runAt,
                source_domains: [...(MODELS[model] || [model])],
                source_runs: (MODELS[model] || [model]).map((domain) => ({
                    domain,
                    run_at: runAt,
                    data_end_at: '2026-10-30T23:00:00Z',
                })),
            },
        },
    };
}
export function marineFixture(start = '2026-10-17T00:00:00Z') {
    return {
        timezone: 'GMT',
        utc_offset_seconds: 0,
        hourly: {
            time: Array.from({ length: 48 }, (_, i) =>
                new Date(Date.parse(start) + i * 3600_000).toISOString().replace('.000Z', ''),
            ),
            wave_height: Array.from({ length: 48 }, (_, i) => 1 + i / 100),
            wave_period: Array(48).fill(8),
            wave_direction: Array(48).fill(90),
        },
        hourly_units: { time: 'iso8601', wave_height: 'm', wave_period: 's', wave_direction: '°' },
        daily: { time: ['2026-10-17', '2026-10-18'], wave_height_max: [99, 99] },
    };
}
