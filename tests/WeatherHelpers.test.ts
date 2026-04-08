import { describe, it, expect } from 'vitest';
import { generateWeatherNarrative, getMoonPhase } from '../components/dashboard/WeatherHelpers';

describe('generateWeatherNarrative', () => {
    it('includes capitalized condition', () => {
        const narrative = generateWeatherNarrative({
            airTemperature: 22,
            condition: 'partly cloudy',
            windSpeed: 10,
            windDirection: 'NW',
            windDegree: 315,
        } as any);
        expect(narrative).toContain('Partly cloudy');
    });

    it('omits unknown condition', () => {
        const narrative = generateWeatherNarrative({
            airTemperature: 22,
            condition: 'unknown',
            windSpeed: 10,
            windDirection: 'S',
        } as any);
        expect(narrative).not.toContain('Unknown');
    });

    it('includes wind with direction and speed', () => {
        const narrative = generateWeatherNarrative({
            windSpeed: 15,
            windDirection: 'NE',
            windGust: 25,
        } as any);
        expect(narrative).toContain('Wind NE at 15kts');
        expect(narrative).toContain('gusts 25kts');
    });

    it('shows calm winds when windSpeed is 0', () => {
        const narrative = generateWeatherNarrative({ windSpeed: 0 } as any);
        expect(narrative).toContain('Calm winds');
    });

    it('omits gust if gust <= windSpeed + 3', () => {
        const narrative = generateWeatherNarrative({
            windSpeed: 10,
            windGust: 13,
            windDirection: 'N',
        } as any);
        expect(narrative).not.toContain('gusts');
    });

    it('classifies sea states correctly', () => {
        expect(generateWeatherNarrative({ waveHeight: 9 } as any)).toContain('Very rough seas');
        expect(generateWeatherNarrative({ waveHeight: 5 } as any)).toContain('Rough seas');
        expect(generateWeatherNarrative({ waveHeight: 3 } as any)).toContain('Moderate seas');
        expect(generateWeatherNarrative({ waveHeight: 1 } as any)).toContain('Slight seas');
        expect(generateWeatherNarrative({ waveHeight: 0.2 } as any)).toContain('Calm seas');
    });

    it('includes poor visibility', () => {
        const narrative = generateWeatherNarrative({ visibility: 2 } as any);
        expect(narrative).toContain('Vis 2.0nm');
    });

    it('omits visibility when > 5nm', () => {
        const narrative = generateWeatherNarrative({ visibility: 10 } as any);
        expect(narrative).not.toContain('Vis');
    });

    it('includes low pressure warning', () => {
        const narrative = generateWeatherNarrative({ pressure: 990 } as any);
        expect(narrative).toContain('Low pressure 990hPa');
    });

    it('includes high pressure note', () => {
        const narrative = generateWeatherNarrative({ pressure: 1030 } as any);
        expect(narrative).toContain('High pressure 1030hPa');
    });

    it('appends temperature at end', () => {
        const narrative = generateWeatherNarrative({ airTemperature: 22 } as any);
        expect(narrative).toContain('22°C');
    });

    it('joins parts with periods', () => {
        const narrative = generateWeatherNarrative({
            windSpeed: 10,
            windDirection: 'N',
            waveHeight: 1.5,
        } as any);
        expect(narrative).toMatch(/\. /);
    });
});

describe('getMoonPhase', () => {
    it('returns a known new moon', () => {
        // Jan 6, 2000 is the reference new moon
        const phase = getMoonPhase(new Date(Date.UTC(2000, 0, 6, 18, 14, 0)));
        expect(phase.phase).toBe('New');
        expect(phase.emoji).toBe('🌑');
    });

    it('returns full moon ~14.76 days after new moon', () => {
        // Approx full moon: Jan 21, 2000
        const phase = getMoonPhase(new Date(Date.UTC(2000, 0, 21)));
        expect(phase.phase).toBe('Full');
        expect(phase.emoji).toBe('🌕');
    });

    it('returns one of 8 valid phases', () => {
        const validPhases = [
            'New',
            'Waxing Crescent',
            'First Quarter',
            'Waxing Gibbous',
            'Full',
            'Waning Gibbous',
            'Last Quarter',
            'Waning Crescent',
        ];
        // Test a range of dates
        for (let d = 0; d < 30; d++) {
            const date = new Date(Date.UTC(2024, 5, d + 1));
            const phase = getMoonPhase(date);
            expect(validPhases).toContain(phase.phase);
            expect(phase.emoji).toBeTruthy();
        }
    });

    it('cycles back to the same phase after ~29.53 days', () => {
        const baseDate = new Date(Date.UTC(2024, 0, 1));
        const oneMonthLater = new Date(baseDate.getTime() + 29.53058770576 * 86400000);
        expect(getMoonPhase(baseDate).phase).toBe(getMoonPhase(oneMonthLater).phase);
    });
});
