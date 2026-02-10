
import { WeatherMetrics, VesselProfile, HourlyForecast, ForecastDay, NotificationPreferences, LockerItem, Tide } from '../types';
import { expandCompassDirection } from './format';
import { calculateApparentTemp } from './math';

// Generates robust, non-AI advice when services are offline or keys are missing
export const generateTacticalAdvice = (
    metrics: WeatherMetrics,
    isLandlocked: boolean = false,
    locationName: string = "Current Location",
    vessel?: VesselProfile,
    tides?: Tide[],
    sunsetTime?: string
): string => {
    const wind = metrics.windSpeed || 0;
    const wave = metrics.waveHeight || 0;
    const vis = metrics.visibility;
    const gust = metrics.windGust || (wind * 1.3);
    const cond = (metrics.condition || "").toLowerCase();
    const now = new Date();

    let summary = `Captain's Log: ${locationName}\n\n`;

    // --- 1. TIDE & BAR CROSSING ANALYSIS ---
    let tideMsg = "";
    if (tides && tides.length > 0) {
        const nextTide = tides.find(t => new Date(t.time) > now);
        if (nextTide) {
            const isHigh = nextTide.type === 'High';
            const timeDiff = (new Date(nextTide.time).getTime() - now.getTime()) / 3600000;
            const hours = Math.floor(timeDiff);
            const mins = Math.round((timeDiff - hours) * 60);

            tideMsg = `\n\n🌊 Tides: Currently ${isHigh ? 'incoming (Flood)' : 'outgoing (Ebb)'}. Expect ${isHigh ? 'High Water' : 'Low Water'} in ${hours}h ${mins}m. `;

            if (!isHigh && wind > 15) {
                tideMsg += "CAUTION: Wind against Tide. Bar crossings likely hazardous with steep standing waves. ";
            } else if (isHigh && wind < 10) {
                tideMsg += "Slack water approaching; ideal for bar crossing or docking. ";
            }
        } else {
            tideMsg = "\nTide: Data available but next tide not found. ";
        }
    }

    // --- 2. DAYLIGHT ANALYSIS ---
    let sunMsg = "";
    if (sunsetTime && sunsetTime !== '--:--') {
        const today = new Date().toISOString().split('T')[0];
        const sunsetDate = new Date(`${today}T${sunsetTime.length === 5 ? sunsetTime : '18:00'}:00`);
        const minsUntilDark = (sunsetDate.getTime() - now.getTime()) / 60000;

        if (minsUntilDark > 0) {
            sunMsg = `\n\n☀️ Daylight: Sunset at ${sunsetTime}. You have ${(minsUntilDark / 60).toFixed(1)}h of light remaining. `;
            if (minsUntilDark < 90) sunMsg += "Golden hour is here. Ensure you are close to home port. ";
        } else if (minsUntilDark > -60) {
            sunMsg = `\n\n🌙 Twilight: Sunset passed at ${sunsetTime}. Navigation lights required. Visibility dropping rapidly. `;
        }
    }

    // --- 3. VESSEL SPECIFIC CHECKS ---
    let vesselStatus = "";
    if (vessel) {
        const maxWind = vessel.maxWindSpeed || 30;
        const maxWave = vessel.maxWaveHeight || 10;

        vesselStatus += `\n\n⚓ Vessel Report (${vessel.name}): `;

        if (tides && vessel.draft) {
            const nextTide = tides.find(t => new Date(t.time) > now);
            if (nextTide && nextTide.type === 'Low' && vessel.draft > 2) {
                vesselStatus += `Depth Alert: Low tide approaching. Keep a sharp watch on sounder given your ${vessel.draft}ft draft. `;
            }
        }

        if (wind > maxWind) {
            vesselStatus += `CRITICAL: Winds > ${maxWind}kts exceed safety limits. Secure vessel and remain in port. `;
        } else if (wave > maxWave) {
            vesselStatus += `DANGER: Seas > ${maxWave}ft exceed handling limits. Do not proceed. `;
        } else if (wind > maxWind * 0.75 || wave > maxWave * 0.75) {
            vesselStatus += `Conditions are rough. Expect spray and uncomfortable motion. Experienced crew only recommended today. `;
        } else {
            if (wind < maxWind * 0.4 && wave < maxWave * 0.3) {
                vesselStatus += `Conditions are excellent. Smooth sailing expected. Perfect for guests or easy cruising. `;
            } else {
                vesselStatus += `Conditions are well within operational limits. Good day for a passage. `;
            }
        }
    }

    // --- COMPOSE SUMMARY ---

    // Wind Analysis
    if (wind < 5) summary += "The air is nearly still. Mirror-like conditions prevail with light airs only. ";
    else if (wind < 10) summary += `A light breeze (${wind.toFixed(0)} kts) ripples the water, coming from the ${expandCompassDirection(metrics.windDirection)}. Perfect for gentle drifting. `;
    else if (wind < 15) summary += `Moderate breeze (${wind.toFixed(0)} kts) building. Whitecaps may begin to form. Good sailing breeze. `;
    else if (wind < 20) summary += `Fresh breeze (${wind.toFixed(0)} kts) whistling in the rigging. Things are getting lively. Reefs may be needed soon. `;
    else if (wind < 25) summary += `Strong breeze (${wind.toFixed(0)} kts). Large wavelets and crests everywhere. Reduced sail area advised. `;
    else if (wind < 35) summary += "GALE WARNING in effect. High winds and spindrift. Difficult conditions for all craft. ";
    else summary += "STORM CONDITIONS. Survival weather. Seek urgent shelter. ";

    // Sea State
    if (!isLandlocked && wave > 0) {
        if (wave < 1) summary += "Seas are flat to calm. ";
        else if (wave < 3) summary += `Slight chop (${wave.toFixed(1)} ft) on the open water. `;
        else if (wave < 6) summary += `Moderate seas (${wave.toFixed(1)} ft) rolling through. `;
        else summary += `Heavy seas (${wave.toFixed(1)} ft) reported. Expect signficant motion. `;
    }

    // Add Contexts
    if (tideMsg) summary += tideMsg;
    if (sunMsg) summary += sunMsg;

    // Weather/Vis
    if (cond.includes('rain') || cond.includes('showers')) summary += "\n\n🌧️ Visibility reduced in passing rain squalls. Keep radar watch if equipped. ";
    if (vis !== null && vis !== undefined && vis < 2) summary += "\n\n🌫️ Fog banks reported. Visibility poor. Sound signals required. ";
    if (cond.includes('thunder') || cond.includes('storm')) summary += "\n\n⚡ ELECTRICAL STORM RISK. Avoid open water and stay off rigging. ";

    // Recommendation
    if (vesselStatus) {
        summary += vesselStatus;
    } else {
        summary += "\n\nSkippers Advice: ";
        if (wind > 30 || wave > 10) summary += "Vessel operations unsafe. Secure lines and fenders.";
        else if (wind > 20 || wave > 6) summary += "Small craft advisory conditions. Only suitable for capable vessels and experienced hands.";
        else if (wind > 10) summary += "Good conditions for sailing or planing. Enjoy the water.";
        else summary += "Tranquil conditions. Excellent for all activities.";
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
        if (todayUV && todayUV && todayUV >= prefs.uv.threshold) alerts.push(`THRESHOLD ALERT: High UV Index (${todayUV.toFixed(0)}) expected today`);
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

export const getSkipperLockerItems = (current: WeatherMetrics, unit: string, isLandlocked: boolean = false, locationName: string = ""): LockerItem[] => {
    const items: LockerItem[] = [];
    const temp = current.airTemperature || 20;
    const tempF = unit === 'F' ? temp : (temp * 9 / 5) + 32;

    const isCold = tempF < 60;
    const isHot = tempF > 85;
    const isRain = current.condition.toLowerCase().includes('rain') || current.condition.toLowerCase().includes('storm');
    const uv = current.uvIndex || 0;
    const isNight = current.condition.toLowerCase().includes('night') || current.condition.toLowerCase().includes('dark');

    const addItem = (name: string, icon: string, category: string) => {
        items.push({ name, icon, category });
    }

    if (isLandlocked) {
        if (isRain) { addItem("Umbrella", "☂️", "Rain Gear"); addItem("Waterproof Jacket", "🧥", "Clothing"); }
        if (isCold) { addItem("Fleece Layer", "🧥", "Clothing"); addItem("Beanie/Gloves", "🧤", "Clothing"); }
        if (isHot) { addItem("Wide Brim Hat", "👒", "Sun Protection"); addItem("Hydration Pack", "💧", "Safety"); }
        if (isNight) { addItem("Headlamp", "🔦", "Safety"); addItem("Reflective Gear", "🦺", "Safety"); }
        addItem("Hiking Boots", "🥾", "Footwear"); addItem("Multi-tool", "🛠", "Tools");
        if (uv > 5) addItem("Sunscreen", "🧴", "Sun Protection"); addItem("Polarized Shades", "🕶", "Eyewear");

        if (!isRain && !isCold && !isHot) addItem("Light Windbreaker", "🧥", "Clothing");
        addItem("First Aid Kit", "🩹", "Safety"); addItem("Power Bank", "🔋", "Electronics"); addItem("Map/Compass", "🧭", "Navigation");
    } else {
        const isCoordinates = /^-?\d+(\.\d+)?,\s*-?\d+(\.\d+)?$/.test(locationName || "");
        const isStation = (locationName || "").toLowerCase().includes('station') || (locationName || "").toLowerCase().includes('buoy');
        const isOffshore = isCoordinates || isStation || !(locationName || "").includes(',');

        if (isOffshore) {
            addItem("Tether/Harness", "🔗", "Safety"); addItem("EPIRB / PLB", "📡", "Safety");
            if (isRain || (current.waveHeight || 0) > 6 || (current.windSpeed || 0) > 20) { addItem("Full Foulies", "🧥", "Heavy Weather"); addItem("Sea Boots", "👢", "Footwear"); }
            else { addItem("Windbreaker", "🧥", "Clothing"); addItem("Deck Shoes", "👟", "Footwear"); }
            if (isCold) { addItem("Thermals", "🌡", "Clothing"); addItem("Watch Cap", "🧢", "Clothing"); }
            if (isNight) { addItem("Red Headlamp", "🔦", "Safety"); addItem("Flashlight", "🔦", "Safety"); }
            addItem("Grab Bag", "🎒", "Safety"); addItem("Handheld VHF", "📻", "Comms"); addItem("Logbook", "📓", "Admin");
            if (uv > 6) addItem("Zinc/Sunscreen", "🧴", "Sun Protection");
        } else {
            addItem("PFD / Life Jacket", "🦺", "Safety"); addItem("VHF Handheld", "📻", "Comms");
            if (uv > 5) { addItem("Sunscreen", "🧴", "Sun Protection"); addItem("Polarized Shades", "🕶", "Eyewear"); addItem("Cap", "🧢", "Clothing"); }
            else if (!isNight) addItem("Sunglasses", "🕶", "Eyewear");
            if (isRain) addItem("Rain Shell", "🧥", "Clothing");
            if (isCold) addItem("Windproof Fleece", "🧥", "Clothing");
            if (!isCold && !isRain) { addItem("Boat Shoes", "👟", "Footwear"); addItem("Light Jacket", "🧥", "Clothing"); }
            addItem("Water Bottle", "💧", "Provisions"); addItem("Multi-tool", "🛠", "Tools"); addItem("Towel", "🧖", "Comfort");
        }
    }

    const defaultItems = [
        { name: "First Aid Kit", icon: "🩹", category: "Safety" },
        { name: "Knife", icon: "🔪", category: "Tools" },
        { name: "Snacks", icon: "🍎", category: "Provisions" },
        { name: "Water", icon: "💧", category: "Provisions" },
        { name: "Phone Case", icon: "📱", category: "Electronics" }
    ];

    for (const d of defaultItems) {
        if (!items.some(i => i.name === d.name)) items.push(d);
    }
    return items.slice(0, 12);
};
