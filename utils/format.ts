/**
 * @fileoverview String formatting utilities for location names, compass directions,
 * and text-to-speech processing.
 * @module utils/format
 */

/**
 * Formats a location input string with proper capitalization.
 * Keeps known abbreviations (US states, Australian states, countries) uppercase.
 * 
 * @param {string} input - Raw location input string
 * @returns {string} Properly formatted location string
 * @example
 * formatLocationInput("new york, ny") // returns "New York, NY"
 * formatLocationInput("sydney, nsw") // returns "Sydney, NSW"
 */
export const formatLocationInput = (input: string): string => {
    const ABBREVS = new Set([
        'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
        'NSW', 'QLD', 'VIC', 'TAS', 'WA', 'SA', 'NT', 'ACT',
        'UK', 'USA', 'UAE', 'NZ', 'AU', 'US', 'CA',
        'DC', 'PR', 'VI'
    ]);

    return input.split(/(\s+)/).map(part => {
        if (part.trim().length === 0) return part;
        const clean = part.replace(/[.,]/g, '').toUpperCase();
        if (ABBREVS.has(clean)) return part.toUpperCase();
        return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
    }).join('');
};

/**
 * Converts wind/wave direction in degrees to 16-point cardinal direction.
 * Uses standard meteorological convention (0° = North, 90° = East).
 * 
 * @param {number | null | undefined} degrees - Direction in degrees (0-360)
 * @returns {string} Cardinal direction abbreviation (N, NNE, NE, ENE, E, etc.) or "--" if invalid
 * @example
 * degreesToCardinal(0)   // returns "N"
 * degreesToCardinal(45)  // returns "NE"
 * degreesToCardinal(270) // returns "W"
 * degreesToCardinal(null) // returns "--"
 */
export const degreesToCardinal = (degrees: number | null | undefined): string => {
    if (degrees === null || degrees === undefined) return '--';
    const cardinals = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
    const val = Math.floor((degrees / 22.5) + 0.5);
    return cardinals[val % 16];
};

/**
 * Converts 16-point cardinal direction to degrees.
 * Inverse of degreesToCardinal - used when API provides cardinal instead of degrees.
 * 
 * @param {string | null | undefined} cardinal - Cardinal direction abbreviation (N, NNE, NE, etc.)
 * @returns {number | undefined} Direction in degrees (0-360) or undefined if invalid
 * @example
 * cardinalToDegrees("N")   // returns 0
 * cardinalToDegrees("SE")  // returns 135
 * cardinalToDegrees("W")   // returns 270
 * cardinalToDegrees(null)  // returns undefined
 */
export const cardinalToDegrees = (cardinal: string | null | undefined): number | undefined => {
    if (!cardinal) return undefined;
    const cardinalMap: Record<string, number> = {
        "N": 0, "NNE": 22.5, "NE": 45, "ENE": 67.5,
        "E": 90, "ESE": 112.5, "SE": 135, "SSE": 157.5,
        "S": 180, "SSW": 202.5, "SW": 225, "WSW": 247.5,
        "W": 270, "WNW": 292.5, "NW": 315, "NNW": 337.5
    };
    return cardinalMap[cardinal.toUpperCase()];
};

/**
 * Expands a compass direction abbreviation to its full name.
 * 
 * @param {string} dir - Cardinal direction abbreviation (e.g., "NNE")
 * @returns {string} Full direction name (e.g., "North-Northeast")
 * @example
 * expandCompassDirection("NNE") // returns "North-Northeast"
 * expandCompassDirection("SW")  // returns "Southwest"
 */
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

/**
 * Converts abbreviated maritime text to full speech-friendly format.
 * Expands units (kts → knots, nm → nautical miles, ft → feet),
 * temperature symbols (°C → degrees Celsius), compass directions (N → North),
 * and country/state abbreviations (NSW → New South Wales).
 * 
 * Used for audio broadcast feature.
 * 
 * @param {string} text - Text with abbreviations
 * @returns {string} Fully expanded text suitable for text-to-speech
 * @example
 * expandForSpeech("Wind 15kts from NNE") // returns "Wind 15 knots from North Northeast"
 * expandForSpeech("Waves 6ft, visibility 10nm") // returns "Waves 6 feet, visibility 10 nautical miles"
 */
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

/**
 * Formats a decimal coordinate to a human-readable string with direction.
 * 
 * @param {number} value - Decimal coordinate value
 * @param {'lat' | 'lon'} type - Coordinate type (latitude or longitude)
 * @returns {string} Formatted coordinate string (e.g., "27.4500°S")
 * @example
 * formatCoordinate(-27.45, 'lat') // returns "27.4500°S"
 * formatCoordinate(153.02, 'lon') // returns "153.0200°E"
 */
export const formatCoordinate = (value: number, type: 'lat' | 'lon'): string => {
    const absolute = Math.abs(value);
    const direction = type === 'lat'
        ? (value >= 0 ? 'N' : 'S')
        : (value >= 0 ? 'E' : 'W');
    return `${absolute.toFixed(4)}°${direction}`;
};
