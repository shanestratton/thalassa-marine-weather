/**
 * Voyage Header Component
 * Displays voyage summary (Start → End) with swipe-to-delete functionality
 */

import React, { useState, useRef, useEffect, TouchEvent } from 'react';
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

// Helper to format location as fallback (compact coords)
const formatLocationFallback = (entry: ShipLogEntry): string => {
    if (entry.waypointName) return entry.waypointName;
    const lat = entry.latitude;
    const lon = entry.longitude;
    const latDir = lat >= 0 ? 'N' : 'S';
    return `${Math.abs(lat).toFixed(2)}°${latDir}`;
};

export const VoyageHeader: React.FC<VoyageHeaderProps> = ({
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
    useEffect(() => {
        const fetchLocationNames = async () => {
            if (firstEntry && !firstEntry.waypointName) {
                try {
                    const name = await reverseGeocode(firstEntry.latitude, firstEntry.longitude);
                    if (name) setStartLocationName(name);
                } catch (e) {
                    // Fallback to coords
                }
            }
            if (lastEntry && !lastEntry.waypointName && lastEntry.id !== firstEntry?.id) {
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
        if (entry.waypointName) return entry.waypointName;
        if (resolvedName) return resolvedName;
        return formatLocationFallback(entry);
    };

    // Calculate voyage stats
    const totalEntries = entries.length;
    const totalDistance = Math.max(...entries.map(e => e.cumulativeDistanceNM || 0), 0);
    const speeds = entries.filter(e => e.speedKts && e.speedKts > 0).map(e => e.speedKts!);
    const avgSpeed = speeds.length > 0 ? speeds.reduce((a, b) => a + b, 0) / speeds.length : 0;

    // Calculate duration in days
    const startDate = firstEntry ? new Date(firstEntry.timestamp) : new Date();
    const endDate = lastEntry ? new Date(lastEntry.timestamp) : new Date();
    const durationMs = endDate.getTime() - startDate.getTime();
    const durationDays = Math.max(1, Math.ceil(durationMs / (1000 * 60 * 60 * 24)));

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
        <div className="relative overflow-hidden rounded-xl mb-2">
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
                        <span className="text-xs font-bold">Delete</span>
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
                    onClick={() => {
                        if (swipeOffset === 0) {
                            onSelect(); // Select this voyage for export on any click
                        }
                    }}
                    className={`w-full text-left rounded-xl border transition-colors cursor-pointer ${isActive
                        ? 'bg-gradient-to-r from-emerald-900/40 to-sky-900/40 border-emerald-500/30'
                        : isSelected
                            ? 'bg-gradient-to-r from-amber-900/40 to-orange-900/40 border-amber-500/50 ring-1 ring-amber-500/30'
                            : 'bg-slate-800/60 border-white/10 hover:bg-slate-800/80'
                        }`}
                >
                    <div className="p-4">
                        {/* Top row: Route and status */}
                        <div className="flex items-center justify-between mb-2">
                            {/* Clickable area for toggle - left section */}
                            <div
                                className="flex items-center gap-2 cursor-pointer hover:opacity-80 transition-opacity flex-1 min-w-0"
                                onClick={(e) => {
                                    e.stopPropagation(); // Don't trigger card selection twice
                                    if (swipeOffset === 0) {
                                        onSelect();
                                        onToggle();
                                    }
                                }}
                            >
                                <svg
                                    className={`w-4 h-4 text-slate-400 transition-transform duration-150 flex-shrink-0 ${isExpanded ? 'rotate-90' : ''}`}
                                    fill="none"
                                    viewBox="0 0 24 24"
                                    stroke="currentColor"
                                >
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                                </svg>
                                <div className="text-lg font-bold text-white truncate">
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
                                <span className="px-2 py-0.5 bg-emerald-500/20 text-emerald-400 text-xs font-bold rounded-full flex items-center gap-1 flex-shrink-0 ml-2">
                                    <span className="w-1.5 h-1.5 bg-emerald-400 rounded-full animate-pulse" />
                                    ACTIVE
                                </span>
                            )}
                        </div>

                        {/* Stats bar */}
                        <div className="flex items-center gap-4 text-sm">
                            <span className="text-slate-400">
                                <span className="text-white font-bold">{totalDistance.toFixed(1)}</span> NM
                            </span>
                            <span className="text-slate-400">
                                <span className="text-white font-bold">{avgSpeed.toFixed(1)}</span> kts avg
                            </span>
                            <span className="text-slate-400">
                                <span className="text-white font-bold">{totalEntries}</span> entries
                            </span>
                            <span className="text-slate-400">
                                <span className="text-white font-bold">{durationDays}</span>d
                            </span>
                        </div>

                        {/* Swipe hint */}
                        {!isActive && swipeOffset === 0 && (
                            <div className="text-[10px] text-slate-500 mt-2 flex items-center gap-1">
                                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16l-4-4m0 0l4-4m-4 4h18" />
                                </svg>
                                Swipe to delete
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
};
