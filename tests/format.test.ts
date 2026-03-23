import { describe, it, expect } from 'vitest';
import {
    formatLocationInput,
    degreesToCardinal,
    cardinalToDegrees,
    expandCompassDirection,
    expandForSpeech,
    formatCoordinate,
} from '../utils/format';

describe('formatLocationInput', () => {
    it('capitalizes normal words', () => {
        expect(formatLocationInput('san francisco')).toBe('San Francisco');
    });

    it('keeps US state abbreviations uppercase', () => {
        expect(formatLocationInput('new york, ny')).toContain('NY');
    });

    it('keeps Australian state abbreviations uppercase', () => {
        expect(formatLocationInput('sydney, nsw')).toContain('NSW');
    });

    it('handles mixed case input', () => {
        expect(formatLocationInput('BRISBANE, QLD')).toContain('QLD');
    });

    it('handles single word', () => {
        expect(formatLocationInput('london')).toBe('London');
    });

    it('handles empty string', () => {
        expect(formatLocationInput('')).toBe('');
    });

    it('keeps country abbreviations uppercase', () => {
        const result = formatLocationInput('visiting usa');
        expect(result).toContain('USA');
    });
});

describe('degreesToCardinal', () => {
    it('returns N for 0 degrees', () => {
        expect(degreesToCardinal(0)).toBe('N');
    });

    it('returns E for 90 degrees', () => {
        expect(degreesToCardinal(90)).toBe('E');
    });

    it('returns S for 180 degrees', () => {
        expect(degreesToCardinal(180)).toBe('S');
    });

    it('returns W for 270 degrees', () => {
        expect(degreesToCardinal(270)).toBe('W');
    });

    it('returns NE for 45 degrees', () => {
        expect(degreesToCardinal(45)).toBe('NE');
    });

    it('returns SE for 135 degrees', () => {
        expect(degreesToCardinal(135)).toBe('SE');
    });

    it('returns SW for 225 degrees', () => {
        expect(degreesToCardinal(225)).toBe('SW');
    });

    it('returns NW for 315 degrees', () => {
        expect(degreesToCardinal(315)).toBe('NW');
    });

    it('returns -- for null', () => {
        expect(degreesToCardinal(null)).toBe('--');
    });

    it('returns -- for undefined', () => {
        expect(degreesToCardinal(undefined)).toBe('--');
    });

    it('handles 360 degrees as N', () => {
        expect(degreesToCardinal(360)).toBe('N');
    });

    it('handles intermediate angles correctly', () => {
        expect(degreesToCardinal(22)).toBe('NNE');
        expect(degreesToCardinal(67)).toBe('ENE');
        expect(degreesToCardinal(112)).toBe('ESE');
        expect(degreesToCardinal(157)).toBe('SSE');
        expect(degreesToCardinal(202)).toBe('SSW');
        expect(degreesToCardinal(247)).toBe('WSW');
        expect(degreesToCardinal(292)).toBe('WNW');
        expect(degreesToCardinal(337)).toBe('NNW');
    });
});

describe('cardinalToDegrees', () => {
    it('converts N to 0', () => {
        expect(cardinalToDegrees('N')).toBe(0);
    });

    it('converts E to 90', () => {
        expect(cardinalToDegrees('E')).toBe(90);
    });

    it('converts S to 180', () => {
        expect(cardinalToDegrees('S')).toBe(180);
    });

    it('converts W to 270', () => {
        expect(cardinalToDegrees('W')).toBe(270);
    });

    it('converts NE to 45', () => {
        expect(cardinalToDegrees('NE')).toBe(45);
    });

    it('converts SE to 135', () => {
        expect(cardinalToDegrees('SE')).toBe(135);
    });

    it('handles lowercase input', () => {
        expect(cardinalToDegrees('ne')).toBe(45);
    });

    it('returns undefined for null', () => {
        expect(cardinalToDegrees(null)).toBeUndefined();
    });

    it('returns undefined for undefined', () => {
        expect(cardinalToDegrees(undefined)).toBeUndefined();
    });

    it('returns undefined for invalid cardinal', () => {
        expect(cardinalToDegrees('XYZ')).toBeUndefined();
    });

    it('converts all 16 cardinals correctly', () => {
        expect(cardinalToDegrees('NNE')).toBe(22.5);
        expect(cardinalToDegrees('ENE')).toBe(67.5);
        expect(cardinalToDegrees('ESE')).toBe(112.5);
        expect(cardinalToDegrees('SSE')).toBe(157.5);
        expect(cardinalToDegrees('SSW')).toBe(202.5);
        expect(cardinalToDegrees('WSW')).toBe(247.5);
        expect(cardinalToDegrees('WNW')).toBe(292.5);
        expect(cardinalToDegrees('NNW')).toBe(337.5);
    });
});

describe('expandCompassDirection', () => {
    it('expands N to North', () => {
        expect(expandCompassDirection('N')).toBe('North');
    });

    it('expands NNE to North-Northeast', () => {
        expect(expandCompassDirection('NNE')).toBe('North-Northeast');
    });

    it('expands SE to Southeast', () => {
        expect(expandCompassDirection('SE')).toBe('Southeast');
    });

    it('returns Unknown for empty string', () => {
        expect(expandCompassDirection('')).toBe('Unknown');
    });

    it('returns input for unknown direction', () => {
        expect(expandCompassDirection('XYZ')).toBe('XYZ');
    });

    it('expands all 16 directions', () => {
        const expected: Record<string, string> = {
            N: 'North',
            NNE: 'North-Northeast',
            NE: 'Northeast',
            ENE: 'East-Northeast',
            E: 'East',
            ESE: 'East-Southeast',
            SE: 'Southeast',
            SSE: 'South-Southeast',
            S: 'South',
            SSW: 'South-Southwest',
            SW: 'Southwest',
            WSW: 'West-Southwest',
            W: 'West',
            WNW: 'West-Northwest',
            NW: 'Northwest',
            NNW: 'North-Northwest',
        };
        Object.entries(expected).forEach(([abbr, full]) => {
            expect(expandCompassDirection(abbr)).toBe(full);
        });
    });
});

describe('expandForSpeech', () => {
    it('expands kts to knots', () => {
        expect(expandForSpeech('Wind 15 kts from NE')).toContain('knots');
    });

    it('expands nm to nautical miles', () => {
        expect(expandForSpeech('visibility 10 nm ahead')).toContain('nautical miles');
    });

    it('expands ft to feet', () => {
        expect(expandForSpeech('Waves 6 ft high')).toContain('feet');
    });

    it('expands °C to degrees Celsius', () => {
        expect(expandForSpeech('Temperature 20°C')).toContain('degrees Celsius');
    });

    it('expands °F to degrees Fahrenheit', () => {
        expect(expandForSpeech('Temperature 68°F')).toContain('degrees Fahrenheit');
    });

    it('expands mb to millibars', () => {
        expect(expandForSpeech('Pressure 1013 mb falling')).toContain('millibars');
    });

    it('expands hPa to hectopascals', () => {
        expect(expandForSpeech('Pressure 1013 hPa steady')).toContain('hectopascals');
    });

    it('returns empty string for null/empty input', () => {
        expect(expandForSpeech('')).toBe('');
    });

    it('expands country abbreviations', () => {
        const result = expandForSpeech('Sailing to AU');
        expect(result).toContain('Australia');
    });
});

describe('formatCoordinate', () => {
    it('formats positive latitude as N', () => {
        expect(formatCoordinate(27.45, 'lat')).toBe('27.4500°N');
    });

    it('formats negative latitude as S', () => {
        expect(formatCoordinate(-27.45, 'lat')).toBe('27.4500°S');
    });

    it('formats positive longitude as E', () => {
        expect(formatCoordinate(153.02, 'lon')).toBe('153.0200°E');
    });

    it('formats negative longitude as W', () => {
        expect(formatCoordinate(-153.02, 'lon')).toBe('153.0200°W');
    });

    it('formats zero latitude as N', () => {
        expect(formatCoordinate(0, 'lat')).toBe('0.0000°N');
    });

    it('formats zero longitude as E', () => {
        expect(formatCoordinate(0, 'lon')).toBe('0.0000°E');
    });
});
