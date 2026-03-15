import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createLogger } from '../utils/createLogger';

const log = createLogger('DiaryPage');
import { DiaryService, DiaryEntry, DiaryMood, MOOD_CONFIG } from '../services/DiaryService';
import { triggerHaptic } from '../utils/system';
import { Capacitor } from '@capacitor/core';
import { scrollInputAboveKeyboard } from '../utils/keyboardScroll';
import { SlideToAction } from './ui/SlideToAction';
import { AnchorWatchService } from '../services/AnchorWatchService';
import { useWeather } from '../context/WeatherContext';
import { PageHeader } from './ui/PageHeader';
import { OfflineBadge } from './ui/OfflineBadge';
import { UndoToast } from './ui/UndoToast';
import { SwipeableDiaryCard } from './diary/SwipeableDiaryCard';
import { toast } from './Toast';
import { useDiaryState } from '../hooks/useDiaryState';

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

const formatTime = (iso: string): string => {
    return new Date(iso).toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' });
};

const formatCoord = (lat: number, lon: number): string => {
    const latDir = lat >= 0 ? 'N' : 'S';
    const lonDir = lon >= 0 ? 'E' : 'W';
    return `${Math.abs(lat).toFixed(4)}°${latDir}, ${Math.abs(lon).toFixed(4)}°${lonDir}`;
};

const formatDuration = (seconds: number): string => {
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

export const DiaryPage: React.FC<DiaryPageProps> = ({ onBack }) => {
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
        gpsLoading,
        deletedItem,
        selectMode,
        selectedIds,
        menuOpen,
        exportProgress,
        isRecording,
        recordingTime,
        transcribing,
        isPlaying,
        keyboardHeight,
    } = state;

    // Setter shims — same API surface, backed by dispatch
    const setEntries = useCallback(
        (v: DiaryEntry[] | ((prev: DiaryEntry[]) => DiaryEntry[])) => {
            dispatch({ type: 'SET_ENTRIES', entries: typeof v === 'function' ? v(state.entries) : v });
        },
        [dispatch, state.entries],
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
            // For backward compat — exit select mode clears IDs
            if (typeof v === 'function') {
                const next = v(state.selectedIds);
                if (next.size === 0) dispatch({ type: 'EXIT_SELECT_MODE' });
            } else if (v.size === 0) {
                dispatch({ type: 'EXIT_SELECT_MODE' });
            }
        },
        [dispatch, state.selectedIds],
    );

    // Additional setter shims
    const setKeyboardHeight = useCallback(
        (h: number) => dispatch({ type: 'SET_KEYBOARD_HEIGHT', height: h }),
        [dispatch],
    );
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
    const [polishIntensity, setPolishIntensity] = useState(30); // 0=clean grammar, 100=shakespearean

    // Weather context
    const { weatherData } = useWeather();

    const deletedIdRef = useRef<string | null>(null);
    const menuRef = useRef<HTMLDivElement>(null);
    const mediaRecorderRef = useRef<MediaRecorder | null>(null);
    const audioChunksRef = useRef<Blob[]>([]);
    const recordingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const audioPlayerRef = useRef<HTMLAudioElement | null>(null);
    const fileRef = useRef<HTMLInputElement>(null);

    // Track iOS keyboard height via Capacitor Keyboard plugin (reliable with KeyboardResize.None)
    // Falls back to visualViewport for web
    useEffect(() => {
        let cleanup: (() => void) | undefined;

        if (Capacitor.isNativePlatform()) {
            import('@capacitor/keyboard')
                .then(({ Keyboard }) => {
                    const showHandle = Keyboard.addListener('keyboardDidShow', (info) => {
                        setKeyboardHeight(info.keyboardHeight > 0 ? info.keyboardHeight : 0);
                        // After the layout adjusts, scroll the focused field into view
                        setTimeout(() => {
                            const focused = document.activeElement as HTMLElement;
                            if (focused && (focused.tagName === 'INPUT' || focused.tagName === 'TEXTAREA')) {
                                focused.scrollIntoView({ behavior: 'smooth', block: 'center' });
                            }
                        }, 250);
                    });
                    const hideHandle = Keyboard.addListener('keyboardWillHide', () => {
                        setKeyboardHeight(0);
                    });
                    cleanup = () => {
                        showHandle.then((h) => h.remove());
                        hideHandle.then((h) => h.remove());
                    };
                })
                .catch(() => {
                    /* Keyboard plugin not available */
                });
        } else {
            // Web fallback: visualViewport
            const vp = window.visualViewport;
            if (vp) {
                const handleResize = () => {
                    const kbHeight = window.innerHeight - vp.height;
                    setKeyboardHeight(kbHeight > 50 ? kbHeight : 0);
                };
                vp.addEventListener('resize', handleResize);
                cleanup = () => vp.removeEventListener('resize', handleResize);
            }
        }

        return () => {
            cleanup?.();
            setKeyboardHeight(0);
        };
    }, []);

    // ── Load entries ───────────────────────────────────────────

    const refreshEntries = useCallback(() => {
        DiaryService.getEntries(100).then((data) => {
            // Filter out the entry pending soft-delete (undo window still open)
            const pendingId = deletedIdRef.current;
            const fresh = pendingId ? data.filter((e) => e.id !== pendingId) : data;

            // MERGE with existing state instead of replacing.
            // Any offline-created entries already in React state are preserved
            // even if getEntries() doesn't return them (e.g. localStorage quota
            // overflow prevented them from being saved to the pending queue).
            setEntries((prev) => {
                const freshIds = new Set(fresh.map((e) => e.id));
                // Keep entries from prev that are offline-created and NOT in the fresh data
                const preservedFromPrev = prev.filter((e) => e.id.startsWith('offline-') && !freshIds.has(e.id));
                // Merge: fresh data + preserved offline entries, sorted by date
                return [...fresh, ...preservedFromPrev].sort(
                    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
                );
            });
        });
    }, []);

    useEffect(() => {
        DiaryService.getEntries(100).then((data) => {
            setEntries(data);
            setLoading(false);
        });
        // Periodically refresh to clear PENDING badges after background sync
        const interval = setInterval(() => {
            if (!document.hidden) refreshEntries();
        }, 8000);
        return () => clearInterval(interval);
    }, [refreshEntries]);

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            if (recordingTimerRef.current) clearInterval(recordingTimerRef.current);
            if (mediaRecorderRef.current?.state === 'recording') mediaRecorderRef.current.stop();
            if (audioPlayerRef.current) {
                audioPlayerRef.current.pause();
                audioPlayerRef.current = null;
            }
        };
    }, []);

    // ── GPS helper ─────────────────────────────────────────────

    const grabGps = useCallback(async () => {
        setGpsLoading(true);
        const loc = await DiaryService.getCurrentLocation();
        if (loc) {
            setLat(loc.lat);
            setLon(loc.lon);

            // Check anchor watch first — if active, use depth info
            const anchorSnap = AnchorWatchService.getSnapshot();
            const isAnchored = anchorSnap.state === 'watching' || anchorSnap.state === 'alarm';

            // Reverse geocode for a readable place name
            const placeName = await DiaryService.reverseGeocode(loc.lat, loc.lon);

            if (isAnchored) {
                const depth = anchorSnap.config.waterDepth;
                const prefix = `Anchored in ${depth}m of water`;
                setLocationName(placeName ? `${prefix} — ${placeName}` : prefix);
            } else {
                setLocationName(placeName || formatCoord(loc.lat, loc.lon));
            }
        }
        setGpsLoading(false);
    }, []);

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

    const openCompose = useCallback(async () => {
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
        setRecordingTime(0);
        setShowCompose(true);
        triggerHaptic('light');
        grabGps();
    }, [grabGps, buildWeatherSnapshot]);

    // ── Edit (existing) ────────────────────────────────────────

    const openEdit = useCallback(
        (entry: DiaryEntry) => {
            const locationDisplay =
                entry.location_name ||
                (entry.latitude && entry.longitude ? formatCoord(entry.latitude, entry.longitude) : '');
            dispatch({ type: 'OPEN_EDIT', entry, locationDisplay });
            triggerHaptic('light');
        },
        [dispatch],
    );

    // ── Audio Recording ────────────────────────────────────────

    const startRecording = async () => {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

            // Determine best supported audio format
            // iOS WKWebView only supports audio/mp4; desktop Chrome/Firefox support audio/webm
            let mimeType = '';
            if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) {
                mimeType = 'audio/webm;codecs=opus';
            } else if (MediaRecorder.isTypeSupported('audio/webm')) {
                mimeType = 'audio/webm';
            } else if (MediaRecorder.isTypeSupported('audio/mp4')) {
                mimeType = 'audio/mp4';
            } else if (MediaRecorder.isTypeSupported('audio/aac')) {
                mimeType = 'audio/aac';
            }
            // If none match, let the browser pick the default

            const recorderOptions: MediaRecorderOptions = {};
            if (mimeType) recorderOptions.mimeType = mimeType;

            const mediaRecorder = new MediaRecorder(stream, recorderOptions);
            const recordedMime = mediaRecorder.mimeType || mimeType || 'audio/mp4';

            audioChunksRef.current = [];
            mediaRecorderRef.current = mediaRecorder;

            mediaRecorder.ondataavailable = (e) => {
                if (e.data.size > 0) audioChunksRef.current.push(e.data);
            };

            mediaRecorder.onstop = async () => {
                // Stop all tracks
                stream.getTracks().forEach((t) => t.stop());

                const blob = new Blob(audioChunksRef.current, { type: recordedMime });
                if (blob.size > 0) {
                    const url = await DiaryService.uploadAudio(blob);
                    // Store URL for saving with entry (but don't show preview)
                    if (url) setAudioUrl(url);

                    // Auto-transcribe voice memo to text silently
                    if (url) {
                        setTranscribing(true);
                        const text = await DiaryService.transcribeAudio(url, recordedMime);
                        if (text) {
                            setBody((prev) => (prev ? `${prev}\n\n${text}` : text));
                        }
                        setTranscribing(false);
                    }
                }
                if (recordingTimerRef.current) clearInterval(recordingTimerRef.current);
            };

            mediaRecorder.start(100); // Collect data every 100ms for snappy response
            setIsRecording(true);
            setRecordingTime(0);
            triggerHaptic('medium');

            // Timer
            recordingTimerRef.current = setInterval(() => {
                setRecordingTime((prev) => prev + 1);
            }, 1000);
        } catch (err) {
            log.error('[Diary] Mic access denied:', err);
        }
    };

    const stopRecording = () => {
        if (mediaRecorderRef.current?.state === 'recording') {
            mediaRecorderRef.current.stop();
        }
        setIsRecording(false);
        if (recordingTimerRef.current) clearInterval(recordingTimerRef.current);
        triggerHaptic('light');
    };

    const removeAudio = () => {
        setAudioUrl(null);
        setRecordingTime(0);
    };

    // ── Audio Playback ─────────────────────────────────────────

    const togglePlayback = (url: string) => {
        if (isPlaying && audioPlayerRef.current) {
            audioPlayerRef.current.pause();
            audioPlayerRef.current = null;
            setIsPlaying(false);
            return;
        }

        const audio = new Audio(url);
        audioPlayerRef.current = audio;
        audio.play();
        setIsPlaying(true);
        audio.onended = () => {
            setIsPlaying(false);
            audioPlayerRef.current = null;
        };
    };

    // ── Transcribe ─────────────────────────────────────────────

    const handleTranscribe = async (url: string) => {
        if (transcribing) return;
        setTranscribing(true);
        triggerHaptic('light');
        const text = await DiaryService.transcribeAudio(url);
        if (text) {
            setBody((prev) => (prev ? `${prev}\n\n${text}` : text));
        }
        setTranscribing(false);
    };

    // ── Photo handling ─────────────────────────────────────────

    const handlePhotoSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        setUploading(true);
        const url = await DiaryService.uploadPhoto(file);
        if (url) setPhotos((prev) => [...prev, url]);
        setUploading(false);
        if (fileRef.current) fileRef.current.value = '';
    };

    const removePhoto = (idx: number) => {
        setPhotos((prev) => prev.filter((_, i) => i !== idx));
    };

    // ── Gemini polish ──────────────────────────────────────────

    const handlePolish = async () => {
        if (!body.trim() || polishing) return;
        setPolishing(true);
        triggerHaptic('light');
        const enhanced = await DiaryService.enhanceWithGemini(body, {
            mood,
            location: locationName,
            intensity: polishIntensity,
        });
        if (enhanced) setBody(enhanced);
        setPolishing(false);
    };

    // ── Save (create or update) ────────────────────────────────

    const handleSave = async () => {
        if (!body.trim() && !title.trim() && !audioUrl) return;
        setSaving(true);
        triggerHaptic('medium');

        if (editingId) {
            const ok = await DiaryService.updateEntry(editingId, {
                title: title.trim() || formatDate(new Date().toISOString()),
                body: body.trim(),
                mood,
                photos,
            });
            if (ok) {
                setEntries((prev) =>
                    prev.map((e) =>
                        e.id === editingId
                            ? {
                                  ...e,
                                  title: title.trim() || e.title,
                                  body: body.trim(),
                                  mood,
                                  photos,
                                  audio_url: audioUrl,
                              }
                            : e,
                    ),
                );
                setShowCompose(false);
                setEditingId(null);
            }
        } else {
            const entry = await DiaryService.createEntry({
                title: title.trim() || formatDate(new Date().toISOString()),
                body: body.trim(),
                mood,
                photos,
                audio_url: audioUrl,
                latitude: lat,
                longitude: lon,
                location_name: locationName,
                weather_summary: weatherSummary,
                tags: [],
            });
            if (entry) {
                setEntries((prev) => [entry, ...prev]);
                setShowCompose(false);
            }
        }
        setSaving(false);
        // Don't eagerly refresh here — the 8s periodic poll handles it safely.
        // An immediate refreshEntries() can race with the pending queue merge
        // and cause entries to vanish when offline or on slow connections.
    };

    // ── Delete (soft-delete with undo) ─────────────────────────

    const handleDelete = (id: string) => {
        const item = entries.find((e) => e.id === id);
        if (!item) return;
        triggerHaptic('medium');

        // Track pending-delete so refreshEntries won't bring it back
        deletedIdRef.current = id;
        // Remove from UI immediately
        setEntries((prev) => prev.filter((e) => e.id !== id));
        setSelectedEntry(null);
        setDeletedItem(item);
    };

    // Called by UndoToast after 5s — performs the actual API delete
    const handleDismissDelete = async () => {
        if (!deletedItem) return;
        const item = deletedItem;
        setDeletedItem(null);
        try {
            const ok = await DiaryService.deleteEntry(item.id);
            if (!ok) {
                // Delete returned false (e.g. Supabase not ready) — retry once
                log.warn('Delete returned false, retrying...');
                const retry = await DiaryService.deleteEntry(item.id);
                if (!retry) {
                    log.warn('Delete retry failed, restoring entry');
                    toast.error('Failed to delete — try again');
                    setEntries((prev) => [...prev, item]);
                    deletedIdRef.current = null;
                    return;
                }
            }
        } catch (e) {
            log.warn(' delete failed:', e);
            toast.error('Failed to delete entry');
            // Restore on failure
            setEntries((prev) => [...prev, item]);
        }
        // Clear pending-delete ref after successful delete
        deletedIdRef.current = null;
    };

    const handleUndoDelete = () => {
        if (deletedItem) {
            setEntries((prev) => [...prev, deletedItem]);
            toast.success('Entry restored');
        }
        setDeletedItem(null);
        deletedIdRef.current = null;
    };

    // ── Grouped entries ────────────────────────────────────────

    const grouped = groupByDate(entries);

    // ── PDF Export ───────────────────────────────────────────────

    const exportDiaryPdf = useCallback(async (entriesToPrint: DiaryEntry[]) => {
        setExportProgress('Preparing...');
        const { generateDiaryPDF } = await import('../utils/diaryExport');
        generateDiaryPDF(entriesToPrint, {
            onProgress: (msg) => setExportProgress(msg),
            onSuccess: () => {
                setExportProgress(null);
                setSelectMode(false);
                setSelectedIds(new Set());
            },
            onError: (err) => {
                setExportProgress(null);
                log.error('Diary PDF export error:', err);
            },
        });
    }, []);

    const toggleEntrySelection = useCallback(
        (id: string) => {
            // Enter select mode on first selection
            if (!state.selectMode) dispatch({ type: 'ENTER_SELECT_MODE' });
            dispatch({ type: 'TOGGLE_ENTRY_SELECTION', id });
        },
        [dispatch, state.selectMode],
    );

    const exitSelectMode = useCallback(() => {
        setSelectMode(false);
        setSelectedIds(new Set());
    }, []);

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    //  AUDIO PLAYER WIDGET — reused in entry view and compose
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

    const AudioWidget: React.FC<{
        url: string;
        allowTranscribe?: boolean;
        allowRemove?: boolean;
    }> = ({ url, allowTranscribe, allowRemove }) => (
        <div className="bg-gradient-to-r from-emerald-500/10 to-emerald-500/10 border border-emerald-500/15 rounded-xl p-3">
            <div className="flex items-center gap-2.5">
                <button
                    onClick={() => togglePlayback(url)}
                    className="p-2.5 bg-emerald-500/20 rounded-full hover:bg-emerald-500/30 transition-colors active:scale-95"
                >
                    {isPlaying ? (
                        <svg className="w-5 h-5 text-emerald-400" fill="currentColor" viewBox="0 0 24 24">
                            <rect x="6" y="4" width="4" height="16" rx="1" />
                            <rect x="14" y="4" width="4" height="16" rx="1" />
                        </svg>
                    ) : (
                        <svg className="w-5 h-5 text-emerald-400" fill="currentColor" viewBox="0 0 24 24">
                            <path d="M8 5v14l11-7z" />
                        </svg>
                    )}
                </button>
                <div className="flex-1">
                    <p className="text-[11px] font-bold text-emerald-400/70 uppercase tracking-wider">Voice Memo</p>
                    <div className="flex items-center gap-1 mt-0.5">
                        {/* Waveform visualization */}
                        {[3, 5, 8, 12, 6, 10, 4, 7, 11, 5, 8, 3, 6, 9, 4].map((h, i) => (
                            <div
                                key={i}
                                className={`w-1 rounded-full transition-all ${isPlaying ? 'bg-emerald-400 animate-pulse' : 'bg-emerald-500/30'}`}
                                style={{ height: `${h}px`, animationDelay: `${i * 0.1}s` }}
                            />
                        ))}
                    </div>
                </div>
                <div className="flex items-center gap-1">
                    {allowTranscribe && (
                        <button
                            onClick={() => handleTranscribe(url)}
                            disabled={transcribing}
                            className="px-3 py-1.5 bg-white/5 border border-white/10 rounded-lg text-[11px] font-bold text-purple-300 hover:bg-purple-500/15 transition-colors disabled:opacity-40"
                            title="Transcribe to text"
                        >
                            {transcribing ? '⏳' : '📝'} {transcribing ? 'Transcribing…' : 'To Text'}
                        </button>
                    )}
                    {allowRemove && (
                        <button
                            onClick={removeAudio}
                            className="p-1.5 rounded-lg hover:bg-red-500/20 transition-colors"
                        >
                            <svg
                                className="w-4 h-4 text-red-400/60"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                                strokeWidth={1.5}
                            >
                                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                            </svg>
                        </button>
                    )}
                </div>
            </div>
        </div>
    );

    // SwipeableDiaryCard — extracted to components/diary/SwipeableDiaryCard.tsx (React.memo)

    // ── Render: Full Entry View ─────────────────────────────────

    if (selectedEntry) {
        const e = selectedEntry;
        const moodCfg = MOOD_CONFIG[e.mood] || MOOD_CONFIG.neutral;
        const hasCoords = e.latitude != null && e.longitude != null;

        return (
            <div className="flex flex-col h-full bg-slate-950 text-white">
                {/* Header */}
                <div className="shrink-0 px-4 pt-4 pb-3">
                    <div className="flex items-center gap-3">
                        <button
                            onClick={() => setSelectedEntry(null)}
                            className="p-2 rounded-xl bg-white/5 hover:bg-white/10 transition-colors"
                        >
                            <svg
                                className="w-5 h-5 text-gray-400"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                                strokeWidth={2}
                            >
                                <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
                            </svg>
                        </button>
                        <div className="flex-1 min-w-0">
                            <h1 className="text-lg font-extrabold text-white truncate">{e.title}</h1>
                        </div>
                        <button
                            onClick={() => openEdit(e)}
                            className="p-2 rounded-xl bg-white/5 hover:bg-white/10 transition-colors"
                        >
                            <svg
                                className="w-5 h-5 text-sky-400"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                                strokeWidth={1.5}
                            >
                                <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10"
                                />
                            </svg>
                        </button>
                    </div>
                </div>

                {/* Content */}
                <div className="flex-1 overflow-y-auto">
                    {e.photos.length > 0 && (
                        <div className="flex gap-1 overflow-x-auto snap-x snap-mandatory">
                            {e.photos.map((url, i) => (
                                <img
                                    key={i}
                                    src={url}
                                    alt=""
                                    className="w-full h-56 object-cover snap-center shrink-0"
                                />
                            ))}
                        </div>
                    )}

                    <div className="p-5 space-y-4">
                        {/* Meta row */}
                        <div className="flex items-center gap-3 text-sm">
                            <span className="text-lg">{moodCfg.emoji}</span>
                            <span className={`font-bold ${moodCfg.color}`}>{moodCfg.label}</span>
                            <span className="text-gray-500">•</span>
                            <span className="text-gray-400">{formatDate(e.created_at)}</span>
                            <span className="text-gray-500">•</span>
                            <span className="text-gray-500 font-mono text-xs">{formatTime(e.created_at)}</span>
                        </div>

                        {/* GPS Position */}
                        {hasCoords && (
                            <div className="bg-gradient-to-r from-sky-500/10 to-sky-500/10 border border-sky-500/15 rounded-xl p-3">
                                <div className="flex items-center gap-2.5">
                                    <div className="p-2 bg-sky-500/15 rounded-lg">
                                        <svg
                                            className="w-4 h-4 text-sky-400"
                                            fill="none"
                                            viewBox="0 0 24 24"
                                            stroke="currentColor"
                                            strokeWidth={1.5}
                                        >
                                            <path
                                                strokeLinecap="round"
                                                strokeLinejoin="round"
                                                d="M15 10.5a3 3 0 11-6 0 3 3 0 016 0z"
                                            />
                                            <path
                                                strokeLinecap="round"
                                                strokeLinejoin="round"
                                                d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1115 0z"
                                            />
                                        </svg>
                                    </div>
                                    <div className="flex-1">
                                        <p className="text-[11px] font-bold text-sky-400/60 uppercase tracking-wider">
                                            Position
                                        </p>
                                        <p className="text-sm font-bold text-white font-mono tracking-wide">
                                            {formatCoord(e.latitude!, e.longitude!)}
                                        </p>
                                        {e.location_name && !e.location_name.includes('°') && (
                                            <p className="text-xs text-gray-400 mt-0.5">{e.location_name}</p>
                                        )}
                                    </div>
                                </div>
                            </div>
                        )}
                        {!hasCoords && e.location_name && (
                            <div className="flex items-center gap-2 text-xs text-sky-400/70">
                                <svg
                                    className="w-3.5 h-3.5"
                                    fill="none"
                                    viewBox="0 0 24 24"
                                    stroke="currentColor"
                                    strokeWidth={1.5}
                                >
                                    <path
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        d="M15 10.5a3 3 0 11-6 0 3 3 0 016 0z"
                                    />
                                    <path
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1115 0z"
                                    />
                                </svg>
                                <span className="font-medium">{e.location_name}</span>
                            </div>
                        )}

                        {/* Voice Memo */}
                        {e.audio_url && <AudioWidget url={e.audio_url} allowTranscribe={true} />}

                        {/* Weather */}
                        {e.weather_summary && (
                            <div className="text-xs text-gray-500 italic bg-white/[0.03] rounded-xl p-3 border border-white/5">
                                🌤 {e.weather_summary}
                            </div>
                        )}

                        {/* Body */}
                        {e.body && (
                            <div className="text-sm text-gray-200 leading-relaxed whitespace-pre-wrap">{e.body}</div>
                        )}

                        {/* Tags */}
                        {e.tags.length > 0 && (
                            <div className="flex flex-wrap gap-2 pt-2">
                                {e.tags.map((tag) => (
                                    <span
                                        key={tag}
                                        className="text-[11px] font-bold text-sky-400/60 bg-sky-500/10 px-2 py-1 rounded-full uppercase tracking-wider"
                                    >
                                        #{tag}
                                    </span>
                                ))}
                            </div>
                        )}

                        {e._offline && (
                            <div className="flex items-center gap-2 text-[11px] text-amber-400/70 bg-amber-500/10 rounded-lg px-3 py-2 border border-amber-500/10">
                                <span>⏳</span>
                                <span className="font-bold uppercase tracking-wider">
                                    Pending sync — will upload when online
                                </span>
                            </div>
                        )}
                    </div>
                </div>

                {/* Undo toast */}
                <UndoToast
                    isOpen={!!deletedItem}
                    message={`"${deletedItem?.title}" deleted`}
                    onUndo={handleUndoDelete}
                    onDismiss={handleDismissDelete}
                    duration={5000}
                />
            </div>
        );
    }

    // ── Render: Compose / Edit ───────────────────────────────────

    if (showCompose) {
        const isEditing = !!editingId;
        // Dynamic bottom padding: when keyboard is up, add extra space so textarea stays visible
        const bottomPad = keyboardHeight > 0 ? `${keyboardHeight}px` : 'calc(4rem + env(safe-area-inset-bottom) + 8px)';
        return (
            <div className="flex flex-col h-full bg-slate-950 text-white" style={{ paddingBottom: bottomPad }}>
                {/* Header */}
                <div className="shrink-0 px-4 pt-4 pb-3">
                    <div className="flex items-center gap-3">
                        <button
                            onClick={() => {
                                setShowCompose(false);
                                setEditingId(null);
                            }}
                            className="p-2 rounded-xl bg-white/5 hover:bg-white/10 transition-colors"
                        >
                            <svg
                                className="w-5 h-5 text-gray-400"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                                strokeWidth={2}
                            >
                                <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
                            </svg>
                        </button>
                        <div className="flex-1">
                            <h1 className="text-xl font-extrabold text-white uppercase tracking-wider">
                                {isEditing ? 'Edit Entry' : 'New Entry'}
                            </h1>
                        </div>
                        <OfflineBadge />
                    </div>
                </div>

                {/* Compose body — flex column fills viewport, no scroll */}
                <div className="flex-1 flex flex-col p-4 gap-3 min-h-0 overflow-auto no-scrollbar">
                    {/* Title */}
                    <input
                        type="text"
                        placeholder="Entry title (optional)"
                        value={title}
                        onChange={(e) => setTitle(e.target.value)}
                        onFocus={scrollInputAboveKeyboard}
                        autoFocus
                        className="shrink-0 w-full bg-white/[0.03] border border-white/[0.08] rounded-xl px-4 py-3 text-lg font-bold text-white placeholder-gray-500 outline-none focus:border-sky-500/30 transition-colors"
                    />

                    {/* Mood selector — 4 moods, single row */}
                    <div className="shrink-0 grid grid-cols-4 gap-1.5">
                        {(['epic', 'good', 'neutral', 'rough'] as DiaryMood[]).map((key) => {
                            const cfg = MOOD_CONFIG[key];
                            return (
                                <button
                                    key={key}
                                    onClick={() => {
                                        setMood(key);
                                        triggerHaptic('light');
                                    }}
                                    className={`flex items-center justify-center gap-1.5 py-2 rounded-xl text-xs font-bold transition-all ${
                                        mood === key
                                            ? 'bg-white/15 border border-white/20 scale-[1.02]'
                                            : 'bg-white/5 border border-white/[0.06] opacity-60 hover:opacity-90'
                                    }`}
                                >
                                    <span>{cfg.emoji}</span>
                                    <span className={cfg.color}>{cfg.label}</span>
                                </button>
                            );
                        })}
                    </div>

                    {/* ═══ POSITION | VOICE | POLISH — single row ═══ */}
                    <div className="shrink-0 space-y-2">
                        <div className="flex gap-2">
                            {/* Position — 2/3 width, tappable */}
                            <button
                                type="button"
                                onClick={grabGps}
                                disabled={gpsLoading}
                                className="flex-[2] bg-gradient-to-r from-sky-500/10 to-sky-500/10 border border-sky-500/15 rounded-xl p-2.5 flex items-center gap-2 min-w-0 transition-colors hover:bg-sky-500/15 active:scale-[0.98] disabled:opacity-60"
                            >
                                <div className="p-1.5 bg-sky-500/15 rounded-lg shrink-0">
                                    {gpsLoading ? (
                                        <div className="w-4 h-4 border-2 border-sky-400 border-t-transparent rounded-full animate-spin" />
                                    ) : (
                                        <svg
                                            className="w-4 h-4 text-sky-400"
                                            fill="none"
                                            viewBox="0 0 24 24"
                                            stroke="currentColor"
                                            strokeWidth={1.5}
                                        >
                                            <path
                                                strokeLinecap="round"
                                                strokeLinejoin="round"
                                                d="M15 10.5a3 3 0 11-6 0 3 3 0 016 0z"
                                            />
                                            <path
                                                strokeLinecap="round"
                                                strokeLinejoin="round"
                                                d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1115 0z"
                                            />
                                        </svg>
                                    )}
                                </div>
                                <div className="flex-1 min-w-0 text-left">
                                    {lat != null && lon != null ? (
                                        <p className="text-xs font-bold text-white font-mono tracking-wide truncate">
                                            {formatCoord(lat, lon)}
                                        </p>
                                    ) : (
                                        <p className="text-[11px] text-sky-400 font-bold truncate">
                                            {gpsLoading ? 'Acquiring…' : 'Add Position'}
                                        </p>
                                    )}
                                </div>
                            </button>

                            {/* Voice — 1/6 width */}
                            <button
                                onClick={isRecording ? stopRecording : startRecording}
                                className={`flex-1 flex flex-col items-center justify-center gap-0.5 rounded-xl border transition-all active:scale-[0.95] ${
                                    isRecording
                                        ? 'bg-red-500/20 border-red-500/30 animate-pulse'
                                        : 'bg-white/[0.03] border-white/[0.06] hover:bg-emerald-500/10 hover:border-emerald-500/15'
                                }`}
                            >
                                <svg
                                    className={`w-5 h-5 ${isRecording ? 'text-red-400' : 'text-emerald-400'}`}
                                    fill={isRecording ? 'currentColor' : 'none'}
                                    viewBox="0 0 24 24"
                                    stroke="currentColor"
                                    strokeWidth={1.5}
                                >
                                    {isRecording ? (
                                        <rect x="6" y="6" width="12" height="12" rx="2" />
                                    ) : (
                                        <path
                                            strokeLinecap="round"
                                            strokeLinejoin="round"
                                            d="M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5a3 3 0 116 0v8.25a3 3 0 01-3 3z"
                                        />
                                    )}
                                </svg>
                                <span
                                    className={`text-[8px] font-bold uppercase tracking-wider leading-none ${isRecording ? 'text-red-400' : 'text-emerald-400/70'}`}
                                >
                                    {isRecording ? 'Stop' : 'Voice'}
                                </span>
                            </button>

                            {/* Polish — 1/6 width */}
                            <button
                                onClick={handlePolish}
                                disabled={polishing || body.trim().length < 10}
                                className={`flex-1 flex flex-col items-center justify-center gap-0.5 rounded-xl border transition-all active:scale-[0.95] ${
                                    polishing
                                        ? 'bg-purple-500/30 border-purple-500/30 animate-pulse'
                                        : body.trim().length >= 10
                                          ? 'bg-purple-500/20 border-purple-500/30 hover:bg-purple-500/30'
                                          : 'bg-white/[0.03] border-white/[0.06] opacity-30 cursor-default'
                                }`}
                            >
                                <span className="text-lg">{polishing ? '⏳' : '✨'}</span>
                                <span className="text-[8px] font-bold text-purple-300/70 uppercase tracking-wider leading-none">
                                    Polish
                                </span>
                            </button>
                        </div>

                        {/* Polish intensity slider */}
                        <div className="flex items-center gap-2 px-1">
                            <span className="text-[9px] font-bold text-gray-500 uppercase tracking-wider shrink-0 w-10">
                                Clean
                            </span>
                            <input
                                type="range"
                                min={0}
                                max={100}
                                step={5}
                                value={polishIntensity}
                                onChange={(e) => setPolishIntensity(Number(e.target.value))}
                                className="flex-1 h-1.5 appearance-none bg-gradient-to-r from-gray-600 via-purple-500 to-amber-500 rounded-full outline-none [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:shadow-lg [&::-webkit-slider-thumb]:cursor-pointer"
                            />
                            <span className="text-[9px] font-bold text-amber-400/70 uppercase tracking-wider shrink-0 w-12 text-right">
                                Literary
                            </span>
                        </div>

                        {/* Location name input — below the row */}
                        <input
                            type="text"
                            placeholder="Location (e.g. Moreton Bay)"
                            value={locationName}
                            onChange={(e) => setLocationName(e.target.value)}
                            onFocus={scrollInputAboveKeyboard}
                            className="w-full bg-white/5 border border-white/5 rounded-lg px-3 py-1.5 text-[11px] text-gray-300 placeholder-gray-500 outline-none focus:border-sky-500/30 transition-colors"
                        />

                        {/* Recording indicator */}
                        {isRecording && (
                            <div className="flex items-center gap-3 px-3 py-2 bg-gradient-to-r from-red-500/15 to-amber-500/15 border border-red-500/20 rounded-xl">
                                <p className="text-xs font-bold text-red-400 animate-pulse">● Recording</p>
                                <p className="text-sm font-mono font-bold text-white">
                                    {formatDuration(recordingTime)}
                                </p>
                                <div className="flex-1 flex items-center justify-end gap-0.5">
                                    {Array.from({ length: 8 }).map((_, i) => (
                                        <div
                                            key={i}
                                            className="w-1 bg-red-400 rounded-full animate-pulse"
                                            style={{
                                                height: `${6 + Math.random() * 12}px`,
                                                animationDelay: `${i * 0.08}s`,
                                                animationDuration: '0.5s',
                                            }}
                                        />
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>

                    {/* Body text */}
                    <div className="flex-1 min-h-0">
                        <textarea
                            placeholder=""
                            value={body}
                            onChange={(e) => setBody(e.target.value)}
                            onFocus={scrollInputAboveKeyboard}
                            className="w-full h-full min-h-0 bg-slate-900 border border-white/[0.08] rounded-2xl p-4 text-sm text-gray-200 placeholder-gray-500 leading-relaxed resize-none outline-none focus:border-sky-500/30 transition-colors"
                        />
                    </div>

                    {/* Transcribing indicator */}
                    {transcribing && (
                        <div className="shrink-0 flex items-center justify-center gap-2 px-3 py-2 bg-emerald-500/10 border border-emerald-500/15 rounded-xl">
                            <span className="text-sm animate-pulse">🎙️</span>
                            <span className="text-xs font-bold text-emerald-400">Converting speech to text…</span>
                        </div>
                    )}

                    {/* Weather snapshot is auto-captured on save but not shown during compose */}

                    {/* Photos */}
                    <div className="shrink-0">
                        <div
                            className="grid gap-2"
                            style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(56px, 1fr))' }}
                        >
                            {photos.map((url, i) => (
                                <div key={i} className="relative aspect-square rounded-xl overflow-hidden group">
                                    <img src={url} alt="" className="w-full h-full object-cover" />
                                    <button
                                        onClick={() => removePhoto(i)}
                                        className="absolute top-1 right-1 w-5 h-5 bg-black/60 rounded-full flex items-center justify-center text-white text-[11px] opacity-0 group-hover:opacity-100 transition-opacity"
                                    >
                                        ✕
                                    </button>
                                </div>
                            ))}
                            {/* Fill remaining slots with Add buttons */}
                            {Array.from({ length: Math.max(1, 6 - photos.length) }).map((_, i) => (
                                <button
                                    key={`add-${i}`}
                                    onClick={() => fileRef.current?.click()}
                                    disabled={uploading || photos.length >= 6}
                                    className="aspect-square rounded-xl border-2 border-dashed border-white/10 hover:border-sky-500/30 flex flex-col items-center justify-center gap-0.5 text-gray-500 hover:text-sky-400 transition-colors disabled:opacity-30"
                                >
                                    {uploading && i === 0 ? (
                                        <span className="text-xs animate-pulse">📷</span>
                                    ) : (
                                        <>
                                            <svg
                                                className="w-4 h-4"
                                                fill="none"
                                                viewBox="0 0 24 24"
                                                stroke="currentColor"
                                                strokeWidth={1.5}
                                            >
                                                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                                            </svg>
                                        </>
                                    )}
                                </button>
                            ))}
                        </div>
                    </div>
                </div>

                {/* ═══ SAVE + CANCEL — fixed at bottom ═══ */}
                <div className="shrink-0 px-4 py-3 border-t border-white/5 bg-slate-950">
                    <div className="flex gap-3">
                        <button
                            onClick={() => {
                                setShowCompose(false);
                                setEditingId(null);
                            }}
                            className="flex-1 py-3 rounded-xl bg-white/5 border border-white/[0.08] text-gray-400 font-bold text-sm hover:bg-white/10 transition-colors active:scale-[0.98]"
                        >
                            Cancel
                        </button>
                        <button
                            onClick={handleSave}
                            disabled={saving || (!body.trim() && !title.trim() && !audioUrl)}
                            className="flex-[2] py-3 rounded-xl bg-sky-600 hover:bg-sky-500 disabled:bg-gray-700 disabled:text-gray-500 text-white font-bold text-sm transition-colors active:scale-[0.98]"
                        >
                            {saving ? 'Saving…' : isEditing ? 'Update Entry' : 'Save Entry'}
                        </button>
                    </div>
                </div>

                <input ref={fileRef} type="file" accept="image/*" onChange={handlePhotoSelect} className="hidden" />
            </div>
        );
    }

    // ── Render: Timeline ────────────────────────────────────────

    return (
        <div className="relative h-full bg-slate-950 overflow-hidden">
            {/* Export progress overlay */}
            {exportProgress && (
                <div className="absolute inset-0 bg-black/70 flex flex-col items-center justify-center z-50 gap-4">
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
                        <p className="text-label text-gray-500 font-bold uppercase tracking-widest">
                            {entries.length} {entries.length === 1 ? 'Entry' : 'Entries'}
                            {selectedIds.size > 0 && (
                                <span className="text-sky-400 ml-2">✓ {selectedIds.size} selected</span>
                            )}
                        </p>
                    }
                    action={
                        entries.length > 0 ? (
                            <div className="relative" ref={menuRef}>
                                <button
                                    onClick={() => setMenuOpen(!menuOpen)}
                                    className="p-2 rounded-xl bg-white/5 hover:bg-white/10 transition-colors min-w-[44px] min-h-[44px] flex items-center justify-center"
                                    aria-label="Page actions"
                                >
                                    <svg className="w-5 h-5 text-gray-400" viewBox="0 0 24 24" fill="currentColor">
                                        <circle cx="12" cy="5" r="1.5" />
                                        <circle cx="12" cy="12" r="1.5" />
                                        <circle cx="12" cy="19" r="1.5" />
                                    </svg>
                                </button>
                                {menuOpen && (
                                    <>
                                        <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
                                        <div className="absolute right-0 top-full mt-1 z-50 w-52 bg-slate-800 border border-white/10 rounded-xl shadow-2xl overflow-hidden">
                                            <button
                                                onClick={() => {
                                                    setMenuOpen(false);
                                                    const sel = entries.filter((e) => selectedIds.has(e.id));
                                                    if (sel.length > 0) exportDiaryPdf(sel);
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
                                            <div className="border-t border-white/5" />
                                            <button
                                                onClick={() => {
                                                    setMenuOpen(false);
                                                    const sel = entries.filter((e) => selectedIds.has(e.id));
                                                    if (sel.length > 0) exportDiaryPdf(sel);
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
                                                    <div className="border-t border-white/5" />
                                                    <button
                                                        onClick={() => {
                                                            setSelectedIds(new Set());
                                                            setMenuOpen(false);
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
                            {[1, 2, 3].map((i) => (
                                <div
                                    key={i}
                                    className="rounded-2xl border border-white/[0.06] bg-white/[0.03] p-4 space-y-3"
                                >
                                    <div className="flex items-center gap-3">
                                        <div className="w-10 h-10 rounded-full skeleton-shimmer" />
                                        <div className="flex-1 space-y-2">
                                            <div className="h-4 w-3/4 rounded-lg skeleton-shimmer" />
                                            <div className="h-3 w-1/3 rounded-lg skeleton-shimmer" />
                                        </div>
                                    </div>
                                    <div className="h-12 w-full rounded-lg skeleton-shimmer" />
                                </div>
                            ))}
                        </div>
                    ) : entries.length === 0 ? (
                        <div className="flex-1 flex flex-col items-center justify-center text-slate-400 px-6 py-16">
                            <div className="relative w-20 h-20 mb-5">
                                <svg viewBox="0 0 96 96" fill="none" className="w-full h-full text-sky-500/30">
                                    <circle
                                        cx="48"
                                        cy="48"
                                        r="44"
                                        stroke="currentColor"
                                        strokeWidth="1.5"
                                        strokeDasharray="4 4"
                                    />
                                    <circle cx="48" cy="48" r="6" fill="currentColor" fillOpacity="0.3" />
                                    <path d="M48 8L52 44H44L48 8Z" fill="currentColor" fillOpacity="0.6" />
                                    <path d="M48 88L44 52H52L48 88Z" fill="currentColor" fillOpacity="0.3" />
                                </svg>
                            </div>
                            <p className="text-base font-bold text-white mb-1">Your Story Starts Here</p>
                            <p className="text-sm text-white/60 max-w-[240px] text-center">
                                Slide below to write your first journal entry. Add photos, voice memos, and GPS
                                coordinates.
                            </p>
                        </div>
                    ) : (
                        <div className="space-y-6">
                            {Array.from(grouped.entries()).map(([dateKey, dayEntries]) => (
                                <div key={dateKey}>
                                    <div className="flex items-center gap-3 mb-3">
                                        <div className="w-2 h-2 rounded-full bg-sky-500 shrink-0" />
                                        <span className="text-xs font-black text-sky-400 uppercase tracking-widest">
                                            {formatDate(dayEntries[0].created_at)}
                                        </span>
                                        <div className="flex-1 h-px bg-white/5" />
                                    </div>

                                    <div className="space-y-3">
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
                isOpen={!!deletedItem}
                message={`"${deletedItem?.title}" deleted`}
                onUndo={handleUndoDelete}
                onDismiss={handleDismissDelete}
                duration={5000}
            />
        </div>
    );
};
