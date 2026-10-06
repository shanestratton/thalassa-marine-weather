import React, { useState } from 'react';
import type { PersonalRecords } from '../../services/shiplog/VoyageSummary';
import { useOnlineStatus } from '../../hooks/useOnlineStatus';
import { JournalCard } from '../../components/vesselHub/JournalCard';
import { ModalSheet } from '../../components/ui/ModalSheet';
import { PersonalRecordsStrip } from './PersonalRecordsStrip';
import { VoyageTotalsTiles } from './VoyageTotalsTiles';
import {
    LIFETIME_DIDNT_LOAD,
    LIFETIME_PHONE_ONLY,
    LIFETIME_PHONE_ONLY_UNDER_LINE,
    LOG_CARD_ACCENT,
    lifetimeUnavailableNotice,
} from './logPageHelpers';
import { StatsIcon } from './LogPageIcons';

/** The card's one-glance reading: lifetime voyages and miles. From
 *  10,000 nm the miles go compact ("12.5k nm") so the count still fits a
 *  half-width card on a 390 pt phone; `exact` gives the full figure, for
 *  the card's VoiceOver description. */
export function voyageStatsSubline(
    voyageStats: { totalNm: number; voyageCount: number },
    { exact = false }: { exact?: boolean } = {},
): string {
    const { voyageCount, totalNm } = voyageStats;
    if (voyageCount === 0) return 'No voyages yet';
    const nm =
        !exact && totalNm >= 10_000
            ? `${(Math.floor(totalNm / 100) / 10).toLocaleString('en-AU')}k`
            : totalNm >= 100
              ? Math.round(totalNm).toLocaleString('en-AU')
              : totalNm.toFixed(1);
    return `${voyageCount} ${voyageCount === 1 ? 'voyage' : 'voyages'} · ${nm} nm`;
}

/** The card's words while the first lifetime read is still out: never "No
 *  voyages yet" over forty voyages that simply have not arrived. */
export const LIFETIME_LOADING_LINE = 'Loading totals…';

/**
 * Voyage stats on the Log's front: one of the pair anchored above the voyage
 * list (Shane 2026-10-06: "can we make the voyage stats and the archive
 * voyages anchored to the page and also make them look the same as the diary
 * and scuttlebutt boxes for consistency"). The card wears the Vessel page's
 * Diary/Scuttlebutt card (components/vesselHub/JournalCard); a tap opens the
 * totals, records, notice and Retry the card used to expand into, in the
 * app's centred sheet clear of the tab bar.
 */
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
    /** The lifetime read has landed at least once (the page's
     *  lifetimeLoaded). Until it has, an in-flight read shows "Loading
     *  totals…", not a count of the live entries alone. */
    loaded?: boolean;
    /** The page's one history line is showing above the pair and already
     *  says the history didn't load, so the card keeps the short form. */
    underHistoryLine?: boolean;
}> = ({
    voyageStats,
    records,
    notice,
    lifetimeUnavailable = false,
    onRetry,
    retrying = false,
    loaded = true,
    underHistoryLine = false,
}) => {
    const [open, setOpen] = useState(false);
    // A Retry clears the page's error while the load runs, which would flip
    // the card to "includes archived" (and the tiles to 0.0) mid-retry. Hold
    // the unavailable reading until that retry settles.
    const [retryPending, setRetryPending] = useState(false);
    if (retryPending && !retrying) setRetryPending(false);
    const offline = !useOnlineStatus();
    const unavailable = lifetimeUnavailable || (retryPending && retrying);
    const shownNotice = lifetimeUnavailable ? lifetimeUnavailableNotice(voyageStats.voyageCount, offline) : notice;
    // Never claim "includes archived" over totals that could not include it
    // (UX audit run 5: a skipper with forty archived voyages read "0.0 nm
    // lifetime"). On the card the short form; the full one is its description.
    const scope = unavailable ? LIFETIME_PHONE_ONLY : 'Lifetime · includes archived';
    // Under the page's history line the cause is said once already; without
    // it the card names it itself, as "Archive didn't load" does beside it.
    const firstLoad = retrying && !loaded;
    const subline = unavailable
        ? underHistoryLine
            ? LIFETIME_PHONE_ONLY_UNDER_LINE
            : LIFETIME_DIDNT_LOAD
        : firstLoad
          ? LIFETIME_LOADING_LINE
          : voyageStatsSubline(voyageStats);
    // Loading, the subline is the whole reading (and its own description).
    const description = unavailable
        ? scope
        : firstLoad
          ? undefined
          : `${voyageStatsSubline(voyageStats, { exact: true })} · ${scope}`;
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
            className="min-h-[44px] shrink-0 rounded-xl border border-sky-400/25 bg-sky-400/10 px-3.5 text-xs font-bold text-sky-200 transition-colors hover:bg-sky-400/20 disabled:opacity-60"
        >
            {retryPending ? 'Retrying…' : 'Retry'}
        </button>
    );
    return (
        <>
            <JournalCard
                aria-label="Voyage stats"
                title="Voyage stats"
                subtitle={subline}
                description={description}
                opensSheet={{ open }}
                icon={
                    <span className="flex" style={{ color: LOG_CARD_ACCENT }}>
                        <StatsIcon />
                    </span>
                }
                accent={LOG_CARD_ACCENT}
                onClick={() => setOpen(true)}
            />
            <ModalSheet isOpen={open} onClose={() => setOpen(false)} title="Voyage stats">
                <div className="-mt-2 pb-1">
                    {/* With the full notice showing, the shorthand only repeated it. */}
                    {!(unavailable && shownNotice) && <p className="mb-3 text-xs text-slate-400">{scope}</p>}
                    {shownNotice && (
                        <div className="flex items-start justify-between gap-3 pb-3">
                            <p role="status" className="text-xs text-amber-200">
                                {shownNotice}
                            </p>
                            {retryButton}
                        </div>
                    )}
                    {!shownNotice && retryButton && <div className="flex justify-end pb-3">{retryButton}</div>}
                    {/* The tiles bring their own 16 px gutter; the sheet's
                        is cancelled so they keep the width the card gave them. */}
                    <div className="-mx-5">
                        <VoyageTotalsTiles
                            voyageStats={voyageStats}
                            unavailable={unavailable && voyageStats.voyageCount === 0}
                        />
                        {records.voyageCount > 0 && <PersonalRecordsStrip records={records} />}
                    </div>
                </div>
            </ModalSheet>
        </>
    );
};
