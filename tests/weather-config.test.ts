/**
 * Weather Config — Unit tests
 *
 * Tests the static buoy configuration data and state abbreviation mapping.
 */

import { describe, it, expect } from 'vitest';
import { STATE_ABBREVIATIONS, MAJOR_BUOYS } from '../services/weather/config';

describe('STATE_ABBREVIATIONS', () => {
    it('includes Australian states', () => {
        expect(STATE_ABBREVIATIONS['New South Wales']).toBe('NSW');
        expect(STATE_ABBREVIATIONS['Queensland']).toBe('QLD');
        expect(STATE_ABBREVIATIONS['Victoria']).toBe('VIC');
        expect(STATE_ABBREVIATIONS['Tasmania']).toBe('TAS');
        expect(STATE_ABBREVIATIONS['Western Australia']).toBe('WA');
        expect(STATE_ABBREVIATIONS['South Australia']).toBe('SA');
        expect(STATE_ABBREVIATIONS['Northern Territory']).toBe('NT');
    });

    it('includes US states', () => {
        expect(STATE_ABBREVIATIONS['California']).toBe('CA');
        expect(STATE_ABBREVIATIONS['Florida']).toBe('FL');
        expect(STATE_ABBREVIATIONS['New York']).toBe('NY');
        expect(STATE_ABBREVIATIONS['Texas']).toBe('TX');
    });

    it('has 57 entries (7 AU + 50 US)', () => {
        expect(Object.keys(STATE_ABBREVIATIONS).length).toBe(57);
    });

    it('all abbreviations are 2-3 characters', () => {
        for (const [, abbr] of Object.entries(STATE_ABBREVIATIONS)) {
            expect(abbr.length).toBeGreaterThanOrEqual(2);
            expect(abbr.length).toBeLessThanOrEqual(3);
        }
    });
});

describe('MAJOR_BUOYS', () => {
    it('has buoys from multiple regions', () => {
        const types = new Set(MAJOR_BUOYS.map((b) => b.type));
        expect(types.has('noaa')).toBe(true);
        expect(types.has('bom')).toBe(true);
        expect(types.has('other')).toBe(true);
    });

    it('all buoys have required fields', () => {
        for (const buoy of MAJOR_BUOYS) {
            expect(buoy.id).toBeTruthy();
            expect(buoy.name).toBeTruthy();
            expect(typeof buoy.lat).toBe('number');
            expect(typeof buoy.lon).toBe('number');
            expect(buoy.type).toBeTruthy();
        }
    });

    it('all latitudes are in valid range [-90, 90]', () => {
        for (const buoy of MAJOR_BUOYS) {
            expect(buoy.lat).toBeGreaterThanOrEqual(-90);
            expect(buoy.lat).toBeLessThanOrEqual(90);
        }
    });

    it('all longitudes are in valid range [-180, 360]', () => {
        for (const buoy of MAJOR_BUOYS) {
            expect(buoy.lon).toBeGreaterThanOrEqual(-180);
            expect(buoy.lon).toBeLessThanOrEqual(360);
        }
    });

    it('no duplicate buoy IDs', () => {
        const ids = MAJOR_BUOYS.map((b) => b.id);
        const unique = new Set(ids);
        expect(unique.size).toBe(ids.length);
    });

    it('includes Australian east coast buoys', () => {
        const auBuoys = MAJOR_BUOYS.filter((b) => b.type === 'bom');
        expect(auBuoys.length).toBeGreaterThan(10);
        expect(auBuoys.some((b) => b.name.includes('Sydney'))).toBe(true);
        expect(auBuoys.some((b) => b.name.includes('Moreton'))).toBe(true);
    });

    it('includes NOAA US coast buoys', () => {
        const noaaBuoys = MAJOR_BUOYS.filter((b) => b.type === 'noaa');
        expect(noaaBuoys.length).toBeGreaterThan(15);
    });

    it('includes Mediterranean buoys', () => {
        const medBuoys = MAJOR_BUOYS.filter((b) =>
            ['GR01', 'GR02', 'IT01', 'ES01', 'HR01', 'TR01', 'MT01'].includes(b.id),
        );
        expect(medBuoys.length).toBe(7);
    });

    it('includes Hong Kong Observatory stations', () => {
        const hkoBuoys = MAJOR_BUOYS.filter((b) => b.type === 'hko');
        expect(hkoBuoys.length).toBe(4);
    });

    it('includes Irish marine buoys', () => {
        const ieBuoys = MAJOR_BUOYS.filter((b) => b.type === 'marine-ie');
        expect(ieBuoys.length).toBe(5);
    });

    it('BOM AWS stations have bomStationId', () => {
        const awsBuoys = MAJOR_BUOYS.filter((b) => b.type === 'bom-aws');
        expect(awsBuoys.length).toBeGreaterThan(0);
        for (const buoy of awsBuoys) {
            expect(buoy.bomStationId).toBeTruthy();
        }
    });
});
