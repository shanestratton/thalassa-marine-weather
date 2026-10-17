import { describe, expect, it } from 'vitest';
import { agreementByDay } from '../components/dashboard/ModelComparisonMatrix';
import { agreementChipWords } from '../components/dashboard/hero/DailySummaryCard';
import { scalarAgreementForDays, weatherAgreementByDay } from '../services/weather/dayAgreement';
import type { AtmosVar, MarineVar, ModelSpreadResult, SpreadBlock } from '../services/weather/ModelSpreadService';

const HOUR = 3_600_000;
const START = Date.UTC(2026, 9, 23);
function block<V extends string>(variable: V, values: number[], length = 96): SpreadBlock<V> {
    return {
        times: Array.from({ length }, (_, i) => START + i * HOUR),
        models: values.map((value, i) => ({
            id: `model${i}`,
            label: `Model ${i}`,
            provider: 'Fixture',
            hex: '#fff',
            values: { [variable]: Array.from({ length }, () => value) } as Record<V, (number | null)[]>,
        })),
    };
}
function spread(): ModelSpreadResult {
    const atmos = block<AtmosVar>('wind_speed_10m', [12, 13, 14, 14, 13, 12, 12]);
    for (const model of atmos.models) {
        model.values.wind_direction_10m = atmos.times.map(() => 240);
        model.values.precipitation = atmos.times.map(() => 0);
    }
    return { atmos, marine: block<MarineVar>('wave_height', [1.5, 1.6, 1.5, 1.6]) };
}
const wholeDay = (value: ModelSpreadResult) => weatherAgreementByDay(value, 'UTC')[1];

describe('141 weather agreement uses real independent daily cohorts', () => {
    it('adds wave and rain without inventing one shared seven-member count', () => {
        const verdict = wholeDay(spread());
        expect(verdict).toMatchObject({ level: 'agree', members: 7, driver: 'wind', whole: true });
        expect(verdict.components).toMatchObject([
            { metric: 'wind', members: 7, level: 'agree' },
            { metric: 'rain', members: 7, level: 'agree' },
            { metric: 'wave', members: 4, level: 'agree', thin: false },
        ]);
    });

    it('wave disagreement wins over agreeing wind and opens the actual four-member cause', () => {
        const input = spread();
        input.marine!.models[0].values.wave_height.fill(3);
        const verdict = wholeDay(input);
        expect(verdict).toMatchObject({ level: 'split', members: 4, peak: 4, driver: 'wave' });
        const words = agreementChipWords(verdict);
        expect(words.count).toBe('4 wave');
        expect(words.spoken).toContain('wind: models agree, 7 models');
        expect(words.spoken).toContain('waves: models split, 4 models');
    });

    it('rain uses mean hourly water-equivalent spread, not mixed daily totals', () => {
        const input = spread();
        input.atmos!.models[0].values.precipitation.fill(2.1);
        expect(wholeDay(input)).toMatchObject({ driver: 'rain', level: 'split', members: 7 });
        input.atmos!.models[0].values.precipitation.fill(2);
        expect(wholeDay(input)).toMatchObject({ driver: 'rain', level: 'some' });
    });

    it('licensed display-only series cannot vote or change any metric cohort', () => {
        const input = spread();
        input.atmos!.models[0].displayOnly = true;
        input.atmos!.models[0].values.precipitation.fill(99);
        input.marine!.models[0].displayOnly = true;
        input.marine!.models[0].values.wave_height.fill(99);
        expect(wholeDay(input).components).toMatchObject([
            { members: 6, level: 'agree' },
            { members: 6, level: 'agree' },
            { members: 3, level: 'agree' },
        ]);
    });

    it('missing/one-model metrics stay unknown and do not vote agree', () => {
        const input = spread();
        input.marine!.models = input.marine!.models.slice(0, 1);
        for (const model of input.atmos!.models) model.values.precipitation.fill(null);
        const verdict = wholeDay(input);
        expect(verdict.components).toMatchObject([
            { level: 'agree' },
            { level: null, members: 0 },
            { level: null, members: 1 },
        ]);
        expect(agreementChipWords(verdict)).toMatchObject({
            words: 'Wind agrees',
            spoken: 'Wind: models agree, 7 models',
        });
    });

    it('a fresh unavailable-leg receipt supersedes contradictory payload data', () => {
        const input = spread();
        input.unreachable = ['marine'];
        input.marine!.models[0].values.wave_height.fill(9);
        expect(wholeDay(input).components[2]).toMatchObject({ members: 0, level: null });
    });

    it('marine-only answers retain actual local bounds, without invented wind agreement', () => {
        const input = spread();
        input.atmos = null;
        const verdict = wholeDay(input);
        expect(verdict).toMatchObject({ level: 'agree', driver: 'wave', members: 4, whole: true });
        expect(verdict.components[0].level).toBeNull();
        expect(agreementChipWords(verdict).spoken).toContain('wind: insufficient complete-day models');
    });

    it('partial marine days are not aligned to a different atmospheric interval', () => {
        const input = spread();
        input.marine!.times = input.marine!.times.slice(0, 30);
        for (const model of input.marine!.models) model.values.wave_height = model.values.wave_height.slice(0, 30);
        const verdict = wholeDay(input);
        expect(verdict.components[2]).toMatchObject({ level: null, members: 0 });
    });

    it('requires complete hours for each rain/wave member and matches actual comparison bars', () => {
        const series = [
            { id: 'a', label: 'A', provider: 'Fixture', hex: '#fff', values: [0, 0, 0, 0] },
            { id: 'b', label: 'B', provider: 'Fixture', hex: '#fff', values: [3, 3, 3, 3] },
            { id: 'c', label: 'C', provider: 'Fixture', hex: '#fff', values: [20, null, 20, 20] },
        ];
        for (const metric of ['rain', 'wave'] as const) {
            const verdict = scalarAgreementForDays(series, [], 4, metric)[0];
            const bar = agreementByDay(series, [], 4, metric)[0];
            expect(verdict).toMatchObject({ members: 2, spread: 3, level: 'split' });
            expect(bar).toMatchObject({ members: 2, variance: 3, level: 'low' });
        }
    });

    it('NaN, negatives and an ended model are gaps, while measured zero remains valid', () => {
        for (const bad of [NaN, -1, null, undefined]) {
            const series = [
                { id: 'a', values: [0, 0] },
                { id: 'b', values: [0, bad] },
            ];
            expect(scalarAgreementForDays(series as never, [], 2, 'wave')[0]).toMatchObject({
                members: 1,
                level: null,
            });
        }
        expect(
            scalarAgreementForDays(
                [
                    { id: 'a', values: [0] },
                    { id: 'b', values: [0] },
                ],
                [],
                1,
                'rain',
            )[0].level,
        ).toBe('agree');
    });

    it('clocks-back uses the actual 25-hour local day for all metrics', () => {
        const verdicts = weatherAgreementByDay(spread(), 'Europe/Paris');
        const sunday = verdicts.find((day) => day.date === '2026-10-25')!;
        expect(sunday.endMs - sunday.startMs).toBe(25 * HOUR);
        expect(sunday.components.every((component) => component.level === 'agree')).toBe(true);
    });

    it('missing all legs is an empty result, never a green chip', () => {
        expect(weatherAgreementByDay({ atmos: null, marine: null }, 'UTC')).toEqual([]);
    });

    it('a lone marine model is honestly scoped, never called agreement', () => {
        const input = spread();
        input.atmos = null;
        input.marine!.models = input.marine!.models.slice(0, 1);
        const verdict = wholeDay(input);
        expect(verdict).toMatchObject({ members: 1, level: null, driver: 'wave' });
        expect(agreementChipWords(verdict).spoken).toBe('Waves: only 1 model reaches this day, nothing to compare');
    });
});
