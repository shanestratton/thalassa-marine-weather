/** Fictional provider-shaped members; never a recorded/published weather forecast. */
export const ENSEMBLE_FIXTURE_NOW = Date.UTC(2026, 9, 17, 12);
export function ensembleFixture(hours = 4) {
    const hourly: Record<string, unknown> = {
        time: Array.from({ length: hours }, (_, i) => Date.UTC(2026, 9, 17, i * 3) / 1000),
    };
    const hourly_units: Record<string, string> = { time: 'unixtime' };
    for (let member = 0; member < 51; member++) {
        for (const variable of ['wind_speed_10m', 'wind_gusts_10m']) {
            const key = `${variable}${member ? `_member${String(member).padStart(2, '0')}` : ''}`;
            hourly[key] = Array.from({ length: hours }, (_, i) => member + i);
            hourly_units[key] = 'kn';
        }
    }
    return { latitude: -27, longitude: 153, utc_offset_seconds: 0, hourly, hourly_units };
}
