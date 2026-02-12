/**
 * Voyage Data Utilities
 * Helper functions for processing and analyzing ship log data
 */

import { ShipLogEntry } from '../types';

export interface GroupedEntries {
    date: string; // YYYY-MM-DD (local)
    displayDate: string; // e.g., "February 1, 2026"
    entries: ShipLogEntry[];
    stats: {
        totalDistance: number;
        avgSpeed: number;
        maxSpeed: number;
        entryCount: number;
    };
}

/**
 * Get local date string (YYYY-MM-DD) from timestamp
 * Uses local timezone, not UTC
 */
function getLocalDateString(timestamp: string): string {
    const d = new Date(timestamp);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

/**
 * Group log entries by date for timeline display
 * Uses LOCAL timezone for grouping (not UTC)
 */
export function groupEntriesByDate(entries: ShipLogEntry[]): GroupedEntries[] {
    const grouped = new Map<string, ShipLogEntry[]>();

    // Group by LOCAL date (not UTC)
    entries.forEach(entry => {
        const date = getLocalDateString(entry.timestamp);
        if (!grouped.has(date)) {
            grouped.set(date, []);
        }
        grouped.get(date)!.push(entry);
    });

    // Convert to sorted array with stats
    return Array.from(grouped.entries())
        .map(([date, dateEntries]) => {
            const speeds = dateEntries
                .filter(e => e.speedKts && e.speedKts > 0 && e.speedKts <= 80)
                .map(e => e.speedKts!);

            // Parse date parts for display (local)
            const [year, month, day] = date.split('-').map(Number);
            const displayDate = new Date(year, month - 1, day).toLocaleDateString('en-US', {
                year: 'numeric',
                month: 'long',
                day: 'numeric'
            });

            return {
                date,
                displayDate,
                // Sort entries within date newest first
                entries: dateEntries.sort((a, b) =>
                    new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
                ),
                stats: {
                    totalDistance: dateEntries.reduce((sum, e) => sum + (e.distanceNM || 0), 0),
                    avgSpeed: speeds.length > 0 ? speeds.reduce((a, b) => a + b, 0) / speeds.length : 0,
                    maxSpeed: speeds.length > 0 ? Math.max(...speeds) : 0,
                    entryCount: dateEntries.length
                }
            };
        })
        .sort((a, b) => b.date.localeCompare(a.date)); // Newest date first
}

/**
 * Calculate voyage statistics
 */
export interface VoyageStats {
    totalDistance: number;
    totalTime: string; // formatted duration
    durationMinutes: number; // raw duration in minutes for sub-6-min check
    avgSpeed: number;
    maxSpeed: number;
    minSpeed: number;
    totalEntries: number;
    waypointCount: number;
    manualEntryCount: number;
    weather: {
        avgWindSpeed: number;
        avgWaveHeight: number;
        avgAirTemp: number;
    };
}

export function calculateVoyageStats(entries: ShipLogEntry[]): VoyageStats | null {
    if (entries.length === 0) return null;

    const speeds = entries.filter(e => e.speedKts && e.speedKts > 0 && e.speedKts <= 80).map(e => e.speedKts!);
    const windSpeeds = entries.filter(e => e.windSpeed).map(e => e.windSpeed!);
    const waveHeights = entries.filter(e => e.waveHeight).map(e => e.waveHeight!);
    const airTemps = entries.filter(e => e.airTemp).map(e => e.airTemp!);

    // Calculate total time
    const startTime = new Date(entries[entries.length - 1].timestamp);
    const endTime = new Date(entries[0].timestamp);
    const durationMs = endTime.getTime() - startTime.getTime();
    const durationMinutes = durationMs / (1000 * 60);
    const days = Math.floor(durationMs / (1000 * 60 * 60 * 24));
    const hours = Math.floor((durationMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));

    // Format: "2d 5h" for multi-day, "3h" for >1h, "0.3h" for sub-hour (6-min increments)
    let totalTime: string;
    if (days > 0) {
        totalTime = `${days}d ${hours}h`;
    } else if (hours >= 1) {
        totalTime = `${hours}h`;
    } else {
        // Sub-hour: show as decimal hours in 0.1 increments (6-min blocks)
        const decimalHours = Math.round(durationMinutes / 6) / 10;
        totalTime = `${decimalHours.toFixed(1)}h`;
    }

    return {
        totalDistance: Math.max(...entries.map(e => e.cumulativeDistanceNM || 0), 0),
        totalTime,
        durationMinutes,
        avgSpeed: speeds.length > 0 ? speeds.reduce((a, b) => a + b, 0) / speeds.length : 0,
        maxSpeed: speeds.length > 0 ? Math.max(...speeds) : 0,
        minSpeed: speeds.length > 0 ? Math.min(...speeds) : 0,
        totalEntries: entries.length,
        waypointCount: entries.filter(e => e.entryType === 'waypoint').length,
        manualEntryCount: entries.filter(e => e.entryType === 'manual').length,
        weather: {
            avgWindSpeed: windSpeeds.length > 0 ? windSpeeds.reduce((a, b) => a + b, 0) / windSpeeds.length : 0,
            avgWaveHeight: waveHeights.length > 0 ? waveHeights.reduce((a, b) => a + b, 0) / waveHeights.length : 0,
            avgAirTemp: airTemps.length > 0 ? airTemps.reduce((a, b) => a + b, 0) / airTemps.length : 0
        }
    };
}

/**
 * Filter entries by type
 */
export function filterEntriesByType(
    entries: ShipLogEntry[],
    types: ('auto' | 'manual' | 'waypoint')[]
): ShipLogEntry[] {
    if (types.length === 0) return entries;
    return entries.filter(e => types.includes(e.entryType));
}

/**
 * Search entries by notes or waypoint name
 */
export function searchEntries(entries: ShipLogEntry[], query: string): ShipLogEntry[] {
    if (!query.trim()) return entries;

    const lowerQuery = query.toLowerCase();
    return entries.filter(e =>
        (e.notes?.toLowerCase().includes(lowerQuery)) ||
        (e.waypointName?.toLowerCase().includes(lowerQuery))
    );
}

/**
 * Filter entries by date range
 */
export function filterEntriesByDateRange(
    entries: ShipLogEntry[],
    startDate?: Date,
    endDate?: Date
): ShipLogEntry[] {
    return entries.filter(e => {
        const entryDate = new Date(e.timestamp);
        if (startDate && entryDate < startDate) return false;
        if (endDate && entryDate > endDate) return false;
        return true;
    });
}
