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
 * glass, one sky accent and the emerald primary.
 *
 * It fits its screen (Shane 2026-10-06: "could we make the diary page just
 * fit the area. I hate scrolling it looks terrible. Use your banging new
 * boxes"). Under the header, top to bottom: ONE box of three rows (Title,
 * Where with the saved position on its label line, Trip), the Vessel page's
 * rows-in-one-box; the one-row Mood; the media box (Photos and their count,
 * the video pill on the same line, the six tiles); and the writing card,
 * whose text box takes all the height that is left, with the ✨ polish and
 * its style at its foot. Cancel and Save at the foot. Every field, state and
 * label of the old form is still here. styles/diary-compose.css draws it,
 * with a compact tier for a short screen.
 *
 * The video (Shane 2026-10-06: "there was no where for the 1min video" — it
 * sat under the text box, off the bottom of a phone) is the pill on the
 * Photos line: "Add video · 1 min", and once a clip is on, "Your video",
 * which opens the clip in a centred sheet. Attaching one only changes the
 * pill's words, so the text box never moves (the 2026-09-09 rule). A saved
 * entry's video cannot be changed yet: updateEntry carries no video_url, so
 * an edit offers no add or remove that the save would silently drop, and
 * says so instead.
 */

import React, { useEffect, useId, useRef, useState } from 'react';
import { DiaryMood, MOOD_CONFIG } from '../../services/DiaryService';
import { keepEditableAboveKeyboard, scrollInputAboveKeyboard } from '../../utils/keyboardScroll';
import { triggerHaptic } from '../../utils/system';
import { DiaryPhoto } from './DiaryPhoto';
import { DiaryVideo } from './DiaryVideo';
import { OfflineBadge } from '../ui/OfflineBadge';
import { ModalSheet } from '../ui/ModalSheet';
import { POLISH_LABEL, type PolishStyle } from '../../types/settings';
import { AnchorIcon, CalendarIcon, DeviceIcon, EditIcon, FlagIcon, MapPinIcon, SparklesIcon } from '../Icons';
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

/** A polish style's name, then its gloss ('Shakespearean', ' — maritime
 *  grandeur'), so the narrowest screen can show the name alone on one line.
 *  The select itself keeps every option's whole label. */
const StyleName: React.FC<{ label: string }> = ({ label }) => {
    const cut = label.indexOf(' — ');
    if (cut < 0) return <>{label}</>;
    return (
        <>
            <span className="diary-style-name">{label.slice(0, cut)}</span>
            <span className="diary-style-gloss">{label.slice(cut)}</span>
        </>
    );
};

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
        const [videoOpen, setVideoOpen] = useState(false);

        // The sheet shows the clip; with no clip there is nothing to show.
        useEffect(() => {
            if (!videoUrl) setVideoOpen(false);
        }, [videoUrl]);

        // Re-check the focused editor after keyboard padding has painted.
        useEffect(() => {
            const body = bodyRef.current;
            if (!body || document.activeElement !== body) return;
            const raf = requestAnimationFrame(() => {
                if (document.activeElement === body) keepEditableAboveKeyboard(body);
            });
            return () => cancelAnimationFrame(raf);
        }, [keyboardHeight]);

        // Clear of the tab bar (4rem over the home indicator) by
        // --diary-nav-clear: 8 px, 4 on a screen under 700 px tall.
        const bottomPad =
            keyboardHeight > 0
                ? `${keyboardHeight}px`
                : 'calc(4rem + env(safe-area-inset-bottom) + var(--diary-nav-clear, 8px))';
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
                {/* Header — the PageHeader recipe (44 px back, the title, and
                    the offline badge beside it, so going offline never pushes
                    the page down). Back cancels the entry, so it is not the
                    edge swipe's data-page-back. */}
                <div className="diary-compose-head shrink-0 px-4">
                    <div className="diary-compose-column flex items-center gap-3">
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
                        <div className="diary-compose-title flex min-h-[44px] min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
                            <h1 className="ui-page-title text-xl font-extrabold leading-tight text-white uppercase tracking-wider">
                                {isEditing ? 'Edit Entry' : 'New Entry'}
                            </h1>
                            <div className="diary-offline flex empty:hidden">
                                <OfflineBadge />
                            </div>
                        </div>
                    </div>
                </div>

                {/* Compose body — fits the screen; it scrolls only while the
                    keyboard is up, or on the smallest screens. */}
                <div className="diary-compose-body flex-1 flex flex-col px-4 min-h-0 overflow-auto no-scrollbar">
                    <div className="diary-compose-column diary-stack flex flex-1 flex-col">
                        {/* One box, three rows: Title, Where and Trip. Each row
                            is its field: the label line sits inside the field's
                            own 44 px box, so a tap anywhere on the row lands in
                            it. */}
                        <div className="diary-group">
                            {/* Title — prefilled with today's date/time so the
                                keyboard doesn't pop up; the skipper edits only if
                                they tap in. */}
                            <div className="diary-row diary-row-field">
                                <div className="diary-row-head">
                                    <label htmlFor={`${id}-title`} className="diary-eyebrow">
                                        <CalendarIcon />
                                        Title
                                    </label>
                                </div>
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

                            {/* Where — the place name, and on its label line the
                                position that will be saved with the entry. */}
                            <div className="diary-row diary-row-field diary-row-where">
                                <div className="diary-row-head">
                                    <label htmlFor={`${id}-place`} className="diary-eyebrow">
                                        <MapPinIcon />
                                        Where
                                    </label>
                                    {/* GPS coords — always on the entry by default
                                        (Shane 2026-08-25). Shown so the punter can SEE
                                        what will be saved; honesty when there is no
                                        fix yet. It wraps rather than cuts. */}
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
                                                {gpsLoading
                                                    ? 'Acquiring GPS fix…'
                                                    : 'No GPS fix — will retry when you save'}
                                            </span>
                                        )}
                                    </p>
                                </div>
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
                            </div>

                            {/* Trip — the face shows the choice, and the native
                                select is laid invisibly over the whole row, so a
                                tap anywhere opens it (the Plan page's Trip tile). */}
                            {tripPicker && (
                                <div className="diary-row diary-row-trip" data-disabled={tripDisabled || undefined}>
                                    <div className="diary-row-head">
                                        <span aria-hidden="true" className="diary-eyebrow">
                                            <FlagIcon />
                                            Trip
                                        </span>
                                        {tripStatus && (
                                            <span id={`${id}-trip-status`} className="diary-trip-status" role="status">
                                                {tripStatus}
                                            </span>
                                        )}
                                    </div>
                                    <span aria-hidden="true" className="diary-trip-value text-white">
                                        {tripLabel}
                                    </span>
                                    <ChevronDown className="diary-select-chevron" />
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
                        </div>

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

                        {/* Media — Photos and their count, the video pill on the
                            same line, then six dashed glass tiles in one row. */}
                        <div className="diary-media">
                            <div className="diary-media-head">
                                <span className="diary-media-label">
                                    <span className="diary-eyebrow">
                                        <CameraGlyph />
                                        Photos
                                    </span>
                                    <span className="diary-count">
                                        {photos.length === 0
                                            ? `Up to ${MAX_PHOTOS}`
                                            : `${photos.length} of ${MAX_PHOTOS}`}
                                    </span>
                                </span>
                                {/* The video pill: its words are its name. The
                                    clip's player opens in a sheet, so a clip going
                                    on or off never moves the text box. */}
                                {videoUrl ? (
                                    <button
                                        type="button"
                                        aria-haspopup="dialog"
                                        aria-expanded={videoOpen}
                                        onClick={() => setVideoOpen(true)}
                                        className="diary-video-pill"
                                        data-state="on"
                                    >
                                        <span className="diary-video-pill-face">
                                            <VideoGlyph />
                                            <span className="diary-video-pill-text">Your video</span>
                                        </span>
                                    </button>
                                ) : isEditing ? (
                                    <span className="diary-video-pill" data-state="note">
                                        <span className="diary-video-pill-face">
                                            <VideoGlyph />
                                            <span className="diary-video-pill-text">Video: new entries</span>
                                        </span>
                                    </span>
                                ) : (
                                    <button
                                        type="button"
                                        onClick={() => videoRef.current?.click()}
                                        disabled={saving || uploading}
                                        className="diary-video-pill"
                                        data-state="add"
                                    >
                                        <span className="diary-video-pill-face">
                                            <VideoGlyph />
                                            <span className="diary-video-pill-text">Add video · 1 min</span>
                                        </span>
                                    </button>
                                )}
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

                        {/* The writing card: the text box takes every pixel that
                            is left, and the ✨ polish and its style sit at its
                            foot. While a polish runs, its note lies over the
                            card's corner, so nothing moves. */}
                        <div className="diary-write">
                            <textarea
                                ref={bodyRef}
                                aria-label="Diary entry text"
                                placeholder={polishing ? 'Styling your entry…' : 'What happened out there?'}
                                value={body}
                                onChange={(e) => onSetBody(e.target.value)}
                                onFocus={scrollInputAboveKeyboard}
                                disabled={polishing}
                                className="diary-body text-gray-200 placeholder-gray-500"
                            />
                            {polishing && (
                                <div className="diary-polishing">
                                    <SparklesIcon className="animate-pulse" />
                                    <span>Styling your entry…</span>
                                </div>
                            )}
                            {/* Polish — the ✨ button, dimmed until the body has
                                enough text to polish, and the style it will apply.
                                The style's native select is laid invisibly over
                                its chip, as on the Trip row; the choice persists
                                via settings.polishStyle. The eyebrow says the
                                select's name, so Voice Control finds it. */}
                            <div className="diary-write-tools">
                                <button
                                    aria-label="Polish entry text"
                                    type="button"
                                    onClick={onPolish}
                                    disabled={polishing || !canPolish}
                                    data-ready={canPolish || polishing}
                                    className={`diary-polish${polishing ? ' animate-pulse' : ''}`}
                                >
                                    {polishing ? (
                                        <span aria-hidden="true" className="diary-spinner animate-spin" />
                                    ) : (
                                        <SparklesIcon />
                                    )}
                                </button>
                                <div className="diary-style">
                                    <span aria-hidden="true" className="diary-eyebrow">
                                        <EditIcon />
                                        Polish style
                                    </span>
                                    <span aria-hidden="true" className="diary-style-value text-white">
                                        <StyleName label={POLISH_LABEL[polishStyle]} />
                                    </span>
                                    <ChevronDown className="diary-select-chevron" />
                                    <select
                                        value={polishStyle}
                                        onChange={(e) => onSetPolishStyle(e.target.value as PolishStyle)}
                                        aria-label="Polish style"
                                        className="plan-tile-select scheme-dark [.display-light_&]:scheme-light"
                                    >
                                        {(Object.entries(POLISH_LABEL) as [PolishStyle, string][]).map(
                                            ([value, label]) => (
                                                <option key={value} value={value}>
                                                    {label}
                                                </option>
                                            ),
                                        )}
                                    </select>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                {/* ═══ SAVE + CANCEL — fixed at bottom ═══ */}
                <div className="diary-compose-foot shrink-0 px-4 border-t border-white/5 bg-slate-950">
                    <div className="diary-compose-column flex gap-3">
                        <button
                            type="button"
                            aria-label="Cancel this action"
                            onClick={onCancel}
                            disabled={saving}
                            className="diary-cancel diary-foot-button press flex flex-1 items-center justify-center rounded-full px-4 text-[15px] font-bold disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                            Cancel
                        </button>
                        <button
                            type="button"
                            aria-label="Save changes"
                            onClick={onSave}
                            disabled={saving || polishing || (!body.trim() && !title.trim() && !audioUrl)}
                            style={SAVE_STYLE}
                            className={`diary-save diary-foot-button press flex flex-2 items-center justify-center gap-2 rounded-full px-5 text-[15px] font-bold disabled:cursor-not-allowed ${
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

                {/* The clip, in the app's centred sheet: the player, and for a
                    new entry the way to take it off again. */}
                <ModalSheet
                    isOpen={videoOpen && !!videoUrl}
                    onClose={() => setVideoOpen(false)}
                    title="Your video"
                    maxWidth="max-w-md"
                >
                    {videoUrl && (
                        <div className="diary-video-sheet">
                            <DiaryVideo src={videoUrl} className="diary-video-player w-full rounded-xl bg-black" />
                            {isEditing ? (
                                <p className="diary-video-caption">A saved entry's video can't be changed yet.</p>
                            ) : (
                                <button
                                    type="button"
                                    onClick={() => {
                                        onVideoRemove();
                                        setVideoOpen(false);
                                    }}
                                    disabled={saving}
                                    className="diary-video-remove"
                                >
                                    Remove the video
                                </button>
                            )}
                        </div>
                    )}
                </ModalSheet>
            </div>
        );
    },
);
