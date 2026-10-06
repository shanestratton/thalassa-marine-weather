/**
 * DiaryComposeForm — New entry / edit entry form for the diary.
 *
 * TEXT-FIRST since 2026-08-25 (Shane: "get rid of the microphone, and just
 * have texting"): the body is a plain editable textarea that rides above
 * the keyboard, mood defaults to EPIC, and the entry's GPS coords are shown
 * (and always saved) by default. The ✨ polish pass stays — it just works
 * on typed words now. Legacy voice entries keep playback in the entry view.
 *
 * The new look since 2026-10-06 (Shane: "can you update the diary entry page
 * to make it more in line with our new look"): the Vessel and Plan pages'
 * glass cards, one sky accent and the emerald primary. Title, Trip (the Plan
 * page's Trip tile), Mood (one segmented row), Where, the polish tile and its
 * style, Photos and the text box, then the video; Cancel and Save at the
 * foot. Every field, state and label of the old form is still here.
 * styles/diary-compose.css draws it.
 */

import React, { useEffect, useId, useRef } from 'react';
import { DiaryMood, MOOD_CONFIG } from '../../services/DiaryService';
import { keepEditableAboveKeyboard, scrollInputAboveKeyboard } from '../../utils/keyboardScroll';
import { triggerHaptic } from '../../utils/system';
import { DiaryPhoto } from './DiaryPhoto';
import { DiaryVideo } from './DiaryVideo';
import { OfflineBadge } from '../ui/OfflineBadge';
import { POLISH_LABEL, type PolishStyle } from '../../types/settings';
import { AnchorIcon, CalendarIcon, DeviceIcon, EditIcon, FlagIcon, MapPinIcon, SparklesIcon } from '../Icons';
import { PLAN_ACCENT, PLAN_TILE_CLASS, PLAN_TILE_STYLE } from '../passage/PlanTile';
import { JOURNAL_CHIP } from '../vesselHub/JournalCard';
import { CONTOUR_BG } from '../vesselHub/glass';
import { ACTION_BAR_THEMES } from '../ui/actionBarThemes';

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
    /** Formatted "27.1234°S, 153.1234°E" once a fix (or photo EXIF) landed,
     *  led by its source ("Boat · …" or "Phone · …") when DiaryPage knows it. */
    coordsLabel: string | null;
    polishStyle: PolishStyle;
    tripPicker?: {
        value: string;
        choices: { voyageId: string; label: string }[];
        originalVoyageId: string | null;
        originalLabel: string;
        disabled: boolean;
        loading: boolean;
        unavailable: boolean;
        onChange: (value: string) => void;
    };
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

/** Photos an entry holds; the add tiles fill the row up to this. */
const MAX_PHOTOS = 6;
const MOODS: DiaryMood[] = ['epic', 'good', 'neutral', 'rough'];
const NO_TRIP_LABEL = 'No trip · general diary';

/** The position line's source word, split from DiaryPage's "Boat · 27.1°S, …". */
function splitPosition(label: string): { source: 'Boat' | 'Phone' | null; coords: string } {
    const match = /^(Boat|Phone) · (.*)$/.exec(label);
    return match ? { source: match[1] as 'Boat' | 'Phone', coords: match[2] } : { source: null, coords: label };
}

/** Save at the foot: the emerald of 'Start plotting' (TapToAction). By day a
 *  solid 700 fill with a white label, as every daylight primary; the `!` is
 *  because the track colours are inline. */
const SAVE_STYLE: React.CSSProperties = {
    background: ACTION_BAR_THEMES.emerald.track,
    border: ACTION_BAR_THEMES.emerald.trackBorder,
};
const SAVE_DAYLIGHT =
    '[.display-light_&]:bg-none! [.display-light_&]:bg-emerald-700! [.display-light_&]:border-emerald-800! [.display-light_&]:text-white! [.display-light_&]:shadow-md [.display-light_&]:shadow-slate-900/15';

/** A tap on a photo stays on the photo. A finger tap on something that does
 *  not respond to clicks is moved by the browser to the nearest control that
 *  does (touch adjustment, Chromium and WebKit alike), which here was the
 *  photo's remove control: a tap in the middle of a photo removed it, and the
 *  copy uploaded this session with it. A click handler on the image (React
 *  marks it with an onclick) makes the photo the nearest control itself. */
const KEEP_TAP_ON_PHOTO = () => undefined;

const ChevronDown: React.FC<{ className: string }> = ({ className }) => (
    <svg
        aria-hidden="true"
        className={className}
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={2.5}
        strokeLinecap="round"
        strokeLinejoin="round"
    >
        <path d="M6 9l6 6 6-6" />
    </svg>
);

const PlusGlyph: React.FC = () => (
    <svg aria-hidden="true" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 5v14m7-7H5" />
    </svg>
);

const CameraGlyph: React.FC<{ className?: string }> = ({ className }) => (
    <svg
        aria-hidden="true"
        className={className}
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
    >
        <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z" />
        <circle cx="12" cy="13" r="3" />
    </svg>
);

const VideoGlyph: React.FC = () => (
    <svg
        aria-hidden="true"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
    >
        <path d="m16 13 5.2 3.5a.5.5 0 0 0 .8-.4V7.9a.5.5 0 0 0-.8-.4L16 11" />
        <rect x="2" y="6" width="14" height="12" rx="2" />
    </svg>
);

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
        tripPicker,
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
        const id = useId();

        // Re-check the focused editor after keyboard padding has painted.
        // The video now follows the editor, so scrolling to the column's tail
        // would expose the video and hide the very field the skipper is typing.
        useEffect(() => {
            const body = bodyRef.current;
            if (!body || document.activeElement !== body) return;
            const raf = requestAnimationFrame(() => {
                if (document.activeElement === body) keepEditableAboveKeyboard(body);
            });
            return () => cancelAnimationFrame(raf);
        }, [keyboardHeight]);

        const bottomPad = keyboardHeight > 0 ? `${keyboardHeight}px` : 'calc(4rem + env(safe-area-inset-bottom) + 8px)';
        const canPolish = body.trim().length >= 10;

        // The trip choices, in the order the select has always listed them:
        // No trip, the entry's own trip when it is no longer a recent one,
        // then the recent trips (the entry's own one named first).
        const tripOptions = tripPicker
            ? [
                  { value: '', label: NO_TRIP_LABEL },
                  ...(tripPicker.originalVoyageId &&
                  !tripPicker.choices.some((choice) => choice.voyageId === tripPicker.originalVoyageId)
                      ? [{ value: tripPicker.originalVoyageId, label: tripPicker.originalLabel }]
                      : []),
                  ...tripPicker.choices.map((choice) => ({
                      value: choice.voyageId,
                      label: `${choice.voyageId === tripPicker.originalVoyageId ? `${tripPicker.originalLabel} · ` : ''}${choice.label}`,
                  })),
              ]
            : [];
        const tripLabel = tripOptions.find((option) => option.value === tripPicker?.value)?.label ?? NO_TRIP_LABEL;
        const tripDisabled = !!tripPicker && (saving || tripPicker.disabled);
        const tripStatus = tripPicker?.loading
            ? 'Loading recent trips…'
            : tripPicker?.unavailable
              ? 'No recent trips available. Your diary can still be saved.'
              : null;

        const position = coordsLabel ? splitPosition(coordsLabel) : null;
        const PositionIcon =
            position?.source === 'Boat' ? AnchorIcon : position?.source === 'Phone' ? DeviceIcon : MapPinIcon;
        const addSlots = Math.max(0, MAX_PHOTOS - photos.length);

        return (
            <div
                className="diary-compose flex flex-col h-full bg-slate-950 text-white"
                style={{ paddingBottom: bottomPad, backgroundImage: CONTOUR_BG, backgroundSize: '400px 400px' }}
            >
                {/* Header — the PageHeader recipe (44 px back, the title, its
                    status under it). Back cancels the entry, so it is not the
                    edge swipe's data-page-back. */}
                <div className="shrink-0 px-4 pt-4 pb-3">
                    <div className="diary-compose-column flex items-start gap-3">
                        <button
                            type="button"
                            aria-label="Cancel this action"
                            onClick={onCancel}
                            disabled={saving}
                            className="press flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-xl bg-white/5 p-2 transition-colors hover:bg-white/10 disabled:opacity-40"
                        >
                            <svg
                                aria-hidden="true"
                                className="h-5 w-5 shrink-0 text-gray-400"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                                strokeWidth={2}
                            >
                                <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
                            </svg>
                        </button>
                        <div className="flex min-h-[44px] min-w-0 flex-1 flex-col justify-center">
                            <h1 className="ui-page-title text-xl font-extrabold leading-tight text-white uppercase tracking-wider">
                                {isEditing ? 'Edit Entry' : 'New Entry'}
                            </h1>
                            <div className="mt-1.5 flex empty:hidden">
                                <OfflineBadge />
                            </div>
                        </div>
                    </div>
                </div>

                {/* Compose body */}
                <div className="diary-compose-body flex-1 flex flex-col px-4 pt-1 pb-4 min-h-0 overflow-auto no-scrollbar">
                    <div className="diary-compose-column flex flex-1 flex-col gap-2">
                        {/* Title — prefilled with today's date/time so the keyboard
                            doesn't pop up; the skipper edits only if they tap in. */}
                        <div className="diary-card">
                            <label htmlFor={`${id}-title`} className="diary-eyebrow">
                                <CalendarIcon />
                                Title
                            </label>
                            <input
                                id={`${id}-title`}
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
                                className="diary-field diary-field-title text-white placeholder-gray-500"
                            />
                        </div>

                        {/* Trip — the Plan page's Trip tile: the face shows the
                            choice, and the native select is laid invisibly over
                            the whole tile, so a tap anywhere opens it. */}
                        {tripPicker && (
                            <div
                                className={`${PLAN_TILE_CLASS} plan-tile-trip diary-trip`}
                                style={PLAN_TILE_STYLE}
                                data-disabled={tripDisabled || undefined}
                            >
                                <span className="plan-tile-body">
                                    <span
                                        aria-hidden="true"
                                        className="plan-tile-icon"
                                        style={{ ...JOURNAL_CHIP, color: PLAN_ACCENT }}
                                    >
                                        <FlagIcon />
                                    </span>
                                    <span className="flex min-w-0 flex-1 flex-col">
                                        <span aria-hidden="true" className="diary-trip-label">
                                            Trip
                                        </span>
                                        <span aria-hidden="true" className="diary-trip-value text-white">
                                            {tripLabel}
                                        </span>
                                        {tripStatus && (
                                            <span id={`${id}-trip-status`} className="diary-trip-status" role="status">
                                                {tripStatus}
                                            </span>
                                        )}
                                    </span>
                                    <svg
                                        aria-hidden="true"
                                        className="plan-tile-go"
                                        fill="none"
                                        viewBox="0 0 24 24"
                                        stroke={PLAN_ACCENT}
                                        strokeWidth={2}
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                    >
                                        <path d="M6 9l6 6 6-6" />
                                    </svg>
                                </span>
                                <select
                                    aria-label="Diary trip"
                                    aria-describedby={tripStatus ? `${id}-trip-status` : undefined}
                                    value={tripPicker.value}
                                    onChange={(event) => tripPicker.onChange(event.target.value)}
                                    disabled={tripDisabled}
                                    className="plan-tile-select scheme-dark [.display-light_&]:scheme-light"
                                >
                                    {tripOptions.map((option) => (
                                        <option key={option.value || 'none'} value={option.value}>
                                            {option.label}
                                        </option>
                                    ))}
                                </select>
                            </div>
                        )}

                        {/* Mood — one segmented row; the chosen one wears the
                            sky accent. */}
                        <div role="group" aria-label="Mood" className="diary-mood">
                            {MOODS.map((key) => {
                                const cfg = MOOD_CONFIG[key];
                                return (
                                    <button
                                        type="button"
                                        aria-label={`Set mood to ${cfg.label}`}
                                        aria-pressed={mood === key}
                                        key={key}
                                        onClick={() => {
                                            onSetMood(key);
                                            triggerHaptic('light');
                                        }}
                                        className="diary-mood-option min-h-[44px]"
                                    >
                                        <span aria-hidden="true" className="diary-mood-emoji">
                                            {cfg.emoji}
                                        </span>
                                        <span className="diary-mood-label">{cfg.label}</span>
                                    </button>
                                );
                            })}
                        </div>

                        {/* Where — the place name, then the position that will
                            be saved with the entry. */}
                        <div className="diary-card">
                            <label htmlFor={`${id}-place`} className="diary-eyebrow">
                                <MapPinIcon />
                                Where
                            </label>
                            {/* Location name input — overrides the auto-detected
                                place name. Useful for back-dated entries where
                                the current GPS reading doesn't match where the
                                skipper actually was when the event happened. */}
                            <input
                                id={`${id}-place`}
                                type="text"
                                placeholder="Location (override e.g. Moreton Bay)"
                                value={locationName}
                                onChange={(e) => onSetLocationName(e.target.value)}
                                onFocus={scrollInputAboveKeyboard}
                                className="diary-field text-white placeholder-gray-500"
                            />
                            <div aria-hidden="true" className="diary-rule" />
                            {/* GPS coords — always on the entry by default (Shane
                                2026-08-25). Shown so the punter can SEE what will
                                be saved; honesty when there is no fix yet. */}
                            <p
                                className={`diary-position font-mono${
                                    !position && !gpsLoading ? ' diary-position-warn' : ''
                                }`}
                            >
                                <PositionIcon />
                                {position ? (
                                    <span className="min-w-0">
                                        {position.source && (
                                            <>
                                                <span className="diary-position-source">{position.source}</span>
                                                {' · '}
                                            </>
                                        )}
                                        <span>{position.coords}</span>
                                    </span>
                                ) : (
                                    <span className="min-w-0">
                                        {gpsLoading ? 'Acquiring GPS fix…' : 'No GPS fix — will retry when you save'}
                                    </span>
                                )}
                            </p>
                        </div>

                        {/* Polish style — the ✨ polish tile, dimmed until the
                            body has enough text to polish, and the style it will
                            apply. The style's native select is laid invisibly
                            over its tile, as on the Trip tile; the choice
                            persists via settings.polishStyle. The eyebrow says
                            the select's name, so Voice Control finds it. */}
                        <div className="flex shrink-0 items-stretch gap-2">
                            <button
                                aria-label="Polish entry text"
                                type="button"
                                onClick={onPolish}
                                disabled={polishing || !canPolish}
                                data-ready={canPolish || polishing}
                                className={`diary-polish min-h-[56px]${polishing ? ' animate-pulse' : ''}`}
                            >
                                {polishing ? (
                                    <span aria-hidden="true" className="diary-spinner animate-spin" />
                                ) : (
                                    <SparklesIcon />
                                )}
                            </button>
                            <div className="diary-card diary-style flex-1">
                                <span aria-hidden="true" className="diary-eyebrow">
                                    <EditIcon />
                                    Polish style
                                </span>
                                <span aria-hidden="true" className="diary-style-value text-white">
                                    {POLISH_LABEL[polishStyle]}
                                </span>
                                <ChevronDown className="diary-select-chevron" />
                                <select
                                    value={polishStyle}
                                    onChange={(e) => onSetPolishStyle(e.target.value as PolishStyle)}
                                    aria-label="Polish style"
                                    className="plan-tile-select scheme-dark [.display-light_&]:scheme-light"
                                >
                                    {(Object.entries(POLISH_LABEL) as [PolishStyle, string][]).map(([value, label]) => (
                                        <option key={value} value={value}>
                                            {label}
                                        </option>
                                    ))}
                                </select>
                            </div>
                        </div>

                        {/* Photos — six dashed glass tiles in one row. */}
                        <div className="shrink-0">
                            <div className="diary-eyebrow-row">
                                <span className="diary-eyebrow">
                                    <CameraGlyph />
                                    Photos
                                </span>
                                <span className="diary-count">
                                    {photos.length === 0 ? `Up to ${MAX_PHOTOS}` : `${photos.length} of ${MAX_PHOTOS}`}
                                </span>
                            </div>
                            <div className="diary-photos">
                                {photos.map((url, i) => (
                                    <div key={i} className="diary-photo">
                                        <DiaryPhoto
                                            src={url}
                                            alt=""
                                            onClick={KEEP_TAP_ON_PHOTO}
                                            className="diary-photo-img w-full h-full object-cover"
                                        />
                                        {/* Remove: a dot in the corner, its hit area
                                            anchored there (styles/diary-compose.css),
                                            never over the middle of the photo. */}
                                        <button
                                            type="button"
                                            aria-label="Remove this item"
                                            onClick={() => onPhotoRemove(i)}
                                            disabled={saving}
                                            className="diary-photo-remove w-8 h-8"
                                        >
                                            <span aria-hidden="true" className="diary-photo-remove-dot">
                                                ✕
                                            </span>
                                        </button>
                                    </div>
                                ))}
                                {Array.from({ length: addSlots }).map((_, i) => (
                                    <button
                                        type="button"
                                        aria-label={`Add diary photo ${photos.length + i + 1}`}
                                        key={`add-${i}`}
                                        onClick={() => fileRef.current?.click()}
                                        disabled={saving || uploading || photos.length >= MAX_PHOTOS}
                                        className="diary-photo-add min-h-[44px]"
                                    >
                                        {uploading && i === 0 ? (
                                            <CameraGlyph className="h-[18px] w-[18px] animate-pulse" />
                                        ) : (
                                            <PlusGlyph />
                                        )}
                                    </button>
                                ))}
                            </div>
                        </div>

                        {/* Polishing indicator */}
                        {polishing && (
                            <div className="diary-polishing">
                                <SparklesIcon className="animate-pulse" />
                                <span>Styling your entry…</span>
                            </div>
                        )}

                        {/* Writing comes before video. Keep real height in the
                            flex column so a preview cannot collapse or overlap the
                            editor on a short phone; overflow stays in this panel. */}
                        <div className="flex-1 min-h-40">
                            <textarea
                                ref={bodyRef}
                                aria-label="Diary entry text"
                                placeholder={polishing ? 'Styling your entry…' : 'What happened out there?'}
                                value={body}
                                onChange={(e) => onSetBody(e.target.value)}
                                onFocus={scrollInputAboveKeyboard}
                                disabled={polishing}
                                className="diary-body min-h-40 text-gray-200 placeholder-gray-500"
                            />
                        </div>
                        {/* Video follows the content box, including its Add button,
                            so attaching a clip never moves the writing field down.
                            Preview stays local; upload still happens on save. */}
                        <div className="shrink-0">
                            {videoUrl ? (
                                <div className="diary-video">
                                    <DiaryVideo src={videoUrl} className="w-full max-h-48 bg-black" />
                                    <button
                                        type="button"
                                        aria-label="Remove the video"
                                        onClick={onVideoRemove}
                                        disabled={saving}
                                        className="hit-target-44 absolute top-1.5 right-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-black/70 text-[12px] text-white disabled:cursor-not-allowed"
                                    >
                                        ✕
                                    </button>
                                </div>
                            ) : (
                                <button
                                    type="button"
                                    aria-label="Add a video clip"
                                    onClick={() => videoRef.current?.click()}
                                    disabled={saving || uploading}
                                    className="diary-video-add min-h-[48px]"
                                >
                                    <VideoGlyph />
                                    <span>Add a video — up to 1 minute</span>
                                </button>
                            )}
                        </div>
                    </div>
                </div>

                {/* ═══ SAVE + CANCEL — fixed at bottom ═══ */}
                <div className="shrink-0 px-4 py-3 border-t border-white/5 bg-slate-950">
                    <div className="diary-compose-column flex gap-3">
                        <button
                            type="button"
                            aria-label="Cancel this action"
                            onClick={onCancel}
                            disabled={saving}
                            className="diary-cancel press flex min-h-[52px] flex-1 items-center justify-center rounded-full px-4 text-[15px] font-bold disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                            Cancel
                        </button>
                        <button
                            type="button"
                            aria-label="Save changes"
                            onClick={onSave}
                            disabled={saving || polishing || (!body.trim() && !title.trim() && !audioUrl)}
                            style={SAVE_STYLE}
                            className={`diary-save press flex min-h-[52px] flex-2 items-center justify-center gap-2 rounded-full px-5 text-[15px] font-bold disabled:cursor-not-allowed ${
                                saving ? 'disabled:opacity-80' : 'disabled:opacity-40'
                            } ${SAVE_DAYLIGHT}`}
                        >
                            {saving && <span aria-hidden="true" className="diary-spinner animate-spin" />}
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
