import React from 'react';
import { MOOD, type VoyageLogEntry, type VoyageLogTelemetry, type VoyageLogInstruments } from '../voyageLogApi';
import { TelemetryPanel } from './TelemetryPanel';

interface DiarySidebarProps {
    entries: VoyageLogEntry[];
    telemetry: VoyageLogTelemetry | null;
    instruments?: VoyageLogInstruments | null;
    nowMs: number;
    connectionLost: boolean;
    lastSuccessfulAt: number | null;
    /** Historical/all-diary views deliberately omit present-tense instruments. */
    showTelemetry?: boolean;
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
}

const SHORT_DATE = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const FULL_DATE = new Intl.DateTimeFormat(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
});

const formatDate = (iso: string): string => SHORT_DATE.format(new Date(iso));

const formatFullDate = (iso: string): string => FULL_DATE.format(new Date(iso));

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
            <div className="rounded-xl overflow-hidden border border-slate-700 bg-black">
                <video
                    key={attempt}
                    src={url}
                    controls
                    playsInline
                    preload="metadata"
                    className="w-full"
                    onError={onError}
                />
            </div>
        );
    }
    return (
        <div className="rounded-xl border border-slate-700 bg-slate-900/70 p-4 text-center space-y-2">
            <div className="text-2xl" aria-hidden="true">
                🎥
            </div>
            <p className="text-sm text-slate-300">
                {state === 'pending'
                    ? 'The video is still making its way ashore — it uploads from the boat when she next has internet.'
                    : 'This video could not be played in this browser.'}
            </p>
            <button
                type="button"
                onClick={retry}
                className="min-h-[44px] text-xs font-bold uppercase tracking-wider text-sky-300 border border-sky-400/40 rounded-full px-5 py-1.5 hover:bg-sky-500/15 transition-colors"
            >
                Check again
            </button>
        </div>
    );
};

// ── Detail: a single entry, full content ───────────────────────
const EntryDetail: React.FC<{
    entry: VoyageLogEntry;
    onBack: () => void;
    onPhotoClick: (entry: VoyageLogEntry, index: number) => void;
}> = ({ entry, onBack, onPhotoClick }) => {
    const mood = MOOD[entry.mood];
    return (
        <>
            <div className="shrink-0 px-3 py-2 border-b border-slate-700 bg-slate-800/80 backdrop-blur-md">
                <button
                    type="button"
                    onClick={onBack}
                    aria-label="Back to all entries"
                    className="group flex items-center gap-2.5 pr-3 rounded-full hover:bg-white/5 active:bg-white/10 transition-colors"
                >
                    <span className="flex items-center justify-center w-11 h-11 rounded-full bg-sky-500/15 border border-sky-400/30 text-sky-300 group-hover:bg-sky-500/25 group-hover:text-sky-200 group-active:scale-95 transition-all shadow-xs">
                        <svg
                            className="w-5 h-5"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                            strokeWidth={2.5}
                        >
                            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
                        </svg>
                    </span>
                    <span className="text-xs font-bold text-sky-300 uppercase tracking-wider">All entries</span>
                </button>
            </div>

            <div className="shrink-0 p-4 space-y-4">
                {/* Video — preload metadata only: a follower on a phone must
                    not pull 200MB per entry just to draw a poster frame. */}
                {entry.video_url && <EntryVideo url={entry.video_url} />}
                {/* Photos */}
                {entry.photos.length > 0 && (
                    <div className="grid grid-cols-2 gap-2">
                        {entry.photos.map((url, i) => (
                            <button
                                key={i}
                                type="button"
                                onClick={() => onPhotoClick(entry, i)}
                                aria-label={`View photo ${i + 1}`}
                                className={`rounded-xl overflow-hidden border border-slate-700 bg-slate-900 ${
                                    entry.photos.length === 1 ? 'col-span-2 aspect-video' : 'aspect-square'
                                }`}
                            >
                                <img
                                    src={url}
                                    alt=""
                                    loading="lazy"
                                    className="w-full h-full object-cover transition-transform duration-500 hover:scale-105"
                                />
                            </button>
                        ))}
                    </div>
                )}

                {/* Meta */}
                <div className="space-y-1">
                    <p className="text-[11px] font-mono text-blue-400 uppercase tracking-wider">
                        {formatFullDate(entry.created_at)}
                    </p>
                    <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-base">{mood?.emoji ?? '📍'}</span>
                        {mood && (
                            <span className={`text-xs font-bold uppercase tracking-wider ${mood.color}`}>
                                {mood.label}
                            </span>
                        )}
                        {entry.location_name && (
                            <span className="text-xs text-slate-500 truncate">· {entry.location_name}</span>
                        )}
                        {entry.author && (
                            <span className="text-[10px] font-bold uppercase tracking-wider text-amber-300/90 bg-amber-400/10 border border-amber-400/20 rounded-full px-2 py-0.5">
                                by {entry.author.display_name}
                            </span>
                        )}
                    </div>
                </div>

                {/* Title + body */}
                {entry.title && <h2 className="text-lg font-bold text-white leading-tight">{entry.title}</h2>}
                {entry.body && (
                    <p className="text-sm text-slate-200 leading-relaxed whitespace-pre-line">{entry.body}</p>
                )}

                {/* Weather */}
                {entry.weather_summary && (
                    <div className="flex items-center gap-2 pt-2 border-t border-slate-700/60 text-[11px] font-mono text-slate-400">
                        <span className="text-slate-500">⛅</span>
                        <span>{entry.weather_summary}</span>
                    </div>
                )}
            </div>
        </>
    );
};

// ── List: the full feed ────────────────────────────────────────
const EntryList: React.FC<{
    entries: VoyageLogEntry[];
    onSelectEntry: (entry: VoyageLogEntry) => void;
    title?: string;
    context?: string;
    emptyMessage?: string;
}> = React.memo(function EntryList({
    entries,
    onSelectEntry,
    title = 'Voyage Log',
    context,
    emptyMessage = 'No log entries published yet.',
}) {
    return (
        <>
            <div className="shrink-0 px-4 py-3 border-b border-slate-700 bg-slate-800/80 backdrop-blur-md">
                <h2 className="text-base font-bold text-white truncate">{title}</h2>
                <p className="text-[11px] text-slate-400 uppercase tracking-widest">
                    {context ? (
                        <>
                            <span className="normal-case tracking-normal">{context}</span>
                            <span className="text-slate-500"> · </span>
                        </>
                    ) : null}
                    {entries.length} {entries.length === 1 ? 'Entry' : 'Entries'}
                </p>
            </div>

            {entries.length === 0 ? (
                <div className="shrink-0 flex flex-col items-center justify-center text-center px-8 py-8 gap-2">
                    <span className="text-3xl">🧭</span>
                    <p className="text-sm text-slate-400">{emptyMessage}</p>
                    <p className="text-xs text-slate-500">
                        {context
                            ? 'Choose another voyage to explore its published record.'
                            : 'Check back once the passage is underway.'}
                    </p>
                </div>
            ) : (
                <div className="shrink-0 p-3 space-y-3">
                    {entries.map((entry) => {
                        const mood = MOOD[entry.mood];
                        return (
                            <button
                                key={entry.id}
                                type="button"
                                onClick={() => onSelectEntry(entry)}
                                className="block w-full text-left rounded-xl border border-slate-700/70 bg-slate-900/40 hover:bg-slate-900/80 hover:border-blue-500/50 transition-colors p-3"
                            >
                                <div className="flex justify-between items-baseline gap-2 mb-1">
                                    <span className="text-[10px] font-mono text-blue-400 uppercase shrink-0">
                                        {formatDate(entry.created_at)}
                                    </span>
                                    <span className="text-[10px] text-slate-500 font-mono truncate">
                                        {entry.location_name}
                                    </span>
                                </div>
                                <div className="flex items-center gap-1.5 mb-1">
                                    <span className="text-sm">{mood?.emoji ?? '📍'}</span>
                                    <h3 className="text-sm font-bold text-white truncate">
                                        {entry.title || 'Untitled'}
                                    </h3>
                                    {entry.author && (
                                        <span className="ml-auto shrink-0 text-[9px] font-bold uppercase tracking-wider text-amber-300/90 bg-amber-400/10 border border-amber-400/20 rounded-full px-1.5 py-0.5">
                                            {entry.author.display_name}
                                        </span>
                                    )}
                                </div>
                                {entry.body && (
                                    <p className="text-xs text-slate-400 leading-relaxed line-clamp-2">{entry.body}</p>
                                )}
                                {entry.photos.length === 0 && entry.video_url && (
                                    <span className="mt-2 inline-block text-[10px] font-bold text-slate-500">
                                        🎥 video
                                    </span>
                                )}
                                {entry.photos.length > 0 && (
                                    <div className="flex items-center gap-1.5 mt-2">
                                        <div className="flex -space-x-1.5">
                                            {entry.photos.slice(0, 3).map((url, i) => (
                                                <img
                                                    key={i}
                                                    src={url}
                                                    alt=""
                                                    loading="lazy"
                                                    className="w-7 h-7 rounded-md object-cover border border-slate-700 ring-1 ring-slate-900"
                                                />
                                            ))}
                                        </div>
                                        <span className="text-[10px] font-bold text-slate-500">
                                            📷 {entry.photos.length}
                                            {entry.video_url ? ' · 🎥' : ''}
                                        </span>
                                    </div>
                                )}
                            </button>
                        );
                    })}
                </div>
            )}
        </>
    );
});

export default function DiarySidebar({
    entries,
    instruments,
    nowMs,
    connectionLost,
    lastSuccessfulAt,
    showTelemetry = false,
    title,
    context,
    emptyMessage,
    selectedEntry,
    onSelectEntry,
    onClearSelection,
    onPhotoClick,
}: DiarySidebarProps) {
    const scrollRef = React.useRef<HTMLDivElement>(null);
    React.useEffect(() => {
        if (scrollRef.current) scrollRef.current.scrollTop = 0;
    }, [selectedEntry?.id, title]);
    return (
        <div ref={scrollRef} className="flex min-h-0 flex-1 flex-col bg-slate-900 md:overflow-y-auto">
            {/* Current readings require explicit consent in latest mode.
                They can be live at the berth without an active voyage; a
                deliberately selected historical trip never receives them. */}
            {showTelemetry && (
                <TelemetryPanel
                    instruments={instruments ?? null}
                    nowMs={nowMs}
                    connectionLost={connectionLost}
                    lastSuccessfulAt={lastSuccessfulAt}
                />
            )}
            {selectedEntry ? (
                <EntryDetail entry={selectedEntry} onBack={onClearSelection} onPhotoClick={onPhotoClick} />
            ) : (
                <EntryList
                    entries={entries}
                    onSelectEntry={onSelectEntry}
                    title={title}
                    context={context}
                    emptyMessage={emptyMessage}
                />
            )}
        </div>
    );
}
