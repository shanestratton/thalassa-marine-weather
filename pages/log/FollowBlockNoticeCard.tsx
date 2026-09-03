/**
 * FollowBlockNoticeCard — the stay-put "route refused" card shown in the
 * tracking view, extracted verbatim from pages/LogPage.tsx. The caller keeps
 * the guard that decides when the sheet is not the right home for it.
 */
import React from 'react';

export const FollowBlockNoticeCard: React.FC<{
    followBlockNotice: string;
    setFollowBlockNotice: React.Dispatch<React.SetStateAction<string | null>>;
}> = ({ followBlockNotice, setFollowBlockNotice }) => (
    <div className="shrink-0 px-4 pt-2 animate-in fade-in slide-in-from-bottom-2 duration-300" role="alert">
        <div className="rounded-2xl bg-slate-900 border border-amber-500/40 shadow-lg shadow-black/40 px-4 py-3">
            <div className="flex items-start gap-2.5">
                <span aria-hidden="true" className="mt-px text-[15px] leading-none">
                    {'⚠️'}
                </span>
                <p className="flex-1 text-[12px] leading-relaxed text-amber-100">{followBlockNotice}</p>
                <button
                    type="button"
                    aria-label="Dismiss"
                    onClick={() => setFollowBlockNotice(null)}
                    className="hit-target-44 -mr-1 -mt-1 shrink-0 rounded-lg px-2 py-1 text-[15px] leading-none text-amber-200/60 active:scale-95 hover:text-amber-100"
                >
                    {'×'}
                </button>
            </div>
        </div>
    </div>
);
