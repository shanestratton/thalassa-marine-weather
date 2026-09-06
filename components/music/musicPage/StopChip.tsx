import React from 'react';

/**
 * Stop = pause + clear the queue. Pause leaves the track loaded and the
 * floating bar up; this is the off switch (Shane 2026-09-06: "a kill switch
 * here for music … something like STOP"). Sits beside the speaker chip.
 */
export const StopChip: React.FC<{ onStop: () => void }> = ({ onStop }) => (
    <button
        type="button"
        onClick={onStop}
        aria-label="Stop the music and clear the queue"
        className="inline-flex min-h-[44px] items-center gap-1.5 rounded-full border border-red-400/30 bg-slate-950/60 px-3 py-1.5 text-[10px] font-black uppercase tracking-[0.12em] text-red-300 backdrop-blur-md transition active:scale-95"
    >
        <span aria-hidden="true" className="inline-block h-2.5 w-2.5 rounded-[2px] bg-current" />
        <span>Stop</span>
    </button>
);
