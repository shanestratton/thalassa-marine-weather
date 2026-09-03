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
import { FollowRouteChoice } from './LogSubComponents';
import { TRACE_ROUTE_USE_BLOCK_PREFIX, type FollowPromptRow } from './logPageTypes';

const log = createLogger('LogPage');

export const FollowRoutePromptSheet: React.FC<{
    dismissFollowPrompt: () => void;
    followPromptDialogRef: React.RefObject<HTMLDivElement>;
    followPromptDismissRef: React.RefObject<HTMLButtonElement>;
    followBlockNotice: string | null;
    setFollowBlockNotice: React.Dispatch<React.SetStateAction<string | null>>;
    followPromptRows: FollowPromptRow[];
    needsTracerRoutes: ReadonlySet<string>;
    openRouteInTracer: (savedRouteId: string | null) => Promise<void>;
    recheckRoute: (savedRouteId: string) => Promise<void>;
    recheckProgress: string | null;
    recheckingRouteId: string | null;
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
    followBlockNotice,
    setFollowBlockNotice,
    followPromptRows,
    needsTracerRoutes,
    openRouteInTracer,
    recheckRoute,
    recheckProgress,
    recheckingRouteId,
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
    // two previous attempts were.
    createPortal(
        <div
            role="presentation"
            className="fixed inset-0 z-10055 flex items-center justify-center bg-black/60 px-3 py-[max(1rem,env(safe-area-inset-bottom))]"
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
                {followBlockNotice && (
                    <div
                        role="alert"
                        className="mx-3 mt-3 flex items-start gap-2.5 rounded-xl border border-amber-500/25 bg-amber-500/8 px-3 py-2.5"
                    >
                        <span aria-hidden="true" className="mt-px text-[13px] leading-none text-amber-300">
                            {'\u26A0\uFE0F'}
                        </span>
                        <p className="flex-1 text-[12px] leading-relaxed text-amber-100">{followBlockNotice}</p>
                        <button
                            type="button"
                            aria-label="Dismiss"
                            onClick={() => setFollowBlockNotice(null)}
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
                        const { summary: s, reversible, blockReason, savedRouteId } = item.row.choice;
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
                                blockReason={blockReason}
                                onCheckRoute={() => {
                                    if (!savedRouteId) return;
                                    // Second tap on a route the check
                                    // could not decide alone goes to
                                    // the tracer; the first tries here.
                                    if (needsTracerRoutes.has(savedRouteId)) {
                                        void openRouteInTracer(savedRouteId);
                                    } else {
                                        void recheckRoute(savedRouteId);
                                    }
                                }}
                                checkLabel={
                                    savedRouteId && needsTracerRoutes.has(savedRouteId)
                                        ? 'Tap to open it in Route Tracer →'
                                        : 'Tap to check this route now →'
                                }
                                checkingLabel={recheckProgress ?? undefined}
                                checking={recheckingRouteId !== null && recheckingRouteId === savedRouteId}
                                loading={followPromptLoadingId === s.voyageId}
                                disabled={followPromptLoadingId !== null}
                                onPick={() => {
                                    const actionScope = identityScope;
                                    if (!isAuthIdentityScopeCurrent(actionScope)) return;
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
                                            setFollowBlockNotice(message);
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
