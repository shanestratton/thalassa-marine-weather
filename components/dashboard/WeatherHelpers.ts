import { WeatherMetrics } from '../../types';

// Helper function to generate weather narrative based on current conditions
function generateWeatherNarrative(data: WeatherMetrics): string {
    const temp = data.airTemperature || 0;
    const waterTemp = data.waterTemperature;
    const condition = data.condition?.toLowerCase() || '';
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

    let narrative = '';

    // WIND CONDITIONS (Most important for mariners)
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

    // SEA STATE (convert from feet to meters)
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

    // VISIBILITY
    if (visibility < 2) {
        narrative += `⚠️ Poor visibility ${visibility.toFixed(1)}nm. `;
    } else if (visibility < 5) {
        narrative += `Moderate visibility ${visibility.toFixed(1)}nm. `;
    } else if (visibility >= 10) {
        narrative += `Excellent visibility. `;
    }

    // PRECIPITATION
    if (precip > 10) {
        narrative += `Heavy rain ${precip.toFixed(1)}mm/hr. `;
    } else if (precip > 5) {
        narrative += `Moderate rain likely. `;
    } else if (precip > 1) {
        narrative += `Light showers possible. `;
    }

    // CLOUD COVER & SKY
    if (cloudCover > 80) {
        narrative += `Overcast skies. `;
    } else if (cloudCover > 50) {
        narrative += `Partly cloudy. `;
    } else if (cloudCover < 20) {
        narrative += `Clear skies. `;
    }

    // TEMPERATURE CONTEXT
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

    // WATER TEMPERATURE (if available)
    if (waterTemp !== null && waterTemp !== undefined) {
        const diff = temp - waterTemp;
        if (Math.abs(diff) > 3) {
            narrative += `Water ${Math.round(waterTemp)}°C${diff > 0 ? ' (cooler)' : ' (warmer)'}. `;
        }
    }

    // PRESSURE TREND
    if (pressure < 1000) {
        narrative += `Low pressure ${Math.round(pressure)}hPa - weather may deteriorate. `;
    } else if (pressure > 1025) {
        narrative += `High pressure ${Math.round(pressure)}hPa - stable conditions. `;
    }

    // UV INDEX (if significant)
    if (uv >= 8) {
        narrative += `☀️ Very high UV${uv}, sun protection essential.`;
    } else if (uv >= 6) {
        narrative += `UV moderate, sun protection recommended.`;
    }

    return narrative.trim() || 'Pleasant conditions expected.';
}

// Moon phase calculation
function getMoonPhase(date: Date): { phase: string; emoji: string } {
    const year = date.getFullYear();
    const month = date.getMonth() + 1;
    const day = date.getDate();

    let c = 0;
    let e = 0;
    let jd = 0;
    let b = 0;

    if (month < 3) {
        const year_adj = year - 1;
        const month_adj = month + 12;
        c = year_adj;
        e = month_adj;
    } else {
        c = year;
        e = month;
    }

    c = Math.floor(365.25 * c);
    e = Math.floor(30.6 * e);
    jd = c + e + day - 694039.09; // jd is total days elapsed
    jd /= 29.5305882; // divide by the moon cycle
    b = Math.floor(jd); // int(jd) -> b, take integer part of jd
    jd -= b; // subtract integer part to leave fractional part of original jd
    b = Math.round(jd * 8); // scale fraction from 0-8 and round

    if (b >= 8) b = 0; // 0 and 8 are the same so turn 8 into 0

    // &#x1F311 = 🌑 New Moon
    // &#x1F312 = 🌒 Waxing Crescent
    // &#x1F313 = 🌓 First Quarter
    // &#x1F314 = 🌔 Waxing Gibbous
    // &#x1F315 = 🌕 Full Moon
    // &#x1F316 = 🌖 Waning Gibbous
    // &#x1F317 = 🌗 Last Quarter
    // &#x1F318 = 🌘 Waning Crescent

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

    return phases[b];
}

export { generateWeatherNarrative, getMoonPhase };
