/**
 * Voyage Data Utilities
 * Helper functions for processing and analyzing ship log data
 */

import { ShipLogEntry } from '../types';
import { estimatePropulsion } from '../services/shiplog/propulsion';

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
    entries.forEach((entry) => {
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
                .filter((e) => e.speedKts && e.speedKts > 0 && e.speedKts <= 80)
                .map((e) => e.speedKts!);

            // Parse date parts for display (local)
            const [year, month, day] = date.split('-').map(Number);
            const displayDate = new Date(year, month - 1, day).toLocaleDateString('en-US', {
                year: 'numeric',
                month: 'long',
                day: 'numeric',
            });

            return {
                date,
                displayDate,
                // Sort entries within date newest first
                entries: dateEntries.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()),
                stats: {
                    totalDistance: dateEntries.reduce((sum, e) => sum + (e.distanceNM || 0), 0),
                    avgSpeed: speeds.length > 0 ? speeds.reduce((a, b) => a + b, 0) / speeds.length : 0,
                    maxSpeed: speeds.length > 0 ? Math.max(...speeds) : 0,
                    entryCount: dateEntries.length,
                },
            };
        })
        .sort((a, b) => b.date.localeCompare(a.date)); // Newest date first
}

// ── Day's runs (noon-to-noon) ───────────────────────────────────────
// Classic passage logbook: a multi-day voyage is measured in daily
// runs, each from local noon to the next local noon.

export interface DayRun {
    /** Sequential run number, 1-indexed. */
    dayNumber: number;
    /** Epoch-ms of the window's local-noon start (for stable sort/keys). */
    windowStartMs: number;
    /** NM made good in the window. */
    distanceNM: number;
    /** Timestamps of the first/last entry actually in the window. */
    firstTs: string;
    lastTs: string;
    entryCount: number;
}

/** Local-noon start of the noon-to-noon window a timestamp falls in. */
function noonWindowStartMs(timestamp: string): number {
    const d = new Date(timestamp);
    const noon = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12, 0, 0, 0);
    if (d.getTime() < noon.getTime()) noon.setDate(noon.getDate() - 1); // before noon → previous window
    return noon.getTime();
}

/**
 * Break a voyage into noon-to-noon day's runs. Distance is the SUM of
 * per-leg distanceNM within each window (NOT a cumulativeDistanceNM diff
 * — turn pins copy cumulative and contribute 0 distance, so a naive diff
 * double-counts). Each leg is attributed to its end-entry's window; at
 * 5 s cadence the boundary leg is metres, negligible. Windows are
 * returned chronologically and numbered Day 1..N.
 */
export function groupEntriesByNoonWindow(entries: ShipLogEntry[]): DayRun[] {
    const byWindow = new Map<number, ShipLogEntry[]>();
    for (const e of entries) {
        const w = noonWindowStartMs(e.timestamp);
        const arr = byWindow.get(w);
        if (arr) arr.push(e);
        else byWindow.set(w, [e]);
    }

    const windows = [...byWindow.keys()].sort((a, b) => a - b);
    return windows.map((windowStartMs, i) => {
        const list = byWindow.get(windowStartMs)!;
        const sorted = [...list].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
        return {
            dayNumber: i + 1,
            windowStartMs,
            distanceNM: sorted.reduce((sum, e) => sum + (e.distanceNM || 0), 0),
            firstTs: sorted[0].timestamp,
            lastTs: sorted[sorted.length - 1].timestamp,
            entryCount: sorted.length,
        };
    });
}

// ── Sail vs motor split ─────────────────────────────────────────────
// Real data, not a guess: auto track points carry the user-declared
// engineStatus (sticky, stamped in CapturePipeline). Each interval
// between consecutive points is attributed to the engine state at its
// START. Spans before the user first declares the engine are 'unknown'.

export interface PropulsionSplit {
    motorMs: number;
    sailMs: number;
    unknownMs: number;
    /** Portion of motor+sail time that came from the heuristic estimate
     *  (the skipper didn't declare it with the engine toggle). */
    estimatedMs: number;
}

/**
 * Attribute each inter-point span to motor / sail / unknown. The DECLARED
 * engine state (from the on/off toggle) is authoritative; spans the
 * skipper never declared are filled with the heuristic estimate
 * (estimatePropulsion) and counted in estimatedMs so the UI can label
 * them honestly.
 */
export function computePropulsionSplit(entries: ShipLogEntry[]): PropulsionSplit {
    const sorted = [...entries].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    let motorMs = 0;
    let sailMs = 0;
    let unknownMs = 0;
    let estimatedMs = 0;
    for (let i = 0; i < sorted.length - 1; i++) {
        const dt = new Date(sorted[i + 1].timestamp).getTime() - new Date(sorted[i].timestamp).getTime();
        if (!(dt > 0)) continue;
        const s = sorted[i].engineStatus;
        if (s === 'running' || s === 'maneuvering') {
            motorMs += dt;
        } else if (s === 'stopped') {
            sailMs += dt;
        } else {
            // Undeclared — estimate from the span's START point.
            const est = estimatePropulsion(sorted[i]);
            if (est === 'motor') {
                motorMs += dt;
                estimatedMs += dt;
            } else if (est === 'sail') {
                sailMs += dt;
                estimatedMs += dt;
            } else {
                unknownMs += dt;
            }
        }
    }
    return { motorMs, sailMs, unknownMs, estimatedMs };
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

    const speeds = entries.filter((e) => e.speedKts && e.speedKts > 0 && e.speedKts <= 80).map((e) => e.speedKts!);
    const windSpeeds = entries.filter((e) => e.windSpeed).map((e) => e.windSpeed!);
    const waveHeights = entries.filter((e) => e.waveHeight).map((e) => e.waveHeight!);
    const airTemps = entries.filter((e) => e.airTemp).map((e) => e.airTemp!);

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
        totalDistance: Math.max(...entries.map((e) => e.cumulativeDistanceNM || 0), 0),
        totalTime,
        durationMinutes,
        avgSpeed: speeds.length > 0 ? speeds.reduce((a, b) => a + b, 0) / speeds.length : 0,
        maxSpeed: speeds.length > 0 ? Math.max(...speeds) : 0,
        minSpeed: speeds.length > 0 ? Math.min(...speeds) : 0,
        totalEntries: entries.length,
        waypointCount: entries.filter((e) => e.entryType === 'waypoint').length,
        manualEntryCount: entries.filter((e) => e.entryType === 'manual').length,
        weather: {
            avgWindSpeed: windSpeeds.length > 0 ? windSpeeds.reduce((a, b) => a + b, 0) / windSpeeds.length : 0,
            avgWaveHeight: waveHeights.length > 0 ? waveHeights.reduce((a, b) => a + b, 0) / waveHeights.length : 0,
            avgAirTemp: airTemps.length > 0 ? airTemps.reduce((a, b) => a + b, 0) / airTemps.length : 0,
        },
    };
}

/**
 * Filter entries by type
 */
export function filterEntriesByType(
    entries: ShipLogEntry[],
    types: ('auto' | 'manual' | 'waypoint')[],
): ShipLogEntry[] {
    if (types.length === 0) return entries;
    return entries.filter((e) => types.includes(e.entryType));
}

/**
 * Search entries by notes or waypoint name
 */
export function searchEntries(entries: ShipLogEntry[], query: string): ShipLogEntry[] {
    if (!query.trim()) return entries;

    const lowerQuery = query.toLowerCase();
    return entries.filter(
        (e) => e.notes?.toLowerCase().includes(lowerQuery) || e.waypointName?.toLowerCase().includes(lowerQuery),
    );
}

/**
 * Filter entries by date range
 */
export function filterEntriesByDateRange(entries: ShipLogEntry[], startDate?: Date, endDate?: Date): ShipLogEntry[] {
    return entries.filter((e) => {
        const entryDate = new Date(e.timestamp);
        if (startDate && entryDate < startDate) return false;
        if (endDate && entryDate > endDate) return false;
        return true;
    });
}

/**
 * Merge a small batch of freshly-fetched "recent" entries into the
 * existing in-memory entry list WITHOUT re-pulling the whole history.
 *
 * Used by the live-tracking poll: while a voyage is recording we only
 * need to surface the handful of new points captured since the last
 * tick, not re-download and re-group every entry the user has ever
 * logged (which, at 1–10 Hz precision capture, can be hundreds of
 * thousands of rows — the old full-reload-per-second behaviour pegged
 * the main thread and made the page unusable).
 *
 * Merge rules:
 *  - Offline-queue entries carry synthetic, POSITIONAL ids
 *    (`offline_0`, `offline_1`, …) that are regenerated on every read
 *    and shift as the queue drains. They can never be reconciled by
 *    id across reads, so we DROP all prior `offline_*` entries from
 *    the previous list and re-add whatever the fresh batch carries.
 *    (The caller passes the full current offline queue every tick, so
 *    nothing is lost — a point that has since synced to the cloud
 *    arrives in `recent` with a real id instead.)
 *  - Everything else is keyed by `id`; the fresh copy wins (it may
 *    carry a corrected position / backfilled distance).
 *  - Result is sorted newest-first to match the rest of the pipeline.
 *
 * Pure + side-effect free so it can be unit-tested in isolation.
 */
const OFFLINE_ID_PREFIX = 'offline_';

export function mergeRecentEntries(prev: ShipLogEntry[], recent: ShipLogEntry[]): ShipLogEntry[] {
    const byId = new Map<string, ShipLogEntry>();

    // Seed with prior entries, skipping the volatile offline_* set —
    // the fresh batch re-supplies the current queue contents.
    for (const e of prev) {
        if (!e.id || e.id.startsWith(OFFLINE_ID_PREFIX)) continue;
        byId.set(e.id, e);
    }

    // Overlay the fresh batch (cloud points with real ids + the
    // current offline queue). Fresh copy wins for any shared id.
    const offlineFresh: ShipLogEntry[] = [];
    for (const e of recent) {
        if (!e.id) continue;
        if (e.id.startsWith(OFFLINE_ID_PREFIX)) {
            offlineFresh.push(e);
        } else {
            byId.set(e.id, e);
        }
    }

    const merged = [...byId.values(), ...offlineFresh];
    merged.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    return merged;
}
