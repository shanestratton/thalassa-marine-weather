/**
 * SIMPLIFIED INTEGRATION APPROACH
 * 
 * Rather than refactoring the entire complex WeatherContext flow,
 * we'll create a lightweight wrapper that:
 * 1. Fetches beacon data when available
 * 2. Merges multi-source data with source tracking
 */

import { MarineWeatherReport } from '../types';
import { findAndFetchNearestBeacon } from './weather/api/beaconService';
import { mergeWeatherData, generateSourceReport } from './weather/api/dataSourceMerger';

// Global debug state for UI display
(window as any).THALASSA_DEBUG = {
    beacon: null,
    sources: null,
    lastUpdate: null
};

/**
 * Enhance a weather report with beacon data (if available)
 */
export async function enhanceWithBeaconData(
    report: MarineWeatherReport,
    coords: { lat: number, lon: number }
): Promise<MarineWeatherReport> {

    const debug = (window as any).THALASSA_DEBUG;

    try {
        // Fetch nearest beacon (BOM AWS or wave buoy) within 10nm
        const beacon = await findAndFetchNearestBeacon(coords.lat, coords.lon, 10);

        if (beacon) {
            debug.beacon = beacon;
        } else {
            debug.beacon = null;
        }

        // Merge beacon data with StormGlass report
        const mergedReport = mergeWeatherData(beacon, report, {
            lat: coords.lat,
            lon: coords.lon,
            name: (report as any).location?.name || 'Unknown'
        });

        // Update debug state
        if (mergedReport.current && (mergedReport.current as any).sources) {
            debug.sources = (mergedReport.current as any).sources;
            debug.lastUpdate = new Date().toLocaleTimeString();
        }

        return mergedReport;

    } catch (error) {
        console.error('[BeaconIntegration] Error:', error);
        debug.error = String(error);
        return report;
    }
}
