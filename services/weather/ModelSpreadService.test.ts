import { describe, it, expect } from 'vitest';
import { parseSuffixedHourly } from './ModelSpreadService';

const MODELS = [
    { id: 'dwd_icon', label: 'ICON', provider: 'DWD', hex: '#a78bfa' },
    { id: 'ecmwf_ifs025', label: 'ECMWF', provider: 'ECMWF', hex: '#38bdf8' },
    { id: 'jma_gsm', label: 'JMA', provider: 'JMA', hex: '#fb923c' },
];

describe('parseSuffixedHourly', () => {
    it('parses model-suffixed keys into per-model series with epoch-ms times', () => {
        const block = parseSuffixedHourly(
            {
                time: [1784523600, 1784527200],
                wind_speed_10m_dwd_icon: [19.5, 17.1],
                wind_speed_10m_ecmwf_ifs025: [12.5, 11.7],
            },
            ['wind_speed_10m'] as const,
            MODELS.slice(0, 2),
        );
        expect(block).not.toBeNull();
        expect(block!.times).toEqual([1784523600000, 1784527200000]);
        expect(block!.models).toHaveLength(2);
        expect(block!.models[0].id).toBe('dwd_icon');
        expect(block!.models[0].values.wind_speed_10m).toEqual([19.5, 17.1]);
        expect(block!.models[1].values.wind_speed_10m).toEqual([12.5, 11.7]);
    });

    it('fills missing variables with nulls but keeps the model if any variable has data', () => {
        const block = parseSuffixedHourly(
            {
                time: [1784523600],
                wind_speed_10m_dwd_icon: [19.5],
                // visibility key absent for dwd_icon entirely
            },
            ['wind_speed_10m', 'visibility'] as const,
            MODELS.slice(0, 1),
        );
        expect(block!.models[0].values.wind_speed_10m).toEqual([19.5]);
        expect(block!.models[0].values.visibility).toEqual([null]);
    });

    it('drops models whose every variable is null/absent (unsynced domain)', () => {
        const block = parseSuffixedHourly(
            {
                time: [1784523600, 1784527200],
                wind_speed_10m_dwd_icon: [19.5, 17.1],
                wind_speed_10m_jma_gsm: [null, null],
            },
            ['wind_speed_10m'] as const,
            [MODELS[0], MODELS[2]],
        );
        expect(block!.models.map((m) => m.id)).toEqual(['dwd_icon']);
    });

    it('returns null for an empty or absent hourly block', () => {
        expect(parseSuffixedHourly(undefined, ['wind_speed_10m'] as const, MODELS)).toBeNull();
        expect(parseSuffixedHourly({ time: [] }, ['wind_speed_10m'] as const, MODELS)).toBeNull();
    });

    it('normalises non-numeric values to null', () => {
        const block = parseSuffixedHourly(
            {
                time: [1784523600, 1784527200],
                wind_speed_10m_dwd_icon: [19.5, 'NaN'],
            },
            ['wind_speed_10m'] as const,
            MODELS.slice(0, 1),
        );
        expect(block!.models[0].values.wind_speed_10m).toEqual([19.5, null]);
    });
});
