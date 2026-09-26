import React, { useId, useRef, useState } from 'react';
import type { VoyageSummary } from '../../services/shiplog/VoyageSummary';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { formatVoyageDuration, voyageElapsedMs } from '../../utils/voyageTiming';
import { groupPassageLogs } from './PassageLogList';
import { useEndpointNames } from './useEndpointNames';
import { useOnlineStatus } from '../../hooks/useOnlineStatus';

type RestorePassage = (passageId: string, voyageIds: string[]) => Promise<void>;

interface ArchivedVoyagesSectionProps {
    loggedArchivedVoyages: readonly VoyageSummary[];
    showArchived: boolean;
    setShowArchived: React.Dispatch<React.SetStateAction<boolean>>;
    handleUnarchiveVoyage: (voyageId: string) => Promise<void>;
    handleRestorePassage?: RestorePassage;
    loading?: boolean;
    error?: string | null;
    onRetry?: () => void;
    /** Spacing for where the page places the card (default: below the list). */
    className?: string;
}

function ArchivedVoyageCard({
    voyage,
    busy,
    restoring,
    onRestore,
}: {
    voyage: VoyageSummary;
    busy: boolean;
    restoring: boolean;
    onRestore: () => void;
}) {
    const { startLabel, endLabel } = useEndpointNames(
        { latitude: voyage.firstLat, longitude: voyage.firstLon },
        { latitude: voyage.lastLat, longitude: voyage.lastLon },
    );
    const title = `${startLabel ?? 'Departure'} → ${endLabel ?? 'Arrival'}`;
    const date = new Date(voyage.departedAt ?? voyage.startedAt);
    const dateLabel = Number.isFinite(date.getTime())
        ? date.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: '2-digit' })
        : 'Date unavailable';
    return (
        <article aria-label={title} className="min-w-0 rounded-2xl border border-white/10 bg-slate-950/40 p-3.5 sm:p-4">
            <h4 className="text-sm font-bold leading-snug text-slate-100 break-words">{title}</h4>
            <p className="mt-1 text-xs text-slate-400">{dateLabel}</p>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs font-semibold tabular-nums">
                    <span className="text-sky-300">{voyage.totalDistanceNM.toFixed(1)} nm</span>
                    <span className="text-slate-300">{formatVoyageDuration(voyageElapsedMs(voyage))}</span>
                </div>
                <button
                    type="button"
                    aria-label={`Restore voyage ${title} · ${dateLabel}`}
                    aria-busy={restoring}
                    disabled={busy}
                    onClick={onRestore}
                    className="min-h-[44px] shrink-0 rounded-xl border border-sky-400/25 bg-sky-400/10 px-3.5 text-xs font-bold text-sky-200 transition-colors hover:bg-sky-400/20 disabled:opacity-50"
                >
                    {restoring ? 'Restoring…' : 'Restore'}
                </button>
            </div>
        </article>
    );
}

/** Every row is a whole-voyage summary, never a slice of archived GPS points.
 * The heading counts voyages, even when several are grouped in one passage. */
export function ArchivedVoyagesSection({
    loggedArchivedVoyages,
    showArchived,
    setShowArchived,
    handleUnarchiveVoyage,
    handleRestorePassage,
    loading = false,
    error = null,
    onRetry,
    className = 'mt-5',
}: ArchivedVoyagesSectionProps) {
    const contentId = useId();
    const statusLineId = useId();
    const offline = !useOnlineStatus();
    const [restoringIds, setRestoringIds] = useState<readonly string[]>([]);
    const [restoreError, setRestoreError] = useState<string | null>(null);
    const [notice, setNotice] = useState('');
    const [restoreRequest, setRestoreRequest] = useState<{
        passageId: string;
        voyageIds: string[];
        restore: RestorePassage;
    } | null>(null);
    const busyRef = useRef(false);
    const groups = groupPassageLogs(loggedArchivedVoyages);
    const passageCount = groups.filter((group) => group.passage).length;
    const count = loggedArchivedVoyages.length;
    const busy = restoringIds.length > 0;
    // Nothing to show and the read failed. Collapsed, this card is the only
    // place the skipper sees it, so the Retry lives on the card itself.
    const loadFailed = !!error && count === 0 && !loading;
    // A cause only when the app already knows it (probe-verified offline).
    const loadErrorText = error && offline ? `${error} You’re offline.` : error;

    async function restore(ids: string[], action: () => Promise<void>) {
        if (busyRef.current) return;
        busyRef.current = true;
        setRestoringIds(ids);
        setRestoreError(null);
        setNotice('');
        try {
            await action();
            setNotice(`${ids.length === 1 ? 'Voyage' : `${ids.length} voyages`} restored to your log.`);
        } catch (cause) {
            setRestoreError(
                cause instanceof Error && cause.message.trim()
                    ? cause.message
                    : 'Could not finish restoring. Refresh the archive, then try again.',
            );
        } finally {
            busyRef.current = false;
            setRestoringIds([]);
        }
    }

    return (
        <section className={`${className} overflow-hidden rounded-[1.5rem] border border-slate-500/25 bg-slate-900/35`}>
            <button
                type="button"
                aria-expanded={showArchived}
                aria-controls={contentId}
                onClick={() => setShowArchived(!showArchived)}
                className="flex min-h-[76px] w-full items-center justify-between gap-3 px-4 py-3.5 text-left transition-colors hover:bg-white/3"
            >
                <span className="flex min-w-0 items-center gap-3">
                    <svg
                        aria-hidden="true"
                        className="h-5 w-5 shrink-0 text-sky-300"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                    >
                        <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={1.7}
                            d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4"
                        />
                    </svg>
                    <span className="min-w-0">
                        <span className="block text-xs font-black uppercase tracking-widest text-sky-300">
                            Archived voyages
                        </span>
                        <span id={statusLineId} className="mt-1 block text-xs text-slate-400">
                            {loading && count === 0
                                ? 'Loading archive…'
                                : error && count === 0
                                  ? 'Archive unavailable'
                                  : `${count} ${count === 1 ? 'voyage' : 'voyages'}${passageCount ? ` · ${passageCount} ${passageCount === 1 ? 'passage' : 'passages'}` : ''}`}
                        </span>
                    </span>
                </span>
                <span className="flex shrink-0 items-center gap-1.5 text-xs font-semibold text-sky-200">
                    {showArchived ? 'Hide' : error && count === 0 ? 'Details' : 'Show'}
                    <svg
                        aria-hidden="true"
                        className={`h-4 w-4 transition-transform ${showArchived ? 'rotate-180' : ''}`}
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                    >
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="m6 9 6 6 6-6" />
                    </svg>
                </span>
            </button>

            {loadFailed && !showArchived && onRetry && (
                <div className="-mt-1 flex items-center justify-between gap-3 px-4 pb-3">
                    <span className="text-xs text-slate-400">{offline ? 'You’re offline.' : ''}</span>
                    <button
                        type="button"
                        disabled={busy}
                        aria-describedby={statusLineId}
                        onClick={() => onRetry()}
                        className="min-h-[44px] shrink-0 rounded-xl border border-sky-400/25 bg-sky-400/10 px-3.5 text-xs font-bold text-sky-200 transition-colors hover:bg-sky-400/20 disabled:opacity-50"
                    >
                        Retry
                    </button>
                </div>
            )}
            <p role="status" className={notice ? 'mx-4 mb-3 text-xs font-semibold text-emerald-300' : 'sr-only'}>
                {notice}
            </p>
            {showArchived && (
                <div id={contentId} className="space-y-3 border-t border-white/5 p-3" aria-busy={loading}>
                    {loading && <p className="px-1 text-xs text-sky-200">Updating archive…</p>}
                    {(error || restoreError) && (
                        <div role="alert" className="rounded-xl border border-amber-400/25 bg-amber-400/10 p-3">
                            <p className="text-xs leading-relaxed text-amber-100">{restoreError || loadErrorText}</p>
                            {onRetry && (
                                <button
                                    type="button"
                                    disabled={loading || busy}
                                    onClick={() => {
                                        setRestoreError(null);
                                        onRetry();
                                    }}
                                    className="mt-1 min-h-[44px] text-xs font-bold text-amber-200 disabled:opacity-40"
                                >
                                    Refresh archive
                                </button>
                            )}
                        </div>
                    )}
                    {!loading && !error && count === 0 && (
                        <div className="px-3 py-6 text-center">
                            <p className="text-sm font-semibold text-slate-200">No archived voyages</p>
                            <p className="mt-1 text-xs text-slate-400">
                                Archived logs stay here until you restore them.
                            </p>
                        </div>
                    )}
                    {groups.map((group) => {
                        const cards = group.voyages.map((voyage) => (
                            <ArchivedVoyageCard
                                key={voyage.voyageId}
                                voyage={voyage}
                                busy={busy}
                                restoring={restoringIds.includes(voyage.voyageId)}
                                onRestore={() =>
                                    void restore([voyage.voyageId], () => handleUnarchiveVoyage(voyage.voyageId))
                                }
                            />
                        ));
                        if (!group.passage) return <React.Fragment key={group.key}>{cards}</React.Fragment>;
                        return (
                            <section
                                key={group.key}
                                aria-label={`Archived passage · ${group.voyages.length} ${group.voyages.length === 1 ? 'leg' : 'legs'}`}
                                className="min-w-0 space-y-2 rounded-2xl border border-purple-400/35 bg-linear-to-b from-purple-500/15 to-purple-500/5 p-2 shadow-[0_0_22px_-8px_rgba(192,132,252,0.3)]"
                            >
                                <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 px-1 pb-1">
                                    <div>
                                        <h3 className="text-xs font-extrabold tracking-[0.2em] text-yellow-300">
                                            PASSAGE
                                        </h3>
                                        <p className="mt-1 text-xs text-purple-200/75">
                                            {group.voyages.length} {group.voyages.length === 1 ? 'leg' : 'legs'}
                                        </p>
                                    </div>
                                    {handleRestorePassage && (
                                        <button
                                            type="button"
                                            disabled={busy}
                                            onClick={() =>
                                                setRestoreRequest({
                                                    passageId: group.voyages[0].passageGroupId!,
                                                    voyageIds: group.voyages.map((voyage) => voyage.voyageId),
                                                    restore: handleRestorePassage,
                                                })
                                            }
                                            className="min-h-[44px] rounded-xl border border-purple-300/25 bg-purple-400/10 px-3 text-xs font-bold text-purple-100 disabled:opacity-40"
                                        >
                                            Restore passage
                                        </button>
                                    )}
                                </div>
                                {cards}
                            </section>
                        );
                    })}
                </div>
            )}
            <ConfirmDialog
                isOpen={!!restoreRequest}
                title="Restore this passage?"
                message={`Return all ${restoreRequest?.voyageIds.length ?? 0} archived ${(restoreRequest?.voyageIds.length ?? 0) === 1 ? 'leg' : 'legs'} to your log. They stay grouped as a passage.`}
                confirmLabel={`Restore ${restoreRequest?.voyageIds.length ?? 0} ${(restoreRequest?.voyageIds.length ?? 0) === 1 ? 'leg' : 'legs'}`}
                onCancel={() => {
                    if (!busyRef.current) setRestoreRequest(null);
                }}
                onConfirm={async () => {
                    if (!restoreRequest || busyRef.current) return;
                    const request = restoreRequest;
                    await restore(request.voyageIds, () => request.restore(request.passageId, request.voyageIds));
                    setRestoreRequest(null);
                }}
            />
        </section>
    );
}
