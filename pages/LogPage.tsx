/**
 * @filesize-justified Page orchestrator with shared state across list/detail/export views. Sub-views share 10+ state variables.
 */
/**
 * Log Page - Ship's GPS-based Log
 *
 * Pure rendering shell — all state management lives in useLogPageState hook.
 * This file is ONLY responsible for JSX layout.
 */

import { createPortal } from 'react-dom';
import React, { useState, useEffect, useRef, useCallback, useSyncExternalStore } from 'react';
import { Preferences } from '@capacitor/preferences';
import { createLogger } from '../utils/createLogger';
import { triggerHaptic } from '../utils/system';

const log = createLogger('LogPage');
import { PlayIcon, StopIcon, MapPinIcon } from '../components/Icons';
import { TraceReportModal } from '../components/map/TraceReportModal';
import { AddEntryModal } from '../components/AddEntryModal';
import { useToast } from '../components/Toast';
import { SlideToAction } from '../components/ui/SlideToAction';
import { followCastOffRoute } from '../services/shiplog/followCastOffRoute';
import {
    clearCastOffHandoff,
    peekCastOffHandoff,
    startHandoffGps,
    subscribeCastOffHandoff,
    updateCastOffHandoff,
} from '../services/castOffHandoff';
import { VoyageStatsPanel } from '../components/VoyageStatsPanel';
import { EditEntryModal } from '../components/EditEntryModal';
import { TrackMapViewer } from '../components/TrackMapViewer';
import { LiveMiniMap } from '../components/LiveMiniMap';
import { DeleteVoyageModal } from '../components/DeleteVoyageModal';
import { CommunityTrackBrowser } from '../components/CommunityTrackBrowser';

import { UndoToast } from '../components/ui/UndoToast';
import { EmptyTrackRemovedModal } from '../components/ui/EmptyTrackRemovedModal';
import { useGpsHealth, gpsHealthMessage, openDeviceSettings } from '../hooks/useGpsHealth';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { PageHeader } from '../components/ui/PageHeader';
import { OverlayPortal } from '../components/ui/OverlayPortal';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { useLogPageState } from '../hooks/useLogPageState';
import { useFollowRouteStore } from '../stores/followRouteStore';
import { useUI } from '../context/UIContext';
import { ShipLogEntry } from '../types';

import { reverseGeocode } from '../services/weatherService';
import { reverseGeocodeContext } from '../services/weather/api/geocoding';
import {
    computePersonalRecords,
    matchPlannedRouteByCoords,
    type VoyageSummary,
} from '../services/shiplog/VoyageSummary';
import { voyageHasRecordedFix } from '../services/shiplog/helpers';
import { evaluatePropulsionConflict } from '../services/shiplog/propulsion';
import { ShipLogService } from '../services/ShipLogService';
import { acquireFreshOwnshipPosition, resolveOwnshipPosition } from '../services/ownshipPosition';
import { NmeaStore } from '../services/NmeaStore';
import { LocationStore } from '../stores/LocationStore';
import { VoyageLogService } from '../services/VoyageLogService';
import { collapseReversedRoutes } from '../services/shiplog/collapseReversedRoutes';
import { fetchVoyageAsTrack, groupByVoyage } from '../services/shiplog/RoutesAndTracks';
import { requestTracerOpen } from '../services/deepLink';
import { useUIStore } from '../stores/uiStore';
import { buildFollowRoutePlanFromRoute } from '../services/shiplog/followRoutePlan';
import { excludeSuggestedRoutes } from '../utils/voyageStats';
import { VoyageCard, StatBox, MenuBtn, FollowRouteChoice } from './log/LogSubComponents';
import { formatEndpointCoordinates } from './log/useEndpointNames';
import { VoyageChoiceDialog, StopVoyageDialog } from './log/VoyageDialogs';
import { ExportSheet } from './log/ExportSheet';
import { GpsDisclaimerModal } from './log/GpsDisclaimerModal';
import { SkipperClaimNotice } from './log/SkipperClaimNotice';
import { ImportSheet } from './log/ImportSheet';
import { ShareSheet } from './log/ShareSheet';
import { ShareFormSheet } from './log/ShareFormSheet';
import { StatsSheet } from './log/StatsSheet';
import { publishFollowedRoute, clearFollowedRoute } from '../services/shiplog/publishFollowedRoute';
import {
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
    type AuthIdentityScope,
} from '../services/authIdentityScope';
import type { RouteCoordinate } from '../utils/routeCoordinates';
import { FEATURE_VISIBILITY } from '../utils/featureVisibility';
import {
    tracedRouteDirectUseBlockReason,
    tracedRouteFollowGeometry,
    localTraceLinkByVoyageId,
    savedTraceFollowBlockReason,
    tripIdentityByTraceId,
} from '../services/traceDirectUseGate';
import { orderSavedRouteRows } from '../services/savedRouteOrder';
import { ordinalLegLabel } from '../services/routeTracer';
import { SavedRoutePassageHeading } from '../components/routes/SavedRouteRows';

const NO_FOLLOWED_ROUTE: readonly RouteCoordinate[] = [];
const FOLLOW_ROUTE_HYDRATION_TIMEOUT_MS = 10_000;
const TRACE_ROUTE_USE_BLOCK_PREFIX = 'TRACE_ROUTE_USE_BLOCKED:';
const SYSTEM_LOG_ENDPOINT_NAMES = new Set(['Voyage Start', 'Voyage End', 'Latest Position']);

type TrackingStartFailure = {
    kind: 'permission' | 'services-off' | 'no-provider' | 'no-fix';
    title: string;
    detail: string;
    actionable: boolean;
};

/** A human-entered waypoint wins; recorder placeholders do not name a place. */
function meaningfulLogEndpointName(entry: Pick<ShipLogEntry, 'waypointName'> | undefined): string | null {
    const name = entry?.waypointName?.trim();
    return name && !SYSTEM_LOG_ENDPOINT_NAMES.has(name) ? name : null;
}

/** Do not trap the cast-off sheet behind an unbounded marine-data request.
 *  Late fulfilments are consumed but ignored, so they cannot resurrect a
 *  selection after the UI has unlocked. */
function withFollowRouteLoadDeadline<T>(promise: Promise<T>): Promise<T | null> {
    return new Promise<T | null>((resolve, reject) => {
        let settled = false;
        const timer = window.setTimeout(() => {
            settled = true;
            resolve(null);
        }, FOLLOW_ROUTE_HYDRATION_TIMEOUT_MS);
        promise.then(
            (value) => {
                if (settled) return;
                settled = true;
                window.clearTimeout(timer);
                resolve(value);
            },
            (error) => {
                if (settled) return;
                settled = true;
                window.clearTimeout(timer);
                reject(error);
            },
        );
    });
}

// Inline icons not in Icons.tsx
const PlusIcon = ({ className }: { className?: string }) => (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
    </svg>
);

const _AnchorIcon = ({ className }: { className?: string }) => (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
    </svg>
);

const subscribeIdentitySnapshot = (notify: () => void): (() => void) => subscribeAuthIdentityScope(() => notify());
const getIdentitySnapshot = (): AuthIdentityScope => getAuthIdentityScope();

/**
 * ANSWER-keyed guards for the cast-off "Following a route?" sheet — MODULE
 * scope, not refs ([[lesson_session_guards_module_scope]]): the page unmounts
 * on every tab-bounce and instance guards let the sheet re-prompt mid-voyage,
 * where dismissing it killed the cockpit route line.
 *
 * Keyed on the ANSWER, not on having shown the sheet (hardening 2026-08-01):
 * marking at show time meant an unmount without an answer — deep link,
 * notification tap — forfeited the question for the whole voyage. Now an
 * unanswered sheet legitimately re-asks on the next visit; an answered one
 * stays suppressed.
 *
 * `confirmedFollowVoyages` — the skipper PICKED a route (via the sheet's own
 * pick, the link-changed event another door dispatches, or inferred from a
 * follow that started after cast-off). Dismissal must never undo these.
 * `dismissedFollowVoyages` — the skipper explicitly chose "Just recording".
 */
const confirmedFollowVoyages = new Set<string>();
/** voyageId → when this device started waiting for its first fix. Module
 *  scope so the clock survives the tab-bounce that unmounts this page. */
const acquiringSince = new Map<string, number>();
const dismissedFollowVoyages = new Set<string>();

/**
 * Same module-scope pattern for the two page-local view toggles that were
 * resetting on every tab-bounce ("I literally have to start all over again",
 * Shane mid-voyage 2026-08-01). The reducer-owned view state has its own memo
 * in useLogPageState; these two live here because they never joined the
 * reducer. Cleared on identity change alongside the prompt guards.
 */
let liveMapExpandedMemo = false;
let showArchivedMemo = false;

/** Test-only: the guards outlive component instances BY DESIGN, which also
 *  makes them outlive test cases — each spec must start unprompted. */
export function resetFollowPromptGuardsForTest(): void {
    confirmedFollowVoyages.clear();
    dismissedFollowVoyages.clear();
    liveMapExpandedMemo = false;
    showArchivedMemo = false;
}

export const LogPage: React.FC<{ onBack?: () => void }> = ({ onBack }) => {
    const identityScope = useSyncExternalStore(subscribeIdentitySnapshot, getIdentitySnapshot, getIdentitySnapshot);

    // Cast Off handoff — Passage Planning's Cast Off lands here immediately
    // and this page owns the honest GPS starting/failed state plus the
    // starting/failed state (Shane 2026-08-26: "act as though we went through
    // that page"). Cleared automatically once GPS is confirmed.
    //
    // The route-check heads-up that used to render here is gone (Shane
    // 2026-08-30: "not necessary"). castOff() still computes its caution and
    // returns it, so restoring the surface is a display change rather than a
    // rewrite -- but nothing carries it into the handoff now, and it must stay
    // out of the auto-clear gate below: a caution with no way to acknowledge it
    // would pin the handoff open forever.
    const castOffHandoff = useSyncExternalStore(subscribeCastOffHandoff, peekCastOffHandoff, peekCastOffHandoff);
    useEffect(() => {
        if (
            castOffHandoff &&
            castOffHandoff.gps === 'confirmed' &&
            !castOffHandoff.followNote &&
            castOffHandoff.publishState !== 'skipped' &&
            castOffHandoff.publishState !== 'failed' &&
            castOffHandoff.publishState !== 'queued'
        ) {
            clearCastOffHandoff();
        }
    }, [castOffHandoff]);
    const [pageStateScope, setPageStateScope] = useState(identityScope);
    const previousIdentityScopeRef = useRef(identityScope);
    const pageBelongsToCurrentIdentity =
        pageStateScope.key === identityScope.key &&
        pageStateScope.generation === identityScope.generation &&
        isAuthIdentityScopeCurrent(pageStateScope);
    // Navigation helper was used by the old Diary kebab item;
    // Diary now has its own tile in the Vessel-tab → Sharing section
    // (2026-05-17). The destructure stays as a `_` placeholder so
    // useUI() is still called — keeps the hook's effect/subscription
    // semantics if other code starts depending on it.

    const { setPage: _setPage } = useUI();
    const {
        state,
        dispatch,
        settings: _settings,
        // Tracking
        handleStartTracking,
        startTrackingWithNewVoyage,
        continueLastVoyage,

        // handleToggleRapidMode + handleTogglePrecisionMode no longer
        // destructured 2026-05-17 — both kebab menu items removed when
        // Precision Mode became the always-on tracking pipeline. The
        // hook still exposes them for future paywall gating.
        handleStopTracking,
        confirmStopVoyage,
        // Entry CRUD
        handleDeleteEntry,
        handleUndoDeleteEntry,
        handleDismissDeleteEntry,
        deletedEntry,
        handleEditEntry,
        handleSaveEdit,
        loadData,
        // Voyage management
        toggleVoyage,
        handleDeleteVoyageRequest,
        handleConfirmDeleteVoyage,
        deletedVoyage,
        handleUndoDeleteVoyage,
        handleDismissDeleteVoyage,
        showSharedVoyageWarning,
        confirmDeleteSharedVoyage,
        cancelDeleteSharedVoyage,
        // Export / share
        handleExportCSV: _handleExportCSV,
        handleShare,
        handleExportThenDelete,
        handleExportGPX,
        handleImportGPXFile,
        handleShareToCommunity,
        // Derived state
        filteredEntries,
        groupedEntries: _groupedEntries,
        entryCounts: _entryCounts,
        listVoyages,
        voyageStats,
        loadVoyageEntries,
        loadAllEntries,
        hasNonDeviceEntries,
        totalDistance: _totalDistance,
        avgSpeed: _avgSpeed,
        // Archive
        archivedVoyages,
        handleArchiveVoyage,
        handleUnarchiveVoyage,
        // Empty-track tidy announcement
        emptyPruneNotice,
        clearEmptyPruneNotice,
    } = useLogPageState();

    // One automatic retry per handed-off voyage: an app death right after
    // Cast Off restores the handoff as 'failed' — start GPS again without
    // making the skipper find a button first. A second failure keeps the
    // amber Retry card, which remains the manual path.
    const handoffAutoRetryRef = useRef<string | null>(null);
    useEffect(() => {
        if (!castOffHandoff || castOffHandoff.gps !== 'failed' || state.isTracking) return;
        if (handoffAutoRetryRef.current === castOffHandoff.voyageId) return;
        handoffAutoRetryRef.current = castOffHandoff.voyageId;
        void startHandoffGps(true);
    }, [castOffHandoff, state.isTracking]);

    // ── THE AUTHORITY on "which route?": the active voyage itself ──
    // Voyages only ever become active through Cast Off, and a cast-off
    // passage IS its route (Shane 2026-08-26: "it must know what route we
    // are doing"). Handoffs are session conveniences that can die with the
    // process; the voyages table does not. While an active voyage exists,
    // the follow question is answered by construction — and the route line
    // arms itself from that voyage when it is not already up.
    const [activeCastOffVoyage, setActiveCastOffVoyage] = useState<{
        id: string;
        voyage_name: string;
        saved_route_id?: string | null;
    } | null>(null);
    useEffect(() => {
        let cancelled = false;
        if (!state.isTracking) {
            setActiveCastOffVoyage(null);
            return;
        }
        void (async () => {
            try {
                const { getActiveVoyage } = await import('../services/VoyageService');
                const active = await getActiveVoyage();
                if (!cancelled) setActiveCastOffVoyage(active);
            } catch {
                if (!cancelled) setActiveCastOffVoyage(null);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [state.isTracking, state.currentVoyageId]);

    // A publish recorded 'skipped' or 'failed' earlier is not a verdict —
    // the mirror may exist NOW (a fresh re-save, or the Plan page's repair
    // pass ran since). One re-attempt per page visit, while tracking.
    const publishRetryRef = useRef<string | null>(null);
    useEffect(() => {
        if (!castOffHandoff || !state.isTracking) return;
        if (castOffHandoff.publishState !== 'skipped' && castOffHandoff.publishState !== 'failed') return;
        if (publishRetryRef.current === castOffHandoff.voyageId) return;
        publishRetryRef.current = castOffHandoff.voyageId;
        void (async () => {
            const { retryPublicPublish } = await import('../services/castOffHandoff');
            await retryPublicPublish();
        })();
    }, [castOffHandoff, state.isTracking]);

    const activeFollowArmRef = useRef<string | null>(null);
    useEffect(() => {
        if (!activeCastOffVoyage) return;
        const vid = state.currentVoyageId;
        // The active row is the route authority for ITS OWN voyage only. A
        // casual "voyage_…" track running beside a (possibly stale) active
        // row must keep its route question — answering it from a different
        // voyage's row silently killed the Log-page publish for anyone
        // carrying a stuck-active passage (Shane 2026-08-27: "if you just
        // use the log from the log page… it no longer shows up on your
        // public page").
        if (!vid || vid !== activeCastOffVoyage.id) return;
        confirmedFollowVoyages.add(vid);
        // Close the sheet if it opened before the voyage row loaded.
        setFollowPromptVoyageId((open) => (open === vid ? null : open));
        // The auto-arm below is gated by the SAME id, and must be: arming a
        // stale passage's route while a casual track is recording put the
        // zombie's line on the cockpit AND published it against the casual
        // voyage — whose own route question then auto-answered itself off
        // the resulting plan-link event. That defeated the whole fix online.
        if (activeFollowArmRef.current === activeCastOffVoyage.id) return;
        activeFollowArmRef.current = activeCastOffVoyage.id;
        const follow = useFollowRouteStore.getState();
        if (!follow.isFollowing) {
            const publishPref = (() => {
                const handoff = peekCastOffHandoff();
                if (handoff?.voyageId === activeCastOffVoyage.id) return handoff.publishRoute;
                try {
                    return localStorage.getItem('thalassa_castoff_publish_public') !== '0';
                } catch {
                    return true;
                }
            })();
            void followCastOffRoute(
                activeCastOffVoyage.id,
                activeCastOffVoyage.saved_route_id ?? null,
                publishPref,
                activeCastOffVoyage.voyage_name,
            ).then((reason) => {
                if (reason) updateCastOffHandoff({ followNote: reason });
            });
        }
    }, [activeCastOffVoyage, state.currentVoyageId]);

    const toast = useToast();

    // ── Cast-off "Follow a route?" prompt (Shane 2026-07-17) ──
    // When a fresh voyage starts and the skipper has suggested routes saved,
    // ask which (if any) to broadcast on the public page. Publishing is tied
    // to the active voyage (setVoyagePlanLink); "Just recording" skips it.
    const [followPromptVoyageId, setFollowPromptVoyageId] = React.useState<string | null>(null);
    const [followPromptLoadingId, setFollowPromptLoadingId] = React.useState<string | null>(null);
    /**
     * Which blocked row is fetching its waypoints from the account.
     *
     * Deliberately NOT followPromptLoadingId: that one disables every row, the
     * "Just recording" footer AND the escape from the sheet, so borrowing it
     * would trap the skipper inside the picker at cast-off for as long as a
     * network fetch took. This gates one row's button and nothing else.
     */
    const [recheckingRouteId, setRecheckingRouteId] = React.useState<string | null>(null);
    /** "Checking 6 of 18…" — a cold recheck can run tens of seconds. */
    const [recheckProgress, setRecheckProgress] = React.useState<string | null>(null);
    /**
     * Routes whose automatic recheck came back needing a human — a danger leg,
     * or a land crossing. Tapping those again opens Route Tracer instead of
     * re-running a check that has already said it cannot decide this alone.
     */
    const [needsTracerRoutes, setNeedsTracerRoutes] = React.useState<ReadonlySet<string>>(() => new Set());
    /**
     * The route report, shown right here at cast-off so a skipper can
     * acknowledge no-go legs without a round trip to Route Tracer. Holds the
     * grading the recheck already did — the check is never re-run for this.
     */
    const [ackReport, setAckReport] = React.useState<{
        savedRouteId: string;
        name: string;
        points: Array<{ lat: number; lon: number }>;
        report: import('../services/traceRecheck').RecheckReport;
        priorDepartureMs: number | null;
    } | null>(null);
    const [ackedLegs, setAckedLegs] = React.useState<ReadonlySet<number>>(() => new Set());
    /** PRE-START mode (Shane 2026-08-10: "it starts to track, and THEN it
     *  asks?? tidy this up"): the sheet now opens the moment Start Tracking
     *  is slid, before the voyage exists. The answer parks here and the
     *  cast-off effect applies it once the voyage id is real. */
    const preStartAnswerRef = React.useRef<VoyageSummary | 'none' | null>(null);
    const [preStartSheetOpen, setPreStartSheetOpen] = React.useState(false);
    /** The GPS-verified start action, assigned each render once the handlers
     *  exist below — the sheet's pre-start answers fire it without caring
     *  about declaration order. */
    const startTrackingVerifiedRef = React.useRef<() => void>(() => {});
    /** Snapshot of the sheet's routes taken when it OPENS — the live list
     *  reshuffles as entries land and the ⇄ fold re-picks direction, which
     *  flipped rows under the skipper's thumb (hardening 2026-08-01). Each
     *  row carries the follow gate's verdict: null = pickable, a string =
     *  shown disabled with that reason. */
    const [followPromptChoices, setFollowPromptChoices] = React.useState<
        (ReturnType<typeof collapseReversedRoutes<VoyageSummary>>[number] & {
            savedRouteId: string | null;
            blockReason: string | null;
            /** Trip grouping, so this sheet can wear the Plan page's layout —
             *  passages first with their legs beneath. Absent on a day sail. */
            tripId?: string;
            legOrdinal?: number;
            tripName?: string;
            legName?: string;
        })[]
    >([]);
    /**
     * The sheet's running order: passages first with their legs beneath, day
     * sails after, newest group first — the same arithmetic the Plan page and
     * Passage Planning use, from services/savedRouteOrder.
     *
     * A heading is emitted when a group's first leg appears. Legs whose trip
     * has no name resolved were already demoted to standalone upstream, so a
     * dog-leg arrow can never sit under nothing.
     */
    const followPromptRows = React.useMemo(() => {
        const ordered = orderSavedRouteRows(
            followPromptChoices.map((choice) => ({
                choice,
                kind: choice.tripName ? ('leg' as const) : ('standalone' as const),
                groupKey: choice.tripId ?? choice.summary.voyageId,
                legOrdinal: choice.legOrdinal,
                stamp: Date.parse(choice.summary.startedAt) || 0,
            })),
        );
        const rows: Array<
            | { type: 'passage'; key: string; name: string }
            | { type: 'choice'; key: string; row: (typeof ordered)[number] }
        > = [];
        let openGroup: string | null = null;
        for (const row of ordered) {
            if (row.kind === 'leg' && row.groupKey !== openGroup) {
                rows.push({ type: 'passage', key: `passage:${row.groupKey}`, name: row.choice.tripName as string });
            }
            openGroup = row.groupKey;
            rows.push({ type: 'choice', key: row.choice.summary.voyageId, row });
        }
        return rows;
    }, [followPromptChoices]);

    const followSelectionGenerationRef = React.useRef(0);
    /** One-shot guard for the pre-open "is this voyage already linked?"
     *  server check — instance-scoped ON PURPOSE (unlike the module Sets):
     *  an unmount mid-question re-asks, so a remount must re-check too. */
    const followLinkPrecheckRef = React.useRef<string | null>(null);
    const followPromptDismissRef = React.useRef<HTMLButtonElement>(null);
    /** Why the last follow attempt was refused, shown INSIDE the sheet.
     *  Was a toast (Shane 2026-08-07: "i literally hate toast messages"), which
     *  is the wrong surface for this: the sheet is still open, the message is
     *  two lines of chart-safety reasoning, and a toast slides away while the
     *  skipper is still reading the row it refers to. */
    const [followBlockNotice, setFollowBlockNotice] = React.useState<string | null>(null);

    const dismissFollowPrompt = React.useCallback(() => {
        if (followPromptLoadingId !== null) return;
        if (!isAuthIdentityScopeCurrent(identityScope)) return;
        // PRE-START mode: the skipper slid Start Tracking and is being asked
        // BEFORE the voyage exists. Any dismissal is "Just recording" — the
        // slide already committed them to starting; the sheet only asks which
        // line to show. Tracking starts now; the cast-off effect records the
        // no-route answer once the voyage id is real.
        if (preStartSheetOpen) {
            preStartAnswerRef.current = 'none';
            setPreStartSheetOpen(false);
            startTrackingVerifiedRef.current();
            return;
        }
        // "Just recording" (including Escape/backdrop dismissal) is an
        // explicit no-route choice for this cast-off — recorded durably so the
        // sheet never re-asks this voyage, and applied to BOTH surfaces:
        // the local chart line AND the public link. The public half used to be
        // skipped, so a link row written seconds earlier by another door (in
        // that era, the since-removed DeparturePrompts suggestion banner) kept
        // showing punters a route the skipper just declined (hardening
        // 2026-08-01, finding D).
        //
        // UNLESS the skipper already PICKED a route for this voyage: then this
        // dismissal is just closing a re-shown sheet, and stopping the follow
        // or clearing the link would kill the choice they explicitly made.
        followSelectionGenerationRef.current += 1;
        const promptVid = followPromptVoyageId;
        const confirmed = promptVid !== null && confirmedFollowVoyages.has(promptVid);
        if (promptVid && !confirmed) dismissedFollowVoyages.add(promptVid);
        const follow = useFollowRouteStore.getState();
        if (follow.isFollowing && !confirmed) follow.stopFollowing();
        // Durable-intent clear: retried on reconnect, and a no-op when no link
        // row exists (the common case).
        if (!confirmed) void clearFollowedRoute();
        setFollowPromptVoyageId(null);
    }, [followPromptLoadingId, followPromptVoyageId, identityScope, preStartSheetOpen]);
    const followPromptDialogRef = useFocusTrap<HTMLDivElement>(followPromptVoyageId !== null || preStartSheetOpen, {
        initialFocusRef: followPromptDismissRef,
        onEscape: dismissFollowPrompt,
    });
    const plannedSummaries = React.useMemo(
        () => (state.summaries ?? []).filter((s) => s.isPlannedRoute && s.voyageId),
        [state.summaries],
    );
    // The Log is the factual record of where the boat has actually been.
    // Keep saved plans resident in the raw state — cast-off choices, followed
    // route geometry and planned-vs-sailed overlays still need them — but do
    // not present them as completed voyages. Check both summary classification
    // and entry source so offline-only plans (not yet in the summary RPC) are
    // excluded too.
    const plannedVoyageIds = React.useMemo(() => {
        const ids = new Set<string>();
        for (const summary of state.summaries ?? []) {
            if (summary.isPlannedRoute && summary.voyageId) ids.add(summary.voyageId);
        }
        for (const entry of state.entries) {
            if (entry.source === 'planned_route' && entry.voyageId) ids.add(entry.voyageId);
        }
        return ids;
    }, [state.entries, state.summaries]);
    const loggedVoyages = React.useMemo(
        () => listVoyages.filter((summary) => !summary.isPlannedRoute && !plannedVoyageIds.has(summary.voyageId)),
        [listVoyages, plannedVoyageIds],
    );
    const loggedEntries = React.useMemo(
        () =>
            state.entries.filter(
                (entry) =>
                    entry.source !== 'planned_route' && (!entry.voyageId || !plannedVoyageIds.has(entry.voyageId)),
            ),
        [plannedVoyageIds, state.entries],
    );
    const loggedFilteredEntries = React.useMemo(
        () =>
            filteredEntries.filter(
                (entry) =>
                    entry.source !== 'planned_route' && (!entry.voyageId || !plannedVoyageIds.has(entry.voyageId)),
            ),
        [filteredEntries, plannedVoyageIds],
    );
    const loggedArchivedVoyages = React.useMemo(() => excludeSuggestedRoutes(archivedVoyages), [archivedVoyages]);

    // Latest trustworthy fix of the voyage being recorded. Used only to choose
    // WHICH WAY ROUND to offer a there-and-back route (below) — same "ignore
    // 0,0" rule as hasRecordedFix, since a null-island fix would drag every
    // direction choice toward the Gulf of Guinea.
    /**
     * Where the boat is RIGHT NOW, from the live fix — synchronous, no network.
     * Seeds the live map's first viewport on a cold start, when the entries
     * that would otherwise frame it have not arrived yet. Deliberately not
     * `currentFix` below: that is derived from ENTRIES, so it is null at
     * exactly the moment this is needed.
     */
    const liveFix = React.useMemo(() => {
        try {
            const own = resolveOwnshipPosition(NmeaStore.getState(), LocationStore.getState());
            return own ? { lat: own.lat, lon: own.lon } : null;
        } catch {
            return null;
        }
        // Intentionally computed once per mount: it is a SEED for the first
        // viewport, not a tracker. The map follows the track after that.
    }, []);

    const currentFix = React.useMemo(() => {
        const vid = state.currentVoyageId;
        if (!vid) return null;
        for (let i = state.entries.length - 1; i >= 0; i--) {
            const e = state.entries[i];
            if (e.voyageId !== vid) continue;
            if (!e.latitude || !e.longitude) continue;
            if (e.latitude === 0 && e.longitude === 0) continue;
            return { lat: e.latitude, lon: e.longitude };
        }
        return null;
    }, [state.entries, state.currentVoyageId]);

    // One row per passage — the ⇄ reverse of a saved route is a separate
    // voyage, so the picker was listing every passage twice. Pure + tested in
    // collapseReversedRoutes (it can HIDE a route if wrong, which does not look
    // like a bug from the cockpit — it looks like a route you saved simply not
    // being offered).
    const plannedChoices = React.useMemo(
        () => collapseReversedRoutes(plannedSummaries, currentFix),
        [plannedSummaries, currentFix],
    );

    /** voyageId → savedRouteId, read off the resident plan entries (the link
     *  lives on entries, not summaries). */
    const plannedRouteLinkIds = React.useMemo(() => {
        const byVoyage = new Map<string, string>();
        for (const entry of state.entries) {
            if (!entry.voyageId || byVoyage.has(entry.voyageId)) continue;
            const sid = entry.savedRouteId;
            if (typeof sid === 'string' && sid.length > 0) byVoyage.set(entry.voyageId, sid);
        }
        return byVoyage;
    }, [state.entries]);

    /**
     * EVERY planned route reaches the sheet; ones the follow gate refuses
     * render disabled with the gate's reason on the row. This is the third
     * design in four days, so the history matters: pick-then-refuse (two
     * lines of chart-safety prose after choosing — Shane 2026-08-10: "just
     * show tracks that are ready to be followed"), then hide-the-blocked
     * (honest but a skipper whose routes all need re-checks saw NOTHING at
     * cast-off — Shane 2026-08-13: "the saved routes do not show up on the
     * startup screen to select one"). Visible-but-disabled is the synthesis:
     * the route is seen, the reason is named, and the fix (Route Tracer) is
     * one line away — without letting an unchecked line be steered.
     *
     * Two link sources, because entries may not be resident on a fresh boot:
     * the entry rows when loaded, else the local trace store's own
     * plannedRouteId mirror. An ordinary plan (no trace link) has no gate to
     * fail and is always pickable.
     */
    const followSheetChoices = React.useMemo(() => {
        const traceLinks = localTraceLinkByVoyageId();
        /* The sheet's rows are VoyageSummary, which carries no trip or leg
           identity — which is why this list was flat while the Plan page showed
           the same routes grouped. The trace store knows, and the row already
           resolves to a trace id, so the grouping costs one lookup and no
           guesswork (Shane 2026-08-30). */
        const trips = tripIdentityByTraceId();
        return plannedChoices.map((choice) => {
            const vid = choice.summary.voyageId;
            const sid = plannedRouteLinkIds.get(vid) ?? traceLinks.get(vid);
            const trip = sid ? trips.get(sid) : undefined;
            return {
                ...choice,
                savedRouteId: sid ?? null,
                blockReason: sid ? savedTraceFollowBlockReason(sid) : null,
                ...(trip ?? {}),
            };
        });
    }, [plannedChoices, plannedRouteLinkIds]);

    /**
     * Take a blocked row to the one screen that can clear its block.
     *
     * A refused route used to be a disabled row: visible, explained, and
     * completely inert (Shane 2026-08-13: "i cannot actually accept it. it has
     * no way of selecting"). The gate's refusals are all fixable — re-check the
     * line in Route Tracer — so the row should carry you there rather than
     * describe the problem and stop.
     */
    /**
     * Re-run the hazard check on a blocked route, in place.
     *
     * The row has always said "tap to check it in Route Tracer". Now the first
     * tap does the check itself — cold, against the current charts and the
     * skipper's real draft — and only sends them to the tracer when the answer
     * genuinely needs a person: a danger leg to acknowledge, or a land
     * crossing whose waypoints must be moved.
     *
     * A refusal is an answer, not a failure. The route stays blocked and the
     * reason is shown, which is what "warn — but not let us go" means.
     */
    const recheckRoute = React.useCallback(
        async (savedRouteId: string) => {
            const actionScope = identityScope;
            if (!isAuthIdentityScopeCurrent(actionScope)) return;
            setFollowBlockNotice(null);
            setRecheckingRouteId(savedRouteId);
            setRecheckProgress(null);
            try {
                const [{ loadSavedTraces, adoptServerRoute, saveTrace }, { fetchSavedRoutePoints }] = await Promise.all(
                    [import('../services/routeTracer'), import('../services/savedRoutePoints')],
                );
                if (!isAuthIdentityScopeCurrent(actionScope)) return;

                // The waypoints may only exist in the account — a second
                // device, or this one after a reinstall. Adopt them under the
                // same id first so the check attaches to the right route.
                let trace = loadSavedTraces().find((t) => t.id === savedRouteId);
                if (!trace || trace.points.length < 2) {
                    const fetched = await fetchSavedRoutePoints(savedRouteId);
                    if (!isAuthIdentityScopeCurrent(actionScope)) return;
                    if (!fetched.ok) {
                        setFollowBlockNotice(fetched.reason);
                        return;
                    }
                    trace = adoptServerRoute(fetched.id, fetched.name, fetched.points) ?? undefined;
                    if (!trace) {
                        setFollowBlockNotice('Could not store this route on this device.');
                        return;
                    }
                }

                const { recheckTrace } = await import('../services/traceRecheck');
                if (!isAuthIdentityScopeCurrent(actionScope)) return;
                const outcome = await recheckTrace(trace.points, {
                    priorVerification: trace.verification ?? null,
                    onProgress: (done, total) =>
                        setRecheckProgress(total > 1 ? `Checking ${done} of ${total}` : 'Checking'),
                });
                if (!isAuthIdentityScopeCurrent(actionScope)) return;

                if (!outcome.ok) {
                    // A refusal whose legs can be cleared by a person deciding
                    // is not a reason to send them somewhere else. Show the
                    // report here, with the grading that was just done.
                    if (outcome.report && outcome.report.ackableDangerLegs.length > 0) {
                        setAckedLegs(new Set());
                        setAckReport({
                            savedRouteId,
                            name: trace.name,
                            points: trace.points,
                            report: outcome.report,
                            priorDepartureMs: trace.verification?.departureMs ?? null,
                        });
                        return;
                    }
                    setFollowBlockNotice(outcome.reason);
                    if (outcome.needsTracer) {
                        setNeedsTracerRoutes((prev) => new Set(prev).add(savedRouteId));
                    }
                    return;
                }

                // Bank the freshly earned envelope against the same id.
                saveTrace(trace.name, trace.points, {
                    overwriteId: trace.id,
                    verification: outcome.verification,
                });
                setNeedsTracerRoutes((prev) => {
                    if (!prev.has(savedRouteId)) return prev;
                    const next = new Set(prev);
                    next.delete(savedRouteId);
                    return next;
                });

                // The sheet renders a SNAPSHOT taken when it opened, so a
                // successful recheck would otherwise leave the row looking
                // exactly as blocked as before. Recompute from the gate rather
                // than assuming null — a check can pass and the row still
                // block for a different reason.
                const { savedTraceFollowBlockReason } = await import('../services/traceDirectUseGate');
                if (!isAuthIdentityScopeCurrent(actionScope)) return;
                const reason = savedTraceFollowBlockReason(savedRouteId);
                setFollowPromptChoices((prev) =>
                    prev.map((choice) =>
                        choice.savedRouteId === savedRouteId ? { ...choice, blockReason: reason } : choice,
                    ),
                );
                if (reason) setFollowBlockNotice(reason);
            } catch (error) {
                log.warn('Route recheck failed:', error);
                setFollowBlockNotice('Could not check this route. Try again.');
            } finally {
                setRecheckingRouteId(null);
                setRecheckProgress(null);
            }
        },
        [identityScope],
    );

    /**
     * A leg was acknowledged on the report. Re-run the release GATE (pure and
     * cheap) — never the check itself, which already ran. The moment the gate
     * allows, bank the envelope and unblock the row.
     */
    const acknowledgeLeg = React.useCallback(
        (legIndex: number) => {
            if (!ackReport) return;
            const actionScope = identityScope;
            const nextAcks = new Set(ackedLegs).add(legIndex);
            setAckedLegs(nextAcks);
            void (async () => {
                const [{ releaseWithAcks }, { saveTrace }, { savedTraceFollowBlockReason }] = await Promise.all([
                    import('../services/traceRecheck'),
                    import('../services/routeTracer'),
                    import('../services/traceDirectUseGate'),
                ]);
                if (!isAuthIdentityScopeCurrent(actionScope)) return;
                const gate = releaseWithAcks(ackReport.points, ackReport.report, nextAcks, ackReport.priorDepartureMs);
                if (!gate.allowed || !gate.verification) return; // more legs to go
                saveTrace(ackReport.name, ackReport.points, {
                    overwriteId: ackReport.savedRouteId,
                    verification: gate.verification,
                });
                const reason = savedTraceFollowBlockReason(ackReport.savedRouteId);
                setFollowPromptChoices((prev) =>
                    prev.map((choice) =>
                        choice.savedRouteId === ackReport.savedRouteId ? { ...choice, blockReason: reason } : choice,
                    ),
                );
                setAckReport(null);
                setAckedLegs(new Set());
                setFollowBlockNotice(reason);
            })();
        },
        [ackReport, ackedLegs, identityScope],
    );

    const openRouteInTracer = React.useCallback(
        async (savedRouteId: string | null) => {
            const actionScope = identityScope;
            if (!isAuthIdentityScopeCurrent(actionScope)) return;

            // The tracer loads a saved route from localStorage, so on a second
            // device — or the same one after a reinstall — it opens to nothing
            // and does it SILENTLY (MapHub's load-saved branch has no else).
            // That is the closed loop behind "the route is blocked, and the fix
            // it offers cannot work either". The waypoints are in the account;
            // fetch them and adopt them under the SAME id first, so the tracer,
            // the follow link and the Cast Off gate all still agree on which
            // route this is.
            if (savedRouteId) {
                const [{ loadSavedTraces, adoptServerRoute }, { fetchSavedRoutePoints }] = await Promise.all([
                    import('../services/routeTracer'),
                    import('../services/savedRoutePoints'),
                ]);
                if (!isAuthIdentityScopeCurrent(actionScope)) return;
                const local = loadSavedTraces().find((t) => t.id === savedRouteId);
                if (!local || local.points.length < 2) {
                    setRecheckingRouteId(savedRouteId);
                    const fetched = await fetchSavedRoutePoints(savedRouteId);
                    setRecheckingRouteId(null);
                    if (!isAuthIdentityScopeCurrent(actionScope)) return;
                    if (!fetched.ok) {
                        // Stay put and say why. Navigating to a tracer that
                        // will open empty is how this dead-ended before.
                        setFollowBlockNotice(fetched.reason);
                        return;
                    }
                    if (!adoptServerRoute(fetched.id, fetched.name, fetched.points)) {
                        setFollowBlockNotice('Could not store this route on this device. Free up space and try again.');
                        return;
                    }
                }
            }

            setPreStartSheetOpen(false);
            setFollowPromptVoyageId(null);
            requestTracerOpen(savedRouteId ? { kind: 'load-saved', id: savedRouteId } : null, actionScope);
            useUIStore.getState().setPage('voyage');
        },
        [identityScope],
    );

    /**
     * Start local follow mode from recovered saved geometry. Resident entries
     * can start immediately; otherwise the caller remains in a visible loading
     * state while this fetches the voyage. Summary endpoints alone are not
     * drawn because a straight chord can cross land or shoals.
     */
    const followPlannedRouteLocally = React.useCallback(
        async (summary: VoyageSummary): Promise<boolean> => {
            const actionScope = identityScope;
            const voyageId = summary.voyageId;
            if (!voyageId || !isAuthIdentityScopeCurrent(actionScope)) return false;

            const selectionGeneration = ++followSelectionGenerationRef.current;
            const initialFollow = useFollowRouteStore.getState();
            const initialFingerprint = {
                isFollowing: initialFollow.isFollowing,
                voyageId: initialFollow.voyageId,
                startedAt: initialFollow.startedAt,
            };
            const residentEntries = state.entries.filter((entry) => entry.voyageId === voyageId);
            const residentRoute = groupByVoyage(residentEntries, new Set([voyageId])).find(
                (route) => route.id === voyageId,
            );
            try {
                const fetchedRoute = await withFollowRouteLoadDeadline(fetchVoyageAsTrack(voyageId));
                if (
                    selectionGeneration !== followSelectionGenerationRef.current ||
                    !isAuthIdentityScopeCurrent(actionScope)
                ) {
                    return false;
                }

                const current = useFollowRouteStore.getState();
                const expectedFollowStillCurrent =
                    current.isFollowing === initialFingerprint.isFollowing &&
                    current.voyageId === initialFingerprint.voyageId &&
                    current.startedAt === initialFingerprint.startedAt;
                if (!expectedFollowStillCurrent) return false;

                const logRoute = fetchedRoute ?? residentRoute;
                if (!logRoute) return false;
                // A trace-linked voyage steers the TRACE's waypoints, not the
                // line assembled from its log entries — those carry recorder
                // rows (Voyage Start / End, Latest Position) the tracer never
                // drew. One object from here on: verified, planned and
                // followed are the same geometry by construction, which is
                // what stops the check and the follow disagreeing.
                const steerRoute = tracedRouteFollowGeometry(logRoute);
                const traceBlock = tracedRouteDirectUseBlockReason(steerRoute);
                if (traceBlock) throw new Error(`${TRACE_ROUTE_USE_BLOCK_PREFIX}${traceBlock}`);
                const exactPlan = buildFollowRoutePlanFromRoute(steerRoute);
                if (!exactPlan) return false;
                current.startFollowing(exactPlan, voyageId, steerRoute.points);
                return true;
            } catch (error) {
                if (error instanceof Error && error.message.startsWith(TRACE_ROUTE_USE_BLOCK_PREFIX)) throw error;
                log.warn('Could not hydrate followed route geometry:', error);
                return false;
            }
        },
        [identityScope, state.entries],
    );

    /**
     * The one "follow this route" action — shared by the sheet's rows and by
     * the pre-start answer applied after cast-off. Starts local follow mode,
     * records the answer, then publishes the public-page link in the
     * background. Extracted from the row's inline handler so the pre-start
     * flow could not fork its behaviour (hardening 2026-08-10).
     */
    const applyFollowPick = React.useCallback(
        async (s: VoyageSummary, promptVid: string | null) => {
            const actionScope = identityScope;
            if (!isAuthIdentityScopeCurrent(actionScope)) return;
            // A new attempt supersedes the last refusal — never leave a stale
            // reason sitting above a different row.
            setFollowBlockNotice(null);
            setFollowPromptLoadingId(s.voyageId);
            try {
                const answered = () => {
                    // The question is answered — record it (dismissal must not
                    // undo it) and retire the banner NOW, not when the
                    // in-flight write lands.
                    if (promptVid) confirmedFollowVoyages.add(promptVid);
                    try {
                        window.dispatchEvent(
                            new CustomEvent('thalassa:voyage-plan-link-changed', {
                                detail: { voyageId: promptVid ?? undefined },
                            }),
                        );
                    } catch {
                        /* non-DOM host */
                    }
                    setFollowPromptLoadingId(null);
                    setFollowPromptVoyageId(null);
                };

                const started = await followPlannedRouteLocally(s);
                if (!isAuthIdentityScopeCurrent(actionScope)) return;

                if (started) {
                    // Verification and exact geometry are now known. Only at
                    // this point may either the cockpit or public page
                    // advertise the line; racing publication before this gate
                    // let a legacy unverified trace bypass MapHub.
                    const publishPromise = Promise.resolve(publishFollowedRoute(s.voyageId)).catch((error) => {
                        log.warn('publish followed route failed:', error);
                        return 'error' as const;
                    });
                    answered();
                    void publishPromise.then((result) => {
                        if (!isAuthIdentityScopeCurrent(actionScope)) return;
                        if (result === 'linked') {
                            toast.success('Your public page now follows this route');
                        } else if (result === 'queued') {
                            toast.info('Following — your public page will update when signal returns');
                        } else if (result === 'not-tracking') {
                            toast.info('Following locally — start tracking to update your public page');
                        } else {
                            toast.error('Following locally — couldn’t update your public page');
                        }
                    });
                    return;
                }
                setFollowBlockNotice('Couldn’t load this saved route — please try again');
            } finally {
                if (isAuthIdentityScopeCurrent(actionScope)) {
                    setFollowPromptLoadingId(null);
                }
            }
        },
        [identityScope, followPlannedRouteLocally, toast],
    );

    React.useEffect(() => {
        if (!isAuthIdentityScopeCurrent(identityScope)) return;
        const vid = state.currentVoyageId;
        if (!state.isTracking || !vid) return;

        // A pre-start answer IS the answer — apply it and never re-ask.
        const preAnswer = preStartAnswerRef.current;
        if (preAnswer) {
            preStartAnswerRef.current = null;
            if (preAnswer === 'none') {
                dismissedFollowVoyages.add(vid);
                void clearFollowedRoute();
            } else {
                confirmedFollowVoyages.add(vid);
                void applyFollowPick(preAnswer, vid).catch((error) => {
                    if (!isAuthIdentityScopeCurrent(identityScope)) return;
                    log.warn('Could not start pre-picked followed route:', error);
                    const message =
                        error instanceof Error && error.message.startsWith(TRACE_ROUTE_USE_BLOCK_PREFIX)
                            ? error.message.slice(TRACE_ROUTE_USE_BLOCK_PREFIX.length)
                            : // There is no such menu. This used to read "tap Menu →
                              // Follow a route to pick it again", naming a control
                              // that has never existed — grep finds the string and
                              // two comments, nothing else. Point at the door that
                              // is actually there: the picker reopens from Cast Off.
                              'Couldn’t load this saved route. Stop and cast off again to pick a route.';
                    // NOT a toast (Shane 2026-08-12: "i hate toast messages",
                    // and 2026-08-07 before that). Two lines of chart-safety
                    // reasoning need a surface that stays put: the same
                    // followBlockNotice the sheet uses renders as an inline
                    // card on the tracking view when the sheet is closed.
                    setFollowBlockNotice(message);
                });
            }
            return;
        }
        if (followPromptVoyageId !== null) return; // already open
        if (confirmedFollowVoyages.has(vid) || dismissedFollowVoyages.has(vid)) return; // answered
        // A cast-off passage already DECLARED its route — the handoff is the
        // answer to "which route?", whether or not the auto-follow managed
        // to arm the line (Shane 2026-08-26: "it asks you to pick a route,
        // but we already know what route we are doing. so that needs to
        // go"). Bound to the exact voyage id so a later casual slide-start
        // still gets its honest question.
        if (castOffHandoff && castOffHandoff.voyageId === vid) {
            confirmedFollowVoyages.add(vid);
            return;
        }
        // And the durable authority: the active voyage's question is
        // answered — voyages only become active through Cast Off, whose
        // passage is its route. Handoff lifecycles cannot be trusted across
        // app deaths; the voyages table can. But the row answers ONLY for
        // its own voyage id — a stale active row answering for a casual
        // "voyage_…" track suppressed every Log-page publish (Shane
        // 2026-08-27).
        if (activeCastOffVoyage && activeCastOffVoyage.id === vid) {
            confirmedFollowVoyages.add(vid);
            return;
        }
        if (followSheetChoices.length === 0) return; // no saved routes at all

        // The question may have been answered OUTSIDE this component — e.g.
        // the Settings retro-link picker, or a follow that survived a
        // webview reload (the follow store persists 7 days; these module Sets
        // do not survive the process). A follow that STARTED after this
        // voyage began was chosen in this voyage's context: treat it as
        // confirmed rather than re-ask, because dismissing the re-ask used to
        // kill that restored line mid-passage (hardening 2026-08-01).
        const follow = useFollowRouteStore.getState();
        if (follow.isFollowing && follow.startedAt) {
            const voyageStartMs = (() => {
                const summary = (state.summaries ?? []).find((v) => v.voyageId === vid);
                if (summary?.startedAt) return new Date(summary.startedAt).getTime();
                const firstEntry = state.entries.find((e) => e.voyageId === vid);
                return firstEntry ? new Date(firstEntry.timestamp).getTime() : null;
            })();
            // Cast Off arms the follow BEFORE GPS mints the ship-log
            // voyage, so the follow can legitimately predate the voyage by
            // the length of a GPS cold start. A follow that began within
            // the grace window before voyage start is this voyage's answer
            // — re-asking here was the "it asks you for which passage you
            // are doing — it should know that already" sheet (Shane
            // 2026-08-26). A follow older than that is a previous voyage's
            // and still re-asks.
            const FOLLOW_PRESTART_GRACE_MS = 10 * 60_000;
            if (
                voyageStartMs !== null &&
                new Date(follow.startedAt).getTime() >= voyageStartMs - FOLLOW_PRESTART_GRACE_MS
            ) {
                confirmedFollowVoyages.add(vid);
                return;
            }
        }

        // Freeze the choice list at open. The live list reshuffles as data
        // lands (the ⇄ fold re-picks direction when the first fix arrives),
        // which flipped rows under the skipper's thumb.
        setFollowPromptChoices(followSheetChoices);
        // A fresh sheet is a fresh attempt. Without this, a route that once
        // answered "a person has to look at this" stayed latched forever: every
        // later tap went straight back to the tracer and recheckRoute — the only
        // thing that can clear the latch — was never reached again. Acknowledge
        // the leg, save it, come back, and the row would still bounce you to the
        // tracer to acknowledge the very thing you just acknowledged.
        setNeedsTracerRoutes((prev) => (prev.size === 0 ? prev : new Set()));
        setFollowPromptVoyageId(vid);
        // NOT marked "asked" here — only an ANSWER (pick or explicit
        // dismissal) suppresses future prompts. An unmount mid-question
        // legitimately re-asks on the next visit.

        // CONCURRENTLY, ask the server whether this question was already
        // answered somewhere this component couldn't see (audit 2026-08-02).
        // The 'voyage-plan-link-changed' event can't cover the cross-page or
        // cross-session case — the Settings retro-link picker dispatches it,
        // but LogPage is unmounted while Settings is open, and the module
        // Sets die with the process. A voyage linked in Settings the night
        // before therefore looked "unanswered" here, the sheet re-asked, and
        // "Just recording" durably ERASED that link. An existing link IS the
        // answer: record the confirm and close the sheet. Deliberately NOT a
        // pre-open gate — the question must appear instantly (Shane
        // 2026-08-02: the wait before the question was the whole complaint),
        // and offline this check simply fails while the sheet works as
        // before. One-shot per voyage (the ref) because this effect re-fires
        // on every entries poll tick; instance-scoped so a remount re-checks.
        if (followLinkPrecheckRef.current !== vid) {
            followLinkPrecheckRef.current = vid;
            void (async () => {
                try {
                    const links = await VoyageLogService.getPlanLinks();
                    if (!isAuthIdentityScopeCurrent(identityScope)) return;
                    if (!links.has(vid)) return;
                    confirmedFollowVoyages.add(vid);
                    setFollowPromptVoyageId((open) => (open === vid ? null : open));
                } catch {
                    /* offline — the sheet stays up; asking beats never asking */
                }
            })();
        }
    }, [
        identityScope,
        state.isTracking,
        state.currentVoyageId,
        state.summaries,
        state.entries,
        followSheetChoices,
        followPromptVoyageId,
        castOffHandoff,
        activeCastOffVoyage,
        applyFollowPick,
        toast,
    ]);

    // Any other door answering the question (the Settings retro-link picker,
    // or a second device) retires this sheet's claim to it: record the
    // confirm and close if we're open on the same voyage. publishFollowedRoute
    // dispatches this event on success, and the sheet's own pick dispatches
    // it optimistically.
    React.useEffect(() => {
        const onLinkChanged = (e: Event) => {
            const vid = (e as CustomEvent<{ voyageId?: string }>).detail?.voyageId;
            if (!vid) return;
            confirmedFollowVoyages.add(vid);
            setFollowPromptVoyageId((open) => (open === vid ? null : open));
        };
        window.addEventListener('thalassa:voyage-plan-link-changed', onLinkChanged);
        return () => window.removeEventListener('thalassa:voyage-plan-link-changed', onLinkChanged);
    }, []);
    const [showMenu, setShowMenu] = useState(false);
    const [showArchived, setShowArchived] = useState(() => showArchivedMemo);

    // Stable identity for the TrackMapViewer prop — the old inline
    // .filter() minted a new array every render, defeating the viewer's
    // React.memo and forcing a full Leaflet layer rebuild on every
    // 1–5 s live-tracking poll tick.
    // Planned-vs-actual overlay: when a single sailed voyage is open, find
    // its planned route by start/end coords and overlay it (the viewer
    // already styles source==='planned_route' as a dashed purple plan
    // line and partitions per voyageId). Null when there's no plan.
    const matchedPlannedId = React.useMemo(() => {
        const summaries = state.summaries ?? [];
        if (!state.selectedVoyageId) return null;
        const sailed = summaries.find((s) => s.voyageId === state.selectedVoyageId);
        if (!sailed || sailed.isPlannedRoute) return null;
        return matchPlannedRouteByCoords(sailed, summaries);
    }, [state.selectedVoyageId, state.summaries]);

    // Immediate, reactive follow geometry. This works before (or without) a
    // background logbook save assigning a voyage id, updates on weather-route
    // refresh, and clears atomically when follow mode stops.
    const followedRouteCoords = useFollowRouteStore((s) =>
        s.isFollowing && s.routeCoords.length >= 2 ? s.routeCoords : NO_FOLLOWED_ROUTE,
    );
    const followedVoyageId = useFollowRouteStore((s) => (s.isFollowing ? s.voyageId : null));
    const trackViewerShowsFollowedRoute =
        !state.selectedVoyageId ||
        state.selectedVoyageId === state.currentVoyageId ||
        state.selectedVoyageId === followedVoyageId ||
        (followedVoyageId != null && matchedPlannedId === followedVoyageId);
    const trackViewerFollowedRouteCoords = trackViewerShowsFollowedRoute ? followedRouteCoords : NO_FOLLOWED_ROUTE;

    const trackMapEntries = React.useMemo(() => {
        const omitFollowedVoyageId = trackViewerShowsFollowedRoute ? followedVoyageId : null;
        if (!state.selectedVoyageId) {
            // The exact followed route has its own layer. Omit any resident
            // sparse saved-plan rows so the same violet line is not drawn
            // twice. Other saved plans are also omitted: the all-voyages map
            // is a historical track map, not a route library.
            return omitFollowedVoyageId
                ? loggedEntries.filter((entry) => entry.voyageId !== omitFollowedVoyageId)
                : loggedEntries;
        }
        const overlayMatchedPlan = matchedPlannedId != null && matchedPlannedId !== followedVoyageId;
        return state.entries.filter(
            (entry) =>
                entry.voyageId !== omitFollowedVoyageId &&
                (entry.voyageId === state.selectedVoyageId ||
                    (overlayMatchedPlan && entry.voyageId === matchedPlannedId)),
        );
    }, [
        state.entries,
        state.selectedVoyageId,
        loggedEntries,
        matchedPlannedId,
        followedVoyageId,
        trackViewerShowsFollowedRoute,
    ]);

    // Load the matched planned route's points when the track map opens so
    // they're resident for the overlay.
    useEffect(() => {
        if (state.showTrackMap && matchedPlannedId) void loadVoyageEntries(matchedPlannedId);
    }, [state.showTrackMap, matchedPlannedId, loadVoyageEntries]);

    // Career personal records — derived purely from voyage summaries.
    const records = React.useMemo(() => computePersonalRecords(state.summaries ?? []), [state.summaries]);

    // "Recording" vs "Acquiring GPS fix…" — keyed on whether the active
    // voyage has a real recorded position yet. gpsStatus alone can't be
    // trusted for this: an engine-start replay fix makes it read
    // 'locked' immediately while nothing trustworthy has been captured.
    // Shared with the poll cadence in useLogPageState — one definition, so the
    // overlay and the poll that lets it notice cannot disagree.
    const hasRecordedFix = React.useMemo(
        // LIVE voyage-id fallback (audit follow-up 2026-08-03):
        // state.currentVoyageId is written only by LOAD_DATA, which awaits
        // Supabase fetches — on dead boat comms it can starve indefinitely
        // while the 1 s poll happily merges recorded entries keyed on the
        // LIVE id. Without the fallback the badge claims "Acquiring GPS
        // fix…" forever on a voyage that is recording perfectly.
        () => voyageHasRecordedFix(state.entries, state.currentVoyageId ?? ShipLogService.getCurrentVoyageId()),
        [state.entries, state.currentVoyageId],
    );

    // ── ONE honest acquiring state, shared by ALL FOUR surfaces ──
    // The top banner, the header badge and both map veils each rendered their
    // own hard-coded "Acquiring GPS fix…" with no cause and no clock, so
    // hardening only the full-screen overlay changed nothing the skipper
    // actually looks at (Shane, 2026-08-02: "still have the exact same screen…
    // it has been there for over 1 minute"). They now share one source.
    const gpsHealth = useGpsHealth();
    const gpsBlocked = gpsHealth && !gpsHealth.usable ? gpsHealthMessage(gpsHealth.reason) : null;
    const [trackingStartFailure, setTrackingStartFailure] = useState<TrackingStartFailure | null>(null);
    const [checkingStartGps, setCheckingStartGps] = useState(false);
    const startGpsCheckRef = useRef(false);

    // Elapsed since this voyage started waiting. Module-scope so it survives
    // the tab-bounce that unmounts this page, per
    // [[lesson_session_guards_module_scope]] — a counter that resets every time
    // the skipper checks the chart is exactly the lie it exists to prevent.
    const [gpsWaitSec, setGpsWaitSec] = React.useState(0);
    React.useEffect(() => {
        const vid = state.currentVoyageId ?? null;
        if (!state.isTracking || hasRecordedFix) {
            if (vid) acquiringSince.delete(vid);
            // The pre-LOAD_DATA sentinel too. Cleanup used to remove only the
            // vid key, so a stop that landed while vid was still null left
            // '__pending__' in the module map forever — and the NEXT voyage's
            // clock inherited that old timestamp, opening at "2:07" for a fix
            // the device had been acquiring for seconds (Shane 2026-08-12:
            // "it seems to start at 2mins sometimes").
            acquiringSince.delete('__pending__');
            setGpsWaitSec(0);
            return;
        }
        const key = vid ?? '__pending__';
        if (!acquiringSince.has(key)) {
            // Inherit the pre-LOAD_DATA clock: waiting began at cast-off,
            // not when Supabase named the voyage.
            acquiringSince.set(key, acquiringSince.get('__pending__') ?? Date.now());
        }
        if (vid) acquiringSince.delete('__pending__');
        const startedAt = acquiringSince.get(key) as number;
        const tick = () => setGpsWaitSec(Math.floor((Date.now() - startedAt) / 1000));
        tick();
        const id = setInterval(tick, 1000);
        return () => clearInterval(id);
    }, [state.isTracking, state.currentVoyageId, hasRecordedFix]);

    /** "1:23" — what the skipper reads to know whether waiting is still sane. */
    const gpsWaitLabel = `${Math.floor(gpsWaitSec / 60)}:${String(gpsWaitSec % 60).padStart(2, '0')}`;
    /** The headline the header badge shows: elapsed clock, or the named
     *  OS-level blocker when waiting cannot help. */
    const gpsHeadline = gpsBlocked ? gpsBlocked.title : `Acquiring GPS fix… ${gpsWaitLabel}`;

    // ── The OTHER acquiring surfaces are GONE (Shane 2026-08-03) ──
    // The full-screen GpsAcquiringOverlay takeover, the floating top banner,
    // and the two live-map veils were all removed: "remove the large full
    // screen acquiring gps fix, as well as the smaller background one. i
    // would like to just keep the green one that is just below the heading."
    // The header badge above is now the ONE acquiring surface, and it keeps
    // the honest story: gpsHeadline carries the elapsed clock and, when the
    // OS is the blocker (denied / services off), the named cause via
    // gpsBlocked. History for whoever wonders why the takeover ever existed:
    // built 2026-07-03 (badge invisible in cockpit sunlight while the first
    // minutes silently didn't record), grew a 120 s safety valve 2026-07-29
    // ("sometimes never goes away"), learned to yield to the follow-route
    // sheet 2026-08-02 ("ask which track BEFORE the acquiring message") —
    // and that ordering dance is precisely why one badge beats four layers.
    // NOTE: the banner's "Fix" button (deep link to Settings when location
    // permission is denied) went with it; the badge still names the cause,
    // and the GPS disclaimer modal remains the actionable door.

    // ── Departure prompt (share-live?) MOVED OUT ─────
    // The "share this voyage live?" nudge lives in a global, always-mounted
    // <DeparturePrompts/> (App.tsx), driven by ShipLogService's tracking
    // listener. It used to be here, but the app mounts one view at a time
    // and a voyage is cast off from the helm — so LogPage wasn't mounted and
    // the prompt never fired (Shane 2026-07-05). Its sibling, the
    // "link-a-plan?" suggestion banner, was removed 2026-08-02 — the
    // cast-off follow sheet below owns that question outright.

    // Engine on/off — user-declared while tracking, stamped onto track
    // points for the sail/motor split. Mirrors ShipLogService's sticky
    // state (undefined until first declared this voyage).
    const [engineRunning, setEngineRunningState] = useState<boolean | undefined>(undefined);
    useEffect(() => {
        setEngineRunningState(state.isTracking ? ShipLogService.getEngineRunning() : undefined);
    }, [state.isTracking, state.currentVoyageId]);
    const toggleEngine = useCallback(
        async (running: boolean) => {
            const actionScope = identityScope;
            if (!isAuthIdentityScopeCurrent(actionScope)) return;
            await ShipLogService.setEngineRunning(running);
            if (!isAuthIdentityScopeCurrent(actionScope)) return;
            setEngineRunningState(running);
            setNudgeDismiss(null); // resolving the toggle clears any nudge
            triggerHaptic('light');
        },
        [identityScope],
    );

    // ── Propulsion mismatch nudge ──
    // When the declared engine state and the live heuristic estimate
    // SUSTAINEDLY disagree, gently suggest flipping the toggle. Only fires
    // on a real, debounced conflict (see evaluatePropulsionConflict's
    // hysteresis), and a Dismiss snoozes it for 10 min for that state.
    const recentActiveEntries = React.useMemo(() => {
        if (!state.currentVoyageId) return [];
        const cutoff = Date.now() - 5 * 60 * 1000;
        return state.entries.filter((e) => e.voyageId === state.currentVoyageId && Date.parse(e.timestamp) >= cutoff);
    }, [state.entries, state.currentVoyageId]);

    const propConflict = React.useMemo(
        () => evaluatePropulsionConflict(recentActiveEntries, engineRunning),
        [recentActiveEntries, engineRunning],
    );

    const [nudgeDismiss, setNudgeDismiss] = useState<{ until: number; forDeclared: boolean | undefined } | null>(null);
    const showPropNudge =
        state.isTracking &&
        propConflict.conflict &&
        !(nudgeDismiss && nudgeDismiss.forDeclared === engineRunning && Date.now() < nudgeDismiss.until);

    // Live mini-map expansion — tap the little map to blow it up to a
    // fullscreen live view (stats stay overlaid), tap again to shrink.
    const [liveMapExpanded, setLiveMapExpanded] = useState(() => liveMapExpandedMemo);
    const liveMapTitleId = React.useId();
    const expandLiveMapRef = useRef<HTMLButtonElement>(null);
    const shrinkLiveMapRef = useRef<HTMLButtonElement>(null);
    const closeLiveMap = useCallback(() => {
        if (isAuthIdentityScopeCurrent(identityScope)) setLiveMapExpanded(false);
    }, [identityScope]);
    const liveMapDialogRef = useFocusTrap<HTMLDivElement>(liveMapExpanded, {
        initialFocusRef: shrinkLiveMapRef,
        onEscape: closeLiveMap,
    });
    const openLiveMap = useCallback(() => {
        if (!isAuthIdentityScopeCurrent(identityScope)) return;
        // The explicit opener remains mounted underneath the portal, giving
        // the focus trap a stable element to restore when the map closes.
        expandLiveMapRef.current?.focus();
        setLiveMapExpanded(true);
    }, [identityScope]);
    useEffect(() => {
        // Close the live map when tracking genuinely STOPS — but not on the
        // remount window. Fresh reducer state reads isTracking=false until the
        // first LOAD_DATA lands, so gating on the raw flag closed the restored
        // map on every tab-bounce back to the page, right before the load
        // proved tracking was still on. `loading` distinguishes "not tracking"
        // from "don't know yet".
        if (!state.isTracking && !state.loading) setLiveMapExpanded(false);
    }, [state.isTracking, state.loading]);
    // Bank the toggles for the next mount (module memos — see their header).
    useEffect(() => {
        liveMapExpandedMemo = liveMapExpanded;
    }, [liveMapExpanded]);
    useEffect(() => {
        showArchivedMemo = showArchived;
    }, [showArchived]);

    // GPS Disclaimer modal state
    const [showGpsDisclaimer, setShowGpsDisclaimer] = useState(false);
    const pendingStartRef = useRef<(() => void) | null>(null);

    const checkGpsDisclaimer = useCallback(
        async (onProceed: () => void) => {
            const actionScope = identityScope;
            if (!isAuthIdentityScopeCurrent(actionScope)) return;
            try {
                const { value } = await Preferences.get({ key: 'gps_disclaimer_dismissed' });
                if (!isAuthIdentityScopeCurrent(actionScope)) return;
                if (value === 'true') {
                    onProceed();
                } else {
                    pendingStartRef.current = onProceed;
                    setShowGpsDisclaimer(true);
                }
            } catch {
                if (isAuthIdentityScopeCurrent(actionScope)) onProceed(); // fail-open
            }
        },
        [identityScope],
    );

    const dismissGpsDisclaimer = useCallback(
        async (dontShowAgain: boolean) => {
            const actionScope = identityScope;
            if (!isAuthIdentityScopeCurrent(actionScope)) return;
            if (dontShowAgain) {
                await Preferences.set({ key: 'gps_disclaimer_dismissed', value: 'true' });
                if (!isAuthIdentityScopeCurrent(actionScope)) return;
            }
            setShowGpsDisclaimer(false);
            const pendingStart = pendingStartRef.current;
            pendingStartRef.current = null;
            if (pendingStart) pendingStart();
        },
        [identityScope],
    );

    /**
     * A voyage is not declared "Live Recording" until the page proves this
     * device can supply a fresh position. ShipLogService still owns the
     * long-lived capture gate; this is the fail-closed user-facing preflight
     * that prevents permission denial or a GPS-less browser from entering an
     * optimistic recording state indefinitely.
     */
    const verifyGpsAndStart = useCallback(
        async (onProceed: () => void | Promise<void>, showDisclaimer: boolean) => {
            if (startGpsCheckRef.current) return;
            const actionScope = identityScope;
            if (!isAuthIdentityScopeCurrent(actionScope)) return;

            startGpsCheckRef.current = true;
            setCheckingStartGps(true);
            setTrackingStartFailure(null);
            try {
                const position = await acquireFreshOwnshipPosition({
                    maxGpsAgeMs: 30_000,
                    timeoutSec: 12,
                    locationAccess: 'background-safety',
                });
                if (!isAuthIdentityScopeCurrent(actionScope)) return;
                if (!position) {
                    if (gpsBlocked && gpsHealth) {
                        const kind: TrackingStartFailure['kind'] =
                            gpsHealth.reason === 'denied' || gpsHealth.reason === 'not-determined'
                                ? 'permission'
                                : gpsHealth.reason === 'services-off'
                                  ? 'services-off'
                                  : 'no-provider';
                        setTrackingStartFailure({
                            kind,
                            title: gpsBlocked.title,
                            detail: `Tracking did not start. ${gpsBlocked.detail}`,
                            actionable: gpsHealth.actionable,
                        });
                    } else {
                        setTrackingStartFailure({
                            kind: 'no-fix',
                            title: 'No fresh GPS fix',
                            detail: 'Tracking did not start. Check location permission, move the device to a clear view of the sky, or reconnect the vessel GPS, then try again.',
                            actionable: gpsHealth?.actionable ?? false,
                        });
                    }
                    triggerHaptic('medium');
                    return;
                }

                setTrackingStartFailure(null);
                if (showDisclaimer) await checkGpsDisclaimer(onProceed);
                else await onProceed();
            } finally {
                startGpsCheckRef.current = false;
                if (isAuthIdentityScopeCurrent(actionScope)) setCheckingStartGps(false);
            }
        },
        [checkGpsDisclaimer, gpsBlocked, gpsHealth, identityScope],
    );
    // Render-time ref assignment (idempotent) so the follow sheet's pre-start
    // answers — declared far above — can fire the verified start without a
    // declaration-order knot.
    startTrackingVerifiedRef.current = () => {
        void verifyGpsAndStart(handleStartTracking, true);
    };

    /**
     * The Start Tracking gesture (Shane 2026-08-10: "it starts to track, and
     * THEN it asks if you want to follow a route?? tidy this up, make it
     * snappy"). With followable routes saved, the question now comes FIRST —
     * the sheet opens instantly on the slide — while the GPS fix warms in the
     * background, so answering leads straight into a fast verified start.
     * With nothing to follow, the slide starts tracking exactly as before.
     */
    const beginCastOff = React.useCallback(() => {
        if (!isAuthIdentityScopeCurrent(identityScope)) return;
        if (followSheetChoices.length === 0) {
            void verifyGpsAndStart(handleStartTracking, true);
            return;
        }
        // Warm the fix while the skipper reads the sheet — the post-answer
        // preflight then finds a fresh position already cached instead of
        // starting a cold acquisition. Fire-and-forget by design.
        void acquireFreshOwnshipPosition({
            maxGpsAgeMs: 30_000,
            timeoutSec: 12,
            locationAccess: 'background-safety',
        }).catch(() => null);
        setFollowBlockNotice(null);
        setFollowPromptChoices(followSheetChoices);
        // A fresh sheet is a fresh attempt. Without this, a route that once
        // answered "a person has to look at this" stayed latched forever: every
        // later tap went straight back to the tracer and recheckRoute — the only
        // thing that can clear the latch — was never reached again. Acknowledge
        // the leg, save it, come back, and the row would still bounce you to the
        // tracer to acknowledge the very thing you just acknowledged.
        setNeedsTracerRoutes((prev) => (prev.size === 0 ? prev : new Set()));
        setPreStartSheetOpen(true);
    }, [followSheetChoices, handleStartTracking, identityScope, verifyGpsAndStart]);

    // Share form auto-fill state
    const [shareAutoTitle, setShareAutoTitle] = useState('');
    const [shareAutoRegion, setShareAutoRegion] = useState('');
    const shareFormResetRef = useRef(0);

    // Share a self-contained summary-card PNG of the scoped voyage.
    const handleShareImage = useCallback(async () => {
        const actionScope = identityScope;
        if (!isAuthIdentityScopeCurrent(actionScope)) return;
        const scoped = state.selectedVoyageId
            ? state.entries.filter((e) => e.voyageId === state.selectedVoyageId)
            : loggedEntries;
        if (scoped.filter((e) => e.latitude && e.longitude).length < 2) {
            toast.error('Not enough track to make a card yet');
            return;
        }
        dispatch({ type: 'SET_ACTION_SHEET', sheet: null });
        try {
            const { shareVoyageCard } = await import('../services/shiplog/voyageShareCard');
            if (!isAuthIdentityScopeCurrent(actionScope)) return;
            await shareVoyageCard(scoped, { title: shareAutoTitle || undefined });
        } catch (err) {
            if (!isAuthIdentityScopeCurrent(actionScope)) return;
            if (err instanceof Error && err.name !== 'AbortError') {
                log.warn('share image failed:', err);
                toast.error('Could not create the image');
            }
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [identityScope, loggedEntries, state.selectedVoyageId, state.entries, shareAutoTitle, toast]);

    // Destructure frequently used state for JSX readability.
    // `isRapidMode` and `isPrecisionMode` no longer destructured here
    // 2026-05-17 — the UI toggles that consumed them were removed when
    // Precision became always-on. State remains in the reducer for
    // potential paywall-gating UI to read directly.
    const {
        entries,
        isTracking,
        loading,
        showAddModal,
        showTrackMap,
        showStats,
        showStopVoyageDialog,
        showVoyageChoiceDialog,
        showCommunityBrowser,
        actionSheet,
        editEntry,
        selectedVoyageId,
        deleteVoyageId,
        currentVoyageId,
        expandedVoyages,
        gpsStatus,
        filters: _filters,
    } = state;

    const handleShareCurrentPosition = useCallback(async () => {
        const actionScope = identityScope;
        if (!isAuthIdentityScopeCurrent(actionScope)) return;
        try {
            const voyageEntries = entries
                .filter((entry) => entry.voyageId === currentVoyageId)
                .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
            const latestEntry = voyageEntries[0];
            const pinLat = latestEntry?.latitude;
            const pinLon = latestEntry?.longitude;
            if (!Number.isFinite(pinLat) || !Number.isFinite(pinLon) || (pinLat === 0 && pinLon === 0)) {
                toast.error('No GPS position available yet');
                return;
            }
            const mapsUrl = `https://maps.google.com/?q=${pinLat!.toFixed(6)},${pinLon!.toFixed(6)}`;
            const message = `\u{1F4CD} My Current Position\n\nLat: ${pinLat!.toFixed(4)}\u00B0  Lon: ${pinLon!.toFixed(4)}\u00B0\n\nView on map: ${mapsUrl}\n\nShared via Thalassa \u{26F5}`;
            if (navigator.share) {
                await navigator.share({ title: 'My Position', text: message });
            } else {
                await navigator.clipboard.writeText(message);
                if (isAuthIdentityScopeCurrent(actionScope)) toast.success('Position copied to clipboard');
            }
        } catch (err: unknown) {
            if (isAuthIdentityScopeCurrent(actionScope) && err instanceof Error && err.name !== 'AbortError') {
                log.warn('Share failed:', err);
            }
        }
    }, [currentVoyageId, entries, identityScope, toast]);

    // Auto-fill share form when panel opens
    useEffect(() => {
        const effectScope = identityScope;
        if (!isAuthIdentityScopeCurrent(effectScope)) return;
        if (actionSheet !== 'share' && actionSheet !== 'share_form') {
            setShareAutoTitle('');
            setShareAutoRegion('');
            return;
        }

        const targetEntries = selectedVoyageId ? entries.filter((e) => e.voyageId === selectedVoyageId) : loggedEntries;

        if (targetEntries.length === 0) return;

        const sorted = [...targetEntries].sort(
            (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
        );
        const first = sorted[0];
        const last = sorted[sorted.length - 1];
        const resetId = ++shareFormResetRef.current;

        // Reverse geocode start and end for title
        (async () => {
            try {
                const firstWaypointName = meaningfulLogEndpointName(first);
                const lastWaypointName = meaningfulLogEndpointName(last);
                const [startName, endName] = await Promise.all([
                    firstWaypointName
                        ? Promise.resolve(firstWaypointName)
                        : reverseGeocode(first.latitude, first.longitude).catch(() => null),
                    last.id !== first.id
                        ? lastWaypointName
                            ? Promise.resolve(lastWaypointName)
                            : reverseGeocode(last.latitude, last.longitude).catch(() => null)
                        : Promise.resolve(null),
                ]);
                if (resetId !== shareFormResetRef.current || !isAuthIdentityScopeCurrent(effectScope)) return; // stale
                const startLabel = startName?.trim() || formatEndpointCoordinates(first);
                const endLabel = endName?.trim() || formatEndpointCoordinates(last);
                const title =
                    endLabel && endLabel !== startLabel ? `${startLabel || 'Unknown'} → ${endLabel}` : startLabel || '';
                setShareAutoTitle(title);
            } catch (e) {
                if (isAuthIdentityScopeCurrent(effectScope)) log.warn('could not build share title:', e);
            }
        })();

        // Auto-detect region from start location
        // GeoContext.name is already "City, State, Country" — extract region by dropping city
        (async () => {
            try {
                const ctx = await reverseGeocodeContext(first.latitude, first.longitude);
                if (resetId !== shareFormResetRef.current || !isAuthIdentityScopeCurrent(effectScope)) return; // stale
                if (ctx && ctx.name) {
                    const parts = ctx.name.split(',').map((p) => p.trim());
                    // Drop the city (first part) to get "State, Country"
                    const region = parts.length > 1 ? parts.slice(1).join(', ') : parts[0];
                    setShareAutoRegion(region);
                }
            } catch (e) {
                if (isAuthIdentityScopeCurrent(effectScope)) log.warn('fallback to empty:', e);
            }
        })();
    }, [actionSheet, selectedVoyageId, entries, identityScope, loggedEntries]);

    useEffect(() => {
        // Reset only when the identity actually changes. A one-shot "mounted"
        // ref is not sufficient because React StrictMode replays mount effects
        // in development and would clear a cast-off prompt on the replay.
        const previous = previousIdentityScopeRef.current;
        if (previous.key === identityScope.key && previous.generation === identityScope.generation) return;
        previousIdentityScopeRef.current = identityScope;
        setPageStateScope(identityScope);
        setFollowPromptVoyageId(null);
        setFollowPromptLoadingId(null);
        // Account boundary: prompt suppression must not leak across identities.
        confirmedFollowVoyages.clear();
        dismissedFollowVoyages.clear();
        setShowMenu(false);
        setShowArchived(false);
        setEngineRunningState(undefined);
        setNudgeDismiss(null);
        setLiveMapExpanded(false);
        setShowGpsDisclaimer(false);
        pendingStartRef.current = null;
        startGpsCheckRef.current = false;
        setCheckingStartGps(false);
        setTrackingStartFailure(null);
        setShareAutoTitle('');
        setShareAutoRegion('');
        shareFormResetRef.current += 1;
    }, [identityScope]);

    // No full-page spinner: the page shell + the Start control render
    // immediately (starting a track is network-free), and only the
    // voyage LIST shows a skeleton while history loads. The old
    // early-return here held the entire page — Start button included —
    // hostage to auth rehydrate + the Supabase summaries fetch.

    if (!pageBelongsToCurrentIdentity) {
        return <div className="h-full bg-slate-950" aria-busy="true" aria-label="Switching ship log account" />;
    }

    return (
        <div className="relative h-full bg-slate-950 overflow-hidden">
            {/* Fullscreen Statistics View */}
            {showStats ? (
                <div className="flex flex-col h-full">
                    <div className="flex items-center justify-between p-4 border-b border-white/10">
                        <h2 className="text-lg font-bold text-white">Voyage Statistics</h2>
                        <button
                            aria-label="Close statistics"
                            onClick={() => dispatch({ type: 'SHOW_STATS', show: false })}
                            className="p-2 text-slate-400 hover:text-white hover:bg-white/10 rounded-lg transition-colors"
                        >
                            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth={2}
                                    d="M6 18L18 6M6 6l12 12"
                                />
                            </svg>
                        </button>
                    </div>
                    <div className="flex-1 overflow-auto p-4 md:p-8 flex flex-col justify-center md:max-w-3xl md:mx-auto">
                        {(() => {
                            // All-Voyages aggregate excludes suggested/
                            // planned routes (source='planned_route') so
                            // they don't inflate distance / speed / entry
                            // totals. A single selected voyage shows its
                            // own entries verbatim (the user explicitly
                            // drilled into it). 2026-05-20.
                            const scopedEntries = selectedVoyageId
                                ? filteredEntries.filter((e) => e.voyageId === selectedVoyageId)
                                : loggedFilteredEntries;

                            let scopedDistance = 0;
                            if (selectedVoyageId) {
                                // Single voyage: max cumulative distance
                                scopedDistance =
                                    scopedEntries.length > 0
                                        ? Math.max(...scopedEntries.map((e) => e.cumulativeDistanceNM || 0))
                                        : 0;
                            } else {
                                // All voyages: sum each voyage's max cumulative distance
                                const voyageMap = new Map<string, number>();
                                scopedEntries.forEach((e) => {
                                    const vid = e.voyageId || 'default';
                                    const current = voyageMap.get(vid) || 0;
                                    voyageMap.set(vid, Math.max(current, e.cumulativeDistanceNM || 0));
                                });
                                voyageMap.forEach((d) => {
                                    scopedDistance += d;
                                });
                            }

                            const speedEntries = scopedEntries.filter((e) => e.speedKts && e.speedKts > 0);
                            const scopedAvgSpeed =
                                speedEntries.length > 0
                                    ? speedEntries.reduce((sum, e) => sum + (e.speedKts || 0), 0) / speedEntries.length
                                    : 0;
                            return (
                                <div className="grid grid-cols-3 gap-3 mb-4">
                                    <StatBox label="Distance" value={`${(scopedDistance ?? 0).toFixed(1)} NM`} />
                                    <StatBox label="Avg Speed" value={`${(scopedAvgSpeed ?? 0).toFixed(1)} kts`} />
                                    <StatBox label="Entries" value={scopedEntries.length} />
                                </div>
                            );
                        })()}
                        <VoyageStatsPanel
                            entries={
                                selectedVoyageId
                                    ? filteredEntries.filter((e) => e.voyageId === selectedVoyageId)
                                    : loggedFilteredEntries
                            }
                        />
                    </div>
                </div>
            ) : (
                <div className="flex flex-col h-full">
                    {/* ── Header ── */}
                    <PageHeader
                        title="Ship's Log"
                        subtitle={
                            isTracking ? (
                                <div className="flex items-center gap-1.5 mt-0.5">
                                    <span
                                        className={`w-1.5 h-1.5 rounded-full ${
                                            gpsStatus === 'locked'
                                                ? 'bg-emerald-400 animate-pulse'
                                                : gpsStatus === 'stale'
                                                  ? 'bg-amber-400 animate-pulse'
                                                  : 'bg-red-500 animate-pulse'
                                        }`}
                                    />
                                    <span
                                        className={`text-[10px] font-bold uppercase tracking-widest ${
                                            gpsStatus === 'locked'
                                                ? 'text-emerald-400/80'
                                                : gpsStatus === 'stale'
                                                  ? 'text-amber-300/80'
                                                  : 'text-red-400/80'
                                        }`}
                                    >
                                        {gpsStatus === 'locked' && hasRecordedFix ? 'Recording' : gpsHeadline}
                                    </span>
                                </div>
                            ) : (
                                'GPS Voyage Recorder'
                            )
                        }
                        onBack={onBack}
                        action={
                            <div className="relative">
                                <button
                                    aria-label="Open menu"
                                    onClick={() => setShowMenu(!showMenu)}
                                    className="flex min-h-[44px] min-w-[44px] items-center justify-center p-2 text-slate-400 hover:text-white hover:bg-white/10 rounded-lg transition-colors"
                                >
                                    <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                                        <circle cx="10" cy="4" r="1.5" />
                                        <circle cx="10" cy="10" r="1.5" />
                                        <circle cx="10" cy="16" r="1.5" />
                                    </svg>
                                </button>
                                {/* Overflow Menu */}
                                {showMenu && (
                                    <>
                                        <div className="fixed inset-0 z-40" onClick={() => setShowMenu(false)} />
                                        <div className="absolute right-0 top-full mt-1 z-50 w-52 bg-slate-800 border border-white/10 rounded-xl shadow-2xl overflow-hidden">
                                            {/* Rapid Mode + Precision Mode toggles were removed
                                                from this menu 2026-05-17. Precision Mode is now
                                                always-on whenever tracking is active (the
                                                canonical "hi-fi 2 Hz + live decimation" pipeline),
                                                so the toggle was just visual noise. Rapid Mode is
                                                preserved in the service for potential future
                                                paywall gating but no longer surfaced in the UI —
                                                "having two tracking modes, one of which works"
                                                was the wrong story. The handler hooks
                                                (handleToggleRapidMode, handleTogglePrecisionMode)
                                                stay in the hook in case we re-expose them as a
                                                Skipper-tier gate. */}
                                            {/* Diary kebab item REMOVED 2026-05-17 — Diary now
                                                has its own prominent full-card tile in the new
                                                Vessel-tab → Sharing section (paired with
                                                Scuttlebutt). The kebab was the right rescue
                                                home when Diary was otherwise orphaned, but for
                                                the "share your voyage" conversion story it
                                                deserves real presence, not menu-burial. */}
                                            <MenuBtn
                                                icon="📊"
                                                label="Statistics"
                                                onClick={() => {
                                                    dispatch({ type: 'SET_ACTION_SHEET', sheet: 'stats' });
                                                    setShowMenu(false);
                                                }}
                                                disabled={loggedVoyages.length === 0 && loggedEntries.length === 0}
                                            />
                                            <MenuBtn
                                                icon="🗺"
                                                label="Track Map"
                                                onClick={() => {
                                                    dispatch({ type: 'SHOW_TRACK_MAP', show: true });
                                                    setShowMenu(false);
                                                }}
                                                disabled={loggedVoyages.length === 0 && loggedEntries.length === 0}
                                            />
                                            <MenuBtn
                                                icon="📤"
                                                label="Export"
                                                onClick={() => {
                                                    dispatch({ type: 'SET_ACTION_SHEET', sheet: 'export' });
                                                    setShowMenu(false);
                                                }}
                                                disabled={loggedVoyages.length === 0 && loggedEntries.length === 0}
                                            />
                                            {FEATURE_VISIBILITY.communityTrackSharing && (
                                                <MenuBtn
                                                    icon="📥"
                                                    label="Import"
                                                    onClick={() => {
                                                        dispatch({ type: 'SET_ACTION_SHEET', sheet: 'import' });
                                                        setShowMenu(false);
                                                    }}
                                                />
                                            )}
                                            <MenuBtn
                                                icon="🔗"
                                                label="Share"
                                                onClick={() => {
                                                    dispatch({ type: 'SET_ACTION_SHEET', sheet: 'share' });
                                                    setShowMenu(false);
                                                }}
                                                disabled={loggedVoyages.length === 0 && loggedEntries.length === 0}
                                            />
                                        </div>
                                    </>
                                )}
                            </div>
                        }
                    />

                    {/* The trickle's single-publisher veto, said out loud. It
                        used to be console-only, which is how a healthy-looking
                        chain published nothing for a whole day, twice. */}
                    <SkipperClaimNotice isTracking={state.isTracking} onOpenVessel={() => _setPage('vessel')} />

                    {/* ── Voyage Totals — three hero gauge tiles ──
                        Polished 2026-05-17 — gradient backdrops per
                        accent colour, icon glyph in the upper-right
                        corner of each, larger metric + inline unit
                        suffix, brighter labels. Stats use
                        `sailedVoyageGroups` — the SAILED subset of the
                        cards below, with suggested/planned routes excluded
                        (2026-05-20) so aspirational routes don't inflate
                        the distance / time / voyage totals. */}
                    {(() => {
                        // Aggregated server-side from voyage SUMMARIES (accurate
                        // across the whole history, no points loaded). voyageStats
                        // already excludes suggested/planned routes.
                        const totalNmRaw = voyageStats.totalNm;
                        const totalMs = voyageStats.totalMs;
                        const totalHrs = Math.round((totalMs / (1000 * 60 * 60)) * 10) / 10;
                        const atSeaDays = Math.round(totalHrs / 24);
                        const atSeaValue = totalHrs < 24 ? totalHrs.toString() : atSeaDays.toString();
                        // Singular where it is singular: "1 days" read as a typo on the skipper's own log.
                        const atSeaUnit =
                            totalHrs < 24 ? (totalHrs === 1 ? 'hr' : 'hrs') : atSeaDays === 1 ? 'day' : 'days';
                        return (
                            <div className="shrink-0 px-4 pb-3">
                                <div className="grid grid-cols-3 gap-2.5">
                                    {/* ── NM Sailed ── */}
                                    <div className="relative rounded-2xl overflow-hidden border border-sky-500/15 bg-linear-to-br from-sky-500/10 via-sky-500/4 to-transparent p-3.5 shadow-[0_2px_12px_-4px_rgba(56,189,248,0.15)]">
                                        {/* Soft top-edge highlight */}
                                        <div className="absolute top-0 left-0 right-0 h-px bg-linear-to-r from-transparent via-sky-400/40 to-transparent" />
                                        {/* Compass-needle icon, top-right */}
                                        <svg
                                            className="absolute top-2.5 right-2.5 w-4 h-4 text-sky-400/40"
                                            fill="none"
                                            viewBox="0 0 24 24"
                                            stroke="currentColor"
                                            strokeWidth={1.8}
                                            aria-hidden="true"
                                        >
                                            <circle cx="12" cy="12" r="9" />
                                            <path
                                                d="M14.5 9.5L11 13l-1.5-1.5L13 8z"
                                                fill="currentColor"
                                                stroke="none"
                                            />
                                            <path
                                                d="M9.5 14.5L13 11l1.5 1.5L11 16z"
                                                fill="currentColor"
                                                stroke="none"
                                                opacity="0.4"
                                            />
                                        </svg>
                                        <div className="text-[10px] font-bold text-sky-300/70 uppercase tracking-widest mb-2">
                                            Distance
                                        </div>
                                        <div className="flex items-baseline gap-1">
                                            <span className="text-2xl font-black text-white tabular-nums leading-none">
                                                {totalNmRaw.toFixed(1)}
                                            </span>
                                            <span className="text-[11px] font-bold text-sky-300/60 uppercase tracking-wider">
                                                nm
                                            </span>
                                        </div>
                                    </div>
                                    {/* ── At Sea ── */}
                                    <div className="relative rounded-2xl overflow-hidden border border-emerald-500/15 bg-linear-to-br from-emerald-500/10 via-emerald-500/4 to-transparent p-3.5 shadow-[0_2px_12px_-4px_rgba(16,185,129,0.15)]">
                                        <div className="absolute top-0 left-0 right-0 h-px bg-linear-to-r from-transparent via-emerald-400/40 to-transparent" />
                                        {/* Clock-like circle-with-tick icon */}
                                        <svg
                                            className="absolute top-2.5 right-2.5 w-4 h-4 text-emerald-400/40"
                                            fill="none"
                                            viewBox="0 0 24 24"
                                            stroke="currentColor"
                                            strokeWidth={1.8}
                                            aria-hidden="true"
                                        >
                                            <circle cx="12" cy="12" r="9" />
                                            <path d="M12 7v5l3 2" strokeLinecap="round" />
                                        </svg>
                                        {/* "Sea Time", not "Time at Sea" — the longer label ran
                                            into the clock icon (Shane 2026-08-13). */}
                                        <div className="text-[10px] font-bold text-emerald-300/70 uppercase tracking-widest mb-2">
                                            Sea Time
                                        </div>
                                        <div className="flex items-baseline gap-1">
                                            <span className="text-2xl font-black text-white tabular-nums leading-none">
                                                {atSeaValue}
                                            </span>
                                            <span className="text-[11px] font-bold text-emerald-300/60 uppercase tracking-wider">
                                                {atSeaUnit}
                                            </span>
                                        </div>
                                    </div>
                                    {/* ── Voyages ── */}
                                    <div className="relative rounded-2xl overflow-hidden border border-amber-500/15 bg-linear-to-br from-amber-500/10 via-amber-500/4 to-transparent p-3.5 shadow-[0_2px_12px_-4px_rgba(245,158,11,0.15)]">
                                        <div className="absolute top-0 left-0 right-0 h-px bg-linear-to-r from-transparent via-amber-400/40 to-transparent" />
                                        {/* Anchor icon */}
                                        <svg
                                            className="absolute top-2.5 right-2.5 w-4 h-4 text-amber-400/40"
                                            fill="none"
                                            viewBox="0 0 24 24"
                                            stroke="currentColor"
                                            strokeWidth={1.8}
                                            aria-hidden="true"
                                        >
                                            <circle cx="12" cy="5" r="2" />
                                            <path d="M12 7v13" strokeLinecap="round" />
                                            <path d="M8 11h8" strokeLinecap="round" />
                                            <path d="M5 15a7 7 0 0014 0" strokeLinecap="round" />
                                        </svg>
                                        <div className="text-[10px] font-bold text-amber-300/70 uppercase tracking-widest mb-2">
                                            Voyages
                                        </div>
                                        <div className="flex items-baseline gap-1">
                                            <span className="text-2xl font-black text-white tabular-nums leading-none">
                                                {voyageStats.voyageCount}
                                            </span>
                                            <span className="text-[11px] font-bold text-amber-300/60 uppercase tracking-wider">
                                                {voyageStats.voyageCount === 1 ? 'log' : 'logs'}
                                            </span>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        );
                    })()}

                    {/* ── Personal records strip — career bests from summaries.
                        Shown in the list view (not while the live card fills
                        the screen), only once there's qualifying history. */}
                    {!isTracking && records.voyageCount >= 2 && (
                        <div className="px-4 mb-2">
                            <div className="grid grid-cols-3 gap-2">
                                {[
                                    {
                                        label: 'Longest',
                                        value: `${records.longestPassageNM.toFixed(0)}`,
                                        unit: 'NM',
                                        icon: '🛣️',
                                    },
                                    {
                                        label: 'Fastest avg',
                                        value: `${records.fastestAvgKts.toFixed(1)}`,
                                        unit: 'kt',
                                        icon: '⚡',
                                    },
                                    {
                                        label: 'Longest trip',
                                        value: (() => {
                                            const h = records.longestDurationMs / 3600000;
                                            return h >= 24 ? `${Math.floor(h / 24)}d` : `${Math.round(h)}h`;
                                        })(),
                                        unit: '',
                                        icon: '⏱️',
                                    },
                                ].map((r) => (
                                    <div
                                        key={r.label}
                                        className="rounded-xl bg-slate-900/40 border border-amber-500/15 px-2 py-2 text-center"
                                    >
                                        <div className="text-[9px] uppercase tracking-wider text-amber-400/70 font-bold flex items-center justify-center gap-1">
                                            <span>{r.icon}</span>
                                            {r.label}
                                        </div>
                                        <div className="text-lg font-extrabold text-white tabular-nums mt-0.5">
                                            {r.value}
                                            {r.unit && (
                                                <span className="text-[10px] text-white/40 ml-0.5">{r.unit}</span>
                                            )}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {castOffHandoff &&
                        (castOffHandoff.caution ||
                            castOffHandoff.gps !== 'confirmed' ||
                            castOffHandoff.followNote ||
                            castOffHandoff.publishState === 'skipped' ||
                            castOffHandoff.publishState === 'failed' ||
                            castOffHandoff.publishState === 'queued') && (
                            <div className="px-4 mb-2 space-y-2">
                                {castOffHandoff.gps === 'starting' && !isTracking && (
                                    <div className="rounded-xl border border-emerald-400/25 bg-emerald-500/10 px-3 py-2.5 flex items-center gap-2.5">
                                        <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse shrink-0" />
                                        <p className="text-sm font-semibold text-emerald-100">
                                            Underway — GPS voyage logging is starting for “{castOffHandoff.voyageName}”…
                                        </p>
                                    </div>
                                )}
                                {castOffHandoff.gps === 'failed' && (
                                    <div
                                        role="alert"
                                        className="rounded-xl border border-amber-400/25 bg-amber-500/10 px-3 py-2.5 space-y-2"
                                    >
                                        <p className="text-sm font-semibold text-amber-100">
                                            Passage is active, but GPS voyage logging did not start.
                                            {castOffHandoff.gpsError ? ` ${castOffHandoff.gpsError}` : ''}
                                        </p>
                                        <button
                                            type="button"
                                            onClick={() => void startHandoffGps(true)}
                                            className="min-h-[44px] rounded-xl border border-amber-300/25 bg-amber-400/15 px-3 py-2 text-xs font-black text-amber-100"
                                        >
                                            Retry GPS Logging
                                        </button>
                                    </div>
                                )}
                                {castOffHandoff.followNote && (
                                    <div className="rounded-xl border border-amber-400/25 bg-amber-500/10 px-3 py-2.5 space-y-1.5">
                                        <p className="text-[11px] font-black uppercase tracking-[0.2em] text-amber-300">
                                            Route line not armed
                                        </p>
                                        <p className="text-sm text-amber-100">{castOffHandoff.followNote}</p>
                                        <button
                                            type="button"
                                            onClick={() => updateCastOffHandoff({ followNote: null })}
                                            className="hit-target-44 rounded-lg border border-amber-300/20 px-2 py-1 text-xs font-black text-amber-200/80"
                                        >
                                            Got it
                                        </button>
                                    </div>
                                )}
                                {(castOffHandoff.publishState === 'skipped' ||
                                    castOffHandoff.publishState === 'failed' ||
                                    castOffHandoff.publishState === 'queued') && (
                                    <div className="rounded-xl border border-amber-400/25 bg-amber-500/10 px-3 py-2.5 space-y-1.5">
                                        <p className="text-[11px] font-black uppercase tracking-[0.2em] text-amber-300">
                                            Public page
                                        </p>
                                        <p className="text-sm text-amber-100">
                                            {castOffHandoff.publishState === 'skipped'
                                                ? 'This route has no planned mirror the public page can draw. Open it in Route Tracer and save it again, then re-tick Show on the Public Page at your next Cast Off.'
                                                : castOffHandoff.publishState === 'queued'
                                                  ? 'The public-page link is queued — it will publish automatically when the connection allows.'
                                                  : 'Publishing the route to the public page failed. It will keep retrying in the background while online.'}
                                        </p>
                                        <button
                                            type="button"
                                            onClick={() => updateCastOffHandoff({ publishState: 'private' })}
                                            className="hit-target-44 rounded-lg border border-amber-300/20 px-2 py-1 text-xs font-black text-amber-200/80"
                                        >
                                            Got it
                                        </button>
                                    </div>
                                )}
                            </div>
                        )}

                    {isTracking ? (
                        <>
                            {/* ── TRACKING MODE: Live card fills entire space ── */}
                            {/* The fallback below exists because "tracking, but the
                                voyage id is momentarily unknown" used to render
                                LITERAL NOTHING — no card, no border, no map box —
                                which is exactly what Shane described: "not even the
                                outline of the box, just empty space" (2026-08-20).
                                The id can be briefly unknown mid cold-start resume;
                                the REGION must exist the whole time regardless. */}
                            {!currentVoyageId && (
                                <div className="flex-1 flex flex-col rounded-2xl bg-slate-900/40 border border-white/5 p-4">
                                    <div className="h-3 w-32 bg-white/10 rounded-sm mb-3 animate-pulse" />
                                    <div className="mt-3 flex-1 min-h-[100px] rounded-xl bg-[#0b1220] border border-white/5" />
                                </div>
                            )}
                            {currentVoyageId &&
                                (() => {
                                    const activeEntries = entries.filter((e) => e.voyageId === currentVoyageId);
                                    const dist =
                                        activeEntries.length > 0
                                            ? Math.max(0, ...activeEntries.map((e) => e.cumulativeDistanceNM || 0))
                                            : 0;
                                    const sorted = [...activeEntries].sort(
                                        (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
                                    );
                                    const first = sorted[0];
                                    const last = sorted[sorted.length - 1];
                                    const durationMs =
                                        first && last
                                            ? new Date(last.timestamp).getTime() - new Date(first.timestamp).getTime()
                                            : 0;
                                    const durationHrs = Math.floor(durationMs / 3600000);
                                    const durationMins = Math.floor((durationMs % 3600000) / 60000);
                                    const speeds = activeEntries.filter((e) => e.speedKts && e.speedKts > 0);
                                    const liveAvgSpeed =
                                        speeds.length > 0
                                            ? speeds.reduce((s, e) => s + (e.speedKts || 0), 0) / speeds.length
                                            : 0;
                                    return (
                                        <div className="flex-1 min-h-0 flex flex-col rounded-2xl bg-linear-to-br from-emerald-500/10 to-slate-900/80 border border-emerald-500/20 p-4 mx-4 mt-2 mb-2">
                                            <div className="flex items-center gap-2 mb-3 shrink-0">
                                                <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                                                <span className="text-xs font-bold text-red-400 uppercase tracking-wider">
                                                    Live Recording
                                                </span>
                                            </div>
                                            {first?.waypointName &&
                                                first.waypointName !== 'Voyage Start' &&
                                                first.waypointName !== 'Latest Position' && (
                                                    <div className="text-xs text-slate-400 mb-3 shrink-0">
                                                        Departed: {first.waypointName}
                                                    </div>
                                                )}
                                            <div className="grid grid-cols-3 gap-3 shrink-0">
                                                <div>
                                                    <div className="text-2xl font-extrabold text-emerald-400 tabular-nums">
                                                        {(dist ?? 0).toFixed(1)}
                                                    </div>
                                                    <div className="text-[11px] text-slate-500 uppercase">NM</div>
                                                </div>
                                                <div>
                                                    <div className="text-2xl font-extrabold text-emerald-400 tabular-nums">
                                                        {durationHrs}h {durationMins}m
                                                    </div>
                                                    <div className="text-[11px] text-slate-500 uppercase">Duration</div>
                                                </div>
                                                <div>
                                                    <div className="text-2xl font-extrabold text-emerald-400 tabular-nums">
                                                        {(liveAvgSpeed ?? 0).toFixed(1)}
                                                    </div>
                                                    <div className="text-[11px] text-slate-500 uppercase">Avg kts</div>
                                                </div>
                                            </div>

                                            {/* Engine on/off — declares propulsion so the
                                                voyage's sail/motor split is real data. */}
                                            <div className="flex items-center gap-2 mt-3 shrink-0">
                                                <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
                                                    Engine
                                                </span>
                                                <div className="flex rounded-full bg-slate-900/60 border border-white/10 p-0.5">
                                                    <button
                                                        onClick={() => toggleEngine(true)}
                                                        className={`hit-target-44 px-3 py-1 rounded-full text-[11px] font-bold uppercase tracking-wider transition-colors ${
                                                            engineRunning === true
                                                                ? 'bg-amber-500 text-white'
                                                                : 'text-white/55'
                                                        }`}
                                                    >
                                                        Motor
                                                    </button>
                                                    <button
                                                        onClick={() => toggleEngine(false)}
                                                        className={`hit-target-44 px-3 py-1 rounded-full text-[11px] font-bold uppercase tracking-wider transition-colors ${
                                                            engineRunning === false
                                                                ? 'bg-emerald-500 text-white'
                                                                : 'text-white/55'
                                                        }`}
                                                    >
                                                        Sailing
                                                    </button>
                                                </div>
                                                {engineRunning === undefined && (
                                                    <span className="text-[10px] text-white/50">— tap to log</span>
                                                )}
                                            </div>

                                            {/* Live Mini Map — grows to fill all remaining space.
                                                Tap to expand fullscreen. Until the first accepted
                                                fix lands there's nothing to draw, so say what's
                                                happening instead of showing a silent empty map.
                                                UNMOUNTED while any fullscreen map is open — iOS
                                                WebKit composites Leaflet's transformed layers above
                                                fixed overlays regardless of z-index, so a live map
                                                redrawing underneath bled through as a second track. */}
                                            <div className="mt-3 flex-1 min-h-[100px] relative">
                                                {!liveMapExpanded && !showTrackMap && (
                                                    <LiveMiniMap
                                                        entries={activeEntries}
                                                        followedRouteCoords={followedRouteCoords}
                                                        initialCenter={liveFix ?? currentFix}
                                                        height="100%"
                                                        isLive={true}
                                                        onTap={openLiveMap}
                                                    />
                                                )}
                                                {!showTrackMap && (
                                                    <button
                                                        ref={expandLiveMapRef}
                                                        type="button"
                                                        aria-label="Expand live map"
                                                        onClick={openLiveMap}
                                                        className="absolute bottom-2 right-2 z-10 flex h-11 w-11 items-center justify-center rounded-full border border-white/15 bg-slate-900/85 text-white/80 shadow-lg backdrop-blur-xs transition-transform active:scale-95"
                                                    >
                                                        <svg
                                                            className="h-4 w-4"
                                                            fill="none"
                                                            viewBox="0 0 24 24"
                                                            stroke="currentColor"
                                                            aria-hidden="true"
                                                        >
                                                            <path
                                                                strokeLinecap="round"
                                                                strokeLinejoin="round"
                                                                strokeWidth={2}
                                                                d="M4 9V4m0 0h5M4 4l6 6m10-1V4m0 0h-5m5 0l-6 6M4 15v5m0 0h5m-5 0l6-6m10 1v5m0 0h-5m5 0l-6-6"
                                                            />
                                                        </svg>
                                                    </button>
                                                )}
                                            </div>

                                            {/* ── Fullscreen live map — tap map (or chevron) to shrink ──
                                                transform-gpu promotes the overlay to its own composited
                                                layer so iOS can't paint underlying map tiles above it. */}
                                            {liveMapExpanded && (
                                                <OverlayPortal
                                                    ref={liveMapDialogRef}
                                                    className="bg-slate-950 transform-gpu"
                                                    role="dialog"
                                                    aria-modal="true"
                                                    aria-labelledby={liveMapTitleId}
                                                >
                                                    <LiveMiniMap
                                                        entries={activeEntries}
                                                        followedRouteCoords={followedRouteCoords}
                                                        height="100%"
                                                        isLive={true}
                                                        freeZoom={true}
                                                        onTap={closeLiveMap}
                                                        className="rounded-none! border-0!"
                                                    />

                                                    {/* Top info bar — same stats as the card */}
                                                    <div
                                                        className="absolute top-0 left-0 right-0 z-1001 px-4 pointer-events-none"
                                                        style={{ paddingTop: 'max(16px, env(safe-area-inset-top))' }}
                                                    >
                                                        <div className="flex items-center gap-2">
                                                            <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                                                            <span
                                                                id={liveMapTitleId}
                                                                className="text-xs font-bold text-red-400 uppercase tracking-wider drop-shadow-lg"
                                                            >
                                                                Live Recording
                                                            </span>
                                                        </div>
                                                        <div className="text-[13px] text-white/90 flex gap-4 mt-1.5 font-bold drop-shadow-lg tabular-nums">
                                                            <span>{(dist ?? 0).toFixed(1)} NM</span>
                                                            <span>
                                                                {durationHrs}h {durationMins}m
                                                            </span>
                                                            <span>{(liveAvgSpeed ?? 0).toFixed(1)} avg kts</span>
                                                            <span>{activeEntries.length} pts</span>
                                                        </div>
                                                        <div className="text-[10px] text-white/40 mt-1 drop-shadow-lg">
                                                            Tap map to shrink
                                                        </div>
                                                    </div>

                                                    {/* Explicit collapse affordance */}
                                                    <button
                                                        ref={shrinkLiveMapRef}
                                                        type="button"
                                                        aria-label="Shrink map"
                                                        onClick={closeLiveMap}
                                                        className="absolute right-4 z-1001 w-10 h-10 rounded-full bg-slate-900/80 border border-white/10 text-white/80 flex items-center justify-center active:scale-95 transition-transform"
                                                        style={{ top: 'max(16px, env(safe-area-inset-top))' }}
                                                    >
                                                        <svg
                                                            className="w-5 h-5"
                                                            fill="none"
                                                            viewBox="0 0 24 24"
                                                            stroke="currentColor"
                                                        >
                                                            <path
                                                                strokeLinecap="round"
                                                                strokeLinejoin="round"
                                                                strokeWidth={2}
                                                                d="M9 9L4 4m0 0v4m0-4h4m7 5l5-5m0 0v4m0-4h-4M9 15l-5 5m0 0v-4m0 4h4m7-5l5 5m0 0v-4m0 4h-4"
                                                            />
                                                        </svg>
                                                    </button>
                                                </OverlayPortal>
                                            )}
                                        </div>
                                    );
                                })()}

                            {/* ── Follow-route refusal notice ──
                                NOT a toast (Shane 2026-08-12: "i hate toast
                                messages"). When a pre-start route pick fails
                                after cast-off, the sheet that normally hosts
                                followBlockNotice is already closed — so the
                                same message renders here as a stay-put card.
                                IN NORMAL FLOW between the live map and the
                                Stop controls: the first cut was fixed-position
                                and sat on top of the map's bottom edge (Shane
                                2026-08-13: "that message is now showing up
                                there"). Here it pushes the map up instead of
                                covering it. */}
                            {followBlockNotice && followPromptVoyageId === null && !preStartSheetOpen && (
                                <div
                                    className="shrink-0 px-4 pt-2 animate-in fade-in slide-in-from-bottom-2 duration-300"
                                    role="alert"
                                >
                                    <div className="rounded-2xl bg-slate-900 border border-amber-500/40 shadow-lg shadow-black/40 px-4 py-3">
                                        <div className="flex items-start gap-2.5">
                                            <span aria-hidden="true" className="mt-px text-[15px] leading-none">
                                                {'⚠️'}
                                            </span>
                                            <p className="flex-1 text-[12px] leading-relaxed text-amber-100">
                                                {followBlockNotice}
                                            </p>
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
                            )}

                            {/* ── Stop / New Entry — pinned at bottom ── */}
                            <div
                                className="shrink-0 px-4 pt-2"
                                style={{ paddingBottom: 'calc(4rem + env(safe-area-inset-bottom) + 8px)' }}
                            >
                                <div className="flex gap-2">
                                    <button
                                        aria-label="Stop tracking"
                                        onClick={() => {
                                            triggerHaptic('medium');
                                            handleStopTracking();
                                        }}
                                        className="flex-1 h-14 rounded-2xl font-extrabold text-xs uppercase tracking-wider transition-all flex items-center justify-center gap-1.5 bg-red-500/15 border border-red-500/30 text-red-400 hover:bg-red-500/25 active:scale-[0.97]"
                                    >
                                        <StopIcon className="w-4 h-4" />
                                        Stop
                                    </button>
                                    <button
                                        aria-label="Share your position"
                                        onClick={handleShareCurrentPosition}
                                        className="w-14 h-14 shrink-0 rounded-2xl font-extrabold text-xs transition-all flex items-center justify-center bg-teal-500/15 border border-teal-500/30 text-teal-400 hover:bg-teal-500/25 active:scale-[0.97]"
                                        title="Share your position"
                                    >
                                        <MapPinIcon className="w-5 h-5" />
                                    </button>
                                    <button
                                        aria-label="Add log entry"
                                        onClick={() => dispatch({ type: 'SHOW_ADD_MODAL', show: true })}
                                        className="flex-1 h-14 px-4 rounded-2xl font-extrabold text-sm uppercase tracking-wider transition-all flex items-center justify-center gap-2 bg-linear-to-r from-sky-500 to-sky-600 hover:from-sky-400 hover:to-sky-500 text-white shadow-lg shadow-sky-500/25 active:scale-[0.98]"
                                    >
                                        <PlusIcon className="w-5 h-5" />
                                        New Log Entry
                                    </button>
                                </div>
                            </div>
                        </>
                    ) : (
                        <>
                            {/* ── NOT TRACKING: Scrollable voyage list ── */}
                            <div
                                className="flex-1 overflow-y-auto px-4 snap-y snap-proximity scroll-pt-2"
                                style={{ paddingBottom: 'calc(5rem + env(safe-area-inset-bottom) + 16px)' }}
                            >
                                {/* The smaller "X TODAY · Y VOYAGES · Z NM"
                                    status row that used to live here was
                                    removed 2026-05-17 — it was a duplicate
                                    of the three big gauge tiles up at the
                                    top of the page, just in worse formatting
                                    (and using a different — broken — data
                                    source for the totals). Career counts now
                                    live in one place: the gauge tile grid. */}

                                {/* Past Voyage Cards */}
                                {loading && loggedVoyages.length === 0 ? (
                                    /* History still hydrating (cache miss / first network
                                       load) — skeleton cards, NOT the "Begin Your Log"
                                       empty state, and never a page-wide spinner: the
                                       Start control below is live the whole time. */
                                    <div className="space-y-3 px-1 py-2" aria-label="Loading voyages">
                                        {[0, 1, 2].map((i) => (
                                            <div
                                                key={i}
                                                className="rounded-2xl bg-slate-900/40 border border-white/5 p-4 animate-pulse"
                                            >
                                                <div className="h-3 w-28 bg-white/10 rounded-sm mb-3" />
                                                <div className="h-2.5 w-44 bg-white/5 rounded-sm mb-2" />
                                                <div className="h-2.5 w-36 bg-white/5 rounded-sm" />
                                            </div>
                                        ))}
                                    </div>
                                ) : loggedVoyages.length === 0 ? (
                                    <div className="flex-1 flex flex-col items-center justify-center text-slate-400 px-6 py-12">
                                        {/* Decorative maritime line art */}
                                        <div className="relative w-24 h-24 mb-6">
                                            <svg viewBox="0 0 96 96" fill="none" className="w-full h-full">
                                                {/* Outer ring — dashed */}
                                                <circle
                                                    cx="48"
                                                    cy="48"
                                                    r="44"
                                                    stroke="rgba(56,189,248,0.12)"
                                                    strokeWidth="1"
                                                    strokeDasharray="3 5"
                                                />
                                                {/* Middle ring — solid faint */}
                                                <circle
                                                    cx="48"
                                                    cy="48"
                                                    r="32"
                                                    stroke="rgba(56,189,248,0.08)"
                                                    strokeWidth="0.5"
                                                />
                                                {/* Compass rose petals */}
                                                <path d="M48 4L51 44H45L48 4Z" fill="rgba(56,189,248,0.25)" />
                                                <path d="M48 92L45 52H51L48 92Z" fill="rgba(56,189,248,0.10)" />
                                                <path d="M4 48L44 45V51L4 48Z" fill="rgba(56,189,248,0.10)" />
                                                <path d="M92 48L52 51V45L92 48Z" fill="rgba(56,189,248,0.10)" />
                                                {/* Center dot */}
                                                <circle cx="48" cy="48" r="3" fill="rgba(56,189,248,0.30)" />
                                                {/* Track line suggestion — curved */}
                                                <path
                                                    d="M20 70 C32 55, 64 42, 76 28"
                                                    stroke="rgba(52,211,153,0.25)"
                                                    strokeWidth="1.5"
                                                    strokeDasharray="4 3"
                                                    strokeLinecap="round"
                                                />
                                                {/* Waypoint dots on the track */}
                                                <circle cx="20" cy="70" r="2.5" fill="rgba(52,211,153,0.35)" />
                                                <circle cx="48" cy="49" r="2" fill="rgba(52,211,153,0.25)" />
                                                <circle cx="76" cy="28" r="2.5" fill="rgba(52,211,153,0.35)" />
                                            </svg>
                                        </div>
                                        <p className="text-base font-bold text-white mb-1.5">Begin Your Log</p>
                                        <p className="text-[13px] text-white/40 max-w-[260px] text-center leading-relaxed">
                                            Every great voyage starts with a single position. Slide below to begin GPS
                                            tracking.
                                        </p>
                                    </div>
                                ) : (
                                    loggedVoyages.map((summary) => (
                                        <VoyageCard
                                            suppressMiniMap={showTrackMap || liveMapExpanded}
                                            recordBadge={
                                                records.voyageCount >= 2
                                                    ? records.longestPassageVoyageId === summary.voyageId
                                                        ? 'longest'
                                                        : records.fastestVoyageId === summary.voyageId
                                                          ? 'fastest'
                                                          : records.longestDurationVoyageId === summary.voyageId
                                                            ? 'longestTrip'
                                                            : null
                                                    : null
                                            }
                                            key={summary.voyageId}
                                            summary={summary}
                                            entries={entries.filter((e) => e.voyageId === summary.voyageId)}
                                            isSelected={selectedVoyageId === summary.voyageId}
                                            isExpanded={expandedVoyages.has(summary.voyageId)}
                                            onToggle={() => toggleVoyage(summary.voyageId)}
                                            onSelect={() => {
                                                void loadVoyageEntries(summary.voyageId);
                                                dispatch({ type: 'SELECT_VOYAGE', voyageId: summary.voyageId });
                                            }}
                                            onDelete={() => handleDeleteVoyageRequest(summary.voyageId)}
                                            onArchive={() => handleArchiveVoyage(summary.voyageId)}
                                            onShowMap={() => {
                                                void loadVoyageEntries(summary.voyageId);
                                                dispatch({ type: 'SELECT_VOYAGE', voyageId: summary.voyageId });
                                                dispatch({ type: 'SHOW_TRACK_MAP', show: true });
                                            }}
                                            onFollowPlannedRoute={followPlannedRouteLocally}
                                            onNeedEntries={() => loadVoyageEntries(summary.voyageId)}
                                            filteredEntries={filteredEntries}
                                            onDeleteEntry={handleDeleteEntry}
                                            onEditEntry={handleEditEntry}
                                        />
                                    ))
                                )}

                                {/* ── Archived Voyages ── */}
                                {loggedArchivedVoyages.length > 0 && (
                                    <div className="mt-4">
                                        <button
                                            aria-label="Toggle archived voyages"
                                            onClick={() => setShowArchived(!showArchived)}
                                            className="w-full flex items-center justify-between px-3 py-2 rounded-xl bg-amber-500/10 border border-amber-500/20 active:scale-[0.98] transition-all"
                                        >
                                            <div className="flex items-center gap-2">
                                                <svg
                                                    className="w-4 h-4 text-amber-400"
                                                    fill="none"
                                                    viewBox="0 0 24 24"
                                                    stroke="currentColor"
                                                >
                                                    <path
                                                        strokeLinecap="round"
                                                        strokeLinejoin="round"
                                                        strokeWidth={2}
                                                        d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8"
                                                    />
                                                </svg>
                                                <span className="text-xs font-bold text-amber-400 uppercase tracking-wider">
                                                    Archived Voyages
                                                </span>
                                                <span className="text-[11px] font-bold text-amber-300/60 bg-amber-500/15 px-1.5 py-0.5 rounded-full">
                                                    {loggedArchivedVoyages.length}
                                                </span>
                                            </div>
                                            <svg
                                                className={`w-4 h-4 text-amber-400 transition-transform ${showArchived ? 'rotate-180' : ''}`}
                                                fill="none"
                                                viewBox="0 0 24 24"
                                                stroke="currentColor"
                                            >
                                                <path
                                                    strokeLinecap="round"
                                                    strokeLinejoin="round"
                                                    strokeWidth={2}
                                                    d="M19 9l-7 7-7-7"
                                                />
                                            </svg>
                                        </button>

                                        {showArchived && (
                                            <div className="mt-2 space-y-2">
                                                {loggedArchivedVoyages.map((voyage) => (
                                                    <div
                                                        key={voyage.voyageId}
                                                        className="rounded-2xl bg-slate-900/30 backdrop-blur-md border border-amber-500/10 p-4 flex items-center justify-between"
                                                    >
                                                        <div className="min-w-0">
                                                            <div className="flex items-center gap-2 mb-0.5">
                                                                <span className="text-xs font-bold text-white/80">
                                                                    {new Date(
                                                                        voyage.entries[voyage.entries.length - 1]
                                                                            ?.timestamp || '',
                                                                    )
                                                                        .toLocaleDateString('en-AU', {
                                                                            day: '2-digit',
                                                                            month: 'short',
                                                                            year: '2-digit',
                                                                        })
                                                                        .toUpperCase()}
                                                                </span>
                                                                <span className="text-[11px] font-bold text-amber-400 bg-amber-500/15 px-1.5 py-0.5 rounded-full uppercase">
                                                                    Archived
                                                                </span>
                                                            </div>
                                                            <div className="text-[11px] text-white/60">
                                                                {voyage.entries.length} entries ·{' '}
                                                                {Math.max(
                                                                    0,
                                                                    ...voyage.entries.map(
                                                                        (e) => e.cumulativeDistanceNM || 0,
                                                                    ),
                                                                ).toFixed(1)}{' '}
                                                                NM
                                                            </div>
                                                        </div>
                                                        <button
                                                            aria-label="Unarchive voyage"
                                                            onClick={() => handleUnarchiveVoyage(voyage.voyageId)}
                                                            className="hit-target-44 px-3 py-1.5 rounded-lg text-[11px] font-bold text-amber-400 bg-amber-500/15 border border-amber-500/20 uppercase tracking-wider active:scale-[0.95] transition-all"
                                                        >
                                                            Unarchive
                                                        </button>
                                                    </div>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>

                            {/* ── Slide to Start CTA — pinned at bottom ── */}
                            <div
                                className="shrink-0 px-4 pt-2"
                                style={{ paddingBottom: 'calc(4rem + env(safe-area-inset-bottom) + 8px)' }}
                            >
                                {trackingStartFailure && (
                                    <div
                                        role="alert"
                                        aria-live="assertive"
                                        className="mb-2 rounded-xl border border-red-400/30 bg-red-500/10 px-3 py-2.5"
                                    >
                                        <div className="text-sm font-black text-red-200">
                                            {trackingStartFailure.title}
                                        </div>
                                        <p className="mt-1 text-xs leading-relaxed text-red-100/80">
                                            {trackingStartFailure.detail}
                                        </p>
                                        {trackingStartFailure.actionable && (
                                            <button
                                                type="button"
                                                onClick={openDeviceSettings}
                                                className="mt-2 min-h-[44px] rounded-xl border border-red-300/25 bg-red-400/15 px-3 py-2 text-xs font-black text-red-100"
                                            >
                                                Open Location Settings
                                            </button>
                                        )}
                                    </div>
                                )}
                                {!castOffHandoff ? (
                                    <SlideToAction
                                        label="Slide to Start Tracking"
                                        thumbIcon={<PlayIcon className="w-5 h-5 text-white" />}
                                        onConfirm={beginCastOff}
                                        loading={checkingStartGps}
                                        loadingText="Checking GPS…"
                                        theme="emerald"
                                    />
                                ) : null}
                            </div>
                        </>
                    )}
                </div>
            )}

            {/* ── Propulsion mismatch nudge ──
                Bottom banner (above the Stop controls) that appears only
                when the declared engine state and the live estimate
                sustainedly disagree. One tap fixes it; Dismiss snoozes.
                Honest wording ("Looks like…") — it's a forecast-grade
                estimate, not a certainty. pointer-events-auto so the
                buttons work; sits above the bottom nav. */}
            {showPropNudge && propConflict.suggested && (
                <div
                    className="fixed inset-x-0 z-10000 flex justify-center px-4 animate-in fade-in slide-in-from-bottom-4 duration-300"
                    style={{ bottom: 'calc(4rem + env(safe-area-inset-bottom) + 76px)' }}
                    role="alert"
                >
                    <div className="w-full max-w-sm rounded-2xl bg-slate-900/96 border border-sky-400/40 shadow-2xl shadow-black/50 px-4 py-3 backdrop-blur-md">
                        <div className="flex items-start gap-2.5">
                            <span className="text-lg leading-none mt-0.5">
                                {propConflict.suggested === 'sail' ? '⛵' : '⚙'}
                            </span>
                            <div className="min-w-0 flex-1">
                                <div className="text-[13px] font-bold text-white">
                                    {propConflict.suggested === 'sail'
                                        ? 'Looks like you’re sailing'
                                        : 'Looks like you’re under power'}
                                </div>
                                <div className="text-[11px] text-white/55 leading-snug mt-0.5">
                                    Logged as {engineRunning ? 'motoring' : 'sailing'} — switch it?
                                </div>
                                <div className="flex gap-2 mt-2.5">
                                    <button
                                        onClick={() => toggleEngine(propConflict.suggested === 'motor')}
                                        className="flex-1 h-9 rounded-xl bg-sky-500 text-white text-[12px] font-extrabold uppercase tracking-wider active:scale-[0.97] transition-transform"
                                    >
                                        Switch to {propConflict.suggested === 'sail' ? 'Sailing' : 'Motoring'}
                                    </button>
                                    <button
                                        onClick={() =>
                                            setNudgeDismiss({
                                                until: Date.now() + 10 * 60 * 1000,
                                                forDeclared: engineRunning,
                                            })
                                        }
                                        className="px-3 h-9 rounded-xl bg-white/10 text-white/60 text-[12px] font-bold active:scale-[0.97] transition-transform"
                                    >
                                        Dismiss
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* Empty-track tidy announcement — big friendly modal with a
                5 s countdown ring, replaces the plain toast. */}
            <EmptyTrackRemovedModal count={emptyPruneNotice} onClose={clearEmptyPruneNotice} />

            {/* The share-live departure prompt renders globally from
                <DeparturePrompts/> in App.tsx — see the note where its
                effect used to live. */}

            {/* Toast Notifications */}
            <toast.ToastContainer />

            {/* GPS Accuracy Disclaimer Modal */}
            <GpsDisclaimerModal
                isOpen={showGpsDisclaimer}
                onDismiss={async (dontShowAgain) => dismissGpsDisclaimer(dontShowAgain)}
            />

            {/* Manual Entry Modal */}
            <AddEntryModal
                isOpen={showAddModal}
                onClose={() => dispatch({ type: 'SHOW_ADD_MODAL', show: false })}
                onSuccess={loadData}
                selectedVoyageId={selectedVoyageId}
            />

            {/* Edit Entry Modal */}
            <EditEntryModal
                isOpen={editEntry !== null}
                entry={editEntry}
                onClose={() => dispatch({ type: 'SET_EDIT_ENTRY', entry: null })}
                onSave={handleSaveEdit}
            />

            {/* Full Track Map Viewer — shows selected voyage or all */}
            <TrackMapViewer
                isOpen={showTrackMap}
                onClose={() => dispatch({ type: 'SHOW_TRACK_MAP', show: false })}
                entries={trackMapEntries}
                followedRouteCoords={trackViewerFollowedRouteCoords}
            />

            {/* Community Track Browser */}
            {FEATURE_VISIBILITY.communityTrackSharing && (
                <CommunityTrackBrowser
                    isOpen={showCommunityBrowser}
                    onClose={() => dispatch({ type: 'SHOW_COMMUNITY_BROWSER', show: false })}
                    onImportComplete={loadData}
                />
            )}

            {/* ========== ACTION SHEET MODALS ========== */}

            {/* EXPORT ACTION SHEET */}
            {actionSheet === 'export' && (
                <ExportSheet
                    onClose={() => dispatch({ type: 'SET_ACTION_SHEET', sheet: null })}
                    selectedVoyageId={selectedVoyageId}
                    hasNonDeviceEntries={hasNonDeviceEntries}
                    onExportPDF={handleShare}
                    onExportGPX={handleExportGPX}
                />
            )}

            {FEATURE_VISIBILITY.communityTrackSharing && actionSheet === 'import' && (
                <ImportSheet
                    onClose={() => dispatch({ type: 'SET_ACTION_SHEET', sheet: null })}
                    onImportGPXFile={handleImportGPXFile}
                    onShowCommunityBrowser={() => {
                        dispatch({ type: 'SHOW_COMMUNITY_BROWSER', show: true });
                        dispatch({ type: 'SET_ACTION_SHEET', sheet: null });
                    }}
                    onImportComplete={loadData}
                />
            )}

            {actionSheet === 'share' && (
                <ShareSheet
                    onClose={() => dispatch({ type: 'SET_ACTION_SHEET', sheet: null })}
                    onShowShareForm={() => dispatch({ type: 'SET_ACTION_SHEET', sheet: 'share_form' })}
                    onShowCommunityBrowser={() => {
                        dispatch({ type: 'SHOW_COMMUNITY_BROWSER', show: true });
                        dispatch({ type: 'SET_ACTION_SHEET', sheet: null });
                    }}
                    onShareImage={handleShareImage}
                    hasNonDeviceEntries={hasNonDeviceEntries}
                    selectedVoyageId={selectedVoyageId}
                />
            )}

            {FEATURE_VISIBILITY.communityTrackSharing && actionSheet === 'share_form' && (
                <ShareFormSheet
                    onClose={() => dispatch({ type: 'SET_ACTION_SHEET', sheet: null })}
                    onBack={() => dispatch({ type: 'SET_ACTION_SHEET', sheet: 'share' })}
                    onShowCommunityBrowser={() => {
                        dispatch({ type: 'SHOW_COMMUNITY_BROWSER', show: true });
                        dispatch({ type: 'SET_ACTION_SHEET', sheet: null });
                    }}
                    onShareToCommunity={handleShareToCommunity}
                    shareAutoTitle={shareAutoTitle}
                    shareAutoRegion={shareAutoRegion}
                />
            )}

            {actionSheet === 'stats' && (
                <StatsSheet
                    onClose={() => dispatch({ type: 'SET_ACTION_SHEET', sheet: null })}
                    onSelectVoyage={(id) => {
                        // Stats need the full points: lazy-load the selected
                        // voyage, or ALL voyages for the "All Voyages" deep-dive.
                        if (id) void loadVoyageEntries(id);
                        else void loadAllEntries();
                        dispatch({ type: 'SELECT_VOYAGE', voyageId: id });
                    }}
                    onShowStats={() => dispatch({ type: 'SHOW_STATS', show: true })}
                    entries={loggedEntries}
                    selectedVoyageId={selectedVoyageId}
                    currentVoyageId={currentVoyageId ?? null}
                    voyageGroups={loggedVoyages}
                />
            )}

            {/* The route report, at cast-off. Acknowledging a no-go leg is a
                DECISION, and a decision can be made here — so it is, instead of
                a trip to Route Tracer to have the identical grading pass run
                again in front of the skipper. No chart and no fix controls:
                moving a waypoint is an EDIT and still belongs in the editor,
                which is why land-crossing legs never reach this modal. */}
            {ackReport && (
                <TraceReportModal
                    open
                    onClose={() => {
                        setAckReport(null);
                        setAckedLegs(new Set());
                    }}
                    pins={ackReport.points}
                    routeName={ackReport.name}
                    verdicts={ackReport.report.verdicts}
                    tideLabels={{}}
                    departureLabel={ackReport.report.tideWindowLabel}
                    ackedLegs={ackedLegs}
                    releaseGate={{ allowed: false, reason: '', verification: null }}
                    fixBusy={null}
                    onAckLeg={acknowledgeLeg}
                />
            )}

            {/* "Follow a route?" sheet — TWO doors. Pre-start: opens the
                moment Start Tracking is slid (the answer is applied when the
                voyage id lands). Post-start: the legacy cast-off ask for
                voyages started from other pages. "Just recording" skips both
                local follow mode and publication — and in pre-start mode it
                still starts the track (the slide already committed that). */}
            {(followPromptVoyageId !== null || preStartSheetOpen) &&
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
                                    <p className="flex-1 text-[12px] leading-relaxed text-amber-100">
                                        {followBlockNotice}
                                    </p>
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
                                                                ? error.message.slice(
                                                                      TRACE_ROUTE_USE_BLOCK_PREFIX.length,
                                                                  )
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
                                    className="w-full rounded-xl bg-white/10 py-2.5 text-[12px] font-black uppercase tracking-widest text-gray-300 active:scale-95 disabled:cursor-wait disabled:opacity-50"
                                >
                                    {followPromptLoadingId ? 'Loading route…' : 'Just recording'}
                                </button>
                            </div>
                        </div>
                    </div>,
                    document.body,
                )}

            {/* Voyage Choice Dialog - Continue or New */}
            {showVoyageChoiceDialog && (
                <VoyageChoiceDialog
                    onContinue={() => {
                        dispatch({ type: 'SHOW_VOYAGE_CHOICE', show: false });
                        void verifyGpsAndStart(continueLastVoyage, false);
                    }}
                    onNewVoyage={async () => {
                        dispatch({ type: 'SHOW_VOYAGE_CHOICE', show: false });
                        await verifyGpsAndStart(startTrackingWithNewVoyage, false);
                    }}
                    onCancel={() => dispatch({ type: 'SHOW_VOYAGE_CHOICE', show: false })}
                />
            )}

            {/* Stop Voyage Confirmation Dialog */}
            {showStopVoyageDialog && (
                <StopVoyageDialog
                    onConfirm={confirmStopVoyage}
                    onCancel={() => dispatch({ type: 'SHOW_STOP_DIALOG', show: false })}
                />
            )}

            {/* Delete Voyage Confirmation Modal */}
            {deleteVoyageId &&
                (() => {
                    const voyageEntries = entries.filter((e) => e.voyageId === deleteVoyageId);
                    const sortedEntries = [...voyageEntries].sort(
                        (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
                    );
                    const first = sortedEntries[0];
                    const last = sortedEntries[sortedEntries.length - 1];
                    const startDate = first ? new Date(first.timestamp) : new Date();
                    const endDate = last ? new Date(last.timestamp) : new Date();
                    const totalDays = Math.max(
                        1,
                        Math.ceil((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)),
                    );
                    const voyageTotalDistance = Math.max(...voyageEntries.map((e) => e.cumulativeDistanceNM || 0), 0);

                    const formatLoc = (e: ShipLogEntry | undefined) => {
                        if (!e) return 'Unknown';
                        const namedWaypoint = meaningfulLogEndpointName(e);
                        if (namedWaypoint) return namedWaypoint;
                        return formatEndpointCoordinates(e) ?? 'Unknown';
                    };

                    return (
                        <DeleteVoyageModal
                            isOpen={true}
                            onClose={() => dispatch({ type: 'REQUEST_DELETE_VOYAGE', voyageId: null })}
                            onExportFirst={handleExportThenDelete}
                            onDelete={handleConfirmDeleteVoyage}
                            voyageInfo={{
                                startLocation: formatLoc(first),
                                endLocation: formatLoc(last),
                                totalDays,
                                totalEntries: voyageEntries.length,
                                totalDistance: voyageTotalDistance,
                            }}
                        />
                    );
                })()}
            {/* Undo toast for entry deletion */}
            <UndoToast
                isOpen={!!deletedEntry}
                message={`Entry deleted`}
                onUndo={handleUndoDeleteEntry}
                onDismiss={handleDismissDeleteEntry}
                duration={5000}
            />
            {/* Undo toast for voyage deletion */}
            <UndoToast
                isOpen={!!deletedVoyage}
                message={`Voyage deleted`}
                onUndo={handleUndoDeleteVoyage}
                onDismiss={handleDismissDeleteVoyage}
                duration={5000}
            />

            {/* Shared voyage warning confirm dialog */}
            <ConfirmDialog
                isOpen={!!showSharedVoyageWarning}
                title="Legacy Shared Track"
                message={`This voyage has a legacy cloud track copy (${showSharedVoyageWarning?.trackInfo || 'untitled'}). Deleting the voyage will also remove that private copy.`}
                confirmLabel="Delete Anyway"
                cancelLabel="Cancel"
                destructive
                onConfirm={confirmDeleteSharedVoyage}
                onCancel={cancelDeleteSharedVoyage}
            />
        </div>
    );
};

// --- SUB-COMPONENTS ---
