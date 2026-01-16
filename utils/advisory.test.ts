import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { generateTacticalAdvice } from './advisory';
import { WeatherMetrics, VesselProfile } from '../types';

// Mock Data
const MOCK_METRICS: WeatherMetrics = {
    windSpeed: 5,
    windDirection: 'N',
    waveHeight: 0.5,
    visibility: 10,
    airTemperature: 25,
    waterTemperature: 22,
    pressure: 1013,
    humidity: 60,
    condition: 'Sunny',
    uvIndex: 5,
    cloudCover: 10,
    dewPoint: 15,
    windGust: 7,
    swellPeriod: 6,
    description: "Mock Description"
};

const MOCK_VESSEL: VesselProfile = {
    name: 'Thalassa Test',
    type: 'sail',
    displacement: 5000,
    length: 30,
    draft: 1.5,
    beam: 3,
    maxWindSpeed: 25,
    maxWaveHeight: 8,
    cruisingSpeed: 6
};

describe('generateTacticalAdvice', () => {
    it('should generate "Good" advice for calm conditions', () => {
        const advice = generateTacticalAdvice(MOCK_METRICS, false, "Test Loc", MOCK_VESSEL);
        expect(advice).toContain("Conditions are excellent");
    });

    it('should warn when wind exceeds vessel limits', () => {
        const highWind = { ...MOCK_METRICS, windSpeed: 26 }; // > maxWindSpeed (25)
        const advice = generateTacticalAdvice(highWind, false, "Test Loc", MOCK_VESSEL);
        expect(advice).toContain("CRITICAL: Winds > 25kts exceed safety limits");
    });

    it('should warn when waves exceed vessel limits', () => {
        const bigWeaves = { ...MOCK_METRICS, waveHeight: 9 }; // > maxWaveHeight (8)
        const advice = generateTacticalAdvice(bigWeaves, false, "Test Loc", MOCK_VESSEL);
        expect(advice).toContain("DANGER: Seas > 8ft exceed handling limits");
    });

    it('should provide specific advice for "landlocked" locations', () => {
        // Landlocked implies no waves usually, but function logic might just omit sea state
        const advice = generateTacticalAdvice(MOCK_METRICS, true, "Mountain Lake", MOCK_VESSEL);
        expect(advice).not.toContain("Seas are flat"); // Should skip sea state block check
        expect(advice).toContain("Mountain Lake");
    });

    it('should warn about fog when visibility is low', () => {
        const fogMetrics = { ...MOCK_METRICS, visibility: 0.5 };
        const advice = generateTacticalAdvice(fogMetrics, false, "Foggy Bay", MOCK_VESSEL);
        expect(advice).toContain("Fog banks reported");
    });

    it('should generate sunset warnings if late', () => {
        // Mock System Time to 17:00 (1 hour before 18:00 sunset)
        const date = new Date(2000, 1, 1, 17, 0, 0);
        vi.setSystemTime(date);

        const advice = generateTacticalAdvice(MOCK_METRICS, false, "Test", MOCK_VESSEL, [], "18:00");
        expect(advice).toContain("Sunset at 18:00");

        vi.useRealTimers();
    });
});
