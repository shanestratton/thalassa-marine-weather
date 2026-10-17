import { describe, expect, it } from 'vitest';
import {
    MARINE_HOURS,
    MARINE_WAVE_FIELDS,
    MARINE_MOTION_FIELDS,
    marineEnvelopeV2,
    marineFieldUnitV2,
    marineQueryV2,
    marineSourceV2,
    readMarineEnvelopeV2,
    type MarineKindV2,
} from '../supabase/functions/_shared/marine-v2';

const at = Date.UTC(2026, 9, 17, 0),
    point = { latitude: -27.1234, longitude: 153.4567 };
function source(kind: MarineKindV2 = 'waves') {
    const fields = kind === 'waves' ? MARINE_WAVE_FIELDS : MARINE_MOTION_FIELDS;
    const raw = {
        ...point,
        utc_offset_seconds: 0,
        current: { time: at / 1000, interval: 900 } as Record<string, unknown>,
        hourly: { time: [at / 1000, at / 1000 + 3600] } as Record<string, unknown>,
        current_units: { time: 'unixtime', interval: 'seconds' } as Record<string, string>,
        hourly_units: { time: 'unixtime' } as Record<string, string>,
    };
    for (const field of fields) {
        const value = field.endsWith('_period') ? 8 : field.endsWith('_direction') ? 270 : 1.2;
        raw.current[field] = value;
        raw.hourly[field] = [value, value + 0.1];
        raw.current_units[field] = marineFieldUnitV2(field);
        raw.hourly_units[field] = marineFieldUnitV2(field);
    }
    return raw;
}
describe('versioned marine contract', () => {
    it('keeps independent source cells, original valid times and immutable fetch receipt', () => {
        const waves = source(),
            motion = { ...source('motion'), latitude: -27.2 };
        const envelope = marineEnvelopeV2(point, at, waves, motion);
        const cached = readMarineEnvelopeV2(envelope, point, at + 300000)!;
        expect(cached.fetched_at_ms).toBe(at);
        expect(cached.waves?.latitude).toBe(point.latitude);
        expect(cached.motion?.latitude).toBe(-27.2);
        expect(cached.waves?.hourly.time).toEqual(waves.hourly.time);
        expect(cached.motion?.current.ocean_current_velocity).toBe(1.2);
        expect(cached.waves?.current.ocean_current_velocity).toBeUndefined();
    });
    it('pairs the wave query with a separately snap-checkable motion query', () => {
        const waves = marineQueryV2('waves', point),
            motion = marineQueryV2('motion', point);
        expect(waves.get('models')).toBe('meteofrance_wave');
        expect(motion.get('models')).toBe('best_match');
        expect(waves.get('hourly')).not.toContain('ocean_current');
        expect(motion.get('hourly')).toContain('sea_surface_temperature');
        expect(motion.get('hourly')).toContain('ocean_current_velocity');
        expect(waves.get('hourly')).not.toContain('secondary_swell_wave_peak_period');
        expect(waves.get('timezone')).toBe('UTC');
        expect(waves.get('timeformat')).toBe('unixtime');
        expect(waves.get('forecast_days')).toBe('10');
        expect(waves.get('latitude')).toBe('-27.1234');
    });
    it.each(['current', 'hourly'] as const)('does not convert or borrow a number with wrong %s units', (kind) => {
        const raw = source('motion');
        raw[(kind + '_units') as 'current_units'].ocean_current_velocity = 'm/s';
        const admitted = marineSourceV2(raw, 'motion')!;
        expect(
            kind === 'current' ? admitted.current.ocean_current_velocity : admitted.hourly.ocean_current_velocity,
        ).toEqual(kind === 'current' ? null : [null, null]);
    });
    it('retains partial independent replies rather than borrowing wave data for currents', () => {
        const envelope = marineEnvelopeV2(point, at, source(), null);
        expect(envelope.waves).not.toBeNull();
        expect(envelope.motion).toBeNull();
    });
    it.each([NaN, Infinity, -1, 51, '2', undefined])('keeps an invalid height unknown: %s', (value) => {
        const raw = source();
        raw.current.wave_height = value;
        expect(marineSourceV2(raw, 'waves')?.current.wave_height).toBeNull();
    });
    it('refuses the measured zero-height/zero-period/zero-direction land mask', () => {
        const raw = source();
        for (const field of ['wave_height', 'wave_period', 'wave_direction']) {
            raw.current[field] = 0;
            raw.hourly[field] = [0, 1];
        }
        const admitted = marineSourceV2(raw, 'waves')!;
        expect(admitted.current.wave_height).toBeNull();
        expect(admitted.hourly.wave_height?.[0]).toBeNull();
        expect(admitted.hourly.wave_height?.[1]).toBe(1);
    });
    it.each(['offset', 'duplicate', 'gap', 'oversize', 'units', 'current clock', 'interval units'])(
        'refuses unprovable original source clocks: %s',
        (mode) => {
            const raw = source();
            if (mode === 'offset') raw.utc_offset_seconds = 3600;
            if (mode === 'duplicate') raw.hourly.time = [at / 1000, at / 1000];
            if (mode === 'gap') raw.hourly.time = [at / 1000, at / 1000 + 7200];
            if (mode === 'oversize')
                raw.hourly.time = Array.from({ length: MARINE_HOURS + 1 }, (_, i) => at / 1000 + i * 3600);
            if (mode === 'units') raw.hourly_units.time = 'iso8601';
            if (mode === 'current clock') raw.current.time = '2026-10-17T00:00';
            if (mode === 'interval units') raw.current_units.interval = 'minutes';
            expect(marineSourceV2(raw, 'waves')).toBeNull();
        },
    );
    it.each(['legacy', 'other model', 'other point', 'old fetch', 'future fetch'])(
        'refuses mixed or stale cache context: %s',
        (mode) => {
            const value = marineEnvelopeV2(point, at, source(), null) as unknown as Record<string, unknown>;
            if (mode === 'legacy') delete value.marine_schema;
            if (mode === 'other model') value.wave_model = 'best_match';
            if (mode === 'other point') value.requested = { ...point, latitude: point.latitude + 0.01 };
            if (mode === 'old fetch') value.fetched_at_ms = at - 3600001;
            if (mode === 'future fetch') value.fetched_at_ms = at + 5001;
            expect(readMarineEnvelopeV2(value, point, at)).toBeNull();
        },
    );
});
