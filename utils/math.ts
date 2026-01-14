export const calculateWindChill = (temp: number, speedKnots: number, unit: string): number | null => {
    if (temp === undefined || temp === null || speedKnots === undefined || speedKnots === null) return null;
    const tempF = unit === 'C' ? (temp * 9 / 5) + 32 : temp;
    const speedMph = speedKnots * 1.15078;
    if (tempF > 50 || speedMph < 3) return null;
    const wcF = 35.74 + 0.6215 * tempF - 35.75 * Math.pow(speedMph, 0.16) + 0.4275 * tempF * Math.pow(speedMph, 0.16);
    return unit === 'C' ? (wcF - 32) * 5 / 9 : wcF;
};

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

export const calculateApparentTemp = (tempC: number, humidity: number, windKnots: number): number | null => {
    if (tempC === undefined || tempC === null || humidity === undefined || humidity === null || windKnots === undefined) return null;
    const ws_ms = windKnots * 0.514444;
    const e = (humidity / 100) * 6.105 * Math.exp((17.27 * tempC) / (237.7 + tempC));
    const at = tempC + (0.33 * e) - (0.70 * ws_ms) - 4.00;
    return at;
}

export const calculateFeelsLike = (tempC: number, humidity: number, windSpeedKts: number): number => {
    // AUSTRALIAN APPARENT TEMPERATURE (BOM Formula)
    const e = (humidity / 100) * 6.105 * Math.exp((17.27 * tempC) / (237.7 + tempC));
    const ws = windSpeedKts * 0.514444;
    // Adjusted: Removed -4.00 radiation baseline to better match user perception of "Heat"
    // (BOM standard assumes shade/shelter cooling, but users expect Humidity to strictly ADD heat)
    let AT = tempC + (0.33 * e) - (0.70 * ws);
    return parseFloat(AT.toFixed(1));
};

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
