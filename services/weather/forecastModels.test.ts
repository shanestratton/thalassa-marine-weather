import { describe, it, expect } from 'vitest';
import {
    AUTO_MODEL,
    SELECTABLE_MODELS,
    COMPARE_MODELS,
    SPREAD_EXTRA_MODELS,
    WAVE_SPREAD_MODELS,
    getForecastModelInfo,
    SPITFIRE_MODEL,
    isConcreteModel,
    isSpitfire,
    modelLacks,
    resolveForecastModel,
    OFFSHORE_MODELS,
    resolveOffshoreModel,
    getOffshoreModelInfo,
    MODEL_ATTRIBUTION_LINE,
    forecastDataCredit,
    providerLicence,
    ECCC_LICENCE,
    ECCC_LICENCE_URL,
} from './forecastModels';

describe('forecastModels', () => {
    it('keeps supported offshore source keys separate from atmospheric model domains', () => {
        expect(OFFSHORE_MODELS.map((model) => model.id)).toEqual(['sg', 'ecmwf', 'gfs', 'icon']);
        for (const model of OFFSHORE_MODELS) {
            expect(resolveOffshoreModel(model.id)).toBe(model.id);
            expect(getOffshoreModelInfo(model.id)).toEqual(model);
            expect(SELECTABLE_MODELS.some((entry) => entry.id === (model.id as string))).toBe(false);
        }
    });

    it.each([undefined, null, '', 'ecmwf_aifs025_single', 'dwd_icon', 'spitfire', 'best_match'])(
        'defaults invalid offshore choice %s to the supported blend',
        (stored) => {
            expect(resolveOffshoreModel(stored)).toBe('sg');
        },
    );

    it('offers the model domains that actually carry wind', () => {
        expect(SELECTABLE_MODELS.map((m) => m.id)).toEqual([
            'dwd_icon',
            'ecmwf_ifs025',
            'ecmwf_aifs025_single',
            'ukmo_global_deterministic_10km',
            'jma_gsm',
        ]);
    });

    it('does NOT offer ncep_gfs025 — it has no 10m wind in the open-data mirror', () => {
        // GFS is split across domains upstream: gusts/pressure in ncep_gfs025,
        // the 10m wind in ncep_gfs013. Offering the former alone gave a model
        // with no wind at all. Re-list it only via gfs_seamless, once
        // ncep_gfs013 is synced AND wind_speed_10m verifies non-null.
        expect(SELECTABLE_MODELS.some((m) => m.id === 'ncep_gfs025')).toBe(false);
    });

    it('declares the models that publish no gust field', () => {
        expect(modelLacks('ecmwf_aifs025_single', 'gust')).toBe(true);
        expect(modelLacks('jma_gsm', 'gust')).toBe(true);
        expect(modelLacks('dwd_icon', 'gust')).toBe(false);
        expect(modelLacks('ukmo_global_deterministic_10km', 'gust')).toBe(false);
    });

    it('treats SPITFIRE as its own thing, never a model id', () => {
        expect(isSpitfire(SPITFIRE_MODEL)).toBe(true);
        expect(isSpitfire('dwd_icon')).toBe(false);
        // It must never be passed as &models= — it is not a grid.
        expect(SELECTABLE_MODELS.some((m) => m.id === SPITFIRE_MODEL)).toBe(false);
        expect(resolveForecastModel(SPITFIRE_MODEL)).toBe(SPITFIRE_MODEL);
    });

    it('migrates a stored GFS selection off the dead model rather than keeping it', () => {
        expect(resolveForecastModel('ncep_gfs025')).toBe('dwd_icon');
    });

    it('isConcreteModel accepts catalogue ids and rejects Auto/legacy/undefined', () => {
        expect(isConcreteModel('dwd_icon')).toBe(true);
        expect(isConcreteModel(AUTO_MODEL)).toBe(false);
        expect(isConcreteModel('icon_seamless')).toBe(false); // legacy id, not selectable
        expect(isConcreteModel(undefined)).toBe(false);
    });

    describe('resolveForecastModel', () => {
        it('defaults an unset preference to ICON', () => {
            expect(resolveForecastModel(undefined)).toBe('dwd_icon');
        });
        it('preserves an explicit Auto choice', () => {
            expect(resolveForecastModel(AUTO_MODEL)).toBe(AUTO_MODEL);
        });
        it('passes concrete choices through', () => {
            expect(resolveForecastModel('ukmo_global_deterministic_10km')).toBe('ukmo_global_deterministic_10km');
        });
        it('maps unknown/legacy stored ids to the ICON default', () => {
            expect(resolveForecastModel('icon_seamless')).toBe('dwd_icon');
        });
    });

    it('compares seven models: the picker five plus GFS and GEM', () => {
        expect(COMPARE_MODELS.map((m) => m.id)).toEqual([
            'dwd_icon',
            'ecmwf_ifs025',
            'ecmwf_aifs025_single',
            'ukmo_global_deterministic_10km',
            'jma_gsm',
            'gfs_seamless',
            'gem_seamless',
        ]);
        expect(SPREAD_EXTRA_MODELS.map((m) => [m.label, m.provider])).toEqual([
            ['GFS', 'NOAA'],
            ['GEM', 'Environment and Climate Change Canada'],
        ]);
        // Every member draws in its own colour.
        expect(new Set(COMPARE_MODELS.map((m) => m.hex.toLowerCase())).size).toBe(7);
        // Comparison-only: the Glass picker and the model-check card keep their five.
        for (const m of SPREAD_EXTRA_MODELS) {
            expect(isConcreteModel(m.id as never)).toBe(false);
            expect(getForecastModelInfo(m.id as never)).toBeNull();
        }
    });

    it('wave models are distinct from atmospheric models (marine endpoint set)', () => {
        const atmosIds = new Set(SELECTABLE_MODELS.map((m) => m.id as string));
        for (const w of WAVE_SPREAD_MODELS) {
            expect(atmosIds.has(w.id)).toBe(false);
        }
    });

    describe('licences in the credit', () => {
        // UK Met Office open data is CC BY-SA 4.0 (share-alike). NOAA's is a
        // US Government work, public domain (weather.gov/disclaimer). ECCC's
        // GEM comes under its own Data Services End-use Licence, whose
        // attribution is "Data Source: Environment and Climate Change Canada"
        // (eccc-msc.github.io/open-data/licence, v2.1.1). The rest are CC BY 4.0.
        it('knows the UK Met Office is share-alike, under either of its names', () => {
            expect(providerLicence('UK Met Office')).toBe('CC BY-SA 4.0');
            expect(providerLicence('UKMO')).toBe('CC BY-SA 4.0');
            for (const p of ['ECMWF', 'DWD', 'JMA', 'Météo-France']) expect(providerLicence(p)).toBe('CC BY 4.0');
        });

        it('credits NOAA as public domain and ECCC under its own end-use licence', () => {
            expect(providerLicence('NOAA')).toBe('public domain');
            expect(providerLicence('Environment and Climate Change Canada')).toBe('ECCC Data Services End-use Licence');
            expect(providerLicence('ECCC')).toBe('ECCC Data Services End-use Licence');
        });

        it('credits all seven comparison members, each under its own licence', () => {
            expect(
                forecastDataCredit(
                    COMPARE_MODELS.map((m) => m.provider),
                    'Data via Open-Meteo',
                ),
            ).toBe(
                'Data via Open-Meteo: DWD, ECMWF, JMA (CC BY 4.0); UK Met Office (CC BY-SA 4.0); NOAA (public domain); ' +
                    'Data Source: Environment and Climate Change Canada (ECCC Data Services End-use Licence)',
            );
        });

        it('credits ECCC in the words its licence specifies, whichever name the caller used, with the licence link', () => {
            for (const name of ['ECCC', 'Environment and Climate Change Canada'])
                expect(forecastDataCredit([name])).toBe(
                    'Forecast data: Data Source: Environment and Climate Change Canada (ECCC Data Services End-use Licence)',
                );
            expect(forecastDataCredit(['ECCC', 'Environment and Climate Change Canada'])).toBe(
                'Forecast data: Data Source: Environment and Climate Change Canada (ECCC Data Services End-use Licence)',
            );
            expect(ECCC_LICENCE).toBe('ECCC Data Services End-use Licence');
            expect(ECCC_LICENCE_URL).toBe('https://eccc-msc.github.io/open-data/licence/readme_en/');
        });

        it('every Glass model resolves a licence', () => {
            for (const m of SELECTABLE_MODELS) expect(providerLicence(m.provider)).toMatch(/^CC BY(-SA)? 4\.0$/);
        });

        it('groups providers by licence, each once, in the order given', () => {
            expect(forecastDataCredit(['DWD', 'ECMWF', 'UK Met Office', 'JMA', 'ECMWF'])).toBe(
                'Forecast data: DWD, ECMWF, JMA (CC BY 4.0); UK Met Office (CC BY-SA 4.0)',
            );
            expect(forecastDataCredit(['UK Met Office'])).toBe('Forecast data: UK Met Office (CC BY-SA 4.0)');
            expect(forecastDataCredit(['ECMWF'])).toBe('Forecast data: ECMWF (CC BY 4.0)');
            expect(forecastDataCredit(['ECMWF', 'UK Met Office'], 'Data via Open-Meteo')).toBe(
                'Data via Open-Meteo: ECMWF (CC BY 4.0); UK Met Office (CC BY-SA 4.0)',
            );
            expect(forecastDataCredit([' ', ''])).toBeNull();
            expect(forecastDataCredit([])).toBeNull();
        });

        it('the full attribution line credits UKMO under CC BY-SA 4.0 and NOAA as public domain', () => {
            expect(MODEL_ATTRIBUTION_LINE).toBe(
                'Forecast data: ECMWF, DWD, JMA, Météo-France (CC BY 4.0); UKMO (CC BY-SA 4.0); NOAA (public domain)',
            );
        });
    });
});
