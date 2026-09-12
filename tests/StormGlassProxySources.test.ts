import { describe, expect, it } from 'vitest';
import { normalizeStormGlassSources } from '../supabase/functions/_shared/stormglass-source';

describe('StormGlass proxy source allowlist', () => {
    it.each([
        ['sg', 'sg'],
        ['ecmwf', 'ecmwf'],
        ['noaa', 'noaa'],
        ['ecmwf,sg', 'ecmwf,sg'],
        ['noaa,sg', 'noaa,sg'],
        ['gfs', 'noaa'],
        ['gfs,sg', 'noaa,sg'],
        ['icon', 'sg'],
    ])('normalizes %s to documented upstream %s', (input, expected) => {
        expect(normalizeStormGlassSources(input)).toBe(expected);
    });

    it.each([
        null,
        undefined,
        42,
        [],
        {},
        '',
        'all',
        '*',
        'dwd',
        'aifs',
        'sg,sg',
        'gfs,noaa',
        'icon,sg',
        'sg,ecmwf,noaa',
        'noaa,',
        ',sg',
        'SG',
        'noaa, sg',
        'sg\n',
        'noaa&key=secret',
        'sg,'.repeat(50),
    ])('rejects unsupported, duplicate or unbounded sources: %j', (input) => {
        expect(normalizeStormGlassSources(input)).toBeNull();
    });
});
