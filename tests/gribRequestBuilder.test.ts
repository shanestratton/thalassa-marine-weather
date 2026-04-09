/**
 * GribRequestBuilder — Unit tests for configuration constants.
 *
 * Verifies that GRIB_PARAMETERS, RESOLUTION_OPTIONS, TIME_STEP_OPTIONS,
 * and FORECAST_HOURS_OPTIONS are correctly structured for the UI.
 */

import { describe, it, expect } from 'vitest';
import {
    GribRequestBuilder,
    GRIB_PARAMETERS,
    RESOLUTION_OPTIONS,
    TIME_STEP_OPTIONS,
    FORECAST_HOURS_OPTIONS,
} from '../services/GribRequestBuilder';
import type { GribRequest } from '../types';

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

// ── Builder logic tests ──

const makeRequest = (overrides: Partial<GribRequest> = {}): GribRequest => ({
    bbox: { north: -25, south: -35, west: 150, east: 160 },
    parameters: ['wind', 'pressure'],
    resolution: 1.0,
    timeStep: 6,
    forecastHours: 72,
    model: 'GFS',
    ...overrides,
});

describe('GribRequestBuilder.estimateSize', () => {
    it('returns positive size for valid request', () => {
        expect(GribRequestBuilder.estimateSize(makeRequest())).toBeGreaterThan(0);
    });

    it('higher resolution produces larger files', () => {
        const low = GribRequestBuilder.estimateSize(makeRequest({ resolution: 1.0 }));
        const high = GribRequestBuilder.estimateSize(makeRequest({ resolution: 0.25 }));
        expect(high).toBeGreaterThan(low);
    });

    it('more parameters produce larger files', () => {
        const few = GribRequestBuilder.estimateSize(makeRequest({ parameters: ['wind'] }));
        const many = GribRequestBuilder.estimateSize(
            makeRequest({ parameters: ['wind', 'pressure', 'waves', 'precip'] }),
        );
        expect(many).toBeGreaterThan(few);
    });

    it('longer forecast produces larger files', () => {
        const short = GribRequestBuilder.estimateSize(makeRequest({ forecastHours: 48 }));
        const long = GribRequestBuilder.estimateSize(makeRequest({ forecastHours: 120 }));
        expect(long).toBeGreaterThan(short);
    });

    it('larger bounding box produces larger files', () => {
        const small = GribRequestBuilder.estimateSize(
            makeRequest({ bbox: { north: -30, south: -32, west: 150, east: 152 } }),
        );
        const large = GribRequestBuilder.estimateSize(
            makeRequest({ bbox: { north: -20, south: -40, west: 140, east: 170 } }),
        );
        expect(large).toBeGreaterThan(small);
    });
});

describe('GribRequestBuilder.formatSize', () => {
    it('formats bytes', () => {
        expect(GribRequestBuilder.formatSize(500)).toBe('500 B');
    });

    it('formats kilobytes', () => {
        expect(GribRequestBuilder.formatSize(2048)).toBe('2.0 KB');
    });

    it('formats megabytes', () => {
        expect(GribRequestBuilder.formatSize(2 * 1024 * 1024)).toBe('2.00 MB');
    });
});

describe('GribRequestBuilder.getGridInfo', () => {
    it('calculates correct grid points', () => {
        const info = GribRequestBuilder.getGridInfo(
            makeRequest({
                bbox: { north: -25, south: -35, west: 150, east: 160 },
                resolution: 1.0,
            }),
        );
        expect(info.latPoints).toBe(11);
        expect(info.lonPoints).toBe(11);
        expect(info.totalPoints).toBe(121);
    });

    it('calculates correct time steps', () => {
        const info = GribRequestBuilder.getGridInfo(makeRequest({ forecastHours: 72, timeStep: 6 }));
        expect(info.timeSteps).toBe(12);
    });
});

describe('GribRequestBuilder.formatSaildocsRequest', () => {
    it('formats correct Saildocs syntax', () => {
        const str = GribRequestBuilder.formatSaildocsRequest(makeRequest());
        expect(str).toMatch(/^send GFS:/);
        expect(str).toContain('-35,-25,150,160');
        expect(str).toContain('|1,1|');
        expect(str).toContain('0,72..6');
        expect(str).toContain('WIND');
        expect(str).toContain('PRESS');
    });

    it('maps wave parameters to Saildocs codes', () => {
        const str = GribRequestBuilder.formatSaildocsRequest(makeRequest({ parameters: ['waves'] }));
        expect(str).toContain('HTSGW,PERPW');
    });
});

describe('GribRequestBuilder.buildDownloadUrl', () => {
    it('generates NOMADS URL for GFS model', () => {
        const url = GribRequestBuilder.buildDownloadUrl(makeRequest());
        expect(url).toContain('nomads.ncep.noaa.gov');
        expect(url).toContain('var_UGRD=on');
        expect(url).toContain('var_VGRD=on');
    });

    it('generates ECMWF URL for non-GFS models', () => {
        const url = GribRequestBuilder.buildDownloadUrl(makeRequest({ model: 'ECMWF' as any }));
        expect(url).toContain('api.ecmwf.int');
    });
});

describe('GribRequestBuilder.validateBBox', () => {
    it('returns no errors for valid bbox', () => {
        expect(GribRequestBuilder.validateBBox({ north: -25, south: -35, west: 150, east: 160 })).toEqual([]);
    });

    it('catches north <= south', () => {
        const errors = GribRequestBuilder.validateBBox({ north: -35, south: -25, west: 150, east: 160 });
        expect(errors).toContain('North must be greater than South');
    });

    it('catches area too large', () => {
        const errors = GribRequestBuilder.validateBBox({ north: 40, south: -30, west: 0, east: 10 });
        expect(errors.some((e) => e.includes('too large'))).toBe(true);
    });

    it('catches area too small', () => {
        const errors = GribRequestBuilder.validateBBox({ north: -33, south: -33.5, west: 151, east: 151.3 });
        expect(errors.some((e) => e.includes('too small'))).toBe(true);
    });
});

describe('GribRequestBuilder.createDefault', () => {
    it('creates a valid request centered on given coords', () => {
        const req = GribRequestBuilder.createDefault(-33, 151);
        expect(req.bbox.north).toBe(-23);
        expect(req.bbox.south).toBe(-43);
        expect(req.model).toBe('GFS');
    });

    it('default params include wind and pressure', () => {
        const req = GribRequestBuilder.createDefault();
        expect(req.parameters).toContain('wind');
        expect(req.parameters).toContain('pressure');
    });
});
