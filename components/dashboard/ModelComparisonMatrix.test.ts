import { createElement } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('../../services/weather/ModelSpreadService', () => ({ queryModelSpread: vi.fn() }));
vi.mock('../../stores/LocationStore', () => ({ useLocationCoords: () => ({ lat: 51.5, lon: -0.1 }) }));

import { queryModelSpread, type ModelSpreadResult } from '../../services/weather/ModelSpreadService';
import { COMPARE_MODELS, ECCC_LICENCE_URL, WAVE_SPREAD_MODELS } from '../../services/weather/forecastModels';
import {
    ModelComparisonMatrix,
    sampleAt,
    circularSpread,
    seriesFor,
    chartPath,
    memberCounts,
    countRuns,
    localDayStarts,
    agreementByDay,
    nearTermAgreement,
    circularMean,
    intoWindow,
    type HourlySeries,
} from './ModelComparisonMatrix';

const H = 3600_000;

// ── Fictional ten-day spread: seven members, with each model's run
// ending where it did through the proxy at Fiji on 2026-10-07 (ICON 167 h,
// UKMO 155 h, GEM 227 h), and a ten-hour hole in GEM's run. ──

const T0 = Date.UTC(2026, 9, 7, 14); // 11:00 in Halifax (ADT, UTC-3)
const TIMES = Array.from({ length: 240 }, (_, i) => T0 + i * H);
const LAST: Record<string, number> = { dwd_icon: 166, ukmo_global_deterministic_10km: 154, gem_seamless: 226 };

function run(id: string, base: number, hole?: [number, number]): (number | null)[] {
    const last = LAST[id] ?? 239;
    return TIMES.map((_, i) =>
        i > last || (hole && i >= hole[0] && i <= hole[1]) ? null : base + 3 * Math.sin(i / 12),
    );
}

function fixtureSpread(): ModelSpreadResult {
    return {
        atmos: {
            times: TIMES,
            models: COMPARE_MODELS.map((m, k) => ({
                id: m.id,
                label: m.label,
                provider: m.provider,
                hex: m.hex,
                values: {
                    wind_speed_10m: run(m.id, 12 + k, m.id === 'gem_seamless' ? [100, 109] : undefined),
                    wind_direction_10m: run(m.id, 200 + 5 * k),
                    // Only UKMO and GFS publish visibility (metres).
                    visibility:
                        m.id === 'ukmo_global_deterministic_10km' || m.id === 'gfs_seamless'
                            ? run(m.id, 20_000)
                            : TIMES.map(() => null),
                    // Only GFS publishes UV.
                    uv_index: m.id === 'gfs_seamless' ? run(m.id, 5) : TIMES.map(() => null),
                } as never,
            })),
        },
        marine: {
            times: TIMES,
            models: WAVE_SPREAD_MODELS.map((m, k) => ({
                ...m,
                values: { wave_height: run(m.id, 1 + k / 10) } as never,
            })),
        },
    };
}

describe('sampleAt', () => {
    const times = [0, H, 2 * H, 3 * H];
    const values = [10, 20, 30, 40];

    it('picks the nearest hourly sample', () => {
        expect(sampleAt(times, values, H + 20 * 60_000)).toBe(20); // 1h20 → 1h
        expect(sampleAt(times, values, H + 40 * 60_000)).toBe(30); // 1h40 → 2h
    });

    it('returns null beyond 90 minutes of the series edge', () => {
        expect(sampleAt(times, values, 6 * H)).toBeNull();
        expect(sampleAt([], [], 0)).toBeNull();
    });

    it('propagates null samples', () => {
        expect(sampleAt(times, [10, null, 30, 40], H)).toBeNull();
    });
});

describe('circularSpread', () => {
    it('measures spread the short way around', () => {
        expect(circularSpread([350, 10])).toBe(20);
        expect(circularSpread([0, 180])).toBe(180);
        expect(circularSpread([90, 100, 110])).toBe(20);
    });

    it('is zero for a single value', () => {
        expect(circularSpread([123])).toBe(0);
    });
});

describe('seriesFor — every hour to ten days, not six columns', () => {
    it('keeps each model’s full hourly run on the block’s own clock', () => {
        const { times, series } = seriesFor(fixtureSpread(), 'wind');
        expect(times).toEqual(TIMES);
        expect(series.map((s) => s.id)).toEqual(COMPARE_MODELS.map((m) => m.id));
        for (const s of series) expect(s.values).toHaveLength(240);
    });

    it('leaves the hours a model lacks as gaps — never interpolated', () => {
        const gem = seriesFor(fixtureSpread(), 'wind').series.find((s) => s.id === 'gem_seamless')!;
        expect(gem.values.slice(100, 110).every((v) => v === null)).toBe(true);
        expect(gem.values[99]).not.toBeNull();
        expect(gem.values[110]).not.toBeNull();
        const icon = seriesFor(fixtureSpread(), 'wind').series.find((s) => s.id === 'dwd_icon')!;
        expect(icon.values.slice(167).every((v) => v === null)).toBe(true);
    });

    it('drops models that do not publish the metric, and converts units', () => {
        const { series } = seriesFor(fixtureSpread(), 'vis');
        expect(series.map((s) => s.id)).toEqual(['ukmo_global_deterministic_10km', 'gfs_seamless']);
        expect(series[1].values[0]).toBeCloseTo(20, 0); // metres → km
    });

    it('serves the wave tabs from the marine block', () => {
        expect(seriesFor(fixtureSpread(), 'wave').series.map((s) => s.id)).toEqual(WAVE_SPREAD_MODELS.map((m) => m.id));
        expect(seriesFor(null, 'wind')).toEqual({ times: [], series: [] });
    });
});

describe('chartPath', () => {
    const x = (t: number) => t / H;
    const y = (v: number) => v;

    it('lifts the pen across a missing hour instead of joining the ends', () => {
        expect(chartPath([0, H, 2 * H, 3 * H, 4 * H], [1, 2, null, 4, 5], x, y)).toBe(
            'M0.0 1.0L1.0 2.0M3.0 4.0L4.0 5.0',
        );
    });

    it('lifts the pen where hours are absent from the time axis', () => {
        expect(chartPath([0, H, 4 * H, 5 * H], [1, 2, 3, 4], x, y)).toBe('M0.0 1.0L1.0 2.0M4.0 3.0L5.0 4.0');
    });

    it('draws a lone hour as a dot rather than nothing', () => {
        expect(chartPath([0, H, 2 * H], [null, 3, null], x, y)).toBe('M1.0 3.0L1.0 3.0');
    });

    it('breaks a direction line where it wraps through north, never sweeping across the chart', () => {
        expect(chartPath([0, H, 2 * H, 3 * H], [340, 350, 10, 20], x, y, true)).toBe(
            'M0.0 340.0L1.0 350.0M2.0 10.0L3.0 20.0',
        );
        // A linear metric that jumps is still one line.
        expect(chartPath([0, H, 2 * H], [340, 350, 10], x, y)).toBe('M0.0 340.0L1.0 350.0L2.0 10.0');
    });
});

describe('member count', () => {
    it('drops visibly after day 7 as ICON and UKMO run out', () => {
        const { series } = seriesFor(fixtureSpread(), 'dir');
        const counts = memberCounts(series, 240);
        expect(counts[0]).toBe(7);
        expect(counts[24 * 8]).toBe(5);
        expect(countRuns(counts)).toEqual([
            { start: 0, end: 154, count: 7 },
            { start: 155, end: 166, count: 6 },
            { start: 167, end: 226, count: 5 },
            { start: 227, end: 239, count: 4 },
        ]);
    });

    it('counts a model’s gap hours out, not in', () => {
        const { series } = seriesFor(fixtureSpread(), 'wind');
        expect(memberCounts(series, 240)[105]).toBe(6);
    });
});

describe('localDayStarts — the location’s own days', () => {
    it('follows a clock change: the day the clocks go back has 25 hours (London)', () => {
        const t0 = Date.UTC(2026, 9, 20, 0);
        const times = Array.from({ length: 240 }, (_, i) => t0 + i * H);
        expect(localDayStarts(times, 'Europe/London')).toEqual([23, 47, 71, 95, 119, 144, 168, 192, 216]);
    });

    it('uses the place’s midnight, not the phone’s (Tokyo)', () => {
        const starts = localDayStarts(TIMES, 'Asia/Tokyo'); // T0 is 23:00 JST
        expect(starts[0]).toBe(1);
        expect(starts).toHaveLength(10);
        expect(starts[9]).toBe(217);
    });
});

describe('agreementByDay', () => {
    const steady = Array.from({ length: 72 }, () => 10);

    it('rates each local day by how far apart the models are', () => {
        const apart = steady.map((v, i) => (i >= 24 && i < 48 ? v + 10 : v));
        const series = [
            { id: 'a', label: 'A', provider: 'DWD', hex: '#fff', values: steady },
            { id: 'b', label: 'B', provider: 'NOAA', hex: '#000', values: apart },
        ];
        const days = agreementByDay(series, [24, 48], 72, 'wind');
        expect(days.map((d) => d.level)).toEqual(['high', 'low', 'high']);
        expect(days[1].variance).toBeCloseTo(10);
    });

    it('says nothing for a day with fewer than two members', () => {
        const short = steady.map((v, i) => (i < 48 ? v : null));
        const series = [
            { id: 'a', label: 'A', provider: 'DWD', hex: '#fff', values: steady },
            { id: 'b', label: 'B', provider: 'NOAA', hex: '#000', values: short },
        ];
        expect(agreementByDay(series, [24, 48], 72, 'wind')[2]).toEqual({
            variance: null,
            level: 'none',
            members: 1,
            thin: false,
        });
    });

    // Seven models 0.8 kt apart (4.8 kt range: amber), then only ECMWF, AIFS,
    // JMA and GFS on the last day (3.2 kt: green only because three are gone).
    const fanned = (hours: [number, number][]) =>
        COMPARE_MODELS.map((m, k) => ({
            id: m.id,
            label: m.label,
            provider: m.provider,
            hex: m.hex,
            values: Array.from({ length: 72 }, (_, i) =>
                hours.some(([a, b]) => i >= a && i < b) || [1, 2, 4, 5].includes(k) ? 10 + 0.8 * k : null,
            ),
        }));

    it('marks a day left with fewer than five members as thin, not as better agreement', () => {
        const days = agreementByDay(fanned([[0, 48]]), [24, 48], 72, 'wind');
        expect(days[0]).toMatchObject({ level: 'moderate', members: 7, thin: false });
        expect(days[2]).toMatchObject({ level: 'high', members: 4, thin: true });
    });

    it('does not call the four wave models thin: that is all there are', () => {
        const waves = fanned([[0, 72]])
            .slice(0, 4)
            .map((s) => ({ ...s, values: s.values.map((v) => (v == null ? null : v / 10)) }));
        expect(agreementByDay(waves, [24, 48], 72, 'wave').every((d) => !d.thin)).toBe(true);
    });
});

describe('nearTermAgreement — the headline covers the next three days', () => {
    const series = (late: number): HourlySeries[] =>
        [0, 1, 2].map((k) => ({
            id: `m${k}`,
            label: `M${k}`,
            provider: 'ECMWF',
            hex: '#fff',
            values: Array.from({ length: 240 }, (_, i) => 12 + (i < 200 ? 0.5 : late) * k),
        }));
    const times = Array.from({ length: 240 }, (_, i) => T0 + i * H);

    it('agrees when the next 72 hours agree, however far apart day nine is', () => {
        expect(nearTermAgreement(series(10), times, T0 + 20 * 60_000, 'wind')).toEqual({
            variance: 1,
            level: 'high',
        });
        expect(agreementByDay(series(10), [24 * 9], 240, 'wind')[1].level).toBe('low');
    });

    it('starts at now, not at the first hour of a half-hour-old answer', () => {
        expect(nearTermAgreement(series(10), times, T0 + 190 * H, 'wind')!.level).toBe('low');
    });

    it('has nothing to say about one model alone', () => {
        expect(nearTermAgreement(series(10).slice(0, 1), times, T0, 'wind')).toBeNull();
    });
});

describe('direction window — centred on the models, so a northerly stays whole', () => {
    it('finds the mean bearing the short way round north', () => {
        const mean = circularMean([350, 10, 355, 5]);
        expect(Math.min(mean, 360 - mean)).toBeLessThan(1e-6);
        expect(circularMean([80, 100])).toBeCloseTo(90);
        expect(circularMean([])).toBe(180);
    });

    it('places each bearing in its 360° window', () => {
        expect(intoWindow(350, -180)).toBe(-10);
        expect(intoWindow(10, -180)).toBe(10);
        expect(intoWindow(-90, 0)).toBe(270);
        expect(intoWindow(720, 0)).toBe(0);
    });
});

describe('ModelComparisonMatrix — the ten-day sheet', () => {
    beforeEach(() => {
        vi.mocked(queryModelSpread).mockResolvedValue(fixtureSpread());
        // Half an hour after the answer's first hour, as a fresh fetch would be.
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(T0 + 30 * 60_000);
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    /** The sheet's atmospheric block with one variable replaced, each model's
     *  run still ending where it did (ICON 167 h, UKMO 155 h, GEM 227 h). */
    function withAtmos(variable: string, values: (k: number) => number[]): ModelSpreadResult {
        const spread = fixtureSpread();
        spread.atmos!.models.forEach((m, k) => {
            (m.values as Record<string, (number | null)[]>)[variable] = values(k).map((v, i) =>
                i > (LAST[m.id] ?? 239) ? null : v,
            );
        });
        return spread;
    }

    async function open(selectedModel = 'ecmwf_ifs025') {
        render(
            createElement(ModelComparisonMatrix, {
                visible: true,
                onClose: vi.fn(),
                selectedModel: selectedModel as never,
                coordinates: { lat: 44.6, lon: -63.5 }, // Halifax approaches
            }),
        );
        await waitFor(() => expect(document.querySelectorAll('path[data-model]')).toHaveLength(7));
    }

    it('asks for the spread at the Glass point and says ten days, seven models', async () => {
        await open();
        expect(queryModelSpread).toHaveBeenCalledWith(44.6, -63.5);
        // "models", not "global models": GFS and GEM start from regional nests near North America.
        expect(screen.getByRole('dialog', { name: 'Model Convergence' })).toHaveTextContent('10 days · 7 models');
    });

    it('emphasises the pinned model and draws it on top', async () => {
        await open('ecmwf_ifs025');
        const lines = [...document.querySelectorAll('path[data-model]')];
        expect(lines.at(-1)!.getAttribute('data-model')).toBe('ecmwf_ifs025');
        expect(lines.at(-1)!.getAttribute('stroke-width')).toBe('2.5');
        expect(lines[0].getAttribute('stroke-width')).not.toBe('2.5');
    });

    it('shows gaps as gaps: GEM’s line lifts across its missing hours', async () => {
        await open();
        const gem = document.querySelector('path[data-model="gem_seamless"]')!.getAttribute('d')!;
        expect(gem.match(/M/g)).toHaveLength(2);
        const icon = document.querySelector('path[data-model="dwd_icon"]')!.getAttribute('d')!;
        expect(icon.match(/M/g)).toHaveLength(1);
    });

    it('has a member strip that says when the count drops, on the place’s clock', async () => {
        await open();
        const strip = screen.getByRole('img', { name: /^Models with data/ });
        expect(strip).toHaveAccessibleName(
            // GEM's ten-hour hole counts out (Sun 15:00 to Mon 01:00), then ICON and UKMO end.
            'Models with data: 7 from the start, 6 from Sun 15:00, 7 from Mon 01:00, 6 from Tue 22:00, ' +
                '5 from Wed 10:00, 4 from Fri 22:00',
        );
        const bar = (count: number) =>
            Number(strip.querySelector(`rect[data-count="${count}"]`)!.getAttribute('height'));
        expect(bar(7)).toBeGreaterThan(bar(5));
        expect(bar(5)).toBeGreaterThan(bar(4));
    });

    it('marks each of the place’s days with how well the models agree, and when only a few are left', async () => {
        await open();
        // Wed 11:00 to Sat 10:00 in Halifax: eleven local days, the models 4–6 kt apart
        // throughout; from Fri 22:00 only four remain, so the last two days are thin.
        const days = ['Wed', 'Thu', 'Fri', 'Sat', 'Sun', 'Mon', 'Tue', 'Wed', 'Thu'];
        const row = screen.getByRole('img', { name: /^Agreement by day/ });
        expect(row).toHaveAccessibleName(
            `Agreement by day — ${days.map((d) => `${d}: moderate`).join(', ')}, ` +
                'Fri: moderate, only 4 models, Sat: moderate, only 4 models',
        );
        expect(row.querySelectorAll('rect[data-thin]')).toHaveLength(2);
    });

    it('heads the sheet with the next three days, not with day ten', async () => {
        // The models agree closely to day 8, then fan out 3 kt apart each.
        vi.mocked(queryModelSpread).mockResolvedValue(
            withAtmos('wind_speed_10m', (k) => TIMES.map((_, i) => 12 + (i < 200 ? 0.3 : 3) * k)),
        );
        await open();
        const dialog = screen.getByRole('dialog', { name: 'Model Convergence' });
        expect(dialog).toHaveTextContent('Strong agreement3-day avg spread ±2 kts');
        expect(dialog).not.toHaveTextContent('Models disagree');
        expect(screen.getByRole('img', { name: /^Agreement by day/ }).getAttribute('aria-label')).toMatch(
            /Fri: low, only 4 models, Sat: low, only 4 models$/,
        );
    });

    it('says one model alone is one model, never "strong agreement" (UV, from GFS only)', async () => {
        await open();
        fireEvent.click(screen.getByRole('button', { name: 'UV' }));
        const dialog = screen.getByRole('dialog', { name: 'Model Convergence' });
        expect(dialog).toHaveTextContent('10 days · 1 model');
        expect(dialog).toHaveTextContent('Only GFS publishes UV here, so there is nothing to compare.');
        expect(dialog).not.toHaveTextContent(/agreement|divergence|disagree|avg spread/i);
        expect(screen.queryByRole('img', { name: /^Agreement by day/ })).toBeNull();
        expect(screen.getByRole('img', { name: 'UV from 1 model, hourly for ten days' })).toBeInTheDocument();
        expect(screen.getByRole('img', { name: /^Models with data/ })).toHaveTextContent(/^1 model$/);
    });

    it('labels a day with a single member "1 model", not "no data" (VIS after UKMO ends)', async () => {
        await open();
        fireEvent.click(screen.getByRole('button', { name: 'VIS' }));
        expect(screen.getByRole('img', { name: /^Agreement by day/ }).getAttribute('aria-label')).toMatch(
            /Tue: high, Wed: 1 model, Thu: 1 model, Fri: 1 model, Sat: 1 model$/,
        );
    });

    it('keeps a northerly whole: the direction axis is centred on the models, not cut at north', async () => {
        // Seven models within ±10° of north for ten days (Mistral off Marseille, fictional).
        vi.mocked(queryModelSpread).mockResolvedValue(
            withAtmos('wind_direction_10m', (k) =>
                TIMES.map((_, i) => (360 + (k - 3) * 3 + Math.round(4 * Math.sin(i / 7))) % 360),
            ),
        );
        render(
            createElement(ModelComparisonMatrix, {
                visible: true,
                onClose: vi.fn(),
                selectedModel: 'ecmwf_ifs025' as never,
                initialParam: 'dir',
                coordinates: { lat: 43.2, lon: 5.3 },
            }),
        );
        await waitFor(() => expect(document.querySelectorAll('path[data-model]')).toHaveLength(7));
        for (const line of document.querySelectorAll('path[data-model]'))
            expect(line.getAttribute('d')!.match(/M/g)).toHaveLength(1);
        const chart = screen.getByRole('img', { name: /^DIR from 7 models/ });
        expect([...chart.querySelectorAll('text')].slice(0, 5).map((t) => t.textContent)).toEqual([
            'S',
            'W',
            'N',
            'E',
            'S',
        ]);
    });

    it('says "unavailable" for the leg the servers never answered, and still draws the other', async () => {
        vi.mocked(queryModelSpread).mockResolvedValue({ ...fixtureSpread(), atmos: null, unreachable: ['atmos'] });
        render(
            createElement(ModelComparisonMatrix, {
                visible: true,
                onClose: vi.fn(),
                selectedModel: 'ecmwf_ifs025' as never,
                coordinates: { lat: -34.4, lon: 18.5 }, // off Cape Point
            }),
        );
        const dialog = screen.getByRole('dialog', { name: 'Model Convergence' });
        await waitFor(() => expect(dialog).toHaveTextContent('Model data unavailable'));
        expect(dialog).not.toHaveTextContent('No model publishes');
        fireEvent.click(screen.getByRole('button', { name: 'WAVE' }));
        expect(document.querySelectorAll('path[data-model]')).toHaveLength(4);
    });

    it('still says "no model publishes" when the leg answered with nothing', async () => {
        vi.mocked(queryModelSpread).mockResolvedValue({ ...fixtureSpread(), atmos: null });
        render(
            createElement(ModelComparisonMatrix, {
                visible: true,
                onClose: vi.fn(),
                selectedModel: 'ecmwf_ifs025' as never,
                coordinates: { lat: -34.4, lon: 18.5 },
            }),
        );
        const dialog = screen.getByRole('dialog', { name: 'Model Convergence' });
        await waitFor(() => expect(dialog).toHaveTextContent('No model publishes WIND here.'));
    });

    it('credits exactly the models on screen, each under its own licence', async () => {
        await open();
        const credit = () => screen.getByTestId('matrix-credit').textContent;
        expect(credit()).toBe(
            'Data via Open-Meteo: DWD, ECMWF, JMA (CC BY 4.0); UK Met Office (CC BY-SA 4.0); NOAA (public domain); ' +
                'Data Source: Environment and Climate Change Canada (ECCC Data Services End-use Licence)',
        );
        // ECCC's licence asks for a link to it where possible.
        expect(screen.getByRole('link', { name: 'ECCC Data Services End-use Licence' })).toHaveAttribute(
            'href',
            ECCC_LICENCE_URL,
        );
        fireEvent.click(screen.getByRole('button', { name: 'VIS' }));
        expect(credit()).toBe('Data via Open-Meteo: UK Met Office (CC BY-SA 4.0); NOAA (public domain)');
        fireEvent.click(screen.getByRole('button', { name: 'WAVE' }));
        expect(credit()).toBe('Data via Open-Meteo: ECMWF, DWD, Météo-France (CC BY 4.0); NOAA (public domain)');
    });
});
