
import { UnitPreferences, WeatherMetrics, Tide, VesselProfile, ForecastDay, HourlyForecast, NotificationPreferences } from './types';
import { Haptics, ImpactStyle } from '@capacitor/haptics';
import { Capacitor } from '@capacitor/core';

export const triggerHaptic = async (style: 'light' | 'medium' | 'heavy' = 'light') => {
    if (Capacitor.isNativePlatform()) {
        try {
            let impact = ImpactStyle.Light;
            if (style === 'medium') impact = ImpactStyle.Medium;
            if (style === 'heavy') impact = ImpactStyle.Heavy;
            await Haptics.impact({ style: impact });
        } catch (e) {
            // Ignore haptic errors
        }
    }
};

export const getSystemUnits = (): UnitPreferences => {
    // Default to Metric/International
    const defaults: UnitPreferences = { 
        speed: 'kts', 
        length: 'm', 
        tideHeight: 'm', 
        temp: 'C', 
        distance: 'nm', 
        visibility: 'nm', 
        volume: 'l' 
    };

    if (typeof navigator === 'undefined') return defaults;

    // Check for US Locale (Imperial Defaults)
    // We check both languages array and single property for broader support
    const languages = navigator.languages || [navigator.language || 'en'];
    const isUS = languages.some(l => l.toLowerCase() === 'en-us' || l.toLowerCase() === 'en-us');

    if (isUS) {
        return {
            speed: 'kts', 
            length: 'ft',
            tideHeight: 'ft',
            temp: 'F',
            distance: 'nm',
            visibility: 'nm',
            volume: 'gal'
        };
    }

    return defaults;
};

export const formatLocationInput = (input: string): string => {
    const ABBREVS = new Set([
        'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY',
        'NSW','QLD','VIC','TAS','WA','SA','NT','ACT',
        'UK','USA','UAE','NZ','AU','US','CA',
        'DC', 'PR', 'VI'
    ]);

    return input.split(/(\s+)/).map(part => {
        if (part.trim().length === 0) return part;
        const clean = part.replace(/[.,]/g, '').toUpperCase();
        if (ABBREVS.has(clean)) return part.toUpperCase();
        return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
    }).join('');
};

export const convertSpeed = (kts: number | null | undefined, unit: string) => {
    if (kts === null || kts === undefined) return null;
    let val = kts;
    if(unit === 'mph') val = kts * 1.15078;
    if(unit === 'kmh') val = kts * 1.852;
    if(unit === 'mps') val = kts * 0.514444;
    return parseFloat(val.toFixed(1));
};

export const convertLength = (ft: number | null | undefined, unit: string) => {
    if (ft === null || ft === undefined) return null;
    if (unit === 'm') return parseFloat((ft * 0.3048).toFixed(1));
    return parseFloat(ft.toFixed(1));
};

export const convertWeight = (lbs: number | null | undefined, unit: string) => {
    if (lbs === null || lbs === undefined) return null;
    if (unit === 'kg') return parseFloat((lbs * 0.453592).toFixed(0));
    if (unit === 'tonnes') return parseFloat((lbs * 0.000453592).toFixed(2));
    return parseFloat(lbs.toFixed(0));
};

export const convertTemp = (val: number | null | undefined, unit: string) => {
    if (val === undefined || val === null) return '--';
    
    // API always returns Celsius. Convert if unit is F.
    if (unit === 'F') {
        const f = (val * 9/5) + 32;
        return f.toFixed(0);
    }
    
    return val.toFixed(0);
};

export const convertDistance = (miles: number | null | undefined, unit: string) => {
    if (miles === undefined || miles === null) return '--';
    let val = miles;
    if (unit === 'km') val = miles * 1.60934;
    if (unit === 'nm') val = miles * 0.868976;
    return val.toFixed(1);
}

export const convertPrecip = (mm: number | null | undefined, tempUnit: string) => {
    if (mm === undefined || mm === null || mm === 0) return null;
    if (tempUnit === 'F') {
        const inches = mm * 0.0393701;
        if (inches < 0.01) return '<0.01"';
        return `${inches.toFixed(2)}"`;
    }
    return `${mm.toFixed(1)}mm`;
}

export const calculateWindChill = (temp: number, speedKnots: number, unit: string): number | null => {
    if (temp === undefined || temp === null || speedKnots === undefined || speedKnots === null) return null;
    const tempF = unit === 'C' ? (temp * 9/5) + 32 : temp;
    const speedMph = speedKnots * 1.15078;
    if (tempF > 50 || speedMph < 3) return null;
    const wcF = 35.74 + 0.6215 * tempF - 35.75 * Math.pow(speedMph, 0.16) + 0.4275 * tempF * Math.pow(speedMph, 0.16);
    return unit === 'C' ? (wcF - 32) * 5/9 : wcF;
};

export const calculateHeatIndex = (tempC: number, humidity: number): number | null => {
    if (tempC === undefined || tempC === null || humidity === undefined || humidity === null) return null;
    const T = (tempC * 9/5) + 32;
    const R = humidity;
    if (T < 70) return tempC; 
    let HI = 0.5 * (T + 61.0 + ((T-68.0)*1.2) + (R*0.094));
    if (HI > 80) {
        HI = -42.379 + 2.04901523*T + 10.14333127*R - 0.22475541*T*R - 0.00683783*T*T - 0.05481717*R*R + 0.00122874*T*T*R + 0.00085282*T*R*R - 0.00000199*T*T*R*R;
        if (R < 13 && T > 80 && T < 112) {
            HI -= ((13-R)/4)*Math.sqrt((17-Math.abs(T-95.))/17);
        } else if (R > 85 && T > 80 && T < 87) {
            HI += ((R-85)/10) * ((87-T)/5);
        }
    }
    return (HI - 32) * 5/9;
};

export const calculateApparentTemp = (tempC: number, humidity: number, windKnots: number): number | null => {
    if (tempC === undefined || tempC === null || humidity === undefined || humidity === null || windKnots === undefined) return null;
    const ws_ms = windKnots * 0.514444;
    const e = (humidity / 100) * 6.105 * Math.exp((17.27 * tempC) / (237.7 + tempC));
    const at = tempC + (0.33 * e) - (0.70 * ws_ms) - 4.00;
    return at;
}

export const getBeaufort = (knots: number | null | undefined) => {
    if (knots === null || knots === undefined) return { force: 0, desc: "Unknown", sea: "Calm" };
    if(knots < 1) return { force: 0, desc: "Calm", sea: "Sea like a mirror" };
    if(knots < 4) return { force: 1, desc: "Light Air", sea: "Ripples but no foam crests" };
    if(knots < 7) return { force: 2, desc: "Light Breeze", sea: "Small wavelets, glassy crests" };
    if(knots < 11) return { force: 3, desc: "Gentle Breeze", sea: "Large wavelets, crests break" };
    if(knots < 17) return { force: 4, desc: "Moderate Breeze", sea: "Small waves, becoming longer" };
    if(knots < 22) return { force: 5, desc: "Fresh Breeze", sea: "Moderate waves, many whitecaps" };
    if(knots < 28) return { force: 6, desc: "Strong Breeze", sea: "Large waves, foam crests everywhere" };
    if(knots < 34) return { force: 7, desc: "Near Gale", sea: "Sea heaps up, white foam streaks" };
    if(knots < 41) return { force: 8, desc: "Gale", sea: "Moderately high waves, spindrift" };
    if(knots < 48) return { force: 9, desc: "Strong Gale", sea: "High waves, dense foam streaks" };
    if(knots < 56) return { force: 10, desc: "Storm", sea: "Very high waves, visibility reduced" };
    if(knots < 64) return { force: 11, desc: "Violent Storm", sea: "Exceptionally high waves" };
    return { force: 12, desc: "Hurricane", sea: "Air filled with foam and spray" };
};

// Generates robust, non-AI advice when services are offline or keys are missing
export const generateTacticalAdvice = (metrics: WeatherMetrics, isLandlocked: boolean = false): string => {
    const wind = metrics.windSpeed || 0;
    const wave = metrics.waveHeight || 0;
    const vis = metrics.visibility;
    const gust = metrics.windGust || (wind * 1.3);
    const cond = (metrics.condition || "").toLowerCase();
    
    let summary = "";
    
    // 1. Wind Analysis
    if (wind < 5) summary += "Conditions are calm. ";
    else if (wind < 15) summary += `Moderate breeze (${wind.toFixed(0)} kts) from the ${expandCompassDirection(metrics.windDirection)}. `;
    else if (wind < 25) summary += `Fresh breeze building to ${gust.toFixed(0)} kts. `;
    else if (wind < 35) summary += "GALE WARNING: High winds and steep seas. ";
    else summary += "STORM CONDITIONS: Seek shelter immediately. ";
    
    // 2. Sea State (if marine)
    if (!isLandlocked) {
        if (wave < 1) summary += "Seas are flat. ";
        else if (wave < 4) summary += `Slight chop (${wave.toFixed(1)} ft). `;
        else if (wave < 8) summary += `Moderate seas (${wave.toFixed(1)} ft). `;
        else summary += `DANGEROUS SEAS (${wave.toFixed(1)} ft). `;
    }
    
    // 3. Visibility & Weather
    if (cond.includes('rain') || cond.includes('showers')) summary += "Visibility reduced in precipitation. ";
    if (vis !== null && vis < 2) summary += "Fog detected - proceed with caution. ";
    if (cond.includes('thunder') || cond.includes('storm')) summary += "Lightning risk present. ";
    
    // 4. Tactical Recommendation
    if (wind > 30 || wave > 10) {
        summary += "Vessel operations unsafe. Remain in port.";
    } else if (wind > 20 || wave > 6) {
        summary += "Small craft advisory. Experienced skippers only.";
    } else if (wind > 10) {
        summary += "Good sailing conditions. Monitor gusts.";
    } else {
        summary += "Excellent conditions for all craft.";
    }
    
    return summary;
};

export const checkForecastThresholds = (
    hourly: HourlyForecast[],
    daily: ForecastDay[],
    prefs: NotificationPreferences
): string[] => {
    const alerts: string[] = [];
    if (!hourly || hourly.length === 0) return alerts;
    const next24 = hourly.slice(0, 24);

    if (prefs.wind && prefs.wind.enabled) {
        const maxWind = Math.max(...next24.map(h => h.windSpeed));
        if (maxWind >= prefs.wind.threshold) alerts.push(`THRESHOLD ALERT: Sustained wind reaching ${maxWind.toFixed(1)}kts in next 24h`);
    }
    if (prefs.gusts && prefs.gusts.enabled) {
        const maxGust = Math.max(...next24.map(h => h.windGust || (h.windSpeed * 1.2)));
        if (maxGust >= prefs.gusts.threshold) alerts.push(`THRESHOLD ALERT: Gusts reaching ${maxGust.toFixed(1)}kts in next 24h`);
    }
    if (prefs.waves && prefs.waves.enabled) {
        const maxWave = Math.max(...next24.map(h => h.waveHeight));
        if (maxWave >= prefs.waves.threshold) alerts.push(`THRESHOLD ALERT: Seas building to ${maxWave.toFixed(1)}ft in next 24h`);
    }
    if (prefs.swellPeriod && prefs.swellPeriod.enabled) {
        const maxPeriod = Math.max(...next24.map(h => h.swellPeriod || 0));
        if (maxPeriod >= prefs.swellPeriod.threshold) alerts.push(`THRESHOLD ALERT: Long period swell (${maxPeriod}s) expected in next 24h`);
    }
    if (prefs.visibility && prefs.visibility.enabled) {
        const poorVis = next24.find(h => h.condition.toLowerCase().includes('fog') || (h.precipitation && h.precipitation > 5));
        if (poorVis) alerts.push(`THRESHOLD ALERT: Poor visibility forecast (Fog/Heavy Rain)`);
    }
    if (prefs.uv && prefs.uv.enabled) {
        const todayUV = daily.length > 0 ? daily[0].uvIndex : 0;
        if (todayUV && todayUV >= prefs.uv.threshold) alerts.push(`THRESHOLD ALERT: High UV Index (${todayUV.toFixed(0)}) expected today`);
    }
    if (prefs.tempHigh && prefs.tempHigh.enabled) {
        const maxTemp = Math.max(...next24.map(h => h.temperature));
        if (maxTemp >= prefs.tempHigh.threshold) alerts.push(`THRESHOLD ALERT: High Temp reaching ${maxTemp.toFixed(0)}° in next 24h`);
    }
    if (prefs.tempLow && prefs.tempLow.enabled) {
        const minTemp = Math.min(...next24.map(h => h.temperature));
        if (minTemp <= prefs.tempLow.threshold) alerts.push(`THRESHOLD ALERT: Low Temp dropping to ${minTemp.toFixed(0)}° in next 24h`);
    }
    return alerts;
};

export const generateSafetyAlerts = (current: WeatherMetrics, todayHigh?: number, dailyForecast?: ForecastDay[]): string[] => {
    const alerts: string[] = [];
    const wind = current.windSpeed || 0;
    const gust = current.windGust || wind * 1.2;
    const wave = current.waveHeight || 0;
    const vis = current.visibility;
    const temp = current.airTemperature;
    const precip = current.precipitation || 0;
    
    if (wind > 48 || gust > 60) alerts.push("STORM WARNING: Winds exceeding 48kts");
    else if (wind > 34 || gust > 45) alerts.push("GALE WARNING: Winds exceeding 34kts");
    else if (wind > 22 || gust > 30) alerts.push("Small Craft Advisory: Winds > 22kts");

    if (wave > 15) alerts.push("DANGEROUS SEAS: Waves exceeding 15ft");
    else if (wave > 8) alerts.push("Hazardous Seas Advisory: Waves > 8ft");

    if (vis !== null && vis !== undefined) {
        if (vis < 1) alerts.push("DENSE FOG ADVISORY: Visibility < 1nm");
        else if (vis < 3) alerts.push("Low Visibility: < 3nm");
    }

    if (current.condition && (current.condition.toLowerCase().includes('storm') || current.condition.toLowerCase().includes('thunder'))) {
        alerts.push("Severe Thunderstorm Potential");
    }

    if (precip > 8) alerts.push("Heavy Rainfall: Visibility Reduced");

    if (dailyForecast && dailyForecast.length > 0) {
        const upcoming = dailyForecast.slice(0, 3);
        const stormKeywords = ['storm', 'thunder', 'hurricane', 'tornado', 'cyclone', 'gale', 'violent'];
        upcoming.forEach(day => {
            const condLower = day.condition.toLowerCase();
            const isStormy = stormKeywords.some(k => condLower.includes(k));
            const isHighWind = day.windSpeed >= 34;
            const isExtremeGust = (day.windGust || 0) > 45;
            const isToday = day.day === 'Today' || day.date === new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
            if (!isToday || (isToday && !current.condition.toLowerCase().includes('storm'))) {
                 if (isStormy) alerts.push(`STORM WATCH: ${day.condition} forecast for ${day.day}`);
                 else if (isHighWind || isExtremeGust) alerts.push(`GALE WATCH: High winds (${day.windSpeed}kts) forecast for ${day.day}`);
            }
        });
    }

    if (temp !== undefined && temp !== null) {
        const apparent = calculateApparentTemp(temp, current.humidity || 0, current.windSpeed || 0);
        const feelC = apparent || temp;
        const maxThreatTemp = Math.max(feelC, todayHigh || -99);

        if (maxThreatTemp >= 38) alerts.push("EXCESSIVE HEAT WARNING: Extreme Danger");
        else if (maxThreatTemp >= 33) alerts.push("HEAT ADVISORY: Dangerous temperatures expected");
        else if (maxThreatTemp >= 29) alerts.push("Heat Caution: Prolonged sun exposure risky");
        
        if (temp < 0) alerts.push("FREEZING SPRAY WARNING: Icing risk");
        else if (temp < 4) alerts.push("FREEZE WARNING: Hypothermia risk");
    }

    if (current.uvIndex !== undefined && current.uvIndex >= 8) alerts.push(`HIGH UV ALERT: Protection Required`);

    return [...new Set(alerts)];
};

export const expandCompassDirection = (dir: string): string => {
    if (!dir) return "Unknown";
    const map: Record<string, string> = {
        'N': 'North', 'NNE': 'North-Northeast', 'NE': 'Northeast', 'ENE': 'East-Northeast',
        'E': 'East', 'ESE': 'East-Southeast', 'SE': 'Southeast', 'SSE': 'South-Southeast',
        'S': 'South', 'SSW': 'South-Southwest', 'SW': 'Southwest', 'WSW': 'West-Southwest',
        'W': 'West', 'WNW': 'West-Northwest', 'NW': 'Northwest', 'NNW': 'North-Northwest'
    };
    return map[dir] || dir;
};

export const expandForSpeech = (text: string): string => {
    if (!text) return "";
    let processed = text;
    processed = processed
        .replace(/\bkts\b/gi, "knots")
        .replace(/\bnm\b/gi, "nautical miles")
        .replace(/\bft\b/gi, "feet")
        .replace(/\bmb\b/gi, "millibars")
        .replace(/\bhPa\b/gi, "hectopascals")
        .replace(/°C/g, "degrees Celsius")
        .replace(/°F/g, "degrees Fahrenheit")
        .replace(/°/g, "degrees");

    const compassMap: Record<string, string> = {
        'N': 'North', 'NNE': 'North Northeast', 'NE': 'Northeast', 'ENE': 'East Northeast',
        'E': 'East', 'ESE': 'East Southeast', 'SE': 'Southeast', 'SSE': 'South Southeast',
        'S': 'South', 'SSW': 'South Southwest', 'SW': 'Southwest', 'WSW': 'West Southwest',
        'W': 'West', 'WNW': 'West Northwest', 'NW': 'Northwest', 'NNW': 'North Northwest'
    };
    Object.keys(compassMap).forEach(key => {
        const regex = new RegExp(`\\b${key}\\b`, 'g');
        processed = processed.replace(regex, compassMap[key]);
    });

    const countryMap: Record<string, string> = {
        'IT': 'Italy', 'US': 'United States', 'USA': 'United States',
        'UK': 'United Kingdom', 'GB': 'Great Britain',
        'AU': 'Australia', 'NZ': 'New Zealand',
        'FR': 'France', 'ES': 'Spain', 'GR': 'Greece',
        'HR': 'Croatia', 'DE': 'Germany', 'CA': 'California',
        'JP': 'Japan', 'CN': 'China', 'HK': 'Hong Kong',
        'NSW': 'New South Wales', 'QLD': 'Queensland', 'VIC': 'Victoria',
        'TAS': 'Tasmania', 'WA': 'Western Australia', 'SA': 'South Australia',
        'NT': 'Northern Territory'
    };
    Object.keys(countryMap).forEach(key => {
        const regex = new RegExp(`\\b${key}\\b`, 'g');
        processed = processed.replace(regex, countryMap[key]);
    });
    return processed;
};

export const getSkipperLockerItems = (current: WeatherMetrics, unit: string, isLandlocked: boolean = false, locationName: string = ""): string[] => {
    const items: string[] = [];
    const temp = current.airTemperature || 20;
    const tempF = unit === 'F' ? temp : (temp * 9/5) + 32;
    
    const isCold = tempF < 60;
    const isHot = tempF > 85;
    const isRain = current.condition.toLowerCase().includes('rain') || current.condition.toLowerCase().includes('storm');
    const uv = current.uvIndex || 0;
    const isNight = current.condition.toLowerCase().includes('night') || current.condition.toLowerCase().includes('dark');

    if (isLandlocked) {
        if (isRain) { items.push("Umbrella", "Waterproof Jacket"); }
        if (isCold) { items.push("Fleece Layer", "Beanie/Gloves"); }
        if (isHot) { items.push("Wide Brim Hat", "Hydration Pack"); }
        if (isNight) { items.push("Headlamp", "Reflective Gear"); }
        items.push("Hiking Boots", "Multi-tool");
        if (uv > 5) items.push("Sunscreen", "Polarized Shades");
        else if (!isNight) items.push("Sunglasses");
        if (!isRain && !isCold && !isHot) items.push("Light Windbreaker");
        items.push("First Aid Kit", "Power Bank", "Map/Compass");
    } else {
        const isCoordinates = /^-?\d+(\.\d+)?,\s*-?\d+(\.\d+)?$/.test(locationName || "");
        const isStation = (locationName || "").toLowerCase().includes('station') || (locationName || "").toLowerCase().includes('buoy');
        const isOffshore = isCoordinates || isStation || !(locationName || "").includes(',');

        if (isOffshore) {
            items.push("Tether/Harness", "EPIRB / PLB");
            if (isRain || current.waveHeight > 6 || current.windSpeed > 20) items.push("Full Foulies", "Sea Boots");
            else items.push("Windbreaker", "Deck Shoes");
            if (isCold) items.push("Thermals", "Watch Cap");
            if (isNight) items.push("Red Headlamp", "Flashlight");
            items.push("Grab Bag", "Handheld VHF", "Logbook");
            if (uv > 6) items.push("Zinc/Sunscreen");
        } else {
            items.push("PFD / Life Jacket", "VHF Handheld");
            if (uv > 5) items.push("Sunscreen", "Polarized Shades", "Cap");
            else if (!isNight) items.push("Sunglasses");
            if (isRain) items.push("Rain Shell");
            if (isCold) items.push("Windproof Fleece");
            if (!isCold && !isRain) items.push("Boat Shoes", "Light Jacket");
            items.push("Water Bottle", "Multi-tool", "Towel");
        }
    }
    
    const defaults = ["First Aid Kit", "Knife", "Snacks", "Water", "Phone Case"];
    for (const d of defaults) {
        if (!items.includes(d)) items.push(d);
    }
    return items.slice(0, 12);
};

export const calculateHullSpeed = (lwl: number): number => {
    return 1.34 * Math.sqrt(lwl);
};

export const calculateMCR = (disp: number, loa: number, beam: number): number => {
    return disp / (0.65 * (0.7 * loa + 0.3 * loa) * Math.pow(beam, 1.33));
};

export const calculateCSF = (disp: number, beam: number): number => {
    return beam / Math.pow(disp / 64, 0.333);
};

export const calculateDLR = (disp: number, lwl: number): number => {
    const longTons = disp / 2240;
    return longTons / Math.pow(0.01 * lwl, 3);
};

export const getTideStatus = (idx: number, hourly: HourlyForecast[]): 'rising' | 'falling' | 'high' | 'low' | 'steady' => {
    if (!hourly || idx === 0 || idx >= hourly.length - 1) return 'steady';
    const prev = hourly[idx - 1].tideHeight || 0;
    const curr = hourly[idx].tideHeight || 0;
    const next = hourly[idx + 1].tideHeight || 0;
    if (curr > prev && curr > next) return 'high';
    if (curr < prev && curr < next) return 'low';
    if (curr > prev) return 'rising';
    if (curr < prev) return 'falling';
    return 'steady';
};

export const calculateDailyScore = (wind: number, wave: number, vessel?: VesselProfile): number => {
    let score = 100;
    const maxWind = vessel?.maxWindSpeed || 25;
    const maxWave = vessel?.maxWaveHeight || 8;
    if (wind > maxWind) score -= 80;
    else if (wind > maxWind * 0.8) score -= 40;
    else if (wind > maxWind * 0.6) score -= 20;
    else if (wind < 5 && vessel?.type === 'sail') score -= 30; 
    if (wave > maxWave) score -= 90;
    else if (wave > maxWave * 0.7) score -= 50;
    else if (wave > maxWave * 0.5) score -= 20;
    return Math.max(0, Math.min(100, score));
};

export const getSailingScoreColor = (score: number): string => {
    if (score >= 80) return 'bg-emerald-500/20 text-emerald-400 border-emerald-500/50';
    if (score >= 60) return 'bg-blue-500/20 text-blue-400 border-blue-500/50';
    if (score >= 40) return 'bg-yellow-500/20 text-yellow-400 border-yellow-500/50';
    return 'bg-red-500/20 text-red-400 border-red-500/50';
};

export const getSailingConditionText = (score: number): string => {
    if (score >= 80) return 'Excellent';
    if (score >= 60) return 'Good';
    if (score >= 40) return 'Fair';
    return 'Poor';
};
