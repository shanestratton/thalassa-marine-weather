import { describe, expect, it } from 'vitest';
import {
    decodeIssuedSkill,
    exactIssuedModelScore,
    SKILL_LEADS,
    type SkillLead,
    type SkillMetric,
} from '../services/weather/modelSkill';

const NOW = 1792211403;
const station = 'ndbc:46026';
function fixture(lead: SkillLead = '0-6h', metric: SkillMetric = 'wind_speed_mps') {
    const hour = { '0-6h': 4, '6-24h': 18, '24-48h': 36, '48-72h': 60 }[lead];
    const keys = metric === 'wind_speed_mps' ? ['ecmwf_ifs025', 'dwd_icon'] : ['ecmwf_wam025', 'meteofrance_wave'];
    return {
        schema: 1,
        basis: 'forward-captured',
        station,
        metric,
        lead,
        windowStart: NOW - 14 * 86400,
        windowEnd: NOW,
        status: 'ready',
        closest: keys[0],
        tiedModels: [] as string[],
        effectiveNMethod: 'hourly-lag1-conservative',
        automaticModelSelection: false,
        models: Object.fromEntries(
            keys.map((id, index) => [
                id,
                { pairs: 100, effectiveN: 31, spanHours: 240, status: 'ready', mae: 1 + index, medianLeadHours: hour },
            ]),
        ),
    };
}
function decode(value = fixture(), lead: SkillLead = '0-6h', metric: SkillMetric = 'wind_speed_mps') {
    return decodeIssuedSkill(value, station, metric, lead, NOW);
}

describe('honest own-server issued skill boundary', () => {
    it.each(SKILL_LEADS)('keeps wind and wave %s leads separate with their actual source domains', (lead) => {
        for (const metric of ['wind_speed_mps', 'wave_hs_m'] as const) {
            const row = decode(fixture(lead, metric), lead, metric);
            expect(row.status).toBe('ready');
            expect(row.lead).toBe(lead);
            expect(row.metric).toBe(metric);
            expect(Object.isFrozen(row.models)).toBe(true);
            expect(Object.isFrozen(Object.values(row.models)[0])).toBe(true);
            expect(() =>
                decode(fixture(lead, metric), lead, metric === 'wave_hs_m' ? 'wind_speed_mps' : 'wave_hs_m'),
            ).toThrow();
        }
    });
    it('never applies IFS 0.25 degree scores to 9 km, Auto, an alias or the marine feed', () => {
        const row = decode();
        expect(exactIssuedModelScore(row, 'ecmwf_ifs025')?.effectiveN).toBe(31);
        for (const id of ['ecmwf_ifs', 'ecmwf', 'auto', 'sg', 'best_match', 'ecmwf_wam025', 'ECMWF', '__proto__']) {
            expect(exactIssuedModelScore(row, id)).toBeNull();
        }
    });
    it('keeps genuinely empty initial evidence warming without a model, MAE or invented vote', () => {
        const raw = { ...fixture(), models: {}, status: 'warming', closest: null };
        const row = decode(raw as unknown as ReturnType<typeof fixture>);
        expect(row.status).toBe('warming');
        expect(row.closest).toBeNull();
        expect(row.models).toEqual({});
        expect(exactIssuedModelScore(row, 'ecmwf_ifs025')).toBeNull();
    });
    it.each([29, 0, -1, 100.5, 101])('refuses unqualified or inflated effective sample count %s', (n) => {
        const raw = fixture();
        raw.models.ecmwf_ifs025.effectiveN = n;
        expect(() => decode(raw)).toThrow();
    });
    it('requires the ten-day evidence span independently of pair count', () => {
        const raw = fixture();
        raw.models.ecmwf_ifs025.spanHours = 239;
        expect(() => decode(raw)).toThrow();
    });
    it('refuses a forged named winner or alphabetical tie breaker', () => {
        const raw = fixture();
        raw.closest = 'dwd_icon';
        expect(() => decode(raw)).toThrow();
        raw.closest = 'ecmwf_ifs025';
        raw.models.dwd_icon.mae = 1;
        expect(() => decode(raw)).toThrow();
        const tie = { ...raw, closest: null, tiedModels: ['dwd_icon', 'ecmwf_ifs025'] };
        const row = decode(tie as unknown as ReturnType<typeof fixture>);
        expect(row.closest).toBeNull();
        expect(row.tiedModels).toEqual(['dwd_icon', 'ecmwf_ifs025']);
    });
    it('does not compare independently selected valid-hour cohorts', () => {
        const raw = fixture();
        raw.models.dwd_icon.pairs = 99;
        expect(() => decode(raw)).toThrow();
        raw.models.dwd_icon.pairs = 100;
        raw.models.dwd_icon.spanHours = 241;
        expect(() => decode(raw)).toThrow();
    });
    it.each(['retrospective', 'best_match-past-days', 'own-boat-subjective'])(
        'refuses %s as issued forecast skill',
        (basis) => {
            expect(() => decode({ ...fixture(), basis })).toThrow();
        },
    );
    it('rejects future/changed scoring windows and unsupported models or guessed fields', () => {
        const raw = fixture();
        expect(() => decode({ ...raw, windowEnd: NOW + 1 })).toThrow();
        expect(() => decode({ ...raw, windowStart: NOW - 15 * 86400 })).toThrow();
        expect(() => decode({ ...raw, automaticModelSelection: true })).toThrow();
        expect(() => decode({ ...raw, safetyScore: 10 } as ReturnType<typeof fixture>)).toThrow();
        const unknown = fixture();
        unknown.models.ecmwf_ifs = unknown.models.ecmwf_ifs025;
        delete unknown.models.ecmwf_ifs025;
        expect(() => decode(unknown)).toThrow();
    });
    it('refuses a warming MAE or out-of-bin lead instead of silently clipping it', () => {
        const raw = fixture();
        raw.models.ecmwf_ifs025.status = 'warming';
        expect(() => decode(raw)).toThrow();
        raw.models.ecmwf_ifs025.status = 'ready';
        raw.models.ecmwf_ifs025.medianLeadHours = 6.1;
        expect(() => decode(raw)).toThrow();
    });
});
