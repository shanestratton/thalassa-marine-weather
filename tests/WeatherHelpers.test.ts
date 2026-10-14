import { describe, it, expect } from 'vitest';
import { getMoonPhase } from '../components/dashboard/WeatherHelpers';

// generateWeatherNarrative is gone (130-04): it had no caller outside its own
// test, and it called 1.2 m (4 ft) "Rough seas", where WMO 3700 says Moderate.

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

describe('the dashboard helpers keep only the moon', () => {
    it('generateWeatherNarrative is no longer exported', async () => {
        const helpers = await import('../components/dashboard/WeatherHelpers');
        expect(Object.keys(helpers)).toEqual(['getMoonPhase']);
    });
});
