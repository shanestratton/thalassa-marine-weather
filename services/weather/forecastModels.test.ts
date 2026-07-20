import { describe, it, expect } from 'vitest';
import {
    AUTO_MODEL,
    SELECTABLE_MODELS,
    WAVE_SPREAD_MODELS,
    isConcreteModel,
    resolveForecastModel,
} from './forecastModels';

describe('forecastModels', () => {
    it('offers the six wx-server model domains', () => {
        expect(SELECTABLE_MODELS.map((m) => m.id)).toEqual([
            'dwd_icon',
            'ecmwf_ifs025',
            'ecmwf_aifs025_single',
            'ukmo_global_deterministic_10km',
            'jma_gsm',
            'ncep_gfs025',
        ]);
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
