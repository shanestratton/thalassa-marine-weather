import { describe, expect, it } from 'vitest';
import { parseEnsembleForecast, reduceEnsemble } from '../utils/ensembleForecast';
import { ensembleFixture, ENSEMBLE_FIXTURE_NOW as now } from './fixtures/ensemble142';

const sha = 'a'.repeat(64);
const reduce = (value: unknown) => reduceEnsemble(value, 'ifs', -27, 153, now, sha);
describe('142 genuine ensemble reduction', () => {
    it('computes type7 quantiles and inclusive exceedance over 51 real member IDs', () => {
        const data = reduce(ensembleFixture());
        expect(data.hours[0].wind).toEqual({ count: 51, p10: 5, p50: 25, p90: 45, exceeding: 26 });
        expect(data).toMatchObject({
            issuedAt: null,
            receivedAt: now,
            rawSha256: sha,
            unit: 'kn',
            expectedMembers: 51,
        });
        expect(parseEnsembleForecast(data, 'ifs', -27, 153, now)).toEqual(data);
    });
    it('counts finite members per variable/hour and leaves insufficient hours unshaded', () => {
        const value = ensembleFixture();
        for (let n = 1; n <= 11; n++)
            (value.hourly[`wind_speed_10m_member${String(n).padStart(2, '0')}`] as unknown[])[0] = null;
        const data = reduce(value);
        expect(data.hours[0].wind).toEqual({ count: 40, p10: null, p50: null, p90: null, exceeding: null });
        expect(data.hours[0].gust.count).toBe(51);
        expect(data.hours[1].wind.count).toBe(51);
    });
    it('uses 41 as a visible minimum and the available denominator rather than invented 51', () => {
        const value = ensembleFixture();
        for (let n = 1; n <= 10; n++)
            (value.hourly[`wind_speed_10m_member${String(n).padStart(2, '0')}`] as unknown[])[0] = null;
        expect(reduce(value).hours[0].wind).toMatchObject({ count: 41, p50: 30, exceeding: 26 });
    });
    it.each(['knots', 'km/h', 'm/s'])('refuses unexpected units %s', (unit) => {
        const value = ensembleFixture();
        value.hourly_units.wind_speed_10m = unit;
        expect(() => reduce(value)).toThrow();
    });
    it('refuses aliased control identities and illegal/malformed member suffixes', () => {
        for (const key of ['wind_speed_10m_member00', 'wind_speed_10m_member51', 'wind_speed_10m_member1']) {
            const value = ensembleFixture();
            value.hourly[key] = [0, 0, 0, 0];
            value.hourly_units[key] = 'kn';
            expect(() => reduce(value)).toThrow();
        }
    });
    it('does not manufacture an ensemble from deterministic or mean-only columns', () => {
        const value = ensembleFixture();
        Object.keys(value.hourly)
            .filter((key) => key.includes('_member'))
            .forEach((key) => delete value.hourly[key]);
        expect(() => reduce(value)).toThrow();
    });
    it.each([Infinity, NaN, -1, 251, '25'])('refuses malformed member value %s', (v) => {
        const value = ensembleFixture();
        (value.hourly.wind_speed_10m as unknown[])[0] = v;
        expect(() => reduce(value)).toThrow();
    });
    it('refuses misaligned lengths, duplicate/decreasing clocks, stale day, wrong point and excessive fields', () => {
        const mutations = [
            (v: ReturnType<typeof ensembleFixture>) => {
                v.hourly.wind_speed_10m = [1];
            },
            (v: ReturnType<typeof ensembleFixture>) => {
                (v.hourly.time as number[])[1] = (v.hourly.time as number[])[0];
            },
            (v: ReturnType<typeof ensembleFixture>) => {
                (v.hourly.time as number[])[0] -= 86400;
            },
            (v: ReturnType<typeof ensembleFixture>) => {
                v.latitude = 40;
            },
            (v: ReturnType<typeof ensembleFixture>) => {
                for (let i = 0; i < 20; i++) v.hourly[`extra${i}`] = [];
            },
        ];
        mutations.forEach((mutate) => {
            const value = ensembleFixture();
            mutate(value);
            expect(() => reduce(value)).toThrow();
        });
    });
    it('refuses stale, future, mismatched or tampered reduced network envelopes', () => {
        const data = reduce(ensembleFixture());
        expect(parseEnsembleForecast(data, 'ec46', -27, 153, now)).toBeNull();
        expect(parseEnsembleForecast(data, 'ifs', -28, 153, now)).toBeNull();
        expect(parseEnsembleForecast(data, 'ifs', -27, 153, now + 1800001)).toBeNull();
        expect(parseEnsembleForecast(data, 'ifs', -27, 153, now - 60001)).toBeNull();
        data.hours[0].wind.exceeding = 52;
        expect(parseEnsembleForecast(data, 'ifs', -27, 153, now)).toBeNull();
    });
});
