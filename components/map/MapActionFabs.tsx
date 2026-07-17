/**
 * Map Action FABs — extracted from MapHub.
 *
 * GPS locate and weather-location recenter floating action buttons.
 */
import React from 'react';

// PARKED (Shane 2026-07-17: "remove that bottom right fab, and replace it
// with the fab which is immediately to the left of it"): the recenter-on-
// weather-location pin rarely earned its corner, and it pushed the far more
// important GPS Locate Me under the detail scrubber. Locate Me now owns the
// bottom-right slot; flip this to bring the pin back (wiring intact).
const RECENTER_FAB_VISIBLE = false;

interface MapActionFabsProps {
    onLocateMe: () => void;
    onRecenter: () => void;
    recenterDisabled: boolean;
}

export const MapActionFabs: React.FC<MapActionFabsProps> = ({ onLocateMe, onRecenter, recenterDisabled }) => {
    return (
        <div
            // right-[16px] (= right-4) aligns with the right-rail FAB column
            // and the ConnectivityChip so every right-edge element on the
            // chart screen sits on the same vertical gridline.
            className="absolute right-[16px] z-[500] flex flex-row gap-2"
            style={{ bottom: 'calc(80px + env(safe-area-inset-bottom))' }}
        >
            {/* GPS Locate Me — fly to device position */}
            <button
                aria-label="Locate me"
                onClick={onLocateMe}
                className="w-12 h-12 bg-slate-900/90 border border-white/[0.08] rounded-2xl flex items-center justify-center shadow-2xl hover:bg-slate-800/90 transition-all active:scale-95"
            >
                <svg
                    className="w-5 h-5 text-emerald-400"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                >
                    <circle cx="12" cy="12" r="3" />
                    <path strokeLinecap="round" d="M12 2v3m0 14v3M2 12h3m14 0h3" />
                </svg>
            </button>

            {/* Recenter on weather location — parked, see RECENTER_FAB_VISIBLE */}
            {RECENTER_FAB_VISIBLE && (
            <button
                aria-label="Recenter on weather location"
                onClick={onRecenter}
                disabled={recenterDisabled}
                className="w-12 h-12 bg-slate-900/90 border border-white/[0.08] rounded-2xl flex items-center justify-center shadow-2xl hover:bg-slate-800/90 transition-all active:scale-95"
            >
                <svg
                    className="w-5 h-5 text-white"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={1.5}
                >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 10.5a3 3 0 11-6 0 3 3 0 016 0z" />
                    <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1115 0z"
                    />
                </svg>
            </button>
            )}
        </div>
    );
};
