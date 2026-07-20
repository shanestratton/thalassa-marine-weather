import { describe, it, expect } from 'vitest';
import {
    AUTO_MODEL,
    SELECTABLE_MODELS,
    WAVE_SPREAD_MODELS,
    SPITFIRE_MODEL,
    isConcreteModel,
    isSpitfire,
    modelLacks,
    resolveForecastModel,
} from './forecastModels';

describe('forecastModels', () => {
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

    it('wave models are distinct from atmospheric models (marine endpoint set)', () => {
        const atmosIds = new Set(SELECTABLE_MODELS.map((m) => m.id as string));
        for (const w of WAVE_SPREAD_MODELS) {
            expect(atmosIds.has(w.id)).toBe(false);
        }
    });
});
