import { WeatherMetrics } from '../../types';
import { degreesToCardinal } from '../../utils/format';

// Helper function to generate weather narrative based on current conditions
// Designed to be concise and consistent with the widget data displayed below
function generateWeatherNarrative(data: WeatherMetrics): string {
    const temp = data.airTemperature;
    const condition = data.condition || '';
    const windSpeed = data.windSpeed || 0;
    const windDir = data.windDirection || degreesToCardinal(data.windDegree || 0);
    const windGust = data.windGust || 0;
    const waveHeight = data.waveHeight || 0; // Already in feet from transformers
    const visibility = data.visibility || 0;
    const pressure = data.pressure || 1013;

    const parts: string[] = [];

    // 1. CONDITION - First, headline (capitalize)
    if (condition && condition.toLowerCase() !== 'unknown') {
        const cap = condition.charAt(0).toUpperCase() + condition.slice(1).toLowerCase();
        parts.push(cap);
    }

    // 2. WIND - Key metric: "Wind DIR at SPEEDkts (gusts Xkts)"
    if (windSpeed > 0) {
        let windStr = `Wind ${windDir || 'VAR'} at ${Math.round(windSpeed)}kts`;
        if (windGust > windSpeed + 3) {
            windStr += `, gusts ${Math.round(windGust)}kts`;
        }
        parts.push(windStr);
    } else {
        parts.push('Calm winds');
    }

    // 3. SEAS - "Seas Xft" or sea state descriptor
    const waveHeightFt = waveHeight; // Already in feet
    if (waveHeightFt >= 8) {
        parts.push(`Very rough seas ${waveHeightFt.toFixed(1)}ft`);
    } else if (waveHeightFt >= 4) {
        parts.push(`Rough seas ${waveHeightFt.toFixed(1)}ft`);
    } else if (waveHeightFt >= 2) {
        parts.push(`Moderate seas ${waveHeightFt.toFixed(1)}ft`);
    } else if (waveHeightFt > 0.5) {
        parts.push(`Slight seas ${waveHeightFt.toFixed(1)}ft`);
    } else {
        parts.push('Calm seas');
    }

    // 4. VISIBILITY - Only if notable (poor or moderate)
    if (visibility > 0 && visibility < 5) {
        parts.push(`Vis ${visibility.toFixed(1)}nm`);
    }

    // 5. PRESSURE - Only if notable (low = bad weather, high = stable)
    if (pressure < 1000) {
        parts.push(`Low pressure ${Math.round(pressure)}hPa`);
    } else if (pressure > 1025) {
        parts.push(`High pressure ${Math.round(pressure)}hPa`);
    }

    // 6. TEMP - append at end
    if (temp !== null && temp !== undefined) {
        parts.push(`${Math.round(temp)}°C`);
    }

    // Join with periods for readability
    return parts.join('. ') + '.' || 'Pleasant conditions expected.';
}

// Moon phase calculation using accurate synodic month
function getMoonPhase(date: Date): { phase: string; emoji: string } {
    // Known new moon reference: January 6, 2000 at 18:14 UTC
    const knownNewMoon = new Date(Date.UTC(2000, 0, 6, 18, 14, 0));

    // Synodic month length (average time between new moons)
    const synodicMonth = 29.53058770576;

    // Calculate days since the known new moon
    const daysSinceNewMoon = (date.getTime() - knownNewMoon.getTime()) / (1000 * 60 * 60 * 24);

    // Get the current position in the lunar cycle (0 to 1)
    let lunarAge = daysSinceNewMoon / synodicMonth;
    lunarAge = lunarAge - Math.floor(lunarAge); // Get fractional part (0 to 1)

    // Convert to 8 phases (0-7)
    // 0 = New Moon, 1 = Waxing Crescent, 2 = First Quarter, 3 = Waxing Gibbous
    // 4 = Full Moon, 5 = Waning Gibbous, 6 = Last Quarter, 7 = Waning Crescent
    const phaseIndex = Math.round(lunarAge * 8) % 8;

    const phases = [
        { phase: 'New', emoji: '🌑' },
        { phase: 'Waxing Crescent', emoji: '🌒' },
        { phase: 'First Quarter', emoji: '🌓' },
        { phase: 'Waxing Gibbous', emoji: '🌔' },
        { phase: 'Full', emoji: '🌕' },
        { phase: 'Waning Gibbous', emoji: '🌖' },
        { phase: 'Last Quarter', emoji: '🌗' },
        { phase: 'Waning Crescent', emoji: '🌘' }
    ];

    return phases[phaseIndex];
}

export { generateWeatherNarrative, getMoonPhase };
