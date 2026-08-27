/**
 * useLogPageState — Custom hook extracting all state & business logic from LogPage.
 *
 * Before: LogPage had 26 useState calls, 30+ handlers, and derived data
 * all in a single 1200-line component.
 *
 * After: LogPage is a pure rendering shell (~500 lines of JSX).
 * All state, effects, and handlers live here.
 */

import { useState, useEffect, useCallback, useMemo, useReducer, useRef, useSyncExternalStore } from 'react';
import { createLogger } from '../utils/createLogger';

const log = createLogger('useLogPageState');

/**
 * Upper bound for the ONE remaining bulk-entry fetch: the opt-in
 * "All Voyages" statistics deep-dive (loadAllEntries). The list itself
 * and every stat tile now render from voyage SUMMARIES, so the default
 * Log open never pulls this many rows. Ordered newest-first, so the cap
 * keeps the freshest window; 50k bounds the pathological precision-GPS
 * case (1–10 Hz capture → hundreds of thousands of rows).
 */
const MAX_LIST_ENTRIES = 50_000;
import type { ShipLogEntry } from '../types';
import { ShipLogService, getRecentDeviceStops } from '../services/ShipLogService';
import { activeVoyageIdFromTrackingState, loadTrackingState } from '../services/shiplog/TrackingStateStore';
import { voyageSummariesSessionReadable } from '../services/shiplog/VoyageSummary';
import { withTimeout } from '../utils/deadline';
import { crumb } from '../utils/flightRecorder';
import {
    getCachedVoyageTrack,
    setCachedVoyageTrack,
    clearCachedVoyageTrack,
} from '../services/shiplog/VoyageTrackCache';
import { supabase } from '../services/supabase';
import { voyageHasRecordedFix } from '../services/shiplog/helpers';
import { useToast } from '../components/Toast';
import { useSettings } from '../context/SettingsContext';
import { groupEntriesByDate, filterEntriesByType, searchEntries, mergeRecentEntries } from '../utils/voyageData';
import {
    mergeSummariesWithLive,
    careerTotalsFromSummaries,
    selectEmptyVoyagesToPrune,
    isMaritimeVoyage,
    type VoyageSummary,
} from '../services/shiplog/VoyageSummary';
import { isPlannedRouteGroup, excludeSuggestedRoutes } from '../utils/voyageStats';
import { exportVoyageAsGPX, shareGPXFile, readGPXFile, importGPXToEntries } from '../services/gpxService';
import { TrackSharingService, TrackCategory } from '../services/TrackSharingService';
import { LogFilters } from '../components/LogFilterToolbar';
import { getErrorMessage } from '../utils/createLogger';
import {
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
    type AuthIdentityScope,
} from '../services/authIdentityScope';

// ─── STATE SHAPE ──────────────────────────────────────────────────────────────

interface LogPageState {
    entries: ShipLogEntry[];
    isTracking: boolean;
    isPaused: boolean;
    isRapidMode: boolean;
    /**
     * Precision Mode — hi-fi GPS capture at ~2 Hz with live decimation.
     * Distinct from Rapid Mode: Rapid changes the FLUSH interval (how
     * often we save an entry), Precision changes the SAMPLE rate (how
     * often the GPS chip delivers a fix to us). Independent toggles.
     */
    isPrecisionMode: boolean;
    loading: boolean;

    /**
     * Server-side voyage roll-ups — one per voyage, NO individual track
     * points. This is the list's data source: cards render from these so
     * opening the Log never has to download a whole history of GPS fixes.
     * Full points for a single voyage are lazy-loaded into `entries` when
     * the user expands or opens it.
     */
    summaries: VoyageSummary[];

    // UI modals / sheets
    showAddModal: boolean;
    showTrackMap: boolean;
    showStats: boolean;
    showStopVoyageDialog: boolean;
    showVoyageChoiceDialog: boolean;
    showCommunityBrowser: boolean;
    actionSheet: 'export' | 'import' | 'share' | 'share_form' | 'pin' | 'stats' | null;

    // Edit / selection
    editEntry: ShipLogEntry | null;
    selectedVoyageId: string | null;
    deleteVoyageId: string | null;
    currentVoyageId: string | undefined;
    /**
     * A start has been confirmed but the voyage id has not arrived yet.
     *
     * currentVoyageId is written by LOAD_DATA alone, which on the start path
     * is chained AFTER startTracking() resolves — i.e. after GPS init and a
     * network load. The acquiring overlay and the live recording card both
     * required that id, so for those seconds the skipper saw neither: the
     * slider vanished and nothing replaced it. This is startingRef made
     * renderable, so the acquiring UI can paint at the tap.
     *
     * It gates PRESENTATION only. Nothing about when recording starts, or
     * which voyage it starts against, depends on it.
     */
    startPending: boolean;
    lastVoyageId: string | null;
    expandedVoyages: Set<string>;
    gpsStatus: 'locked' | 'stale' | 'none';

    // Filters
    filters: LogFilters;
}

// ─── ACTIONS ──────────────────────────────────────────────────────────────────

type LogPageAction =
    | { type: 'RESET_IDENTITY' }
    | {
          type: 'LOAD_DATA';
          entries: ShipLogEntry[];
          isTracking: boolean;
          isPaused: boolean;
          isRapidMode: boolean;
          isPrecisionMode: boolean;
          currentVoyageId: string | undefined;
      }
    | { type: 'SET_ENTRIES'; entries: ShipLogEntry[] }
    | { type: 'SET_SUMMARIES'; summaries: VoyageSummary[] }
    /** Put one summary back (undo, or a shared-track warning restoring the
     *  card). Reducer-side so it composes with CURRENT state — the undo's
     *  SET_SUMMARIES rebuild from a closed-over snapshot is race-prone from
     *  async callbacks. Idempotent: replaces by id if present, else prepends. */
    | { type: 'RESTORE_SUMMARY'; summary: VoyageSummary }
    | { type: 'REMOVE_VOYAGE'; voyageId: string }
    | { type: 'UPDATE_ENTRIES'; updater: (prev: ShipLogEntry[]) => ShipLogEntry[] }
    | { type: 'SET_TRACKING'; isTracking: boolean; isPaused: boolean }
    /**
     * Seed tracking state from ShipLogService's LOCAL knowledge, the moment
     * initialize() has read it — BEFORE any network round trip. The live map is
     * gated on isTracking && currentVoyageId, and the service knows both from
     * Capacitor Preferences in milliseconds; the page used to wait for
     * LOAD_DATA, which lands after five-plus serial Supabase calls, before it
     * would admit a voyage was running (Shane, 2026-08-20: "it needs to be
     * instant along with everything in the log page"). LOAD_DATA remains
     * authoritative and overwrites this when it arrives.
     */
    | { type: 'SEED_TRACKING'; isTracking: boolean; currentVoyageId: string | undefined }
    /**
     * Seed the active voyage's track from the LOCAL offline queue — the boat's
     * own most recent fixes, which are on this device before they are anywhere
     * else. Lets the live map draw a line the instant it mounts instead of
     * sitting empty until the network returns the same points. LOAD_DATA
     * replaces these wholesale when it lands.
     */
    | { type: 'SEED_ENTRIES'; voyageId: string; entries: ShipLogEntry[] }
    | { type: 'SET_RAPID_MODE'; isRapidMode: boolean }
    | { type: 'SET_PRECISION_MODE'; isPrecisionMode: boolean }
    | { type: 'SET_GPS_STATUS'; status: 'locked' | 'stale' | 'none' }
    | { type: 'SHOW_ADD_MODAL'; show: boolean }
    | { type: 'SHOW_TRACK_MAP'; show: boolean }
    | { type: 'SHOW_STATS'; show: boolean }
    | { type: 'SHOW_STOP_DIALOG'; show: boolean }
    | { type: 'SHOW_VOYAGE_CHOICE'; show: boolean; lastVoyageId?: string | null }
    | { type: 'SHOW_COMMUNITY_BROWSER'; show: boolean }
    | { type: 'SET_ACTION_SHEET'; sheet: 'export' | 'import' | 'share' | 'share_form' | 'pin' | 'stats' | null }
    | { type: 'SET_EDIT_ENTRY'; entry: ShipLogEntry | null }
    | { type: 'SET_FILTERS'; filters: LogFilters }
    | { type: 'SELECT_VOYAGE'; voyageId: string | null }
    | { type: 'TOGGLE_VOYAGE'; voyageId: string }
    | { type: 'REQUEST_DELETE_VOYAGE'; voyageId: string | null }
    | { type: 'DONE_LOADING' };

// ─── REDUCER ──────────────────────────────────────────────────────────────────

const initialState: LogPageState = {
    entries: [],
    summaries: [],
    isTracking: false,
    isPaused: false,
    isRapidMode: false,
    isPrecisionMode: false,
    loading: true,
    showAddModal: false,
    showTrackMap: false,
    showStats: false,
    showStopVoyageDialog: false,
    showVoyageChoiceDialog: false,
    showCommunityBrowser: false,
    actionSheet: null,
    editEntry: null,
    selectedVoyageId: null,
    deleteVoyageId: null,
    currentVoyageId: undefined,
    startPending: false,
    lastVoyageId: null,
    expandedVoyages: new Set(),
    gpsStatus: 'none',
    filters: { types: ['auto', 'manual', 'waypoint'], searchQuery: '' },
};

function freshInitialState(): LogPageState {
    return {
        ...initialState,
        expandedVoyages: new Set(),
        filters: { ...initialState.filters, types: [...initialState.filters.types] },
    };
}

/**
 * View state that survives the Log page unmounting — MODULE scope, because the
 * page unmounts on every tab-bounce and instance state dies with it
 * ([[lesson_session_guards_module_scope]]). Shane, mid-voyage 2026-08-01:
 * "when I come back to that page, I literally have to start all over again."
 * Tabbing to the chart and back lost the open track map, the stats sheet, the
 * open voyage, every expand and the search filter.
 *
 * Deliberately EXCLUDED: entries/summaries (data — reloaded fresh so a stale
 * copy is never rendered), confirm dialogs (stop-voyage, delete), actionSheet
 * and editEntry (mid-action state that must not fire on a page the user has
 * left and re-entered), and loading flags.
 */
interface LogViewMemo {
    scopeKey: string;
    generation: number;
    /**
     * Tracking state, banked so a returning skipper sees the live map at once.
     *
     * This used to be excluded with the data, on the reasoning that anything
     * reloaded fresh should not be restored stale. That is right for entries
     * and summaries and wrong for these two, because they are not data — they
     * are the ANSWER TO "is a voyage running", and the live mini map is gated
     * on both. They are written only by LOAD_DATA, which lands after five-plus
     * SERIAL Supabase round trips, and PageTransition rebuilds the page
     * subtree on every navigation — so every return to the Log mid-voyage left
     * the map absent for the length of that chain (Shane, 2026-08-18: "the
     * little map can take up to 10 seconds to arrive"). It was never rendering
     * slowly; it did not yet exist.
     *
     * Restoring them is safe because LOAD_DATA still overwrites both a moment
     * later. The worst case is a live map shown briefly for a voyage that has
     * since stopped, against the certainty of no map at all for ten seconds.
     */
    isTracking: boolean;
    currentVoyageId: string | undefined;
    selectedVoyageId: string | null;
    expandedVoyages: string[];
    showTrackMap: boolean;
    showStats: boolean;
    filters: LogPageState['filters'];
}
let logViewMemo: LogViewMemo | null = null;

/** Test-only: the memo outlives component instances by design, so specs must
 *  start clean. */
export function resetLogViewMemoForTest(): void {
    logViewMemo = null;
}

function seededInitialState(scope: AuthIdentityScope): LogPageState {
    const fresh = freshInitialState();
    const memo = logViewMemo;
    if (!memo || memo.scopeKey !== scope.key || memo.generation !== scope.generation) return fresh;
    return {
        ...fresh,
        isTracking: memo.isTracking,
        currentVoyageId: memo.currentVoyageId,
        selectedVoyageId: memo.selectedVoyageId,
        expandedVoyages: new Set(memo.expandedVoyages),
        showTrackMap: memo.showTrackMap,
        showStats: memo.showStats,
        filters: { ...memo.filters, types: [...memo.filters.types] },
    };
}

function logPageReducer(state: LogPageState, action: LogPageAction): LogPageState {
    const next = logPageReducerInner(state, action);
    // ── Tracking-transition trace ────────────────────────────────────────
    // Every change to (isTracking, currentVoyageId) is logged with the action
    // that caused it. Exists because "the live card shows its placeholder for
    // a while" (isTracking true, id unknown — Shane, 2026-08-20) has FOUR
    // candidate causes, and three rounds of fixing this page by reasoning
    // instead of measuring each fixed the wrong thing. Read it in the Xcode
    // console on device: [LogPage] tracking …. Cheap (fires only on change),
    // and the crumb survives a WebView kill via the flight recorder.
    if (next.isTracking !== state.isTracking || next.currentVoyageId !== state.currentVoyageId) {
        const line =
            `tracking ${state.isTracking}/${state.currentVoyageId ?? '-'} -> ` +
            `${next.isTracking}/${next.currentVoyageId ?? '-'} via ${action.type}`;
        log.warn(line);
        crumb('log:tracking', line);
    }
    return next;
}

function logPageReducerInner(state: LogPageState, action: LogPageAction): LogPageState {
    switch (action.type) {
        case 'RESET_IDENTITY':
            return freshInitialState();
        case 'LOAD_DATA': {
            // Preserve user's expand/collapse state during polls.
            // Only auto-expand active voyage on FIRST load (when entries are
            // empty) — and only when nothing is expanded yet: after a
            // tab-bounce the first load runs again, and without the size guard
            // it REPLACED the restored expand/collapse set with just the
            // active voyage, quietly undoing the view-memo restore.
            const expandedVoyages =
                action.currentVoyageId && state.entries.length === 0 && state.expandedVoyages.size === 0
                    ? new Set([action.currentVoyageId])
                    : state.expandedVoyages;
            return {
                ...state,
                entries: action.entries,
                isTracking: action.isTracking,
                isPaused: action.isPaused,
                isRapidMode: action.isRapidMode,
                isPrecisionMode: action.isPrecisionMode,
                currentVoyageId: action.currentVoyageId,
                // The id has landed (or the start failed and there is none) —
                // either way the optimistic window is over.
                startPending: false,
                expandedVoyages,
                loading: false,
            };
        }
        case 'SET_ENTRIES':
            return { ...state, entries: action.entries };
        case 'SET_SUMMARIES':
            return { ...state, summaries: action.summaries };
        case 'RESTORE_SUMMARY':
            return {
                ...state,
                summaries: [action.summary, ...state.summaries.filter((s) => s.voyageId !== action.summary.voyageId)],
            };
        case 'REMOVE_VOYAGE':
            // Optimistic removal from BOTH the summary list (drives the
            // cards) and any lazy-loaded points for that voyage.
            return {
                ...state,
                summaries: state.summaries.filter((s) => s.voyageId !== action.voyageId),
                entries: state.entries.filter((e) => e.voyageId !== action.voyageId),
            };
        case 'UPDATE_ENTRIES':
            return { ...state, entries: action.updater(state.entries) };
        case 'SEED_ENTRIES': {
            // Only while the page still has nothing: a seed must never clobber
            // data a LOAD_DATA has already delivered. And apply the SAME
            // first-load auto-expand LOAD_DATA would have applied, so seeding
            // early cannot defeat it (LOAD_DATA keys it on entries.length === 0,
            // which would now be false by the time it arrived).
            if (state.entries.length > 0 || action.entries.length === 0) return state;
            const expandedVoyages =
                state.expandedVoyages.size === 0 ? new Set([action.voyageId]) : state.expandedVoyages;
            return { ...state, entries: action.entries, expandedVoyages };
        }
        case 'SEED_TRACKING':
            // Only ever ADD knowledge. If the reducer already believes a voyage
            // is running (memo restore, or an in-flight start), do not let a
            // stale local read talk it out of that — a seed that says "not
            // tracking" is the default value, not evidence.
            if (!action.isTracking || !action.currentVoyageId) return state;
            if (state.isTracking && state.currentVoyageId === action.currentVoyageId) return state;
            return { ...state, isTracking: true, currentVoyageId: action.currentVoyageId };
        case 'SET_TRACKING':
            return {
                ...state,
                isTracking: action.isTracking,
                isPaused: action.isPaused,
                isRapidMode: false,
                isPrecisionMode: false,
                // Pending only while starting WITHOUT an id yet. Continuing an
                // existing voyage already has one, and stopping clears it.
                startPending: action.isTracking && !state.currentVoyageId,
            };
        case 'SET_PRECISION_MODE':
            return { ...state, isPrecisionMode: action.isPrecisionMode };
        case 'SET_RAPID_MODE':
            return { ...state, isRapidMode: action.isRapidMode };
        case 'SET_GPS_STATUS':
            return { ...state, gpsStatus: action.status };
        case 'SHOW_ADD_MODAL':
            return { ...state, showAddModal: action.show };
        case 'SHOW_TRACK_MAP':
            return { ...state, showTrackMap: action.show };
        case 'SHOW_STATS':
            return { ...state, showStats: action.show };
        case 'SHOW_STOP_DIALOG':
            return { ...state, showStopVoyageDialog: action.show };
        case 'SHOW_VOYAGE_CHOICE':
            return {
                ...state,
                showVoyageChoiceDialog: action.show,
                lastVoyageId: action.lastVoyageId !== undefined ? action.lastVoyageId : state.lastVoyageId,
            };
        case 'SHOW_COMMUNITY_BROWSER':
            return { ...state, showCommunityBrowser: action.show };
        case 'SET_ACTION_SHEET':
            return { ...state, actionSheet: action.sheet };
        case 'SET_EDIT_ENTRY':
            return { ...state, editEntry: action.entry };
        case 'SET_FILTERS':
            return { ...state, filters: action.filters };
        case 'SELECT_VOYAGE':
            return { ...state, selectedVoyageId: action.voyageId };
        case 'TOGGLE_VOYAGE': {
            const next = new Set(state.expandedVoyages);
            if (next.has(action.voyageId)) next.delete(action.voyageId);
            else next.add(action.voyageId);
            return { ...state, expandedVoyages: next };
        }
        case 'REQUEST_DELETE_VOYAGE':
            return { ...state, deleteVoyageId: action.voyageId };
        case 'DONE_LOADING':
            return { ...state, loading: false };
        default:
            return state;
    }
}

const subscribeIdentitySnapshot = (notify: () => void): (() => void) => subscribeAuthIdentityScope(() => notify());
const getIdentitySnapshot = (): AuthIdentityScope => getAuthIdentityScope();

// ─── HELPER: Group entries by voyage ──────────────────────────────────────────

function groupEntriesByVoyage(entries: ShipLogEntry[]) {
    const voyageMap = new Map<string, ShipLogEntry[]>();

    entries.forEach((entry) => {
        const voyageId = entry.voyageId || 'default_voyage';
        if (!voyageMap.has(voyageId)) {
            voyageMap.set(voyageId, []);
        }
        voyageMap.get(voyageId)!.push(entry);
    });

    return Array.from(voyageMap.entries())
        .map(([voyageId, entries]) => ({
            voyageId,
            entries: entries.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()),
        }))
        .sort((a, b) => {
            const aTime = new Date(a.entries[0]?.timestamp || 0).getTime();
            const bTime = new Date(b.entries[0]?.timestamp || 0).getTime();
            return bTime - aTime;
        });
}

// ─── HOOK ─────────────────────────────────────────────────────────────────────

export function useLogPageState() {
    const identityScope = useSyncExternalStore(subscribeIdentitySnapshot, getIdentitySnapshot, getIdentitySnapshot);
    const [storedState, rawDispatch] = useReducer(logPageReducer, identityScope, seededInitialState);
    const stateOwnerRef = useRef(identityScope);
    const stateBelongsToCurrentIdentity =
        stateOwnerRef.current.key === identityScope.key &&
        stateOwnerRef.current.generation === identityScope.generation &&
        isAuthIdentityScopeCurrent(stateOwnerRef.current);
    // Never render the previous account for even one React effect cycle.
    const state = stateBelongsToCurrentIdentity ? storedState : freshInitialState();
    // Every callback closes over the dispatch for the identity which created
    // it. A queued DOM event or deferred promise retaining A's callback
    // therefore becomes a no-op as soon as B is current.
    const dispatch = useCallback(
        (action: LogPageAction) => {
            if (isAuthIdentityScopeCurrent(identityScope)) rawDispatch(action);
        },
        [identityScope],
    );
    const toast = useToast();
    const { settings } = useSettings();

    useEffect(() => {
        // Reset ONLY on a real identity change. This effect used to fire
        // RESET_IDENTITY unconditionally — including on plain mount — which
        // wiped the reducer state on every tab-bounce back to the Log page and
        // would also have destroyed the view-memo seed the moment it was
        // applied. Comparing scopes keeps the account boundary exactly as
        // strict (a changed key/generation still resets synchronously-rendered
        // state via stateBelongsToCurrentIdentity, then durably here) while a
        // same-identity remount keeps what the skipper had open. StrictMode's
        // effect replay sees an unchanged scope and is a no-op.
        const previous = stateOwnerRef.current;
        const changed = previous.key !== identityScope.key || previous.generation !== identityScope.generation;
        stateOwnerRef.current = identityScope;
        if (!changed) return;
        logViewMemo = null; // the memo belonged to the old account
        rawDispatch({ type: 'RESET_IDENTITY' });
    }, [identityScope]);

    // Bank the view state on every change, so the NEXT mount can restore it.
    // Cheap (a handful of scalars + two small arrays); never banks data.
    useEffect(() => {
        if (!isAuthIdentityScopeCurrent(identityScope)) return;
        logViewMemo = {
            scopeKey: identityScope.key,
            generation: identityScope.generation,
            isTracking: storedState.isTracking,
            currentVoyageId: storedState.currentVoyageId,
            selectedVoyageId: storedState.selectedVoyageId,
            expandedVoyages: Array.from(storedState.expandedVoyages),
            showTrackMap: storedState.showTrackMap,
            showStats: storedState.showStats,
            filters: { ...storedState.filters, types: [...storedState.filters.types] },
        };
    }, [
        identityScope,
        storedState.isTracking,
        storedState.currentVoyageId,
        storedState.selectedVoyageId,
        storedState.expandedVoyages,
        storedState.showTrackMap,
        storedState.showStats,
        storedState.filters,
    ]);

    // ── Archive state (separate from main state to avoid re-renders on every poll) ──
    const [archivedVoyages, setArchivedVoyages] = useState<ReturnType<typeof groupEntriesByVoyage>>([]);
    useEffect(() => {
        setArchivedVoyages([]);
    }, [identityScope]);

    // Guard: prevents loadData from overwriting optimistic tracking=false during stop
    const stoppingRef = useRef(false);
    // Symmetric guard for START: keeps the optimistic isTracking=true pinned
    // while startTracking()'s native GPS init runs, so an in-flight load
    // (e.g. the one fired when you first open the Log) can't dispatch a
    // stale isTracking=false and silently cancel the just-started voyage.
    const startingRef = useRef(false);

    // Guard: prevents overlapping full reloads from stacking into a
    // storm. loadData is triggered from many places (mount, the 1.5s
    // auth-rehydrate retry, the SIGNED_IN/TOKEN_REFRESHED listener,
    // pull-to-refresh, AND — historically — a 1-second poll while
    // tracking). On an account with a long precision-GPS history each
    // loadData paginates tens of thousands of rows from Supabase; if a
    // second call starts before the first finishes they pile up and
    // peg the main thread (the "5-minute load / can't start a track /
    // can't delete" report). This ref makes loadData a no-op while one
    // is already in flight.
    const loadingRef = useRef(false);

    // Mirror of state.entries for stable-identity callbacks (live poll
    // refresh + soft-delete read the latest entries without re-subscribing).
    const entriesRef = useRef(state.entries);
    entriesRef.current = state.entries;

    // Mirror of expandedVoyages so the (stable-identity) toggle handler can
    // tell expand-from-collapse without re-subscribing.
    const expandedRef = useRef(state.expandedVoyages);
    expandedRef.current = state.expandedVoyages;

    useEffect(() => {
        startingRef.current = false;
        stoppingRef.current = false;
        loadingRef.current = false;
        entriesRef.current = [];
        expandedRef.current = new Set();
    }, [identityScope]);

    // ── Initialization ──────────────────────────────────────────────────────

    const loadDataInner = useCallback(async () => {
        if (!isAuthIdentityScopeCurrent(identityScope)) return;
        // voyageId AT START is only used to choose which voyage's points to
        // fetch — the tracking STATUS we dispatch is re-read after the await
        // (see below) to avoid clobbering an optimistic start/stop.
        const voyageIdAtStart = ShipLogService.getCurrentVoyageId();

        // ── Summary-first load ──────────────────────────────────────────
        // The LIST renders from per-voyage SUMMARIES (one aggregated row
        // each, no individual track points). Opening the Log therefore no
        // longer downloads a whole precision-GPS history just to draw the
        // cards — the single biggest source of the old slow load.
        //
        // Into `entries` we now load ONLY the points we actually need
        // resident: the ACTIVE live-tracking voyage (so its card grows and
        // its expanded timeline works) plus the offline queue (unsynced
        // points). Past voyages' full points are lazy-loaded on demand
        // when the user expands or opens one (see loadVoyageEntries). The
        // merge preserves any voyage already lazy-loaded this session.
        const t0 = performance.now();
        const [summaries, activeEntries, offlineEntries] = await Promise.all([
            ShipLogService.getVoyageSummaries(),
            voyageIdAtStart ? ShipLogService.getVoyageEntries(voyageIdAtStart) : Promise.resolve([] as ShipLogEntry[]),
            ShipLogService.getOfflineEntries(),
        ]);
        if (!isAuthIdentityScopeCurrent(identityScope)) return;
        log.warn(
            `[perf] loadData network: ${Math.round(performance.now() - t0)}ms ` +
                `(${summaries.length} voyages, ${activeEntries.length} active pts)`,
        );

        // An EMPTY result is ambiguous: "no voyages" and "session not yet
        // readable, failed closed" look identical. Only believe the first.
        // Without this, an auth-rehydrate reload wiped every cache-painted
        // card for several seconds — the "just the main log page" gap after a
        // delete. A skipped update here is healed by the next poll/retry.
        if (summaries.length > 0) {
            dispatch({ type: 'SET_SUMMARIES', summaries });
        } else {
            const readable = await voyageSummariesSessionReadable().catch(() => false);
            if (!isAuthIdentityScopeCurrent(identityScope)) return;
            if (readable) dispatch({ type: 'SET_SUMMARIES', summaries });
        }

        // Merge active + offline into whatever is already resident
        // (expanded voyages), purging volatile offline_* ids and deduping
        // by real id — same primitive the live poll uses.
        const merged = mergeRecentEntries(entriesRef.current, [...activeEntries, ...offlineEntries]);

        // Re-read tracking status + voyage NOW, AFTER the network fetch.
        // Reading them at the top (pre-await) caused the first-start no-op:
        // open Log → loadData starts + snapshots isTracking=false → user
        // slides to Start (optimistic isTracking=true) → this load finishes
        // and dispatched the STALE false, clobbering the start. Reading at
        // dispatch time means a start that landed during the fetch sticks.
        const status = ShipLogService.getTrackingStatus();
        const voyageId = ShipLogService.getCurrentVoyageId();

        // THE IN-MEMORY STATUS LIES DURING A COLD-START RESUME, and LOAD_DATA
        // used to believe it. initializeForScope deliberately sets the
        // service's in-memory isTracking to FALSE for the whole native resume
        // (BgGeo ready → authorisation → lease → requestStart) and only flips
        // it true when startTracking completes — which on device is roughly
        // when the first GPS fix lands. So any loadData finishing in that
        // window (the auth-rehydrate reload reliably does) dispatched
        // isTracking:false over the seed, unmounted the live card, and the map
        // "arrived with the GPS fix" — the exact symptom the seed was built to
        // kill. Found by the 2026-08-20 render-path audit after two fixes that
        // read correctly and were then clobbered.
        //
        // The persisted record is the tie-breaker, same source the seed uses.
        // It cannot go stale-true: every path that genuinely stops tracking —
        // stop, pause, mark-stopped, failed-start rollback — SAVES the record
        // as not-tracking before or as it changes the in-memory state.
        let effectiveTracking = status.isTracking;
        let effectiveVoyageId = voyageId;
        if (!status.isTracking && !stoppingRef.current) {
            try {
                const persistedVoyageId = activeVoyageIdFromTrackingState(await loadTrackingState(identityScope));
                if (persistedVoyageId) {
                    effectiveTracking = true;
                    effectiveVoyageId = persistedVoyageId;
                }
            } catch {
                /* fall through to the in-memory answer */
            }
            if (!isAuthIdentityScopeCurrent(identityScope)) return;
        }

        dispatch({
            type: 'LOAD_DATA',
            entries: merged,
            // startingRef pins true (a start is in flight), stoppingRef pins
            // false (a stop is in flight); otherwise trust the freshly-read
            // status, tie-broken by the persisted record above. This keeps an
            // in-flight load from clobbering either optimistic transition OR
            // an in-flight cold-start resume.
            isTracking: startingRef.current ? true : stoppingRef.current ? false : effectiveTracking,
            isPaused: startingRef.current || stoppingRef.current ? false : status.isPaused,
            isRapidMode: stoppingRef.current ? false : status.isRapidMode,
            isPrecisionMode: stoppingRef.current ? false : status.isPrecisionMode === true,
            currentVoyageId: startingRef.current || stoppingRef.current ? voyageId : effectiveVoyageId,
        });

        // Load archived voyages and career entries in parallel (non-blocking)
        reloadCareerData();

        // Auto-prune empty (0.0 NM) tracks — runs on the NETWORK load only
        // (not the cache instant-paint) so it acts on confirmed data. Feed
        // it the MERGED summary list (cloud summaries overlaid with live/
        // offline entries) — the SAME source the cards render from — so an
        // offline-only empty voyage (still in the queue, not yet synced)
        // is reachable. The cloud-only `summaries` would never include it,
        // which is why the empties never deleted. Guards (active voyage,
        // recent activity, planned/imported, manual) live in
        // selectEmptyVoyagesToPrune.
        void pruneEmptyTracks(mergeSummariesWithLive(summaries, merged), voyageId);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [dispatch, identityScope]);

    // How many empty (0.0 NM) tracks were just tidied away — drives the
    // EmptyTrackRemovedModal announcement. null = nothing to show.
    const [emptyPruneNotice, setEmptyPruneNotice] = useState<number | null>(null);
    useEffect(() => {
        setEmptyPruneNotice(null);
    }, [identityScope]);

    // Delete genuinely empty device tracks in the background. Idempotent:
    // once a voyage is pruned it's gone from summaries, so subsequent
    // loads find nothing. A guard ref prevents overlapping sweeps.
    const pruningRef = useRef(false);
    const pruneEmptyTracks = useCallback(
        async (summaries: VoyageSummary[], activeVoyageId: string | null | undefined) => {
            if (!isAuthIdentityScopeCurrent(identityScope)) return;
            if (pruningRef.current) return;
            const toPrune = selectEmptyVoyagesToPrune(summaries, {
                activeVoyageId,
                nowMs: Date.now(),
                // Voyages THIS device stopped skip the cross-device recency
                // hold — a nowhere-track ended from any door tidies away on
                // the very next sweep instead of 15 minutes later.
                deviceStoppedIds: getRecentDeviceStops(),
            });
            if (toPrune.length === 0) return;
            pruningRef.current = true;
            try {
                let deleted = 0;
                for (const voyageId of toPrune) {
                    const ok = await ShipLogService.deleteVoyage(voyageId);
                    if (!isAuthIdentityScopeCurrent(identityScope)) return;
                    if (ok) {
                        deleted += 1;
                        dispatch({ type: 'REMOVE_VOYAGE', voyageId });
                        loadedVoyagesRef.current.delete(voyageId);
                        void clearCachedVoyageTrack(voyageId);
                    }
                }
                if (deleted > 0) {
                    if (!isAuthIdentityScopeCurrent(identityScope)) return;
                    reloadCareerData();
                    setEmptyPruneNotice(deleted);
                }
            } catch (e) {
                log.warn('pruneEmptyTracks failed', e);
            } finally {
                // A stale A sweep must not unlock B's in-flight sweep after
                // the shared guard ref has been reset and reused by B.
                if (isAuthIdentityScopeCurrent(identityScope)) pruningRef.current = false;
            }
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [toast, dispatch, identityScope],
    );

    // Public loadData — in-flight guard so overlapping triggers can't stack
    // into a storm. But a load REQUESTED while one is running (e.g. the
    // refresh fired right after startTracking() resolves) must not be
    // silently dropped — that would leave the just-started voyage's
    // currentVoyageId unset. So we COALESCE: remember that another run was
    // asked for and do exactly one more pass when the current one finishes.
    const pendingReloadRef = useRef(false);
    useEffect(() => {
        pendingReloadRef.current = false;
        pruningRef.current = false;
    }, [identityScope]);
    const loadData = useCallback(async () => {
        if (!isAuthIdentityScopeCurrent(identityScope)) return;
        if (loadingRef.current) {
            pendingReloadRef.current = true;
            return;
        }
        loadingRef.current = true;
        try {
            do {
                pendingReloadRef.current = false;
                await loadDataInner();
            } while (pendingReloadRef.current && isAuthIdentityScopeCurrent(identityScope));
        } finally {
            if (isAuthIdentityScopeCurrent(identityScope)) loadingRef.current = false;
        }
    }, [identityScope, loadDataInner]);

    // Lightweight live-tracking refresh — DEVICE-ONLY. While a voyage is
    // recording, local-first capture writes every point to the offline
    // queue (nothing lands in the cloud until the voyage stops), so the
    // live card refreshes purely from the local queue: zero network on
    // the 1–5 s poll, instant, and identical on a dead link offshore.
    // This poll only runs on the RECORDING device (gated on isTracking +
    // getCurrentVoyageId), so no other surface loses cloud freshness.
    const refreshActiveVoyage = useCallback(async () => {
        if (!isAuthIdentityScopeCurrent(identityScope)) return;
        const voyageId = ShipLogService.getCurrentVoyageId();
        if (!voyageId) return;

        try {
            const offlineEntries = await ShipLogService.getOfflineEntries();
            if (!isAuthIdentityScopeCurrent(identityScope)) return;
            if (offlineEntries.length === 0) return;
            dispatch({
                type: 'UPDATE_ENTRIES',
                updater: (prev) => mergeRecentEntries(prev, offlineEntries),
            });
        } catch (e) {
            if (isAuthIdentityScopeCurrent(identityScope)) log.warn('refreshActiveVoyage failed', e);
        }
    }, [dispatch, identityScope]);

    // Auto-archive REMOVED 2026-05-05.
    //
    // Previously: a one-shot sweep on every LogPage mount that
    // archived any voyage whose newest entry was > 30 days old. The
    // policy was wrong for the user's actual workflow — bluewater
    // cruisers can easily go a month between passages, sail
    // seasonally, or save a planned route weeks before departing.
    // Tracks were "randomly" disappearing because the sweep fired
    // every time the user opened the Ship's Log.
    //
    // Manual archive (handleArchiveVoyage / the row's archive button
    // in LogPage) still works. Archiving is now a deliberate action,
    // not an opaque background process.
    //
    // If we ever want auto-archive back, it should:
    //   - require voyage.status === 'completed' (not just stale entries)
    //   - run on a much longer threshold (1+ year)
    //   - be opt-in via a setting
    //   - announce itself with a toast / undo affordance

    // Reusable archive-data refresh. (Career totals no longer need a
    // separate entry fetch — they're derived from the voyage summaries.)
    const reloadCareerData = useCallback(() => {
        const actionScope = identityScope;
        if (!isAuthIdentityScopeCurrent(actionScope)) return;
        ShipLogService.getArchivedEntries()
            .then((archived) => {
                if (isAuthIdentityScopeCurrent(actionScope)) {
                    setArchivedVoyages(groupEntriesByVoyage(archived));
                }
            })
            .catch((e) => {
                if (isAuthIdentityScopeCurrent(actionScope)) console.warn(`[useLogPageState]`, e);
            });
    }, [identityScope]);

    useEffect(() => {
        const effectScope = identityScope;
        let mounted = true;
        let retryTimer: ReturnType<typeof setTimeout> | undefined;
        const timeout = setTimeout(() => {
            /* Safety: dismiss spinner after 5s if init hangs (web/no Capacitor) */
            if (mounted) dispatch({ type: 'DONE_LOADING' });
        }, 5000);
        // ── INSTANT PAINT ───────────────────────────────────────────────
        // Boot the list from the LOCAL summary cache before any network
        // call — the Log appears immediately (online, offline, cold start),
        // then loadData() refreshes it from the cloud in the background.
        // DONE_LOADING fires even on a cache MISS: the page (and the
        // Start control) must never sit behind a spinner waiting for
        // auth rehydrate + a Supabase fetch — first-ever opens and
        // pre-auth cold starts paint the empty shell and the list
        // hydrates when loadData lands.
        (async () => {
            try {
                const cached = await ShipLogService.getCachedVoyageSummaries();
                if (mounted && isAuthIdentityScopeCurrent(effectScope) && cached.length > 0) {
                    dispatch({ type: 'SET_SUMMARIES', summaries: cached });
                }
            } catch {
                /* cache miss — the network load below fills it */
            } finally {
                if (mounted && isAuthIdentityScopeCurrent(effectScope)) dispatch({ type: 'DONE_LOADING' });
            }
        })();
        // ── SEED FROM LOCAL STATE, IN PARALLEL WITH initialize() ────────
        // Not after it. On a cold start with a voyage to resume, initialize()
        // runs the whole native chain — BgGeo ensureReady, location
        // authorisation, lease acquisition, requestStart, a state save — and
        // only returns once all of that has settled, which on device is
        // roughly when the first GPS fix lands. A seed placed behind it
        // therefore arrived WITH the fix (Shane, 2026-08-20: "it seems to
        // arrive after there is a gps fix. can we make it come before that?").
        //
        // But the answer to "is a voyage running" is the FIRST thing
        // initialize() reads — one Capacitor Preferences get, milliseconds —
        // and activeVoyageIdFromTrackingState is the pure helper the service
        // itself uses to interpret it. So read the same record here, directly,
        // and open the gate before the native chain has even started. The
        // service's own reconciliation still runs; LOAD_DATA still wins.
        //
        // Wrapped and fire-and-forget: a seed must NEVER delay or break the
        // load. The map appearing early is a nicety; the data arriving is not.
        void (async () => {
            try {
                const persisted = await loadTrackingState(effectScope);
                if (!mounted || !isAuthIdentityScopeCurrent(effectScope)) return;
                const seededVoyageId = activeVoyageIdFromTrackingState(persisted);
                if (!seededVoyageId) return;
                dispatch({ type: 'SEED_TRACKING', isTracking: true, currentVoyageId: seededVoyageId });
                // And the track itself, from the local offline queue — the
                // boat's own latest fixes, on this device before anywhere else.
                const queued = await ShipLogService.getOfflineEntries();
                if (!mounted || !isAuthIdentityScopeCurrent(effectScope)) return;
                const mine = queued.filter((e) => e.voyageId === seededVoyageId);
                if (mine.length > 0) dispatch({ type: 'SEED_ENTRIES', voyageId: seededVoyageId, entries: mine });
            } catch (seedErr) {
                log.warn('local tracking seed skipped:', seedErr);
            }
        })();

        (async () => {
            try {
                await ShipLogService.initialize();
                if (mounted && isAuthIdentityScopeCurrent(effectScope)) await loadData();

                // FIX: Supabase auth session may still be rehydrating from storage
                // on cold starts. If getLogEntries returned [] because getUser() was
                // null, retry after a short delay to give the session time to restore.
                // This is the root cause of "empty LogPage on first visit".
                retryTimer = setTimeout(async () => {
                    if (mounted && isAuthIdentityScopeCurrent(effectScope)) await loadData();
                }, 1500);
            } catch (e) {
                if (isAuthIdentityScopeCurrent(effectScope)) log.warn('Init failed:', e);
                /* Init or load failure — stop spinner to show empty state */
                if (mounted && isAuthIdentityScopeCurrent(effectScope)) dispatch({ type: 'DONE_LOADING' });
            } finally {
                clearTimeout(timeout);
            }
        })();

        // AUTH SESSION LISTENER: Reload data when Supabase session becomes available.
        // Handles the case where the user navigates to LogPage before auth finishes.
        let authUnsubscribe: (() => void) | undefined;
        if (supabase) {
            const {
                data: { subscription },
            } = supabase.auth.onAuthStateChange((event) => {
                if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
                    if (mounted && isAuthIdentityScopeCurrent(effectScope)) loadData();
                }
            });
            authUnsubscribe = () => subscription.unsubscribe();
        }

        return () => {
            mounted = false;
            clearTimeout(timeout);
            if (retryTimer) clearTimeout(retryTimer);
            authUnsubscribe?.();
        };
    }, [dispatch, identityScope, loadData]);

    // ── GPS Status Polling ──────────────────────────────────────────────────

    useEffect(() => {
        if (!state.isTracking) {
            dispatch({ type: 'SET_GPS_STATUS', status: 'none' });
            return;
        }
        const poll = () => {
            if (!document.hidden) dispatch({ type: 'SET_GPS_STATUS', status: ShipLogService.getGpsStatus() });
        };
        poll();
        const id = setInterval(poll, 5000);
        return () => clearInterval(id);
    }, [dispatch, state.isTracking]);

    // ── Entry Refresh Polling — live updates while tracking ──────────────────
    // RAPID INITIAL POLL: Poll every 1s for the first 10s after tracking starts
    // so the first track card appears almost instantly. Then fall back to 5s/3s.
    //
    // Each tick now runs the LIGHTWEIGHT refreshActiveVoyage (active
    // voyage's new points + local offline queue, merged in) rather than
    // a full history reload. This is what the original "just reads from
    // local DB, no GPS calls" comment intended — the prior loadData()
    // call actually re-paginated the entire Supabase table every second,
    // which is what made starting a track freeze the page.

    // STILL ACQUIRING? Drives the poll cadence below. Same predicate the
    // Log page's acquiring badge uses, imported rather than re-written so the
    // two cannot disagree about when the track is open. LIVE voyage-id
    // fallback (audit follow-up 2026-08-03): state.currentVoyageId only
    // arrives with LOAD_DATA's Supabase round-trip — on dead boat comms this
    // predicate would otherwise burst-poll at 1 s forever over a voyage that
    // is recording fine.
    const stillAcquiring = !voyageHasRecordedFix(
        state.entries,
        state.currentVoyageId ?? ShipLogService.getCurrentVoyageId(),
    );

    useEffect(() => {
        if (!state.isTracking) return;

        const normalPollMs = state.isRapidMode ? 3_000 : 5_000;
        const BURST_POLL_MS = 1_000;
        const BURST_DURATION_MS = 10_000;

        // Start with rapid polling
        let currentId = setInterval(() => {
            if (!document.hidden) refreshActiveVoyage();
        }, BURST_POLL_MS);

        // After burst period, switch to normal polling — UNLESS we are still
        // waiting on the opening fix.
        //
        // The burst used to expire on a flat 10 s timer, but the first-fix gate
        // cannot open before ~5 s of GPS warm-up plus a corroborating second
        // fix, so the opening fix routinely lands AFTER the burst has already
        // stepped down. The overlay then sat there for up to another 5 s over a
        // position that was already on disk — pure display lag on top of a wait
        // that already felt long. Holding the 1 s cadence until the fix lands
        // costs one local queue read per second (no network: capture is
        // local-first while tracking) and stops the moment it does.
        const burstTimeout = setTimeout(() => {
            if (stillAcquiring) return; // keep the 1 s poll; effect re-runs when it lands
            clearInterval(currentId);
            currentId = setInterval(() => {
                if (!document.hidden) refreshActiveVoyage();
            }, normalPollMs);
        }, BURST_DURATION_MS);

        // Both polls skip while backgrounded, and nothing forced a refresh on
        // return — so pocketing the phone during acquisition (exactly what the
        // overlay exists to catch) meant the fix could land unseen and the
        // overlay stayed up until the next tick after wake. Refresh on the spot.
        const onVisible = () => {
            if (!document.hidden) refreshActiveVoyage();
        };
        document.addEventListener('visibilitychange', onVisible);

        return () => {
            clearInterval(currentId);
            clearTimeout(burstTimeout);
            document.removeEventListener('visibilitychange', onVisible);
        };
    }, [state.isTracking, state.isRapidMode, refreshActiveVoyage, stillAcquiring]);

    // ── Tracking Handlers ───────────────────────────────────────────────────

    const handleStartTracking = useCallback(async () => {
        const actionScope = identityScope;
        if (!isAuthIdentityScopeCurrent(actionScope)) return;
        // Offer to continue the most recent REAL voyage (device-tracked, not
        // suggested/imported). Sourced from summaries (newest-first) so it
        // works without the full history resident in `entries`.
        const recentVoyageId = state.summaries.find((s) => !s.isPlannedRoute && !s.isImported)?.voyageId;
        if (recentVoyageId) {
            dispatch({ type: 'SHOW_VOYAGE_CHOICE', show: true, lastVoyageId: recentVoyageId });
            return;
        }
        // Instant UI response — dispatch first, service call is fire-and-forget.
        // startingRef pins the optimistic state through the native init.
        startingRef.current = true;
        dispatch({ type: 'SET_TRACKING', isTracking: true, isPaused: false });
        ShipLogService.startTracking()
            .then(() => (isAuthIdentityScopeCurrent(actionScope) ? loadData() : undefined))
            .then(() => {
                if (isAuthIdentityScopeCurrent(actionScope)) startingRef.current = false;
            })
            .catch((error: unknown) => {
                if (!isAuthIdentityScopeCurrent(actionScope)) return;
                startingRef.current = false;
                dispatch({ type: 'SET_TRACKING', isTracking: false, isPaused: false });
                toast.error(getErrorMessage(error) || 'Failed to start tracking');
            });
    }, [dispatch, identityScope, state.summaries, loadData, toast]);

    const startTrackingWithNewVoyage = useCallback(async () => {
        const actionScope = identityScope;
        if (!isAuthIdentityScopeCurrent(actionScope)) return;
        startingRef.current = true;
        dispatch({ type: 'SET_TRACKING', isTracking: true, isPaused: false });
        ShipLogService.startTracking()
            .then(() => (isAuthIdentityScopeCurrent(actionScope) ? loadData() : undefined))
            .then(() => {
                if (isAuthIdentityScopeCurrent(actionScope)) startingRef.current = false;
            })
            .catch((error: unknown) => {
                if (!isAuthIdentityScopeCurrent(actionScope)) return;
                startingRef.current = false;
                dispatch({ type: 'SET_TRACKING', isTracking: false, isPaused: false });
                toast.error(getErrorMessage(error) || 'Failed to start tracking');
            });
    }, [dispatch, identityScope, loadData, toast]);

    const continueLastVoyage = useCallback(async () => {
        const actionScope = identityScope;
        if (!isAuthIdentityScopeCurrent(actionScope)) return;
        startingRef.current = true;
        dispatch({ type: 'SET_TRACKING', isTracking: true, isPaused: false });
        dispatch({ type: 'SHOW_VOYAGE_CHOICE', show: false });
        ShipLogService.startTracking(false, state.lastVoyageId || undefined)
            .then(() => (isAuthIdentityScopeCurrent(actionScope) ? loadData() : undefined))
            .then(() => {
                if (isAuthIdentityScopeCurrent(actionScope)) startingRef.current = false;
            })
            .catch((error: unknown) => {
                if (!isAuthIdentityScopeCurrent(actionScope)) return;
                startingRef.current = false;
                dispatch({ type: 'SET_TRACKING', isTracking: false, isPaused: false });
                toast.error(getErrorMessage(error) || 'Failed to continue tracking');
            });
    }, [dispatch, identityScope, state.lastVoyageId, loadData, toast]);

    const handlePauseTracking = useCallback(async () => {
        const actionScope = identityScope;
        if (!isAuthIdentityScopeCurrent(actionScope)) return;
        try {
            await ShipLogService.pauseTracking();
            if (!isAuthIdentityScopeCurrent(actionScope)) return;
            dispatch({ type: 'SET_TRACKING', isTracking: false, isPaused: true });
        } catch (error) {
            if (!isAuthIdentityScopeCurrent(actionScope)) return;
            const status = ShipLogService.getTrackingStatus();
            dispatch({ type: 'SET_TRACKING', isTracking: status.isTracking, isPaused: status.isPaused });
            toast.error(
                getErrorMessage(error) ||
                    'Voyage is paused, but background GPS is still active. Resume and pause again to retry.',
            );
        }
    }, [dispatch, identityScope, toast]);

    const handleToggleRapidMode = useCallback(async () => {
        const actionScope = identityScope;
        if (!isAuthIdentityScopeCurrent(actionScope)) return;
        const newState = !state.isRapidMode;
        await ShipLogService.setRapidMode(newState);
        if (!isAuthIdentityScopeCurrent(actionScope)) return;
        dispatch({ type: 'SET_RAPID_MODE', isRapidMode: newState });
    }, [dispatch, identityScope, state.isRapidMode]);

    /**
     * Precision Mode toggle — hi-fi GPS capture at ~2 Hz with live
     * decimation. See `ShipLogService.setPrecisionMode` for the full
     * battery / auto-shutoff story. Independent of Rapid Mode.
     */
    const handleTogglePrecisionMode = useCallback(async () => {
        const actionScope = identityScope;
        if (!isAuthIdentityScopeCurrent(actionScope)) return;
        const newState = !state.isPrecisionMode;
        await ShipLogService.setPrecisionMode(newState);
        if (!isAuthIdentityScopeCurrent(actionScope)) return;
        dispatch({ type: 'SET_PRECISION_MODE', isPrecisionMode: newState });
    }, [dispatch, identityScope, state.isPrecisionMode]);

    const handleStopTracking = useCallback(() => {
        if (!isAuthIdentityScopeCurrent(identityScope)) return;
        dispatch({ type: 'SHOW_STOP_DIALOG', show: true });
    }, [dispatch, identityScope]);

    const confirmStopVoyage = useCallback(async () => {
        const actionScope = identityScope;
        if (!isAuthIdentityScopeCurrent(actionScope)) return;
        dispatch({ type: 'SHOW_STOP_DIALOG', show: false });
        // Capture the voyage id BEFORE stopTracking clears it.
        const stoppedVoyageId = ShipLogService.getCurrentVoyageId();
        // Instant UI response — dispatch first, guard prevents polls from overwriting
        stoppingRef.current = true;
        dispatch({ type: 'SET_TRACKING', isTracking: false, isPaused: false });
        try {
            // Exact-voyage teardown: every other caller passes the id it
            // means to stop; the captured id IS the current one, so this is
            // pure lease verification, never a mismatch.
            await ShipLogService.stopTracking(stoppedVoyageId);
        } catch (e) {
            if (!isAuthIdentityScopeCurrent(actionScope)) return;
            log.warn('stopTracking failed:', e);
            stoppingRef.current = false;
            const status = ShipLogService.getTrackingStatus();
            dispatch({ type: 'SET_TRACKING', isTracking: status.isTracking, isPaused: status.isPaused });
            // Do not prune/delete/reload as though stop completed. The service
            // retains a pending-stop lease and the same action retries it.
            toast.error(getErrorMessage(e) || 'Background GPS is still active. Retry End Voyage.');
            return;
        }
        if (!isAuthIdentityScopeCurrent(actionScope)) return;
        // Clear the guard
        stoppingRef.current = false;

        // Keep the dialog's promise. Its title is "End Voyage?" and its
        // button says "End Voyage" — but this handler only ever stopped
        // GPS, leaving the voyages row status='active' forever, which then
        // ambushed the next Cast Off (Shane 2026-08-27: "i have to end
        // voyage and archive. even though i stopped the route in the
        // log???"). Archive the row now. Only cast-off voyages have a
        // voyages row — casual Log-page starts mint a local "voyage_…" id
        // with nothing to archive. Success-path only: a failed teardown
        // returned above and must leave the row active.
        if (stoppedVoyageId && !stoppedVoyageId.startsWith('voyage_')) {
            try {
                const { endVoyage } = await import('../services/VoyageService');
                const ended = await endVoyage(stoppedVoyageId, 'completed');
                if (!isAuthIdentityScopeCurrent(actionScope)) return;
                if (!ended) {
                    // false also means "row already archived elsewhere", so
                    // the wording must not assert it is still active.
                    toast.error(
                        'Track stopped. The passage could not be confirmed as ended — if it still shows active, End Voyage from the Vessel tab.',
                    );
                }
            } catch (e) {
                if (!isAuthIdentityScopeCurrent(actionScope)) return;
                log.warn('archive-on-stop failed:', e);
                toast.error(
                    'Track stopped. The passage could not be confirmed as ended — if it still shows active, End Voyage from the Vessel tab.',
                );
            }
        }

        // Immediately bin an empty (0.0 NM) just-stopped voyage. The
        // summary-level auto-prune holds recently-active voyages for 15 min
        // (they might be live on ANOTHER device) — but this is OUR voyage
        // and we just stopped it, so there's no cross-device ambiguity:
        // delete it now rather than making the user wait out that window.
        if (stoppedVoyageId) {
            const ve = entriesRef.current.filter((e) => e.voyageId === stoppedVoyageId);
            const dist = ve.length ? Math.max(0, ...ve.map((e) => e.cumulativeDistanceNM || 0)) : 0;
            const hasManual = ve.some((e) => e.entryType === 'manual');
            if (dist < 0.05 && !hasManual) {
                // OPTIMISTIC (Shane 2026-08-12: the tidy-up "takes some time
                // to come"). The wait was the awaited cloud delete — a network
                // round trip standing between End Voyage and the announcement.
                // The verdict (empty, ours, just stopped) is already local
                // truth: remove the card and announce NOW, delete in the
                // background. ShipLogService has usually already binned the
                // queue copy pre-upload; if the cloud delete fails anyway, the
                // sweep retries it on the next load via the device-stops
                // bypass, so the card cannot silently resurrect for long.
                dispatch({ type: 'REMOVE_VOYAGE', voyageId: stoppedVoyageId });
                loadedVoyagesRef.current.delete(stoppedVoyageId);
                void clearCachedVoyageTrack(stoppedVoyageId);
                setEmptyPruneNotice(1);
                void ShipLogService.deleteVoyage(stoppedVoyageId).catch((e) => {
                    log.warn('empty-voyage prune on stop failed (sweep will retry)', e);
                });
            }
        }

        // Reload to pick up final state
        await loadData();
    }, [dispatch, identityScope, loadData, toast]);

    // ── Entry CRUD ──────────────────────────────────────────────────────────

    // ── Soft-delete with undo ──
    const [deletedEntry, setDeletedEntry] = useState<ShipLogEntry | null>(null);
    const deletingEntryRef = useRef(false);
    useEffect(() => {
        setDeletedEntry(null);
        deletingEntryRef.current = false;
    }, [identityScope]);

    const handleDeleteEntry = useCallback(
        (entryId: string) => {
            if (!isAuthIdentityScopeCurrent(identityScope)) return;
            // Guard: prevent double-fire from stale callbacks
            if (deletingEntryRef.current) return;
            deletingEntryRef.current = true;

            const entry = entriesRef.current.find((e) => e.id === entryId);
            if (!entry) {
                deletingEntryRef.current = false;
                return;
            }

            // Remove from UI immediately
            dispatch({ type: 'UPDATE_ENTRIES', updater: (prev) => prev.filter((e) => e.id !== entryId) });
            setDeletedEntry(entry);
        },
        [dispatch, identityScope],
    );

    // Called by UndoToast after 5s — performs the actual API delete
    const handleDismissDeleteEntry = useCallback(async () => {
        const actionScope = identityScope;
        if (!isAuthIdentityScopeCurrent(actionScope)) return;
        if (!deletedEntry) return;
        const entry = deletedEntry;
        setDeletedEntry(null);
        deletingEntryRef.current = false;
        try {
            const success = await ShipLogService.deleteEntry(entry.id);
            if (!isAuthIdentityScopeCurrent(actionScope)) return;
            if (!success) {
                toast.error('Failed to delete entry');
                dispatch({ type: 'UPDATE_ENTRIES', updater: (prev) => [...prev, entry] });
            }
        } catch (e) {
            if (!isAuthIdentityScopeCurrent(actionScope)) return;
            toast.error('Failed to delete entry');
            dispatch({ type: 'UPDATE_ENTRIES', updater: (prev) => [...prev, entry] });
        }
    }, [deletedEntry, dispatch, identityScope, toast]);

    const handleUndoDeleteEntry = useCallback(() => {
        if (!isAuthIdentityScopeCurrent(identityScope)) return;
        if (deletedEntry) {
            dispatch({ type: 'UPDATE_ENTRIES', updater: (prev) => [...prev, deletedEntry] });
            toast.success('Entry restored');
        }
        setDeletedEntry(null);
        deletingEntryRef.current = false;
    }, [deletedEntry, dispatch, identityScope, toast]);

    const handleEditEntry = useCallback(
        (entry: ShipLogEntry) => {
            if (!isAuthIdentityScopeCurrent(identityScope)) return;
            dispatch({ type: 'SET_EDIT_ENTRY', entry });
        },
        [dispatch, identityScope],
    );

    const handleSaveEdit = useCallback(
        (entryId: string, updates: { notes?: string; waypointName?: string }) => {
            if (!isAuthIdentityScopeCurrent(identityScope)) return;
            dispatch({
                type: 'UPDATE_ENTRIES',
                updater: (prev) => prev.map((e) => (e.id === entryId ? { ...e, ...updates } : e)),
            });
            toast.success('Entry updated');
        },
        [dispatch, identityScope, toast],
    );

    // ── Voyage Management ───────────────────────────────────────────────────

    // Tracks which voyages have had their full points lazy-loaded this
    // session, so we don't re-fetch on every expand toggle.
    const loadedVoyagesRef = useRef<Set<string>>(new Set());
    const loadingVoyagesRef = useRef<Set<string>>(new Set());
    useEffect(() => {
        loadedVoyagesRef.current.clear();
        loadingVoyagesRef.current.clear();
    }, [identityScope]);

    /**
     * Lazy-load a single voyage's FULL points (the list itself only holds
     * summaries). Called when the user expands a card or opens its map /
     * stats / export. Idempotent: skips voyages already loaded or in
     * flight, and the active live-tracking voyage (already resident).
     */
    const loadVoyageEntries = useCallback(
        async (voyageId: string) => {
            const actionScope = identityScope;
            if (!isAuthIdentityScopeCurrent(actionScope)) return;
            if (!voyageId) return;
            if (loadedVoyagesRef.current.has(voyageId) || loadingVoyagesRef.current.has(voyageId)) return;
            // Only the ACTIVELY-RECORDING voyage may claim residency — its
            // points stream into state live, so a fetch would be redundant.
            // The old check latched on ANY resident row (`entries.some`), but
            // the boot seed also loads offline-queue stragglers and a stopped
            // voyage can leave 1-2 of those behind: one stray row marked the
            // voyage "loaded", the 2,800-point fetch never ran, and the track
            // viewer starved at "Loading track…" forever (Shane 2026-07-10 —
            // one test track opened, the other never did).
            if (voyageId === ShipLogService.getCurrentVoyageId()) {
                loadedVoyagesRef.current.add(voyageId);
                return;
            }
            loadingVoyagesRef.current.add(voyageId);

            // Replace-then-merge: swap THIS voyage's resident entries for the
            // incoming batch (instead of accumulating), so a cached paint
            // followed by the network refresh never doubles the points —
            // cached entries carry trkc_* ids, fresh ones real DB ids.
            const swapIn = (batch: ShipLogEntry[]) =>
                isAuthIdentityScopeCurrent(actionScope) &&
                dispatch({
                    type: 'UPDATE_ENTRIES',
                    updater: (prev) =>
                        mergeRecentEntries(
                            prev.filter((e) => e.voyageId !== voyageId),
                            batch,
                        ),
                });

            let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
            try {
                // CACHE-FIRST: paint instantly from the local track cache
                // (written when the voyage stopped, or on a previous view),
                // then refresh from Supabase in the background.
                const cached = await getCachedVoyageTrack(voyageId);
                if (!isAuthIdentityScopeCurrent(actionScope)) return;
                const haveCache = !!cached && cached.length >= 2;
                if (haveCache) swapIn(cached);

                // Timeout the (paginated, un-cancellable) fetch so a cold
                // view on bad comms shows what we have instead of hanging.
                // Generous budget when a cached track is already painted.
                // 8 s → 45 s cold budget (audit 2026-07-03): a full-retention
                // one-day passage is many 1000-row pages; on boat comms the old
                // 8 s race expired mid-pagination EVERY time for a big voyage,
                // so an uncached track could never be opened at anchor. The
                // fetch still resolves partial-page-by-page server-side; the
                // budget only bounds how long the spinner can live.
                const timeoutMs = haveCache ? 30_000 : 45_000;
                const voyageEntries = await Promise.race([
                    ShipLogService.getVoyageEntries(voyageId),
                    new Promise<ShipLogEntry[]>(
                        (_, reject) =>
                            (timeoutHandle = setTimeout(() => reject(new Error('voyage-fetch-timeout')), timeoutMs)),
                    ),
                ]);
                if (!isAuthIdentityScopeCurrent(actionScope)) return;

                if (voyageEntries.length > 0) {
                    swapIn(voyageEntries);
                    void setCachedVoyageTrack(voyageId, voyageEntries);
                    loadedVoyagesRef.current.add(voyageId);
                } else if (haveCache) {
                    // Nothing in the cloud (yet) — the cached copy stands.
                    loadedVoyagesRef.current.add(voyageId);
                }
            } catch (e) {
                // Timeout / network failure: the cached paint (if any)
                // stands, and NOT marking the voyage loaded means the next
                // open retries the refresh.
                if (isAuthIdentityScopeCurrent(actionScope)) log.warn('loadVoyageEntries failed', e);
            } finally {
                if (timeoutHandle) clearTimeout(timeoutHandle);
                if (isAuthIdentityScopeCurrent(actionScope)) loadingVoyagesRef.current.delete(voyageId);
            }
        },
        [dispatch, identityScope],
    );

    const toggleVoyage = useCallback(
        (voyageId: string) => {
            if (!isAuthIdentityScopeCurrent(identityScope)) return;
            // Expanding (it wasn't already expanded) → lazy-load its points.
            if (!expandedRef.current.has(voyageId)) {
                void loadVoyageEntries(voyageId);
            }
            dispatch({ type: 'TOGGLE_VOYAGE', voyageId });
        },
        [dispatch, identityScope, loadVoyageEntries],
    );

    // Opt-in heavy load: pulls a bounded window of ALL entries into state.
    // Used only by the "All Voyages" statistics deep-dive (an explicit
    // user action), so the default Log open never pays this cost.
    const allEntriesLoadedRef = useRef(false);
    useEffect(() => {
        allEntriesLoadedRef.current = false;
    }, [identityScope]);
    const loadAllEntries = useCallback(async () => {
        const actionScope = identityScope;
        if (!isAuthIdentityScopeCurrent(actionScope)) return;
        if (allEntriesLoadedRef.current || loadingRef.current) return;
        loadingRef.current = true;
        try {
            const [dbEntries, offlineEntries] = await Promise.all([
                ShipLogService.getLogEntries(MAX_LIST_ENTRIES),
                ShipLogService.getOfflineEntries(),
            ]);
            if (!isAuthIdentityScopeCurrent(actionScope)) return;
            dispatch({
                type: 'UPDATE_ENTRIES',
                updater: (prev) => mergeRecentEntries(prev, [...dbEntries, ...offlineEntries]),
            });
            allEntriesLoadedRef.current = true;
        } catch (e) {
            if (isAuthIdentityScopeCurrent(actionScope)) log.warn('loadAllEntries failed', e);
        } finally {
            if (isAuthIdentityScopeCurrent(actionScope)) loadingRef.current = false;
        }
    }, [dispatch, identityScope]);

    // ── Soft-delete voyage with undo ──
    // Holds the removed voyage's summary (so the card can be restored even
    // when its points were never lazy-loaded) plus whatever points were
    // resident at delete time.
    const [deletedVoyage, setDeletedVoyage] = useState<{
        voyageId: string;
        entries: ShipLogEntry[];
        summary: VoyageSummary | null;
    } | null>(null);
    useEffect(() => {
        setDeletedVoyage(null);
    }, [identityScope]);

    const handleDeleteVoyageRequest = useCallback(
        async (voyageId: string) => {
            const actionScope = identityScope;
            if (!isAuthIdentityScopeCurrent(actionScope)) return;

            // THE TAP ACTS FIRST. The card is removed and the undo countdown
            // starts the moment the skipper's finger lifts — nothing sits
            // between them and the screen. This used to await a shared-track
            // check (unbounded, then bounded to 2.5 s) before the card moved,
            // which on a marine link was still 2.5 s of a tap apparently
            // ignored. Nothing about the check needs to precede the removal:
            // the actual delete happens 5 s from now at the earliest.
            const voyageEntries = state.entries.filter((e) => e.voyageId === voyageId);
            const summary = state.summaries.find((s) => s.voyageId === voyageId) ?? null;
            dispatch({ type: 'REMOVE_VOYAGE', voyageId });
            setDeletedVoyage({ voyageId, entries: voyageEntries, summary });

            // The shared-track warning runs BEHIND the removal, with the whole
            // undo window as its budget instead of 2.5 s of the skipper's
            // patience. If shares exist, the card comes back (the same restore
            // undo performs) and the warning dialog takes over — the delete
            // has not happened yet, so nothing is lost either way. If the
            // check fails or times out, the delete proceeds as unshared:
            // fail-open, same trade as before, bigger budget.
            void (async () => {
                try {
                    const sharedTracks = await withTimeout(
                        TrackSharingService.getSharedTracksByVoyageId(voyageId),
                        [] as Awaited<ReturnType<typeof TrackSharingService.getSharedTracksByVoyageId>>,
                        4000,
                    );
                    if (!isAuthIdentityScopeCurrent(actionScope)) return;
                    if (sharedTracks.length === 0) return;
                    const trackInfo = sharedTracks
                        .map((t) => `"${t.title}" (${t.download_count || 0} downloads)`)
                        .join(', ');
                    // Put the card back and let the dialog decide. Guard on the
                    // undo window still being open for THIS voyage — if it has
                    // already elapsed, executeVoyageDelete owns the outcome and
                    // resurrecting the card here would fight it.
                    setDeletedVoyage((current) => {
                        if (!current || current.voyageId !== voyageId) return current;
                        if (current.entries.length > 0) {
                            dispatch({ type: 'UPDATE_ENTRIES', updater: (prev) => [...prev, ...current.entries] });
                        }
                        if (current.summary) {
                            dispatch({ type: 'RESTORE_SUMMARY', summary: current.summary });
                        }
                        setShowSharedVoyageWarning({ voyageId, trackInfo });
                        return null;
                    });
                } catch (e) {
                    if (isAuthIdentityScopeCurrent(actionScope)) log.warn('shared track check failed:', e);
                }
            })();
        },
        [dispatch, identityScope, state.entries, state.summaries],
    );

    // Called by UndoToast after 5s — performs the actual voyage delete
    const handleDismissDeleteVoyage = useCallback(async () => {
        if (!isAuthIdentityScopeCurrent(identityScope)) return;
        if (!deletedVoyage) return;
        const { voyageId } = deletedVoyage;
        setDeletedVoyage(null);
        await executeVoyageDelete(voyageId);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [deletedVoyage, identityScope]);

    const handleUndoDeleteVoyage = useCallback(() => {
        if (!isAuthIdentityScopeCurrent(identityScope)) return;
        if (deletedVoyage) {
            // Restore resident points (if any were loaded)…
            if (deletedVoyage.entries.length > 0) {
                dispatch({ type: 'UPDATE_ENTRIES', updater: (prev) => [...prev, ...deletedVoyage.entries] });
            }
            // …and the summary card itself.
            if (deletedVoyage.summary) {
                const restored = deletedVoyage.summary;
                dispatch({
                    type: 'SET_SUMMARIES',
                    summaries: [restored, ...state.summaries.filter((s) => s.voyageId !== restored.voyageId)],
                });
            }
            toast.success('Voyage restored');
        }
        setDeletedVoyage(null);
    }, [deletedVoyage, dispatch, identityScope, toast, state.summaries]);

    // Track shared voyage warning state for ConfirmDialog in UI
    const [showSharedVoyageWarning, setShowSharedVoyageWarning] = useState<{
        voyageId: string;
        trackInfo: string;
    } | null>(null);
    useEffect(() => {
        setShowSharedVoyageWarning(null);
    }, [identityScope]);

    const handleConfirmDeleteVoyage = useCallback(async () => {
        const actionScope = identityScope;
        if (!isAuthIdentityScopeCurrent(actionScope)) return;
        if (!state.deleteVoyageId) return;
        const voyageId = state.deleteVoyageId;

        // Check if this voyage has been shared to the community. This is the
        // ONE network call that genuinely belongs before the delete proceeds —
        // it decides whether to show the "this is shared" warning — so it
        // stays, but BOUNDED. On a marine link an uncapped query here was the
        // first of several seconds of nothing visibly happening after the
        // skipper tapped Delete. Fail OPEN: if the check cannot answer in
        // time, proceed as unshared. The downside is a missed warning; the
        // alternative was a delete that appeared to ignore the tap.
        try {
            const sharedTracks = await withTimeout(
                TrackSharingService.getSharedTracksByVoyageId(voyageId),
                [] as Awaited<ReturnType<typeof TrackSharingService.getSharedTracksByVoyageId>>,
                2500,
            );
            if (!isAuthIdentityScopeCurrent(actionScope)) return;
            if (sharedTracks.length > 0) {
                const trackInfo = sharedTracks
                    .map((t) => `"${t.title}" (${t.download_count || 0} downloads)`)
                    .join(', ');
                // Show custom confirm dialog instead of native confirm()
                setShowSharedVoyageWarning({ voyageId, trackInfo });
                return; // Wait for user to confirm via UI
            }
        } catch (e) {
            if (!isAuthIdentityScopeCurrent(actionScope)) return;
            log.warn('shared track check failed:', e);
        }

        // No shared tracks — proceed directly
        await executeVoyageDelete(voyageId);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [identityScope, state.deleteVoyageId]);

    const executeVoyageDelete = useCallback(
        async (voyageId: string) => {
            const actionScope = identityScope;
            if (!isAuthIdentityScopeCurrent(actionScope)) return;

            // The row leaves the screen on the ACCEPTANCE BOUNDARY — the
            // durable local tombstone — not when the cloud finishes. That is
            // the boundary deleteVoyage itself defines: from the tombstone on,
            // the voyage is gone on this device whether or not the network
            // ever answers, and every cloud step after it has its own timeout
            // and its own retry ledger. Awaiting the lot before touching the
            // UI made "delete a track" take up to ~16 s on a marine link for
            // an outcome decided in the first milliseconds.
            let accepted = false;
            const onAccepted = () => {
                if (!isAuthIdentityScopeCurrent(actionScope)) return;
                accepted = true;
                dispatch({ type: 'UPDATE_ENTRIES', updater: (prev) => prev.filter((e) => e.voyageId !== voyageId) });
                // A deleted voyage's cached track must not resurrect it.
                void clearCachedVoyageTrack(voyageId);
                loadedVoyagesRef.current.delete(voyageId);
                // Close the dialog NOW. The skipper tapped Delete; the thing
                // is gone; there is nothing left to confirm.
                dispatch({ type: 'REQUEST_DELETE_VOYAGE', voyageId: null });
                setShowSharedVoyageWarning(null);
            };

            const success = await ShipLogService.deleteVoyage(voyageId, onAccepted);
            if (!isAuthIdentityScopeCurrent(actionScope)) return;

            if (!accepted) {
                // The tombstone itself could not be written — the only genuine
                // failure. Nothing was removed from the screen, so this message
                // is true, which is what the old "Failed to delete voyage"
                // shown after the row had already vanished was not.
                toast.error('Could not delete voyage — please try again');
                dispatch({ type: 'REQUEST_DELETE_VOYAGE', voyageId: null });
                setShowSharedVoyageWarning(null);
                return;
            }

            // Background cascade, after the UI is already done. Community
            // shares are a CONSEQUENCE of the voyage, not a precondition of
            // deleting it, and this used to sit in front of everything.
            void TrackSharingService.deleteSharedTracksByVoyageId(voyageId).catch(() => {
                /* ok — may not exist, and the delete is already accepted */
            });
            reloadCareerData();
            if (!success) {
                // Accepted locally, cloud still pending in the retry ledger.
                // Not an error for the skipper; the ledger will land it.
                log.info('voyage delete accepted locally; cloud cleanup queued');
            }
        },
        [dispatch, identityScope, toast, reloadCareerData],
    );

    const confirmDeleteSharedVoyage = useCallback(() => {
        if (!isAuthIdentityScopeCurrent(identityScope)) return;
        if (showSharedVoyageWarning) {
            void executeVoyageDelete(showSharedVoyageWarning.voyageId);
        }
    }, [identityScope, showSharedVoyageWarning, executeVoyageDelete]);

    const cancelDeleteSharedVoyage = useCallback(() => {
        if (!isAuthIdentityScopeCurrent(identityScope)) return;
        dispatch({ type: 'REQUEST_DELETE_VOYAGE', voyageId: null });
        setShowSharedVoyageWarning(null);
    }, [dispatch, identityScope]);

    // ── Export / Share ───────────────────────────────────────────────────────

    // The Log is a record of what actually happened. Suggested routes stay in
    // the underlying state because cast-off and planned-vs-sailed comparison
    // need them, but an unscoped Log export/share must never quietly mix those
    // plans into the sailed record. Check both provenance and the summary flag:
    // old/offline rows are not guaranteed to carry source on every point.
    const plannedVoyageIdsForPresentation = useMemo(() => {
        const ids = new Set(
            state.summaries.filter((summary) => summary.isPlannedRoute).map((summary) => summary.voyageId),
        );
        for (const entry of state.entries) {
            if (entry.source === 'planned_route' && entry.voyageId) ids.add(entry.voyageId);
        }
        return ids;
    }, [state.entries, state.summaries]);
    const loggedEntriesForPresentation = useMemo(
        () =>
            state.entries.filter(
                (entry) =>
                    entry.source !== 'planned_route' &&
                    (!entry.voyageId || !plannedVoyageIdsForPresentation.has(entry.voyageId)),
            ),
        [plannedVoyageIdsForPresentation, state.entries],
    );

    const handleExportCSV = useCallback(async () => {
        const actionScope = identityScope;
        if (!isAuthIdentityScopeCurrent(actionScope)) return;
        const targetEntries = state.selectedVoyageId
            ? loggedEntriesForPresentation.filter((e) => e.voyageId === state.selectedVoyageId)
            : loggedEntriesForPresentation;
        const { exportToCSV } = await import('../utils/logExport');
        if (!isAuthIdentityScopeCurrent(actionScope)) return;
        exportToCSV(targetEntries, 'ships_log.csv', {
            onProgress: () => {},
            onSuccess: () => {},
            onError: (err) => {
                if (isAuthIdentityScopeCurrent(actionScope)) toast.error(err);
            },
        });
    }, [identityScope, loggedEntriesForPresentation, state.selectedVoyageId, toast]);

    const handleShare = useCallback(async () => {
        const actionScope = identityScope;
        if (!isAuthIdentityScopeCurrent(actionScope)) return;
        const targetEntries = state.selectedVoyageId
            ? loggedEntriesForPresentation.filter((e) => e.voyageId === state.selectedVoyageId)
            : loggedEntriesForPresentation;
        const { sharePDF } = await import('../utils/logExport');
        if (!isAuthIdentityScopeCurrent(actionScope)) return;
        await sharePDF(
            targetEntries,
            {
                onProgress: () => {},
                onSuccess: () => {},
                onError: (err) => {
                    if (isAuthIdentityScopeCurrent(actionScope)) toast.error(err);
                },
            },
            settings.vessel?.name,
            { vessel: settings.vessel, vesselUnits: settings.vesselUnits, units: settings.units },
        );
    }, [
        identityScope,
        loggedEntriesForPresentation,
        state.selectedVoyageId,
        settings.vessel,
        settings.vesselUnits,
        settings.units,
        toast,
    ]);

    const handleExportThenDelete = useCallback(async () => {
        await handleShare();
    }, [handleShare]);

    const handleExportGPX = useCallback(async () => {
        const actionScope = identityScope;
        if (!isAuthIdentityScopeCurrent(actionScope)) return;
        const targetEntries = state.selectedVoyageId
            ? loggedEntriesForPresentation.filter((e) => e.voyageId === state.selectedVoyageId)
            : loggedEntriesForPresentation;
        if (targetEntries.length === 0) return;
        const voyageName = state.selectedVoyageId ? `Voyage ${state.selectedVoyageId.slice(0, 8)}` : 'All Voyages';
        const gpxXml = exportVoyageAsGPX(targetEntries, voyageName, settings.vessel?.name);
        dispatch({ type: 'SET_ACTION_SHEET', sheet: null });
        try {
            await shareGPXFile(gpxXml, `${voyageName.replace(/\s+/g, '_').toLowerCase()}.gpx`);
        } catch (e) {
            if (!isAuthIdentityScopeCurrent(actionScope)) return;
            // AbortError = user dismissed the native share sheet — not a
            // failure, stay silent. Anything else is a real export error.
            if (e instanceof Error && e.name === 'AbortError') return;
            log.warn('GPX export failed:', e);
            toast.error('Could not export the GPX file — try again.');
        }
    }, [dispatch, identityScope, loggedEntriesForPresentation, state.selectedVoyageId, settings.vessel?.name, toast]);

    const handleImportGPXFile = useCallback(
        async (file: File) => {
            const actionScope = identityScope;
            if (!isAuthIdentityScopeCurrent(actionScope)) return;
            try {
                const gpxXml = await readGPXFile(file);
                if (!isAuthIdentityScopeCurrent(actionScope)) return;
                const entries = importGPXToEntries(gpxXml);
                if (entries.length === 0) {
                    toast.error('No valid track points found in file');
                    return;
                }
                // Stamp with provenance
                entries.forEach((e) => {
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    (e as any).source = 'gpx_import';
                });
                const { savedCount } = await ShipLogService.importGPXVoyage(entries);
                if (!isAuthIdentityScopeCurrent(actionScope)) return;
                toast.success(`Imported ${savedCount} entries from ${file.name}`);
                await loadData();
            } catch (err: unknown) {
                if (isAuthIdentityScopeCurrent(actionScope)) {
                    toast.error(getErrorMessage(err) || 'Failed to import GPX file');
                }
            }
        },
        [identityScope, toast, loadData],
    );

    const handleShareToCommunity = useCallback(
        async (shareData: { title: string; description: string; category: TrackCategory; region: string }) => {
            const actionScope = identityScope;
            if (!isAuthIdentityScopeCurrent(actionScope)) return;
            dispatch({ type: 'SET_ACTION_SHEET', sheet: null });
            const targetEntries = state.selectedVoyageId
                ? loggedEntriesForPresentation.filter((e) => e.voyageId === state.selectedVoyageId)
                : loggedEntriesForPresentation;
            if (targetEntries.length === 0) {
                toast.error('No entries to share');
                return;
            }

            try {
                const result = await TrackSharingService.shareTrack(targetEntries, {
                    title: shareData.title,
                    description: shareData.description,
                    tags: [],
                    category: shareData.category,
                    region: shareData.region,
                });
                if (!isAuthIdentityScopeCurrent(actionScope)) return;
                if (result) {
                    toast.success('Track shared to community!');
                } else {
                    toast.error('Failed to share track');
                }
            } catch (err: unknown) {
                if (isAuthIdentityScopeCurrent(actionScope)) {
                    toast.error(getErrorMessage(err) || 'Share failed');
                }
            }
        },
        [dispatch, identityScope, loggedEntriesForPresentation, state.selectedVoyageId, toast],
    );

    // ── Derived State ───────────────────────────────────────────────────────

    const filteredEntries = useMemo(() => {
        let filtered = state.entries;
        filtered = filterEntriesByType(filtered, state.filters.types);
        filtered = searchEntries(filtered, state.filters.searchQuery);
        return filtered;
    }, [state.entries, state.filters]);

    const groupedEntries = useMemo(() => {
        const newestFirst = [...filteredEntries].sort(
            (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
        );
        return groupEntriesByDate(newestFirst);
    }, [filteredEntries]);

    const entryCounts = useMemo(
        () => ({
            auto: state.entries.filter((e) => e.entryType === 'auto').length,
            manual: state.entries.filter((e) => e.entryType === 'manual').length,
            waypoint: state.entries.filter((e) => e.entryType === 'waypoint').length,
        }),
        [state.entries],
    );

    const voyageGroups = useMemo(() => {
        const groups = groupEntriesByVoyage(state.entries);
        // Sort: planned routes first, then by newest timestamp
        return groups.sort((a, b) => {
            const aPlanned = isPlannedRouteGroup(a);
            const bPlanned = isPlannedRouteGroup(b);
            if (aPlanned && !bPlanned) return -1;
            if (!aPlanned && bPlanned) return 1;
            // Then by most recent timestamp
            const aTime = Math.max(...a.entries.map((e) => new Date(e.timestamp).getTime()));
            const bTime = Math.max(...b.entries.map((e) => new Date(e.timestamp).getTime()));
            return bTime - aTime;
        });
    }, [state.entries]);

    // Voyage groups that were ACTUALLY SAILED — planned/suggested routes
    // (any entry with source='planned_route') excluded. Added 2026-05-20:
    // suggested routes are aspirational, not logged miles, so they must
    // NOT inflate the stats totals (top gauge tiles + the 3-dot Stats
    // sheet). They remain in the raw `voyageGroups` data for cast-off
    // choices and planned-vs-sailed overlays; LogPage filters them from
    // the factual voyage list at its presentation boundary.
    // Predicate lives in utils/voyageStats so the rule stays testable
    // and consistent across every stat surface.
    const sailedVoyageGroups = useMemo(() => excludeSuggestedRoutes(voyageGroups), [voyageGroups]);

    // ── Summary-driven list + stats ──────────────────────────────────────
    // listVoyages drives the card list: server summaries, with the active
    // live-tracking voyage and any lazy-loaded voyages overlaid live from
    // their resident points (mergeSummariesWithLive). One row per voyage,
    // no full point arrays — this is what makes the list render instantly.
    const listVoyages = useMemo(
        () => mergeSummariesWithLive(state.summaries, state.entries),
        [state.summaries, state.entries],
    );

    // Top gauge tiles + voyage count, aggregated from summaries so they are
    // accurate across the user's ENTIRE history without loading any points.
    // Suggested/planned routes excluded (aspirational, not sailed miles).
    const voyageStats = useMemo(() => {
        // Maritime only — exclude planned, imported AND land voyages (car
        // drives / walks). A land track isn't sea miles or time at sea and
        // shouldn't pad the voyage count. (Was excluding only planned, so
        // land walks were padding all three tiles.)
        const sailed = listVoyages.filter(isMaritimeVoyage);
        let totalNm = 0;
        let totalMs = 0;
        for (const v of sailed) {
            totalNm += v.totalDistanceNM || 0;
            const start = new Date(v.startedAt).getTime();
            const end = new Date(v.endedAt).getTime();
            if (isFinite(start) && isFinite(end) && end > start) totalMs += end - start;
        }
        return { totalNm, totalMs, voyageCount: sailed.length };
    }, [listVoyages]);

    const hasNonDeviceEntries = useMemo(() => {
        const targetEntries = state.selectedVoyageId
            ? loggedEntriesForPresentation.filter((e) => e.voyageId === state.selectedVoyageId)
            : loggedEntriesForPresentation;
        return targetEntries.some((e) => e.source && e.source !== 'device');
    }, [loggedEntriesForPresentation, state.selectedVoyageId]);

    // Total distance: sum each voyage's max cumulative distance
    const totalDistance = useMemo(() => {
        const voyageMap = new Map<string, number>();
        filteredEntries.forEach((e) => {
            const vid = e.voyageId || 'default';
            const current = voyageMap.get(vid) || 0;
            voyageMap.set(vid, Math.max(current, e.cumulativeDistanceNM || 0));
        });
        let total = 0;
        voyageMap.forEach((d) => {
            total += d;
        });
        return total;
    }, [filteredEntries]);

    // Average speed: across all entries with speed > 0
    const avgSpeed = useMemo(() => {
        const withSpeed = filteredEntries.filter((e) => e.speedKts && e.speedKts > 0);
        return withSpeed.length > 0 ? withSpeed.reduce((sum, e) => sum + (e.speedKts || 0), 0) / withSpeed.length : 0;
    }, [filteredEntries]);

    // ── Career Totals ───────────────────────────────────────────────────────
    // Aggregated from voyage SUMMARIES (one row per voyage) rather than the
    // old getAllEntriesForCareer projection, which capped at 10k entries and
    // silently under-counted heavy histories. listVoyages includes the live
    // active voyage, so career miles tick up in real time. Only the sailor's
    // own maritime voyages count — imports/planned routes excluded, land
    // tracks filtered by landFraction majority vote. See VoyageSummary.ts.
    const careerTotals = useMemo(() => careerTotalsFromSummaries(listVoyages), [listVoyages]);

    // ── Archive handlers ─────────────────────────────────────────────────────

    const handleArchiveVoyage = useCallback(
        async (voyageId: string) => {
            const actionScope = identityScope;
            if (!isAuthIdentityScopeCurrent(actionScope)) return;
            const success = await ShipLogService.archiveVoyage(voyageId);
            if (!isAuthIdentityScopeCurrent(actionScope)) return;
            if (success) {
                // Immediately remove from active view (summary card + any
                // resident points for the voyage).
                dispatch({ type: 'REMOVE_VOYAGE', voyageId });
                toast.success('Voyage archived');
                reloadCareerData();
            } else {
                toast.error('Failed to archive voyage — check if the "archived" column exists in Supabase');
            }
        },
        [dispatch, identityScope, toast, reloadCareerData],
    );

    const handleUnarchiveVoyage = useCallback(
        async (voyageId: string) => {
            const actionScope = identityScope;
            if (!isAuthIdentityScopeCurrent(actionScope)) return;
            const success = await ShipLogService.unarchiveVoyage(voyageId);
            if (!isAuthIdentityScopeCurrent(actionScope)) return;
            if (success) {
                await loadData();
                if (!isAuthIdentityScopeCurrent(actionScope)) return;
                reloadCareerData();
                toast.success('Voyage restored');
            } else {
                toast.error('Failed to unarchive voyage');
            }
        },
        [identityScope, loadData, reloadCareerData, toast],
    );

    // ── Public API ──────────────────────────────────────────────────────────

    return {
        // Raw state
        state,
        dispatch,

        // Settings (needed by JSX)
        settings,

        // Tracking
        handleStartTracking,
        startTrackingWithNewVoyage,
        continueLastVoyage,
        handlePauseTracking,
        handleToggleRapidMode,
        handleTogglePrecisionMode,
        handleStopTracking,
        confirmStopVoyage,

        // Entry CRUD
        handleDeleteEntry,
        handleUndoDeleteEntry,
        handleDismissDeleteEntry,
        deletedEntry: stateBelongsToCurrentIdentity ? deletedEntry : null,
        handleEditEntry,
        handleSaveEdit,
        loadData,

        // Voyage management
        toggleVoyage,
        handleDeleteVoyageRequest,
        handleConfirmDeleteVoyage,
        deletedVoyage: stateBelongsToCurrentIdentity ? deletedVoyage : null,
        handleUndoDeleteVoyage,
        handleDismissDeleteVoyage,
        showSharedVoyageWarning: stateBelongsToCurrentIdentity ? showSharedVoyageWarning : null,
        confirmDeleteSharedVoyage,
        cancelDeleteSharedVoyage,

        // Export / share
        handleExportCSV,
        handleShare,
        handleExportThenDelete,
        handleExportGPX,
        handleImportGPXFile,
        handleShareToCommunity,

        // Derived state
        filteredEntries,
        groupedEntries,
        entryCounts,
        voyageGroups,
        sailedVoyageGroups,
        // Summary-driven list + stats (the perf-critical path)
        summaries: state.summaries,
        listVoyages,
        voyageStats,
        loadVoyageEntries,
        loadAllEntries,
        hasNonDeviceEntries,
        totalDistance,
        avgSpeed,
        careerTotals,

        // Archive
        archivedVoyages: stateBelongsToCurrentIdentity ? archivedVoyages : [],
        handleArchiveVoyage,
        handleUnarchiveVoyage,

        // Empty-track tidy announcement
        emptyPruneNotice: stateBelongsToCurrentIdentity ? emptyPruneNotice : null,
        clearEmptyPruneNotice: () => {
            if (isAuthIdentityScopeCurrent(identityScope)) setEmptyPruneNotice(null);
        },
    };
}
