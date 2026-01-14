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

export const degreesToCardinal = (degrees: number | null | undefined): string => {
    if (degrees === null || degrees === undefined) return '--';
    const cardinals = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
    const val = Math.floor((degrees / 22.5) + 0.5);
    return cardinals[val % 16];
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

export const formatCoordinate = (value: number, type: 'lat' | 'lon'): string => {
    const absolute = Math.abs(value);
    const direction = type === 'lat'
        ? (value >= 0 ? 'N' : 'S')
        : (value >= 0 ? 'E' : 'W');
    return `${absolute.toFixed(4)}°${direction}`;
};
