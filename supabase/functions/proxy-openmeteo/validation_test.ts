import { assert, assertEquals } from 'jsr:@std/assert@1';
import { FORECAST_HOURLY, PRESSURE_LEVEL_HOURLY, validateRequest } from './validation.ts';

/**
 * The sounding sheet's pressure levels (build 125, SND): ECMWF's seven synced
 * levels × temperature, humidity, height and wind. The allowlist grows by
 * exactly these 35 names, the 32-name cap per call stands (the app splits its
 * request in two), and everything else stays refused.
 */
const LEVELS = [1000, 925, 850, 700, 500, 300, 250];
const VARIABLES = ['temperature', 'relative_humidity', 'geopotential_height', 'wind_speed', 'wind_direction'];
const EXPECTED = LEVELS.flatMap((p) => VARIABLES.map((v) => `${v}_${p}hPa`));

const SURFACE = ['temperature_2m', 'dew_point_2m', 'pressure_msl', 'wind_speed_10m', 'wind_direction_10m', 'cape'];
const atLevels = (names: string[]) => LEVELS.flatMap((p) => names.map((v) => `${v}_${p}hPa`));
const THERMO = atLevels(['temperature', 'relative_humidity', 'geopotential_height']);
const WIND = atLevels(['wind_speed', 'wind_direction']);

function sounding(hourly: string[], extra: Record<string, unknown> = {}) {
    return {
        latitude: 38.5,
        longitude: -28.75,
        hourly: hourly.join(','),
        models: 'ecmwf_ifs025',
        forecast_hours: 76,
        timezone: 'auto',
        timeformat: 'unixtime',
        cell_selection: 'nearest',
        ...extra,
    };
}

Deno.test('the pressure-level allowlist is exactly the 35 names the sounding asks for', () => {
    assertEquals([...PRESSURE_LEVEL_HOURLY].sort(), [...EXPECTED].sort());
    assertEquals(PRESSURE_LEVEL_HOURLY.size, 35);
    for (const name of EXPECTED) assert(FORECAST_HOURLY.has(name), name);
});

Deno.test("the sounding's two calls pass as the app sends them", () => {
    const first = validateRequest('forecast', sounding([...SURFACE, ...THERMO]));
    assert(first, 'surface + temperature/humidity/height');
    assertEquals(first.hourly.split(',').length, 27);
    assertEquals(first.models, 'ecmwf_ifs025');
    assertEquals(first.cell_selection, 'nearest');
    const second = validateRequest('forecast', sounding(WIND));
    assert(second, 'winds at the seven levels');
    assertEquals(second.hourly.split(',').length, 14);
});

Deno.test('other pressure-level names, levels and spellings are still refused', () => {
    for (
        const name of [
            'temperature_600hPa',
            'temperature_200hPa',
            'wind_u_component_850hPa',
            'wind_v_component_850hPa',
            'vertical_velocity_500hPa',
            'cloud_cover_850hPa',
            'temperature_850hpa',
            'Temperature_850hPa',
            'surface_pressure_850hPa',
        ]
    ) {
        assertEquals(validateRequest('forecast', sounding(['temperature_2m', name])), null, name);
    }
    // Hourly only: the current block and the marine endpoint never take them.
    assertEquals(
        validateRequest('forecast', { latitude: 1, longitude: 2, current: 'temperature_850hPa' }),
        null,
    );
    assertEquals(validateRequest('marine', sounding(['temperature_850hPa'], { models: 'ecmwf_wam025' })), null);
});

Deno.test('the 32-name cap per call still holds', () => {
    assertEquals(validateRequest('forecast', sounding([...SURFACE, ...THERMO, ...WIND.slice(0, 6)])), null);
});

Deno.test('the requests the app already sends are unchanged', () => {
    const point = validateRequest('forecast', {
        latitude: '-27.4000',
        longitude: '153.1000',
        hourly: 'temperature_2m,wind_speed_10m,wind_gusts_10m,pressure_msl',
        models: 'dwd_icon',
        forecast_days: 7,
        timezone: 'auto',
    });
    assert(point);
    assertEquals(point.hourly, 'temperature_2m,wind_speed_10m,wind_gusts_10m,pressure_msl');
    assertEquals(validateRequest('forecast', sounding(['not_a_variable'])), null);
});
