/**
 * DiaryPage — Captain's Journal
 *
 * Premium passage diary with:
 *   - Timeline view of entries with photos, GPS, mood
 *   - Full-screen compose with photo attachment + GPS
 *   - Gemini AI "polish" button for journal text
 *   - Mood selector with nautical emojis
 *   - Beautiful card-based timeline
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { DiaryService, DiaryEntry, DiaryMood, MOOD_CONFIG } from '../services/DiaryService';
import { triggerHaptic } from '../utils/system';

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

    // Compose state
    const [title, setTitle] = useState('');
    const [body, setBody] = useState('');
    const [mood, setMood] = useState<DiaryMood>('good');
    const [photos, setPhotos] = useState<string[]>([]);
    const [uploading, setUploading] = useState(false);
    const [lat, setLat] = useState<number | null>(null);
    const [lon, setLon] = useState<number | null>(null);
    const [locationName, setLocationName] = useState('');
    const [saving, setSaving] = useState(false);
    const [polishing, setPolishing] = useState(false);
    const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

    const fileRef = useRef<HTMLInputElement>(null);
    const bodyRef = useRef<HTMLTextAreaElement>(null);

    // ── Load entries ───────────────────────────────────────────

    useEffect(() => {
        DiaryService.getEntries(100).then(data => {
            setEntries(data);
            setLoading(false);
        });
    }, []);

    // ── Compose ────────────────────────────────────────────────

    const openCompose = useCallback(async () => {
        setTitle('');
        setBody('');
        setMood('good');
        setPhotos([]);
        setLocationName('');
        setShowCompose(true);
        triggerHaptic('light');

        // Auto-grab GPS
        const loc = await DiaryService.getCurrentLocation();
        if (loc) {
            setLat(loc.lat);
            setLon(loc.lon);
            setLocationName(`${loc.lat.toFixed(4)}°, ${loc.lon.toFixed(4)}°`);
        }
    }, []);

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

    const handlePolish = async () => {
        if (!body.trim() || polishing) return;
        setPolishing(true);
        triggerHaptic('light');
        const enhanced = await DiaryService.enhanceWithGemini(body, {
            mood,
            location: locationName,
        });
        if (enhanced) setBody(enhanced);
        setPolishing(false);
    };

    const handleSave = async () => {
        if (!body.trim() && !title.trim()) return;
        setSaving(true);
        triggerHaptic('medium');

        const entry = await DiaryService.createEntry({
            title: title.trim() || formatDate(new Date().toISOString()),
            body: body.trim(),
            mood,
            photos,
            latitude: lat,
            longitude: lon,
            location_name: locationName,
            tags: [],
        });

        if (entry) {
            setEntries(prev => [entry, ...prev]);
            setShowCompose(false);
        }
        setSaving(false);
    };

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

    // ── Render: Full Entry View ─────────────────────────────────

    if (selectedEntry) {
        const e = selectedEntry;
        const moodCfg = MOOD_CONFIG[e.mood] || MOOD_CONFIG.neutral;
        return (
            <div className="flex flex-col h-full bg-slate-900 text-white">
                {/* Header */}
                <div className="flex items-center gap-2 px-4 pt-[max(1rem,env(safe-area-inset-top))] pb-3 bg-slate-900/95 backdrop-blur-xl border-b border-white/5 shrink-0">
                    <button onClick={() => setSelectedEntry(null)} className="p-2 -ml-2 rounded-full hover:bg-white/10 active:bg-white/20 transition-colors">
                        <svg className="w-6 h-6 text-sky-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
                        </svg>
                    </button>
                    <h2 className="text-base font-black text-white flex-1 truncate">{e.title}</h2>
                    <button
                        onClick={() => setDeleteConfirm(e.id)}
                        className="p-2 rounded-full hover:bg-red-500/20 transition-colors"
                    >
                        <svg className="w-5 h-5 text-red-400/60" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
                        </svg>
                    </button>
                </div>

                {/* Content */}
                <div className="flex-1 overflow-y-auto">
                    {/* Photos hero */}
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

                        {/* Location */}
                        {e.location_name && (
                            <div className="flex items-center gap-2 text-xs text-sky-400/70">
                                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 10.5a3 3 0 11-6 0 3 3 0 016 0z" />
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1115 0z" />
                                </svg>
                                <span className="font-medium">{e.location_name}</span>
                                {e.latitude && e.longitude && (
                                    <span className="text-gray-600 font-mono">
                                        ({e.latitude.toFixed(4)}°, {e.longitude.toFixed(4)}°)
                                    </span>
                                )}
                            </div>
                        )}

                        {/* Weather */}
                        {e.weather_summary && (
                            <div className="text-xs text-gray-500 italic bg-white/[0.03] rounded-xl p-3 border border-white/5">
                                🌤 {e.weather_summary}
                            </div>
                        )}

                        {/* Body */}
                        <div className="text-[15px] text-gray-200 leading-relaxed whitespace-pre-wrap">
                            {e.body}
                        </div>

                        {/* Tags */}
                        {e.tags.length > 0 && (
                            <div className="flex flex-wrap gap-2 pt-2">
                                {e.tags.map(tag => (
                                    <span key={tag} className="text-[10px] font-bold text-sky-400/60 bg-sky-500/10 px-2 py-1 rounded-full uppercase tracking-wider">
                                        #{tag}
                                    </span>
                                ))}
                            </div>
                        )}
                    </div>
                </div>

                {/* Delete confirm */}
                {deleteConfirm && (
                    <div className="absolute inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-8">
                        <div className="bg-slate-800 border border-white/10 rounded-2xl p-6 max-w-sm w-full space-y-4">
                            <h3 className="text-lg font-black text-white">Delete Entry?</h3>
                            <p className="text-sm text-gray-400">This will permanently delete this journal entry and any attached photos.</p>
                            <div className="flex gap-3">
                                <button onClick={() => setDeleteConfirm(null)} className="flex-1 py-3 rounded-xl bg-white/10 text-white font-bold text-sm">
                                    Cancel
                                </button>
                                <button onClick={() => handleDelete(deleteConfirm)} className="flex-1 py-3 rounded-xl bg-red-600 text-white font-bold text-sm">
                                    Delete
                                </button>
                            </div>
                        </div>
                    </div>
                )}
            </div>
        );
    }

    // ── Render: Compose ─────────────────────────────────────────

    if (showCompose) {
        return (
            <div className="flex flex-col h-full bg-slate-900 text-white">
                {/* Header */}
                <div className="flex items-center gap-2 px-4 pt-[max(1rem,env(safe-area-inset-top))] pb-3 bg-slate-900/95 backdrop-blur-xl border-b border-white/5 shrink-0">
                    <button onClick={() => setShowCompose(false)} className="p-2 -ml-2 rounded-full hover:bg-white/10 transition-colors">
                        <svg className="w-6 h-6 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                        </svg>
                    </button>
                    <h2 className="text-base font-black text-white flex-1">New Entry</h2>
                    <button
                        onClick={handleSave}
                        disabled={saving || (!body.trim() && !title.trim())}
                        className="px-4 py-2 bg-sky-600 hover:bg-sky-500 disabled:bg-gray-700 disabled:text-gray-500 text-white font-bold text-sm rounded-xl transition-colors"
                    >
                        {saving ? 'Saving…' : 'Save'}
                    </button>
                </div>

                {/* Compose body */}
                <div className="flex-1 overflow-y-auto p-4 space-y-4">
                    {/* Title */}
                    <input
                        type="text"
                        placeholder="Entry title (optional)"
                        value={title}
                        onChange={e => setTitle(e.target.value)}
                        className="w-full bg-transparent text-xl font-bold text-white placeholder-gray-600 border-none outline-none"
                    />

                    {/* Mood selector */}
                    <div className="flex items-center gap-1">
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

                    {/* Location badge */}
                    {locationName && (
                        <div className="flex items-center gap-2 text-xs text-sky-400/70 bg-sky-500/10 rounded-lg px-3 py-2 border border-sky-500/10">
                            <svg className="w-3.5 h-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M15 10.5a3 3 0 11-6 0 3 3 0 016 0z" />
                                <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1115 0z" />
                            </svg>
                            <span className="font-medium">{locationName}</span>
                        </div>
                    )}

                    {/* Body text */}
                    <textarea
                        ref={bodyRef}
                        placeholder="What's happening out there, skipper?&#10;&#10;Describe the conditions, the crew mood, the sunset over the bow…"
                        value={body}
                        onChange={e => setBody(e.target.value)}
                        rows={8}
                        className="w-full bg-white/[0.03] border border-white/5 rounded-2xl p-4 text-[15px] text-gray-200 placeholder-gray-600 leading-relaxed resize-none outline-none focus:border-sky-500/30 transition-colors"
                    />

                    {/* AI Polish button */}
                    {body.trim().length > 20 && (
                        <button
                            onClick={handlePolish}
                            disabled={polishing}
                            className="flex items-center gap-2 px-4 py-2.5 bg-gradient-to-r from-violet-500/20 to-purple-500/20 border border-violet-500/20 rounded-xl text-sm font-bold text-violet-300 hover:from-violet-500/30 hover:to-purple-500/30 transition-all disabled:opacity-50"
                        >
                            <span className="text-base">{polishing ? '⏳' : '✨'}</span>
                            {polishing ? 'Polishing with Gemini…' : 'Polish with Gemini'}
                        </button>
                    )}

                    {/* Photos */}
                    <div>
                        <div className="flex items-center gap-2 mb-2">
                            <span className="text-xs font-bold text-gray-500 uppercase tracking-wider">Photos</span>
                            {photos.length > 0 && (
                                <span className="text-[10px] text-gray-600 bg-white/5 px-1.5 py-0.5 rounded-full">{photos.length}/6</span>
                            )}
                        </div>

                        <div className="flex gap-2 flex-wrap">
                            {photos.map((url, i) => (
                                <div key={i} className="relative w-20 h-20 rounded-xl overflow-hidden group">
                                    <img src={url} alt="" className="w-full h-full object-cover" />
                                    <button
                                        onClick={() => removePhoto(i)}
                                        className="absolute top-1 right-1 w-5 h-5 bg-black/60 rounded-full flex items-center justify-center text-white text-[10px] opacity-0 group-hover:opacity-100 transition-opacity"
                                    >
                                        ✕
                                    </button>
                                </div>
                            ))}

                            {photos.length < 6 && (
                                <button
                                    onClick={() => fileRef.current?.click()}
                                    disabled={uploading}
                                    className="w-20 h-20 rounded-xl border-2 border-dashed border-white/10 hover:border-sky-500/30 flex flex-col items-center justify-center gap-1 text-gray-600 hover:text-sky-400 transition-colors"
                                >
                                    {uploading ? (
                                        <span className="text-xs animate-pulse">📷</span>
                                    ) : (
                                        <>
                                            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                                                <path strokeLinecap="round" strokeLinejoin="round" d="M6.827 6.175A2.31 2.31 0 015.186 7.23c-.38.054-.757.112-1.134.175C2.999 7.58 2.25 8.507 2.25 9.574V18a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9.574c0-1.067-.75-1.994-1.802-2.169a47.865 47.865 0 00-1.134-.175 2.31 2.31 0 01-1.64-1.055l-.822-1.316a2.192 2.192 0 00-1.736-1.039 48.774 48.774 0 00-5.232 0 2.192 2.192 0 00-1.736 1.039l-.821 1.316z" />
                                                <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 12.75a4.5 4.5 0 11-9 0 4.5 4.5 0 019 0z" />
                                            </svg>
                                            <span className="text-[9px] font-bold uppercase">Add</span>
                                        </>
                                    )}
                                </button>
                            )}
                        </div>
                    </div>
                </div>

                <input ref={fileRef} type="file" accept="image/*" onChange={handlePhotoSelect} className="hidden" />
            </div>
        );
    }

    // ── Render: Timeline ────────────────────────────────────────

    return (
        <div className="flex flex-col h-full bg-slate-900 text-white">
            {/* Header */}
            <div className="flex items-center gap-2 px-4 pt-[max(1rem,env(safe-area-inset-top))] pb-3 bg-slate-900/95 backdrop-blur-xl border-b border-white/5 shrink-0">
                <button onClick={onBack} className="p-2 -ml-2 rounded-full hover:bg-white/10 active:bg-white/20 transition-colors">
                    <svg className="w-6 h-6 text-sky-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
                    </svg>
                </button>
                <div className="flex-1">
                    <h2 className="text-base font-black text-white tracking-wide">Captain's Diary</h2>
                    <p className="text-[10px] text-gray-500 font-bold uppercase tracking-widest">
                        {entries.length} {entries.length === 1 ? 'entry' : 'entries'}
                    </p>
                </div>
                <button
                    onClick={openCompose}
                    className="px-4 py-2 bg-sky-600 hover:bg-sky-500 text-white font-bold text-sm rounded-xl transition-colors flex items-center gap-1.5 active:scale-95"
                >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                    </svg>
                    New
                </button>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto">
                {loading ? (
                    <div className="flex items-center justify-center h-full">
                        <div className="text-center">
                            <div className="text-3xl mb-3 animate-pulse">📓</div>
                            <p className="text-sm text-gray-500">Loading journal…</p>
                        </div>
                    </div>
                ) : entries.length === 0 ? (
                    <div className="flex items-center justify-center h-full px-8">
                        <div className="text-center max-w-xs">
                            <div className="text-5xl mb-4">🌅</div>
                            <h3 className="text-lg font-black text-white mb-2">Your Story Starts Here</h3>
                            <p className="text-sm text-gray-400 leading-relaxed mb-6">
                                Document your passages, anchorages, and adventures. Add photos, GPS coordinates, and let Gemini help craft your narrative.
                            </p>
                            <button
                                onClick={openCompose}
                                className="px-6 py-3 bg-gradient-to-r from-sky-600 to-cyan-600 text-white font-bold rounded-2xl shadow-lg hover:shadow-sky-500/25 transition-all active:scale-95"
                            >
                                Write Your First Entry
                            </button>
                        </div>
                    </div>
                ) : (
                    <div className="p-4 space-y-6 pb-24">
                        {Array.from(grouped.entries()).map(([dateKey, dayEntries]) => (
                            <div key={dateKey}>
                                {/* Date header */}
                                <div className="flex items-center gap-3 mb-3">
                                    <div className="w-2 h-2 rounded-full bg-sky-500 shrink-0" />
                                    <span className="text-xs font-black text-sky-400 uppercase tracking-widest">
                                        {formatDate(dayEntries[0].created_at)}
                                    </span>
                                    <div className="flex-1 h-px bg-white/5" />
                                </div>

                                {/* Entries for this day */}
                                <div className="space-y-3 ml-4 border-l border-white/5 pl-4">
                                    {dayEntries.map(entry => {
                                        const moodCfg = MOOD_CONFIG[entry.mood] || MOOD_CONFIG.neutral;
                                        return (
                                            <button
                                                key={entry.id}
                                                onClick={() => { setSelectedEntry(entry); triggerHaptic('light'); }}
                                                className="w-full text-left bg-white/[0.03] border border-white/5 rounded-2xl overflow-hidden hover:bg-white/[0.05] hover:border-white/10 transition-all active:scale-[0.98] group"
                                            >
                                                {/* Photo strip */}
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
                                                            </div>
                                                            <p className="text-xs text-gray-400 line-clamp-2 leading-relaxed">
                                                                {entry.body}
                                                            </p>
                                                        </div>
                                                        <span className="text-[10px] text-gray-600 font-mono shrink-0 mt-0.5">
                                                            {formatTime(entry.created_at)}
                                                        </span>
                                                    </div>

                                                    {/* Footer: location + coords */}
                                                    {(entry.location_name || (entry.latitude && entry.longitude)) && (
                                                        <div className="flex items-center gap-1.5 mt-2 text-[10px] text-sky-500/50">
                                                            <svg className="w-3 h-3 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                                                                <path strokeLinecap="round" strokeLinejoin="round" d="M15 10.5a3 3 0 11-6 0 3 3 0 016 0z" />
                                                                <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1115 0z" />
                                                            </svg>
                                                            <span className="font-medium truncate">{entry.location_name || `${entry.latitude?.toFixed(2)}°, ${entry.longitude?.toFixed(2)}°`}</span>
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
        </div>
    );
};
