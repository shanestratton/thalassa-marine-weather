/**
 * TrackingFooterControls — the Stop / Share position / New Log Entry row
 * pinned at the bottom while recording, extracted verbatim from
 * pages/LogPage.tsx.
 */
import React from 'react';
import { MapPinIcon, StopIcon } from '../../components/Icons';
import { triggerHaptic } from '../../utils/system';
import type { LogPageAction } from '../../hooks/useLogPageState';
import { PlusIcon } from './LogPageIcons';

export const TrackingFooterControls: React.FC<{
    handleStopTracking: () => void;
    handleShareCurrentPosition: () => void;
    dispatch: (action: LogPageAction) => void;
}> = ({ handleStopTracking, handleShareCurrentPosition, dispatch }) => (
    <div className="shrink-0 px-4 pt-2" style={{ paddingBottom: 'calc(4rem + env(safe-area-inset-bottom) + 8px)' }}>
        <div className="flex gap-2">
            <button
                aria-label="Stop tracking"
                onClick={() => {
                    triggerHaptic('medium');
                    handleStopTracking();
                }}
                className="flex-1 h-14 rounded-2xl font-extrabold text-sm uppercase tracking-wider transition-all flex items-center justify-center gap-1.5 bg-red-500/15 border border-red-500/30 text-red-400 hover:bg-red-500/25 active:scale-[0.97]"
            >
                <StopIcon className="w-4 h-4" />
                Stop
            </button>
            <button
                aria-label="Share your position"
                onClick={handleShareCurrentPosition}
                className="w-14 h-14 shrink-0 rounded-2xl font-extrabold text-xs transition-all flex items-center justify-center bg-teal-500/15 border border-teal-500/30 text-teal-400 hover:bg-teal-500/25 active:scale-[0.97]"
                title="Share your position"
            >
                <MapPinIcon className="w-5 h-5" />
            </button>
            <button
                aria-label="Add log entry"
                onClick={() => dispatch({ type: 'SHOW_ADD_MODAL', show: true })}
                className="flex-1 h-14 px-4 rounded-2xl font-extrabold text-sm uppercase tracking-wider transition-all flex items-center justify-center gap-2 bg-linear-to-r from-sky-500 to-sky-600 hover:from-sky-400 hover:to-sky-500 text-white shadow-lg shadow-sky-500/25 active:scale-[0.98]"
            >
                <PlusIcon className="w-5 h-5" />
                New Log Entry
            </button>
        </div>
    </div>
);
