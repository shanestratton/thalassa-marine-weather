/**
 * DiaryPage — Captain's Journal
 *
 * Premium passage diary with:
 *   - Timeline view of entries with photos, GPS, mood
 *   - Full-screen compose/edit with photo attachment + GPS
 *   - 🎙️ Voice recorder — record audio memos, transcribe later
 *   - Gemini AI "polish" button for journal text
 *   - Mood selector with nautical emojis
 *   - Beautiful card-based timeline
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { DiaryService, DiaryEntry, DiaryMood, MOOD_CONFIG } from '../services/DiaryService';
import { triggerHaptic } from '../utils/system';
import { SlideToAction } from './ui/SlideToAction';
import { generateDiaryPDF } from '../utils/diaryExport';
import { AnchorWatchService } from '../services/AnchorWatchService';
import { useWeather } from '../context/WeatherContext';
import { PageHeader } from './ui/PageHeader';

interface DiaryPageProps {
    onBack: () => void;
}

// ── Helpers ─────────────────────────────────────────────────────

const formatDate = (iso: string): string => {
    const d = new Date(iso);
    return d.toLocaleDateString('en-AU', {
        weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
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
    const [entries, setEntries] = useState<DiaryEntry[]>([]);
    const [loading, setLoading] = useState(true);
    const [showCompose, setShowCompose] = useState(false);
    const [selectedEntry, setSelectedEntry] = useState<DiaryEntry | null>(null);

    // Weather context
    const { weatherData } = useWeather();

    // Compose state
    const [editingId, setEditingId] = useState<string | null>(null);
    const [title, setTitle] = useState('');
    const [body, setBody] = useState('');
    const [mood, setMood] = useState<DiaryMood>('good');
    const [photos, setPhotos] = useState<string[]>([]);
    const [audioUrl, setAudioUrl] = useState<string | null>(null);
    const [uploading, setUploading] = useState(false);
    const [lat, setLat] = useState<number | null>(null);
    const [lon, setLon] = useState<number | null>(null);
    const [locationName, setLocationName] = useState('');
    const [weatherSummary, setWeatherSummary] = useState('');
    const [saving, setSaving] = useState(false);
    const [polishing, setPolishing] = useState(false);
    const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
    const [gpsLoading, setGpsLoading] = useState(false);

    // Timeline selection state
    const [selectMode, setSelectMode] = useState(false);
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
    const [menuOpen, setMenuOpen] = useState(false);
    const [exportProgress, setExportProgress] = useState<string | null>(null);
    const menuRef = useRef<HTMLDivElement>(null);

    // Audio recording state
    const [isRecording, setIsRecording] = useState(false);
    const [recordingTime, setRecordingTime] = useState(0);
    const [transcribing, setTranscribing] = useState(false);
    const mediaRecorderRef = useRef<MediaRecorder | null>(null);
    const audioChunksRef = useRef<Blob[]>([]);
    const recordingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

    // Playback state
    const [isPlaying, setIsPlaying] = useState(false);
    const audioPlayerRef = useRef<HTMLAudioElement | null>(null);

    const fileRef = useRef<HTMLInputElement>(null);

    // ── Load entries ───────────────────────────────────────────

    useEffect(() => {
        DiaryService.getEntries(100).then(data => {
            setEntries(data);
            setLoading(false);
        });
    }, []);

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            if (recordingTimerRef.current) clearInterval(recordingTimerRef.current);
            if (mediaRecorderRef.current?.state === 'recording') mediaRecorderRef.current.stop();
            if (audioPlayerRef.current) { audioPlayerRef.current.pause(); audioPlayerRef.current = null; }
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
        if (c.waveHeight != null && c.waveHeight > 0) parts.push(`Waves ${c.waveHeight.toFixed(1)}m`);
        else if (c.description) parts.push(c.description);
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

    const openEdit = useCallback((entry: DiaryEntry) => {
        setEditingId(entry.id);
        setTitle(entry.title);
        setBody(entry.body);
        setMood(entry.mood);
        setPhotos(entry.photos || []);
        setAudioUrl(entry.audio_url || null);
        setLat(entry.latitude);
        setLon(entry.longitude);
        setLocationName(entry.location_name || (entry.latitude && entry.longitude ? formatCoord(entry.latitude, entry.longitude) : ''));
        setSelectedEntry(null);
        setShowCompose(true);
        triggerHaptic('light');
    }, []);

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
                stream.getTracks().forEach(t => t.stop());

                const blob = new Blob(audioChunksRef.current, { type: recordedMime });
                if (blob.size > 0) {
                    const url = await DiaryService.uploadAudio(blob);
                    setAudioUrl(url);

                    // Auto-transcribe voice memo to text
                    if (url) {
                        setTranscribing(true);
                        const text = await DiaryService.transcribeAudio(url, recordedMime);
                        if (text) {
                            setBody(prev => prev ? `${prev}\n\n${text}` : text);
                        }
                        setTranscribing(false);
                    }
                }
                if (recordingTimerRef.current) clearInterval(recordingTimerRef.current);
            };

            mediaRecorder.start(250); // Collect data every 250ms
            setIsRecording(true);
            setRecordingTime(0);
            triggerHaptic('medium');

            // Timer
            recordingTimerRef.current = setInterval(() => {
                setRecordingTime(prev => prev + 1);
            }, 1000);
        } catch (err) {
            console.error('[Diary] Mic access denied:', err);
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
            setBody(prev => prev ? `${prev}\n\n${text}` : text);
        }
        setTranscribing(false);
    };

    // ── Photo handling ─────────────────────────────────────────

    const handlePhotoSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        setUploading(true);
        const url = await DiaryService.uploadPhoto(file);
        if (url) setPhotos(prev => [...prev, url]);
        setUploading(false);
        if (fileRef.current) fileRef.current.value = '';
    };

    const removePhoto = (idx: number) => {
        setPhotos(prev => prev.filter((_, i) => i !== idx));
    };

    // ── Gemini polish ──────────────────────────────────────────

    const handlePolish = async () => {
        if (!body.trim() || polishing) return;
        setPolishing(true);
        triggerHaptic('light');
        const enhanced = await DiaryService.enhanceWithGemini(body, { mood, location: locationName });
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
                setEntries(prev => prev.map(e =>
                    e.id === editingId
                        ? { ...e, title: title.trim() || e.title, body: body.trim(), mood, photos, audio_url: audioUrl }
                        : e
                ));
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
                setEntries(prev => [entry, ...prev]);
                setShowCompose(false);
            }
        }
        setSaving(false);
    };

    // ── Delete ─────────────────────────────────────────────────

    const handleDelete = async (id: string) => {
        const ok = await DiaryService.deleteEntry(id);
        if (ok) {
            setEntries(prev => prev.filter(e => e.id !== id));
            setSelectedEntry(null);
            setDeleteConfirm(null);
        }
    };

    // ── Grouped entries ────────────────────────────────────────

    const grouped = groupByDate(entries);

    // ── PDF Export ───────────────────────────────────────────────

    const exportDiaryPdf = useCallback((entriesToPrint: DiaryEntry[]) => {
        setExportProgress('Preparing...');
        generateDiaryPDF(entriesToPrint, {
            onProgress: (msg) => setExportProgress(msg),
            onSuccess: () => {
                setExportProgress(null);
                setSelectMode(false);
                setSelectedIds(new Set());
            },
            onError: (err) => {
                setExportProgress(null);
                console.error('Diary PDF export error:', err);
            }
        });
    }, []);

    const toggleEntrySelection = useCallback((id: string) => {
        setSelectedIds(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }, []);

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
                            <svg className="w-4 h-4 text-red-400/60" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                            </svg>
                        </button>
                    )}
                </div>
            </div>
        </div>
    );

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
                        <button onClick={() => setSelectedEntry(null)} className="p-2 rounded-xl bg-white/5 hover:bg-white/10 transition-colors">
                            <svg className="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
                            </svg>
                        </button>
                        <div className="flex-1 min-w-0">
                            <h1 className="text-lg font-extrabold text-white truncate">{e.title}</h1>
                        </div>
                        <button onClick={() => openEdit(e)} className="p-2 rounded-xl bg-white/5 hover:bg-white/10 transition-colors">
                            <svg className="w-5 h-5 text-sky-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10" />
                            </svg>
                        </button>
                        <button onClick={() => setDeleteConfirm(e.id)} className="p-2 rounded-xl bg-white/5 hover:bg-white/10 transition-colors">
                            <svg className="w-5 h-5 text-red-400/60" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
                            </svg>
                        </button>
                    </div>
                </div>

                {/* Content */}
                <div className="flex-1 overflow-y-auto">
                    {e.photos.length > 0 && (
                        <div className="flex gap-1 overflow-x-auto snap-x snap-mandatory">
                            {e.photos.map((url, i) => (
                                <img key={i} src={url} alt="" className="w-full h-56 object-cover snap-center shrink-0" />
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
                                        <svg className="w-4 h-4 text-sky-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                                            <path strokeLinecap="round" strokeLinejoin="round" d="M15 10.5a3 3 0 11-6 0 3 3 0 016 0z" />
                                            <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1115 0z" />
                                        </svg>
                                    </div>
                                    <div className="flex-1">
                                        <p className="text-[11px] font-bold text-sky-400/60 uppercase tracking-wider">Position</p>
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
                                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 10.5a3 3 0 11-6 0 3 3 0 016 0z" />
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1115 0z" />
                                </svg>
                                <span className="font-medium">{e.location_name}</span>
                            </div>
                        )}

                        {/* Voice Memo */}
                        {e.audio_url && (
                            <AudioWidget url={e.audio_url} allowTranscribe={true} />
                        )}

                        {/* Weather */}
                        {e.weather_summary && (
                            <div className="text-xs text-gray-500 italic bg-white/[0.03] rounded-xl p-3 border border-white/5">
                                🌤 {e.weather_summary}
                            </div>
                        )}

                        {/* Body */}
                        {e.body && (
                            <div className="text-sm text-gray-200 leading-relaxed whitespace-pre-wrap">
                                {e.body}
                            </div>
                        )}

                        {/* Tags */}
                        {e.tags.length > 0 && (
                            <div className="flex flex-wrap gap-2 pt-2">
                                {e.tags.map(tag => (
                                    <span key={tag} className="text-[11px] font-bold text-sky-400/60 bg-sky-500/10 px-2 py-1 rounded-full uppercase tracking-wider">
                                        #{tag}
                                    </span>
                                ))}
                            </div>
                        )}

                        {e._offline && (
                            <div className="flex items-center gap-2 text-[11px] text-amber-400/70 bg-amber-500/10 rounded-lg px-3 py-2 border border-amber-500/10">
                                <span>⏳</span>
                                <span className="font-bold uppercase tracking-wider">Pending sync — will upload when online</span>
                            </div>
                        )}
                    </div>
                </div>

                {/* Delete confirm */}
                {deleteConfirm && (
                    <div className="absolute inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-8">
                        <div className="bg-slate-800 border border-white/10 rounded-2xl p-6 max-w-sm w-full space-y-4">
                            <h3 className="text-lg font-black text-white">Delete Entry?</h3>
                            <p className="text-sm text-gray-400">This will permanently delete this journal entry and any attached photos or audio.</p>
                            <div className="flex gap-3">
                                <button onClick={() => setDeleteConfirm(null)} className="flex-1 py-3 rounded-xl bg-white/10 text-white font-bold text-sm">Cancel</button>
                                <button onClick={() => handleDelete(deleteConfirm)} className="flex-1 py-3 rounded-xl bg-red-600 text-white font-bold text-sm">Delete</button>
                            </div>
                        </div>
                    </div>
                )}
            </div>
        );
    }

    // ── Render: Compose / Edit ───────────────────────────────────

    if (showCompose) {
        const isEditing = !!editingId;
        return (
            <div className="flex flex-col h-full bg-slate-950 text-white" style={{ paddingBottom: 'calc(4rem + env(safe-area-inset-bottom) + 8px)' }}>
                {/* Header */}
                <div className="shrink-0 px-4 pt-4 pb-3">
                    <div className="flex items-center gap-3">
                        <button onClick={() => { setShowCompose(false); setEditingId(null); }} className="p-2 rounded-xl bg-white/5 hover:bg-white/10 transition-colors">
                            <svg className="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                            </svg>
                        </button>
                        <div className="flex-1">
                            <h1 className="text-xl font-extrabold text-white uppercase tracking-wider">{isEditing ? 'Edit Entry' : 'New Entry'}</h1>
                        </div>
                        <button
                            onClick={handleSave}
                            disabled={saving || (!body.trim() && !title.trim() && !audioUrl)}
                            className="px-4 py-2 bg-sky-600 hover:bg-sky-500 disabled:bg-gray-700 disabled:text-gray-500 text-white font-bold text-sm rounded-xl transition-colors"
                        >
                            {saving ? 'Saving…' : isEditing ? 'Update' : 'Save'}
                        </button>
                    </div>
                </div>

                {/* Compose body — flex column fills viewport, no scroll */}
                <div className="flex-1 flex flex-col p-4 gap-3 min-h-0 overflow-hidden">
                    {/* Title */}
                    <input
                        type="text"
                        placeholder="Entry title (optional)"
                        value={title}
                        onChange={e => setTitle(e.target.value)}
                        className="shrink-0 w-full bg-transparent text-xl font-bold text-white placeholder-gray-600 border-none outline-none"
                    />

                    {/* Mood selector */}
                    <div className="shrink-0 flex items-center gap-1">
                        {(Object.entries(MOOD_CONFIG) as [DiaryMood, typeof MOOD_CONFIG.epic][]).map(([key, cfg]) => (
                            <button
                                key={key}
                                onClick={() => { setMood(key); triggerHaptic('light'); }}
                                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold transition-all ${mood === key
                                    ? 'bg-white/15 border border-white/20 scale-105'
                                    : 'bg-white/5 border border-transparent opacity-50 hover:opacity-80'
                                    }`}
                            >
                                <span>{cfg.emoji}</span>
                                <span className={cfg.color}>{cfg.label}</span>
                            </button>
                        ))}
                    </div>

                    {/* GPS Position */}
                    <div className="shrink-0 bg-gradient-to-r from-sky-500/10 to-sky-500/10 border border-sky-500/15 rounded-xl p-3">
                        <div className="flex items-center gap-2.5">
                            <div className="p-2 bg-sky-500/15 rounded-lg">
                                <svg className="w-4 h-4 text-sky-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 10.5a3 3 0 11-6 0 3 3 0 016 0z" />
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1115 0z" />
                                </svg>
                            </div>
                            <div className="flex-1 min-w-0">
                                <p className="text-[11px] font-bold text-sky-400/60 uppercase tracking-wider">Position</p>
                                {lat != null && lon != null ? (
                                    <p className="text-sm font-bold text-white font-mono tracking-wide">{formatCoord(lat, lon)}</p>
                                ) : (
                                    <p className="text-xs text-gray-500 italic">{gpsLoading ? 'Acquiring GPS fix…' : 'No position — tap refresh'}</p>
                                )}
                            </div>
                            <button onClick={grabGps} disabled={gpsLoading} className="relative z-10 p-2 rounded-lg bg-white/5 hover:bg-white/10 transition-colors disabled:opacity-40 cursor-pointer" title="Refresh GPS">
                                <svg className={`w-4 h-4 text-sky-400 ${gpsLoading ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182M2.985 19.644l3.181-3.182" />
                                </svg>
                            </button>
                        </div>
                        <div className="mt-2">
                            <input
                                type="text"
                                placeholder="Location name (e.g. Moreton Bay, Anchor in 4m)"
                                value={locationName}
                                onChange={e => setLocationName(e.target.value)}
                                className="w-full bg-white/5 border border-white/5 rounded-lg px-3 py-2 text-xs text-gray-300 placeholder-gray-600 outline-none focus:border-sky-500/30 transition-colors"
                            />
                        </div>
                    </div>

                    {/* ═══ VOICE TO TEXT ═══ */}
                    <div className="shrink-0">
                        <div className="flex items-center gap-2 mb-2">
                            <span className="text-xs font-bold text-gray-500 uppercase tracking-wider">Voice to Text</span>
                            <span className="text-[11px] text-gray-600">Dictate or type below</span>
                        </div>

                        {isRecording ? (
                            /* Active recording UI */
                            <div className="bg-gradient-to-r from-red-500/15 to-amber-500/15 border border-red-500/20 rounded-xl p-4">
                                <div className="flex items-center gap-4">
                                    <button
                                        onClick={stopRecording}
                                        className="p-3 bg-red-500 rounded-full shadow-lg shadow-red-500/30 hover:bg-red-400 transition-colors active:scale-95"
                                    >
                                        <svg className="w-6 h-6 text-white" fill="currentColor" viewBox="0 0 24 24">
                                            <rect x="6" y="6" width="12" height="12" rx="2" />
                                        </svg>
                                    </button>
                                    <div className="flex-1">
                                        <p className="text-sm font-bold text-red-400 animate-pulse">● Recording…</p>
                                        <p className="text-xl font-mono font-bold text-white">{formatDuration(recordingTime)}</p>
                                    </div>
                                    {/* Live waveform */}
                                    <div className="flex items-center gap-0.5">
                                        {Array.from({ length: 12 }).map((_, i) => (
                                            <div
                                                key={i}
                                                className="w-1 bg-red-400 rounded-full animate-pulse"
                                                style={{
                                                    height: `${8 + Math.random() * 16}px`,
                                                    animationDelay: `${i * 0.08}s`,
                                                    animationDuration: '0.5s',
                                                }}
                                            />
                                        ))}
                                    </div>
                                </div>
                                <p className="text-[11px] text-red-400/50 mt-2 text-center font-bold uppercase tracking-wider">
                                    Tap stop — your words will appear in the text box below
                                </p>
                            </div>
                        ) : audioUrl ? (
                            /* Recorded audio preview */
                            <AudioWidget url={audioUrl} allowTranscribe={true} allowRemove={true} />
                        ) : (
                            /* Record button */
                            <button
                                onClick={startRecording}
                                className="w-full bg-white/[0.03] border border-white/5 rounded-xl p-4 flex items-center gap-3 hover:bg-emerald-500/5 hover:border-emerald-500/15 transition-all active:scale-[0.98] group"
                            >
                                <div className="p-2.5 bg-emerald-500/15 rounded-full group-hover:bg-emerald-500/25 transition-colors">
                                    <svg className="w-5 h-5 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5a3 3 0 116 0v8.25a3 3 0 01-3 3z" />
                                    </svg>
                                </div>
                                <div className="text-left flex-1">
                                    <p className="text-sm font-bold text-white">Record Voice to Text</p>
                                    <p className="text-[11px] text-gray-500">Speak — your words fill the entry below</p>
                                </div>
                                <svg className="w-4 h-4 text-gray-600 group-hover:text-emerald-400 transition-colors" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
                                </svg>
                            </button>
                        )}
                    </div>

                    {/* Body text — fills remaining space */}
                    <textarea
                        placeholder={"What's happening out there, skipper?\n\nDescribe the conditions, the crew mood, the sunset over the bow…"}
                        value={body}
                        onChange={e => setBody(e.target.value)}
                        className="w-full flex-1 min-h-0 bg-white/[0.03] border border-white/5 rounded-2xl p-4 text-sm text-gray-200 placeholder-gray-600 leading-relaxed resize-none outline-none focus:border-sky-500/30 transition-colors"
                    />

                    {/* AI Polish + Weather Snapshot */}
                    <div className="shrink-0 flex flex-wrap gap-2">
                        {body.trim().length > 10 && (
                            <button
                                onClick={handlePolish}
                                disabled={polishing}
                                className="flex items-center gap-2 px-3 py-2 bg-gradient-to-r from-purple-500/20 to-purple-500/20 border border-purple-500/20 rounded-xl text-xs font-bold text-purple-300 hover:from-purple-500/30 hover:to-purple-500/30 transition-all disabled:opacity-50"
                            >
                                <span className="text-sm">{polishing ? '⏳' : '✨'}</span>
                                {polishing ? 'Polishing…' : 'Polish with Gemini'}
                            </button>
                        )}
                        {transcribing && (
                            <div className="flex items-center gap-2 px-3 py-2 bg-emerald-500/10 border border-emerald-500/15 rounded-xl">
                                <span className="text-sm animate-pulse">🎙️</span>
                                <span className="text-xs font-bold text-emerald-400">Converting speech to text…</span>
                            </div>
                        )}
                    </div>

                    {/* Weather Snapshot */}
                    {weatherSummary && (
                        <div className="shrink-0 flex items-center gap-2 px-3 py-2 bg-amber-500/10 border border-amber-500/15 rounded-xl">
                            <span className="text-sm">🌤</span>
                            <input
                                type="text"
                                value={weatherSummary}
                                onChange={e => setWeatherSummary(e.target.value)}
                                className="flex-1 bg-transparent text-xs text-amber-200/90 font-medium outline-none placeholder-amber-600"
                                placeholder="Weather conditions"
                            />
                        </div>
                    )}

                    {/* Photos */}
                    <div className="shrink-0">
                        <div className="flex items-center gap-2 mb-2">
                            <span className="text-xs font-bold text-gray-500 uppercase tracking-wider">Photos</span>
                            {photos.length > 0 && (
                                <span className="text-[11px] text-gray-600 bg-white/5 px-1.5 py-0.5 rounded-full">{photos.length}/6</span>
                            )}
                        </div>
                        <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(56px, 1fr))' }}>
                            {photos.map((url, i) => (
                                <div key={i} className="relative aspect-square rounded-xl overflow-hidden group">
                                    <img src={url} alt="" className="w-full h-full object-cover" />
                                    <button onClick={() => removePhoto(i)} className="absolute top-1 right-1 w-5 h-5 bg-black/60 rounded-full flex items-center justify-center text-white text-[11px] opacity-0 group-hover:opacity-100 transition-opacity">✕</button>
                                </div>
                            ))}
                            {/* Fill remaining slots with Add buttons */}
                            {Array.from({ length: Math.max(1, 6 - photos.length) }).map((_, i) => (
                                <button
                                    key={`add-${i}`}
                                    onClick={() => fileRef.current?.click()}
                                    disabled={uploading || photos.length >= 6}
                                    className="aspect-square rounded-xl border-2 border-dashed border-white/10 hover:border-sky-500/30 flex flex-col items-center justify-center gap-0.5 text-gray-600 hover:text-sky-400 transition-colors disabled:opacity-30"
                                >
                                    {uploading && i === 0 ? (
                                        <span className="text-xs animate-pulse">📷</span>
                                    ) : (
                                        <>
                                            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                                                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                                            </svg>
                                        </>
                                    )}
                                </button>
                            ))}
                        </div>
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
                <div className="absolute inset-0 bg-black/70 backdrop-blur-sm flex flex-col items-center justify-center z-50 gap-4">
                    <div className="w-10 h-10 border-2 border-sky-500 border-t-transparent rounded-full animate-spin" />
                    <p className="text-sm font-bold text-white">{exportProgress}</p>
                </div>
            )}
            <div className="flex flex-col h-full">
                <PageHeader
                    title="Diary"
                    onBack={onBack}
                    breadcrumbs={['Ship\'s Office', 'Diary']}
                    subtitle={selectMode ? `${selectedIds.size} Selected` : `${entries.length} ${entries.length === 1 ? 'Entry' : 'Entries'}`}
                    action={selectMode ? (
                        <button onClick={exitSelectMode} className="px-3 py-1.5 rounded-xl bg-white/10 text-xs font-bold text-white min-h-[44px]">
                            Done
                        </button>
                    ) : entries.length > 0 ? (
                        <div className="relative" ref={menuRef}>
                            <button
                                onClick={() => setMenuOpen(!menuOpen)}
                                className="p-2 rounded-xl bg-white/5 hover:bg-white/10 transition-colors min-w-[44px] min-h-[44px] flex items-center justify-center"
                            >
                                <svg className="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.75a.75.75 0 110-1.5.75.75 0 010 1.5zM12 12.75a.75.75 0 110-1.5.75.75 0 010 1.5zM12 18.75a.75.75 0 110-1.5.75.75 0 010 1.5z" />
                                </svg>
                            </button>
                            {menuOpen && (
                                <>
                                    <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
                                    <div className="absolute right-0 top-full mt-1 z-50 w-52 bg-slate-800 border border-white/10 rounded-xl shadow-2xl overflow-hidden">
                                        <button
                                            onClick={() => { setSelectMode(true); setSelectedIds(new Set()); setMenuOpen(false); }}
                                            className="w-full text-left px-4 py-3 text-sm text-white hover:bg-white/5 transition-colors flex items-center gap-3"
                                        >
                                            <svg className="w-4 h-4 text-sky-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                                                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                                            </svg>
                                            Select for Export
                                        </button>
                                        <button
                                            onClick={() => { exportDiaryPdf(entries); setMenuOpen(false); }}
                                            className="w-full text-left px-4 py-3 text-sm text-white hover:bg-white/5 transition-colors flex items-center gap-3 border-t border-white/5"
                                        >
                                            <svg className="w-4 h-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                                                <path strokeLinecap="round" strokeLinejoin="round" d="M6.72 13.829c-.24.03-.48.062-.72.096m.72-.096a42.415 42.415 0 0110.56 0m-10.56 0L6.34 18m10.94-4.171c.24.03.48.062.72.096m-.72-.096L17.66 18m0 0l.229 2.523a1.125 1.125 0 01-1.12 1.227H7.231c-.662 0-1.18-.568-1.12-1.227L6.34 18m11.318 0h1.091A2.25 2.25 0 0021 15.75V9.456c0-1.081-.768-2.015-1.837-2.175a48.055 48.055 0 00-1.913-.247M6.34 18H5.25A2.25 2.25 0 013 15.75V9.456c0-1.081.768-2.015 1.837-2.175a48.041 48.041 0 011.913-.247m10.5 0a48.536 48.536 0 00-10.5 0m10.5 0V3.375c0-.621-.504-1.125-1.125-1.125h-8.25c-.621 0-1.125.504-1.125 1.125v3.659M18.25 7.034H5.75" />
                                            </svg>
                                            Export All to PDF
                                        </button>
                                    </div>
                                </>
                            )}
                        </div>
                    ) : undefined}
                />

                {/* Content */}
                <div className="flex-1 overflow-y-auto px-4 min-h-0" style={{ paddingBottom: '4px' }}>
                    {loading ? (
                        <div className="flex items-center justify-center py-12">
                            <div className="w-8 h-8 border-2 border-sky-500 border-t-transparent rounded-full animate-spin" />
                        </div>
                    ) : entries.length === 0 ? (
                        <div className="flex-1 flex flex-col items-center justify-center text-slate-400 px-6 py-16">
                            <div className="relative w-20 h-20 mb-5">
                                <svg viewBox="0 0 96 96" fill="none" className="w-full h-full text-sky-500/30">
                                    <circle cx="48" cy="48" r="44" stroke="currentColor" strokeWidth="1.5" strokeDasharray="4 4" />
                                    <circle cx="48" cy="48" r="6" fill="currentColor" fillOpacity="0.3" />
                                    <path d="M48 8L52 44H44L48 8Z" fill="currentColor" fillOpacity="0.6" />
                                    <path d="M48 88L44 52H52L48 88Z" fill="currentColor" fillOpacity="0.3" />
                                </svg>
                            </div>
                            <p className="text-base font-bold text-white mb-1">Your Story Starts Here</p>
                            <p className="text-sm text-white/50 max-w-[240px] text-center">Slide below to write your first journal entry. Add photos, voice memos, and GPS coordinates.</p>
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

                                    <div className="space-y-3 ml-4 border-l border-white/5 pl-4">
                                        {dayEntries.map(entry => {
                                            const moodCfg = MOOD_CONFIG[entry.mood] || MOOD_CONFIG.neutral;
                                            const entryHasCoords = entry.latitude != null && entry.longitude != null;
                                            return (
                                                <button
                                                    key={entry.id}
                                                    onClick={() => {
                                                        if (selectMode) {
                                                            toggleEntrySelection(entry.id);
                                                        } else {
                                                            setSelectedEntry(entry);
                                                            triggerHaptic('light');
                                                        }
                                                    }}
                                                    className={`relative w-full text-left bg-white/[0.03] border rounded-2xl overflow-hidden hover:bg-white/[0.05] transition-all active:scale-[0.98] group ${selectMode && selectedIds.has(entry.id) ? 'border-sky-500/50 !bg-sky-500/5' : 'border-white/5 hover:border-white/10'}`}
                                                >
                                                    {/* Selection indicator */}
                                                    {selectMode && (
                                                        <div className="absolute top-3 right-3 z-10">
                                                            <div className={`w-6 h-6 rounded-full border-2 flex items-center justify-center transition-all ${selectedIds.has(entry.id) ? 'bg-sky-500 border-sky-500' : 'border-white/20 bg-black/30'}`}>
                                                                {selectedIds.has(entry.id) && (
                                                                    <svg className="w-3.5 h-3.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                                                                        <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                                                                    </svg>
                                                                )}
                                                            </div>
                                                        </div>
                                                    )}
                                                    {entry.photos.length > 0 && (
                                                        <div className="flex h-28 overflow-hidden">
                                                            {entry.photos.slice(0, 3).map((url, i) => (
                                                                <img key={i} src={url} alt="" className={`h-full object-cover ${entry.photos.length === 1 ? 'w-full' : entry.photos.length === 2 ? 'w-1/2' : 'w-1/3'}`} />
                                                            ))}
                                                            {entry.photos.length > 3 && (
                                                                <div className="w-1/3 h-full bg-black/50 flex items-center justify-center">
                                                                    <span className="text-white/60 text-sm font-bold">+{entry.photos.length - 3}</span>
                                                                </div>
                                                            )}
                                                        </div>
                                                    )}

                                                    <div className="p-4">
                                                        <div className="flex items-start justify-between gap-2">
                                                            <div className="flex-1 min-w-0">
                                                                <div className="flex items-center gap-2 mb-1">
                                                                    <span className="text-sm">{moodCfg.emoji}</span>
                                                                    <h4 className="text-sm font-bold text-white truncate">{entry.title}</h4>
                                                                    {entry.audio_url && <span className="text-[11px] text-emerald-400 bg-emerald-500/15 px-1.5 py-0.5 rounded-full font-bold">🎙️</span>}
                                                                    {entry._offline && <span className="text-[11px] text-amber-400 bg-amber-500/15 px-1.5 py-0.5 rounded-full font-bold">PENDING</span>}
                                                                </div>
                                                                <p className="text-xs text-gray-400 line-clamp-2 leading-relaxed">
                                                                    {entry.body || (entry.audio_url ? 'Voice memo attached' : '')}
                                                                </p>
                                                            </div>
                                                            <span className="text-[11px] text-gray-600 font-mono shrink-0 mt-0.5">
                                                                {formatTime(entry.created_at)}
                                                            </span>
                                                        </div>

                                                        {entryHasCoords && (
                                                            <div className="flex items-center gap-1.5 mt-2 text-[11px] text-sky-500/60">
                                                                <svg className="w-3 h-3 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                                                                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 10.5a3 3 0 11-6 0 3 3 0 016 0z" />
                                                                    <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1115 0z" />
                                                                </svg>
                                                                <span className="font-mono font-medium">{formatCoord(entry.latitude!, entry.longitude!)}</span>
                                                                {entry.location_name && !entry.location_name.includes('°') && (
                                                                    <span className="text-gray-600 truncate">— {entry.location_name}</span>
                                                                )}
                                                            </div>
                                                        )}
                                                        {!entryHasCoords && entry.location_name && (
                                                            <div className="flex items-center gap-1.5 mt-2 text-[11px] text-sky-500/50">
                                                                <svg className="w-3 h-3 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                                                                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 10.5a3 3 0 11-6 0 3 3 0 016 0z" />
                                                                    <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1115 0z" />
                                                                </svg>
                                                                <span className="font-medium truncate">{entry.location_name}</span>
                                                            </div>
                                                        )}
                                                    </div>
                                                </button>
                                            );
                                        })}
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                {/* ── Bottom bar: select mode export OR slide-to-action ── */}
                <div className="shrink-0 px-4" style={{ paddingBottom: 'calc(4rem + env(safe-area-inset-bottom) + 8px)' }}>
                    {selectMode ? (
                        <div className="flex items-center gap-3">
                            <button
                                onClick={() => {
                                    const sel = entries.filter(e => selectedIds.has(e.id));
                                    if (sel.length > 0) exportDiaryPdf(sel);
                                }}
                                disabled={selectedIds.size === 0}
                                className="flex-1 py-3 rounded-xl bg-sky-600 hover:bg-sky-500 disabled:bg-gray-700 disabled:text-gray-500 text-white font-bold text-sm transition-colors flex items-center justify-center gap-2"
                            >
                                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M6.72 13.829c-.24.03-.48.062-.72.096m.72-.096a42.415 42.415 0 0110.56 0m-10.56 0L6.34 18m10.94-4.171c.24.03.48.062.72.096m-.72-.096L17.66 18m0 0l.229 2.523a1.125 1.125 0 01-1.12 1.227H7.231c-.662 0-1.18-.568-1.12-1.227L6.34 18m11.318 0h1.091A2.25 2.25 0 0021 15.75V9.456c0-1.081-.768-2.015-1.837-2.175a48.055 48.055 0 00-1.913-.247M6.34 18H5.25A2.25 2.25 0 013 15.75V9.456c0-1.081.768-2.015 1.837-2.175a48.041 48.041 0 011.913-.247m10.5 0a48.536 48.536 0 00-10.5 0m10.5 0V3.375c0-.621-.504-1.125-1.125-1.125h-8.25c-.621 0-1.125.504-1.125 1.125v3.659M18.25 7.034H5.75" />
                                </svg>
                                Export {selectedIds.size > 0 ? `${selectedIds.size} Selected` : 'Selected'}
                            </button>
                            <button
                                onClick={() => setSelectedIds(new Set(entries.map(e => e.id)))}
                                className="py-3 px-4 rounded-xl bg-white/5 text-white font-bold text-xs transition-colors"
                            >
                                All
                            </button>
                        </div>
                    ) : (
                        <SlideToAction
                            label="Slide to Write Entry"
                            thumbIcon={
                                <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                                </svg>
                            }
                            onConfirm={() => {
                                triggerHaptic('medium');
                                openCompose();
                            }}
                            theme="sky"
                        />
                    )}
                </div>
            </div>
        </div>
    );
};
