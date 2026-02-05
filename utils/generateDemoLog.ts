/**
 * Generate Demo Ship's Log
 * Creates an EPIC Brisbane → Nouméa voyage for demonstration
 * Complete with whales, dolphins, pirates, storms, and chaos!
 */

import { ShipLogEntry } from '../types';
import { calculateDistance, calculateBearing, formatDMS } from './navigationCalculations';

// Dramatic manual entries for an unforgettable voyage
const VOYAGE_EVENTS = [
    // Day 1 - Departure
    { progress: 0.00, note: '⚓ Slipped mooring at Rivergate Marina. Crew excited, weather perfect. Brisbane skyline fading astern.' },
    { progress: 0.02, note: '🐬 Pod of 20+ dolphins escort us through Moreton Bay! Incredible send-off.' },
    { progress: 0.05, note: '🌊 Cleared North Stradbroke. Set course 065°. Full main + genoa, making 7.2 kts.' },

    // Day 2 - Good sailing
    { progress: 0.12, note: '🐟 Flying fish everywhere! One landed in the cockpit - instant sashimi.' },
    { progress: 0.18, note: '🎣 Hooked a big mahi-mahi. Fresh dinner tonight!' },
    { progress: 0.22, note: '🌅 Spectacular sunset. No ships in sight. True bluewater sailing.' },

    // Day 3 - The storm
    { progress: 0.28, note: '⚠️ Barometer dropping fast. 1018 → 1006 in 3 hours. Preparing for weather.' },
    { progress: 0.32, note: '🌧️ SQUALL LINE approaching from WSW. Reefing main, furling genoa.' },
    { progress: 0.35, note: '⛈️ STORM! 40kt gusts, 4m seas. All crew clipped on. Scary but handling well.' },
    { progress: 0.38, note: '🤢 First mate down with seasickness. Captain not feeling great either.' },
    { progress: 0.40, note: '💔 Lost the dinner plate set overboard in a big roll. RIP Corelle.' },
    { progress: 0.42, note: '😱 RIPPED SAIL! Main has a 2-foot tear near the second reef. Dropped main, sailing under jib only.' },
    { progress: 0.45, note: '🚽 HEAD IS BROKEN. Pump failed. All hands now using the cedar bucket. Morale low.' },
    { progress: 0.48, note: '☀️ Storm passed. Seas settling. Crew exhausted but relieved. Makeshift sail repair holding.' },

    // Day 4 - Recovery and wildlife
    { progress: 0.52, note: '🔧 Proper sail repair completed. Stitching held through the night.' },
    { progress: 0.55, note: '🐋 WHALE! Humpback breached 100m off port beam. Absolutely massive!' },
    { progress: 0.58, note: '🐋🐋 Mother and calf now swimming alongside. Magical. Crew spirits lifted.' },
    { progress: 0.62, note: '🦈 Large shark circling the hull. Possibly a tiger. Stayed for 20 mins then left.' },

    // Day 5 - The "pirates"
    { progress: 0.68, note: '👀 Unknown vessel approaching fast from stern. No AIS signal. All hands on deck.' },
    { progress: 0.70, note: '🏴‍☠️ FALSE ALARM! "Pirates" turned out to be French fishermen offering us fresh lobster. Very friendly!' },
    { progress: 0.72, note: '🦞 Lobster dinner! Best meal of the trip. Traded them some Brisbane beer.' },

    // Day 6 - Approach
    { progress: 0.78, note: '📻 Radio contact with Nouméa VTS. Advised of entry procedures.' },
    { progress: 0.82, note: '🏝️ New Caledonia visible on horizon! Grande Terre emerging from morning haze.' },
    { progress: 0.88, note: '⛵ Reef passage negotiated. Stunning turquoise lagoon. Feels like a different planet.' },
    { progress: 0.92, note: '🐢 Sea turtle surfaced next to the hull. Welcome committee!' },
    { progress: 0.95, note: '🏙️ Nouméa harbor in sight! Preparing dock lines and fenders.' },
    { progress: 0.98, note: '🎉 ARRIVED! 770nm, 5 days, 1 storm, 1 ripped sail, 1 broken toilet, countless memories.' },
    { progress: 1.00, note: '🍾 Tied up at Port Moselle. Cold Kronenbourg in hand. Crew survived. Boat mostly intact. Victory!' }
];

// Waypoints with colorful names
const WAYPOINTS = [
    { lat: -26.85, lon: 154.20, name: 'Cape Moreton Clear', progress: 0.08 },
    { lat: -25.50, lon: 157.00, name: 'Offshore - Byron Abeam', progress: 0.20 },
    { lat: -24.20, lon: 160.50, name: 'Mid-Coral Sea', progress: 0.45 },
    { lat: -23.00, lon: 163.80, name: 'NC EEZ Entry', progress: 0.70 },
    { lat: -22.40, lon: 165.50, name: 'Havannah Pass Approach', progress: 0.88 }
];

/**
 * Generate an epic Brisbane → Nouméa demo voyage
 * Arriving: Feb 4, 2026 (yesterday)
 * Duration: ~5 days
 * Distance: ~770nm
 */
export function generateDemoVoyage(): ShipLogEntry[] {
    const entries: ShipLogEntry[] = [];

    // Start position: Rivergate Marina, Brisbane
    const startLat = -27.4378;
    const startLon = 153.1089;

    // End position: Port Moselle, Nouméa
    const endLat = -22.2758;
    const endLon = 166.4380;

    // Voyage timing - arrive Feb 4, 2026 at 1600 local (0600 UTC)
    const arrivalTime = new Date('2026-02-04T06:00:00Z');
    const totalHours = 5 * 24 + 10; // 5 days 10 hours
    const startTime = new Date(arrivalTime.getTime() - (totalHours * 60 * 60 * 1000));

    const totalDistance = 770; // nautical miles
    const intervalMinutes = 15;
    const totalEntries = Math.floor((totalHours * 60) / intervalMinutes);

    let cumulativeDistance = 0;
    let waypointIndex = 0;
    let eventIndex = 0;

    for (let i = 0; i < totalEntries; i++) {
        const progress = i / totalEntries;
        const timestamp = new Date(startTime.getTime() + (i * intervalMinutes * 60 * 1000));

        // Interpolate position with some realistic variation
        const progressWithVariation = progress + Math.sin(progress * Math.PI * 8) * 0.01;
        const lat = startLat + (endLat - startLat) * progressWithVariation;
        const lon = startLon + (endLon - startLon) * progress;

        // Calculate distance from previous entry
        let distanceNM = 0;
        if (i > 0) {
            const prevEntry = entries[i - 1];
            distanceNM = calculateDistance(prevEntry.latitude, prevEntry.longitude, lat, lon);
            cumulativeDistance += distanceNM;
        }

        // Calculate speed and course
        const timeDiff = intervalMinutes / 60;
        const baseSpeed = 6.0 + Math.sin(progress * Math.PI * 4) * 1.5;

        // Storm period - slower speed
        const inStorm = progress >= 0.32 && progress <= 0.48;
        const speedKts = inStorm ? baseSpeed * 0.6 : baseSpeed;

        const courseDeg = calculateBearing(
            i === 0 ? lat : entries[i - 1].latitude,
            i === 0 ? lon : entries[i - 1].longitude,
            lat,
            lon
        );

        // Weather simulation
        const dayProgress = (timestamp.getTime() - startTime.getTime()) / (1000 * 60 * 60 * 24);

        // Storm conditions during the storm period
        let windSpeed: number;
        let windDir: string;
        let waveHeight: number;
        let pressure: number;

        if (inStorm) {
            windSpeed = 28 + Math.random() * 15;
            windDir = 'WSW';
            waveHeight = 3.0 + Math.random() * 1.5;
            pressure = 1002 + Math.random() * 4;
        } else {
            windSpeed = 12 + Math.sin(dayProgress * Math.PI) * 6 + Math.random() * 3;
            windDir = ['NE', 'ENE', 'E', 'ESE', 'SE'][Math.floor(dayProgress) % 5];
            waveHeight = 1.0 + Math.sin(dayProgress * Math.PI * 0.5) * 0.6;
            pressure = 1015 + Math.sin(dayProgress * Math.PI * 2) * 5;
        }

        const airTemp = 26 + Math.sin(dayProgress * Math.PI) * 3 + (inStorm ? -4 : 0);
        const waterTemp = 24.5 + progress * 1.5; // Warmer as we go north

        // Determine entry type and notes
        let entryType: 'auto' | 'manual' | 'waypoint' = 'auto';
        let waypointName: string | undefined;
        let notes: string | undefined;

        // Check for waypoints
        if (waypointIndex < WAYPOINTS.length && progress >= WAYPOINTS[waypointIndex].progress) {
            entryType = 'waypoint';
            waypointName = WAYPOINTS[waypointIndex].name;
            notes = `📍 Waypoint: ${waypointName}`;
            waypointIndex++;
        }

        // Check for dramatic events
        if (eventIndex < VOYAGE_EVENTS.length && progress >= VOYAGE_EVENTS[eventIndex].progress) {
            entryType = 'manual';
            notes = VOYAGE_EVENTS[eventIndex].note;
            eventIndex++;
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
