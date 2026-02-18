/**
 * Water Detection Utility
 * Uses the free is-on-water.balbona.me API to determine
 * if GPS coordinates are on water (ocean, river, lake) or on land.
 *
 * Called once per voyage start — negligible API load.
 * Fail-open design: returns true on error (never penalise sailors).
 */

import { createLogger } from '../../utils/logger';

const log = createLogger('WaterDetect');

const API_BASE = 'https://is-on-water.balbona.me/api/v1/get';
const TIMEOUT_MS = 3000;

export interface WaterCheckResult {
    isWater: boolean;
    feature: 'LAND' | 'RIVER' | 'OCEAN' | 'LAKE' | 'UNKNOWN';
    lat: number;
    lon: number;
    failedOpen?: boolean;   // True if we defaulted to true on error
    error?: string;         // Error message if the API failed
}

/**
 * Last water check result — available for debug UI display.
 * Updated every time checkIsOnWater() is called.
 */
let _lastWaterCheck: WaterCheckResult | null = null;

/** Get the most recent water check result for debug display */
export function getLastWaterCheck(): WaterCheckResult | null {
    return _lastWaterCheck;
}

/**
 * Check if the given coordinates are on water.
 * Returns true if on water (ocean, river, lake), false if on land.
 * Fails open (returns true) if the API is unreachable — never penalise sailors.
 */
export async function checkIsOnWater(lat: number, lng: number): Promise<boolean> {
    // Skip invalid coordinates
    if (lat === 0 && lng === 0) {
        log.warn('checkIsOnWater: skipping (0,0) placeholder coordinates');
        _lastWaterCheck = {
            isWater: true, feature: 'UNKNOWN', lat, lon: lng,
            failedOpen: true, error: 'Placeholder (0,0) coordinates'
        };
        return true; // Fail open
    }

    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

        const response = await fetch(
            `${API_BASE}/${lat.toFixed(4)}/${lng.toFixed(4)}`,
            { signal: controller.signal }
        );
        clearTimeout(timeout);

        if (!response.ok) {
            log.warn(`checkIsOnWater: API returned ${response.status}`);
            _lastWaterCheck = {
                isWater: true, feature: 'UNKNOWN', lat, lon: lng,
                failedOpen: true, error: `HTTP ${response.status}`
            };
            return true; // Fail open
        }

        const data: WaterCheckResult = await response.json();
        log.info(`checkIsOnWater: (${lat.toFixed(4)}, ${lng.toFixed(4)}) → isWater=${data.isWater}, feature=${data.feature}`);
        _lastWaterCheck = { ...data, lat, lon: lng, failedOpen: false };
        return data.isWater;
    } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        log.warn('checkIsOnWater: API call failed, defaulting to true (fail-open)', error);
        _lastWaterCheck = {
            isWater: true, feature: 'UNKNOWN', lat, lon: lng,
            failedOpen: true, error: errMsg
        };
        return true; // Fail open — never block logging for sailors
    }
}
