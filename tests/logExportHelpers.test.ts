import { describe, it, expect } from 'vitest';
import { degreesToCardinal16, decodeHtmlEntities } from '../utils/logExportHelpers';

describe('degreesToCardinal16', () => {
    it('converts 0 degrees to N', () => {
        expect(degreesToCardinal16(0)).toBe('N');
    });

    it('converts 90 degrees to E', () => {
        expect(degreesToCardinal16(90)).toBe('E');
    });

    it('converts 180 degrees to S', () => {
        expect(degreesToCardinal16(180)).toBe('S');
    });

    it('converts 270 degrees to W', () => {
        expect(degreesToCardinal16(270)).toBe('W');
    });

    it('converts 45 degrees to NE', () => {
        expect(degreesToCardinal16(45)).toBe('NE');
    });

    it('converts 315 degrees to NW', () => {
        expect(degreesToCardinal16(315)).toBe('NW');
    });

    it('handles 360 degrees as N', () => {
        expect(degreesToCardinal16(360)).toBe('N');
    });

    it('handles negative degrees', () => {
        expect(degreesToCardinal16(-90)).toBe('W');
    });

    it('handles degrees > 360', () => {
        expect(degreesToCardinal16(450)).toBe('E');
    });

    it('handles all 16 cardinal points', () => {
        const expected: [number, string][] = [
            [0, 'N'],
            [22.5, 'NNE'],
            [45, 'NE'],
            [67.5, 'ENE'],
            [90, 'E'],
            [112.5, 'ESE'],
            [135, 'SE'],
            [157.5, 'SSE'],
            [180, 'S'],
            [202.5, 'SSW'],
            [225, 'SW'],
            [247.5, 'WSW'],
            [270, 'W'],
            [292.5, 'WNW'],
            [315, 'NW'],
            [337.5, 'NNW'],
        ];
        expected.forEach(([deg, dir]) => {
            expect(degreesToCardinal16(deg)).toBe(dir);
        });
    });
});

describe('decodeHtmlEntities', () => {
    it('decodes &amp; to &', () => {
        expect(decodeHtmlEntities('Tom &amp; Jerry')).toBe('Tom & Jerry');
    });

    it('decodes &quot; to "', () => {
        expect(decodeHtmlEntities('He said &quot;hello&quot;')).toBe('He said "hello"');
    });

    it('decodes &lt; and &gt;', () => {
        expect(decodeHtmlEntities('&lt;tag&gt;')).toBe('<tag>');
    });

    it('decodes &#34; to "', () => {
        expect(decodeHtmlEntities('value&#34;test')).toBe('value"test');
    });

    it('decodes &#39; to apostrophe', () => {
        expect(decodeHtmlEntities('it&#39;s')).toBe("it's");
    });

    it('decodes &nbsp; to space', () => {
        expect(decodeHtmlEntities('hello&nbsp;world')).toBe('hello world');
    });

    it('decodes hex entities &#x27; and &#x22;', () => {
        expect(decodeHtmlEntities('it&#x27;s a &#x22;test&#x22;')).toBe('it\'s a "test"');
    });

    it('replaces anchor emoji with >>', () => {
        expect(decodeHtmlEntities('Anchor \u2693 dropped')).toBe('Anchor >> dropped');
    });

    it('collapses multiple spaces', () => {
        expect(decodeHtmlEntities('hello    world')).toBe('hello world');
    });

    it('trims whitespace', () => {
        expect(decodeHtmlEntities('  hello  ')).toBe('hello');
    });

    it('handles empty string', () => {
        expect(decodeHtmlEntities('')).toBe('');
    });

    it('handles combined entities', () => {
        expect(decodeHtmlEntities('Tom &amp; Jerry said &quot;hello&quot;')).toBe('Tom & Jerry said "hello"');
    });
});
