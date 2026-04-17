/**
 * DiaryComposeForm — New entry / edit entry form for the diary.
 *
 * Extracted from DiaryPage to reduce component size.
 */

import React, { useRef, useState } from 'react';
import { DiaryMood, MOOD_CONFIG } from '../../services/DiaryService';
import { scrollInputAboveKeyboard } from '../../utils/keyboardScroll';
import { triggerHaptic } from '../../utils/system';
import { AudioWidget } from './AudioWidget';
import { DiaryPhoto } from './DiaryPhoto';
import { OfflineBadge } from '../ui/OfflineBadge';

// ── Helpers ──
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

interface DiaryComposeFormProps {
    // State
    isEditing: boolean;
    title: string;
    body: string;
    mood: DiaryMood;
    photos: string[];
    audioUrl: string | null;
    lat: number | null;
    lon: number | null;
    locationName: string;
    keyboardHeight: number;
    saving: boolean;
    uploading: boolean;
    polishing: boolean;
    gpsLoading: boolean;
    isRecording: boolean;
    recordingTime: number;
    transcribing: boolean;
    isPlaying: boolean;
    // Setters
    onSetTitle: (v: string) => void;
    onSetBody: (v: string | ((prev: string) => string)) => void;
    onSetMood: (v: DiaryMood) => void;
    onSetLocationName: (v: string) => void;
    // Actions
    onSave: () => void;
    onCancel: () => void;
    onGrabGps: () => void;
    onStartRecording: () => void;
    onStopRecording: () => void;
    onRemoveAudio: () => void;
    onTogglePlayback: (url: string) => void;
    onTranscribe: (url: string) => void;
    onPolish: () => void;
    onPhotoSelect: (e: React.ChangeEvent<HTMLInputElement>) => void;
    onPhotoRemove: (idx: number) => void;
}

export const DiaryComposeForm: React.FC<DiaryComposeFormProps> = React.memo(
    ({
        isEditing,
        title,
        body,
        mood,
        photos,
        audioUrl,
        lat,
        lon,
        locationName,
        keyboardHeight,
        saving,
        uploading,
        polishing,
        gpsLoading,
        isRecording,
        recordingTime,
        transcribing,
        isPlaying,
        onSetTitle,
        onSetBody,
        onSetMood,
        onSetLocationName,
        onSave,
        onCancel,
        onGrabGps,
        onStartRecording,
        onStopRecording,
        onRemoveAudio,
        onTogglePlayback,
        onTranscribe,
        onPolish,
        onPhotoSelect,
        onPhotoRemove,
    }) => {
        const fileRef = useRef<HTMLInputElement>(null);
        const [polishIntensity, setPolishIntensity] = useState(30);

        const bottomPad = keyboardHeight > 0 ? `${keyboardHeight}px` : 'calc(4rem + env(safe-area-inset-bottom) + 8px)';

        return (
            <div className="flex flex-col h-full bg-slate-950 text-white" style={{ paddingBottom: bottomPad }}>
                {/* Header */}
                <div className="shrink-0 px-4 pt-4 pb-3">
                    <div className="flex items-center gap-3">
                        <button
                            aria-label="Cancel this action"
                            onClick={onCancel}
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

                {/* Compose body */}
                <div className="flex-1 flex flex-col p-4 gap-3 min-h-0 overflow-auto no-scrollbar">
                    {/* Title */}
                    <input
                        type="text"
                        placeholder="Entry title (optional)"
                        value={title}
                        onChange={(e) => onSetTitle(e.target.value)}
                        onFocus={scrollInputAboveKeyboard}
                        autoFocus
                        className="shrink-0 w-full bg-white/[0.03] border border-white/[0.08] rounded-xl px-4 py-3 text-lg font-bold text-white placeholder-gray-500 outline-none focus:border-sky-500/30 transition-colors"
                    />

                    {/* Mood selector */}
                    <div className="shrink-0 grid grid-cols-4 gap-1.5">
                        {(['epic', 'good', 'neutral', 'rough'] as DiaryMood[]).map((key) => {
                            const cfg = MOOD_CONFIG[key];
                            return (
                                <button
                                    aria-label="Set Mood"
                                    key={key}
                                    onClick={() => {
                                        onSetMood(key);
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
                            {/* Position — 2/3 width */}
                            <button
                                aria-label="Grab Gps"
                                type="button"
                                onClick={onGrabGps}
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
                                aria-label="Start voice recording"
                                onClick={isRecording ? onStopRecording : onStartRecording}
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
                                    className={`text-[11px] font-bold uppercase tracking-wider leading-none ${isRecording ? 'text-red-400' : 'text-emerald-400/70'}`}
                                >
                                    {isRecording ? 'Stop' : 'Voice'}
                                </span>
                            </button>

                            {/* Polish — 1/6 width */}
                            <button
                                aria-label="Polish entry text"
                                onClick={onPolish}
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
                                <span className="text-[11px] font-bold text-purple-300/70 uppercase tracking-wider leading-none">
                                    Polish
                                </span>
                            </button>
                        </div>

                        {/* Polish intensity slider */}
                        <div className="flex items-center gap-2 px-1">
                            <span className="text-[11px] font-bold text-gray-400 uppercase tracking-wider shrink-0 w-10">
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
                            <span className="text-[11px] font-bold text-amber-400/70 uppercase tracking-wider shrink-0 w-12 text-right">
                                Literary
                            </span>
                        </div>

                        {/* Location name input */}
                        <input
                            type="text"
                            placeholder="Location (e.g. Moreton Bay)"
                            value={locationName}
                            onChange={(e) => onSetLocationName(e.target.value)}
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
                            onChange={(e) => onSetBody(e.target.value)}
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

                    {/* Audio widget (if recorded) */}
                    {audioUrl && (
                        <AudioWidget
                            url={audioUrl}
                            isPlaying={isPlaying}
                            transcribing={transcribing}
                            onTogglePlayback={onTogglePlayback}
                            onTranscribe={onTranscribe}
                            onRemove={onRemoveAudio}
                            allowTranscribe={true}
                            allowRemove={true}
                        />
                    )}

                    {/* Photos */}
                    <div className="shrink-0">
                        <div
                            className="grid gap-2"
                            style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(56px, 1fr))' }}
                        >
                            {photos.map((url, i) => (
                                <div key={i} className="relative aspect-square rounded-xl overflow-hidden group">
                                    <DiaryPhoto src={url} alt="" className="w-full h-full object-cover" />
                                    <button
                                        aria-label="Remove this item"
                                        onClick={() => onPhotoRemove(i)}
                                        className="absolute top-1 right-1 w-5 h-5 bg-black/60 rounded-full flex items-center justify-center text-white text-[11px] opacity-0 group-hover:opacity-100 transition-opacity"
                                    >
                                        ✕
                                    </button>
                                </div>
                            ))}
                            {Array.from({ length: Math.max(1, 6 - photos.length) }).map((_, i) => (
                                <button
                                    aria-label="View reference"
                                    key={`add-${i}`}
                                    onClick={() => fileRef.current?.click()}
                                    disabled={uploading || photos.length >= 6}
                                    className="aspect-square rounded-xl border-2 border-dashed border-white/10 hover:border-sky-500/30 flex flex-col items-center justify-center gap-0.5 text-gray-400 hover:text-sky-400 transition-colors disabled:opacity-30"
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
                            aria-label="Cancel this action"
                            onClick={onCancel}
                            className="flex-1 py-3 rounded-xl bg-white/5 border border-white/[0.08] text-gray-400 font-bold text-sm hover:bg-white/10 transition-colors active:scale-[0.98]"
                        >
                            Cancel
                        </button>
                        <button
                            aria-label="Save changes"
                            onClick={onSave}
                            disabled={saving || (!body.trim() && !title.trim() && !audioUrl)}
                            className="flex-[2] py-3 rounded-xl bg-sky-600 hover:bg-sky-500 disabled:bg-gray-700 disabled:text-gray-400 text-white font-bold text-sm transition-colors active:scale-[0.98]"
                        >
                            {saving ? 'Saving…' : isEditing ? 'Update Entry' : 'Save Entry'}
                        </button>
                    </div>
                </div>

                <input ref={fileRef} type="file" accept="image/*" onChange={onPhotoSelect} className="hidden" />
            </div>
        );
    },
);
