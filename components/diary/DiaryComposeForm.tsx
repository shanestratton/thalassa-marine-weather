/**
 * DiaryComposeForm — New entry / edit entry form for the diary.
 *
 * Extracted from DiaryPage to reduce component size.
 */

import React, { useRef } from 'react';
import { DiaryMood, MOOD_CONFIG } from '../../services/DiaryService';
import { scrollInputAboveKeyboard } from '../../utils/keyboardScroll';
import { triggerHaptic } from '../../utils/system';
import { DiaryPhoto } from './DiaryPhoto';
import { OfflineBadge } from '../ui/OfflineBadge';
import { POLISH_LABEL, type PolishStyle } from '../../types/settings';

// ── Helpers ──
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
    locationName: string;
    keyboardHeight: number;
    saving: boolean;
    uploading: boolean;
    polishing: boolean;
    isRecording: boolean;
    recordingTime: number;
    transcribing: boolean;
    polishStyle: PolishStyle;
    // Setters
    onSetTitle: (v: string) => void;
    onSetBody: (v: string | ((prev: string) => string)) => void;
    onSetMood: (v: DiaryMood) => void;
    onSetLocationName: (v: string) => void;
    onSetPolishStyle: (v: PolishStyle) => void;
    // Actions
    onSave: () => void;
    onCancel: () => void;
    onStartRecording: () => void;
    onStopRecording: () => void;
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
        locationName,
        keyboardHeight,
        saving,
        uploading,
        polishing,
        isRecording,
        recordingTime,
        transcribing,
        polishStyle,
        onSetTitle,
        onSetBody,
        onSetMood,
        onSetLocationName,
        onSetPolishStyle,
        onSave,
        onCancel,
        onStartRecording,
        onStopRecording,
        onPolish,
        onPhotoSelect,
        onPhotoRemove,
    }) => {
        const fileRef = useRef<HTMLInputElement>(null);

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
                    {/* Title — prefilled with today's date/time so the keyboard
                        doesn't pop up; the skipper edits only if they tap in. */}
                    <input
                        type="text"
                        placeholder="Entry title (optional)"
                        value={title}
                        onChange={(e) => onSetTitle(e.target.value)}
                        onFocus={(e) => {
                            // First tap selects the prefilled text so a single
                            // keystroke replaces it; otherwise editing in place works.
                            e.currentTarget.select();
                            scrollInputAboveKeyboard(e);
                        }}
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

                    {/* ═══ VOICE | POLISH ═══
                        Position auto-acquires on compose open and is saved
                        with the entry silently — no UI surface, the user
                        doesn't need to think about it. For back-dated
                        entries the "Location" input below overrides the
                        displayed place name. */}
                    <div className="shrink-0 space-y-2">
                        <div className="flex gap-2">
                            {/* Voice */}
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

                            {/* Polish */}
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

                        {/* Polish style — preset dropdown. Replaced the
                            clean→literary slider so the row fits in the
                            cramped New Entry sheet without scrolling. The
                            chosen style persists across sessions and
                            devices via settings.polishStyle. */}
                        <div className="flex items-center gap-2 px-1">
                            <span className="text-[11px] font-bold text-purple-300/70 uppercase tracking-wider shrink-0">
                                ✨ Polish
                            </span>
                            <div className="relative flex-1">
                                <select
                                    value={polishStyle}
                                    onChange={(e) => onSetPolishStyle(e.target.value as PolishStyle)}
                                    aria-label="Polish style"
                                    className="w-full appearance-none bg-purple-500/[0.08] border border-purple-500/25 rounded-lg pl-3 pr-8 py-1.5 text-[11px] text-purple-100 font-bold outline-none focus:border-purple-400/60 hover:bg-purple-500/[0.12] transition-colors cursor-pointer [color-scheme:dark]"
                                >
                                    {(Object.entries(POLISH_LABEL) as [PolishStyle, string][]).map(([value, label]) => (
                                        <option key={value} value={value} className="bg-slate-900 text-purple-100">
                                            {label}
                                        </option>
                                    ))}
                                </select>
                                <svg
                                    className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 w-3 h-3 text-purple-300/70"
                                    fill="none"
                                    viewBox="0 0 24 24"
                                    stroke="currentColor"
                                    strokeWidth={2.5}
                                    aria-hidden="true"
                                >
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                                </svg>
                            </div>
                        </div>

                        {/* Location name input — overrides the auto-detected
                            place name. Useful for back-dated entries where
                            the current GPS reading doesn't match where the
                            skipper actually was when the event happened. */}
                        <input
                            type="text"
                            placeholder="Location (override e.g. Moreton Bay)"
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

                    {/* Voice memo preview deliberately omitted — recording auto-
                        transcribes on stop (DiaryPage onstop handler), so all
                        the punter ever sees is the transient transcribing pill
                        above. audioUrl still rides along on the saved entry
                        for playback in the entry-detail view. */}

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
