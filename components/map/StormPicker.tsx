/**
 * StormPicker — Modal for selecting one of multiple active cyclones.
 *
 * Opens when the user taps "Storms" in the radial helm menu AND there's more
 * than one active cyclone. The previous behaviour auto-focused the closest
 * storm with no way to pick another — which was fine when there's only one
 * system active but broke as soon as (say) three concurrent cyclones were
 * being tracked.
 *
 * Keeps the same styling as the legacy LayerFABMenu storm section — category
 * colour badges, wind/pressure readout, distance — so users see a consistent
 * storm chooser regardless of which FAB path they open it from.
 */
import React from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import type { ActiveCyclone } from '../../services/weather/CycloneTrackingService';
import { triggerHaptic } from '../../utils/system';

interface StormPickerProps {
    /** When true, modal is visible. */
    visible: boolean;
    /** Cyclones to choose from. */
    cyclones: ActiveCyclone[];
    /** User's current position — used to compute distance to each storm. */
    userLat: number;
    userLon: number;
    /** Name of the currently-selected storm, if any (highlights that row). */
    selectedStormName?: string | null;
    /** Called when the user picks a storm. */
    onSelect: (storm: ActiveCyclone) => void;
    /** Called when the user dismisses the modal (tap scrim or close button). */
    onClose: () => void;
    /** Called when the user taps "Turn Off" — hides all cyclones. */
    onClearStorms?: () => void;
}

/** Category → accent colour (matches the legacy storm menu). */
const CAT_COLORS: Record<number, string> = {
    5: 'bg-fuchsia-500',
    4: 'bg-red-500',
    3: 'bg-orange-500',
    2: 'bg-amber-500',
    1: 'bg-yellow-500',
    0: 'bg-sky-500',
};

/** Haversine great-circle distance (km). Good enough for a storm-picker UI. */
function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371;
    const toRad = (d: number) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return Math.round(2 * R * Math.asin(Math.sqrt(a)));
}

/** Trim storm names that sometimes arrive as "Hurricane Kiko" / "Tropical Storm Iona". */
function shortStormName(full: string): string {
    return full.replace(/^(Hurricane|Typhoon|Cyclone|Tropical\s+Storm|Tropical\s+Depression|Severe)\s+/i, '').trim();
}

export const StormPicker: React.FC<StormPickerProps> = ({
    visible,
    cyclones,
    userLat,
    userLon,
    selectedStormName,
    onSelect,
    onClose,
    onClearStorms,
}) => {
    if (typeof document === 'undefined') return null;

    // Sort by distance — closest first is the most useful default for skippers.
    const sorted = [...cyclones].sort((a, b) => {
        const da = distanceKm(userLat, userLon, a.currentPosition.lat, a.currentPosition.lon);
        const db = distanceKm(userLat, userLon, b.currentPosition.lat, b.currentPosition.lon);
        return da - db;
    });

    return createPortal(
        <AnimatePresence>
            {visible && (
                <motion.div
                    key="storm-picker"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.2 }}
                    className="fixed inset-0 z-[9999] flex items-start justify-center bg-black/60"
                    onClick={onClose}
                    role="dialog"
                    aria-modal="true"
                    aria-label="Choose active cyclone"
                    style={{
                        paddingTop: 'calc(env(safe-area-inset-top, 0px) + 56px)',
                        paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 80px)',
                    }}
                >
                    <motion.div
                        initial={{ opacity: 0, scale: 0.95, y: -8 }}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.95, y: -8 }}
                        transition={{ type: 'spring', stiffness: 500, damping: 30 }}
                        className="w-full max-w-md mx-4 bg-slate-900/95 backdrop-blur-xl border border-white/[0.08] rounded-2xl shadow-2xl overflow-hidden"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="h-[2px] bg-gradient-to-r from-transparent via-red-500/60 to-transparent" />

                        {/* Header */}
                        <div className="flex items-center justify-between px-5 pt-4 pb-2">
                            <div>
                                <h2 className="text-sm font-black text-white uppercase tracking-wider">
                                    Active Cyclones
                                </h2>
                                <p className="text-[11px] text-gray-500 mt-0.5">
                                    {cyclones.length} tracked — tap to focus
                                </p>
                            </div>
                            <button
                                onClick={onClose}
                                aria-label="Close storm picker"
                                className="p-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-gray-400 hover:text-white transition-colors"
                            >
                                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        strokeWidth={2}
                                        d="M6 18L18 6M6 6l12 12"
                                    />
                                </svg>
                            </button>
                        </div>

                        {/* Storm list */}
                        <div className="max-h-[60vh] overflow-y-auto">
                            {sorted.map((storm, idx) => {
                                const dist = distanceKm(
                                    userLat,
                                    userLon,
                                    storm.currentPosition.lat,
                                    storm.currentPosition.lon,
                                );
                                const isSelected = selectedStormName === storm.name;
                                return (
                                    <button
                                        key={`${storm.sid}-${idx}`}
                                        aria-label={`Focus on ${shortStormName(storm.name)}`}
                                        onClick={() => {
                                            onSelect(storm);
                                            triggerHaptic('medium');
                                            onClose();
                                        }}
                                        className={`w-full flex items-center gap-3 px-5 py-3 text-left transition-colors border-b border-white/[0.04] last:border-b-0 ${
                                            isSelected ? 'bg-red-500/15 text-white' : 'text-gray-300 hover:bg-white/5'
                                        }`}
                                    >
                                        {/* Category badge */}
                                        <span
                                            className={`w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-black text-white ${CAT_COLORS[storm.category] ?? 'bg-gray-500'} shrink-0`}
                                        >
                                            {storm.categoryLabel}
                                        </span>

                                        {/* Name + stats */}
                                        <div className="flex-1 min-w-0">
                                            <div className="text-sm font-bold truncate">
                                                {shortStormName(storm.name)}
                                            </div>
                                            <div className="text-[11px] text-gray-500 mt-0.5">
                                                {storm.maxWindKts} kt
                                                {storm.minPressureMb ? ` · ${storm.minPressureMb} hPa` : ''}
                                                {' · '}
                                                {dist > 1000 ? `${Math.round(dist / 1000)}k km` : `${dist} km`}
                                            </div>
                                        </div>

                                        {/* Selected indicator */}
                                        {isSelected ? (
                                            <span
                                                className="w-2 h-2 rounded-full bg-red-400 animate-pulse shrink-0"
                                                aria-hidden
                                            />
                                        ) : (
                                            <svg
                                                className="w-4 h-4 text-gray-600 shrink-0"
                                                fill="none"
                                                viewBox="0 0 24 24"
                                                stroke="currentColor"
                                                strokeWidth={2}
                                            >
                                                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                                            </svg>
                                        )}
                                    </button>
                                );
                            })}
                        </div>

                        {/* Footer — "Turn off storms" clears the layer entirely. */}
                        {onClearStorms && (
                            <div className="px-5 py-3 border-t border-white/[0.06]">
                                <button
                                    onClick={() => {
                                        onClearStorms();
                                        onClose();
                                    }}
                                    className="w-full py-2 text-[10px] font-black uppercase tracking-widest text-gray-400 hover:text-red-400 transition-colors"
                                >
                                    Hide All Storms
                                </button>
                            </div>
                        )}
                    </motion.div>
                </motion.div>
            )}
        </AnimatePresence>,
        document.body,
    );
};
