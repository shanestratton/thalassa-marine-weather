import React, { useState, useEffect, useRef, useCallback, useMemo, useId } from 'react';
import { createLogger } from '../utils/createLogger';
const log = createLogger('DiaryPage');
import { DiaryService, DiaryEntry, DiaryMood, DiaryWeatherData } from '../services/DiaryService';
import { triggerHaptic } from '../utils/system';
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
import { startRecording as startAudioRecording, type AudioRecorderHandle } from '../services/voice/audioRecorder';
import { startDeepgramRecognizer, type DeepgramRecognizerHandle } from '../services/voice/deepgramRecognizer';
import { combineDiaryVoiceTranscript } from '../utils/diaryVoiceTranscript';
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

/**
 * A native voice task can occasionally stall. Never let that hold the Stop
 * action hostage: late handles see the invalidated session and clean
 * themselves up instead.
 */
const settleVoiceTask = async <T,>(promise: Promise<T | null> | null, timeoutMs = 1500): Promise<T | null> => {
    if (!promise) return null;
    return new Promise((resolve) => {
        const timeout = setTimeout(() => resolve(null), timeoutMs);
        void promise.then(
            (value) => {
                clearTimeout(timeout);
                resolve(value);
            },
            () => {
                clearTimeout(timeout);
                resolve(null);
            },
        );
    });
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
        isRecording,
        recordingTime,
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
    const setIsRecording = useCallback(
        (v: boolean) => (v ? dispatch({ type: 'START_RECORDING' }) : dispatch({ type: 'STOP_RECORDING' })),
        [dispatch],
    );
    const setRecordingTime = useCallback(
        (v: number | ((prev: number) => number)) => {
            if (typeof v === 'function') dispatch({ type: 'TICK_RECORDING' });
            else dispatch({ type: 'SET_RECORDING_TIME', time: v });
        },
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
    const audioRecorderRef = useRef<AudioRecorderHandle | null>(null);
    const audioRecorderStartRef = useRef<Promise<AudioRecorderHandle | null> | null>(null);
    const liveRecognizerRef = useRef<DeepgramRecognizerHandle | null>(null);
    const liveRecognizerStartRef = useRef<Promise<DeepgramRecognizerHandle | null> | null>(null);
    const liveStopRef = useRef<Promise<string | null> | null>(null);
    // Once Stop has been pressed the active handles move here. Keeping them
    // reachable means Cancel/sign-out can still release WebKit's microphone
    // rather than waiting for a network final-flush to finish.
    const stoppingAudioRecorderRef = useRef<AudioRecorderHandle | null>(null);
    const stoppingLiveRecognizerRef = useRef<DeepgramRecognizerHandle | null>(null);
    const voiceSessionRef = useRef(0);
    const composeSessionRef = useRef(0);
    const voiceListeningRef = useRef(false);
    const voiceFinalizingSessionRef = useRef<number | null>(null);
    const voiceSessionScopeRef = useRef(getAuthIdentityScope());
    const voiceBaselineRef = useRef('');
    const voiceTranscriptRef = useRef('');
    const speechHasTranscriptRef = useRef(false);
    // Startup can outlive a fast tap on Stop (especially while iOS is
    // presenting the microphone prompt). Keep accepting handles until the
    // stop path has either claimed or explicitly timed them out, rather than
    // cancelling a perfectly good capture session mid-startup.
    const voiceAcceptingStartHandlesRef = useRef<number | null>(null);
    const liveDictationUnavailableRef = useRef(false);
    // A memo is not owned by a diary entry until Save completes. Keep its IDB
    // ref here so Cancel, retry, and unmount can discard it without leaks.
    const unsavedVoiceAudioRef = useRef<string | null>(null);
    // A save may have already loaded this IDB blob for upload when the skipper
    // Cancels. Defer deletion until that operation settles so it cannot race
    // its own read/upload pipeline.
    const savingVoiceAudioRef = useRef<string | null>(null);
    // Photos returned by uploadPhoto are still compose-owned until a confirmed
    // create/update adopts them. Existing edit photos never enter this set.
    const unsavedPhotoRefs = useRef<Set<string>>(new Set());
    // A Save snapshots only the refs it is adopting. Account B can therefore
    // begin a clean compose after an A→B switch without Cancel racing A's bytes.
    const savingPhotoRefsRef = useRef<Set<string> | null>(null);
    const abandonedComposeSessionsRef = useRef<Set<number>>(new Set());
    const composeSaveInFlightRef = useRef(false);
    const recordingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const audioPlayerRef = useRef<HTMLAudioElement | null>(null);
    const fileRef = useRef<HTMLInputElement>(null);
    const pageScopeRef = useRef(getAuthIdentityScope());
    const entriesLoadRequestRef = useRef(0);
    const pageActiveRef = useRef(true);
    const voicePolishContextRef = useRef({ mood, locationName, polishStyle });
    voicePolishContextRef.current = { mood, locationName, polishStyle };

    /**
     * Invalidate the current microphone cycle before changing compose state.
     * Late native/STT callbacks must never write into a cancelled or newly
     * opened diary entry.
     */
    const abortVoiceSession = useCallback(
        (resetUi = true) => {
            voiceSessionRef.current += 1;
            // Any in-flight Save belongs to the abandoned compose screen. Its
            // eventual completion must never close or overwrite a new one.
            composeSessionRef.current += 1;
            voiceListeningRef.current = false;
            voiceFinalizingSessionRef.current = null;
            speechHasTranscriptRef.current = false;
            voiceAcceptingStartHandlesRef.current = null;
            liveDictationUnavailableRef.current = false;
            liveStopRef.current = null;
            liveRecognizerStartRef.current = null;
            audioRecorderStartRef.current = null;

            if (recordingTimerRef.current) {
                clearInterval(recordingTimerRef.current);
                recordingTimerRef.current = null;
            }

            const recorder = audioRecorderRef.current;
            audioRecorderRef.current = null;
            recorder?.cancel();

            const recognizer = liveRecognizerRef.current;
            liveRecognizerRef.current = null;
            if (recognizer) void recognizer.cancel();

            const stoppingRecorder = stoppingAudioRecorderRef.current;
            stoppingAudioRecorderRef.current = null;
            stoppingRecorder?.cancel();

            const stoppingRecognizer = stoppingLiveRecognizerRef.current;
            stoppingLiveRecognizerRef.current = null;
            if (stoppingRecognizer) void stoppingRecognizer.cancel();

            const unsavedAudio = unsavedVoiceAudioRef.current;
            unsavedVoiceAudioRef.current = null;
            if (unsavedAudio && savingVoiceAudioRef.current !== unsavedAudio) {
                void DiaryService.discardUnsavedAudio(unsavedAudio);
            }

            if (resetUi) {
                setIsRecording(false);
                setTranscribing(false);
                setPolishing(false);
                if (!composeSaveInFlightRef.current) setSaving(false);
            }
        },
        [setIsRecording, setPolishing, setSaving, setTranscribing],
    );

    const discardNewPhoto = useCallback((ref: string): void => {
        if (!unsavedPhotoRefs.current.delete(ref)) return;
        void DiaryService.discardUnsavedPhoto(ref);
    }, []);

    const discardAllNewPhotos = useCallback((): void => {
        const refs = [...unsavedPhotoRefs.current];
        unsavedPhotoRefs.current.clear();
        for (const ref of refs) void DiaryService.discardUnsavedPhoto(ref);
    }, []);

    /** Detach an abandoned compose without touching refs an active Save owns. */
    const abandonComposePhotos = useCallback((): void => {
        const savingRefs = savingPhotoRefsRef.current ?? new Set<string>();
        const refs = [...unsavedPhotoRefs.current];
        unsavedPhotoRefs.current.clear();
        for (const ref of refs) {
            if (!savingRefs.has(ref)) void DiaryService.discardUnsavedPhoto(ref);
        }
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
            abortVoiceSession(false);
            if (audioPlayerRef.current) {
                audioPlayerRef.current.pause();
                audioPlayerRef.current = null;
            }
        };
    }, [abandonComposePhotos, abortVoiceSession]);
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
            pendingDeleteIdsRef.current.clear();
            dispatch({ type: 'EXIT_SELECT_MODE' });
            dispatch({ type: 'OPEN_COMPOSE', weatherSummary: '' });
            dispatch({ type: 'CLOSE_COMPOSE' });
            setUploading(false);
            setGpsLoading(false);
            setMenuOpen(false);
            setLoading(true);
            abandonComposePhotos();
            abortVoiceSession();
            if (audioPlayerRef.current) {
                audioPlayerRef.current.pause();
                audioPlayerRef.current = null;
                setIsPlaying(false);
            }
            void loadEntriesForScope(next, true);
        });
    }, [
        abandonComposePhotos,
        abortVoiceSession,
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
    const grabGps = useCallback(async () => {
        const operationScope = getAuthIdentityScope();
        const composeSession = composeSessionRef.current;
        const operationIsCurrent = () =>
            pageActiveRef.current &&
            isAuthIdentityScopeCurrent(operationScope) &&
            composeSessionRef.current === composeSession;
        if (locationFromPhotoRef.current) return;
        setGpsLoading(true);
        const loc = await DiaryService.getCurrentLocation();
        if (!operationIsCurrent()) return;
        // Re-check after the await — a photo may have been attached while
        // the fix was in flight (openCompose fires this async).
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
        if (operationIsCurrent()) setGpsLoading(false);
    }, [setGpsLoading, setLat, setLocationName, setLon]);
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
        abortVoiceSession();
        setEditingId(null);
        setTitle('');
        setBody('');
        setMood('good');
        setPhotos([]);
        setAudioUrl(null);
        setLat(null);
        setLon(null);
        setLocationName('');
        setWeatherSummary(buildWeatherSnapshot());
        dispatch({ type: 'SET_WEATHER_DATA', data: buildWeatherData() });
        setRecordingTime(0);
        setShowCompose(true);
        triggerHaptic('light');
        locationFromPhotoRef.current = false;
        grabGps();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [abortVoiceSession, grabGps, buildWeatherSnapshot, buildWeatherData, dispatch]);
    // ── Edit (existing) ────────────────────────────────────────
    const openEdit = useCallback(
        (entry: DiaryEntry) => {
            abortVoiceSession();
            // Fresh edit session: a photo attached DURING this edit may
            // re-pin the entry from its EXIF (the repair path for entries
            // pinned at the berth — re-attach the original photo and the
            // pin moves to where it was taken).
            locationFromPhotoRef.current = false;
            const locationDisplay =
                entry.location_name ||
                (entry.latitude && entry.longitude ? formatCoord(entry.latitude, entry.longitude) : '');
            dispatch({ type: 'OPEN_EDIT', entry, locationDisplay });
            triggerHaptic('light');
        },
        [abortVoiceSession, dispatch],
    );
    // ── Voice diary ─────────────────────────────────────────────
    // Streaming dictation writes partial words into the voice-only body field.
    // The same WebKit microphone stream is recorded as a robust fallback when
    // the live network transcription path is unavailable.
    const finaliseVoiceEntry = useCallback(
        async (
            sessionId: number,
            operationScope: ReturnType<typeof getAuthIdentityScope>,
            baseline: string,
            audio?: { blob: Blob; mimeType: string },
        ) => {
            const operationIsCurrent = () =>
                pageActiveRef.current &&
                isAuthIdentityScopeCurrent(operationScope) &&
                voiceSessionRef.current === sessionId;

            if (!operationIsCurrent() || voiceFinalizingSessionRef.current !== sessionId) return;

            setTranscribing(true);
            try {
                // Keep the raw memo in IndexedDB until the skipper saves the
                // entry. That makes Cancel genuinely discard it and avoids
                // putting base64 audio into the localStorage pending queue.
                let attachedAudio = false;
                let localAudioUrl: string | null = null;
                const attachLocalAudio = async (): Promise<string | null> => {
                    if (!audio?.blob.size || attachedAudio) return localAudioUrl;
                    attachedAudio = true;
                    // Delay the IDB write until it is genuinely needed. If
                    // the skipper Cancels while the live text is being styled,
                    // there is no memo blob to clean up afterwards.
                    const refPromise = DiaryService.saveAudioForEntry(audio.blob);
                    localAudioUrl = await settleVoiceTask(refPromise, 5000);
                    if (!localAudioUrl) {
                        // A very slow IDB write must not keep the form locked;
                        // if it completes late, discard its otherwise-orphaned
                        // blob rather than retaining private audio indefinitely.
                        void refPromise.then((lateRef) => {
                            if (lateRef) void DiaryService.discardUnsavedAudio(lateRef);
                        });
                    }
                    if (!operationIsCurrent()) {
                        if (localAudioUrl) void DiaryService.discardUnsavedAudio(localAudioUrl);
                        return null;
                    }
                    if (localAudioUrl) {
                        unsavedVoiceAudioRef.current = localAudioUrl;
                        setAudioUrl(localAudioUrl);
                    } else log.warn('[Diary] Voice memo could not be saved');
                    return localAudioUrl;
                };

                let transcript = '';
                let fallbackTranscriptionFailed = false;
                try {
                    const speechResult = await liveStopRef.current;
                    transcript = (speechResult || voiceTranscriptRef.current).trim();
                } catch (err) {
                    log.warn('[Diary] Live dictation did not finish cleanly:', err);
                }
                if (!operationIsCurrent()) return;

                // Replace the interim live text with the recognizer's final
                // result as soon as Stop is pressed — never append duplicate
                // partial words to the diary.
                if (transcript) setBody(combineDiaryVoiceTranscript(baseline, transcript));

                // A recorded-audio transcription is the fallback only. This
                // keeps the primary path responsive while still covering an
                // unavailable streaming connection and offline-capable web.
                if (!transcript && audio) {
                    localAudioUrl = await attachLocalAudio();
                    if (!operationIsCurrent()) return;
                }
                if (!transcript && localAudioUrl && audio) {
                    const fallbackTranscript = await DiaryService.transcribeAudio(localAudioUrl, audio.mimeType);
                    if (!operationIsCurrent()) return;
                    // null means the transcription service failed or could
                    // not be reached; an empty string is its explicit result
                    // for a recording that genuinely contains no speech.
                    fallbackTranscriptionFailed = fallbackTranscript === null;
                    transcript = fallbackTranscript?.trim() || '';
                    if (transcript) setBody(combineDiaryVoiceTranscript(baseline, transcript));
                }

                if (!transcript) {
                    toast.error(
                        fallbackTranscriptionFailed && localAudioUrl
                            ? 'Your voice memo was saved, but transcription is unavailable right now. You can save it and try again when online.'
                            : localAudioUrl
                              ? 'We could not hear any speech. Your voice memo was kept so you can try again.'
                              : speechHasTranscriptRef.current
                                ? 'Speech was detected, but the final transcript could not complete. Please try again.'
                                : liveDictationUnavailableRef.current
                                  ? 'Live dictation could not connect, and no voice memo was captured. Check microphone access and try again.'
                                  : 'We could not hear any speech. Check microphone access, then try again.',
                    );
                    return;
                }

                // Do the requested styling pass only after the skipper presses
                // Stop, preserving the raw spoken text if the AI is offline or
                // temporarily unavailable.
                if (transcript.length >= 5) {
                    setPolishing(true);
                    const polishContext = voicePolishContextRef.current;
                    const enhanced = await DiaryService.enhanceWithGemini(transcript, {
                        mood: polishContext.mood,
                        location: polishContext.locationName,
                        intensity: POLISH_INTENSITY[polishContext.polishStyle],
                    });
                    if (!operationIsCurrent()) return;

                    if (enhanced) {
                        setBody(combineDiaryVoiceTranscript(baseline, enhanced));
                    } else {
                        toast.info('Voice captured. The original wording was kept because styling is unavailable.');
                    }
                    setPolishing(false);
                }

                // Keep Save locked until the raw memo is represented locally
                // in the entry, without waiting for a remote storage upload.
                await attachLocalAudio();
            } catch (err) {
                log.error('[Diary] Voice entry finalisation failed:', err);
                if (operationIsCurrent()) {
                    toast.error('Your voice entry could not be finished. Please try recording it again.');
                }
            } finally {
                if (voiceFinalizingSessionRef.current === sessionId) {
                    voiceFinalizingSessionRef.current = null;
                    if (operationIsCurrent()) {
                        setTranscribing(false);
                        setPolishing(false);
                    }
                }
            }
        },
        [setAudioUrl, setBody, setPolishing, setTranscribing],
    );

    const startRecording = () => {
        if (voiceListeningRef.current || voiceFinalizingSessionRef.current !== null) return;

        const previousUnsavedAudio = unsavedVoiceAudioRef.current;
        if (previousUnsavedAudio) {
            unsavedVoiceAudioRef.current = null;
            void DiaryService.discardUnsavedAudio(previousUnsavedAudio);
            setAudioUrl(null);
        }

        const operationScope = getAuthIdentityScope();
        const sessionId = voiceSessionRef.current + 1;
        voiceSessionRef.current = sessionId;
        voiceSessionScopeRef.current = operationScope;
        voiceBaselineRef.current = body.trimEnd();
        voiceTranscriptRef.current = '';
        speechHasTranscriptRef.current = false;
        voiceAcceptingStartHandlesRef.current = sessionId;
        liveDictationUnavailableRef.current = false;
        liveStopRef.current = null;
        voiceListeningRef.current = true;

        const operationIsCurrent = () =>
            pageActiveRef.current &&
            isAuthIdentityScopeCurrent(operationScope) &&
            voiceSessionRef.current === sessionId;
        const isListeningSession = () => operationIsCurrent() && voiceListeningRef.current;
        const canAcceptStartingHandle = () =>
            operationIsCurrent() && voiceAcceptingStartHandlesRef.current === sessionId;

        // Show the active state immediately, including while iOS asks for
        // microphone access, so a second tap correctly means Stop.
        setIsRecording(true);
        setRecordingTime(0);
        triggerHaptic('medium');
        recordingTimerRef.current = setInterval(() => {
            if (!isListeningSession()) {
                if (recordingTimerRef.current) {
                    clearInterval(recordingTimerRef.current);
                    recordingTimerRef.current = null;
                }
                return;
            }
            setRecordingTime((prev) => prev + 1);
        }, 1000);

        // One WebKit capture stream powers both the raw memo and the live
        // recognizer. Do not pair SFSpeechRecognizer's AVAudioEngine with a
        // separate getUserMedia session: on iOS they compete for the mic and
        // produce the exact silent-dictation failure this diary is avoiding.
        const audioStart = startAudioRecording()
            .then((recorder) => {
                if (!canAcceptStartingHandle()) {
                    recorder.cancel();
                    return null;
                }
                audioRecorderRef.current = recorder;

                // Stop may have landed while iOS was presenting the mic
                // permission prompt. In that case the stop path has already
                // captured `audioStart` and will stop this recorder to keep
                // the raw memo; it cannot also see a recognizer that begins
                // only now. Do not start a fresh Deepgram session after Stop
                // or it can remain open without a matching stop()/cancel().
                if (!isListeningSession()) return recorder;

                const liveStart = startDeepgramRecognizer({
                    stream: recorder.mediaStream(),
                    onPartial: (text) => {
                        if (!isListeningSession()) return;
                        const partial = text.trim();
                        if (!partial) return;
                        speechHasTranscriptRef.current = true;
                        voiceTranscriptRef.current = partial;
                        setBody(combineDiaryVoiceTranscript(voiceBaselineRef.current, partial));
                    },
                })
                    .then(async (handle) => {
                        if (!canAcceptStartingHandle()) {
                            await handle.cancel();
                            return null;
                        }
                        liveRecognizerRef.current = handle;
                        return handle;
                    })
                    .catch((err) => {
                        // The raw recording keeps running, so an unavailable
                        // network/STT connection still has a post-Stop Gemini
                        // transcription path instead of losing the entry.
                        if (isListeningSession()) {
                            log.info('[Diary] Live dictation unavailable; using audio transcription fallback:', err);
                            liveDictationUnavailableRef.current = true;
                        }
                        return null;
                    });
                liveRecognizerStartRef.current = liveStart;
                void liveStart.then((handle) => {
                    if (!isListeningSession() || handle) return;
                    toast.info('Live dictation is unavailable. We will convert this recording when you press Stop.');
                });
                return recorder;
            })
            .catch((err) => {
                log.warn('[Diary] Audio-recording fallback unavailable:', err);
                if (!isListeningSession()) return null;
                voiceListeningRef.current = false;
                setIsRecording(false);
                if (recordingTimerRef.current) {
                    clearInterval(recordingTimerRef.current);
                    recordingTimerRef.current = null;
                }
                toast.error('Microphone access is unavailable. Enable Microphone access in Settings.');
                if (voiceAcceptingStartHandlesRef.current === sessionId) {
                    voiceAcceptingStartHandlesRef.current = null;
                }
                return null;
            });
        audioRecorderStartRef.current = audioStart;
    };

    const stopRecording = () => {
        if (!voiceListeningRef.current) return;

        const sessionId = voiceSessionRef.current;
        const operationScope = voiceSessionScopeRef.current;
        const baseline = voiceBaselineRef.current;
        const isStopSessionCurrent = () =>
            pageActiveRef.current &&
            isAuthIdentityScopeCurrent(operationScope) &&
            voiceSessionRef.current === sessionId &&
            voiceFinalizingSessionRef.current === sessionId;
        voiceListeningRef.current = false;
        voiceFinalizingSessionRef.current = sessionId;
        setIsRecording(false);
        // Set this synchronously, before MediaRecorder's asynchronous stop
        // event, so Save can never win the race and discard the final words.
        setTranscribing(true);
        if (recordingTimerRef.current) {
            clearInterval(recordingTimerRef.current);
            recordingTimerRef.current = null;
        }
        triggerHaptic('light');

        const activeLiveRecognizer = liveRecognizerRef.current;
        liveRecognizerRef.current = null;
        const pendingLiveRecognizer = liveRecognizerStartRef.current;
        const beginLiveStop = (recognizer: DeepgramRecognizerHandle): Promise<string | null> => {
            stoppingLiveRecognizerRef.current = recognizer;
            // Calling stop() immediately sends the final PCM batch and
            // CloseStream synchronously, before it awaits Deepgram's final
            // response. The recorder can therefore release the mic right
            // away without clipping the skipper's last words.
            return recognizer
                .stop()
                .then((result) => result.text)
                .catch((err) => {
                    log.warn('[Diary] Could not stop live dictation:', err);
                    return null;
                })
                .finally(() => {
                    if (stoppingLiveRecognizerRef.current === recognizer) {
                        stoppingLiveRecognizerRef.current = null;
                    }
                });
        };
        liveStopRef.current = activeLiveRecognizer
            ? beginLiveStop(activeLiveRecognizer)
            : (async () => {
                  // A just-tapped Stop may race the network handshake. This
                  // is a bounded post-permission wait only — startup itself
                  // never has a permission timeout.
                  const recognizer = await settleVoiceTask(pendingLiveRecognizer);
                  if (!recognizer) return null;
                  if (!isStopSessionCurrent()) {
                      await recognizer.cancel();
                      return null;
                  }
                  return beginLiveStop(recognizer);
              })();

        const activeRecorder = audioRecorderRef.current;
        audioRecorderRef.current = null;
        const pendingRecorder = audioRecorderStartRef.current;
        const beginRecorderStop = (recorder: AudioRecorderHandle): Promise<Blob | null> => {
            stoppingAudioRecorderRef.current = recorder;
            // Do not await the live recognizer here. Its stop call above has
            // already flushed/sent the tail audio; stopping MediaRecorder now
            // releases the iOS microphone as soon as the skipper taps Stop.
            return recorder
                .stop()
                .catch((err) => {
                    log.warn('[Diary] Audio recorder did not finish cleanly:', err);
                    return null;
                })
                .finally(() => {
                    if (stoppingAudioRecorderRef.current === recorder) {
                        stoppingAudioRecorderRef.current = null;
                    }
                });
        };
        const recorderStop = activeRecorder
            ? beginRecorderStop(activeRecorder)
            : (async () => {
                  const recorder = await settleVoiceTask(pendingRecorder);
                  if (!recorder) return null;
                  if (!isStopSessionCurrent()) {
                      recorder.cancel();
                      return null;
                  }
                  return beginRecorderStop(recorder);
              })();
        void (async () => {
            const [, audio] = await Promise.all([liveStopRef.current, recorderStop]);
            // Both bounded startup waits have now completed (or timed out).
            // Any handle arriving after this point belongs to an abandoned
            // session and will cancel itself in the adoption guard above.
            if (voiceAcceptingStartHandlesRef.current === sessionId) {
                voiceAcceptingStartHandlesRef.current = null;
            }
            if (!isStopSessionCurrent()) return;
            if (audio) {
                await finaliseVoiceEntry(sessionId, operationScope, baseline, {
                    blob: audio,
                    mimeType: activeRecorder?.mimeType() || audio.type || 'audio/mp4',
                });
            } else {
                await finaliseVoiceEntry(sessionId, operationScope, baseline);
            }
        })();
    };
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
        // story at the marina). First photo with GPS wins — but ONLY
        // silently for a NEW entry or one with no position. An EXISTING
        // pin is never moved without asking (Shane 2026-08-03: "editing
        // shouldn't update the gps position") — a dinner photo added at
        // home must not quietly re-pin a voyage entry to the house on a
        // public page. The confirm keeps the deliberate repair path:
        // re-attach the original photo, accept the prompt, pin fixed.
        try {
            const exif = await extractPhotoExif(file);
            if (!operationIsCurrent()) return;
            if (exif && !locationFromPhotoRef.current) {
                const hasExistingPin = editingId !== null && lat !== null && lon !== null;
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
        if (
            composeSaveInFlightRef.current ||
            uploading ||
            voiceListeningRef.current ||
            voiceFinalizingSessionRef.current !== null
        )
            return;
        if (!body.trim() && !title.trim() && !audioUrl) return;
        const operationScope = getAuthIdentityScope();
        const composeSession = composeSessionRef.current;
        const operationIsCurrent = () =>
            pageActiveRef.current &&
            isAuthIdentityScopeCurrent(operationScope) &&
            composeSessionRef.current === composeSession;
        let mediaAdopted = false;
        const savePhotoRefs = new Set([...unsavedPhotoRefs.current].filter((ref) => photos.includes(ref)));
        const saveAudioRef = audioUrl?.startsWith('idb-audio:') ? audioUrl : null;
        if (saveAudioRef) savingVoiceAudioRef.current = saveAudioRef;
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
                    if (unsavedVoiceAudioRef.current === audioUrl) unsavedVoiceAudioRef.current = null;
                    if (saveAudioRef && savingVoiceAudioRef.current === saveAudioRef) {
                        savingVoiceAudioRef.current = null;
                    }
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
                    if (unsavedVoiceAudioRef.current === audioUrl) unsavedVoiceAudioRef.current = null;
                    if (saveAudioRef && savingVoiceAudioRef.current === saveAudioRef) {
                        savingVoiceAudioRef.current = null;
                    }
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
            if (saveAudioRef && savingVoiceAudioRef.current === saveAudioRef) {
                savingVoiceAudioRef.current = null;
                if (!operationIsCurrent()) void DiaryService.discardUnsavedAudio(saveAudioRef);
            }
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
            <DiaryComposeForm
                isEditing={!!editingId}
                title={title}
                body={body}
                mood={mood}
                photos={photos}
                audioUrl={audioUrl}
                locationName={locationName}
                keyboardHeight={keyboardHeight}
                saving={saving}
                uploading={uploading}
                polishing={polishing}
                isRecording={isRecording}
                recordingTime={recordingTime}
                transcribing={transcribing}
                polishStyle={polishStyle}
                onSetTitle={setTitle}
                onSetMood={setMood}
                onSetLocationName={setLocationName}
                onSetPolishStyle={setPolishStyle}
                onSave={handleSave}
                onCancel={() => {
                    if (saving || composeSaveInFlightRef.current) return;
                    discardAllNewPhotos();
                    abortVoiceSession();
                    setUploading(false);
                    setShowCompose(false);
                    setEditingId(null);
                }}
                onStartRecording={startRecording}
                onStopRecording={stopRecording}
                onPolish={handlePolish}
                onPhotoSelect={handlePhotoSelect}
                onPhotoRemove={removePhoto}
            />
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
