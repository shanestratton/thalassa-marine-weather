import { WeatherMetrics } from '../../types';

// Helper function to generate weather narrative based on current conditions
function generateWeatherNarrative(data: WeatherMetrics): string {
    const temp = data.airTemperature || 0;
    const waterTemp = data.waterTemperature;
    const condition = data.condition?.toLowerCase() || '';
    const description = data.description || '';
    const precip = data.precipitation || 0;
    const cloudCover = data.cloudCover || 0;
    const uv = data.uvIndex || 0;
    const windSpeed = data.windSpeed || 0;
    const windGust = data.windGust || 0;
    const windDir = data.windDirection;
    const waveHeight = data.waveHeight || 0;
    const visibility = data.visibility || 10;
    const pressure = data.pressure || 1013;
    const humidity = data.humidity || 0;
    const dewPoint = (data as any).dewPoint;

    let narrative = '';

    // DEBUG: Log wind data to help diagnose discrepancy
    console.log('[WeatherNarrative] Wind data:', {
        windSpeed,
        windDir,
        windGust,
        condition,
        description
    });

    // 1. WEATHER DESCRIPTION/CONDITION (First - headline)
    if (description && description.length > 0 && description !== 'Unknown') {
        narrative += `${description}. `;
    } else if (condition && condition.length > 0 && condition !== 'unknown') {
        const capitalizedCondition = condition.charAt(0).toUpperCase() + condition.slice(1);
        narrative += `${capitalizedCondition}. `;
    }

    // 2. HUMIDITY (Second - atmospheric condition)
    if (humidity >= 90) {
        narrative += `💧 Very humid ${Math.round(humidity)}%. `;
    } else if (humidity >= 75) {
        narrative += `Humid ${Math.round(humidity)}%. `;
    } else if (humidity <= 30) {
        narrative += `Dry ${Math.round(humidity)}%. `;
    } else if (humidity > 0) {
        narrative += `Humidity ${Math.round(humidity)}%. `;
    }

    // 3. DEW POINT (Third - fog/condensation risk)
    if (dewPoint !== undefined && dewPoint !== null) {
        const fogRisk = temp - dewPoint;
        if (fogRisk <= 2) {
            narrative += `🌫️ Fog/mist likely, dew point ${Math.round(dewPoint)}°C. `;
        } else if (fogRisk <= 5) {
            narrative += `Dew point ${Math.round(dewPoint)}°C. `;
        }
    }

    // 4. WIND CONDITIONS (Most important for mariners)
    if (windSpeed >= 40) {
        narrative += `🌪️ GALE FORCE winds ${Math.round(windSpeed)}kts`;
        if (windGust > windSpeed + 5) narrative += ` gusting ${Math.round(windGust)}kts`;
        narrative += `. Hazardous conditions. `;
    } else if (windSpeed >= 30) {
        narrative += `💨 Strong winds ${Math.round(windSpeed)}kts`;
        if (windGust > windSpeed + 5) narrative += ` gusting ${Math.round(windGust)}kts`;
        narrative += ` from ${windDir || 'variable'}. Rough conditions. `;
    } else if (windSpeed >= 20) {
        narrative += `🌬️ Fresh winds ${Math.round(windSpeed)}kts`;
        if (windGust > windSpeed + 5) narrative += ` gusting ${Math.round(windGust)}kts`;
        narrative += ` from ${windDir || 'variable'}. `;
    } else if (windSpeed >= 12) {
        narrative += `Moderate winds ${Math.round(windSpeed)}kts`;
        if (windGust > windSpeed + 5) narrative += ` gusting ${Math.round(windGust)}kts`;
        narrative += ` from ${windDir || 'variable'}. `;
    } else if (windSpeed >= 6) {
        narrative += `Light winds ${Math.round(windSpeed)}kts`;
        if (windGust > windSpeed + 5) narrative += ` gusting ${Math.round(windGust)}kts`;
        narrative += `. `;
    } else {
        narrative += `Calm conditions, winds under 6kts. `;
    }

    // 5. SEA STATE
    const waveHeightMeters = waveHeight / 3.28084;
    if (waveHeightMeters >= 4) {
        narrative += `Very rough seas ${waveHeightMeters.toFixed(1)}m. `;
    } else if (waveHeightMeters >= 2.5) {
        narrative += `Rough seas ${waveHeightMeters.toFixed(1)}m. `;
    } else if (waveHeightMeters >= 1.5) {
        narrative += `Moderate seas ${waveHeightMeters.toFixed(1)}m. `;
    } else if (waveHeightMeters >= 0.5) {
        narrative += `Slight seas ${waveHeightMeters.toFixed(1)}m. `;
    } else if (waveHeightMeters > 0) {
        narrative += `Calm seas. `;
    }

    // 6. VISIBILITY
    if (visibility < 2) {
        narrative += `⚠️ Poor visibility ${visibility.toFixed(1)}nm. `;
    } else if (visibility < 5) {
        narrative += `Moderate visibility ${visibility.toFixed(1)}nm. `;
    } else if (visibility >= 10) {
        narrative += `Excellent visibility. `;
    }

    // 7. PRECIPITATION
    if (precip > 10) {
        narrative += `Heavy rain ${precip.toFixed(1)}mm/hr. `;
    } else if (precip > 5) {
        narrative += `Moderate rain likely. `;
    } else if (precip > 1) {
        narrative += `Light showers possible. `;
    }

    // 8. CLOUD COVER & SKY
    if (cloudCover > 80) {
        narrative += `Overcast skies. `;
    } else if (cloudCover > 50) {
        narrative += `Partly cloudy. `;
    } else if (cloudCover < 20) {
        narrative += `Clear skies. `;
    }

    // 9. TEMPERATURE CONTEXT
    if (temp > 30) {
        narrative += `🔥 Hot ${Math.round(temp)}°C. `;
    } else if (temp > 25) {
        narrative += `Warm ${Math.round(temp)}°C. `;
    } else if (temp > 15) {
        narrative += `Mild ${Math.round(temp)}°C. `;
    } else if (temp > 5) {
        narrative += `Cool ${Math.round(temp)}°C. `;
    } else {
        narrative += `Cold ${Math.round(temp)}°C. `;
    }

    // 10. WATER TEMPERATURE (if available)
    if (waterTemp !== null && waterTemp !== undefined) {
        const diff = temp - waterTemp;
        if (Math.abs(diff) > 3) {
            narrative += `Water ${Math.round(waterTemp)}°C${diff > 0 ? ' (cooler)' : ' (warmer)'}. `;
        }
    }

    // 11. PRESSURE TREND
    if (pressure < 1000) {
        narrative += `Low pressure ${Math.round(pressure)}hPa - weather may deteriorate. `;
    } else if (pressure > 1025) {
        narrative += `High pressure ${Math.round(pressure)}hPa - stable conditions. `;
    }

    // 12. UV INDEX (if significant)
    if (uv >= 8) {
        narrative += `☀️ Very high UV${uv}, sun protection essential. `;
    } else if (uv >= 6) {
        narrative += `UV moderate, sun protection recommended. `;
    }

    return narrative.trim() || 'Pleasant conditions expected.';
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
