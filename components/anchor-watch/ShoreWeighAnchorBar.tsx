import React, { useId } from 'react';

/**
 * Shore Watch's Weigh Anchor, shown only when the watch is this phone's own
 * Pi's (Shane 2026-09-29). Leave stays in the header and keeps its meaning
 * (the Pi carries on).
 *
 * It ends the readings column, inside their scroll region: pinned under it,
 * it left compact landscape (844x430) a 40 px sliver of readings. Weighing
 * anchor is a departure, not an emergency, so one scroll away is right.
 * Shared with the layout fixture so the tested bar is the shipped one.
 */
export const ShoreWeighAnchorBar: React.FC<{ onWeighAnchor: () => void }> = ({ onWeighAnchor }) => {
    const noteId = useId();
    return (
        <div className="mt-4" data-testid="shore-weigh-anchor">
            <button
                type="button"
                onClick={onWeighAnchor}
                aria-describedby={noteId}
                className="w-full min-h-11 py-3 bg-red-500/8 border border-red-500/20 rounded-xl text-red-400 text-sm font-bold transition-all active:scale-[0.97] hover:bg-red-500/12"
            >
                ⏏ Weigh Anchor
            </button>
            <p id={noteId} className="mt-1 text-center text-xs text-slate-400">
                Stops the Pi&rsquo;s watch. Leave keeps the Pi watching.
            </p>
        </div>
    );
};
