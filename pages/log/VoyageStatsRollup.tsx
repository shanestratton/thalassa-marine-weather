import React, { useId, useState } from 'react';
import type { PersonalRecords } from '../../services/shiplog/VoyageSummary';
import { useOnlineStatus } from '../../hooks/useOnlineStatus';
import { PersonalRecordsStrip } from './PersonalRecordsStrip';
import { VoyageTotalsTiles } from './VoyageTotalsTiles';
import { LIFETIME_PHONE_ONLY, LOG_CARD_SHELL, LOG_CARD_TITLE, lifetimeUnavailableNotice } from './logPageHelpers';
import { StatsIcon } from './LogPageIcons';

export const VoyageStatsRollup: React.FC<{
    voyageStats: React.ComponentProps<typeof VoyageTotalsTiles>['voyageStats'];
    records: PersonalRecords;
    notice?: string;
    /** The lifetime (archive-inclusive) read failed and never succeeded, so
     *  the totals are this phone's recordings only — or nothing at all. */
    lifetimeUnavailable?: boolean;
    /** Re-runs the existing lifetime/archive load. No Retry without it. */
    onRetry?: () => void | Promise<void>;
    /** That load is in flight (the page's lifetimeLoading). */
    retrying?: boolean;
}> = ({ voyageStats, records, notice, lifetimeUnavailable = false, onRetry, retrying = false }) => {
    const [expanded, setExpanded] = useState(false);
    // A Retry clears the page's error while the load runs, which would flip
    // the card to "includes archived" (and the tiles to 0.0) mid-retry. Hold
    // the unavailable reading until that retry settles.
    const [retryPending, setRetryPending] = useState(false);
    if (retryPending && !retrying) setRetryPending(false);
    const offline = !useOnlineStatus();
    const panelId = useId();
    const titleId = useId();
    const sublineId = useId();
    const unavailable = lifetimeUnavailable || (retryPending && retrying);
    const shownNotice = lifetimeUnavailable ? lifetimeUnavailableNotice(voyageStats.voyageCount, offline) : notice;
    // Expanded, the full notice says it all; the shorthand above it only repeated it.
    const showSubline = !(expanded && unavailable);
    const retry = () => {
        if (!onRetry || retryPending) return;
        setRetryPending(true);
        void onRetry();
    };
    const retryButton = onRetry && unavailable && (
        <button
            type="button"
            onClick={retry}
            disabled={retryPending}
            aria-describedby={showSubline ? sublineId : undefined}
            className="min-h-[44px] shrink-0 rounded-xl border border-sky-400/25 bg-sky-400/10 px-3.5 text-xs font-bold text-sky-200 transition-colors hover:bg-sky-400/20 disabled:opacity-60"
        >
            {retryPending ? 'Retrying…' : 'Retry'}
        </button>
    );
    return (
        // Same card material as Plan's Departure card, so the first card on
        // sibling tabs matches in daylight too (UX scorecard run 6), and the
        // same recipe as Archived voyages below it (run 7).
        <section className={`shrink-0 mx-4 mb-3 ${LOG_CARD_SHELL}`}>
            <button
                type="button"
                aria-expanded={expanded}
                aria-controls={panelId}
                aria-labelledby={titleId}
                aria-describedby={showSubline ? sublineId : undefined}
                onClick={() => setExpanded((open) => !open)}
                className="flex min-h-12 w-full items-center justify-between gap-3 px-4 py-3 text-left focus-visible:outline-2 focus-visible:outline-sky-400"
            >
                <span className="flex min-w-0 items-center gap-3">
                    <span aria-hidden="true" className="shrink-0 text-sky-300">
                        <StatsIcon className="h-5 w-5" />
                    </span>
                    <span className="min-w-0">
                        <span id={titleId} className={LOG_CARD_TITLE}>
                            Voyage stats
                        </span>
                        {/* Never claim "includes archived" over totals that could
                        not include it (UX audit run 5: a skipper with forty
                        archived voyages read "0.0 nm lifetime"). */}
                        {showSubline && (
                            <span id={sublineId} className="mt-1 block text-xs text-slate-400">
                                {unavailable ? LIFETIME_PHONE_ONLY : 'Lifetime · includes archived'}
                            </span>
                        )}
                    </span>
                </span>
                <span aria-hidden="true" className="flex shrink-0 items-center gap-1.5 text-xs font-bold text-sky-200">
                    {expanded ? 'Hide' : 'Show'}
                    <svg
                        width="16"
                        height="16"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        className={`transition-transform ${expanded ? 'rotate-180' : ''}`}
                    >
                        <path d="m6 9 6 6 6-6" />
                    </svg>
                </span>
            </button>
            {retryButton && !expanded && (
                <div className="-mt-1 flex items-center justify-between gap-3 px-4 pb-3">
                    <span className="text-xs text-slate-400">{offline ? 'You’re offline.' : ''}</span>
                    {retryButton}
                </div>
            )}
            <div id={panelId} hidden={!expanded} className="max-h-[40dvh] overflow-y-auto border-t border-white/5 pt-3">
                {shownNotice && (
                    <div className="flex items-start justify-between gap-3 px-4 pb-3">
                        <p role="status" className="text-xs text-amber-200">
                            {shownNotice}
                        </p>
                        {expanded && retryButton}
                    </div>
                )}
                <VoyageTotalsTiles
                    voyageStats={voyageStats}
                    unavailable={unavailable && voyageStats.voyageCount === 0}
                />
                {records.voyageCount > 0 && <PersonalRecordsStrip records={records} />}
            </div>
        </section>
    );
};
