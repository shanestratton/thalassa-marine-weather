import React from 'react';
import {
    MOOD,
    type PublicVoyageTrip,
    type VoyageLogEntry,
    type VoyageLogTelemetry,
    type VoyageLogInstruments,
} from '../voyageLogApi';
import { InstrumentsNotShared, TelemetryPanel } from './TelemetryPanel';
import { PublicDiaryComments } from './PublicDiaryComments';
import { PassageStats } from './PassageStats';
import { isAutoDateTitle, passageFacts } from './voyageStory';
import { newestDiaryEntries } from '../publicDiaryDefaults';

export type PublicVoyagePanel = 'instruments' | 'diary';

interface DiarySidebarProps {
    /** Public vessel handle, scoped by the comment API on every request. */
    publicHandle?: string;
    entries: VoyageLogEntry[];
    telemetry: VoyageLogTelemetry | null;
    instruments?: VoyageLogInstruments | null;
    nowMs: number;
    connectionLost: boolean;
    lastSuccessfulAt: number | null;
    /** Historical/all-diary views deliberately omit present-tense instruments. */
    showTelemetry?: boolean;
    /** Latest view only: explain withheld sharing without exposing readings. */
    showSharingNotice?: boolean;
    /** The public panel is instruments OR diary, never both. */
    view?: PublicVoyagePanel;
    /** The selected trip's public-facing name. */
    title?: string;
    /** A short context line below the title. */
    context?: string;
    emptyMessage?: string;
    /** When set, the box shows just this entry instead of the full feed. */
    selectedEntry: VoyageLogEntry | null;
    onSelectEntry: (entry: VoyageLogEntry) => void;
    onClearSelection: () => void;
    onPhotoClick: (entry: VoyageLogEntry, index: number) => void;
    /** The selected track, for the chapter head's passage facts; null in journey mode. */
    trip?: PublicVoyageTrip | null;
    /** Every public trip, for the whole-journey totals. */
    trips?: PublicVoyageTrip[];
    /** Set while a picker change resolves; the old list dims until it lands. */
    loadingLabel?: string | null;
    /** Offered on an empty trip: open the whole-journey diary, staying on Diary. */
    onShowWholeJourney?: () => void;
    /** Offered on an empty trip when instruments are shared. */
    onShowInstruments?: () => void;
    /** Offered when a historic trip or the whole journey is showing. */
    onShowLatest?: () => void;
}

/** A stable empty list, so the chapter head never sees a fresh [] per render. */
const NO_TRIPS: PublicVoyageTrip[] = [];

const FULL_DATE = new Intl.DateTimeFormat(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
});
const CARD_DATE = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
const CARD_DATE_YEAR = new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
});

const formatFullDate = (iso: string): string => FULL_DATE.format(new Date(iso));

/** 'Fri 25 Sep', with the year only when it is not this year. The locale
 *  keeps its own order, words and marks; only the list commas go, so the
 *  brass kicker reads as one quiet run ('FRI 25 SEP · HAMILTON ISLAND'). */
const cardDate = (iso: string): string => {
    const date = new Date(iso);
    const format = date.getFullYear() === new Date().getFullYear() ? CARD_DATE : CARD_DATE_YEAR;
    return format
        .formatToParts(date)
        .map((part) => (part.type === 'literal' ? part.value.replace(/[,،、，]/g, ' ') : part.value))
        .join('')
        .replace(/\s+/g, ' ')
        .trim();
};

/**
 * Date and place for the brass kicker. An automatic title such as
 * 'Tuesday 22 September 2026 · 09:15' already says when, so the kicker
 * then carries the place only.
 */
const entryKicker = (entry: VoyageLogEntry, formatDate: (iso: string) => string): string => {
    const autoTitle = !!entry.title && isAutoDateTitle(entry.title);
    return [autoTitle ? null : formatDate(entry.created_at), entry.location_name].filter(Boolean).join(' · ');
};

const BackChevron = () => (
    <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5} aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
    </svg>
);

const FilmIcon = () => (
    <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
        <rect x="3" y="5" width="18" height="14" rx="2" />
        <path strokeLinecap="round" d="M7 5v14M17 5v14M3 9.5h4M3 14.5h4M17 9.5h4M17 14.5h4" />
    </svg>
);

// ── Video: may still be crossing from the boat ─────────────────
/**
 * A clip parks on the boat's Pi and uploads whenever she next has internet,
 * while the entry publishes immediately with the video's final URL — so a
 * public entry can point at an object that is still an anchorage away. A dead
 * player with a crossed-out button reads as "broken"; say what is actually
 * happening instead. A HEAD probe separates "not ashore yet" (the bucket
 * 404s) from a genuine can't-play-this-here failure.
 */
const EntryVideo: React.FC<{ url: string }> = ({ url }) => {
    const [state, setState] = React.useState<'ok' | 'pending' | 'unplayable'>('ok');
    const [attempt, setAttempt] = React.useState(0);
    // A new entry (opened from a map pin while this one showed a pending or
    // unplayable notice) starts fresh rather than inheriting that notice.
    const [shownUrl, setShownUrl] = React.useState(url);
    if (shownUrl !== url) {
        setShownUrl(url);
        setState('ok');
        setAttempt(0);
    }

    const onError = () => {
        fetch(url, { method: 'HEAD' })
            .then((res) => setState(res.ok ? 'unplayable' : 'pending'))
            .catch(() => setState('pending'));
    };
    const retry = () => {
        setState('ok');
        setAttempt((n) => n + 1);
    };

    if (state === 'ok') {
        return (
            <figure className="pv-video">
                <figcaption className="pv-video__label">Video · tap to play</figcaption>
                <video
                    key={attempt}
                    src={url}
                    controls
                    playsInline
                    preload="metadata"
                    onError={onError}
                    className="block w-full"
                />
            </figure>
        );
    }
    return (
        <div className="pv-pending flex flex-col items-center gap-3">
            <FilmIcon />
            <p>
                {state === 'pending'
                    ? 'The video is still making its way ashore — it uploads from the boat when she next has internet.'
                    : 'This video could not be played in this browser.'}
            </p>
            <button type="button" onClick={retry} className="pv-btn pv-btn--ghost">
                Check again
            </button>
        </div>
    );
};

// ── Detail: a single entry, full content ───────────────────────
const EntryDetail: React.FC<{
    publicHandle?: string;
    entry: VoyageLogEntry;
    onBack: () => void;
    onPhotoClick: (entry: VoyageLogEntry, index: number) => void;
}> = ({ publicHandle, entry, onBack, onPhotoClick }) => {
    const mood = MOOD[entry.mood];
    const kicker = entryKicker(entry, formatFullDate);
    const photos = entry.photos;
    // Headline first, then the lead picture: a video leads when there is
    // one, otherwise the first photo. The gallery keeps true photo indices
    // so the lightbox opens on the photo that was tapped.
    const photoLead = !entry.video_url && photos.length > 0;
    const gallery = photos.map((url, index) => ({ url, index })).slice(photoLead ? 1 : 0);
    const single = gallery.length === 1;
    return (
        <>
            {/* Sticky inside #voyage-panel-content, so the way back stays in reach. */}
            <div className="pv-detail-bar shrink-0">
                <button
                    type="button"
                    onClick={onBack}
                    aria-label="Back to all entries"
                    className="pv-back inline-flex items-center gap-1.5"
                >
                    <BackChevron />
                    <span>All entries</span>
                </button>
            </div>

            <article className="pv-article flex shrink-0 flex-col gap-4">
                <header className="flex flex-col gap-2">
                    {kicker && <p className="pv-kicker">{kicker}</p>}
                    {entry.title && <h2 className="pv-article__title">{entry.title}</h2>}
                    <p className="pv-byline flex flex-wrap items-center gap-x-2 gap-y-1">
                        {entry.author && <span>by {entry.author.display_name}</span>}
                        <span>
                            <span aria-hidden="true">{mood?.emoji ?? '📍'}</span>{' '}
                            {mood && (
                                <span className="pv-mood" style={{ color: mood.hex }}>
                                    {mood.label}
                                </span>
                            )}
                        </span>
                    </p>
                </header>

                {/* Video — preload metadata only: a follower on a phone must
                    not pull 200MB per entry just to draw a poster frame. */}
                {entry.video_url ? (
                    <EntryVideo url={entry.video_url} />
                ) : photoLead ? (
                    <button
                        type="button"
                        className="pv-lead-media block"
                        aria-label="View photo 1"
                        onClick={() => onPhotoClick(entry, 0)}
                    >
                        <img src={photos[0]} alt="" loading="lazy" />
                    </button>
                ) : null}

                {entry.body && <p className="pv-article__body">{entry.body}</p>}

                {gallery.length > 0 && (
                    <div className="grid grid-cols-2 gap-2">
                        {gallery.map(({ url, index }) => (
                            <button
                                key={index}
                                type="button"
                                onClick={() => onPhotoClick(entry, index)}
                                aria-label={`View photo ${index + 1}`}
                                className={`pv-photo block ${single ? 'col-span-2 aspect-video' : 'aspect-square'}`}
                            >
                                <img src={url} alt="" loading="lazy" />
                            </button>
                        ))}
                    </div>
                )}

                {/* Weather — the summary keeps its own element. */}
                {entry.weather_summary && (
                    <p className="pv-weather flex items-center gap-2">
                        <span aria-hidden="true">⛅</span>
                        <span>{entry.weather_summary}</span>
                    </p>
                )}
                {publicHandle && <PublicDiaryComments handle={publicHandle} entryId={entry.id} />}
            </article>
        </>
    );
};

// ── Chapter head: which part of the voyage this is ─────────────
/**
 * Not memoised on purpose: it reads the 30 s clock for an active trip's
 * "Time so far". The photo cards live in EntryFeed, which is.
 */
const ChapterHead: React.FC<{
    title: string;
    context?: string;
    count: number;
    trip: PublicVoyageTrip | null;
    trips: PublicVoyageTrip[];
    nowMs: number;
    loadingLabel?: string | null;
    onShowLatest?: () => void;
}> = ({ title, context, count, trip, trips, nowMs, loadingLabel, onShowLatest }) => {
    const stats = passageFacts({ trip, trips, nowMs, journey: !trip, entryCount: count });
    return (
        <div className="pv-chapter relative flex shrink-0 flex-col gap-1">
            <h2 className="pv-chapter__title">{title}</h2>
            <p className="pv-chapter__meta pv-num">
                {context && <>{context} · </>}
                {count} {count === 1 ? 'entry' : 'entries'}
            </p>
            {stats.length > 0 && (
                <PassageStats
                    stats={stats}
                    label={trip ? 'This trip' : 'Whole journey'}
                    className="mt-2 grid grid-cols-[repeat(auto-fit,minmax(90px,1fr))] gap-2 lg:hidden"
                />
            )}
            {/* Always mounted, so a screen reader hears the label arrive: a
                live region inserted together with its text is often missed.
                Deliberately aria-live, NOT role='status': the page keeps that
                for its connection and instrument notices. */}
            <p
                className={loadingLabel ? 'pv-chapter__loading mt-2 flex items-center gap-2' : 'sr-only'}
                aria-live="polite"
            >
                {loadingLabel && (
                    <>
                        <span className="pv-spinner" aria-hidden="true" />
                        {loadingLabel}
                    </>
                )}
            </p>
            {onShowLatest && (
                <div className="pv-chapter__note mt-2 flex flex-wrap items-center justify-between gap-2">
                    <span>Live instruments show on the latest trip.</span>
                    <button type="button" className="pv-btn pv-btn--quiet" onClick={onShowLatest}>
                        Go to the latest trip
                    </button>
                </div>
            )}
        </div>
    );
};

// ── Empty chapter: a way on, not a dead end ────────────────────
const EmptyChapter: React.FC<{
    emptyMessage: string;
    context?: string;
    onShowWholeJourney?: () => void;
    onShowInstruments?: () => void;
    /** A picker change is resolving: dim the old chapter, as the feed does. */
    busy: boolean;
}> = ({ emptyMessage, context, onShowWholeJourney, onShowInstruments, busy }) => (
    <div
        className={`pv-empty m-4 flex shrink-0 flex-col items-center gap-3 text-center ${busy ? 'pointer-events-none opacity-50' : ''}`}
        aria-busy={busy || undefined}
    >
        <svg className="pv-empty__art" viewBox="0 0 120 56" fill="none" aria-hidden="true">
            <path
                d="M10 42 C34 10 58 52 84 22 S106 14 110 12"
                stroke="currentColor"
                strokeWidth={2}
                strokeDasharray="4 5"
                strokeLinecap="round"
            />
            <circle cx={10} cy={42} r={4} stroke="currentColor" strokeWidth={2} style={{ fill: 'var(--pv-hull)' }} />
            <circle cx={110} cy={12} r={4} style={{ fill: 'var(--pv-brass)' }} />
        </svg>
        <p className="pv-empty__title">{emptyMessage}</p>
        <p className="pv-empty__body">
            {onShowWholeJourney
                ? 'The whole-journey diary gathers every public story and photo in one place.'
                : context
                  ? 'Choose another voyage to explore its published record.'
                  : 'Check back once the passage is underway.'}
        </p>
        {(onShowWholeJourney || onShowInstruments) && (
            <div className="flex w-full flex-col items-stretch gap-2.5">
                {onShowWholeJourney && (
                    <button type="button" className="pv-btn pv-btn--primary" onClick={onShowWholeJourney}>
                        Read the whole voyage diary
                    </button>
                )}
                {onShowInstruments && (
                    <button type="button" className="pv-btn pv-btn--ghost" onClick={onShowInstruments}>
                        See what the boat is doing now
                    </button>
                )}
            </div>
        )}
    </div>
);

// ── Feed: the dispatch cards ───────────────────────────────────
/**
 * Memoised with stable props only (entries, the dashboard's useCallback
 * handler and a boolean), so the 30 s clock never re-renders the photos.
 * The entry titles are the ONLY h3 elements in the list.
 */
const EntryFeed: React.FC<{
    entries: VoyageLogEntry[];
    onSelectEntry: (entry: VoyageLogEntry) => void;
    busy: boolean;
}> = React.memo(function EntryFeed({ entries, onSelectEntry, busy }) {
    const sortedEntries = React.useMemo(() => newestDiaryEntries(entries), [entries]);
    return (
        <div className="pv-feed flex shrink-0 flex-col gap-3" aria-busy={busy || undefined}>
            {sortedEntries.map((entry) => {
                const mood = MOOD[entry.mood];
                const kicker = entryKicker(entry, cardDate);
                const photos = entry.photos;
                const videoOnly = photos.length === 0 && !!entry.video_url;
                return (
                    <button
                        key={entry.id}
                        type="button"
                        onClick={() => onSelectEntry(entry)}
                        className="pv-entry block"
                    >
                        {photos.length > 0 && (
                            <span className="pv-entry__media relative block">
                                <img src={photos[0]} alt="" loading="lazy" decoding="async" />
                                <span className="absolute bottom-2 right-2 flex gap-1.5">
                                    {photos.length > 1 && <span className="pv-badge pv-num">+{photos.length - 1}</span>}
                                    {entry.video_url && <span className="pv-badge">▶ Video</span>}
                                </span>
                            </span>
                        )}
                        <span className="pv-entry__body flex flex-col gap-1.5">
                            {kicker && <span className="pv-kicker">{kicker}</span>}
                            <h3 className="pv-entry__title">{entry.title || 'Untitled'}</h3>
                            {entry.body && <span className="pv-entry__excerpt">{entry.body}</span>}
                            {(entry.author || videoOnly || mood) && (
                                <span className="pv-entry__meta flex flex-wrap items-center gap-x-3 gap-y-1">
                                    {entry.author && <span>by {entry.author.display_name}</span>}
                                    {/* Video-only entries still advertise their clip in the list. */}
                                    {videoOnly && <span className="pv-badge">▶ Video</span>}
                                    {mood && (
                                        <span role="img" aria-label={`Mood: ${mood.label}`} title={mood.label}>
                                            {mood.emoji}
                                        </span>
                                    )}
                                </span>
                            )}
                        </span>
                    </button>
                );
            })}
        </div>
    );
});

export default function DiarySidebar({
    publicHandle,
    entries,
    instruments,
    nowMs,
    connectionLost,
    lastSuccessfulAt,
    showTelemetry = false,
    showSharingNotice = false,
    view = showTelemetry || showSharingNotice ? 'instruments' : 'diary',
    title = 'Voyage Log',
    context,
    emptyMessage = 'No log entries published yet.',
    selectedEntry,
    onSelectEntry,
    onClearSelection,
    onPhotoClick,
    trip = null,
    trips,
    loadingLabel = null,
    onShowWholeJourney,
    onShowInstruments,
    onShowLatest,
}: DiarySidebarProps) {
    const scrollRef = React.useRef<HTMLDivElement>(null);
    React.useEffect(() => {
        if (scrollRef.current) scrollRef.current.scrollTop = 0;
    }, [selectedEntry?.id, title, view]);
    return (
        <div
            id="voyage-panel-content"
            ref={scrollRef}
            role="region"
            aria-label={view === 'instruments' ? 'Instruments content' : 'Diary content'}
            tabIndex={0}
            className="pv-scroll flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto overscroll-contain pb-4 [overflow-wrap:anywhere]"
        >
            {/* Current readings require explicit consent in latest mode.
                They can be live at the berth without an active voyage; a
                deliberately selected historical trip never receives them. */}
            {view === 'instruments' ? (
                showTelemetry ? (
                    <TelemetryPanel
                        instruments={instruments ?? null}
                        nowMs={nowMs}
                        connectionLost={connectionLost}
                        lastSuccessfulAt={lastSuccessfulAt}
                    />
                ) : showSharingNotice ? (
                    <InstrumentsNotShared />
                ) : null
            ) : selectedEntry ? (
                <EntryDetail
                    publicHandle={publicHandle}
                    entry={selectedEntry}
                    onBack={onClearSelection}
                    onPhotoClick={onPhotoClick}
                />
            ) : (
                <>
                    <ChapterHead
                        title={title}
                        context={context}
                        count={entries.length}
                        trip={trip}
                        trips={trips ?? NO_TRIPS}
                        nowMs={nowMs}
                        loadingLabel={loadingLabel}
                        onShowLatest={onShowLatest}
                    />
                    {entries.length === 0 ? (
                        <EmptyChapter
                            emptyMessage={emptyMessage}
                            context={context}
                            onShowWholeJourney={onShowWholeJourney}
                            onShowInstruments={onShowInstruments}
                            busy={!!loadingLabel}
                        />
                    ) : (
                        <EntryFeed entries={entries} onSelectEntry={onSelectEntry} busy={!!loadingLabel} />
                    )}
                </>
            )}
            <footer className="pv-colophon mt-auto flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-1">
                <span>Voyage log · Thalassa</span>
                {/* Skipper door — the public log page's only outbound link.
                    RELATIVE /plan (Shane 2026-07-17: "it defaults back to
                    www.thalassawx.app/plan rather than boat-name.thalassawx.app
                    /plan"). This tracking page is served on the vessel
                    subdomain, so a relative link keeps the punter on THEIR
                    boat's planner (serene-summer.thalassawx.app/plan) — the
                    old absolute apex link 308-redirected to www and dropped
                    the handle. Sign-in happens on the subdomain now (its own
                    per-origin session), which is the intended per-vessel model.
                    Still supabase-free here — a plain <a>, not an auth flow. */}
                <a href="/plan" className="pv-link" title="Skipper? Sign in and build a passage on the big screen">
                    Skipper sign in
                </a>
            </footer>
        </div>
    );
}
