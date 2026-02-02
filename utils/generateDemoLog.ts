/**
 * Generate Demo Ship's Log
 * Creates a realistic Newport → Noumea voyage for demonstration
 */

import { ShipLogEntry } from '../types';
import { calculateDistance, calculateBearing, formatDMS } from './navigationCalculations';

/**
 * Generate a demo voyage from Newport, QLD to Noumea, New Caledonia
 * Distance: ~770nm
 * Duration: ~5.3 days at 6 knots average
 */
export function generateDemoVoyage(): ShipLogEntry[] {
    const entries: ShipLogEntry[] = [];

    // Start position: Newport, QLD
    const startLat = -27.2086;
    const startLon = 153.0874;

    // End position: Noumea, New Caledonia
    const endLat = -22.2758;
    const endLon = 166.4581;

    // Voyage parameters
    const startTime = new Date('2026-02-01T06:00:00Z');
    const totalDistance = 770; // nautical miles
    const avgSpeed = 6.2; // knots
    const totalHours = totalDistance / avgSpeed; // ~124 hours
    const intervalMinutes = 15; // Log every 15 minutes
    const totalEntries = Math.floor((totalHours * 60) / intervalMinutes);

    // Waypoints
    const waypoints = [
        { lat: -26.5, lon: 155.0, name: 'North Stradbroke Clear', time: 0.15 },
        { lat: -25.8, lon: 157.5, name: 'Offshore Transition', time: 0.35 },
        { lat: -24.5, lon: 161.0, name: 'Mid-Passage', time: 0.55 },
        { lat: -23.2, lon: 164.5, name: 'New Caledonia Approach', time: 0.75 }
    ];

    let cumulativeDistance = 0;
    let waypointIndex = 0;

    for (let i = 0; i < totalEntries; i++) {
        const progress = i / totalEntries;
        const timestamp = new Date(startTime.getTime() + (i * intervalMinutes * 60 * 1000));

        // Interpolate position
        const lat = startLat + (endLat - startLat) * progress;
        const lon = startLon + (endLon - startLon) * progress;

        // Calculate distance from previous entry
        let distanceNM = 0;
        if (i > 0) {
            const prevEntry = entries[i - 1];
            distanceNM = calculateDistance(prevEntry.latitude, prevEntry.longitude, lat, lon);
            cumulativeDistance += distanceNM;
        }

        // Calculate speed and course
        const timeDiff = intervalMinutes / 60; // hours
        const speedKts = distanceNM / timeDiff;
        const courseDeg = calculateBearing(
            i === 0 ? lat : entries[i - 1].latitude,
            i === 0 ? lon : entries[i - 1].longitude,
            lat,
            lon
        );

        // Simulate weather changes throughout voyage
        const dayProgress = (timestamp.getTime() - startTime.getTime()) / (1000 * 60 * 60 * 24);
        const windSpeed = 12 + Math.sin(dayProgress * Math.PI) * 8 + Math.random() * 3;
        const windDir = ['NE', 'E', 'SE', 'S', 'SW'][Math.floor(dayProgress) % 5];
        const waveHeight = 1.2 + Math.sin(dayProgress * Math.PI * 0.5) * 0.8;
        const pressure = 1013 + Math.sin(dayProgress * Math.PI * 2) * 8;
        const airTemp = 26 + Math.sin(dayProgress * Math.PI) * 4;
        const waterTemp = 24 + Math.sin(dayProgress * Math.PI * 0.3) * 2;

        // Check if we're at a waypoint
        let entryType: 'auto' | 'manual' | 'waypoint' = 'auto';
        let waypointName: string | undefined;
        let notes: string | undefined;

        if (waypointIndex < waypoints.length && progress >= waypoints[waypointIndex].time) {
            entryType = 'waypoint';
            waypointName = waypoints[waypointIndex].name;
            notes = `Waypoint: ${waypointName} - Course adjusted`;
            waypointIndex++;
        }

        // Add some manual entries
        if (i === 50) {
            entryType = 'manual';
            notes = 'Tacked to port - wind shift from NE';
        } else if (i === 150) {
            entryType = 'manual';
            notes = 'Pod of dolphins spotted off starboard bow';
        } else if (i === 300) {
            entryType = 'manual';
            notes = 'Reduced sail - squall approaching';
        } else if (i === totalEntries - 10) {
            entryType = 'manual';
            notes = 'Noumea harbor in sight - preparing for entry';
        }

        entries.push({
            id: `demo_${i}`,
            userId: 'demo_user',
            timestamp: timestamp.toISOString(),
            latitude: parseFloat(lat.toFixed(6)),
            longitude: parseFloat(lon.toFixed(6)),
            positionFormatted: formatDMS(lat, lon),
            distanceNM: parseFloat(distanceNM.toFixed(2)),
            cumulativeDistanceNM: parseFloat(cumulativeDistance.toFixed(2)),
            speedKts: parseFloat(speedKts.toFixed(1)),
            courseDeg: Math.round(courseDeg),
            windSpeed: parseFloat(windSpeed.toFixed(1)),
            windDirection: windDir,
            waveHeight: parseFloat(waveHeight.toFixed(1)),
            pressure: Math.round(pressure),
            airTemp: Math.round(airTemp),
            waterTemp: Math.round(waterTemp),
            entryType,
            notes,
            waypointName
        });
    }

    return entries;
}
