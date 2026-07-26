/**
 * Water Detection Utility
 * Uses the free is-on-water.balbona.me API to determine
 * if GPS coordinates are on water (ocean, river, lake) or on land.
 *
 * Called at a bounded cadence during a voyage — negligible API load.
 * Fail-open design: reports water on error so logging never stops, while
 * retaining that uncertainty for consumers that need a conservative decision.
 */

import { createLogger } from '../../utils/createLogger';

const log = createLogger('WaterDetect');

const API_BASE = 'https://is-on-water.balbona.me/api/v1/get';
const TIMEOUT_MS = 3000;

export interface WaterCheckResult {
    isWater: boolean;
    feature: 'LAND' | 'RIVER' | 'OCEAN' | 'LAKE' | 'UNKNOWN';
    lat: number;
    lon: number;
    failedOpen?: boolean; // True if we defaulted to true on error
    error?: string; // Error message if the API failed
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
 * Check the water/land status at a coordinate without throwing away the
 * confidence signal. `failedOpen` / `UNKNOWN` are deliberately distinct from
 * confirmed ocean water: the voyage plotting policy must stay dense whenever
 * shoreline classification is uncertain.
 */
export async function checkWaterStatus(lat: number, lng: number): Promise<WaterCheckResult> {
    // Skip invalid coordinates
    if (lat === 0 && lng === 0) {
        log.warn('checkIsOnWater: skipping (0,0) placeholder coordinates');
        _lastWaterCheck = {
            isWater: true,
            feature: 'UNKNOWN',
            lat,
            lon: lng,
            failedOpen: true,
            error: 'Placeholder (0,0) coordinates',
        };
        return _lastWaterCheck;
    }

    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

        const response = await fetch(`${API_BASE}/${lat.toFixed(4)}/${lng.toFixed(4)}`, { signal: controller.signal });
        clearTimeout(timeout);

        if (!response.ok) {
            log.warn(`checkIsOnWater: API returned ${response.status}`);
            _lastWaterCheck = {
                isWater: true,
                feature: 'UNKNOWN',
                lat,
                lon: lng,
                failedOpen: true,
                error: `HTTP ${response.status}`,
            };
            return _lastWaterCheck;
        }

        const data: WaterCheckResult = await response.json();
        log.info(
            `checkIsOnWater: (${lat.toFixed(4)}, ${lng.toFixed(4)}) → isWater=${data.isWater}, feature=${data.feature}`,
        );
        _lastWaterCheck = { ...data, lat, lon: lng, failedOpen: false };
        return _lastWaterCheck;
    } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        log.warn('checkIsOnWater: API call failed, defaulting to true (fail-open)', error);
        _lastWaterCheck = {
            isWater: true,
            feature: 'UNKNOWN',
            lat,
            lon: lng,
            failedOpen: true,
            error: errMsg,
        };
        return _lastWaterCheck;
    }
}

/**
 * Compatibility wrapper for callers that only need a boolean. It deliberately
 * preserves the long-standing fail-open behaviour so a water-service outage can
 * never stop a live log; zone selection should use `checkWaterStatus` instead.
 */
export async function checkIsOnWater(lat: number, lng: number): Promise<boolean> {
    return (await checkWaterStatus(lat, lng)).isWater;
}
