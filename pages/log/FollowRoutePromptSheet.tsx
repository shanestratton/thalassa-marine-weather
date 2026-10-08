/**
 * FollowRoutePromptSheet — the cast-off "Following a route?" sheet, extracted
 * verbatim from pages/LogPage.tsx. TWO doors feed it (pre-start and
 * post-start); the caller keeps the guard that opens it and owns every piece
 * of state it reads.
 */
import { createPortal } from 'react-dom';
import React from 'react';
import { createLogger } from '../../utils/createLogger';
import { SavedRoutePassageHeading } from '../../components/routes/SavedRouteRows';
import { ordinalLegLabel } from '../../services/routeTracer';
import { isAuthIdentityScopeCurrent, type AuthIdentityScope } from '../../services/authIdentityScope';
import type { VoyageSummary } from '../../services/shiplog/VoyageSummary';
import type { TraceCheckState } from '../../services/traceBackgroundCheck';
import { FollowRouteChoice } from './LogSubComponents';
import { TRACE_ROUTE_USE_BLOCK_PREFIX, TRACE_CHECK_STORAGE_FULL, type FollowPromptRow } from './logPageTypes';

const log = createLogger('LogPage');

export const FollowRoutePromptSheet: React.FC<{
    dismissFollowPrompt: () => void;
    followPromptDialogRef: React.RefObject<HTMLDivElement>;
    followPromptDismissRef: React.RefObject<HTMLButtonElement>;
    followNotice: string | null;
    setFollowNotice: React.Dispatch<React.SetStateAction<string | null>>;
    followPromptRows: FollowPromptRow[];
    openRouteInTracer: (savedRouteId: string | null) => Promise<void>;
    /** Background check state per saved route (services/traceBackgroundCheck). */
    checkStates: ReadonlyMap<string, TraceCheckState>;
    onCheckNow: (savedRouteId: string) => void;
    onStopCheck: (savedRouteId: string) => void;
    /** The red row's finding can be acknowledged in place. */
    canReview: (savedRouteId: string) => boolean;
    onReview: (savedRouteId: string) => void;
    /** A red row's armed second tap: follow it anyway. */
    acceptFindingFor: (voyageId: string) => void;
    /** The row whose waypoints are being fetched from the account. */
    fetchingRouteId: string | null;
    followPromptLoadingId: string | null;
    setFollowPromptLoadingId: React.Dispatch<React.SetStateAction<string | null>>;
    followPromptVoyageId: string | null;
    identityScope: AuthIdentityScope;
    preStartSheetOpen: boolean;
    setPreStartSheetOpen: React.Dispatch<React.SetStateAction<boolean>>;
    preStartAnswerRef: React.MutableRefObject<VoyageSummary | 'none' | null>;
    startTrackingVerifiedRef: React.MutableRefObject<() => void>;
    applyFollowPick: (s: VoyageSummary, promptVid: string | null) => Promise<void>;
}> = ({
    dismissFollowPrompt,
    followPromptDialogRef,
    followPromptDismissRef,
    followNotice,
    setFollowNotice,
    followPromptRows,
    openRouteInTracer,
    checkStates,
    onCheckNow,
    onStopCheck,
    canReview,
    onReview,
    acceptFindingFor,
    fetchingRouteId,
    followPromptLoadingId,
    setFollowPromptLoadingId,
    followPromptVoyageId,
    identityScope,
    preStartSheetOpen,
    setPreStartSheetOpen,
    preStartAnswerRef,
    startTrackingVerifiedRef,
    applyFollowPick,
}) =>
    // PORTALLED TO <body> — the reason two position fixes missed.
    // PageTransition animates this page with translate3d, and a
    // transformed ancestor becomes the containing block for `fixed`
    // children, so `fixed inset-0` was covering the PAGE box, not the
    // screen: hence a card that sat low and a backdrop that stopped
    // short of the tab bar. Portalling out of that subtree makes
    // `fixed` mean the viewport again, so centring is genuinely
    // screen-centred and the modal covers the whole app. Same trick
    // LocationStarMenu and RoutePlanner already use here.
    // Centred rather than offset (Shane 2026-07-19: "can it be a modal
    // screen instead, centred on the screen"): centring needs no
    // measurement, so it cannot be wrong by a magic number the way the
    // two previous attempts were. Centred in the house modal band (build
    // 124): below the status bar, clear of the tab bar, the list scrolling
    // inside the card when a season of routes outgrows it.
    createPortal(
        <div
            role="presentation"
            data-follow-sheet-overlay
            className="fixed inset-0 z-10055 flex items-center justify-center bg-black/60 px-3 pt-[max(1rem,env(safe-area-inset-top))] pb-[calc(4rem+env(safe-area-inset-bottom)+1rem)]"
            onClick={dismissFollowPrompt}
        >
            <div
                ref={followPromptDialogRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby="follow-route-prompt-title"
                aria-describedby="follow-route-prompt-description"
                className="flex max-h-full w-full max-w-md flex-col overflow-hidden rounded-3xl border border-white/10 bg-slate-900 shadow-2xl"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="shrink-0 border-b border-white/10 px-5 py-4">
                    <div
                        id="follow-route-prompt-title"
                        className="text-sm font-black uppercase tracking-widest text-emerald-300"
                    >
                        Following a route?
                    </div>
                    <div id="follow-route-prompt-description" className="mt-0.5 text-[12px] text-gray-400">
                        Pick one to show on your public page — or just record the track.
                    </div>
                </div>
                {followNotice && (
                    <div
                        role="alert"
                        className="mx-3 mt-3 flex items-start gap-2.5 rounded-xl border border-amber-500/25 bg-amber-500/8 px-3 py-2.5"
                    >
                        <span aria-hidden="true" className="mt-px text-[13px] leading-none text-amber-300">
                            {'\u26A0\uFE0F'}
                        </span>
                        <p className="flex-1 text-[12px] leading-relaxed text-amber-100">{followNotice}</p>
                        <button
                            type="button"
                            aria-label="Dismiss"
                            onClick={() => setFollowNotice(null)}
                            className="hit-target-44 -mr-1 -mt-1 shrink-0 rounded-lg px-2 py-1 text-[13px] leading-none text-amber-200/60 active:scale-95 hover:text-amber-100"
                        >
                            {'\u00D7'}
                        </button>
                    </div>
                )}
                <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-3 py-3">
                    {followPromptRows.map((item) => {
                        if (item.type === 'passage') {
                            return (
                                <SavedRoutePassageHeading
                                    key={item.key}
                                    row={{
                                        id: item.key,
                                        name: item.name,
                                        detail: null,
                                        kind: 'passage',
                                        groupKey: item.key,
                                        stamp: 0,
                                    }}
                                />
                            );
                        }
                        if (item.type === 'missing-leg') {
                            // A leg the Plan page knows and the log does not (Shane
                            // 2026-09-08). Named in its place, disabled, fix one tap away.
                            return (
                                <div
                                    key={item.key}
                                    data-testid="follow-missing-leg"
                                    className="rounded-xl border border-dashed border-amber-400/25 bg-amber-500/5 px-3 py-2.5"
                                >
                                    <div className="flex items-center gap-2">
                                        <span aria-hidden="true" className="text-amber-300/70">
                                            ↳
                                        </span>
                                        <p className="min-w-0 flex-1 truncate text-[13px] font-bold text-white/90">
                                            {item.leg.name}{' '}
                                            <span className="font-black text-white/60">
                                                ({ordinalLegLabel(item.leg.legOrdinal)})
                                            </span>
                                        </p>
                                    </div>
                                    <p className="mt-1 text-[11px] leading-snug text-amber-200/90">
                                        Not in the log yet — this leg is saved in Route Tracer only.
                                    </p>
                                    <button
                                        type="button"
                                        onClick={() => void openRouteInTracer(item.leg.savedRouteId)}
                                        className="mt-1 text-[11px] font-black uppercase tracking-wider text-sky-300 underline-offset-2 hover:underline"
                                    >
                                        Open it in Route Tracer and save it →
                                    </button>
                                </div>
                            );
                        }
                        const { summary: s, reversible, savedRouteId } = item.row.choice;
                        const check = savedRouteId ? checkStates.get(savedRouteId) : undefined;
                        // A check that passed but could not be stored says so
                        // — the row must not silently stay amber (build 124).
                        const followStatus =
                            check?.phase === 'done' && check.result === 'storage' && item.row.choice.followStatus
                                ? { ...item.row.choice.followStatus, reason: TRACE_CHECK_STORAGE_FULL }
                                : item.row.choice.followStatus;
                        return (
                            <FollowRouteChoice
                                key={item.key}
                                summary={s}
                                isLeg={item.row.kind === 'leg'}
                                savedName={item.row.choice.legName}
                                legBadge={
                                    item.row.kind === 'leg' && item.row.legOrdinal
                                        ? `(${ordinalLegLabel(item.row.legOrdinal)})`
                                        : undefined
                                }
                                reversible={reversible}
                                followStatus={followStatus}
                                // Queued counts as in hand: the row says it is
                                // waiting (Route Tracer open, another route
                                // first) and offers Stop, not a dead Check now.
                                checking={check?.phase === 'checking' || check?.phase === 'queued'}
                                checkingLabel={
                                    check?.phase === 'checking'
                                        ? check.total > 1
                                            ? `Checking… ${check.done} of ${check.total}`
                                            : 'Checking…'
                                        : check?.phase === 'queued'
                                          ? 'Waiting to check…'
                                          : undefined
                                }
                                onCheckNow={savedRouteId ? () => onCheckNow(savedRouteId) : undefined}
                                onStopCheck={savedRouteId ? () => onStopCheck(savedRouteId) : undefined}
                                onReview={
                                    savedRouteId && canReview(savedRouteId) ? () => onReview(savedRouteId) : undefined
                                }
                                onFixInTracer={savedRouteId ? () => void openRouteInTracer(savedRouteId) : undefined}
                                loading={
                                    followPromptLoadingId === s.voyageId ||
                                    (fetchingRouteId !== null && fetchingRouteId === savedRouteId)
                                }
                                disabled={followPromptLoadingId !== null}
                                onPick={(acceptFinding) => {
                                    const actionScope = identityScope;
                                    if (!isAuthIdentityScopeCurrent(actionScope)) return;
                                    if (acceptFinding === true) acceptFindingFor(s.voyageId);
                                    if (preStartSheetOpen) {
                                        // Answer parked; tracking starts NOW and the
                                        // cast-off effect follows this route the moment
                                        // the voyage id is real.
                                        preStartAnswerRef.current = s;
                                        setPreStartSheetOpen(false);
                                        startTrackingVerifiedRef.current();
                                        return;
                                    }
                                    void applyFollowPick(s, followPromptVoyageId).catch((error) => {
                                        if (isAuthIdentityScopeCurrent(actionScope)) {
                                            log.warn('Could not start followed route:', error);
                                            const message =
                                                error instanceof Error &&
                                                error.message.startsWith(TRACE_ROUTE_USE_BLOCK_PREFIX)
                                                    ? error.message.slice(TRACE_ROUTE_USE_BLOCK_PREFIX.length)
                                                    : 'Couldn’t load this saved route — please try again';
                                            setFollowNotice(message);
                                            setFollowPromptLoadingId(null);
                                        }
                                    });
                                }}
                            />
                        );
                    })}
                </div>
                <div className="shrink-0 border-t border-white/10 px-5 py-3">
                    <button
                        ref={followPromptDismissRef}
                        onClick={dismissFollowPrompt}
                        disabled={followPromptLoadingId !== null}
                        className="w-full min-h-[44px] rounded-xl bg-white/10 py-2.5 text-[12px] font-black uppercase tracking-widest text-gray-300 active:scale-95 disabled:cursor-wait disabled:opacity-50"
                    >
                        {followPromptLoadingId ? 'Loading route…' : 'Just recording'}
                    </button>
                </div>
            </div>
        </div>,
        document.body,
    );
