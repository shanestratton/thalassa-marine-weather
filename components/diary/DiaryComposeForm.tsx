/**
 * DiaryComposeForm — New entry / edit entry form for the diary.
 *
 * TEXT-FIRST since 2026-08-25 (Shane: "get rid of the microphone, and just
 * have texting"): the body is a plain editable textarea that rides above
 * the keyboard, mood defaults to EPIC, and the entry's GPS coords are shown
 * (and always saved) by default. The ✨ polish pass stays — it just works
 * on typed words now. Legacy voice entries keep playback in the entry view.
 */

import React, { useEffect, useRef } from 'react';
import { DiaryMood, MOOD_CONFIG } from '../../services/DiaryService';
import { scrollInputAboveKeyboard } from '../../utils/keyboardScroll';
import { triggerHaptic } from '../../utils/system';
import { DiaryPhoto } from './DiaryPhoto';
import { DiaryVideo } from './DiaryVideo';
import { OfflineBadge } from '../ui/OfflineBadge';
import { Button } from '../ui/Button';
import { POLISH_LABEL, type PolishStyle } from '../../types/settings';

interface DiaryComposeFormProps {
    // State
    isEditing: boolean;
    title: string;
    body: string;
    mood: DiaryMood;
    photos: string[];
    audioUrl: string | null;
    videoUrl: string | null;
    locationName: string;
    keyboardHeight: number;
    saving: boolean;
    uploading: boolean;
    polishing: boolean;
    /** Device fix still being acquired — the coords line says so. */
    gpsLoading: boolean;
    /** Formatted "27.1234°S, 153.1234°E" once a fix (or photo EXIF) landed. */
    coordsLabel: string | null;
    polishStyle: PolishStyle;
    // Setters
    onSetTitle: (v: string) => void;
    onSetBody: (v: string) => void;
    onSetMood: (v: DiaryMood) => void;
    onSetLocationName: (v: string) => void;
    onSetPolishStyle: (v: PolishStyle) => void;
    // Actions
    onSave: () => void;
    onCancel: () => void;
    onPolish: () => void;
    onPhotoSelect: (e: React.ChangeEvent<HTMLInputElement>) => void;
    onPhotoRemove: (idx: number) => void;
    onVideoSelect: (e: React.ChangeEvent<HTMLInputElement>) => void;
    onVideoRemove: () => void;
}

export const DiaryComposeForm: React.FC<DiaryComposeFormProps> = React.memo(
    ({
        isEditing,
        title,
        body,
        mood,
        photos,
        audioUrl,
        videoUrl,
        locationName,
        keyboardHeight,
        saving,
        uploading,
        polishing,
        gpsLoading,
        coordsLabel,
        polishStyle,
        onSetTitle,
        onSetBody,
        onSetMood,
        onSetLocationName,
        onSetPolishStyle,
        onSave,
        onCancel,
        onPolish,
        onPhotoSelect,
        onPhotoRemove,
        onVideoSelect,
        onVideoRemove,
    }) => {
        const fileRef = useRef<HTMLInputElement>(null);
        const videoRef = useRef<HTMLInputElement>(null);
        const bodyRef = useRef<HTMLTextAreaElement>(null);

        // FIRST-TAP RACE (Shane 2026-08-25: "still doing the scroll up thing,
        // however, once you click into the box a second time. it comes
        // good"): the focus handler's tail-scroll fired before the keyboard
        // height published, so it scrolled pre-keyboard geometry; the bottom
        // padding then grew underneath it and left the void. The tail-scroll
        // must chase the KEYBOARD, not the tap — whenever the measured height
        // changes while the body is focused, re-pin the column to its tail
        // (one rAF after the padding paints).
        useEffect(() => {
            const body = bodyRef.current;
            if (!body || document.activeElement !== body) return;
            const scroller = body.closest('.overflow-auto');
            if (!scroller) return;
            const raf = requestAnimationFrame(() => {
                scroller.scrollTop = scroller.scrollHeight;
            });
            return () => cancelAnimationFrame(raf);
        }, [keyboardHeight]);

        const bottomPad = keyboardHeight > 0 ? `${keyboardHeight}px` : 'calc(4rem + env(safe-area-inset-bottom) + 8px)';

        return (
            <div className="flex flex-col h-full bg-slate-950 text-white" style={{ paddingBottom: bottomPad }}>
                {/* Header */}
                <div className="shrink-0 px-4 pt-4 pb-3">
                    <div className="flex items-center gap-3">
                        <button
                            aria-label="Cancel this action"
                            onClick={onCancel}
                            disabled={saving}
                            className="p-2 rounded-xl bg-white/5 hover:bg-white/10 transition-colors disabled:opacity-40"
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
                                    aria-label={`Set mood to ${cfg.label}`}
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

                    {/* ═══ POLISH · STYLE — single 44px row ═══ */}
                    <div className="shrink-0 space-y-2">
                        <div className="flex gap-2 items-stretch">
                            {/* Polish — icon-only, dimmed until body has enough
                                text to polish. The style chip on the right tells
                                the user what style this button will apply. */}
                            <button
                                aria-label="Polish entry text"
                                type="button"
                                onClick={onPolish}
                                disabled={polishing || body.trim().length < 10}
                                className={`w-11 h-11 shrink-0 flex items-center justify-center rounded-xl border transition-all active:scale-[0.95] text-lg ${
                                    polishing
                                        ? 'bg-purple-500/30 border-purple-500/30 animate-pulse'
                                        : body.trim().length >= 10
                                          ? 'bg-purple-500/15 border-purple-500/25 hover:bg-purple-500/25'
                                          : 'bg-white/[0.03] border-white/[0.06] opacity-30 cursor-default'
                                }`}
                            >
                                <span aria-hidden="true">{polishing ? '⏳' : '✨'}</span>
                            </button>

                            {/* Polish style — preset dropdown, fills the rest
                                of the row. Chip + chevron makes it obvious this
                                is interactive. Choice persists via
                                settings.polishStyle. */}
                            <div className="relative flex-1 min-w-0">
                                <select
                                    value={polishStyle}
                                    onChange={(e) => onSetPolishStyle(e.target.value as PolishStyle)}
                                    aria-label="Polish style"
                                    className="w-full h-11 appearance-none bg-purple-500/[0.08] border border-purple-500/25 rounded-xl pl-3 pr-8 text-[11px] text-purple-100 font-bold outline-none focus:border-purple-400/60 hover:bg-purple-500/[0.12] transition-colors cursor-pointer [color-scheme:dark]"
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

                        {/* GPS coords — always on the entry by default (Shane
                            2026-08-25). Shown so the punter can SEE what will
                            be saved; honesty when there is no fix yet. */}
                        <p className="px-1 text-[10px] font-mono text-gray-500">
                            <span aria-hidden>📍 </span>
                            {coordsLabel ??
                                (gpsLoading ? 'Acquiring GPS fix…' : 'No GPS fix — will retry when you save')}
                        </p>
                    </div>

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
                                        disabled={saving}
                                        className="absolute top-1 right-1 w-5 h-5 bg-black/60 rounded-full flex items-center justify-center text-white text-[11px] opacity-0 group-hover:opacity-100 transition-opacity disabled:cursor-not-allowed"
                                    >
                                        ✕
                                    </button>
                                </div>
                            ))}
                            {Array.from({ length: Math.max(1, 6 - photos.length) }).map((_, i) => (
                                <button
                                    aria-label={`Add diary photo ${photos.length + i + 1}`}
                                    key={`add-${i}`}
                                    onClick={() => fileRef.current?.click()}
                                    disabled={saving || uploading || photos.length >= 6}
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
                    {/* Video — one clip, a minute at most. The preview plays the
                        local blob so the skipper can check the clip BEFORE it
                        costs anything; upload happens on save via the drain. */}
                    <div className="shrink-0">
                        {videoUrl ? (
                            <div className="relative rounded-xl overflow-hidden border border-violet-500/20">
                                <DiaryVideo src={videoUrl} className="w-full max-h-48 bg-black" />
                                <button
                                    aria-label="Remove the video"
                                    onClick={onVideoRemove}
                                    disabled={saving}
                                    className="absolute top-1.5 right-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-black/70 text-[12px] text-white disabled:cursor-not-allowed"
                                >
                                    ✕
                                </button>
                            </div>
                        ) : (
                            <button
                                aria-label="Add a video clip"
                                onClick={() => videoRef.current?.click()}
                                disabled={saving || uploading}
                                className="flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border-2 border-dashed border-white/10 py-2 text-xs font-semibold text-gray-400 transition-colors hover:border-violet-500/30 hover:text-violet-300 disabled:opacity-30"
                            >
                                <span>🎥</span>
                                <span>Add a video — up to 1 minute</span>
                            </button>
                        )}
                    </div>
                    {/* Polishing indicator */}
                    {polishing && (
                        <div className="shrink-0 flex items-center justify-center gap-2 px-3 py-2 bg-purple-500/10 border border-purple-500/15 rounded-xl">
                            <span className="text-sm animate-pulse">✨</span>
                            <span className="text-xs font-bold text-purple-300">Styling your entry…</span>
                        </div>
                    )}

                    {/* Body text — the big box. Editable, and it rides above
                        the keyboard: the form's paddingBottom tracks the shared
                        keyboard measurement and the focus handler scrolls the
                        caret clear (the KeyboardResize.None trap). LAST in
                        the column on purpose (Shane 2026-08-25 screenshot: the
                        box scrolled to the top and left a void above the
                        buttons): it must sit JUST ABOVE Cancel/Save, so focus
                        scrolls the column to its tail — never to a void. */}
                    <div className="flex-1 min-h-0">
                        <textarea
                            ref={bodyRef}
                            aria-label="Diary entry text"
                            placeholder={polishing ? 'Styling your entry…' : 'What happened out there?'}
                            value={body}
                            onChange={(e) => onSetBody(e.target.value)}
                            onFocus={(e) => {
                                scrollInputAboveKeyboard(e);
                                const scroller = e.currentTarget.closest('.overflow-auto');
                                requestAnimationFrame(() => {
                                    if (scroller) scroller.scrollTop = scroller.scrollHeight;
                                });
                            }}
                            disabled={polishing}
                            className="w-full h-full min-h-[10rem] bg-slate-900 border border-white/[0.08] rounded-2xl p-4 text-sm text-gray-200 placeholder-gray-500 leading-relaxed resize-none outline-none focus:border-sky-500/30 transition-colors disabled:opacity-60"
                        />
                    </div>
                </div>

                {/* ═══ SAVE + CANCEL — fixed at bottom ═══ */}
                <div className="shrink-0 px-4 py-3 border-t border-white/5 bg-slate-950">
                    <div className="flex gap-3">
                        <Button
                            aria-label="Cancel this action"
                            onClick={onCancel}
                            disabled={saving}
                            className="flex-1 text-gray-400 disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                            Cancel
                        </Button>
                        <button
                            aria-label="Save changes"
                            onClick={onSave}
                            disabled={saving || polishing || (!body.trim() && !title.trim() && !audioUrl)}
                            className="flex-[2] py-3 rounded-xl bg-sky-600 hover:bg-sky-500 disabled:bg-gray-700 disabled:text-gray-400 text-white font-bold text-sm transition-colors active:scale-[0.98]"
                        >
                            {saving ? 'Saving…' : isEditing ? 'Update Entry' : 'Save Entry'}
                        </button>
                    </div>
                </div>

                <input ref={fileRef} type="file" accept="image/*" onChange={onPhotoSelect} className="hidden" />
                <input ref={videoRef} type="file" accept="video/*" onChange={onVideoSelect} className="hidden" />
            </div>
        );
    },
);
