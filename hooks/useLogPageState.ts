/**
 * useLogPageState — Custom hook extracting all state & business logic from LogPage.
 *
 * Before: LogPage had 26 useState calls, 30+ handlers, and derived data
 * all in a single 1200-line component.
 *
 * After: LogPage is a pure rendering shell (~500 lines of JSX).
 * All state, effects, and handlers live here.
 */

import { useState, useEffect, useCallback, useMemo, useReducer } from 'react';
import { ShipLogService } from '../services/ShipLogService';
import { BgGeoManager } from '../services/BgGeoManager';
import { ShipLogEntry } from '../types';
import { useToast } from '../components/Toast';
import { useSettings } from '../context/SettingsContext';
import { exportToCSV, sharePDF } from '../utils/logExport';
import { groupEntriesByDate, filterEntriesByType, searchEntries } from '../utils/voyageData';
import { exportVoyageAsGPX, shareGPXFile, readGPXFile, importGPXToEntries } from '../services/gpxService';
import { TrackSharingService, TrackCategory } from '../services/TrackSharingService';
import { LogFilters } from '../components/LogFilterToolbar';
import { getErrorMessage } from '../utils/logger';

// ─── STATE SHAPE ──────────────────────────────────────────────────────────────

interface LogPageState {
    entries: ShipLogEntry[];
    isTracking: boolean;
    isPaused: boolean;
    isRapidMode: boolean;
    loading: boolean;

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
    lastVoyageId: string | null;
    expandedVoyages: Set<string>;
    gpsStatus: 'locked' | 'stale' | 'none';

    // Filters
    filters: LogFilters;
}

// ─── ACTIONS ──────────────────────────────────────────────────────────────────

type LogPageAction =
    | { type: 'LOAD_DATA'; entries: ShipLogEntry[]; isTracking: boolean; isPaused: boolean; isRapidMode: boolean; currentVoyageId: string | undefined }
    | { type: 'SET_ENTRIES'; entries: ShipLogEntry[] }
    | { type: 'UPDATE_ENTRIES'; updater: (prev: ShipLogEntry[]) => ShipLogEntry[] }
    | { type: 'SET_TRACKING'; isTracking: boolean; isPaused: boolean }
    | { type: 'SET_RAPID_MODE'; isRapidMode: boolean }
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
    isTracking: false,
    isPaused: false,
    isRapidMode: false,
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
    lastVoyageId: null,
    expandedVoyages: new Set(),
    gpsStatus: 'none',
    filters: { types: ['auto', 'manual', 'waypoint'], searchQuery: '' },
};

function logPageReducer(state: LogPageState, action: LogPageAction): LogPageState {
    switch (action.type) {
        case 'LOAD_DATA': {
            // Preserve user's expand/collapse state during polls.
            // Only auto-expand active voyage on FIRST load (when entries are empty).
            const expandedVoyages = action.currentVoyageId && state.entries.length === 0
                ? new Set([action.currentVoyageId])
                : state.expandedVoyages;
            return {
                ...state,
                entries: action.entries,
                isTracking: action.isTracking,
                isPaused: action.isPaused,
                isRapidMode: action.isRapidMode,
                currentVoyageId: action.currentVoyageId,
                expandedVoyages,
                loading: false,
            };
        }
        case 'SET_ENTRIES':
            return { ...state, entries: action.entries };
        case 'UPDATE_ENTRIES':
            return { ...state, entries: action.updater(state.entries) };
        case 'SET_TRACKING':
            return { ...state, isTracking: action.isTracking, isPaused: action.isPaused, isRapidMode: false };
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

// ─── HELPER: Group entries by voyage ──────────────────────────────────────────

function groupEntriesByVoyage(entries: ShipLogEntry[]) {
    const voyageMap = new Map<string, ShipLogEntry[]>();

    entries.forEach(entry => {
        const voyageId = entry.voyageId || 'default_voyage';
        if (!voyageMap.has(voyageId)) {
            voyageMap.set(voyageId, []);
        }
        voyageMap.get(voyageId)!.push(entry);
    });

    return Array.from(voyageMap.entries())
        .map(([voyageId, entries]) => ({
            voyageId,
            entries: entries.sort((a, b) =>
                new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
            )
        }))
        .sort((a, b) => {
            const aTime = new Date(a.entries[0]?.timestamp || 0).getTime();
            const bTime = new Date(b.entries[0]?.timestamp || 0).getTime();
            return bTime - aTime;
        });
}

// ─── HOOK ─────────────────────────────────────────────────────────────────────

export function useLogPageState() {
    const [state, dispatch] = useReducer(logPageReducer, initialState);
    const toast = useToast();
    const { settings } = useSettings();

    // ── Archive state (separate from main state to avoid re-renders on every poll) ──
    const [archivedVoyages, setArchivedVoyages] = useState<ReturnType<typeof groupEntriesByVoyage>>([]);
    const [careerEntries, setCareerEntries] = useState<ShipLogEntry[]>([]);

    // ── Initialization ──────────────────────────────────────────────────────

    const ARCHIVE_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

    const loadData = useCallback(async () => {
        const status = ShipLogService.getTrackingStatus();
        const voyageId = ShipLogService.getCurrentVoyageId();

        // Fetch from BOTH sources and merge — ensures entries are visible
        // whether they're synced to Supabase or still in the offline queue.
        const [dbEntries, offlineEntries] = await Promise.all([
            ShipLogService.getLogEntries(10_000_000),
            ShipLogService.getOfflineEntries(),
        ]);

        // Merge + deduplicate by entry ID (offline entries may not yet be in Supabase)
        const seen = new Set<string>();
        const merged: ShipLogEntry[] = [];
        for (const entry of [...dbEntries, ...offlineEntries]) {
            const key = entry.id;
            if (key && !seen.has(key)) {
                seen.add(key);
                merged.push(entry);
            }
        }

        // Sort newest first
        merged.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

        dispatch({
            type: 'LOAD_DATA',
            entries: merged,
            isTracking: status.isTracking,
            isPaused: status.isPaused,
            isRapidMode: status.isRapidMode,
            currentVoyageId: voyageId,
        });

        // Auto-archive voyages > 30 days old (fire-and-forget, non-blocking)
        const now = Date.now();
        const voyages = groupEntriesByVoyage(merged);
        for (const v of voyages) {
            const lastEntry = [...v.entries].sort((a, b) =>
                new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
            )[0];
            if (lastEntry && (now - new Date(lastEntry.timestamp).getTime()) > ARCHIVE_AGE_MS) {
                ShipLogService.archiveVoyage(v.voyageId).catch(() => { });
            }
        }

        // Load archived voyages and career entries in parallel (non-blocking)
        reloadCareerData();
    }, []);

    // Reusable career + archive data refresh
    const reloadCareerData = useCallback(() => {
        Promise.all([
            ShipLogService.getArchivedEntries(),
            ShipLogService.getAllEntriesForCareer(),
        ]).then(([archived, career]) => {
            setArchivedVoyages(groupEntriesByVoyage(archived));
            setCareerEntries(career);
        }).catch(() => { });
    }, []);

    useEffect(() => {
        let mounted = true;
        const timeout = setTimeout(() => {
            /* Safety: dismiss spinner after 5s if init hangs (web/no Capacitor) */
            if (mounted) dispatch({ type: 'DONE_LOADING' });
        }, 5000);
        // Pre-warm GPS plugin on mount — saves 1-2s when user taps Start
        BgGeoManager.ensureReady().catch(() => { });
        (async () => {
            try {
                await ShipLogService.initialize();
                if (mounted) await loadData();
            } catch {
                /* Init or load failure — stop spinner to show empty state */
                if (mounted) dispatch({ type: 'DONE_LOADING' });
            } finally {
                clearTimeout(timeout);
            }
        })();
        return () => { mounted = false; clearTimeout(timeout); };
    }, [loadData]);

    // ── GPS Status Polling ──────────────────────────────────────────────────

    useEffect(() => {
        if (!state.isTracking) {
            dispatch({ type: 'SET_GPS_STATUS', status: 'none' });
            return;
        }
        const poll = () => dispatch({ type: 'SET_GPS_STATUS', status: ShipLogService.getGpsStatus() });
        poll();
        const id = setInterval(poll, 5000);
        return () => clearInterval(id);
    }, [state.isTracking]);

    // ── Entry Refresh Polling — live updates while tracking ──────────────────
    // RAPID INITIAL POLL: Poll every 1s for the first 10s after tracking starts
    // so the first track card appears almost instantly. Then fall back to 5s/3s.
    // This is lightweight — just reads from local DB, no GPS calls.

    useEffect(() => {
        if (!state.isTracking) return;

        const normalPollMs = state.isRapidMode ? 3_000 : 5_000;
        const BURST_POLL_MS = 1_000;
        const BURST_DURATION_MS = 10_000;

        // Start with rapid polling
        let currentId = setInterval(() => { loadData(); }, BURST_POLL_MS);

        // After burst period, switch to normal polling
        const burstTimeout = setTimeout(() => {
            clearInterval(currentId);
            currentId = setInterval(() => { loadData(); }, normalPollMs);
        }, BURST_DURATION_MS);

        return () => {
            clearInterval(currentId);
            clearTimeout(burstTimeout);
        };
    }, [state.isTracking, state.isRapidMode, loadData]);

    // ── Tracking Handlers ───────────────────────────────────────────────────

    const handleStartTracking = useCallback(async () => {
        const voyages = groupEntriesByVoyage(state.entries);
        if (voyages.length > 0) {
            const recentVoyageId = voyages[0]?.voyageId;
            if (recentVoyageId) {
                dispatch({ type: 'SHOW_VOYAGE_CHOICE', show: true, lastVoyageId: recentVoyageId });
                return;
            }
        }
        // Instant UI response — dispatch first, service call is fire-and-forget
        dispatch({ type: 'SET_TRACKING', isTracking: true, isPaused: false });
        ShipLogService.startTracking().then(() => loadData()).catch((error: unknown) => {
            dispatch({ type: 'SET_TRACKING', isTracking: false, isPaused: false });
            alert(getErrorMessage(error) || 'Failed to start tracking');
        });
    }, [state.entries, loadData]);

    const startTrackingWithNewVoyage = useCallback(async () => {
        // Instant UI response — dispatch first, service call is fire-and-forget
        dispatch({ type: 'SET_TRACKING', isTracking: true, isPaused: false });
        ShipLogService.startTracking().then(() => loadData()).catch((error: unknown) => {
            dispatch({ type: 'SET_TRACKING', isTracking: false, isPaused: false });
            alert(getErrorMessage(error) || 'Failed to start tracking');
        });
    }, [loadData]);

    const continueLastVoyage = useCallback(async () => {
        // Instant UI response — dispatch first, service call is fire-and-forget
        dispatch({ type: 'SET_TRACKING', isTracking: true, isPaused: false });
        dispatch({ type: 'SHOW_VOYAGE_CHOICE', show: false });
        ShipLogService.startTracking(false, state.lastVoyageId || undefined).then(() => loadData()).catch((error: unknown) => {
            dispatch({ type: 'SET_TRACKING', isTracking: false, isPaused: false });
            alert(getErrorMessage(error) || 'Failed to continue tracking');
        });
    }, [state.lastVoyageId, loadData]);

    const handlePauseTracking = useCallback(async () => {
        await ShipLogService.pauseTracking();
        dispatch({ type: 'SET_TRACKING', isTracking: false, isPaused: true });
    }, []);

    const handleToggleRapidMode = useCallback(async () => {
        const newState = !state.isRapidMode;
        await ShipLogService.setRapidMode(newState);
        dispatch({ type: 'SET_RAPID_MODE', isRapidMode: newState });
    }, [state.isRapidMode]);

    const handleStopTracking = useCallback(() => {
        dispatch({ type: 'SHOW_STOP_DIALOG', show: true });
    }, []);

    const confirmStopVoyage = useCallback(async () => {
        dispatch({ type: 'SHOW_STOP_DIALOG', show: false });
        // Instant UI response — dispatch first, service call is fire-and-forget
        dispatch({ type: 'SET_TRACKING', isTracking: false, isPaused: false });
        ShipLogService.stopTracking().then(() => loadData()).catch(() => { });
    }, [loadData]);

    // ── Entry CRUD ──────────────────────────────────────────────────────────

    const handleDeleteEntry = useCallback(async (entryId: string) => {
        if (confirm('Delete this entry?')) {
            const success = await ShipLogService.deleteEntry(entryId);
            if (success) {
                dispatch({ type: 'UPDATE_ENTRIES', updater: prev => prev.filter(e => e.id !== entryId) });
            } else {
                toast.error('Failed to delete entry');
            }
        }
    }, [toast]);

    const handleEditEntry = useCallback((entry: ShipLogEntry) => {
        dispatch({ type: 'SET_EDIT_ENTRY', entry });
    }, []);

    const handleSaveEdit = useCallback((entryId: string, updates: { notes?: string; waypointName?: string }) => {
        dispatch({
            type: 'UPDATE_ENTRIES',
            updater: prev => prev.map(e => e.id === entryId ? { ...e, ...updates } : e)
        });
        toast.success('Entry updated');
    }, [toast]);

    // ── Voyage Management ───────────────────────────────────────────────────

    const toggleVoyage = useCallback((voyageId: string) => {
        dispatch({ type: 'TOGGLE_VOYAGE', voyageId });
    }, []);

    const handleDeleteVoyageRequest = useCallback((voyageId: string) => {
        dispatch({ type: 'REQUEST_DELETE_VOYAGE', voyageId });
    }, []);

    const handleConfirmDeleteVoyage = useCallback(async () => {
        if (!state.deleteVoyageId) return;
        const success = await ShipLogService.deleteVoyage(state.deleteVoyageId);
        if (success) {
            dispatch({ type: 'UPDATE_ENTRIES', updater: prev => prev.filter(e => e.voyageId !== state.deleteVoyageId) });
            reloadCareerData(); // Refresh career totals immediately
        } else {
            toast.error('Failed to delete voyage');
        }
        dispatch({ type: 'REQUEST_DELETE_VOYAGE', voyageId: null });
    }, [state.deleteVoyageId, toast, reloadCareerData]);

    // ── Export / Share ───────────────────────────────────────────────────────

    const handleExportCSV = useCallback(() => {
        const targetEntries = state.selectedVoyageId
            ? state.entries.filter(e => e.voyageId === state.selectedVoyageId)
            : state.entries;
        exportToCSV(targetEntries, 'ships_log.csv', {
            onProgress: () => { },
            onSuccess: () => { },
            onError: (err) => toast.error(err),
        });
    }, [state.selectedVoyageId, state.entries, toast]);

    const handleShare = useCallback(async () => {
        const targetEntries = state.selectedVoyageId
            ? state.entries.filter(e => e.voyageId === state.selectedVoyageId)
            : state.entries;
        await sharePDF(targetEntries, {
            onProgress: () => { },
            onSuccess: () => { },
            onError: (err) => toast.error(err),
        }, settings.vessel?.name, { vessel: settings.vessel, vesselUnits: settings.vesselUnits, units: settings.units });
    }, [state.selectedVoyageId, state.entries, settings.vessel, settings.vesselUnits, settings.units, toast]);

    const handleExportThenDelete = useCallback(async () => {
        await handleShare();
    }, [handleShare]);

    const handleExportGPX = useCallback(async () => {
        const targetEntries = state.selectedVoyageId
            ? state.entries.filter(e => e.voyageId === state.selectedVoyageId)
            : state.entries;
        if (targetEntries.length === 0) return;
        const voyageName = state.selectedVoyageId
            ? `Voyage ${state.selectedVoyageId.slice(0, 8)}`
            : 'All Voyages';
        const gpxXml = exportVoyageAsGPX(targetEntries, voyageName, settings.vessel?.name);
        dispatch({ type: 'SET_ACTION_SHEET', sheet: null });
        await shareGPXFile(gpxXml, `${voyageName.replace(/\s+/g, '_').toLowerCase()}.gpx`);
    }, [state.selectedVoyageId, state.entries, settings.vessel?.name]);

    const handleImportGPXFile = useCallback(async (file: File) => {
        try {
            const gpxXml = await readGPXFile(file);
            const entries = importGPXToEntries(gpxXml);
            if (entries.length === 0) {
                toast.error('No valid track points found in file');
                return;
            }
            // Stamp with provenance
            entries.forEach(e => { (e as any).source = 'gpx_import'; });
            const { savedCount } = await ShipLogService.importGPXVoyage(entries);
            toast.success(`Imported ${savedCount} entries from ${file.name}`);
            await loadData();
        } catch (err: unknown) {
            toast.error(getErrorMessage(err) || 'Failed to import GPX file');
        }
    }, [toast, loadData]);

    const handleShareToCommunity = useCallback(async (shareData: { title: string; description: string; category: TrackCategory; region: string }) => {
        dispatch({ type: 'SET_ACTION_SHEET', sheet: null });
        const targetEntries = state.selectedVoyageId
            ? state.entries.filter(e => e.voyageId === state.selectedVoyageId)
            : state.entries;
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
            if (result) {
                toast.success('Track shared to community!');
            } else {
                toast.error('Failed to share track');
            }
        } catch (err: unknown) {
            toast.error(getErrorMessage(err) || 'Share failed');
        }
    }, [state.selectedVoyageId, state.entries, toast]);

    // ── Derived State ───────────────────────────────────────────────────────

    const filteredEntries = useMemo(() => {
        let filtered = state.entries;
        filtered = filterEntriesByType(filtered, state.filters.types);
        filtered = searchEntries(filtered, state.filters.searchQuery);
        return filtered;
    }, [state.entries, state.filters]);

    const groupedEntries = useMemo(() => {
        const newestFirst = [...filteredEntries].sort((a, b) =>
            new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
        );
        return groupEntriesByDate(newestFirst);
    }, [filteredEntries]);

    const entryCounts = useMemo(() => ({
        auto: state.entries.filter(e => e.entryType === 'auto').length,
        manual: state.entries.filter(e => e.entryType === 'manual').length,
        waypoint: state.entries.filter(e => e.entryType === 'waypoint').length,
    }), [state.entries]);

    const voyageGroups = useMemo(() => groupEntriesByVoyage(state.entries), [state.entries]);

    const hasNonDeviceEntries = useMemo(() => {
        const targetEntries = state.selectedVoyageId
            ? state.entries.filter(e => e.voyageId === state.selectedVoyageId)
            : state.entries;
        return targetEntries.some(e => e.source && e.source !== 'device');
    }, [state.entries, state.selectedVoyageId]);

    const totalDistance = filteredEntries.length > 0
        ? Math.max(...filteredEntries.map(e => e.cumulativeDistanceNM || 0))
        : 0;

    const avgSpeed = filteredEntries.length > 0
        ? filteredEntries.filter(e => e.speedKts).reduce((sum, e) => sum + (e.speedKts || 0), 0) / filteredEntries.filter(e => e.speedKts).length
        : 0;

    // ── Career Totals ───────────────────────────────────────────────────────
    // Only counts the user's own maritime voyages:
    //   1. Source must be 'device' (or undefined for legacy entries) — excludes imports & community
    //   2. Voyage's first entry must not be explicitly marked as land (isOnWater !== false)

    const careerTotals = useMemo(() => {
        // Uses ALL entries (active + archived) from dedicated career query
        const source = careerEntries.length > 0 ? careerEntries : state.entries;

        // Step 1: Filter to device-only entries
        const ownEntries = source.filter(e =>
            !e.source || e.source === 'device'
        );

        // Step 2: Group into voyages
        const groups = groupEntriesByVoyage(ownEntries);

        // Step 3: Filter out land-based voyages (majority vote)
        // If ≥60% of entries with water data are on land, classify as land track.
        // This prevents coastal GPS jitter from misclassifying car drives as maritime.
        const maritimeGroups = groups.filter(g => {
            const withWaterData = g.entries.filter(e => e.isOnWater !== undefined);
            if (withWaterData.length === 0) return true; // No data → assume water (fail-open)
            const landCount = withWaterData.filter(e => e.isOnWater === false).length;
            return landCount / withWaterData.length < 0.6; // ≥60% land → land track
        });

        let distance = 0;
        let timeMs = 0;
        maritimeGroups.forEach(g => {
            distance += Math.max(0, ...g.entries.map(e => e.cumulativeDistanceNM || 0));
            if (g.entries.length >= 2) {
                const sorted = [...g.entries].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
                timeMs += new Date(sorted[sorted.length - 1].timestamp).getTime() - new Date(sorted[0].timestamp).getTime();
            }
        });
        return {
            totalDistance: distance,
            totalTimeAtSeaHrs: Math.round(timeMs / (1000 * 60 * 60) * 10) / 10,
            totalVoyages: maritimeGroups.length,
        };
    }, [careerEntries]);

    // ── Archive handlers ─────────────────────────────────────────────────────

    const handleArchiveVoyage = useCallback(async (voyageId: string) => {
        await ShipLogService.archiveVoyage(voyageId);
        await loadData();
        reloadCareerData();
    }, [loadData, reloadCareerData]);

    const handleUnarchiveVoyage = useCallback(async (voyageId: string) => {
        await ShipLogService.unarchiveVoyage(voyageId);
        await loadData();
        reloadCareerData();
    }, [loadData, reloadCareerData]);

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
        handleStopTracking,
        confirmStopVoyage,

        // Entry CRUD
        handleDeleteEntry,
        handleEditEntry,
        handleSaveEdit,
        loadData,

        // Voyage management
        toggleVoyage,
        handleDeleteVoyageRequest,
        handleConfirmDeleteVoyage,

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
        hasNonDeviceEntries,
        totalDistance,
        avgSpeed,
        careerTotals,

        // Archive
        archivedVoyages,
        handleArchiveVoyage,
        handleUnarchiveVoyage,
    };
}
