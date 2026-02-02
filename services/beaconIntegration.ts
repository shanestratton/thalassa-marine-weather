/**
 * SIMPLIFIED INTEGRATION APPROACH
 * 
 * Rather than refactoring the entire complex WeatherContext flow,
 * we'll create a lightweight wrapper that:
 * 1. Fetches beacon data when available
 * 2. Merges multi-source data with source tracking
 * 3. Logs the multi-source breakdown to console
 * 
 * This approach adds the beacon functionality and logging
 * without disrupting the battle-tested METAR + StormGlass logic.
 */

import { MarineWeatherReport } from '../types';
import { findAndFetchNearestBeacon } from './weather/api/beaconService';
import { mergeWeatherData, generateSourceReport } from './weather/api/dataSourceMerger';
import { fetchNearestMetar, LocalObservation } from './MetarService';

// Global debug state for UI display
(window as any).THALASSA_DEBUG = {
    beacon: null,
    airport: null,
    sources: null,
    lastUpdate: null
};

/**
 * Enhance a weather report with beacon data (if available)
 * and log the multi-source breakdown
 */
export async function enhanceWithBeaconData(
    report: MarineWeatherReport,
    coords: { lat: number, lon: number }
): Promise<MarineWeatherReport> {

    const debug = (window as any).THALASSA_DEBUG;

    try {
        // 1. Try to fetch beacon data
        const beacon = await findAndFetchNearestBeacon(coords.lat, coords.lon, 10);

        if (beacon) {
            report.beaconObservation = beacon;
            debug.beacon = `${beacon.name || 'Beacon'} (${beacon.distance?.toFixed(1) || '?'}nm)`;
        } else {
            debug.beacon = 'None within 10nm';
        }

        // 2. Get airport data - fetch fresh if not in report
        // Note: report.observations is ObservationStation[], but we need LocalObservation for merging
        let airport: LocalObservation | null = null;

        // Try to get from cache first (if it matches LocalObservation structure)
        if (report.observations && report.observations.length > 0) {
            const obs = report.observations[0] as any;
            // Check if it has LocalObservation properties
            if (obs.stationId) {
                airport = obs;
                debug.airport = `${obs.name || obs.stationId || 'Unknown'} (from cache)`;
            }
        }

        // If not in cache, fetch fresh
        if (!airport) {
            try {
                airport = await fetchNearestMetar(coords.lat, coords.lon);
                if (airport) {
                    debug.airport = `${airport.stationId} (fetched fresh)`;
                } else {
                    debug.airport = 'None found nearby';
                }
            } catch (e) {
                console.error('[BeaconIntegration] Failed to fetch airport:', e);
                debug.airport = 'Fetch failed';
            }
        }

        const location = {
            lat: coords.lat,
            lon: coords.lon,
            name: report.locationName
        };

        // DEBUG: Show what we're passing to mergeWeatherData
        debug.mergeInput = {
            hasBeacon: !!beacon,
            hasAirport: !!airport,
            hasStormGlass: !!report.current
        };

        // 3. Merge and replace the entire report with source-tracked data
        const mergedReport = mergeWeatherData(
            beacon || null,
            airport,
            report,
            location
        );

        // 4. Store sources for debug display
        if (mergedReport.current && (mergedReport.current as any).sources) {
            debug.sources = (mergedReport.current as any).sources;
            debug.lastUpdate = new Date().toLocaleTimeString();

            // Generate report for console
            const sourceReport = generateSourceReport(mergedReport.current as any);
            console.log(sourceReport);
        } else {
            debug.sources = null;
            debug.error = 'mergeWeatherData did not return sources property';
        }

        return mergedReport;

    } catch (error) {
        console.error('[BeaconIntegration] Error:', error);
        debug.error = String(error);
        return report;
    }
}
