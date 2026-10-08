/**
 * @filesize-justified Page orchestrator with shared state across list/detail/export views. Sub-views share 10+ state variables.
 */
/**
 * Log Page - Ship's GPS-based Log
 *
 * Pure rendering shell — all state management lives in useLogPageState hook.
 * This file is ONLY responsible for JSX layout.
 */

import React, { useState, useEffect, useRef, useCallback, useSyncExternalStore } from 'react';
import { Preferences } from '@capacitor/preferences';
import { Capacitor } from '@capacitor/core';
import { createLogger } from '../utils/createLogger';
import { triggerHaptic } from '../utils/system';

const log = createLogger('LogPage');
import { TraceReportModal } from '../components/map/TraceReportModal';
import { AddEntryModal } from '../components/AddEntryModal';
import { useToast } from '../components/Toast';
import { followCastOffRoute } from '../services/shiplog/followCastOffRoute';
import {
    clearCastOffHandoff,
    ensureActiveVoyageLogging,
    peekCastOffHandoff,
    retryPublicPublish,
    startHandoffGps,
    subscribeCastOffHandoff,
    updateCastOffHandoff,
} from '../services/castOffHandoff';
import { EditEntryModal } from '../components/EditEntryModal';
import { TrackMapViewer } from '../components/TrackMapViewer';
import { DeleteVoyageModal } from '../components/DeleteVoyageModal';
import { CommunityTrackBrowser } from '../components/CommunityTrackBrowser';

import { UndoToast } from '../components/ui/UndoToast';
import { useGpsHealth, gpsHealthMessage, openDeviceSettings } from '../hooks/useGpsHealth';
import { BgGeoManager, isVoyageLocationError } from '../services/BgGeoManager';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { useLogPageState } from '../hooks/useLogPageState';
import { useFollowRouteStore } from '../stores/followRouteStore';
import { useUI } from '../context/UIContext';
import { ShipLogEntry } from '../types';

import { reverseGeocode } from '../services/weatherService';
import { reverseGeocodeContext } from '../services/weather/api/geocoding';
import { matchPlannedRouteByCoords, type VoyageSummary } from '../services/shiplog/VoyageSummary';
import { voyageHasRecordedFix } from '../services/shiplog/helpers';
import { evaluatePropulsionConflict } from '../services/shiplog/propulsion';
import { ShipLogService } from '../services/ShipLogService';
import { acquireFreshOwnshipPosition, resolveOwnshipPosition } from '../services/ownshipPosition';
import { NmeaStore } from '../services/NmeaStore';
import { LocationStore } from '../stores/LocationStore';
import { VoyageLogService } from '../services/VoyageLogService';
import { fetchVoyageAsTrack, groupByVoyage } from '../services/shiplog/RoutesAndTracks';
import { requestTracerOpen } from '../services/deepLink';
import { useUIStore } from '../stores/uiStore';
import { buildFollowRoutePlanFromRoute } from '../services/shiplog/followRoutePlan';
import { VoyageCard } from './log/LogSubComponents';
import { PassageLogList } from './log/PassageLogList';
import { formatEndpointCoordinates } from './log/useEndpointNames';
import { VoyageChoiceDialog, StopVoyageDialog } from './log/VoyageDialogs';
import { ExportSheet } from './log/ExportSheet';
import { GpsDisclaimerModal } from './log/GpsDisclaimerModal';
import { StandInQuestionModal } from './log/StandInQuestionModal';
import { resolveTrackSourcePlan } from '../services/shiplog/trackSourceInputs';
import { applyStandInAnswer, type TrackSourcePlan } from '../services/shiplog/trackSourcePlan';
import type { StartTrackingOptions } from '../hooks/useLogPageState';
import { SkipperClaimNotice } from './log/SkipperClaimNotice';
import { ImportSheet } from './log/ImportSheet';
import { ShareSheet } from './log/ShareSheet';
import { ShareFormSheet } from './log/ShareFormSheet';
import { StatsSheet } from './log/StatsSheet';
import {
    publishFollowedRoute,
    publishFollowedRouteDetailed,
    clearFollowedRoute,
    type PublishFollowHold,
} from '../services/shiplog/publishFollowedRoute';
import { PLAN_LINK_INTENT_DROPPED_EVENT, type PlanLinkIntentDropped } from '../services/shiplog/planLinkIntent';
import {
    choseJustRecording,
    JUST_RECORDING_CHOSEN_EVENT,
    rememberJustRecording,
} from '../services/shiplog/recordingChoice';
import { currentRouteReplaceDecision, ROUTE_AUTHORITY_REFUSAL } from '../services/shiplog/routeAuthority';
import { useRemotePassage } from '../hooks/useRemotePassage';
import type { RemotePassage } from '../services/shiplog/remotePassage';
import { RemotePassageCard } from './log/RemotePassageCard';
import { isAuthIdentityScopeCurrent } from '../services/authIdentityScope';
import { FEATURE_VISIBILITY } from '../utils/featureVisibility';
import { LogSightingEntry } from '../components/sightings/LogSightingEntry';
import { tracedRouteDirectUseStatus, tracedRouteFollowGeometry } from '../services/traceDirectUseGate';
import { actOnCurrentTraceCheckReport, cancelTraceChecks, enqueueTraceChecks } from '../services/traceBackgroundCheck';
import { getTraceCheckOutcome } from '../services/traceCheckOutcomes';
import type { TraceFollowStatus } from '../services/traceVerification';
import { useTraceBackgroundChecks } from './log/useTraceBackgroundChecks';
import { useFollowRoutePickerIdentity } from '../hooks/useFollowRoutePickerIdentity';

import {
    NO_ENTRIES,
    NO_FOLLOWED_ROUTE,
    followingNotice,
    TRACE_CHECK_STORAGE_FULL,
    TRACE_ROUTE_USE_BLOCK_PREFIX,
    type FollowSheetChoice,
    type TrackingStartFailure,
} from './log/logPageTypes';
import {
    getIdentitySnapshot,
    meaningfulLogEndpointName,
    subscribeIdentitySnapshot,
    withFollowRouteLoadDeadline,
} from './log/logPageHelpers';
import {
    buildFollowPromptRows,
    collapseOutsideTrips,
    missingTripLegs,
    buildFollowSheetChoices,
    deriveCurrentFix,
    deriveEntriesByVoyage,
    deriveLiveStats,
    derivePlannedRouteLinkIds,
    derivePlannedVoyageIds,
    plannedRouteDryReasons,
    refreshFollowSheetStatuses,
    sameFollowStatus,
} from './log/logPageDerive';
import { ArchivedVoyagesSection } from './log/ArchivedVoyagesSection';
import { CastOffHandoffNotices } from './log/CastOffHandoffNotices';
import { FollowBlockNoticeCard } from './log/FollowBlockNoticeCard';
import { FollowRoutePromptSheet } from './log/FollowRoutePromptSheet';
import { LiveVoyageCard } from './log/LiveVoyageCard';
import { LogPageHeader } from './log/LogPageHeader';
import { LogHistoryScroll } from './log/LogHistoryScroll';
import { LogStatsFullscreen } from './log/LogStatsFullscreen';
import { VoyageStatsRollup } from './log/VoyageStatsRollup';
import { HistoryStatusLine } from './log/HistoryStatusLine';
import { PropulsionNudge } from './log/PropulsionNudge';
import { StartTrackingFooter } from './log/StartTrackingFooter';
import { TrackingFooterControls } from './log/TrackingFooterControls';
import { VoyageListEmptyState, VoyageListSkeleton } from './log/VoyageListPlaceholders';

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
 * Same module-scope pattern for the page-local live-map toggle, which was
 * resetting on every tab-bounce ("I literally have to start all over again",
 * Shane mid-voyage 2026-08-01). The reducer-owned view state has its own memo
 * in useLogPageState; this one lives here because it never joined the
 * reducer. Cleared on identity change alongside the prompt guards. (The
 * archive's open state had a memo too while it was an inline disclosure; as a
 * sheet, restoring it popped the dialog open by itself on a split-view
 * tab-bounce, 2026-10-06, so it starts closed.)
 */
let liveMapExpandedMemo = false;

/**
 * A Start's source plan (build 123, package VL) stays good this long: the
 * Continue / New dialog straight after a Start, and the follow sheet's warm-up,
 * reuse it instead of asking the Pi — or the skipper — again.
 */
const PLAN_REUSE_MS = 120_000;

/** Voyages whose location advisory card the skipper has put away ("Got it"). Module scope: it survives a tab-bounce. */
const dismissedAdvisoryVoyages = new Set<string>();

/** The live voyage's stand-in question (build 123 review), as an external store. */
const subscribeStandInQuestion = (listener: () => void) => ShipLogService.subscribeStandInQuestion(listener);
const readStandInQuestion = () => ShipLogService.isStandInQuestionPending();
const serverStandInQuestion = () => false;

/** Test-only: the guards outlive component instances BY DESIGN, which also
 *  makes them outlive test cases — each spec must start unprompted. */
export function resetFollowPromptGuardsForTest(): void {
    confirmedFollowVoyages.clear();
    dismissedFollowVoyages.clear();
    dismissedAdvisoryVoyages.clear();
    liveMapExpandedMemo = false;
}

export const LogPage: React.FC<{ onBack?: () => void }> = ({ onBack }) => {
    const identityScope = useSyncExternalStore(subscribeIdentitySnapshot, getIdentitySnapshot, getIdentitySnapshot);
    const preStartAnswerRef = React.useRef<VoyageSummary | 'none' | null>(null);
    const rememberStartedRecordingChoice = useCallback(
        (voyageId: string) => {
            if (!isAuthIdentityScopeCurrent(identityScope) || preStartAnswerRef.current !== 'none') return;
            dismissedFollowVoyages.add(voyageId);
            rememberJustRecording(voyageId, identityScope);
        },
        [identityScope],
    );

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
            !castOffHandoff.followCaution &&
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
        lifetimeStats,
        lifetimeLoading,
        lifetimeError,
        lifetimeLoaded,
        loadVoyageEntries,
        hasNonDeviceEntries,
        totalDistance: _totalDistance,
        avgSpeed: _avgSpeed,
        // Archive
        archivedVoyages,
        archivesLoading,
        archiveError,
        reloadArchivedVoyages,
        handleArchiveVoyage,
        handleArchivePassage,
        handleUnarchiveVoyage,
        handleRestorePassage,
        // Empty-track tidy announcement
    } = useLogPageState(rememberStartedRecordingChoice);

    // ── The passage the ACCOUNT is running on another device (2026-09-08) ──
    // Server truth: the active voyage (stamped with the device that cast off)
    // and its followed-route link (stamped with the device that set it). This
    // device shows it, draws its route, and never overwrites it without a
    // confirm that names the other device.
    const { remote: remotePassage, refresh: refreshRemotePassage } = useRemotePassage({
        enabled: !!identityScope.userId,
        trackingVoyageId: state.isTracking ? (state.currentVoyageId ?? null) : null,
    });
    const remotePassageRef = useRef<RemotePassage | null>(null);
    remotePassageRef.current = remotePassage;
    /** The follow sheet is open ON BEHALF of the remote passage (its voyage id). */
    const remoteSheetVoyageRef = useRef<string | null>(null);
    const [remoteJoinBusy, setRemoteJoinBusy] = useState(false);
    /** Another device's route stands on the voyage this pick would publish
     *  to — the centred confirm that names it, then replaces on yes. */
    const [replaceRequest, setReplaceRequest] = useState<{
        planVoyageId: string;
        forVoyageId?: string;
        hold: PublishFollowHold;
    } | null>(null);

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
        // Called directly (the module is already imported above), so the retry
        // is tracked from the first tick and castOffHandoffIdle sees it.
        void retryPublicPublish();
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
            ).then(({ note, caution }) => {
                if (note || caution) updateCastOffHandoff({ followNote: note, followCaution: caution });
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
     * Which row is fetching its waypoints from the account.
     *
     * Deliberately NOT followPromptLoadingId: that one disables every row, the
     * "Just recording" footer AND the escape from the sheet, so borrowing it
     * would trap the skipper inside the picker at cast-off for as long as a
     * network fetch took. This gates one row's button and nothing else.
     */
    const [recheckingRouteId, setRecheckingRouteId] = React.useState<string | null>(null);
    /** Voyage rows whose red finding the skipper accepted with the second tap. */
    const acceptedFindingsRef = React.useRef(new Set<string>());
    /** The status of the line the last follow started — amber says so, once,
     *  in words that match WHY it is amber. */
    const followStatusRef = React.useRef<TraceFollowStatus | null>(null);
    /**
     * The route report, shown right here at cast-off so a skipper can
     * acknowledge no-go legs without a round trip to Route Tracer. Holds the
     * grading the background check already did — never re-run for this.
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
    const [followPromptChoices, setFollowPromptChoices] = React.useState<FollowSheetChoice[]>([]);
    // Legs saved in Route Tracer but never mirrored into the log still appear
    // under their passage, disabled, with the fix one line away.
    const followPromptRows = React.useMemo(
        () => buildFollowPromptRows(followPromptChoices, missingTripLegs(followPromptChoices)),
        [followPromptChoices],
    );

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
    const [followNotice, setFollowNotice] = React.useState<string | null>(null);

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
        // Opened from the remote-passage card: closing it changes nothing —
        // the other device's line stays drawn here and published there.
        if (promptVid !== null && remoteSheetVoyageRef.current === promptVid) {
            remoteSheetVoyageRef.current = null;
            setFollowPromptVoyageId(null);
            return;
        }
        const confirmed = promptVid !== null && confirmedFollowVoyages.has(promptVid);
        if (promptVid && !confirmed) {
            dismissedFollowVoyages.add(promptVid);
            rememberJustRecording(promptVid, identityScope);
        }
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
    const plannedVoyageIds = React.useMemo(
        () => derivePlannedVoyageIds(state.entries, state.summaries),
        [state.entries, state.summaries],
    );
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
    const loggedArchivedVoyages = React.useMemo(
        () => archivedVoyages.filter((voyage) => !voyage.isPlannedRoute),
        [archivedVoyages],
    );
    // Stats-view scope — filtered once per change and shared by the tiles and
    // the VoyageStatsPanel (it used to be filtered twice per render).
    const scopedStatsEntries = React.useMemo(
        () =>
            state.selectedVoyageId
                ? filteredEntries.filter((e) => e.voyageId === state.selectedVoyageId)
                : loggedFilteredEntries,
        [state.selectedVoyageId, filteredEntries, loggedFilteredEntries],
    );

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

    const currentFix = React.useMemo(
        () => deriveCurrentFix(state.entries, state.currentVoyageId),
        [state.entries, state.currentVoyageId],
    );

    // One row per passage — the ⇄ reverse of a saved route is a separate
    // voyage, so the picker was listing every passage twice. Pure + tested in
    // collapseReversedRoutes (it can HIDE a route if wrong, which does not look
    // like a bug from the cockpit — it looks like a route you saved simply not
    // being offered).
    /** voyageId → savedRouteId, read off the resident plan entries (the link
     *  lives on entries, not summaries). */
    const residentRouteLinkIds = React.useMemo(() => derivePlannedRouteLinkIds(state.entries), [state.entries]);
    const followRouteIdentity = useFollowRoutePickerIdentity(
        plannedSummaries,
        residentRouteLinkIds,
        state.entries,
        identityScope,
    );
    const {
        links: plannedRouteLinkIds,
        geometryLinks: plannedRouteGeometryIds,
        reconcileSnapshot: reconcileFollowSnapshot,
    } = followRouteIdentity;

    // There-and-back day sails fold into one choice; a trip's legs never do
    // (Shane 2026-09-08: the fold ate the last leg of Newport → Whitsundays
    // under its own homeward twin).
    const plannedChoices = React.useMemo(
        () => collapseOutsideTrips(followRouteIdentity.summaries, plannedRouteLinkIds, currentFix),
        [followRouteIdentity.summaries, plannedRouteLinkIds, currentFix],
    );

    // A plan the router drew red where no tide clears it is a red finding
    // too (package 125-05), read off its resident notes.
    const plannedDryReasons = React.useMemo(() => plannedRouteDryReasons(state.entries), [state.entries]);

    /**
     * EVERY planned route reaches the sheet, carrying its follow status. The
     * history matters: pick-then-refuse (Shane 2026-08-10: "just show tracks
     * that are ready to be followed"), hide-the-blocked (2026-08-13: "the
     * saved routes do not show up"), visible-but-disabled, tap-to-fix — and
     * since build 124 a warning, not a wall (2026-10-08: "punters just aren't
     * going to use it"): amber follows on the first tap with its reason on the
     * row, re-checking itself in the background; only a real check's red
     * finding takes a deliberate second tap.
     *
     * Two link sources, because entries may not be resident on a fresh boot:
     * the entry rows when loaded, else the local trace store's own
     * plannedRouteId mirror. An ordinary plan (no trace link) has no gate to
     * fail and is always pickable — unless the router drew it red where no
     * tide clears it (package 125-05): its resident notes make it a red
     * finding too (plannedDryReasons, above).
     */
    const followSheetChoices = React.useMemo(
        () => buildFollowSheetChoices(plannedChoices, plannedRouteLinkIds, undefined, plannedDryReasons),
        [plannedChoices, plannedRouteLinkIds, plannedDryReasons],
    );

    // A historical mirror can be identified after the sheet opened. Refine
    // only that frozen snapshot, preserving its directions and membership;
    // never reload/sort the live voyage list under a skipper's finger.
    React.useEffect(() => {
        if (
            (!preStartSheetOpen && followPromptVoyageId === null) ||
            followPromptLoadingId ||
            recheckingRouteId ||
            ackReport
        )
            return;
        setFollowPromptChoices((previous) => {
            const identity = reconcileFollowSnapshot(previous.map((choice) => choice.summary));
            const keep = new Set(identity.summaries.map((summary) => summary.voyageId));
            // An ordinary plan's red (package 125-05) is its notes', not a
            // check's: keep it, whether read from them or found at the pick.
            const dry = new Map(plannedDryReasons);
            for (const choice of previous)
                if (!choice.savedRouteId && choice.followStatus?.tone === 'finding' && choice.followStatus.reason)
                    dry.set(choice.summary.voyageId, choice.followStatus.reason);
            const next = buildFollowSheetChoices(
                previous.filter((choice) => keep.has(choice.summary.voyageId)),
                identity.links,
                undefined,
                dry,
            );
            const unchanged =
                next.length === previous.length &&
                next.every((choice, index) => {
                    const prior = previous[index];
                    return (
                        choice.summary === prior.summary &&
                        choice.savedRouteId === prior.savedRouteId &&
                        choice.tripId === prior.tripId &&
                        choice.legOrdinal === prior.legOrdinal &&
                        choice.tripName === prior.tripName &&
                        choice.legName === prior.legName &&
                        sameFollowStatus(choice.followStatus, prior.followStatus)
                    );
                });
            return unchanged ? previous : next;
        });
    }, [
        reconcileFollowSnapshot,
        preStartSheetOpen,
        followPromptVoyageId,
        followPromptLoadingId,
        recheckingRouteId,
        ackReport,
        plannedDryReasons,
    ]);

    /** A check landed or was recovered: re-read the open sheet's statuses. */
    const refreshFollowStatuses = React.useCallback(() => {
        setFollowPromptChoices((prev) => refreshFollowSheetStatuses(prev));
    }, []);
    const followSheetOpen = followPromptVoyageId !== null || preStartSheetOpen;
    const sheetTraceIds = React.useMemo(
        () =>
            followSheetOpen
                ? followPromptRows.flatMap((row) =>
                      row.type === 'choice' && row.row.choice.savedRouteId ? [row.row.choice.savedRouteId] : [],
                  )
                : null,
        [followSheetOpen, followPromptRows],
    );
    const plannedTraceIds = React.useMemo(
        () => followSheetChoices.flatMap((choice) => (choice.savedRouteId ? [choice.savedRouteId] : [])),
        [followSheetChoices],
    );
    // Background re-checks (build 124): one route at a time while this page is
    // open, queued when the sheet opens and after ten idle seconds.
    const traceChecks = useTraceBackgroundChecks({
        identityScope,
        sheetTraceIds,
        plannedTraceIds,
        onStatusesChanged: refreshFollowStatuses,
        onReport: (savedRouteId, { report, points }) => {
            // The pins come WITH the report (125-07): re-reading the trace here
            // could pair a sync's new pins with verdicts graded on the old.
            if (report.verdicts.length !== points.length - 1) return;
            void import('../services/routeTracer').then(({ loadSavedTraces }) => {
                const trace = loadSavedTraces().find((t) => t.id === savedRouteId);
                if (!trace) return;
                setAckedLegs(new Set());
                setAckReport({
                    savedRouteId,
                    name: trace.name,
                    points,
                    report,
                    priorDepartureMs: trace.verification?.departureMs ?? null,
                });
            });
        },
    });

    /**
     * A leg was acknowledged on the report. Re-run the release GATE (pure and
     * cheap) — never the check itself, which already ran. The moment the gate
     * allows, bank the envelope (the one safe bank) and the row goes green.
     */
    const reviewTraceCheck = traceChecks.review;
    const acknowledgeLeg = React.useCallback(
        (legIndex: number) => {
            if (!ackReport) return;
            const actionScope = identityScope;
            const nextAcks = new Set(ackedLegs).add(legIndex);
            setAckedLegs(nextAcks);
            void (async () => {
                const [{ releaseWithAcks }, { bankTraceVerification }] = await Promise.all([
                    import('../services/traceRecheck'),
                    import('../services/routeTracer'),
                ]);
                if (!isAuthIdentityScopeCurrent(actionScope)) return;
                // The memoKey again, at the moment of banking (125-07): a draft
                // sync or new charts while the sheet was open must not bank
                // verdicts graded for another keel. Compared and banked in one
                // synchronous step.
                const outcome = await actOnCurrentTraceCheckReport(ackReport.savedRouteId, ackReport.report, (held) => {
                    const gate = releaseWithAcks(held.points, held.report, nextAcks, ackReport.priorDepartureMs);
                    if (!gate.allowed || !gate.verification) return 'more' as const; // more legs to go
                    return bankTraceVerification(ackReport.savedRouteId, gate.verification, actionScope);
                });
                if (outcome === 'more') return;
                if (!isAuthIdentityScopeCurrent(actionScope)) return;
                setAckReport(null);
                setAckedLegs(new Set());
                if (!outcome) {
                    log.warn('acknowledgement not banked: the route, draft or charts changed; re-checking');
                    reviewTraceCheck(ackReport.savedRouteId);
                    return;
                }
                if (!outcome.banked) log.warn(`acknowledged check not banked (${outcome.reason})`);
                refreshFollowStatuses();
                setFollowNotice(outcome.reason === 'storage' ? TRACE_CHECK_STORAGE_FULL : null);
            })();
        },
        [ackReport, ackedLegs, identityScope, refreshFollowStatuses, reviewTraceCheck],
    );

    /**
     * Put a saved route on THIS device if only the account has it — a second
     * device, or this one after a reinstall — keeping its id so the follow
     * link, the check and Cast Off all still agree which route it is. Then
     * look for its check on the server (B3).
     */
    const ensureTraceOnDevice = React.useCallback(
        async (savedRouteId: string, actionScope: typeof identityScope): Promise<string | null> => {
            const [{ loadSavedTraces, adoptServerRoute }, { fetchSavedRoutePoints }] = await Promise.all([
                import('../services/routeTracer'),
                import('../services/savedRoutePoints'),
            ]);
            if (!isAuthIdentityScopeCurrent(actionScope)) return '';
            const local = loadSavedTraces().find((t) => t.id === savedRouteId);
            if (local && local.points.length >= 2) return null;
            const fetched = await fetchSavedRoutePoints(savedRouteId);
            if (!isAuthIdentityScopeCurrent(actionScope)) return '';
            if (!fetched.ok) return fetched.reason;
            if (!adoptServerRoute(fetched.id, fetched.name, fetched.points, undefined, fetched)) {
                return 'Could not store this route on this device. Free up space and try again.';
            }
            void import('../services/traceCheckRecovery')
                .then(({ recoverTraceChecks }) => recoverTraceChecks(actionScope, [savedRouteId]))
                .then(() => refreshFollowStatuses())
                .catch(() => undefined);
            return null;
        },
        [refreshFollowStatuses],
    );

    /**
     * A row's Check now. A route only the account holds (another phone, a
     * reinstall) is adopted onto this device first — the queue checks what is
     * stored HERE, so without this the tap ran, found nothing and changed
     * nothing.
     */
    const checkRouteNow = React.useCallback(
        async (savedRouteId: string) => {
            const actionScope = identityScope;
            if (!isAuthIdentityScopeCurrent(actionScope)) return;
            setFollowNotice(null);
            setRecheckingRouteId(savedRouteId);
            const problem = await ensureTraceOnDevice(savedRouteId, actionScope).catch(
                () => 'Couldn’t fetch this route from your account. Try again.',
            );
            setRecheckingRouteId(null);
            if (!isAuthIdentityScopeCurrent(actionScope) || problem === '') return;
            if (problem) {
                log.warn(`check now: route not on this device (${problem})`);
                setFollowNotice(problem);
                return;
            }
            enqueueTraceChecks([savedRouteId], 'manual');
        },
        [identityScope, ensureTraceOnDevice],
    );

    const openRouteInTracer = React.useCallback(
        async (savedRouteId: string | null) => {
            const actionScope = identityScope;
            if (!isAuthIdentityScopeCurrent(actionScope)) return;

            // The tracer loads a saved route from localStorage, so on a second
            // device — or the same one after a reinstall — it opens to nothing
            // and does it SILENTLY (MapHub's load-saved branch has no else).
            // Adopt it from the account under the SAME id first; stay put and
            // say why if that fails — navigating to a tracer that will open
            // empty is how this dead-ended before.
            if (savedRouteId) {
                setRecheckingRouteId(savedRouteId);
                const problem = await ensureTraceOnDevice(savedRouteId, actionScope);
                setRecheckingRouteId(null);
                if (!isAuthIdentityScopeCurrent(actionScope)) return;
                if (problem !== null) {
                    if (problem) setFollowNotice(problem);
                    return;
                }
            }

            setPreStartSheetOpen(false);
            setFollowPromptVoyageId(null);
            requestTracerOpen(savedRouteId ? { kind: 'load-saved', id: savedRouteId } : null, actionScope);
            useUIStore.getState().setPage('voyage');
        },
        [identityScope, ensureTraceOnDevice],
    );

    /**
     * Start local follow mode from recovered saved geometry. Resident entries
     * can start immediately; otherwise the caller remains in a visible loading
     * state while this fetches the voyage. Summary endpoints alone are not
     * drawn because a straight chord can cross land or shoals.
     */
    /** A red finding's deliberate second tap on a voyage card's Follow (the
     *  sheet's rows accept through acceptFindingFor, the same set). */
    const acceptPlannedRouteFinding = React.useCallback((voyageId: string) => {
        acceptedFindingsRef.current.add(voyageId);
    }, []);

    const followPlannedRouteLocally = React.useCallback(
        async (summary: VoyageSummary): Promise<boolean> => {
            const actionScope = identityScope;
            const voyageId = summary.voyageId;
            if (!voyageId || !isAuthIdentityScopeCurrent(actionScope)) return false;
            const pickerTraceId = plannedRouteGeometryIds.get(voyageId);

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
                // A linked trace only the account holds (another phone, a
                // reinstall) is adopted alongside the fetch; it then follows
                // amber instead of being refused (build 124).
                const adopting = pickerTraceId
                    ? ensureTraceOnDevice(pickerTraceId, actionScope).catch(() => null)
                    : null;
                const fetchedRoute = await withFollowRouteLoadDeadline(fetchVoyageAsTrack(voyageId));
                if (adopting) await withFollowRouteLoadDeadline(adopting);
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
                // Keep the picker’s proven canonical identity through the use
                // gate too. Legacy entries may predate saved_route_id; otherwise
                // the grouped row would be checked in the picker but treated as
                // an unlinked ordinary plan when actually followed.
                const linkedRoute =
                    !logRoute.savedRouteId && pickerTraceId ? { ...logRoute, savedRouteId: pickerTraceId } : logRoute;
                const steerRoute = tracedRouteFollowGeometry(linkedRoute);
                // A warning, not a wall (build 124): amber follows; only a red
                // finding refuses, until the row's second tap accepts it.
                const acceptFinding = acceptedFindingsRef.current.has(voyageId);
                const status = tracedRouteDirectUseStatus(steerRoute, { acceptFinding });
                if (status.blocked) {
                    // The snapshot row may predate the finding: turn it red.
                    refreshFollowStatuses();
                    // An ordinary plan's finding is its own notes' (package
                    // 125-05: red where no tide clears it), not a check's.
                    if (!steerRoute.savedRouteId) {
                        const { blocked: _blocked, ...finding } = status;
                        setFollowPromptChoices((prev) =>
                            prev.map((choice) =>
                                choice.summary.voyageId === voyageId &&
                                !choice.savedRouteId &&
                                !sameFollowStatus(choice.followStatus, finding)
                                    ? { ...choice, followStatus: finding }
                                    : choice,
                            ),
                        );
                    }
                    throw new Error(
                        `${TRACE_ROUTE_USE_BLOCK_PREFIX}${status.reason ?? 'The route check found a problem'}. Tap the route twice to follow anyway.`,
                    );
                }
                const exactPlan = buildFollowRoutePlanFromRoute(steerRoute);
                if (!exactPlan) return false;
                current.startFollowing(exactPlan, voyageId, steerRoute.points);
                followStatusRef.current = status;
                return true;
            } catch (error) {
                if (error instanceof Error && error.message.startsWith(TRACE_ROUTE_USE_BLOCK_PREFIX)) throw error;
                log.warn('Could not hydrate followed route geometry:', error);
                return false;
            }
        },
        [identityScope, state.entries, plannedRouteGeometryIds, ensureTraceOnDevice, refreshFollowStatuses],
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
            setFollowNotice(null);
            followStatusRef.current = null;
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
                // Picked on behalf of the passage another device is recording:
                // publish against THAT voyage, not one this device tracks.
                const forVoyageId =
                    promptVid !== null && remoteSheetVoyageRef.current === promptVid ? promptVid : undefined;
                if (forVoyageId) remoteSheetVoyageRef.current = null;

                const started = await followPlannedRouteLocally(s);
                if (!isAuthIdentityScopeCurrent(actionScope)) return;

                if (started) {
                    // Verification and exact geometry are now known. Only at
                    // this point may either the cockpit or public page
                    // advertise the line; racing publication before this gate
                    // let a legacy unverified trace bypass MapHub.
                    const publishPromise = Promise.resolve(
                        publishFollowedRouteDetailed(s.voyageId, { forVoyageId }),
                    ).catch((error) => {
                        log.warn('publish followed route failed:', error);
                        return {
                            result: 'error',
                        } as import('../services/shiplog/publishFollowedRoute').PublishFollowOutcome;
                    });
                    answered();
                    // Following an unchecked line is allowed — and said, once,
                    // quietly. The row already showed why it was amber. (The
                    // follow set the ref inside an await; TS still sees the
                    // null assigned above.)
                    const followed = followStatusRef.current as TraceFollowStatus | null;
                    if (followed?.tone === 'unchecked') setFollowNotice(followingNotice(followed.code));
                    void publishPromise.then(({ result, hold }) => {
                        if (!isAuthIdentityScopeCurrent(actionScope)) return;
                        if (result === 'linked') {
                            toast.success('Your public page now follows this route');
                        } else if (result === 'queued') {
                            toast.info('Following — your public page will update when signal returns');
                        } else if (result === 'not-tracking') {
                            toast.info('Following locally — start tracking to update your public page');
                        } else if (result === 'held-elsewhere' && hold) {
                            // Another device's route stands — ask, naming it
                            // (authorship 2026-09-08). The chart line is
                            // already this route; only the public page waits.
                            requestRouteReplaceRef.current({ planVoyageId: s.voyageId, forVoyageId, hold });
                        } else {
                            toast.error('Following locally — couldn’t update your public page');
                        }
                    });
                    return;
                }
                setFollowNotice('Couldn’t load this saved route — please try again');
            } finally {
                if (isAuthIdentityScopeCurrent(actionScope)) {
                    setFollowPromptLoadingId(null);
                }
            }
        },
        [identityScope, followPlannedRouteLocally, toast],
    );

    // ── Replacing a route ANOTHER device published (authorship 2026-09-08) ──
    /** Display name for a planned-route voyage id, from the sheet's own rows. */
    const routeLabelFor = React.useCallback(
        (planVoyageId: string | null | undefined): string | null => {
            if (!planVoyageId) return null;
            const choice = followSheetChoices.find((c) => c.summary.voyageId === planVoyageId);
            return choice?.legName ?? choice?.tripName ?? null;
        },
        [followSheetChoices],
    );
    const performRouteReplace = React.useCallback(
        async (req: { planVoyageId: string; forVoyageId?: string }) => {
            const actionScope = identityScope;
            const result = await Promise.resolve(
                publishFollowedRoute(req.planVoyageId, { replace: true, forVoyageId: req.forVoyageId }),
            ).catch(() => 'error' as const);
            if (!isAuthIdentityScopeCurrent(actionScope)) return;
            if (result === 'linked') toast.success('Your public page now follows this route');
            else if (result === 'queued') toast.info('Following — your public page will update when signal returns');
            else toast.error('Following locally — couldn’t update your public page');
            refreshRemotePassage();
        },
        [identityScope, refreshRemotePassage, toast],
    );
    const requestRouteReplace = React.useCallback(
        (req: { planVoyageId: string; forVoyageId?: string; hold: PublishFollowHold }) => {
            // Dark gate (services/shiplog/routeAuthority.ts): default asks;
            // 'skipper' lets the claim holder through and tells the rest.
            const decision = currentRouteReplaceDecision();
            if (decision === 'refuse') {
                setFollowNotice(ROUTE_AUTHORITY_REFUSAL);
                return;
            }
            if (decision === 'replace') {
                void performRouteReplace(req);
                return;
            }
            setReplaceRequest(req);
        },
        [performRouteReplace],
    );
    const requestRouteReplaceRef = React.useRef(requestRouteReplace);
    requestRouteReplaceRef.current = requestRouteReplace;
    const confirmRouteReplace = React.useCallback(() => {
        const req = replaceRequest;
        setReplaceRequest(null);
        if (req) void performRouteReplace(req);
    }, [performRouteReplace, replaceRequest]);
    const cancelRouteReplace = React.useCallback(() => {
        const req = replaceRequest;
        setReplaceRequest(null);
        if (req) {
            setFollowNotice(`Following on your chart only — ${req.hold.deviceName}'s route stays on your public page.`);
        }
    }, [replaceRequest]);

    // Other doors report the same two facts through events: the planned-route
    // card's Follow button (held elsewhere) and the intent ledger's flush (a
    // queued link dropped because another device set a different route).
    React.useEffect(() => {
        const onHeld = (event: Event) => {
            const detail = (event as CustomEvent<{ planVoyageId?: string; hold?: PublishFollowHold }>).detail;
            if (!detail?.planVoyageId || !detail.hold) return;
            requestRouteReplaceRef.current({ planVoyageId: detail.planVoyageId, hold: detail.hold });
        };
        const onDropped = (event: Event) => {
            const detail = (event as CustomEvent<PlanLinkIntentDropped>).detail;
            if (!detail?.holderName) return;
            setFollowNotice(
                `Route not published — ${detail.holderName} set a different route while you were offline. Your public page shows theirs.`,
            );
        };
        window.addEventListener('thalassa:follow-held-elsewhere', onHeld);
        window.addEventListener(PLAN_LINK_INTENT_DROPPED_EVENT, onDropped);
        return () => {
            window.removeEventListener('thalassa:follow-held-elsewhere', onHeld);
            window.removeEventListener(PLAN_LINK_INTENT_DROPPED_EVENT, onDropped);
        };
    }, []);

    // Draw the route the other device follows, once per (voyage, route). The
    // planned rows arrive with the summaries sync; until they do, wait.
    const remoteHydratedRef = React.useRef<string | null>(null);
    React.useEffect(() => {
        const link = remotePassage?.link;
        if (!remotePassage || !link) return;
        const key = `${remotePassage.voyageId}:${link.planVoyageId}`;
        if (remoteHydratedRef.current === key) return;
        const follow = useFollowRouteStore.getState();
        if (follow.isFollowing && follow.voyageId === link.planVoyageId) {
            remoteHydratedRef.current = key;
            return;
        }
        const summary = plannedSummaries.find((s) => s.voyageId === link.planVoyageId);
        if (!summary) return;
        remoteHydratedRef.current = key;
        confirmedFollowVoyages.add(remotePassage.voyageId);
        // The other device already follows it — a red finding (a plan red
        // where no tide clears it, package 125-05) was accepted there, by
        // its own second tap: draw it here too.
        acceptedFindingsRef.current.add(link.planVoyageId);
        void followPlannedRouteLocally(summary).catch((error) => {
            log.warn('Could not draw the route the other device follows:', error);
        });
    }, [remotePassage, plannedSummaries, followPlannedRouteLocally]);

    /** "Record here too": join the account's active passage on this device —
     *  the same door Open Ship's Log uses after Cast Off. */
    const recordRemoteHere = React.useCallback(async () => {
        const remote = remotePassageRef.current;
        if (!remote || remoteJoinBusy) return;
        const actionScope = identityScope;
        setRemoteJoinBusy(true);
        triggerHaptic('medium');
        try {
            await ensureActiveVoyageLogging({
                id: remote.voyageId,
                voyage_name: remote.voyageName,
                saved_route_id: remote.savedRouteId,
            });
        } finally {
            if (isAuthIdentityScopeCurrent(actionScope)) {
                setRemoteJoinBusy(false);
                refreshRemotePassage();
            }
        }
    }, [identityScope, refreshRemotePassage, remoteJoinBusy]);
    /** "Change the route": the same sheet, on behalf of the remote voyage. */
    const changeRemoteRoute = React.useCallback(() => {
        const remote = remotePassageRef.current;
        if (!remote) return;
        setFollowNotice(null);
        setFollowPromptChoices(followSheetChoices);
        remoteSheetVoyageRef.current = remote.voyageId;
        setFollowPromptVoyageId(remote.voyageId);
    }, [followSheetChoices]);

    useEffect(() => {
        const onChoice = (event: Event) => {
            if (!isAuthIdentityScopeCurrent(identityScope)) return;
            const detail = (event as CustomEvent<{ voyageId: string; ownerKey: string }>).detail;
            if (detail?.ownerKey !== identityScope.key || typeof detail.voyageId !== 'string') return;
            setFollowPromptVoyageId((open) => (open === detail.voyageId ? null : open));
        };
        window.addEventListener(JUST_RECORDING_CHOSEN_EVENT, onChoice);
        return () => window.removeEventListener(JUST_RECORDING_CHOSEN_EVENT, onChoice);
    }, [identityScope]);

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
                rememberJustRecording(vid, identityScope);
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
                    // followNotice the sheet uses renders as an inline
                    // card on the tracking view when the sheet is closed.
                    setFollowNotice(message);
                });
            }
            return;
        }
        if (followPromptVoyageId !== null) return; // already open
        if (
            confirmedFollowVoyages.has(vid) ||
            dismissedFollowVoyages.has(vid) ||
            choseJustRecording(vid, identityScope)
        )
            return; // answered
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
    // Sightings' quick log is up from the list: the voyage cards' mini maps
    // unmount under it (iOS paints Leaflet above fixed overlays).
    const [sightingSheetOpen, setSightingSheetOpen] = useState(false);
    const [showArchived, setShowArchived] = useState(false);
    /** The shared history line's Retry is running (see historyUnreachable). */
    const [historyRetryPending, setHistoryRetryPending] = useState(false);

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

    // Same complete lifetime set as the totals, including archived voyages.
    const records = lifetimeStats.records;
    const lifetimeStatsNotice = lifetimeLoading
        ? 'Updating lifetime totals…'
        : lifetimeError
          ? lifetimeLoaded
              ? 'Couldn’t refresh lifetime totals. Showing the last complete history with locally recorded updates.'
              : 'Lifetime history is unavailable. Only voyages on this phone are counted, so totals are incomplete.'
          : undefined;

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
    // The archive card is the idle Log's: when recording starts its sheet
    // goes with it, so it cannot reappear by itself when recording stops.
    useEffect(() => {
        if (state.isTracking) setShowArchived(false);
    }, [state.isTracking]);

    // GPS Disclaimer modal state
    const [showGpsDisclaimer, setShowGpsDisclaimer] = useState(false);
    const pendingStartRef = useRef<(() => void) | null>(null);
    // The one stand-in question (build 123, package VL): her GPS silent at Start.
    const [standInQuestionOpen, setStandInQuestionOpen] = useState(false);
    const standInAnswerRef = useRef<((answer: 'phone' | 'wait' | null) => void) | null>(null);
    /** The plan the last verified Start settled; the Continue / New dialog that can follow reuses it. */
    const decidedPlanRef = useRef<{ plan: TrackSourcePlan; at: number } | null>(null);
    /** A plan resolved while the follow sheet was open (beginCastOff), so the Start does not ask the Pi twice. */
    const warmPlanRef = useRef<{ promise: Promise<TrackSourcePlan>; at: number } | null>(null);

    const askStandIn = useCallback(
        () =>
            new Promise<'phone' | 'wait' | null>((resolve) => {
                standInAnswerRef.current?.(null);
                standInAnswerRef.current = resolve;
                setStandInQuestionOpen(true);
            }),
        [],
    );
    const answerStandIn = useCallback((answer: 'phone' | 'wait' | null) => {
        const resolve = standInAnswerRef.current;
        standInAnswerRef.current = null;
        setStandInQuestionOpen(false);
        resolve?.(answer);
    }, []);
    // The same question for a voyage started anywhere else — the Cast Off
    // handoff lands here, a Start while her lane was still connecting — that
    // has never heard her and has the phone held for want of any fix of hers
    // (build 123 review). Without it, that voyage records nothing and says
    // nothing. Put away with Cancel, it stays away for that voyage.
    const liveStandInPending = useSyncExternalStore(
        subscribeStandInQuestion,
        readStandInQuestion,
        serverStandInQuestion,
    );
    const [liveStandInDismissedFor, setLiveStandInDismissedFor] = useState<string | null>(null);
    /** The phone notice's Always line, only when Location is not already Always. */
    const [alwaysAdvice, setAlwaysAdvice] = useState(false);
    /** Re-render after "Got it" on the location advisory card. */
    const [, setAdvisoryDismissals] = useState(0);

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
                    // The Always line tells the skipper something only when
                    // Location is not Always already (iOS; a read, never a prompt).
                    const always = Capacitor.getPlatform() === 'ios' ? await BgGeoManager.hasAlwaysLocation() : true;
                    if (!isAuthIdentityScopeCurrent(actionScope)) return;
                    setAlwaysAdvice(!always);
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
     * A voyage is not declared "Live Recording" until the page proves its
     * SOURCE can supply a fresh position. ShipLogService still owns the
     * long-lived capture gate; this is the fail-closed user-facing preflight
     * that prevents permission denial or a GPS-less browser from entering an
     * optimistic recording state indefinitely.
     *
     * Build 123, package VL (Shane 2026-10-07: "we need it to use the vessel
     * gps if and when available"): the source is decided first. Her GPS
     * answering means this phone is asked for nothing — no fix, no notice.
     * Her GPS silent at Start (and not from ashore) asks the one stand-in
     * question. Only when the phone is the source does it have to prove a
     * fresh fix, and only a fix from the phone's own chip earns the notice.
     */
    const verifyGpsAndStart = useCallback(
        async (onProceed: (options?: StartTrackingOptions) => void | Promise<void>, showDisclaimer: boolean) => {
            if (startGpsCheckRef.current) return;
            const actionScope = identityScope;
            if (!isAuthIdentityScopeCurrent(actionScope)) return;

            startGpsCheckRef.current = true;
            setCheckingStartGps(true);
            setTrackingStartFailure(null);
            try {
                // 1. Which receiver feeds this voyage. The Continue / New
                //    dialog straight after a Start reuses that Start's answer.
                const decided = decidedPlanRef.current;
                const reuse =
                    !showDisclaimer && decided && Date.now() - decided.at <= PLAN_REUSE_MS ? decided.plan : null;
                const warm = warmPlanRef.current;
                warmPlanRef.current = null;
                let plan =
                    reuse ??
                    (warm && Date.now() - warm.at <= PLAN_REUSE_MS
                        ? await warm.promise
                        : await resolveTrackSourcePlan());
                if (!isAuthIdentityScopeCurrent(actionScope)) return;

                // 2. Her GPS silent at Start: ask once. From ashore the plan
                //    already says "never", and nothing is asked.
                if (!reuse && plan.source === 'vessel-silent' && plan.standIn === 'ask') {
                    const answer = await askStandIn();
                    if (!isAuthIdentityScopeCurrent(actionScope) || !answer) return;
                    plan = applyStandInAnswer(plan, answer);
                }
                decidedPlanRef.current = { plan, at: Date.now() };
                const sourcePlan = plan;
                // A refusal from the service's own location preflight lands in
                // this page's start card, never as a toast (build 123 review).
                const onFailed = (error: unknown): boolean => {
                    if (!isVoyageLocationError(error) || !isAuthIdentityScopeCurrent(actionScope)) return false;
                    setTrackingStartFailure({
                        kind: error.kind === 'services-off' ? 'services-off' : 'permission',
                        title:
                            error.kind === 'services-off'
                                ? 'Location Services are off'
                                : error.kind === 'deferred'
                                  ? 'Tracking will start when Thalassa is open'
                                  : 'Location is off for Thalassa',
                        detail: `Tracking did not start. ${error.message}`,
                        actionable: error.kind !== 'deferred',
                    });
                    triggerHaptic('medium');
                    return true;
                };
                const start = () => onProceed({ sourcePlan, onFailed });

                // 3. The boat feeds the log: this phone is asked for no fix.
                //    Aboard, its Location keeps her lanes recording with the
                //    screen locked (While Using is enough; her Pi's own track
                //    cannot fill a voyage's gaps until phase 2) — said here,
                //    in the page's card, never as a toast. A Start from ashore
                //    needs nothing.
                if (plan.source === 'vessel' || plan.source === 'vessel-silent') {
                    if (
                        plan.keepAlive === 'when-in-use' &&
                        gpsHealth &&
                        (gpsHealth.reason === 'denied' || gpsHealth.reason === 'services-off')
                    ) {
                        setTrackingStartFailure({
                            kind: gpsHealth.reason === 'denied' ? 'permission' : 'services-off',
                            title:
                                gpsHealth.reason === 'denied'
                                    ? 'Location is off for Thalassa'
                                    : 'Location Services are off',
                            detail: "Tracking did not start. To keep logging your boat's GPS with the screen locked, Thalassa needs Location — While Using is enough. The track comes from your boat; this phone's position is only a backup.",
                            actionable: gpsHealth.actionable,
                        });
                        triggerHaptic('medium');
                        return;
                    }
                    await start();
                    return;
                }

                // 4. The phone is the source: it must supply a fresh fix.
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
                // The notice is about a phone's own chip on the water: never
                // for a fix her receiver supplied ('nmea'), never for a Bad
                // Elf / MFi receiver (plan.showPhoneNotice is false for it).
                if (showDisclaimer && plan.showPhoneNotice && position.source === 'gps') {
                    await checkGpsDisclaimer(() => void start());
                } else await start();
            } finally {
                startGpsCheckRef.current = false;
                if (isAuthIdentityScopeCurrent(actionScope)) setCheckingStartGps(false);
            }
        },
        [askStandIn, checkGpsDisclaimer, gpsBlocked, gpsHealth, identityScope],
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
        // Warm the source while the skipper reads the sheet — the post-answer
        // preflight then finds its plan (and, for a phone log, a fresh fix)
        // already in hand instead of starting cold. Her GPS answering means
        // this phone is never asked (build 123). Fire-and-forget by design.
        const warmPlan = resolveTrackSourcePlan();
        warmPlanRef.current = { promise: warmPlan, at: Date.now() };
        void warmPlan
            .then((plan) =>
                plan.source === 'phone' || plan.source === 'phone-accessory'
                    ? acquireFreshOwnshipPosition({
                          maxGpsAgeMs: 30_000,
                          timeoutSec: 12,
                          locationAccess: 'background-safety',
                      })
                    : null,
            )
            .catch(() => null);
        setFollowNotice(null);
        setFollowPromptChoices(followSheetChoices);
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

    // Build 123 review: the live voyage's stand-in question and its location
    // caution, read from the Ship's Log (both null/false when not tracking).
    const liveStandInOpen =
        isTracking &&
        liveStandInPending &&
        !standInQuestionOpen &&
        liveStandInDismissedFor !== (currentVoyageId ?? null);
    const liveLocationAdvisory =
        isTracking && currentVoyageId && !dismissedAdvisoryVoyages.has(currentVoyageId)
            ? ShipLogService.getLocationAdvisory()
            : null;

    // Overflow (kebab) menu — a titled dialog with the Route Planner actions
    // dialog's discipline: trap focus, land it on Close, Escape dismisses, focus
    // returns to the kebab (UX audit run 5: one kebab pattern on sibling tabs).
    const overflowTriggerRef = useRef<HTMLButtonElement>(null);
    const overflowCloseRef = useRef<HTMLButtonElement>(null);
    const overflowMenuId = React.useId();
    const closeOverflowMenu = useCallback(() => setShowMenu(false), []);
    const overflowMenuRef = useFocusTrap<HTMLDivElement>(showMenu, {
        initialFocusRef: overflowCloseRef,
        onEscape: closeOverflowMenu,
    });
    const engineGroupId = React.useId();

    // Live-recording card stats — memoised so the 1 Hz poll doesn't re-filter
    // and re-sort the whole active voyage in render, and so memo(LiveMiniMap)
    // sees the same `entries` array until the entries actually change.
    const liveStats = React.useMemo(
        () =>
            deriveLiveStats(
                entries,
                currentVoyageId,
                listVoyages.find((s) => s.voyageId === currentVoyageId),
            ),
        [entries, currentVoyageId, listVoyages],
    );

    // Voyage list — one pass over entries instead of one filter per card, and
    // id-taking callbacks so memo(VoyageCard) actually gets to skip renders.
    const entriesByVoyage = React.useMemo(() => deriveEntriesByVoyage(entries), [entries]);
    const handleSelectVoyage = useCallback(
        (voyageId: string) => {
            void loadVoyageEntries(voyageId);
            dispatch({ type: 'SELECT_VOYAGE', voyageId });
        },
        [loadVoyageEntries, dispatch],
    );
    const handleShowVoyageMap = useCallback(
        (voyageId: string) => {
            void loadVoyageEntries(voyageId);
            dispatch({ type: 'SELECT_VOYAGE', voyageId });
            dispatch({ type: 'SHOW_TRACK_MAP', show: true });
        },
        [loadVoyageEntries, dispatch],
    );

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
        preStartAnswerRef.current = null;
        setPreStartSheetOpen(false);
        setShowMenu(false);
        setShowArchived(false);
        setHistoryRetryPending(false);
        setEngineRunningState(undefined);
        setNudgeDismiss(null);
        setLiveMapExpanded(false);
        setShowGpsDisclaimer(false);
        pendingStartRef.current = null;
        standInAnswerRef.current?.(null);
        standInAnswerRef.current = null;
        setStandInQuestionOpen(false);
        setLiveStandInDismissedFor(null);
        dismissedAdvisoryVoyages.clear();
        setAlwaysAdvice(false);
        decidedPlanRef.current = null;
        warmPlanRef.current = null;
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

    // Both account-history reads (lifetime totals and the archive) share one
    // reload and, almost always, one cause. When both have failed, the page
    // says so once, with one Retry, and the two cards keep only their short
    // status lines (UX scorecard run 7). A Retry clears both errors while it
    // runs, so the line and the "this phone only" reading are held until the
    // loads settle rather than flickering to "includes archived".
    const historyRetrying = lifetimeLoading || archivesLoading;
    if (historyRetryPending && !historyRetrying) setHistoryRetryPending(false);
    const heldForRetry = historyRetryPending && historyRetrying;
    const lifetimeUnavailable = (!!lifetimeError || heldForRetry) && !lifetimeLoaded;
    const archiveUnavailable = !!archiveError && loggedArchivedVoyages.length === 0 && !archivesLoading;
    const historyUnreachable =
        !isTracking && ((!!lifetimeError && !lifetimeLoaded && archiveUnavailable) || heldForRetry);
    const retryHistory = () => {
        if (historyRetryPending) return;
        setHistoryRetryPending(true);
        void reloadArchivedVoyages();
    };

    return (
        <div className="relative h-full bg-slate-950 overflow-hidden">
            {/* Fullscreen Statistics View */}
            {showStats ? (
                <LogStatsFullscreen
                    dispatch={dispatch}
                    scopedStatsEntries={scopedStatsEntries}
                    selectedVoyageId={selectedVoyageId}
                    lifetimeStats={lifetimeStats}
                    lifetimeStatsNotice={lifetimeStatsNotice}
                    lifetimeUnavailable={lifetimeUnavailable}
                />
            ) : (
                <div className="flex min-h-0 flex-col h-full">
                    {/* ── Header ── */}
                    <LogPageHeader
                        isTracking={isTracking}
                        gpsStatus={gpsStatus}
                        hasRecordedFix={hasRecordedFix}
                        gpsHeadline={gpsHeadline}
                        onBack={onBack}
                        overflowTriggerRef={overflowTriggerRef}
                        overflowMenuRef={overflowMenuRef}
                        overflowCloseRef={overflowCloseRef}
                        overflowMenuId={overflowMenuId}
                        showMenu={showMenu}
                        setShowMenu={setShowMenu}
                        closeOverflowMenu={closeOverflowMenu}
                        dispatch={dispatch}
                        loggedVoyages={loggedVoyages}
                        hasLifetimeVoyages={lifetimeStats.totals.voyageCount > 0}
                        loggedEntries={loggedEntries}
                    />

                    {/* The trickle's single-publisher veto, said out loud. It
                        used to be console-only, which is how a healthy-looking
                        chain published nothing for a whole day, twice. */}
                    <SkipperClaimNotice isTracking={state.isTracking} />

                    {/* The account's passage, under way on ANOTHER device
                        (2026-09-08). Who records, which route is published and
                        who set it; join here, or change the route through the
                        confirm that names the other device. */}
                    {remotePassage && (
                        <RemotePassageCard
                            passage={remotePassage}
                            routeLabel={routeLabelFor(remotePassage.link?.planVoyageId)}
                            busy={remoteJoinBusy}
                            onRecordHere={() => void recordRemoteHere()}
                            onChangeRoute={changeRemoteRoute}
                        />
                    )}
                    {!isTracking && followNotice && followPromptVoyageId === null && !preStartSheetOpen && (
                        <FollowBlockNoticeCard followNotice={followNotice} setFollowNotice={setFollowNotice} />
                    )}

                    {historyUnreachable && <HistoryStatusLine onRetry={retryHistory} retrying={historyRetryPending} />}

                    {/* Career totals and records stay available without crowding the
                        log. Anchored, in the Vessel page's Diary/Scuttlebutt card
                        (Shane 2026-10-06): idle, Voyage stats and Archived voyages
                        sit side by side above the voyage list, which scrolls in the
                        room below them; recording, Voyage stats alone, one row, above
                        the live card. Each opens its content in a centred sheet. */}
                    <div
                        className={`log-journal-pair vessel-hub-journal mx-4 mb-3 grid shrink-0 gap-3 ${isTracking ? 'log-journal-pair--single grid-cols-1' : 'grid-cols-2'}`}
                    >
                        <VoyageStatsRollup
                            voyageStats={voyageStats}
                            records={records}
                            notice={lifetimeStatsNotice}
                            lifetimeUnavailable={lifetimeUnavailable}
                            onRetry={historyUnreachable ? undefined : reloadArchivedVoyages}
                            retrying={lifetimeLoading}
                            loaded={lifetimeLoaded}
                            underHistoryLine={historyUnreachable}
                        />
                        {/* The archive is the idle Log's, as it always was: no
                            restores mid-recording. */}
                        {!isTracking && (
                            <ArchivedVoyagesSection
                                key={`${identityScope.key}:${identityScope.generation}`}
                                loggedArchivedVoyages={loggedArchivedVoyages}
                                showArchived={showArchived}
                                setShowArchived={setShowArchived}
                                handleUnarchiveVoyage={handleUnarchiveVoyage}
                                handleRestorePassage={handleRestorePassage}
                                loading={archivesLoading}
                                error={archiveError}
                                onRetry={historyUnreachable ? retryHistory : reloadArchivedVoyages}
                            />
                        )}
                    </div>

                    {castOffHandoff &&
                        (castOffHandoff.caution ||
                            castOffHandoff.gps !== 'confirmed' ||
                            castOffHandoff.followNote ||
                            castOffHandoff.followCaution ||
                            castOffHandoff.publishState === 'skipped' ||
                            castOffHandoff.publishState === 'failed' ||
                            castOffHandoff.publishState === 'queued') && (
                            <CastOffHandoffNotices castOffHandoff={castOffHandoff} isTracking={isTracking} />
                        )}

                    {/* The location preflight's one caution for the live voyage
                        (build 123): recording only while open, or Always
                        advised for a phone log. A card, never a toast. */}
                    {liveLocationAdvisory && currentVoyageId && (
                        <div className="px-4 mb-2">
                            <div
                                role="status"
                                data-testid="voyage-location-advisory"
                                className="rounded-xl border border-amber-400/25 bg-amber-500/10 px-3 py-2.5 space-y-2"
                            >
                                <p className="text-sm text-amber-100">{liveLocationAdvisory}</p>
                                <div className="flex flex-wrap gap-2">
                                    <button
                                        type="button"
                                        onClick={openDeviceSettings}
                                        className="min-h-[44px] rounded-xl border border-amber-300/25 bg-amber-400/15 px-3 py-2 text-xs font-black text-amber-100"
                                    >
                                        Open location settings
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => {
                                            dismissedAdvisoryVoyages.add(currentVoyageId);
                                            setAdvisoryDismissals((n) => n + 1);
                                        }}
                                        className="min-h-[44px] rounded-xl border border-amber-300/20 px-3 py-2 text-xs font-black text-amber-200/80"
                                    >
                                        Got it
                                    </button>
                                </div>
                            </div>
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
                            {currentVoyageId && (
                                <LiveVoyageCard
                                    liveStats={liveStats}
                                    engineGroupId={engineGroupId}
                                    engineRunning={engineRunning}
                                    toggleEngine={toggleEngine}
                                    liveMapExpanded={liveMapExpanded}
                                    showTrackMap={showTrackMap}
                                    followedRouteCoords={followedRouteCoords}
                                    liveFix={liveFix}
                                    currentFix={currentFix}
                                    openLiveMap={openLiveMap}
                                    closeLiveMap={closeLiveMap}
                                    expandLiveMapRef={expandLiveMapRef}
                                    shrinkLiveMapRef={shrinkLiveMapRef}
                                    liveMapDialogRef={liveMapDialogRef}
                                    liveMapTitleId={liveMapTitleId}
                                />
                            )}

                            {/* ── Follow-route refusal notice ──
                                NOT a toast (Shane 2026-08-12: "i hate toast
                                messages"). When a pre-start route pick fails
                                after cast-off, the sheet that normally hosts
                                followNotice is already closed — so the
                                same message renders here as a stay-put card.
                                IN NORMAL FLOW between the live map and the
                                Stop controls: the first cut was fixed-position
                                and sat on top of the map's bottom edge (Shane
                                2026-08-13: "that message is now showing up
                                there"). Here it pushes the map up instead of
                                covering it. */}
                            {followNotice && followPromptVoyageId === null && !preStartSheetOpen && (
                                <FollowBlockNoticeCard followNotice={followNotice} setFollowNotice={setFollowNotice} />
                            )}

                            {/* ── Stop / New Entry — pinned at bottom ── */}
                            <TrackingFooterControls
                                handleStopTracking={handleStopTracking}
                                handleShareCurrentPosition={handleShareCurrentPosition}
                                dispatch={dispatch}
                            />
                        </>
                    ) : (
                        <>
                            {/* ── NOT TRACKING: Scrollable voyage list ── */}
                            <LogHistoryScroll>
                                {/* Sightings when not recording (Shane 2026-10-05): crew and a
                                    skipper who hasn't cast off in the app log from here. */}
                                {FEATURE_VISIBILITY.sightings && (
                                    <LogSightingEntry onOpenChange={setSightingSheetOpen} />
                                )}
                                {/* Past Voyage Cards */}
                                {loading && loggedVoyages.length === 0 ? (
                                    <VoyageListSkeleton />
                                ) : loggedVoyages.length === 0 ? (
                                    loggedArchivedVoyages.length > 0 || archivesLoading ? (
                                        <p className="px-1 py-3 text-sm text-slate-400">
                                            {loggedArchivedVoyages.length > 0
                                                ? 'Your past voyages are in the archive above.'
                                                : 'No voyages in your current log.'}
                                        </p>
                                    ) : (
                                        <VoyageListEmptyState
                                            compact={historyUnreachable || lifetimeUnavailable || archiveUnavailable}
                                        />
                                    )
                                ) : (
                                    <PassageLogList
                                        voyages={loggedVoyages}
                                        protectedVoyageIds={[
                                            ...((state.isTracking || state.isPaused) && state.currentVoyageId
                                                ? [state.currentVoyageId]
                                                : []),
                                            ...(remotePassage ? [remotePassage.voyageId] : []),
                                        ]}
                                        onArchivePassage={(passageId, voyageIds) =>
                                            handleArchivePassage(
                                                passageId,
                                                voyageIds,
                                                (voyageId) => remotePassageRef.current?.voyageId === voyageId,
                                            )
                                        }
                                        renderVoyage={(summary, first) => (
                                            <VoyageCard
                                                showSwipeHint={first}
                                                suppressMiniMap={showTrackMap || liveMapExpanded || sightingSheetOpen}
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
                                                isLiveVoyage={
                                                    state.isTracking && state.currentVoyageId === summary.voyageId
                                                }
                                                entries={entriesByVoyage.get(summary.voyageId) ?? NO_ENTRIES}
                                                isSelected={selectedVoyageId === summary.voyageId}
                                                isExpanded={expandedVoyages.has(summary.voyageId)}
                                                onToggle={toggleVoyage}
                                                onSelect={handleSelectVoyage}
                                                onDelete={handleDeleteVoyageRequest}
                                                onArchive={handleArchiveVoyage}
                                                onShowMap={handleShowVoyageMap}
                                                onFollowPlannedRoute={followPlannedRouteLocally}
                                                onAcceptPlannedRouteFinding={acceptPlannedRouteFinding}
                                                onNeedEntries={loadVoyageEntries}
                                                filteredEntries={filteredEntries}
                                                onDeleteEntry={handleDeleteEntry}
                                                onEditEntry={handleEditEntry}
                                            />
                                        )}
                                    />
                                )}
                            </LogHistoryScroll>

                            {/* ── Slide to Start CTA — pinned at bottom ── */}
                            <StartTrackingFooter
                                trackingStartFailure={trackingStartFailure}
                                castOffHandoff={castOffHandoff}
                                beginCastOff={beginCastOff}
                                checkingStartGps={checkingStartGps}
                            />
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
                <PropulsionNudge
                    propConflict={propConflict}
                    engineRunning={engineRunning}
                    toggleEngine={toggleEngine}
                    setNudgeDismiss={setNudgeDismiss}
                />
            )}

            {/* The share-live departure prompt renders globally from
                <DeparturePrompts/> in App.tsx — see the note where its
                effect used to live. */}

            {/* Toast Notifications */}
            <toast.ToastContainer />

            {/* The phone notice: only when this phone is the voyage's source */}
            <GpsDisclaimerModal
                isOpen={showGpsDisclaimer}
                onDismiss={async (dontShowAgain) => dismissGpsDisclaimer(dontShowAgain)}
                alwaysAdvice={alwaysAdvice}
            />

            {/* Her GPS silent: log from this phone, or wait for her — at the
                Start, or for a live voyage that never heard her */}
            <StandInQuestionModal
                isOpen={standInQuestionOpen || liveStandInOpen}
                boatName={_settings?.vessel?.name}
                onAnswer={(answer) => {
                    if (standInQuestionOpen) answerStandIn(answer);
                    else void ShipLogService.answerStandInQuestion(answer);
                }}
                onCancel={() => {
                    if (standInQuestionOpen) answerStandIn(null);
                    else setLiveStandInDismissedFor(currentVoyageId ?? null);
                }}
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
                        // Individual charts need points; lifetime totals use
                        // whole-voyage summaries, not a capped point download.
                        if (id) void loadVoyageEntries(id);
                        dispatch({ type: 'SELECT_VOYAGE', voyageId: id });
                    }}
                    onShowStats={() => dispatch({ type: 'SHOW_STATS', show: true })}
                    entries={loggedEntries}
                    selectedVoyageId={selectedVoyageId}
                    currentVoyageId={currentVoyageId ?? null}
                    voyageGroups={loggedVoyages}
                    lifetimeStats={lifetimeStats}
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
            {(followPromptVoyageId !== null || preStartSheetOpen) && (
                <FollowRoutePromptSheet
                    dismissFollowPrompt={dismissFollowPrompt}
                    followPromptDialogRef={followPromptDialogRef}
                    followPromptDismissRef={followPromptDismissRef}
                    followNotice={followNotice}
                    setFollowNotice={setFollowNotice}
                    followPromptRows={followPromptRows}
                    openRouteInTracer={openRouteInTracer}
                    checkStates={traceChecks.snapshot.states}
                    onCheckNow={checkRouteNow}
                    onStopCheck={(savedRouteId) => cancelTraceChecks('stop', [savedRouteId])}
                    canReview={(savedRouteId) => getTraceCheckOutcome(savedRouteId)?.ackable === true}
                    onReview={traceChecks.review}
                    acceptFindingFor={(voyageId) => acceptedFindingsRef.current.add(voyageId)}
                    fetchingRouteId={recheckingRouteId}
                    followPromptLoadingId={followPromptLoadingId}
                    setFollowPromptLoadingId={setFollowPromptLoadingId}
                    followPromptVoyageId={followPromptVoyageId}
                    identityScope={identityScope}
                    preStartSheetOpen={preStartSheetOpen}
                    setPreStartSheetOpen={setPreStartSheetOpen}
                    preStartAnswerRef={preStartAnswerRef}
                    startTrackingVerifiedRef={startTrackingVerifiedRef}
                    applyFollowPick={applyFollowPick}
                />
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

            {/* Another device's published route stands — replace it? Centred,
                names the device and the time, and only after this does
                anything get written (authorship 2026-09-08). */}
            <ConfirmDialog
                isOpen={!!replaceRequest}
                title="Replace the published route?"
                message={
                    replaceRequest
                        ? `${replaceRequest.hold.deviceName} set ${routeLabelFor(replaceRequest.hold.planVoyageId) ?? 'a different route'}${
                              replaceRequest.hold.updatedAt &&
                              Number.isFinite(Date.parse(replaceRequest.hold.updatedAt))
                                  ? ` at ${new Date(replaceRequest.hold.updatedAt).toLocaleTimeString('en-AU', {
                                        hour: '2-digit',
                                        minute: '2-digit',
                                        hour12: false,
                                    })}`
                                  : ''
                          }. Your public page will switch to ${routeLabelFor(replaceRequest.planVoyageId) ?? 'this route'}.`
                        : ''
                }
                confirmLabel="Replace"
                cancelLabel="Keep theirs"
                onConfirm={confirmRouteReplace}
                onCancel={cancelRouteReplace}
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
