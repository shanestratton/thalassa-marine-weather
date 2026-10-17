/** Fictional provider samples with explicit units and original UTC clocks. */
export const MARINE_FIXTURE_AT = Date.UTC(2026, 9, 17, 0);
export const MARINE_FIXTURE_POINT = { latitude: -27.1234, longitude: 153.4567 };
export function marineFixtureSource(kind: 'waves' | 'motion', at = MARINE_FIXTURE_AT) {
    const values =
        kind === 'waves'
            ? {
                  wave_height: 1.5,
                  wave_period: 8,
                  wave_direction: 270,
                  wind_wave_height: 0.7,
                  wind_wave_period: 4,
                  wind_wave_direction: 240,
                  swell_wave_height: 1.2,
                  swell_wave_period: 10,
                  swell_wave_direction: 280,
                  secondary_swell_wave_height: 0.3,
                  secondary_swell_wave_period: 12,
                  secondary_swell_wave_direction: 90,
              }
            : { sea_surface_temperature: 21, ocean_current_velocity: 3.6, ocean_current_direction: 45 };
    const units: Record<string, string> = {
        wave_height: 'm',
        wave_period: 's',
        wave_direction: '°',
        wind_wave_height: 'm',
        wind_wave_period: 's',
        wind_wave_direction: '°',
        swell_wave_height: 'm',
        swell_wave_period: 's',
        swell_wave_direction: '°',
        secondary_swell_wave_height: 'm',
        secondary_swell_wave_period: 's',
        secondary_swell_wave_direction: '°',
        sea_surface_temperature: '°C',
        ocean_current_velocity: 'km/h',
        ocean_current_direction: '°',
    };
    return {
        ...MARINE_FIXTURE_POINT,
        utc_offset_seconds: 0,
        current: { time: at / 1000, interval: 900, ...values },
        hourly: {
            time: [at / 1000, at / 1000 + 3600],
            ...Object.fromEntries(Object.entries(values).map(([key, value]) => [key, [value, value]])),
        },
        current_units: {
            time: 'unixtime',
            interval: 'seconds',
            ...Object.fromEntries(Object.keys(values).map((key) => [key, units[key]])),
        },
        hourly_units: { time: 'unixtime', ...Object.fromEntries(Object.keys(values).map((key) => [key, units[key]])) },
    };
}
