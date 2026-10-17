import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('./openMeteoProxy', () => ({ fetchOpenMeteoProxy: vi.fn() }));
import { fetchOpenMeteoProxy } from './openMeteoProxy';
import { ECMWF_9KM, REGIONAL_MODELS, regionalModelFor } from './regionalModels';
import {
    refreshCoastalModelCapabilities,
    supportedRegionalModel,
    migratedEcmwfPin,
    applyEcmwfPinMigration,
} from './coastalModelSupport';
import { isModelLive, markModelUnavailable, probeModelLiveness, resetModelLivenessForTests } from './modelLiveness';
import { resolveForecastModel, selectableForecastModels } from './forecastModels';
import { comparisonModelsFor, parseSuffixedHourly, queryModelSpread } from './ModelSpreadService';
import { windAgreementByDay } from './dayAgreement';
import type { AtmosVar, SpreadBlock } from './ModelSpreadService';
import { isSeaCellForecast } from './coastalProvenance';

const proxy = vi.mocked(fetchOpenMeteoProxy);
const uk = { lat: 50.77, lon: -1.3 };
const queensland = { lat: -20.27, lon: 148.72 };
function reply(_operation: string, params: Record<string, string | number>) {
    const hours = Number(params.forecast_hours);
    const hourly: Record<string, unknown> = { time: Array.from({ length: hours }, (_, i) => 1_792_368_000 + i * 3600) };
    for (const model of String(params.models).split(',')) {
        for (const variable of String(params.hourly).split(',')) hourly[`${variable}_${model}`] = Array(hours).fill(12);
    }
    return Promise.resolve({ hourly });
}
beforeEach(() => {
    resetModelLivenessForTests();
    proxy.mockReset();
    proxy.mockImplementation(reply as never);
});
describe('133-03 deployed coastal capability', () => {
    it('does not commit a delayed migration across sign-out, account replacement or a newer pin', async () => {
        await refreshCoastalModelCapabilities(queensland);
        const write = vi.fn();
        expect(
            applyEcmwfPinMigration(
                'ecmwf_ifs025',
                () => false,
                () => 'ecmwf_ifs025',
                write,
            ),
        ).toBe(false);
        expect(
            applyEcmwfPinMigration(
                'ecmwf_ifs025',
                () => true,
                () => 'dwd_icon',
                write,
            ),
        ).toBe(false);
        expect(write).not.toHaveBeenCalled();
        expect(
            applyEcmwfPinMigration(
                'ecmwf_ifs025',
                () => true,
                () => 'ecmwf_ifs025',
                write,
            ),
        ).toBe(true);
        expect(write).toHaveBeenCalledExactlyOnceWith(ECMWF_9KM);
    });
    it('keeps old ECMWF pins/catalogue until the real proxy supplies finite 9 km wind, then migrates only ECMWF', async () => {
        expect(resolveForecastModel('ecmwf_ifs025')).toBe('ecmwf_ifs025');
        expect(resolveForecastModel(ECMWF_9KM)).toBe('ecmwf_ifs025');
        expect(migratedEcmwfPin('ecmwf_ifs025')).toBeUndefined();
        await refreshCoastalModelCapabilities(queensland);
        expect(isModelLive(ECMWF_9KM)).toBe(true);
        expect(resolveForecastModel('ecmwf_ifs025')).toBe(ECMWF_9KM);
        expect(migratedEcmwfPin('ecmwf_ifs025')).toBe(ECMWF_9KM);
        for (const stored of ['best_match', 'dwd_icon', 'spitfire', 'ecmwf_ifs', undefined])
            expect(migratedEcmwfPin(stored)).toBeUndefined();
        expect(selectableForecastModels().map((model) => model.id)).toContain(ECMWF_9KM);
        expect(selectableForecastModels().map((model) => model.id)).not.toContain('ecmwf_ifs025');
        expect(proxy.mock.calls[0][1]).toMatchObject({
            models: ECMWF_9KM,
            hourly: 'wind_speed_10m',
            forecast_hours: 24,
            cell_selection: 'sea',
        });
    });
    it('does not mistake HTTP success with nulls for deployment, and backs off refused calls', async () => {
        proxy.mockResolvedValue({ hourly: { wind_speed_10m: Array(24).fill(null) } });
        await refreshCoastalModelCapabilities(uk);
        expect(resolveForecastModel('ecmwf_ifs025')).toBe('ecmwf_ifs025');
        expect(supportedRegionalModel(uk.lat, uk.lon)).toBeUndefined();
        resetModelLivenessForTests();
        proxy.mockReset().mockRejectedValue(new Error('proxy still rejects the new IDs'));
        await refreshCoastalModelCapabilities(uk);
        await refreshCoastalModelCapabilities(uk);
        expect(proxy).toHaveBeenCalledTimes(2);
    });
    it('adds one native regional member within the eight-model limit, labels its horizon, and keeps UKV display-only', async () => {
        await refreshCoastalModelCapabilities(uk);
        const models = comparisonModelsFor(uk.lat, uk.lon);
        expect(models).toHaveLength(8);
        expect(models.at(-1)).toMatchObject({
            id: 'ukmo_uk_deterministic_2km',
            horizonHours: 48,
            displayOnly: true,
            label: 'Local hi-res · 2 km',
        });
        expect(supportedRegionalModel(queensland.lat, queensland.lon)).toBeUndefined();
        markModelUnavailable(ECMWF_9KM);
        expect(resolveForecastModel(ECMWF_9KM)).toBe('ecmwf_ifs025');
    });
    it('never reuses a pre-capability comparison memo after the model ID changes', async () => {
        proxy.mockResolvedValueOnce({ hourly: { wind_speed_10m: Array(24).fill(null) } });
        const first = await queryModelSpread(queensland.lat, queensland.lon);
        expect(first.atmos!.models.map((model) => model.id)).toContain('ecmwf_ifs025');
        await probeModelLiveness(ECMWF_9KM, queensland);
        const second = await queryModelSpread(queensland.lat, queensland.lon);
        expect(second).not.toBe(first);
        expect(second.atmos!.models.map((model) => model.id)).toContain(ECMWF_9KM);
        const calls = proxy.mock.calls.filter(
            ([operation, params]) => operation === 'forecast' && params.forecast_hours === '240',
        );
        expect(calls).toHaveLength(2);
        expect(calls.every(([, params]) => params.cell_selection === 'sea')).toBe(true);
    });
});
describe('native coverage and missing values', () => {
    it.each([
        [60, 10, 'metno_nordic'],
        [50.77, -1.3, 'ukmo_uk_deterministic_2km'],
        [52, 5, 'knmi_harmonie_arome_netherlands'],
        [48, 12, 'dwd_icon_d2'],
        [43, 1, 'meteofrance_arome_france_hd'],
        [48.86, 2.35, 'meteofrance_arome_france_hd'],
        [37, -122, 'ncep_hrrr_conus'],
        [50, -100, 'cmc_gem_hrdps'],
        [35, 139, 'jma_msm'],
    ])('selects the documented region hint at %s,%s', (lat, lon, id) =>
        expect(regionalModelFor(Number(lat), Number(lon))?.id).toBe(id),
    );
    it.each([
        [-20.27, 148.72],
        [-33.9, 18.4],
        [NaN, 0],
        [0, 181],
    ])('offers global models outside local selection regions', (lat, lon) =>
        expect(regionalModelFor(lat, lon)).toBeUndefined(),
    );
    it('uses unique native IDs and never seamless aliases', () => {
        expect(new Set(REGIONAL_MODELS.map((model) => model.id)).size).toBe(REGIONAL_MODELS.length);
        expect(REGIONAL_MODELS.every((model) => !model.id.includes('seamless'))).toBe(true);
    });
    it('keeps regional run exhaustion and non-finite values as gaps', () => {
        const block = parseSuffixedHourly(
            { time: [1, 2, 3], wind_speed_10m_local: [12, Number.NaN, 99] },
            ['wind_speed_10m'],
            [{ id: 'local', label: 'Local', provider: 'DWD', hex: '#fff', horizonHours: 2 }],
        )!;
        expect(block.models[0].values.wind_speed_10m).toEqual([12, null, null]);
    });
    it('does not fold UKV display data into the day-agreement score', () => {
        const member = (id: string, speed: number, displayOnly = false) => ({
            id,
            label: id,
            provider: id,
            hex: '#fff',
            displayOnly,
            values: { wind_speed_10m: Array(24).fill(speed), wind_direction_10m: Array(24).fill(90) },
        });
        const block = {
            times: Array.from({ length: 24 }, (_, i) => Date.UTC(2026, 9, 16) + i * 3600_000),
            models: [member('a', 10), member('b', 10), member('UKV', 80, true)],
        } as SpreadBlock<AtmosVar>;
        expect(windAgreementByDay(block, 'UTC')[0]).toMatchObject({ members: 2, speedSpread: 0, level: 'agree' });
    });
});

describe('coastal publisher provenance', () => {
    const provenance = { version: 1, model: 'ecmwf_ifs', cell_selection: 'sea', latitude: -20.27, longitude: 148.72 };
    it('requires the exact requested model and sea point; coarse rows never prove 9 km', () => {
        expect(isSeaCellForecast({}, ECMWF_9KM, queensland.lat, queensland.lon)).toBe(false);
        expect(isSeaCellForecast({ thalassa_provenance: provenance }, ECMWF_9KM, queensland.lat, queensland.lon)).toBe(
            true,
        );
        for (const change of [
            { model: 'ecmwf_ifs025' },
            { cell_selection: 'land' },
            { latitude: -20.25 },
            { longitude: NaN },
            { version: 0 },
        ]) {
            expect(
                isSeaCellForecast(
                    { thalassa_provenance: { ...provenance, ...change } },
                    ECMWF_9KM,
                    queensland.lat,
                    queensland.lon,
                ),
            ).toBe(false);
        }
    });
});
