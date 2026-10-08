/**
 * FollowBlockNoticeCard — the stay-put follow notice shown in the tracking
 * view (a refusal, or since build 124 the one quiet "Following, not checked
 * yet" line), extracted from pages/LogPage.tsx. The caller keeps the guard
 * that decides when the sheet is not the right home for it.
 */
import React from 'react';

export const FollowBlockNoticeCard: React.FC<{
    followNotice: string;
    setFollowNotice: React.Dispatch<React.SetStateAction<string | null>>;
}> = ({ followNotice, setFollowNotice }) => (
    <div className="shrink-0 px-4 pt-2 animate-in fade-in slide-in-from-bottom-2 duration-300" role="alert">
        <div className="rounded-2xl bg-slate-900 border border-amber-500/40 shadow-lg shadow-black/40 px-4 py-3">
            <div className="flex items-start gap-2.5">
                <span aria-hidden="true" className="mt-px text-[15px] leading-none">
                    {'⚠️'}
                </span>
                <p className="flex-1 text-[12px] leading-relaxed text-amber-100">{followNotice}</p>
                <button
                    type="button"
                    aria-label="Dismiss"
                    onClick={() => setFollowNotice(null)}
                    className="hit-target-44 -mr-1 -mt-1 shrink-0 rounded-lg px-2 py-1 text-[15px] leading-none text-amber-200/60 active:scale-95 hover:text-amber-100"
                >
                    {'×'}
                </button>
            </div>
        </div>
    </div>
);
