/**
 * Voyage Header Component
 * Displays voyage summary (Start → End) with swipe-to-delete functionality
 */

import React, { useState, useRef, useEffect, TouchEvent } from 'react';
import { t } from '../theme';
import { ShipLogEntry } from '../types';
import { reverseGeocode } from '../services/weatherService';

interface VoyageHeaderProps {
    voyageId: string;
    entries: ShipLogEntry[];
    isActive: boolean; // Is this the current tracking voyage?
    isSelected: boolean; // Is this the selected voyage for export?
    isExpanded: boolean;
    onToggle: () => void;
    onSelect: () => void;
    onDelete: () => void;
}

// Sentinel waypoint names that should NOT be displayed as locations
const SENTINEL_NAMES = new Set(['Voyage Start', 'Latest Position']);
const isSentinelName = (name: string | undefined): boolean => !name || SENTINEL_NAMES.has(name);

// Helper to format location as fallback (compact coords)
const formatLocationFallback = (entry: ShipLogEntry): string => {
    // Skip sentinel names — they're placeholders, not real waypoints
    if (entry.waypointName && !SENTINEL_NAMES.has(entry.waypointName)) return entry.waypointName;
    if (!entry.latitude && !entry.longitude) return 'Unknown';
    const lat = entry.latitude;
    const lon = entry.longitude;
    const latDir = lat >= 0 ? 'N' : 'S';
    const lonDir = lon >= 0 ? 'E' : 'W';
    return `${Math.abs(lat ?? 0).toFixed(2)}°${latDir}, ${Math.abs(lon ?? 0).toFixed(2)}°${lonDir}`;
};

export const VoyageHeader: React.FC<VoyageHeaderProps> = React.memo(({
    voyageId,
    entries,
    isActive,
    isSelected,
    isExpanded,
    onToggle,
    onSelect,
    onDelete
}) => {
    const [swipeOffset, setSwipeOffset] = useState(0);
    const [isSwiping, setIsSwiping] = useState(false);
    const [startLocationName, setStartLocationName] = useState<string | null>(null);
    const [endLocationName, setEndLocationName] = useState<string | null>(null);
    const startX = useRef(0);
    const deleteThreshold = 80; // Pixels to swipe to reveal delete

    // Sort entries chronologically
    const sortedEntries = [...entries].sort((a, b) =>
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );

    const firstEntry = sortedEntries[0];
    const lastEntry = sortedEntries[sortedEntries.length - 1];

    // Reverse geocode start and end locations
    // Trigger geocoding when waypointName is missing OR is a sentinel placeholder
    useEffect(() => {
        const fetchLocationNames = async () => {
            if (firstEntry && isSentinelName(firstEntry.waypointName) && (firstEntry.latitude || firstEntry.longitude)) {
                try {
                    const name = await reverseGeocode(firstEntry.latitude, firstEntry.longitude);
                    if (name) setStartLocationName(name);
                } catch (e) {
                    // Fallback to coords
                }
            }
            if (lastEntry && isSentinelName(lastEntry.waypointName) && lastEntry.id !== firstEntry?.id && (lastEntry.latitude || lastEntry.longitude)) {
                try {
                    const name = await reverseGeocode(lastEntry.latitude, lastEntry.longitude);
                    if (name) setEndLocationName(name);
                } catch (e) {
                    // Fallback to coords
                }
            }
        };
        fetchLocationNames();
    }, [firstEntry?.id, lastEntry?.id]);

    // Get display name for a location
    const getLocationDisplay = (entry: ShipLogEntry | undefined, resolvedName: string | null): string => {
        if (!entry) return 'Unknown';
        // Real waypoint names (not sentinels) take priority
        if (entry.waypointName && !SENTINEL_NAMES.has(entry.waypointName)) return entry.waypointName;
        // Reverse-geocoded name
        if (resolvedName) return resolvedName;
        // Fallback to compact coords
        return formatLocationFallback(entry);
    };

    // Calculate voyage stats
    const totalEntries = entries.length;
    const totalDistance = Math.max(...entries.map(e => e.cumulativeDistanceNM || 0), 0);
    const speeds = entries.filter(e => e.speedKts && e.speedKts > 0).map(e => e.speedKts!);
    const avgSpeed = speeds.length > 0 ? speeds.reduce((a, b) => a + b, 0) / speeds.length : 0;

    // Calculate duration — show hours for short voyages, days for multi-day
    const startDate = firstEntry ? new Date(firstEntry.timestamp) : new Date();
    const endDate = lastEntry ? new Date(lastEntry.timestamp) : new Date();
    const durationMs = endDate.getTime() - startDate.getTime();
    const durationHours = Math.max(1, Math.round(durationMs / (1000 * 60 * 60)));
    const durationDays = Math.ceil(durationMs / (1000 * 60 * 60 * 24));
    const durationLabel = durationHours < 24 ? `${durationHours}h` : `${Math.max(1, durationDays)}d`;

    // Swipe handlers
    const handleTouchStart = (e: TouchEvent) => {
        startX.current = e.touches[0].clientX;
        setIsSwiping(true);
    };

    const handleTouchMove = (e: TouchEvent) => {
        if (!isSwiping) return;
        const diff = startX.current - e.touches[0].clientX;
        // Only allow left swipe (positive diff)
        setSwipeOffset(Math.max(0, Math.min(diff, deleteThreshold + 20)));
    };

    const handleTouchEnd = () => {
        setIsSwiping(false);
        if (swipeOffset >= deleteThreshold) {
            // Keep at threshold to show delete button
            setSwipeOffset(deleteThreshold);
        } else {
            // Snap back
            setSwipeOffset(0);
        }
    };

    const handleDeleteClick = () => {
        setSwipeOffset(0);
        onDelete();
    };

    return (
        <div className="relative overflow-hidden rounded-xl mb-1.5">
            {/* Delete button (revealed on swipe) - only visible when swiping and NOT active */}
            {!isActive && (
                <div
                    className={`absolute right-0 top-0 bottom-0 w-20 bg-red-600 flex items-center justify-center transition-opacity ${swipeOffset > 0 ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
                    onClick={handleDeleteClick}
                >
                    <div className="text-center text-white">
                        <svg className="w-6 h-6 mx-auto mb-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                        <span className="text-sm font-bold">Delete</span>
                    </div>
                </div>
            )}

            {/* Main content (slides on swipe) */}
            <div
                className={`relative transition-transform ${isSwiping ? '' : 'duration-200'}`}
                style={{ transform: `translateX(-${swipeOffset}px)` }}
                onTouchStart={handleTouchStart}
                onTouchMove={handleTouchMove}
                onTouchEnd={handleTouchEnd}
            >
                <div
                    onClick={(e) => {
                        if (swipeOffset !== 0) return;
                        // Left third of the row → expand/collapse + select
                        // Middle/right → select only (for export targets)
                        const rect = e.currentTarget.getBoundingClientRect();
                        const clickX = e.clientX - rect.left;
                        const isLeftThird = clickX < rect.width / 3;
                        onSelect();
                        if (isLeftThird) {
                            onToggle();
                        }
                    }}
                    className={`w-full text-left rounded-xl border transition-colors cursor-pointer ${isActive
                        ? 'bg-gradient-to-r from-emerald-900/40 to-sky-900/40 border-emerald-500/30'
                        : isSelected
                            ? 'bg-gradient-to-r from-amber-900/40 to-orange-900/40 border-amber-500/50 ring-1 ring-amber-500/30'
                            : 'bg-slate-800/60 border-white/10 hover:bg-slate-800/80'
                        }`}
                >
                    <div className="px-2.5 py-2">
                        {/* Top row: Route and status */}
                        <div className="flex items-center justify-between mb-1">
                            {/* Route display + chevron toggle */}
                            <div
                                className="flex items-center gap-2 flex-1 min-w-0"
                            >
                                {/* Chevron — only this triggers expand/collapse */}
                                <div
                                    className="p-2 -m-2 cursor-pointer hover:opacity-80 transition-opacity flex-shrink-0"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        if (swipeOffset === 0) {
                                            onSelect();
                                            onToggle();
                                        }
                                    }}
                                >
                                    <svg
                                        className={`w-4 h-4 text-slate-400 transition-transform duration-150 ${isExpanded ? 'rotate-90' : ''}`}
                                        fill="none"
                                        viewBox="0 0 24 24"
                                        stroke="currentColor"
                                    >
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                                    </svg>
                                </div>
                                <div className="text-sm font-bold text-white truncate">
                                    {firstEntry ? (
                                        <>
                                            {getLocationDisplay(firstEntry, startLocationName)}
                                            {/* Only show end location for completed voyages */}
                                            {!isActive && lastEntry && (
                                                <>
                                                    <span className="text-slate-400 mx-2">→</span>
                                                    {getLocationDisplay(lastEntry, endLocationName)}
                                                </>
                                            )}
                                        </>
                                    ) : (
                                        <span className="text-slate-400">No entries</span>
                                    )}
                                </div>
                            </div>
                            {isActive && (
                                <span className="px-2 py-0.5 bg-emerald-500/20 text-emerald-400 text-sm font-bold rounded-full flex items-center gap-1 flex-shrink-0 ml-2">
                                    <span className="w-1.5 h-1.5 bg-emerald-400 rounded-full animate-pulse" />
                                    ACTIVE
                                </span>
                            )}
                            {entries.some(e => e.source === 'community_download') && (
                                <span className="px-2 py-0.5 bg-amber-500/20 text-amber-400 text-sm font-bold rounded-full flex items-center gap-1 flex-shrink-0 ml-2">
                                    🌐 COMMUNITY
                                </span>
                            )}
                            {entries.some(e => e.source === 'gpx_import') && !entries.some(e => e.source === 'community_download') && (
                                <span className="px-2 py-0.5 bg-amber-500/20 text-amber-400 text-sm font-bold rounded-full flex items-center gap-1 flex-shrink-0 ml-2">
                                    📥 IMPORTED
                                </span>
                            )}
                        </div>

                        {/* Disclaimer for imported tracks */}
                        {entries.some(e => e.source && e.source !== 'device') && (
                            <div className="flex items-center gap-1 mt-0.5">
                                <span className="w-4 text-center text-sm shrink-0">⚠️</span>
                                <p className="text-sm text-amber-500/70 whitespace-nowrap">Not for navigation — unverified data. Verify independently.</p>
                            </div>
                        )}

                        {/* Stats bar */}
                        <div className="flex items-center gap-2.5 text-sm">
                            <span className="text-slate-400">
                                <span className="text-white font-bold">{(totalDistance ?? 0).toFixed(1)}</span> NM
                            </span>
                            <span className="text-slate-400">
                                <span className="text-white font-bold">{(avgSpeed ?? 0).toFixed(1)}</span> kts avg
                            </span>
                            <span className="text-slate-400">
                                <span className="text-white font-bold">{totalEntries}</span> entries
                            </span>
                            <span className="text-slate-400">
                                <span className="text-white font-bold">{durationLabel}</span>
                            </span>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
});
