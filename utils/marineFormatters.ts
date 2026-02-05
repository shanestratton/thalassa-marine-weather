/**
 * Marine Formatters - IMO-compliant formatting utilities
 * 
 * Provides standard maritime formatting for:
 * - 24-hour time (0001-2400)
 * - Beaufort scale (wind)
 * - Douglas scale (sea state)
 * - Watch periods
 */

/**
 * Format time in 24-hour maritime format: "1435" or "0023"
 */
export const formatTime24 = (date: Date | string): string => {
    const d = typeof date === 'string' ? new Date(date) : date;
    const hours = d.getHours().toString().padStart(2, '0');
    const minutes = d.getMinutes().toString().padStart(2, '0');
    return `${hours}${minutes}`;
};

/**
 * Format time with colon: "14:35" or "00:23"
 */
export const formatTime24Colon = (date: Date | string): string => {
    const d = typeof date === 'string' ? new Date(date) : date;
    const hours = d.getHours().toString().padStart(2, '0');
    const minutes = d.getMinutes().toString().padStart(2, '0');
    return `${hours}:${minutes}`;
};

/**
 * Convert wind speed (knots) to Beaufort scale (0-12)
 * Based on standard Beaufort scale definitions
 */
export const windToBeaufort = (kts: number): number => {
    if (kts < 1) return 0;   // Calm
    if (kts < 4) return 1;   // Light air
    if (kts < 7) return 2;   // Light breeze
    if (kts < 11) return 3;  // Gentle breeze
    if (kts < 17) return 4;  // Moderate breeze
    if (kts < 22) return 5;  // Fresh breeze
    if (kts < 28) return 6;  // Strong breeze
    if (kts < 34) return 7;  // Near gale
    if (kts < 41) return 8;  // Gale
    if (kts < 48) return 9;  // Strong gale
    if (kts < 56) return 10; // Storm
    if (kts < 64) return 11; // Violent storm
    return 12;               // Hurricane
};

/**
 * Get Beaufort scale description
 */
export const getBeaufortDescription = (scale: number): string => {
    const descriptions = [
        'Calm',
        'Light air',
        'Light breeze',
        'Gentle breeze',
        'Moderate breeze',
        'Fresh breeze',
        'Strong breeze',
        'Near gale',
        'Gale',
        'Strong gale',
        'Storm',
        'Violent storm',
        'Hurricane'
    ];
    return descriptions[Math.min(scale, 12)] || 'Unknown';
};

/**
 * Convert wave height (meters) to Douglas sea state (0-9)
 * Based on WMO sea state code
 */
export const waveToSeaState = (meters: number): number => {
    if (meters < 0.1) return 0;  // Glassy
    if (meters < 0.5) return 1;  // Calm (rippled)
    if (meters < 1.25) return 2; // Smooth
    if (meters < 2.5) return 3;  // Slight
    if (meters < 4) return 4;    // Moderate
    if (meters < 6) return 5;    // Rough
    if (meters < 9) return 6;    // Very rough
    if (meters < 14) return 7;   // High
    if (meters < 20) return 8;   // Very high
    return 9;                    // Phenomenal
};

/**
 * Get sea state description
 */
export const getSeaStateDescription = (state: number): string => {
    const descriptions = [
        'Glassy',
        'Calm',
        'Smooth',
        'Slight',
        'Moderate',
        'Rough',
        'Very rough',
        'High',
        'Very high',
        'Phenomenal'
    ];
    return descriptions[Math.min(state, 9)] || 'Unknown';
};

/**
 * Watch period type
 */
export type WatchPeriod =
    | 'middle'      // 0000-0400
    | 'morning'     // 0400-0800
    | 'forenoon'    // 0800-1200
    | 'afternoon'   // 1200-1600
    | 'firstDog'    // 1600-1800
    | 'secondDog'   // 1800-2000
    | 'first';      // 2000-0000

/**
 * Determine watch period from hour (0-23)
 */
export const getWatchPeriod = (hour: number): WatchPeriod => {
    if (hour >= 0 && hour < 4) return 'middle';
    if (hour >= 4 && hour < 8) return 'morning';
    if (hour >= 8 && hour < 12) return 'forenoon';
    if (hour >= 12 && hour < 16) return 'afternoon';
    if (hour >= 16 && hour < 18) return 'firstDog';
    if (hour >= 18 && hour < 20) return 'secondDog';
    return 'first';
};

/**
 * Get watch period display name
 */
export const getWatchPeriodName = (period: WatchPeriod): string => {
    const names: Record<WatchPeriod, string> = {
        middle: 'Middle Watch',
        morning: 'Morning Watch',
        forenoon: 'Forenoon Watch',
        afternoon: 'Afternoon Watch',
        firstDog: 'First Dog Watch',
        secondDog: 'Second Dog Watch',
        first: 'First Watch'
    };
    return names[period];
};

/**
 * Get watch period time range
 */
export const getWatchPeriodRange = (period: WatchPeriod): string => {
    const ranges: Record<WatchPeriod, string> = {
        middle: '0000-0400',
        morning: '0400-0800',
        forenoon: '0800-1200',
        afternoon: '1200-1600',
        firstDog: '1600-1800',
        secondDog: '1800-2000',
        first: '2000-0000'
    };
    return ranges[period];
};

/**
 * Format course as degrees True: "045°T"
 */
export const formatCourseTrue = (deg: number): string => {
    return `${deg.toFixed(0).padStart(3, '0')}°T`;
};

/**
 * Visibility categories (nautical miles)
 */
export type VisibilityCategory = 'poor' | 'moderate' | 'good' | 'excellent';

export const getVisibilityCategory = (nm: number): VisibilityCategory => {
    if (nm < 2) return 'poor';
    if (nm < 5) return 'moderate';
    if (nm < 10) return 'good';
    return 'excellent';
};

export const getVisibilityDescription = (nm: number): string => {
    const cat = getVisibilityCategory(nm);
    const descriptions: Record<VisibilityCategory, string> = {
        poor: 'Poor (<2nm)',
        moderate: 'Moderate (2-5nm)',
        good: 'Good (5-10nm)',
        excellent: 'Excellent (>10nm)'
    };
    return descriptions[cat];
};
