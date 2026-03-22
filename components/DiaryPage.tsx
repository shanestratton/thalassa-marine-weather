import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { createLogger } from '../utils/createLogger';
const log = createLogger('DiaryPage');
import { DiaryService, DiaryEntry, DiaryMood, DiaryWeatherData } from '../services/DiaryService';
import { triggerHaptic } from '../utils/system';
import { Capacitor } from '@capacitor/core';
import { SlideToAction } from './ui/SlideToAction';
import { AnchorWatchService } from '../services/AnchorWatchService';
import { useWeather } from '../context/WeatherContext';
import { useSettings } from '../context/SettingsContext';
import { PageHeader } from './ui/PageHeader';
import { UndoToast } from './ui/UndoToast';
import { SwipeableDiaryCard } from './diary/SwipeableDiaryCard';
import { toast } from './Toast';
import { DiaryEntryView } from './diary/DiaryEntryView';
import { DiaryComposeForm } from './diary/DiaryComposeForm';
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
        uploading,
        lat,
        lon,
        locationName,
        weatherSummary,
        saving,
        polishing,
        gpsLoading,
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
    const [polishIntensity, _setPolishIntensity] = useState(30); // 0=clean grammar, 100=shakespearean
    // Weather context
    const { weatherData } = useWeather();
    const { settings } = useSettings();
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
        // eslint-disable-next-line react-hooks/exhaustive-deps
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
        // eslint-disable-next-line react-hooks/exhaustive-deps
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
        // eslint-disable-next-line react-hooks/exhaustive-deps
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
        // eslint-disable-next-line react-hooks/exhaustive-deps
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
        grabGps();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [grabGps, buildWeatherSnapshot, buildWeatherData, dispatch]);
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
                weather_data: state.weatherDataObj,
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
    const grouped = useMemo(() => groupByDate(entries), [entries]);
    // ── PDF Export ───────────────────────────────────────────────
    const exportDiaryPdf = useCallback(async (entriesToPrint: DiaryEntry[]) => {
        setExportProgress('Preparing...');
        const { generateDiaryPDF } = await import('../utils/diaryExport');
        generateDiaryPDF(
            entriesToPrint,
            {
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
            },
            settings.firstName || undefined,
        );
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
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
                lat={lat}
                lon={lon}
                locationName={locationName}
                keyboardHeight={keyboardHeight}
                saving={saving}
                uploading={uploading}
                polishing={polishing}
                gpsLoading={gpsLoading}
                isRecording={isRecording}
                recordingTime={recordingTime}
                transcribing={transcribing}
                isPlaying={isPlaying}
                onSetTitle={setTitle}
                onSetBody={setBody}
                onSetMood={setMood}
                onSetLocationName={setLocationName}
                onSave={handleSave}
                onCancel={() => {
                    setShowCompose(false);
                    setEditingId(null);
                }}
                onGrabGps={grabGps}
                onStartRecording={startRecording}
                onStopRecording={stopRecording}
                onRemoveAudio={removeAudio}
                onTogglePlayback={togglePlayback}
                onTranscribe={handleTranscribe}
                onPolish={handlePolish}
                onPhotoSelect={handlePhotoSelect}
                onPhotoRemove={removePhoto}
            />
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
                        <p className="text-label text-gray-400 font-bold uppercase tracking-widest">
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
                                                aria-label="Menu"
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
                                                aria-label="Menu"
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
                                                        aria-label="Selected Ids"
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
});
