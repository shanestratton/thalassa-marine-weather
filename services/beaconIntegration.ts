/**
 * SIMPLIFIED INTEGRATION APPROACH
 * 
 * Rather than refactoring the entire complex WeatherContext flow,
 * we'll create a lightweight wrapper that:
 * 1. Fetches beacon data when available
 * 2. Merges multi-source data with source tracking
 */

import { MarineWeatherReport, SourcedWeatherMetrics, MetricSource } from '../types';
import { findAndFetchNearestBeacon } from './weather/api/beaconService';
import { mergeWeatherData, generateSourceReport } from './weather/api/dataSourceMerger';

/** Debug state shape for the THALASSA_DEBUG global */
interface ThalassaDebug {
    beacon: unknown;
    sources: Record<string, MetricSource> | null;
    lastUpdate: string | null;
    error?: string;
}

declare global {
    interface Window {
        THALASSA_DEBUG: ThalassaDebug;
    }
}

// Global debug state for UI display
window.THALASSA_DEBUG = {
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

    const debug = window.THALASSA_DEBUG;

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
            name: report.locationName || 'Unknown'
        });

        // Update debug state
        const currentData = mergedReport.current as SourcedWeatherMetrics;
        if (currentData?.sources) {
            debug.sources = currentData.sources;
            debug.lastUpdate = new Date().toLocaleTimeString();
        }

        return mergedReport;

    } catch (error) {
        debug.error = String(error);
        return report;
    }
}
