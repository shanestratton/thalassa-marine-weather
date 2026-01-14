
/**
 * CALCULATE AUSTRALIAN APPARENT TEMPERATURE (BOM Standard)
 * @param tempC - Air Temperature (Celsius)
 * @param humidity - Relative Humidity (0-100)
 * @param windKts - Wind Speed in Knots
 */
export const calculateFeelsLike = (tempC: number, humidity: number, windKts: number): number => {
    // If missing data, return the raw temp (better than - -)
    if (tempC === undefined || humidity === undefined) return tempC || 0;

    // 1. Convert Wind to m/s (BOM formula requires m/s)
    const windMs = (windKts || 0) * 0.514444;

    // 2. Calculate Water Vapour Pressure (e) [hPa]
    // This measures the "muggy" factor. High humidity pushes this number up.
    // Formula: e = (rh/100) * 6.105 * exp(17.27 * T / (237.7 + T))
    const e = (humidity / 100) * 6.105 * Math.exp((17.27 * tempC) / (237.7 + tempC));

    // 3. The Australian Formula
    // AT = Ta + 0.33×e − 0.70×ws − 4.00
    let apparentTemp = tempC + (0.33 * e) - (0.70 * windMs) - 4.00;

    // 4. SANITY CHECK (The "Mad Woman" Clamp)
    // Prevents the number from crashing if a gust hits 35kts.
    // We don't let it drop more than 5 degrees below actual unless it's freezing.
    if (apparentTemp < tempC - 5) apparentTemp = tempC - 5;

    return Math.round(apparentTemp);
};
