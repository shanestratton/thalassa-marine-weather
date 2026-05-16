import { describe, it, expect } from 'vitest';
import { mapTimezoneToRegion } from '../utils/locale';

// Pure-function tests for the IANA-timezone → marine-region mapper.
// This is the foundation for sample-location rotation (PR3/Week 1)
// and the upcoming featured-passage rotation; keeping the regex
// table well-tested prevents a single typo from sending a Newport
// sailor to Sydney.
describe('mapTimezoneToRegion', () => {
    describe('Australia (AU)', () => {
        const auZones = [
            'Australia/Sydney',
            'Australia/Brisbane',
            'Australia/Melbourne',
            'Australia/Perth',
            'Australia/Hobart',
            'Australia/Adelaide',
            'Australia/Darwin',
        ];
        auZones.forEach((tz) => {
            it(`${tz} → AU`, () => {
                expect(mapTimezoneToRegion(tz)).toBe('AU');
            });
        });
    });

    describe('New Zealand (NZ)', () => {
        it('Pacific/Auckland → NZ', () => {
            expect(mapTimezoneToRegion('Pacific/Auckland')).toBe('NZ');
        });
        it('Pacific/Chatham → NZ', () => {
            expect(mapTimezoneToRegion('Pacific/Chatham')).toBe('NZ');
        });
        it('Pacific/Fiji does NOT match NZ', () => {
            expect(mapTimezoneToRegion('Pacific/Fiji')).toBe('DEFAULT');
        });
    });

    describe('United Kingdom (UK)', () => {
        const ukZones = [
            'Europe/London',
            'Europe/Dublin',
            'Europe/Belfast',
            'Europe/Isle_of_Man',
            'Europe/Guernsey',
            'Europe/Jersey',
        ];
        ukZones.forEach((tz) => {
            it(`${tz} → UK`, () => {
                expect(mapTimezoneToRegion(tz)).toBe('UK');
            });
        });
        it('Europe/Paris does NOT match UK', () => {
            expect(mapTimezoneToRegion('Europe/Paris')).toBe('DEFAULT');
        });
    });

    describe('US East Coast (US_EAST)', () => {
        const eastZones = [
            'America/New_York',
            'America/Detroit',
            'America/Toronto',
            'America/Halifax',
            'America/Boston',
            'America/Indiana/Indianapolis',
            'America/Kentucky/Louisville',
            'America/Chicago', // Central time bucketed into East for marine demo
            'America/Bermuda',
        ];
        eastZones.forEach((tz) => {
            it(`${tz} → US_EAST`, () => {
                expect(mapTimezoneToRegion(tz)).toBe('US_EAST');
            });
        });
    });

    describe('US West Coast (US_WEST)', () => {
        const westZones = [
            'America/Los_Angeles',
            'America/Vancouver',
            'America/Tijuana',
            'America/Anchorage',
            'America/Juneau',
        ];
        westZones.forEach((tz) => {
            it(`${tz} → US_WEST`, () => {
                expect(mapTimezoneToRegion(tz)).toBe('US_WEST');
            });
        });
    });

    describe('Unmapped regions → DEFAULT', () => {
        const defaults = [
            'Asia/Tokyo',
            'Asia/Singapore',
            'Europe/Berlin',
            'Africa/Cape_Town',
            'America/Sao_Paulo',
            'America/Mexico_City',
            'Etc/UTC',
            '',
            'not-a-timezone',
        ];
        defaults.forEach((tz) => {
            it(`${JSON.stringify(tz)} → DEFAULT`, () => {
                expect(mapTimezoneToRegion(tz)).toBe('DEFAULT');
            });
        });
    });
});
