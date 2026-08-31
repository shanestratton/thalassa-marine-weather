import React, { useState, useEffect, useRef, useCallback, useMemo, useId } from 'react';
import { createLogger } from '../utils/createLogger';
const log = createLogger('DiaryPage');
import { DiaryService, DiaryEntry, DiaryMood, DiaryWeatherData } from '../services/DiaryService';
import { triggerHaptic } from '../utils/system';
import { haversineMeters } from '../services/shiplog/GpsTrackBuffer';
import { extractPhotoExif } from '../utils/exifGps';
import { SlideToAction } from './ui/SlideToAction';
import { AnchorWatchService, haversineDistance } from '../services/AnchorWatchService';
import { ConfirmDialog } from './ui/ConfirmDialog';
import { useWeather } from '../context/WeatherContext';
import { useSettings } from '../context/SettingsContext';
import { PageHeader } from './ui/PageHeader';
import { CompassIcon, CheckIcon } from './Icons';
import { UndoToast } from './ui/UndoToast';
import { SwipeableDiaryCard } from './diary/SwipeableDiaryCard';
import { toast } from './Toast';
import { DiaryEntryView } from './diary/DiaryEntryView';
import { DiaryComposeForm } from './diary/DiaryComposeForm';
import { VideoTrimmer } from './diary/VideoTrimmer';
import { DiaryPublishModal } from './diary/DiaryPublishModal';
import { useDiaryState } from '../hooks/useDiaryState';
import { useKeyboardOffset } from '../hooks/useKeyboardOffset';
import { EmptyState } from './ui/EmptyState';
import { ShimmerBlock } from './ui/ShimmerBlock';
import { POLISH_INTENSITY, type PolishStyle } from '../types/settings';
import { useMenuNavigation } from '../hooks/useMenuNavigation';
import {
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
} from '../services/authIdentityScope';
interface DiaryPageProps {
    onBack: () => void;
}
// ── Helpers ─────────────────────────────────────────────────────
const formatDate = (iso: string): string => {
    const d = new Date(iso);
    return d.toLocaleDateString('en-AU', {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        year: 'numeric',
    });
};
const _formatTime = (iso: string): string => {
    return new Date(iso).toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' });
};
const formatCoord = (lat: number, lon: number): string => {
    const latDir = lat >= 0 ? 'N' : 'S';
    const lonDir = lon >= 0 ? 'E' : 'W';
    return `${Math.abs(lat).toFixed(4)}°${latDir}, ${Math.abs(lon).toFixed(4)}°${lonDir}`;
};
const _formatDuration = (seconds: number): string => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
};
const groupByDate = (entries: DiaryEntry[]): Map<string, DiaryEntry[]> => {
    const map = new Map<string, DiaryEntry[]>();
    for (const e of entries) {
        const dateKey = new Date(e.created_at).toISOString().split('T')[0];
        const arr = map.get(dateKey) || [];
        arr.push(e);
        map.set(dateKey, arr);
    }
    return map;
};

// ── Component ──────────────────────────────────────────────────
export const DiaryPage: React.FC<DiaryPageProps> = React.memo(({ onBack }) => {
    // ── Consolidated state (replaces 29 individual useState calls) ──
    // Single useReducer eliminates cascade re-renders (openCompose: 11 → 1)
    const { state, dispatch } = useDiaryState();
    // Destructure for JSX backward compatibility
    const {
        entries,
        loading,
        showCompose,
        selectedEntry,
        editingId,
        title,
        body,
        mood,
        photos,
        audioUrl,
        videoUrl,
        uploading,
        lat,
        lon,
        locationName,
        weatherSummary,
        saving,
        polishing,
        deletedItem,
        selectMode: _selectMode,
        selectedIds,
        menuOpen,
        exportProgress,
        gpsLoading,
        transcribing,
        isPlaying,
        keyboardHeight,
    } = state;
    const latestEntriesRef = useRef(entries);
    latestEntriesRef.current = entries;
    const latestSelectedEntryRef = useRef(selectedEntry);
    latestSelectedEntryRef.current = selectedEntry;
    // Setter shims — same API surface, backed by dispatch
    const setEntries = useCallback(
        (v: DiaryEntry[] | ((prev: DiaryEntry[]) => DiaryEntry[])) => {
            dispatch({ type: 'SET_ENTRIES', entries: typeof v === 'function' ? v(latestEntriesRef.current) : v });
        },
        [dispatch],
    );
    const setSelectedEntry = useCallback(
        (e: DiaryEntry | null) => dispatch({ type: 'SET_SELECTED_ENTRY', entry: e }),
        [dispatch],
    );
    const setShowCompose = useCallback(
        (v: boolean) =>
            v ? dispatch({ type: 'OPEN_COMPOSE', weatherSummary: '' }) : dispatch({ type: 'CLOSE_COMPOSE' }),
        [dispatch],
    );
    const setMenuOpen = useCallback((v: boolean) => dispatch({ type: 'SET_MENU_OPEN', open: v }), [dispatch]);
    const setSelectedIds = useCallback(
        (v: Set<string> | ((prev: Set<string>) => Set<string>)) => {
            const next = typeof v === 'function' ? v(state.selectedIds) : v;
            dispatch({ type: 'SET_SELECTED_IDS', ids: next });
        },
        [dispatch, state.selectedIds],
    );
    // Additional setter shims
    const setKeyboardHeight = useCallback(
        (h: number) => dispatch({ type: 'SET_KEYBOARD_HEIGHT', height: h }),
        [dispatch],
    );
    const sharedKeyboardHeight = useKeyboardOffset(showCompose);
    const setLoading = useCallback((v: boolean) => dispatch({ type: 'SET_LOADING', loading: v }), [dispatch]);
    const setGpsLoading = useCallback((v: boolean) => dispatch({ type: 'SET_GPS_LOADING', loading: v }), [dispatch]);
    const setLat = useCallback(
        (v: number | null) => {
            dispatch({ type: 'SET_GPS', lat: v, lon: state.lon, locationName: state.locationName });
        },
        [dispatch, state.lon, state.locationName],
    );
    const setLon = useCallback(
        (v: number | null) => {
            dispatch({ type: 'SET_GPS', lat: state.lat, lon: v, locationName: state.locationName });
        },
        [dispatch, state.lat, state.locationName],
    );
    const setLocationName = useCallback(
        (v: string) => {
            dispatch({ type: 'SET_GPS', lat: state.lat, lon: state.lon, locationName: v });
        },
        [dispatch, state.lat, state.lon],
    );
    const setEditingId = useCallback((_v: string | null) => {
        /* handled by OPEN_COMPOSE/OPEN_EDIT/CLOSE_COMPOSE */
    }, []);
    const setTitle = useCallback((v: string) => dispatch({ type: 'SET_TITLE', title: v }), [dispatch]);
    const setBody = useCallback(
        (v: string | ((prev: string) => string)) => {
            dispatch({ type: 'SET_BODY', body: typeof v === 'function' ? v(state.body) : v });
        },
        [dispatch, state.body],
    );
    const setMood = useCallback((v: DiaryMood) => dispatch({ type: 'SET_MOOD', mood: v }), [dispatch]);
    const setPhotos = useCallback(
        (v: string[] | ((prev: string[]) => string[])) => {
            dispatch({ type: 'SET_PHOTOS', photos: typeof v === 'function' ? v(state.photos) : v });
        },
        [dispatch, state.photos],
    );
    const setAudioUrl = useCallback((v: string | null) => dispatch({ type: 'SET_AUDIO_URL', url: v }), [dispatch]);
    const setVideoUrl = useCallback((v: string | null) => dispatch({ type: 'SET_VIDEO_URL', url: v }), [dispatch]);
    const setUploading = useCallback((v: boolean) => dispatch({ type: 'SET_UPLOADING', uploading: v }), [dispatch]);
    const setWeatherSummary = useCallback(
        (v: string) => dispatch({ type: 'SET_WEATHER_SUMMARY', summary: v }),
        [dispatch],
    );
    const setSaving = useCallback((v: boolean) => dispatch({ type: 'SET_SAVING', saving: v }), [dispatch]);
    const setPolishing = useCallback((v: boolean) => dispatch({ type: 'SET_POLISHING', polishing: v }), [dispatch]);
    const setDeletedItem = useCallback(
        (v: DiaryEntry | null) => dispatch({ type: 'SET_DELETED_ITEM', item: v }),
        [dispatch],
    );
    const setSelectMode = useCallback(
        (v: boolean) => (v ? dispatch({ type: 'ENTER_SELECT_MODE' }) : dispatch({ type: 'EXIT_SELECT_MODE' })),
        [dispatch],
    );
    const setExportProgress = useCallback(
        (v: string | null) => dispatch({ type: 'SET_EXPORT_PROGRESS', progress: v }),
        [dispatch],
    );
    const setTranscribing = useCallback(
        (v: boolean) => dispatch({ type: 'SET_TRANSCRIBING', transcribing: v }),
        [dispatch],
    );
    const setIsPlaying = useCallback((v: boolean) => dispatch({ type: 'SET_PLAYING', playing: v }), [dispatch]);
    // Polish style — read from settings (persists across sessions + devices).
    // Default 'polished' (middle option) on first run.
    // Publish-to-Voyage-Log prompt — holds the just-saved entry while the modal is open
    const [publishPromptEntry, setPublishPromptEntry] = useState<DiaryEntry | null>(null);
    // A GPS-tagged photo attached while EDITING an entry that already has a
    // pin — ask before moving it (never silently relocate an existing pin).
    const [photoPinPrompt, setPhotoPinPrompt] = useState<{ lat: number; lon: number; movedM: number } | null>(null);
    // Weather context
    const { weatherData } = useWeather();
    const { settings, updateSettings } = useSettings();
    const polishStyle: PolishStyle = settings.polishStyle ?? 'polished';
    const setPolishStyle = useCallback(
        (next: PolishStyle) => {
            void updateSettings({ polishStyle: next });
        },
        [updateSettings],
    );
    // Ids whose delete hasn't been committed to DiaryService yet (undo window
    // open, or commit in flight). A Set because a second swipe-delete can start
    // while the first is still pending — both must be guarded from the poll.
    const pendingDeleteIdsRef = useRef<Set<string>>(new Set());
    const pageActionsTriggerRef = useRef<HTMLButtonElement>(null);
    const pageActionsMenuId = useId();
    const closePageActions = useCallback(() => setMenuOpen(false), [setMenuOpen]);
    const pageActionsMenuRef = useMenuNavigation<HTMLDivElement>(menuOpen, {
        triggerRef: pageActionsTriggerRef,
        onClose: closePageActions,
    });
    // The microphone left the diary on 2026-08-25 (Shane: "get rid of the
    // microphone, and just have texting") — ~600 lines of WebKit capture,
    // Deepgram streaming and iOS mic-lifecycle guards went with it. Legacy
    // entries keep their voice memos: playback and transcribe-on-view stay.
    const composeSessionRef = useRef(0);
    // Photos returned by uploadPhoto are still compose-owned until a confirmed
    // create/update adopts them. Existing edit photos never enter this set.
    const unsavedPhotoRefs = useRef<Set<string>>(new Set());
    /** The one compose-owned clip, if any. Replaced or discarded, never leaked. */
    const unsavedVideoRef = useRef<string | null>(null);
    const [trimRequest, setTrimRequest] = useState<{ file: File; durationSec: number } | null>(null);
    /** Set only when vessel and phone GPS disagree — the pub-vs-passage question. */
    const [gpsConflict, setGpsConflict] = useState<{
        vessel: { lat: number; lon: number };
        phone: { lat: number; lon: number };
        distanceM: number;
    } | null>(null);
    const [gpsSource, setGpsSource] = useState<'vessel' | 'phone' | null>(null);
    // A Save snapshots only the refs it is adopting. Account B can therefore
    // begin a clean compose after an A→B switch without Cancel racing A's bytes.
    const savingPhotoRefsRef = useRef<Set<string> | null>(null);
    const abandonedComposeSessionsRef = useRef<Set<number>>(new Set());
    const composeSaveInFlightRef = useRef(false);
    const audioPlayerRef = useRef<HTMLAudioElement | null>(null);
    const fileRef = useRef<HTMLInputElement>(null);
    const pageScopeRef = useRef(getAuthIdentityScope());
    const entriesLoadRequestRef = useRef(0);
    const pageActiveRef = useRef(true);

    /**
     * Invalidate the current compose screen before changing state. Late async
     * callbacks (GPS, photo EXIF, an in-flight Save) must never write into a
     * cancelled or newly opened diary entry.
     */
    const invalidateComposeSession = useCallback(
        (resetUi = true) => {
            // Any in-flight Save belongs to the abandoned compose screen. Its
            // eventual completion must never close or overwrite a new one.
            composeSessionRef.current += 1;
            if (resetUi) {
                setTranscribing(false);
                setPolishing(false);
                if (!composeSaveInFlightRef.current) setSaving(false);
            }
        },
        [setPolishing, setSaving, setTranscribing],
    );

    const discardNewPhoto = useCallback((ref: string): void => {
        if (!unsavedPhotoRefs.current.delete(ref)) return;
        void DiaryService.discardUnsavedPhoto(ref);
    }, []);

    const discardAllNewPhotos = useCallback((): void => {
        const refs = [...unsavedPhotoRefs.current];
        unsavedPhotoRefs.current.clear();
        for (const ref of refs) void DiaryService.discardUnsavedPhoto(ref);
        const videoRef = unsavedVideoRef.current;
        unsavedVideoRef.current = null;
        if (videoRef) void DiaryService.discardUnsavedVideo(videoRef);
    }, []);

    /** Detach an abandoned compose without touching refs an active Save owns. */
    const abandonComposePhotos = useCallback((): void => {
        const savingRefs = savingPhotoRefsRef.current ?? new Set<string>();
        const refs = [...unsavedPhotoRefs.current];
        unsavedPhotoRefs.current.clear();
        for (const ref of refs) {
            if (!savingRefs.has(ref)) void DiaryService.discardUnsavedPhoto(ref);
        }
        const videoRef = unsavedVideoRef.current;
        unsavedVideoRef.current = null;
        if (videoRef) void DiaryService.discardUnsavedVideo(videoRef);
    }, []);

    // Keep the compose reducer in sync with the shared native/web keyboard
    // measurement. DiaryComposeForm uses this value to lift its bottom actions.
    useEffect(() => {
        setKeyboardHeight(sharedKeyboardHeight);
    }, [setKeyboardHeight, sharedKeyboardHeight]);
    // ── Load entries ───────────────────────────────────────────
    const loadEntriesForScope = useCallback(
        async (scope: ReturnType<typeof getAuthIdentityScope>, replace: boolean): Promise<void> => {
            const requestId = ++entriesLoadRequestRef.current;
            const requestIsCurrent = () =>
                pageActiveRef.current &&
                requestId === entriesLoadRequestRef.current &&
                pageScopeRef.current.key === scope.key &&
                pageScopeRef.current.generation === scope.generation &&
                isAuthIdentityScopeCurrent(scope);
            try {
                const data = await DiaryService.getEntries(100);
                if (!requestIsCurrent()) return;
                const pendingIds = pendingDeleteIdsRef.current;
                const fresh = pendingIds.size > 0 ? data.filter((entry) => !pendingIds.has(entry.id)) : data;
                if (replace) {
                    setEntries(fresh);
                    return;
                }

                setEntries((previous) => {
                    const freshIds = new Set(fresh.map((entry) => entry.id));
                    const preserved = previous.filter(
                        (entry) =>
                            entry.id.startsWith('offline-') &&
                            !freshIds.has(entry.id) &&
                            !freshIds.has(DiaryService.resolveServerId(entry.id) ?? ''),
                    );
                    return [...fresh, ...preserved].sort(
                        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
                    );
                });
            } catch (error) {
                if (requestIsCurrent()) log.warn('Diary entries could not be refreshed:', error);
            } finally {
                if (replace && requestIsCurrent()) setLoading(false);
            }
        },
        [setEntries, setLoading],
    );
    const refreshEntries = useCallback(() => {
        void loadEntriesForScope(pageScopeRef.current, false);
    }, [loadEntriesForScope]);
    useEffect(() => {
        void loadEntriesForScope(pageScopeRef.current, true);
        // Periodically refresh to clear PENDING badges after background sync
        const interval = setInterval(() => {
            if (!document.hidden) refreshEntries();
        }, 8000);
        return () => clearInterval(interval);
    }, [loadEntriesForScope, refreshEntries]);
    // Cleanup on unmount
    useEffect(() => {
        pageActiveRef.current = true;
        const abandonedComposeSessions = abandonedComposeSessionsRef.current;
        return () => {
            pageActiveRef.current = false;
            entriesLoadRequestRef.current += 1;
            if (composeSaveInFlightRef.current) {
                abandonedComposeSessions.add(composeSessionRef.current);
            }
            abandonComposePhotos();
            invalidateComposeSession(false);
            if (audioPlayerRef.current) {
                audioPlayerRef.current.pause();
                audioPlayerRef.current = null;
            }
        };
    }, [abandonComposePhotos, invalidateComposeSession]);
    // The mounted page is an auth boundary too: hide A synchronously, abandon
    // A's compose ownership, then load only B's namespace. Request ids prevent
    // a late A read from repainting the timeline.
    useEffect(() => {
        return subscribeAuthIdentityScope((next) => {
            if (composeSaveInFlightRef.current) {
                abandonedComposeSessionsRef.current.add(composeSessionRef.current);
            }
            pageScopeRef.current = next;
            entriesLoadRequestRef.current += 1;
            setEntries([]);
            setSelectedEntry(null);
            setPublishPromptEntry(null);
            setPhotoPinPrompt(null);
            setDeletedItem(null);
            locationFromPhotoRef.current = false;
            gpsChoiceExplicitRef.current = false;
            pendingDeleteIdsRef.current.clear();
            dispatch({ type: 'EXIT_SELECT_MODE' });
            dispatch({ type: 'OPEN_COMPOSE', weatherSummary: '' });
            dispatch({ type: 'CLOSE_COMPOSE' });
            setUploading(false);
            setGpsLoading(false);
            setMenuOpen(false);
            setLoading(true);
            abandonComposePhotos();
            invalidateComposeSession();
            if (audioPlayerRef.current) {
                audioPlayerRef.current.pause();
                audioPlayerRef.current = null;
                setIsPlaying(false);
            }
            void loadEntriesForScope(next, true);
        });
    }, [
        abandonComposePhotos,
        invalidateComposeSession,
        dispatch,
        loadEntriesForScope,
        setDeletedItem,
        setEntries,
        setGpsLoading,
        setIsPlaying,
        setLoading,
        setMenuOpen,
        setSelectedEntry,
        setUploading,
    ]);
    // ── GPS helper ─────────────────────────────────────────────
    // True once an attached photo's EXIF GPS has set the entry position.
    // The photo's location outranks the device fix: the entry is about
    // where the photo was TAKEN, not where the skipper sat down to write
    // it up (which is the berth — i.e. the start of every track). An
    // openCompose reset or a fresh compose clears it.
    const locationFromPhotoRef = useRef(false);
    /** The skipper ANSWERED "Two positions, skipper" this compose session.
     *  An explicit answer outranks photo EXIF entirely: photos shot aboard
     *  carry the camera's last CACHED phone fix, and on 2026-09-01 that
     *  stale tag silently dragged a deliberate ⚓ choice back to the house. */
    const gpsChoiceExplicitRef = useRef(false);
    const grabGps = useCallback(async () => {
        const operationScope = getAuthIdentityScope();
        const composeSession = composeSessionRef.current;
        const operationIsCurrent = () =>
            pageActiveRef.current &&
            isAuthIdentityScopeCurrent(operationScope) &&
            composeSessionRef.current === composeSession;
        if (locationFromPhotoRef.current) return;
        setGpsLoading(true);
        setGpsConflict(null);
        setGpsSource(null);
        // Two candidates, one honest rule: agree (or only one exists) → take
        // it silently; disagree → only the skipper knows whether this entry is
        // about the boat or about where they are standing, so ask. The 200m
        // line keeps swing-at-anchor and GPS scatter from nagging anyone.
        const candidates = await DiaryService.getPositionCandidates();
        if (!operationIsCurrent()) return;
        let loc: { lat: number; lon: number } | null = null;
        const { vessel, phone } = candidates;
        if (vessel && phone) {
            const distanceM = haversineMeters(vessel.lat, vessel.lon, phone.lat, phone.lon);
            // The phone cannot disagree by less than its own blur: an indoor
            // fix is honestly kilometres of fuzz, and a "conflict" inside
            // that radius is the fuzz talking, not the skipper standing
            // somewhere else (Coolum Parade, 2026-08-31). The boat's GPS
            // knows exactly where it is — it wins silently.
            const phoneBlurM = phone.accuracyM ?? 50;
            if (distanceM >= 200 && distanceM > phoneBlurM * 1.5) {
                setGpsConflict({ vessel, phone, distanceM });
                setGpsLoading(false);
                return; // the modal resolves it; applyGpsChoice finishes the job
            }
            loc = vessel;
            setGpsSource('vessel');
        } else if (vessel) {
            loc = vessel;
            setGpsSource('vessel');
        } else if (phone) {
            loc = phone;
            setGpsSource('phone');
        }
        if (!operationIsCurrent()) return;
        // Re-check after the await — a photo may have been attached while
        // the fix was in flight (openCompose fires this async).
        await applyResolvedPosition(loc, operationIsCurrent);
        if (operationIsCurrent()) setGpsLoading(false);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [setGpsLoading, setLat, setLocationName, setLon]);

    /** Pin the compose form at a resolved position (from either source or the modal). */
    const applyResolvedPosition = useCallback(
        async (loc: { lat: number; lon: number } | null, operationIsCurrent: () => boolean) => {
            if (loc && !locationFromPhotoRef.current) {
                setLat(loc.lat);
                setLon(loc.lon);
                // Check anchor watch first — if active, use depth info
                const anchorSnap = AnchorWatchService.getSnapshot();
                const isAnchored = anchorSnap.state === 'watching' || anchorSnap.state === 'alarm';
                // Reverse geocode for a readable place name
                const placeName = await DiaryService.reverseGeocode(loc.lat, loc.lon);
                if (!operationIsCurrent()) return;
                if (isAnchored) {
                    const depth = anchorSnap.config.waterDepth;
                    const prefix = `Anchored in ${depth}m of water`;
                    setLocationName(placeName ? `${prefix} — ${placeName}` : prefix);
                } else {
                    setLocationName(placeName || formatCoord(loc.lat, loc.lon));
                }
            }
        },
        [setLat, setLocationName, setLon],
    );

    /** The skipper answered the pub-vs-passage question. */
    const applyGpsChoice = useCallback(
        (source: 'vessel' | 'phone') => {
            const conflict = gpsConflict;
            if (!conflict) return;
            setGpsConflict(null);
            setGpsSource(source);
            gpsChoiceExplicitRef.current = true;
            setGpsLoading(true);
            const scope = getAuthIdentityScope();
            const session = composeSessionRef.current;
            const stillCurrent = () =>
                pageActiveRef.current && isAuthIdentityScopeCurrent(scope) && composeSessionRef.current === session;
            void (async () => {
                await applyResolvedPosition(source === 'vessel' ? conflict.vessel : conflict.phone, stillCurrent);
                if (stillCurrent()) setGpsLoading(false);
            })();
        },
        [gpsConflict, applyResolvedPosition, setGpsLoading],
    );
    // ── Compose (new) ──────────────────────────────────────────
    /** Build a weather snapshot one-liner from current weather data */
    const buildWeatherSnapshot = useCallback((): string => {
        if (!weatherData?.current) return '';
        const c = weatherData.current;
        const parts: string[] = [];
        if (c.airTemperature != null) parts.push(`${Math.round(c.airTemperature)}°C`);
        if (c.windSpeed != null) {
            let wind = `Wind ${Math.round(c.windSpeed)}kts ${c.windDirection || ''}`;
            if (c.windGust != null && c.windGust > (c.windSpeed || 0) + 2) wind += ` G${Math.round(c.windGust)}`;
            parts.push(wind.trim());
        }
        if (c.waveHeight != null && c.waveHeight > 0) {
            // waveHeight is stored in feet internally (converted from m by transformers.ts)
            // Convert back to meters for display
            const waveM = c.waveHeight / 3.28084;
            parts.push(`Waves ${waveM.toFixed(1)}m`);
        } else if (c.description) parts.push(c.description);
        return parts.join(' · ');
    }, [weatherData]);
    /** Build structured weather data object for pin-drop capture */
    const buildWeatherData = useCallback((): DiaryWeatherData | null => {
        if (!weatherData?.current) return null;
        const c = weatherData.current;
        return {
            description: c.description || undefined,
            airTemp: c.airTemperature != null ? Math.round(c.airTemperature * 10) / 10 : undefined,
            seaTemp: c.waterTemperature != null ? Math.round(c.waterTemperature * 10) / 10 : undefined,
            windSpeed: c.windSpeed != null ? Math.round(c.windSpeed) : undefined,
            windDir: c.windDirection || undefined,
            humidity: c.humidity != null ? Math.round(c.humidity) : undefined,
            rain: c.precipitation != null ? Math.round(c.precipitation * 10) / 10 : undefined,
        };
    }, [weatherData]);
    const openCompose = useCallback(async () => {
        invalidateComposeSession();
        setEditingId(null);
        setTitle('');
        setBody('');
        setMood('epic');
        setPhotos([]);
        setAudioUrl(null);
        setLat(null);
        setLon(null);
        setLocationName('');
        setWeatherSummary(buildWeatherSnapshot());
        dispatch({ type: 'SET_WEATHER_DATA', data: buildWeatherData() });
        setShowCompose(true);
        triggerHaptic('light');
        locationFromPhotoRef.current = false;
        gpsChoiceExplicitRef.current = false;
        grabGps();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [invalidateComposeSession, grabGps, buildWeatherSnapshot, buildWeatherData, dispatch]);
    // ── Edit (existing) ────────────────────────────────────────
    const openEdit = useCallback(
        (entry: DiaryEntry) => {
            invalidateComposeSession();
            // Fresh edit session: a photo attached DURING this edit may
            // re-pin the entry from its EXIF (the repair path for entries
            // pinned at the berth — re-attach the original photo and the
            // pin moves to where it was taken).
            locationFromPhotoRef.current = false;
            gpsChoiceExplicitRef.current = false;
            const locationDisplay =
                entry.location_name ||
                (entry.latitude && entry.longitude ? formatCoord(entry.latitude, entry.longitude) : '');
            dispatch({ type: 'OPEN_EDIT', entry, locationDisplay });
            triggerHaptic('light');
        },
        [invalidateComposeSession, dispatch],
    );
    // ── Audio Playback ─────────────────────────────────────────
    const togglePlayback = async (url: string) => {
        if (isPlaying && audioPlayerRef.current) {
            audioPlayerRef.current.pause();
            audioPlayerRef.current = null;
            setIsPlaying(false);
            return;
        }
        const resolvedUrl = await DiaryService.resolveAudioUrl(url);
        if (!resolvedUrl) return;
        const audio = new Audio(resolvedUrl);
        audioPlayerRef.current = audio;
        audio.play();
        setIsPlaying(true);
        audio.onended = () => {
            setIsPlaying(false);
            audioPlayerRef.current = null;
        };
    };
    // ── Transcribe ─────────────────────────────────────────────
    const handleTranscribe = async (entry: DiaryEntry) => {
        if (!entry.audio_url || transcribing) return;
        const operationScope = getAuthIdentityScope();
        const operationIsCurrent = () => pageActiveRef.current && isAuthIdentityScopeCurrent(operationScope);
        setTranscribing(true);
        triggerHaptic('light');
        try {
            const text = await DiaryService.transcribeAudio(entry.audio_url);
            if (!operationIsCurrent()) return;
            if (!text) {
                toast.error('We could not convert that voice memo to text. Please try again when online.');
                return;
            }

            // A saved fallback memo deserves the same finish as a newly
            // dictated one: transcribe the spoken words, then apply the
            // skipper's chosen diary style before it becomes the entry text.
            const polished = await DiaryService.enhanceWithGemini(text, {
                mood: entry.mood,
                location: entry.location_name,
                intensity: POLISH_INTENSITY[polishStyle],
            });
            if (!operationIsCurrent()) return;

            const currentEntry = latestEntriesRef.current.find((candidate) => candidate.id === entry.id) ?? entry;
            const recoveredText = polished || text;
            const nextBody = currentEntry.body.trim()
                ? `${currentEntry.body.trimEnd()}\n\n${recoveredText}`
                : recoveredText;
            const updateResult = await DiaryService.updateEntry(
                entry.id,
                { body: nextBody },
                { shouldContinue: operationIsCurrent },
            );
            if (!operationIsCurrent()) return;
            if (!updateResult.ok) {
                toast.error('The transcript is ready, but the diary entry could not be saved. Please try again.');
                return;
            }

            const updatedEntry = { ...currentEntry, body: nextBody };
            setEntries((prev) => prev.map((candidate) => (candidate.id === entry.id ? updatedEntry : candidate)));
            if (latestSelectedEntryRef.current?.id === entry.id) setSelectedEntry(updatedEntry);
            toast.success(polished ? 'Voice memo transcribed and styled.' : 'Voice memo transcribed.');
        } catch (error) {
            log.warn('[Diary] Could not recover saved voice memo text:', error);
            if (operationIsCurrent()) {
                toast.error('We could not finish that voice memo. Please try again when online.');
            }
        } finally {
            if (operationIsCurrent()) setTranscribing(false);
        }
    };
    // ── Photo handling ─────────────────────────────────────────
    const handlePhotoSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        const operationScope = getAuthIdentityScope();
        const composeSession = composeSessionRef.current;
        const operationIsCurrent = () =>
            pageActiveRef.current &&
            isAuthIdentityScopeCurrent(operationScope) &&
            composeSessionRef.current === composeSession;
        setUploading(true);
        // Harvest EXIF GPS from the ORIGINAL file before upload — the
        // compressor strips it from the stored copy. If the photo knows
        // where it was taken, pin the entry there instead of at the
        // compose-time device fix (the "photo shows at the start of the
        // track" bug: entries written up back at the berth pinned the
        // story at the marina). First photo with GPS wins silently ONLY
        // while the entry has no pin at all. ANY resolved pin — including
        // a brand-new entry the arbiter just pinned to the BOAT — gets
        // the question instead (Shane 2026-08-03: "editing shouldn't
        // update the gps position"; and 2026-09-01: a mast photo taken
        // ashore silently dragged a new entry off the yacht to Newport,
        // past the whole vessel arbitration, with Signal K live). The
        // confirm keeps the deliberate repair path: attach the original
        // photo, accept the prompt, pin fixed.
        try {
            const exif = await extractPhotoExif(file);
            if (!operationIsCurrent()) return;
            // The skipper has already answered which place this entry is
            // about — a photo does not reopen the question, silently or
            // with a prompt. (Its EXIF is only the phone's cached idea of
            // where the camera was, and this phone's cache lies.)
            if (exif && !locationFromPhotoRef.current && !gpsChoiceExplicitRef.current) {
                const hasExistingPin = lat !== null && lon !== null;
                if (hasExistingPin) {
                    const movedM = haversineDistance(lat, lon, exif.lat, exif.lon);
                    // Same spot (GPS scatter) — nothing worth asking about.
                    if (movedM > 200) {
                        setPhotoPinPrompt({ lat: exif.lat, lon: exif.lon, movedM });
                    }
                } else {
                    locationFromPhotoRef.current = true;
                    setLat(exif.lat);
                    setLon(exif.lon);
                    const placeName = await DiaryService.reverseGeocode(exif.lat, exif.lon);
                    if (!operationIsCurrent()) return;
                    setLocationName(placeName || formatCoord(exif.lat, exif.lon));
                }
            }
        } catch {
            /* EXIF is best-effort — device fix remains the fallback */
        }
        if (!operationIsCurrent()) return;
        const url = await DiaryService.uploadPhoto(file);
        if (url) {
            if (!operationIsCurrent()) {
                await DiaryService.discardUnsavedPhoto(url);
            } else {
                unsavedPhotoRefs.current.add(url);
                setPhotos((prev) => [...prev, url]);
            }
        }
        if (operationIsCurrent()) setUploading(false);
        if (fileRef.current) fileRef.current.value = '';
    };
    /**
     * One clip per entry, a minute at most. The duration gate reads metadata
     * from a temporary object URL rather than trusting the picker, because the
     * Photos app will happily hand over a nine-minute 4K file — and at ~200MB a
     * minute the size is worth saying OUT LOUD before it rides a boat uplink,
     * which is the whole reason this exists.
     */
    const handleVideoSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (e.target) e.target.value = '';
        if (!file) return;
        const probeUrl = URL.createObjectURL(file);
        setUploading(true);
        try {
            // The element probe stalls SILENTLY on iOS for long camera files:
            // their moov index lives at the END of the file and WKWebView's
            // media loader gives up on big blobs without firing an error —
            // which made an over-a-minute movie look like nothing happened at
            // all. Give it five seconds, then read the container directly.
            let duration = await new Promise<number>((resolve) => {
                const probe = document.createElement('video');
                const timer = setTimeout(() => resolve(NaN), 5000);
                probe.preload = 'metadata';
                probe.muted = true;
                probe.playsInline = true;
                probe.onloadedmetadata = () => {
                    clearTimeout(timer);
                    resolve(probe.duration);
                };
                probe.onerror = () => {
                    clearTimeout(timer);
                    resolve(NaN);
                };
                probe.src = probeUrl;
                probe.load();
            });
            if (!Number.isFinite(duration) || duration <= 0) {
                const { probeVideoDurationSeconds } = await import('../services/videoTrim');
                duration = (await probeVideoDurationSeconds(file)) ?? NaN;
            }
            if (!Number.isFinite(duration) || duration <= 0) {
                alert('That file could not be read as a video.');
                return;
            }
            if (duration > 61) {
                // Not a rejection any more — the trimmer opens with the whole
                // movie and a one-minute window to drag to the best bit.
                setTrimRequest({ file, durationSec: duration });
                return;
            }
            if (file.size > 550 * 1048576) {
                alert('That clip is over 550MB, which the storage bucket will refuse. Trim or re-encode it first.');
                return;
            }
        } finally {
            URL.revokeObjectURL(probeUrl);
            setUploading(false);
        }
        await adoptCameraVideo(file);
    };
    /**
     * Camera files are QuickTime containers even when the codecs inside are
     * web-friendly, and the public page hands them to browsers that reject the
     * `qt` brand outright (Chrome; Safari sulks too) — so every accepted clip
     * is remuxed into a real MP4 before adoption. Lossless: same frames, same
     * audio, a container browsers recognise, minus Apple's embedded recording
     * GPS. If the remux chokes on an exotic file the original still goes
     * through — a clip that only plays in the app beats one silently lost.
     */
    const adoptCameraVideo = async (file: File) => {
        setUploading(true);
        let accepted: Blob = file;
        try {
            const { remuxVideoLossless } = await import('../services/videoTrim');
            accepted = (await remuxVideoLossless(file)).blob;
        } catch (err) {
            log.warn('Video remux failed — adopting the original container', err);
        }
        await adoptVideoBlob(accepted);
    };
    /** Park an accepted clip (picked short, or freshly cut) as the entry's video. */
    const adoptVideoBlob = async (blob: Blob) => {
        setUploading(true);
        const ref = await DiaryService.saveVideoForEntry(blob);
        if (ref) {
            const previous = unsavedVideoRef.current;
            unsavedVideoRef.current = ref;
            if (previous) void DiaryService.discardUnsavedVideo(previous);
            setVideoUrl(ref);
        } else {
            alert('Could not store the video on this device — check free space.');
        }
        setUploading(false);
    };
    const removeVideo = () => {
        if (saving || composeSaveInFlightRef.current) return;
        const ref = videoUrl;
        setVideoUrl(null);
        if (ref && unsavedVideoRef.current === ref) {
            unsavedVideoRef.current = null;
            void DiaryService.discardUnsavedVideo(ref);
        }
    };
    const removePhoto = (idx: number) => {
        if (saving || composeSaveInFlightRef.current) return;
        const ref = photos[idx];
        setPhotos((prev) => prev.filter((_, i) => i !== idx));
        if (ref) discardNewPhoto(ref);
    };
    // ── Gemini polish ──────────────────────────────────────────
    const handlePolish = async () => {
        if (!body.trim() || polishing) return;
        setPolishing(true);
        triggerHaptic('light');
        const enhanced = await DiaryService.enhanceWithGemini(body, {
            mood,
            location: locationName,
            intensity: POLISH_INTENSITY[polishStyle],
        });
        if (enhanced) setBody(enhanced);
        setPolishing(false);
    };
    // ── Save (create or update) ────────────────────────────────
    const handleSave = async () => {
        if (composeSaveInFlightRef.current || uploading) return;
        if (!body.trim() && !title.trim() && !audioUrl) return;
        const operationScope = getAuthIdentityScope();
        const composeSession = composeSessionRef.current;
        const operationIsCurrent = () =>
            pageActiveRef.current &&
            isAuthIdentityScopeCurrent(operationScope) &&
            composeSessionRef.current === composeSession;
        let mediaAdopted = false;
        const savePhotoRefs = new Set([...unsavedPhotoRefs.current].filter((ref) => photos.includes(ref)));
        savingPhotoRefsRef.current = savePhotoRefs;
        composeSaveInFlightRef.current = true;
        setSaving(true);
        triggerHaptic('medium');

        try {
            // Last-chance GPS — openCompose fires grabGps async, but if the
            // skipper opens the form, types a quick title, and hits save
            // within a couple seconds, the async grab won't have landed yet
            // and the entry would save with NULL lat/lon. The Voyage Log map
            // filters entries by hasCoords, so those entries appear in the
            // sidebar but never as pins on the public map. Block briefly here
            // to fetch the current location if state is still empty — cheap
            // (~200-800ms when the watchPosition stream has a recent fix) and
            // guarantees the map gets every entry.
            let finalLat: number | null = lat;
            let finalLon: number | null = lon;
            let finalLocationName = locationName;
            if (!editingId && (finalLat === null || finalLon === null)) {
                const loc = await DiaryService.getCurrentLocation();
                if (!operationIsCurrent()) return;
                if (loc) {
                    finalLat = loc.lat;
                    finalLon = loc.lon;
                    if (!finalLocationName) {
                        const placeName = await DiaryService.reverseGeocode(loc.lat, loc.lon);
                        if (!operationIsCurrent()) return;
                        if (placeName) finalLocationName = placeName;
                    }
                }
            }

            if (!operationIsCurrent()) return;
            if (editingId) {
                const updateResult = await DiaryService.updateEntry(
                    editingId,
                    {
                        title: title.trim() || formatDate(new Date().toISOString()),
                        body: body.trim(),
                        mood,
                        photos,
                        audio_url: audioUrl,
                        // Persist position on edit — OPEN_EDIT seeds these from
                        // the entry, and a photo attached during the edit may
                        // have re-pinned them from its EXIF. Previously edits
                        // silently dropped position changes.
                        latitude: finalLat,
                        longitude: finalLon,
                        location_name: finalLocationName,
                    },
                    { shouldContinue: operationIsCurrent },
                );
                if (updateResult.ok) {
                    mediaAdopted = true;
                    for (const ref of savePhotoRefs) unsavedPhotoRefs.current.delete(ref);
                    if (videoUrl && unsavedVideoRef.current === videoUrl) unsavedVideoRef.current = null;
                }
                if (!operationIsCurrent()) return;
                if (updateResult.ok) {
                    const savedAudioUrl = updateResult.audioUrl ?? audioUrl;
                    const prevEntry = entries.find((e) => e.id === editingId);
                    const updated: DiaryEntry | null = prevEntry
                        ? {
                              ...prevEntry,
                              title: title.trim() || prevEntry.title,
                              body: body.trim(),
                              mood,
                              photos,
                              audio_url: savedAudioUrl,
                              latitude: finalLat,
                              longitude: finalLon,
                              location_name: finalLocationName || prevEntry.location_name,
                          }
                        : null;
                    setEntries((prev) => prev.map((e) => (e.id === editingId && updated ? updated : e)));
                    setShowCompose(false);
                    setEditingId(null);
                    // Same publish checkpoint as a new entry — lets the skipper
                    // publish/unpublish on save.
                    if (updated) setPublishPromptEntry(updated);
                } else {
                    toast.error('Could not save this entry. Your changes are still in the editor.');
                }
            } else {
                let entry: DiaryEntry | null = null;
                try {
                    entry = await DiaryService.createEntry({
                        video_url: videoUrl,
                        title: title.trim() || formatDate(new Date().toISOString()),
                        body: body.trim(),
                        mood,
                        photos,
                        audio_url: audioUrl,
                        latitude: finalLat,
                        longitude: finalLon,
                        location_name: finalLocationName,
                        weather_summary: weatherSummary,
                        weather_data: state.weatherDataObj,
                        tags: [],
                        // DiaryService resolves the active recording voyage at its
                        // durable boundary. Omitting this field also covers a cold
                        // launch where the Diary is open before Log hydrates.
                    });
                } catch (error) {
                    if (operationIsCurrent()) {
                        log.error('Diary entry save failed:', error);
                        toast.error('Could not save this entry. Please try again.');
                    }
                    return;
                }
                if (entry) {
                    mediaAdopted = true;
                    for (const ref of savePhotoRefs) unsavedPhotoRefs.current.delete(ref);
                    if (videoUrl && unsavedVideoRef.current === videoUrl) unsavedVideoRef.current = null;
                }
                if (!operationIsCurrent()) return;
                if (entry) {
                    setEntries((prev) => [entry, ...prev]);
                    setShowCompose(false);
                    // Offer to publish it to the public Voyage Log.
                    setPublishPromptEntry(entry);
                }
            }
        } finally {
            const abandoned = abandonedComposeSessionsRef.current.delete(composeSession);
            if (!mediaAdopted && (abandoned || !pageActiveRef.current)) {
                for (const ref of savePhotoRefs) void DiaryService.discardUnsavedPhoto(ref);
            }
            if (savingPhotoRefsRef.current === savePhotoRefs) savingPhotoRefsRef.current = null;
            composeSaveInFlightRef.current = false;
            if (pageActiveRef.current) setSaving(false);
        }
        // Don't eagerly refresh here — the 8s periodic poll handles it safely.
        // An immediate refreshEntries() can race with the pending queue merge
        // and cause entries to vanish when offline or on slow connections.
    };
    // ── Delete (soft-delete with undo) ─────────────────────────
    // Commits the delete to DiaryService once the undo window closes.
    // deleteEntry commits locally (tombstone) and always returns true — even
    // offline. No restore-on-failure here: a throw would be pathological, and
    // resurrecting the item in React state would only create a ghost that the
    // (already-committed) tombstone filters out on the next poll.
    const commitDelete = useCallback(async (item: DiaryEntry) => {
        if (!isAuthIdentityScopeCurrent(pageScopeRef.current)) {
            pendingDeleteIdsRef.current.delete(item.id);
            return;
        }
        try {
            await DiaryService.deleteEntry(item.id);
        } catch (e) {
            if (isAuthIdentityScopeCurrent(pageScopeRef.current)) log.warn('delete failed:', e);
        }
        // Clear pending-delete guard once the commit settles
        pendingDeleteIdsRef.current.delete(item.id);
    }, []);
    const handleDelete = (id: string) => {
        const item = entries.find((e) => e.id === id);
        if (!item) return;
        triggerHaptic('medium');
        // A second delete while the first's undo window is open: commit the
        // first immediately so it isn't orphaned when deletedItem is replaced.
        if (deletedItem && deletedItem.id !== id) void commitDelete(deletedItem);
        // Track pending-delete so refreshEntries won't bring it back
        pendingDeleteIdsRef.current.add(id);
        // Remove from UI immediately
        setEntries((prev) => prev.filter((e) => e.id !== id));
        setSelectedEntry(null);
        setDeletedItem(item);
    };
    // Called by UndoToast after 5s — performs the actual delete
    const handleDismissDelete = async () => {
        if (!deletedItem) return;
        const item = deletedItem;
        setDeletedItem(null);
        await commitDelete(item);
    };
    const handleUndoDelete = () => {
        if (deletedItem) {
            setEntries((prev) => [...prev, deletedItem]);
            toast.success('Entry restored');
            pendingDeleteIdsRef.current.delete(deletedItem.id);
        }
        setDeletedItem(null);
    };
    // The undo toast's 5s timer dies if the page unmounts or the app is
    // backgrounded (WKWebView suspends timers) — the delete would silently
    // never be issued and the entry would resurrect on the next poll. Flush
    // any pending delete the moment we lose the foreground.
    const deletedItemRef = useRef<DiaryEntry | null>(null);
    deletedItemRef.current = deletedItem;
    useEffect(() => {
        const flush = () => {
            const item = deletedItemRef.current;
            if (!item) return;
            deletedItemRef.current = null;
            setDeletedItem(null);
            void commitDelete(item);
        };
        const onVisibility = () => {
            if (document.hidden) flush();
        };
        document.addEventListener('visibilitychange', onVisibility);
        window.addEventListener('pagehide', flush);
        return () => {
            document.removeEventListener('visibilitychange', onVisibility);
            window.removeEventListener('pagehide', flush);
            flush(); // unmount — e.g. user navigated to another page mid-window
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [commitDelete]);
    // ── Grouped entries ────────────────────────────────────────
    const grouped = useMemo(() => groupByDate(entries), [entries]);
    // ── PDF Export ───────────────────────────────────────────────
    const exportDiaryPdf = useCallback(
        async (entriesToPrint: DiaryEntry[], delivery: 'download' | 'share') => {
            const operationScope = getAuthIdentityScope();
            const operationIsCurrent = () => pageActiveRef.current && isAuthIdentityScopeCurrent(operationScope);
            setExportProgress(delivery === 'download' ? 'Preparing download...' : 'Preparing share...');
            const { generateDiaryPDF } = await import('../utils/diaryExport');
            if (!operationIsCurrent()) return;
            await generateDiaryPDF(
                entriesToPrint,
                {
                    shouldContinue: operationIsCurrent,
                    onProgress: (msg) => {
                        if (operationIsCurrent()) setExportProgress(msg);
                    },
                    onSuccess: () => {
                        if (!operationIsCurrent()) return;
                        setExportProgress(null);
                        setSelectMode(false);
                        setSelectedIds(new Set());
                    },
                    onError: (err) => {
                        if (!operationIsCurrent()) return;
                        setExportProgress(null);
                        log.error('Diary PDF export error:', err);
                    },
                },
                settings.firstName || undefined,
                delivery,
            );
        },
        [setExportProgress, setSelectMode, setSelectedIds, settings.firstName],
    );
    const toggleEntrySelection = useCallback(
        (id: string) => {
            // Enter select mode on first selection
            if (!state.selectMode) dispatch({ type: 'ENTER_SELECT_MODE' });
            dispatch({ type: 'TOGGLE_ENTRY_SELECTION', id });
        },
        [dispatch, state.selectMode],
    );
    const _exitSelectMode = useCallback(() => {
        setSelectMode(false);
        setSelectedIds(new Set());
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    // AudioWidget is now imported from ./diary/AudioWidget
    // SwipeableDiaryCard — extracted to components/diary/SwipeableDiaryCard.tsx (React.memo)
    // ── Render: Full Entry View ─────────────────────────────────
    if (selectedEntry) {
        return (
            <DiaryEntryView
                entry={selectedEntry}
                firstName={settings.firstName}
                isPlaying={isPlaying}
                transcribing={transcribing}
                deletedItem={deletedItem}
                onBack={() => setSelectedEntry(null)}
                onEdit={openEdit}
                onTogglePlayback={togglePlayback}
                onTranscribe={handleTranscribe}
                onUndo={handleUndoDelete}
                onDismissDelete={handleDismissDelete}
                onDelete={handleDelete}
                onPublishedChange={(id, isPublic) => {
                    setEntries((prev) => prev.map((en) => (en.id === id ? { ...en, is_public: isPublic } : en)));
                    setSelectedEntry(selectedEntry ? { ...selectedEntry, is_public: isPublic } : null);
                }}
            />
        );
    }
    // ── Render: Compose / Edit ───────────────────────────────────
    if (showCompose) {
        return (
            <>
                {gpsConflict && (
                    <div
                        // Centred, not a bottom sheet: anchored low it slid its second
                        // option under the tab bar, and a question with one visible answer
                        // is not a question (Shane, 2026-08-31).
                        className="fixed inset-0 z-[1200] flex items-center justify-center bg-black/80 p-6"
                        role="dialog"
                        aria-modal="true"
                    >
                        <div className="w-full max-w-sm rounded-3xl border border-sky-500/25 bg-slate-950 p-5 shadow-[0_0_40px_rgba(56,189,248,0.15)]">
                            <p className="text-sm font-black uppercase tracking-[0.14em] text-sky-300">
                                Two positions, skipper
                            </p>
                            <p className="mt-1 text-xs leading-relaxed text-gray-400">
                                The boat and this phone are{' '}
                                {gpsConflict.distanceM >= 1852
                                    ? `${(gpsConflict.distanceM / 1852).toFixed(1)} NM`
                                    : `${Math.round(gpsConflict.distanceM)} m`}{' '}
                                apart. Where does this entry belong?
                            </p>
                            <div className="mt-4 space-y-2">
                                <button
                                    type="button"
                                    onClick={() => {
                                        triggerHaptic('light');
                                        applyGpsChoice('vessel');
                                    }}
                                    className="flex min-h-14 w-full items-center gap-3 rounded-xl border border-cyan-500/25 bg-cyan-500/10 px-4 text-left"
                                >
                                    <span className="text-xl">⚓</span>
                                    <span>
                                        <span className="block text-sm font-bold text-cyan-200">On the boat</span>
                                        <span className="block text-[11px] text-gray-400">
                                            Pin it at the vessel —{' '}
                                            {formatCoord(gpsConflict.vessel.lat, gpsConflict.vessel.lon)}
                                        </span>
                                    </span>
                                </button>
                                <button
                                    type="button"
                                    onClick={() => {
                                        triggerHaptic('light');
                                        applyGpsChoice('phone');
                                    }}
                                    className="flex min-h-14 w-full items-center gap-3 rounded-xl border border-violet-500/25 bg-violet-500/10 px-4 text-left"
                                >
                                    <span className="text-xl">📱</span>
                                    <span>
                                        <span className="block text-sm font-bold text-violet-200">
                                            Where I'm standing
                                        </span>
                                        <span className="block text-[11px] text-gray-400">
                                            Pin it here — {formatCoord(gpsConflict.phone.lat, gpsConflict.phone.lon)}
                                        </span>
                                    </span>
                                </button>
                            </div>
                        </div>
                    </div>
                )}
                {trimRequest && (
                    <VideoTrimmer
                        file={trimRequest.file}
                        durationSec={trimRequest.durationSec}
                        onCancel={() => setTrimRequest(null)}
                        onDone={(blob) => {
                            setTrimRequest(null);
                            void adoptVideoBlob(blob);
                        }}
                    />
                )}
                <DiaryComposeForm
                    isEditing={!!editingId}
                    title={title}
                    body={body}
                    mood={mood}
                    photos={photos}
                    audioUrl={audioUrl}
                    videoUrl={videoUrl}
                    locationName={locationName}
                    keyboardHeight={keyboardHeight}
                    saving={saving}
                    uploading={uploading}
                    polishing={polishing}
                    gpsLoading={gpsLoading}
                    coordsLabel={
                        lat != null && lon != null
                            ? `${gpsSource === 'vessel' ? '⚓ ' : gpsSource === 'phone' ? '📱 ' : ''}${formatCoord(lat, lon)}`
                            : null
                    }
                    polishStyle={polishStyle}
                    onSetTitle={setTitle}
                    onSetBody={setBody}
                    onSetMood={setMood}
                    onSetLocationName={setLocationName}
                    onSetPolishStyle={setPolishStyle}
                    onSave={handleSave}
                    onCancel={() => {
                        if (saving || composeSaveInFlightRef.current) return;
                        discardAllNewPhotos();
                        invalidateComposeSession();
                        setUploading(false);
                        setShowCompose(false);
                        setEditingId(null);
                    }}
                    onPolish={handlePolish}
                    onPhotoSelect={handlePhotoSelect}
                    onVideoSelect={handleVideoSelect}
                    onVideoRemove={removeVideo}
                    onPhotoRemove={removePhoto}
                />
            </>
        );
    }
    // ── Render: Timeline ────────────────────────────────────────
    return (
        <div className="relative h-full bg-slate-950 overflow-hidden slide-up-enter">
            {/* Export progress overlay */}
            {exportProgress && (
                <div
                    role="status"
                    aria-live="polite"
                    aria-label={exportProgress}
                    className="absolute inset-0 bg-black/70 flex flex-col items-center justify-center z-50 gap-4"
                >
                    <div className="w-10 h-10 border-2 border-sky-500 border-t-transparent rounded-full animate-spin" />
                    <p className="text-sm font-bold text-white">{exportProgress}</p>
                </div>
            )}
            <div className="flex flex-col h-full">
                <PageHeader
                    title="Diary"
                    onBack={onBack}
                    breadcrumbs={["Ship's Office", 'Diary']}
                    subtitle={
                        <p className="text-label text-gray-400 font-bold uppercase tracking-widest">
                            {entries.length} {entries.length === 1 ? 'Entry' : 'Entries'}
                            {selectedIds.size > 0 && (
                                <span className="text-sky-400 ml-2 inline-flex items-center gap-1">
                                    <CheckIcon className="w-3 h-3" />
                                    <span>{selectedIds.size} selected</span>
                                </span>
                            )}
                        </p>
                    }
                    action={
                        entries.length > 0 ? (
                            <div className="relative">
                                <button
                                    ref={pageActionsTriggerRef}
                                    onClick={() => setMenuOpen(!menuOpen)}
                                    className="p-2 rounded-xl bg-white/5 hover:bg-white/10 transition-colors min-w-[44px] min-h-[44px] flex items-center justify-center"
                                    aria-label={menuOpen ? 'Close diary actions' : 'Open diary actions'}
                                    aria-expanded={menuOpen}
                                    aria-haspopup="menu"
                                    aria-controls={menuOpen ? pageActionsMenuId : undefined}
                                >
                                    <svg className="w-5 h-5 text-gray-400" viewBox="0 0 24 24" fill="currentColor">
                                        <circle cx="12" cy="5" r="1.5" />
                                        <circle cx="12" cy="12" r="1.5" />
                                        <circle cx="12" cy="19" r="1.5" />
                                    </svg>
                                </button>
                                {menuOpen && (
                                    <>
                                        <div
                                            role="presentation"
                                            aria-hidden="true"
                                            className="fixed inset-0 z-40"
                                            onClick={closePageActions}
                                        />
                                        <div
                                            ref={pageActionsMenuRef}
                                            id={pageActionsMenuId}
                                            role="menu"
                                            aria-label="Diary entry actions"
                                            className="absolute right-0 top-full mt-1 z-50 w-52 bg-slate-800 border border-white/10 rounded-xl shadow-2xl overflow-hidden"
                                        >
                                            {selectedIds.size < entries.length && (
                                                <>
                                                    <button
                                                        role="menuitem"
                                                        aria-label="Select all diary entries"
                                                        onClick={() => {
                                                            setSelectedIds(new Set(entries.map((entry) => entry.id)));
                                                            closePageActions();
                                                        }}
                                                        className="w-full flex items-center gap-2.5 px-4 py-3 text-sm text-white hover:bg-white/5 transition-colors"
                                                    >
                                                        <CheckIcon className="w-4 h-4 text-sky-400" />
                                                        Select All
                                                    </button>
                                                    <div role="separator" className="border-t border-white/5" />
                                                </>
                                            )}
                                            <button
                                                role="menuitem"
                                                aria-label="Download selected diary entries"
                                                onClick={() => {
                                                    closePageActions();
                                                    const sel = entries.filter((e) => selectedIds.has(e.id));
                                                    if (sel.length > 0) void exportDiaryPdf(sel, 'download');
                                                }}
                                                disabled={selectedIds.size === 0}
                                                className="w-full flex items-center gap-2.5 px-4 py-3 text-sm text-white hover:bg-white/5 transition-colors disabled:opacity-30"
                                            >
                                                <svg
                                                    className="w-4 h-4 text-sky-400"
                                                    fill="none"
                                                    viewBox="0 0 24 24"
                                                    stroke="currentColor"
                                                    strokeWidth={2}
                                                >
                                                    <path
                                                        strokeLinecap="round"
                                                        strokeLinejoin="round"
                                                        d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
                                                    />
                                                </svg>
                                                Download Selected
                                            </button>
                                            <div role="separator" className="border-t border-white/5" />
                                            <button
                                                role="menuitem"
                                                aria-label="Share selected diary entries"
                                                onClick={() => {
                                                    closePageActions();
                                                    const sel = entries.filter((e) => selectedIds.has(e.id));
                                                    if (sel.length > 0) void exportDiaryPdf(sel, 'share');
                                                }}
                                                disabled={selectedIds.size === 0}
                                                className="w-full flex items-center gap-2.5 px-4 py-3 text-sm text-white hover:bg-white/5 transition-colors disabled:opacity-30"
                                            >
                                                <svg
                                                    className="w-4 h-4 text-emerald-400"
                                                    fill="none"
                                                    viewBox="0 0 24 24"
                                                    stroke="currentColor"
                                                    strokeWidth={2}
                                                >
                                                    <path
                                                        strokeLinecap="round"
                                                        strokeLinejoin="round"
                                                        d="M7.217 10.907a2.25 2.25 0 100 2.186m0-2.186c.18.324.283.696.283 1.093s-.103.77-.283 1.093m0-2.186l9.566-5.314m-9.566 7.5l9.566 5.314m0 0a2.25 2.25 0 103.935 2.186 2.25 2.25 0 00-3.935-2.186zm0-12.814a2.25 2.25 0 103.933-2.185 2.25 2.25 0 00-3.933 2.185z"
                                                    />
                                                </svg>
                                                Share Selected
                                            </button>
                                            {selectedIds.size > 0 && (
                                                <>
                                                    <div role="separator" className="border-t border-white/5" />
                                                    <button
                                                        role="menuitem"
                                                        aria-label="Clear diary entry selection"
                                                        onClick={() => {
                                                            setSelectedIds(new Set());
                                                            closePageActions();
                                                        }}
                                                        className="w-full flex items-center gap-2.5 px-4 py-3 text-sm text-gray-400 hover:bg-white/5 transition-colors"
                                                    >
                                                        <svg
                                                            className="w-4 h-4"
                                                            fill="none"
                                                            viewBox="0 0 24 24"
                                                            stroke="currentColor"
                                                            strokeWidth={2}
                                                        >
                                                            <path
                                                                strokeLinecap="round"
                                                                strokeLinejoin="round"
                                                                d="M6 18L18 6M6 6l12 12"
                                                            />
                                                        </svg>
                                                        Clear Selection
                                                    </button>
                                                </>
                                            )}
                                        </div>
                                    </>
                                )}
                            </div>
                        ) : undefined
                    }
                />
                {/* Content */}
                <div className="flex-1 overflow-y-auto px-4 min-h-0" style={{ paddingBottom: '4px' }}>
                    {loading ? (
                        <div className="space-y-3 px-1">
                            <ShimmerBlock variant="card" />
                            <ShimmerBlock variant="card" />
                            <ShimmerBlock variant="card" />
                        </div>
                    ) : entries.length === 0 ? (
                        <EmptyState
                            icon={<CompassIcon className="w-10 h-10 text-sky-400/60" rotation={0} />}
                            title="Your Story Starts Here"
                            description="Slide below to write your first journal entry. Add photos, voice memos, and GPS coordinates."
                        />
                    ) : (
                        <div className="space-y-6 stagger-in">
                            {Array.from(grouped.entries()).map(([dateKey, dayEntries]) => (
                                <div key={dateKey}>
                                    <div className="flex items-center gap-3 mb-3">
                                        <div className="w-2 h-2 rounded-full bg-sky-500 shrink-0" />
                                        <span className="text-xs font-black text-sky-400 uppercase tracking-widest">
                                            {formatDate(dayEntries[0].created_at)}
                                        </span>
                                        <div className="flex-1 h-px bg-white/5" />
                                    </div>
                                    <div className="space-y-2">
                                        {dayEntries.map((entry) => (
                                            <SwipeableDiaryCard
                                                key={entry.id}
                                                entry={entry}
                                                onTap={() => {
                                                    setSelectedEntry(entry);
                                                    triggerHaptic('light');
                                                }}
                                                onDelete={() => handleDelete(entry.id)}
                                                onEdit={() => openEdit(entry)}
                                                selected={selectedIds.has(entry.id)}
                                                onToggleSelect={() => toggleEntrySelection(entry.id)}
                                            />
                                        ))}
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
                {/* ── Bottom bar: slide-to-action ── */}
                <div
                    className="shrink-0 px-4"
                    style={{ paddingBottom: 'calc(4rem + env(safe-area-inset-bottom) + 8px)' }}
                >
                    <SlideToAction
                        label="Slide to Write Entry"
                        thumbIcon={
                            <svg
                                className="w-5 h-5 text-white"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                                strokeWidth={2.5}
                            >
                                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                            </svg>
                        }
                        onConfirm={() => {
                            triggerHaptic('medium');
                            openCompose();
                        }}
                        theme="sky"
                    />
                </div>
            </div>
            {/* Undo toast (timeline view) */}
            <UndoToast
                // Keyed by the item so a second delete during the first's undo
                // window remounts the toast — fresh 5s timer + progress bar
                // instead of inheriting the first delete's leftover countdown.
                key={deletedItem?.id ?? 'closed'}
                isOpen={!!deletedItem}
                message={`"${deletedItem?.title}" deleted`}
                onUndo={handleUndoDelete}
                onDismiss={handleDismissDelete}
                duration={5000}
            />
            {/* Move-the-pin checkpoint — a GPS-tagged photo was attached while
                editing an entry that already has a position. Declining keeps
                the pin exactly where it was. */}
            <ConfirmDialog
                isOpen={photoPinPrompt !== null}
                title="Move this entry's pin?"
                message={
                    photoPinPrompt
                        ? `This photo was taken ${
                              photoPinPrompt.movedM >= 1852
                                  ? `${(photoPinPrompt.movedM / 1852).toFixed(1)} NM`
                                  : `${Math.round(photoPinPrompt.movedM)} m`
                          } from where this entry is pinned. Move the entry to the photo's location?`
                        : ''
                }
                confirmLabel="Move pin"
                onConfirm={async () => {
                    const p = photoPinPrompt;
                    setPhotoPinPrompt(null);
                    if (!p) return;
                    locationFromPhotoRef.current = true;
                    setLat(p.lat);
                    setLon(p.lon);
                    const placeName = await DiaryService.reverseGeocode(p.lat, p.lon);
                    setLocationName(placeName || formatCoord(p.lat, p.lon));
                }}
                onCancel={() => setPhotoPinPrompt(null)}
            />
            {/* Publish-to-Voyage-Log checkpoint — shown after saving a new or edited entry */}
            {publishPromptEntry && (
                <DiaryPublishModal
                    entry={publishPromptEntry}
                    onClose={() => setPublishPromptEntry(null)}
                    onPublishChange={(updated) =>
                        setEntries((prev) => prev.map((e) => (e.id === updated.id ? updated : e)))
                    }
                />
            )}
        </div>
    );
});
