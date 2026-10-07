import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

// ── Ten-day comparison (W1-08): seven members, one fetch per 0.1° cell ──

vi.mock('./openMeteoProxy', () => ({ fetchOpenMeteoProxy: vi.fn() }));

const T0 = Date.UTC(2026, 9, 7, 14) / 1000; // the current hour, unixtime seconds
const HOURS = 240;
const SEVEN = [
    'dwd_icon',
    'ecmwf_ifs025',
    'ecmwf_aifs025_single',
    'ukmo_global_deterministic_10km',
    'jma_gsm',
    'gfs_seamless',
    'gem_seamless',
];
const WAVES = ['ecmwf_wam025', 'dwd_gwam', 'meteofrance_wave', 'ncep_gfswave025'];
/** Where each model's hourly run ends, as measured through the proxy at Fiji
 *  on 2026-10-07 (ICON 167 h, UKMO 155 h, GEM 227 h, the rest the full 240). */
const LAST_HOUR: Record<string, number> = { dwd_icon: 166, ukmo_global_deterministic_10km: 154, gem_seamless: 226 };

/** A fictional proxy answer: every requested model and variable, with each
 *  model's hours beyond its horizon null (as Open-Meteo sends them). */
function fakeProxy(operation: string, params: Record<string, string | number>) {
    const hours = Number(params.forecast_hours);
    const time = Array.from({ length: hours }, (_, i) => T0 + i * 3600);
    const hourly: Record<string, unknown> = { time };
    for (const model of String(params.models).split(',')) {
        for (const variable of String(params.hourly).split(',')) {
            const last = LAST_HOUR[model] ?? hours - 1;
            hourly[`${variable}_${model}`] = time.map((_, i) => (i <= last ? 10 + (i % 7) : null));
        }
    }
    // One mid-run hole in GEM's wind: a missing hour must stay missing.
    const gemWind = hourly.wind_speed_10m_gem_seamless as (number | null)[] | undefined;
    if (operation === 'forecast' && gemWind) gemWind[50] = null;
    return Promise.resolve({ hourly });
}

async function loadSpread() {
    vi.resetModules();
    const proxy = vi.mocked((await import('./openMeteoProxy')).fetchOpenMeteoProxy);
    proxy.mockReset();
    proxy.mockImplementation(fakeProxy as never);
    const svc = await import('./ModelSpreadService');
    return { proxy, svc };
}

describe('queryModelSpread — ten-day, seven-member comparison', () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(T0 * 1000 + 10 * 60_000));
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('asks for the seven models over 240 hours in unixtime, with no cell_selection yet', async () => {
        const { proxy, svc } = await loadSpread();
        await svc.queryModelSpread(50.77, -1.3); // the Solent

        expect(proxy).toHaveBeenCalledTimes(2);
        const forecast = proxy.mock.calls.find(([op]) => op === 'forecast')![1];
        const marine = proxy.mock.calls.find(([op]) => op === 'marine')![1];
        expect(String(forecast.models).split(',')).toEqual(SEVEN);
        expect(forecast.forecast_hours).toBe('240');
        expect(forecast.timeformat).toBe('unixtime');
        expect(forecast.wind_speed_unit).toBe('kn');
        expect(String(marine.models).split(',')).toEqual(WAVES);
        expect(marine.forecast_hours).toBe('240');
        expect(marine.timeformat).toBe('unixtime');
        // Sea-cell selection waits for W2-01, so the sheet and the Glass agree at the coast.
        expect(forecast).not.toHaveProperty('cell_selection');
        expect(marine).not.toHaveProperty('cell_selection');
    });

    it('returns GFS and GEM as members, credited to NOAA and ECCC', async () => {
        const { svc } = await loadSpread();
        const result = await svc.queryModelSpread(-17.7, 177.4); // Fiji
        expect(result.atmos!.models.map((m) => m.id)).toEqual(SEVEN);
        const gfs = result.atmos!.models.find((m) => m.id === 'gfs_seamless')!;
        const gem = result.atmos!.models.find((m) => m.id === 'gem_seamless')!;
        expect([gfs.label, gfs.provider]).toEqual(['GFS', 'NOAA']);
        expect([gem.label, gem.provider]).toEqual(['GEM', 'Environment and Climate Change Canada']);
        expect(result.atmos!.times).toHaveLength(HOURS);
        expect(result.atmos!.times[1] - result.atmos!.times[0]).toBe(3600_000);
    });

    it('keeps hours a model does not cover as gaps, never filled in', async () => {
        const { svc } = await loadSpread();
        const result = await svc.queryModelSpread(44.6, -63.5); // Halifax approaches
        const wind = (id: string) => result.atmos!.models.find((m) => m.id === id)!.values.wind_speed_10m;
        expect(wind('dwd_icon')).toHaveLength(HOURS);
        expect(
            wind('dwd_icon')
                .slice(167)
                .every((v) => v === null),
        ).toBe(true);
        expect(wind('ukmo_global_deterministic_10km')[155]).toBeNull();
        expect(wind('gem_seamless')[50]).toBeNull();
        expect(wind('gem_seamless')[49]).not.toBeNull();
        expect(wind('gem_seamless')[51]).not.toBeNull();
        expect(wind('gfs_seamless').every((v) => v !== null)).toBe(true);
    });

    it('fetches once per 0.1° cell, so the sheet and the day cards share one answer', async () => {
        const { proxy, svc } = await loadSpread();
        const first = await svc.queryModelSpread(54.32, 4.71); // North Sea
        const sameCell = await svc.queryModelSpread(54.28, 4.74);
        expect(proxy).toHaveBeenCalledTimes(2);
        expect(sameCell).toBe(first);
        await svc.queryModelSpread(54.36, 4.71); // the next cell north
        expect(proxy).toHaveBeenCalledTimes(4);
    });

    it('shares one in-flight request between simultaneous callers in a cell', async () => {
        const { proxy, svc } = await loadSpread();
        const [a, b] = await Promise.all([
            svc.queryModelSpread(18.42, -64.62), // BVI
            svc.queryModelSpread(18.38, -64.58),
        ]);
        expect(a).toBe(b);
        expect(proxy).toHaveBeenCalledTimes(2);
    });

    it('keeps a cell for 30 minutes and refetches within the hour', async () => {
        const { proxy, svc } = await loadSpread();
        await svc.queryModelSpread(43.2, 5.3); // Marseille
        vi.setSystemTime(Date.now() + 29 * 60_000);
        await svc.queryModelSpread(43.2, 5.3);
        expect(proxy).toHaveBeenCalledTimes(2);
        vi.setSystemTime(Date.now() + 32 * 60_000);
        await svc.queryModelSpread(43.2, 5.3);
        expect(proxy).toHaveBeenCalledTimes(4);
    });

    it('does not keep an answer when either endpoint failed', async () => {
        const { proxy, svc } = await loadSpread();
        proxy.mockImplementation(((op: string, params: Record<string, string>) =>
            op === 'marine' ? Promise.reject(new Error('503')) : fakeProxy(op, params)) as never);
        const partial = await svc.queryModelSpread(-33.9, 18.4); // Cape Town
        expect(partial.atmos).not.toBeNull();
        expect(partial.marine).toBeNull();
        proxy.mockImplementation(fakeProxy as never);
        await svc.queryModelSpread(-33.9, 18.4);
        expect(proxy).toHaveBeenCalledTimes(4);
    });

    it('names the leg the servers never answered, so the sheet can say "unavailable", not "no model"', async () => {
        const { proxy, svc } = await loadSpread();
        proxy.mockImplementation(((op: string, params: Record<string, string>) =>
            op === 'forecast' ? Promise.reject(new Error('timeout')) : fakeProxy(op, params)) as never);
        const partial = await svc.queryModelSpread(41.2, -70.1); // south of Nantucket, a slow link
        expect(partial.atmos).toBeNull();
        expect(partial.marine).not.toBeNull();
        expect(partial.unreachable).toEqual(['atmos']);
        // A leg that answered with nothing (a 200, e.g. marine far inland) is not "unreachable".
        proxy.mockImplementation(((op: string, params: Record<string, string>) =>
            op === 'marine' ? Promise.resolve({ hourly: { time: [] } }) : fakeProxy(op, params)) as never);
        const inland = await svc.queryModelSpread(46.9, 7.4); // Bern
        expect(inland.marine).toBeNull();
        expect(inland.unreachable).toBeUndefined();
    });

    it('names a cell the same either side of the antimeridian and at the equator', async () => {
        const { svc } = await loadSpread();
        expect(svc.spreadCellKey(54.32, 4.71)).toBe('54.3,4.7');
        expect(svc.spreadCellKey(-17.7, 179.97)).toBe(svc.spreadCellKey(-17.7, -179.97));
        expect(svc.spreadCellKey(-0.04, -0.04)).toBe('0.0,0.0');
    });
});
