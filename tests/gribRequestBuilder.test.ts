/**
 * GribRequestBuilder — Unit tests for configuration constants.
 *
 * Verifies that GRIB_PARAMETERS, RESOLUTION_OPTIONS, TIME_STEP_OPTIONS,
 * and FORECAST_HOURS_OPTIONS are correctly structured for the UI.
 */

import { describe, it, expect } from 'vitest';
import {
    GRIB_PARAMETERS,
    RESOLUTION_OPTIONS,
    TIME_STEP_OPTIONS,
    FORECAST_HOURS_OPTIONS,
} from '../services/GribRequestBuilder';

describe('GRIB_PARAMETERS', () => {
    it('has at least one parameter', () => {
        expect(GRIB_PARAMETERS.length).toBeGreaterThan(0);
    });

    it('each parameter has required fields', () => {
        for (const param of GRIB_PARAMETERS) {
            expect(param).toHaveProperty('key');
            expect(param).toHaveProperty('label');
            expect(typeof param.key).toBe('string');
            expect(typeof param.label).toBe('string');
        }
    });

    it('includes wind parameters', () => {
        const keys = GRIB_PARAMETERS.map((p) => p.key);
        const hasWind = keys.some((key) => key.toLowerCase().includes('wind') || key.toLowerCase().includes('gust'));
        expect(hasWind).toBe(true);
    });
});

describe('RESOLUTION_OPTIONS', () => {
    it('has at least 2 resolution options', () => {
        expect(RESOLUTION_OPTIONS.length).toBeGreaterThanOrEqual(2);
    });

    it('each option has value, label, and description', () => {
        for (const opt of RESOLUTION_OPTIONS) {
            expect(opt).toHaveProperty('value');
            expect(opt).toHaveProperty('label');
            expect(opt).toHaveProperty('description');
        }
    });
});

describe('TIME_STEP_OPTIONS', () => {
    it('has at least 2 options', () => {
        expect(TIME_STEP_OPTIONS.length).toBeGreaterThanOrEqual(2);
    });

    it('each option has value and label', () => {
        for (const opt of TIME_STEP_OPTIONS) {
            expect(opt).toHaveProperty('value');
            expect(opt).toHaveProperty('label');
        }
    });
});

describe('FORECAST_HOURS_OPTIONS', () => {
    it('has at least 2 options', () => {
        expect(FORECAST_HOURS_OPTIONS.length).toBeGreaterThanOrEqual(2);
    });

    it('each option has value and label', () => {
        for (const opt of FORECAST_HOURS_OPTIONS) {
            expect(opt).toHaveProperty('value');
            expect(opt).toHaveProperty('label');
        }
    });

    it('values are in ascending order', () => {
        for (let i = 1; i < FORECAST_HOURS_OPTIONS.length; i++) {
            expect(FORECAST_HOURS_OPTIONS[i].value).toBeGreaterThan(FORECAST_HOURS_OPTIONS[i - 1].value);
        }
    });
});
