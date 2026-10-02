/**
 * SharedBinderLine — one plain line under a Boat Binder page's title saying
 * whose binder this is while the sailor is crew (shared binders, 2026-10-02):
 *
 *   Shared from Test Boat — you're crew · view only
 *
 * With more than one skipper sharing this register, a "Switch boat" button
 * opens a centred sheet listing the boats by name. Renders nothing for the
 * sailor's own binder.
 */
import React, { useState } from 'react';
import { ModalSheet } from '../ui/ModalSheet';
import {
    listBinderSkippers,
    selectBinderSkipper,
    type BinderRegister,
    type BinderSource,
} from '../../services/vessel/sharedBinders';
import { triggerHaptic } from '../../utils/system';

export const SKIPPER_BOAT_FALLBACK = "your skipper's boat";

/** "Shared from Test Boat — you're crew · view only". Never an email. */
export function sharedBinderCopy(source: BinderSource): string | null {
    if (source.mode !== 'shared') return null;
    return `Shared from ${source.vesselName ?? SKIPPER_BOAT_FALLBACK} — you're crew${source.canWrite ? '' : ' · view only'}`;
}

/** "Bringing in Test Boat's binder…", for a shared binder still arriving. */
export function bringingInCopy(source: BinderSource): string {
    const boat = source.mode === 'shared' && source.vesselName ? `${source.vesselName}'s` : "your skipper's";
    return `Bringing in ${boat} binder…`;
}

interface SharedBinderLineProps {
    register: BinderRegister;
    source: BinderSource;
}

export const SharedBinderLine: React.FC<SharedBinderLineProps> = ({ register, source }) => {
    const [switching, setSwitching] = useState(false);
    const copy = sharedBinderCopy(source);
    if (!copy || source.mode !== 'shared') return null;
    const skippers = switching ? listBinderSkippers(register) : [];

    return (
        <>
            <p
                data-testid="shared-binder-line"
                className="basis-full flex flex-wrap items-center gap-x-2 text-xs font-semibold text-sky-300"
            >
                <span>{copy}</span>
                {source.skipperCount > 1 && (
                    <button
                        type="button"
                        onClick={() => {
                            triggerHaptic('light');
                            setSwitching(true);
                        }}
                        className="hit-target-44 font-bold text-sky-400 underline underline-offset-2"
                    >
                        Switch boat
                    </button>
                )}
            </p>
            {switching && (
                <ModalSheet isOpen={true} onClose={() => setSwitching(false)} title="Switch boat" maxWidth="max-w-sm">
                    <p className="text-xs text-gray-400 mb-3">Show the binder shared from:</p>
                    <div className="space-y-2">
                        {skippers.map((skipper) => {
                            const selected = skipper.ownerId === source.ownerId;
                            return (
                                <button
                                    key={skipper.ownerId}
                                    type="button"
                                    aria-pressed={selected}
                                    onClick={() => {
                                        triggerHaptic('medium');
                                        selectBinderSkipper(skipper.ownerId);
                                        setSwitching(false);
                                    }}
                                    className={`w-full min-h-[44px] rounded-xl px-4 py-3 text-left text-sm font-bold transition-colors ${
                                        selected
                                            ? 'bg-sky-500/20 text-sky-300 border border-sky-500/30'
                                            : 'bg-white/5 text-white border border-white/5 hover:bg-white/10'
                                    }`}
                                >
                                    {skipper.vesselName ?? SKIPPER_BOAT_FALLBACK}
                                </button>
                            );
                        })}
                    </div>
                </ModalSheet>
            )}
        </>
    );
};
