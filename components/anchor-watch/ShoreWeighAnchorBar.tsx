import React, { useId } from 'react';

/**
 * Shore Watch's Weigh Anchor, shown only when the watch is this phone's own
 * Pi's (Shane 2026-09-29). There the header has no Leave (Shane 2026-10-10:
 * it looked just like this button); Back leaves the Pi watching.
 *
 * It ends the readings column, inside their scroll region: pinned under it,
 * it left compact landscape (844x430) a 40 px sliver of readings. Weighing
 * anchor is a departure, not an emergency, so one scroll away is right.
 * Shared with the layout fixture so the tested bar is the shipped one.
 *
 * `refused` (129-12): her Pi would not take the stop from this phone, which is
 * not set up for it. The Pi is still watching; the bar says so in her Pi's
 * words and offers the way to set this phone up (Boat network, where the code
 * is typed, as the AIS key's watch row does).
 */
export const ShoreWeighAnchorBar: React.FC<{ onWeighAnchor: () => void; refused?: string | null }> = ({
    onWeighAnchor,
    refused,
}) => {
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
                Stops the Pi&rsquo;s watch. Back keeps the Pi watching.
            </p>
            {refused && (
                <div role="status" className="mt-2 flex flex-col items-center gap-1 text-center">
                    <p className="text-xs text-amber-300">{refused}</p>
                    <button
                        type="button"
                        onClick={() =>
                            window.dispatchEvent(new CustomEvent('thalassa:navigate', { detail: { tab: 'avnav' } }))
                        }
                        className="min-h-11 rounded-lg border border-amber-400/40 px-3 text-xs font-bold text-amber-300"
                    >
                        Set up this phone
                    </button>
                </div>
            )}
        </div>
    );
};
