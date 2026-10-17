import { describe, expect, it } from 'vitest';
import { mapMarineModelV2, MARINE_CURRENT_MAX_AGE_MS } from '../services/weather/marineModelV2';
import { marineEnvelopeV2 } from '../supabase/functions/_shared/marine-v2';
import { marineFixtureSource, MARINE_FIXTURE_AT as at, MARINE_FIXTURE_POINT as point } from './fixtures/marineV2141';

const value = () => marineEnvelopeV2(point, at, marineFixtureSource('waves'), marineFixtureSource('motion'));
describe('pure model-to-report marine boundary', () => {
    it('converts heights once, preserves all partitions and independently preserves SST/current', () => {
        const result = mapMarineModelV2(value(), point, at, 'pi')!;
        expect(result.current).toMatchObject({
            waveHeight: 4.92,
            wavePeriod: 8,
            waveDirection: 270,
            windWaveHeight: 2.3,
            windWavePeriod: 4,
            windWaveDirection: 240,
            swellHeight: 3.94,
            swellPeriod: 10,
            swellDirection: 280,
            secondarySwellHeight: 0.98,
            secondarySwellPeriod: 12,
            secondarySwellDirection: 90,
            waterTemperature: 21,
            currentSpeed: 1,
            currentDirection: 45,
        });
        expect(result.hourly[0]).toMatchObject({ timeMs: at, waveHeight: 4.92, currentSpeed: 1 });
        expect(result.fetchedAtMs).toBe(at);
        expect(result.waveCurrentAtMs).toBe(at);
        expect(result.motionCurrentAtMs).toBe(at);
        expect(result.via).toBe('pi');
        expect(result.waveModel).toBe('meteofrance_wave');
    });
    it('refuses a distant wave cell without losing the independently local motion cell', () => {
        const raw = value();
        raw.waves!.longitude += 1;
        const result = mapMarineModelV2(raw, point, at, 'supabase')!;
        expect(result.waveCell?.local).toBe(false);
        expect(result.motionCell?.local).toBe(true);
        expect(result.current.waveHeight).toBeNull();
        expect(result.current.waterTemperature).toBe(21);
        expect(result.current.currentSpeed).toBe(1);
        expect(result.hourly.every((hour) => hour.waveHeight === null)).toBe(true);
    });
    it('refuses a distant motion cell without borrowing SST/current from wave output', () => {
        const raw = value();
        raw.motion!.latitude += 1;
        const result = mapMarineModelV2(raw, point, at, 'pi')!;
        expect(result.current.waveHeight).toBe(4.92);
        expect(result.current.currentSpeed).toBeNull();
        expect(result.current.waterTemperature).toBeNull();
    });
    it('returns no local reading when both cells are too distant', () => {
        const raw = value();
        raw.waves!.longitude += 1;
        raw.motion!.latitude += 1;
        expect(mapMarineModelV2(raw, point, at, 'pi')).toBeNull();
    });
    it('keeps actual hourly instants when the independent series begin at different hours', () => {
        const raw = value();
        raw.motion!.hourly.time = raw.motion!.hourly.time.map((time) => time + 3600);
        const hours = mapMarineModelV2(raw, point, at, 'pi')!.hourly;
        expect(hours.map((hour) => hour.timeMs)).toEqual([at, at + 3600000, at + 7200000]);
        expect(hours[0].waterTemperature).toBeNull();
        expect(hours[0].waveHeight).toBe(4.92);
        expect(hours[2].waveHeight).toBeNull();
        expect(hours[2].waterTemperature).toBe(21);
    });
    it.each(['stale', 'future'] as const)(
        'refuses %s original current time without relabelling hourly forecasts',
        (mode) => {
            const raw = value();
            raw.waves!.current.time = (at + (mode === 'stale' ? -MARINE_CURRENT_MAX_AGE_MS - 1000 : 301000)) / 1000;
            const result = mapMarineModelV2(raw, point, at, 'pi')!;
            expect(result.waveCurrentAtMs).toBeNull();
            expect(result.current.waveHeight).toBeNull();
            expect(result.hourly[0].timeMs).toBe(at);
            expect(result.hourly[0].waveHeight).toBe(4.92);
            expect(result.motionCurrentAtMs).toBe(at);
            expect(result.current.waterTemperature).toBe(21);
        },
    );
    it('does not turn missing or wrongly-unit data into calm/zero or fill it from another sample', () => {
        const raw = value();
        raw.waves!.current_units.wave_height = 'ft';
        raw.motion!.current_units.ocean_current_velocity = 'm/s';
        const result = mapMarineModelV2(raw, point, at, 'pi')!;
        expect(result.current.waveHeight).toBeNull();
        expect(result.current.currentSpeed).toBeNull();
        expect(result.hourly[0].waveHeight).toBe(4.92);
        expect(result.hourly[0].currentSpeed).toBe(1);
    });
    it('retains an original cache receipt instead of restamping it at a later read', () => {
        const raw = value();
        const result = mapMarineModelV2(raw, point, at + 600000, 'pi')!;
        expect(result.fetchedAtMs).toBe(at);
        expect(result.waveCurrentAtMs).toBe(at);
        expect(result.hourly[0].timeMs).toBe(at);
    });
});
