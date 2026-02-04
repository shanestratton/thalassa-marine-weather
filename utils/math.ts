/**
 * @fileoverview Mathematical utilities for weather calculations including
 * wind chill, heat index, apparent temperature, distance, and sun times.
 * @module utils/math
 */

/**
 * Calculates wind chill temperature using the NWS Wind Chill Formula.
 * Wind chill is only valid when temperature <= 50°F and wind speed >= 3 mph.
 * 
 * @param {number} temp - Temperature value
 * @param {number} speedKnots - Wind speed in knots
 * @param {string} unit - Temperature unit ('C' or 'F')
 * @returns {number | null} Wind chill temperature in the same unit, or null if not applicable
 * @see https://www.weather.gov/media/epz/wxcalc/windChill.pdf
 * @example
 * calculateWindChill(5, 20, 'C')  // returns approx -2.5°C
 * calculateWindChill(60, 10, 'F') // returns null (temp too high)
 */
export const calculateWindChill = (temp: number, speedKnots: number, unit: string): number | null => {
    if (temp === undefined || temp === null || speedKnots === undefined || speedKnots === null) return null;
    const tempF = unit === 'C' ? (temp * 9 / 5) + 32 : temp;
    const speedMph = speedKnots * 1.15078;
    if (tempF > 50 || speedMph < 3) return null;
    const wcF = 35.74 + 0.6215 * tempF - 35.75 * Math.pow(speedMph, 0.16) + 0.4275 * tempF * Math.pow(speedMph, 0.16);
    return unit === 'C' ? (wcF - 32) * 5 / 9 : wcF;
};

/**
 * Calculates heat index using the NWS Heat Index Formula.
 * Heat index is only valid when temperature >= 80°F (26.7°C).
 * 
 * @param {number} tempC - Temperature in Celsius
 * @param {number} humidity - Relative humidity (0-100)
 * @returns {number | null} Heat index in Celsius, or null if not applicable
 * @see https://www.wpc.ncep.noaa.gov/html/heatindex_equation.shtml
 * @example
 * calculateHeatIndex(35, 80) // returns approx 48°C (dangerous heat)
 * calculateHeatIndex(20, 50) // returns null (temp too low)
 */
export const calculateHeatIndex = (tempC: number, humidity: number): number | null => {
    if (tempC === undefined || tempC === null || humidity === undefined || humidity === null) return null;
    const T = (tempC * 9 / 5) + 32;
    const R = humidity;
    if (T < 80) return null;
    let HI = 0.5 * (T + 61.0 + ((T - 68.0) * 1.2) + (R * 0.094));
    if (HI > 80) {
        HI = -42.379 + 2.04901523 * T + 10.14333127 * R - 0.22475541 * T * R - 0.00683783 * T * T - 0.05481717 * R * R + 0.00122874 * T * T * R + 0.00085282 * T * R * R - 0.00000199 * T * T * R * R;
        if (R < 13 && T > 80 && T < 112) {
            HI -= ((13 - R) / 4) * Math.sqrt((17 - Math.abs(T - 95.)) / 17);
        } else if (R > 85 && T > 80 && T < 87) {
            HI += ((R - 85) / 10) * ((87 - T) / 5);
        }
    }
    return (HI - 32) * 5 / 9;
};

/**
 * Calculates apparent temperature using the Australian BOM formula.
 * Accounts for humidity and wind cooling effect.
 * 
 * @param {number} tempC - Temperature in Celsius
 * @param {number} humidity - Relative humidity (0-100)
 * @param {number} windKnots - Wind speed in knots
 * @returns {number | null} Apparent temperature in Celsius
 * @example
 * calculateApparentTemp(30, 80, 5) // returns higher than 30 due to humidity
 */
export const calculateApparentTemp = (tempC: number, humidity: number, windKnots: number): number | null => {
    if (tempC === undefined || tempC === null || humidity === undefined || humidity === null || windKnots === undefined) return null;
    const ws_ms = windKnots * 0.514444;
    const e = (humidity / 100) * 6.105 * Math.exp((17.27 * tempC) / (237.7 + tempC));
    const at = tempC + (0.33 * e) - (0.70 * ws_ms) - 4.00;
    return at;
}

/**
 * Calculates "feels like" temperature using a simplified BOM apparent temperature.
 * Adjusted for marine conditions where radiation baseline is less relevant.
 * 
 * @param {number} tempC - Temperature in Celsius
 * @param {number} humidity - Relative humidity (0-100)
 * @param {number} windSpeedKts - Wind speed in knots
 * @returns {number} Feels like temperature in Celsius (rounded to 1 decimal)
 * @example
 * calculateFeelsLike(25, 70, 10) // returns approx 26.5 (humidity adds heat, wind cools)
 */
export const calculateFeelsLike = (tempC: number, humidity: number, windSpeedKts: number): number => {
    // AUSTRALIAN APPARENT TEMPERATURE (BOM Formula)
    const e = (humidity / 100) * 6.105 * Math.exp((17.27 * tempC) / (237.7 + tempC));
    const ws = windSpeedKts * 0.514444;
    // Adjusted: Removed -4.00 radiation baseline to better match user perception of "Heat"
    // (BOM standard assumes shade/shelter cooling, but users expect Humidity to strictly ADD heat)
    let AT = tempC + (0.33 * e) - (0.70 * ws);
    return parseFloat(AT.toFixed(1));
};

/**
 * Calculates distance between two coordinates using the Haversine formula.
 * 
 * @param {number} lat1 - Latitude of first point
 * @param {number} lon1 - Longitude of first point
 * @param {number} lat2 - Latitude of second point
 * @param {number} lon2 - Longitude of second point
 * @returns {number} Distance in kilometers
 * @example
 * calculateDistance(-27.47, 153.02, -33.87, 151.21) // Sydney to Brisbane ≈ 730km
 */
export const calculateDistance = (lat1: number, lon1: number, lat2: number, lon2: number): number => {
    const R = 6371; // Radius of the earth in km
    const dLat = (lat2 - lat1) * (Math.PI / 180);
    const dLon = (lon2 - lon1) * (Math.PI / 180);
    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c; // Distance in km
};

/**
 * Calculates sunrise and sunset times for a given date and location.
 * Uses the NOAA solar position algorithm.
 * Returns null for polar regions where the sun doesn't rise or set.
 * 
 * @param {Date} date - The date to calculate for
 * @param {number} lat - Latitude in decimal degrees
 * @param {number} lon - Longitude in decimal degrees
 * @returns {{ sunrise: Date, sunset: Date } | null} Sunrise and sunset times, or null for polar regions
 * @example
 * getSunTimes(new Date('2024-06-21'), -27.47, 153.02) // Brisbane summer solstice
 */
export const getSunTimes = (date: Date, lat: number, lon: number): { sunrise: Date, sunset: Date } | null => {
    const times = {
        sunrise: new Date(date),
        sunset: new Date(date)
    };

    const radians = Math.PI / 180.0;
    const degrees = 180.0 / Math.PI;

    // Day of year
    const start = new Date(date.getFullYear(), 0, 0);
    const diff = date.getTime() - start.getTime();
    const oneDay = 1000 * 60 * 60 * 24;
    const dayOfYear = Math.floor(diff / oneDay);

    // Convert longitude to hour value and calculate an approximate time
    const lngHour = lon / 15.0;

    const calculateTime = (isSunrise: boolean) => {
        const t = dayOfYear + ((isSunrise ? 6.0 : 18.0) - lngHour) / 24.0;

        // Sun's mean anomaly
        const M = (0.9856 * t) - 3.289;

        // Sun's true longitude
        let L = M + (1.916 * Math.sin(M * radians)) + (0.020 * Math.sin(2 * M * radians)) + 282.634;
        L = ((L % 360) + 360) % 360; // Normalize to 0-360

        // Right ascension
        let RA = degrees * Math.atan(0.91764 * Math.tan(L * radians));
        RA = ((RA % 360) + 360) % 360;

        // Adjust RA to be in the same quadrant as L
        const Lquadrant = (Math.floor(L / 90)) * 90;
        const RAquadrant = (Math.floor(RA / 90)) * 90;
        RA = RA + (Lquadrant - RAquadrant);
        RA = RA / 15.0;

        // Sun's declination
        const sinDec = 0.39782 * Math.sin(L * radians);
        const cosDec = Math.cos(Math.asin(sinDec));

        // Sun's local hour angle
        const zenith = 90.833;
        const cosH = (Math.cos(zenith * radians) - (sinDec * Math.sin(lat * radians))) / (cosDec * Math.cos(lat * radians));

        if (cosH > 1 || cosH < -1) return null; // The sun never rises or sets on this location (polar region)

        const H = isSunrise
            ? 360 - degrees * Math.acos(cosH)
            : degrees * Math.acos(cosH);

        const H_hours = H / 15.0;

        // Mean time of rising/setting
        const T = H_hours + RA - (0.06571 * t) - 6.622;

        // Adjust back to UTC
        let UT = T - lngHour;
        UT = ((UT % 24) + 24) % 24;

        // Set time on date object
        const result = new Date(date);
        result.setUTCHours(Math.floor(UT));
        result.setUTCMinutes(Math.floor((UT % 1) * 60));
        result.setUTCSeconds(0);

        return result;
    };

    const rise = calculateTime(true);
    const set = calculateTime(false);

    if (!rise || !set) return null;

    return { sunrise: rise, sunset: set };
};
