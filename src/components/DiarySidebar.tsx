import React from 'react';
import { MOOD, type VoyageLogEntry, type VoyageLogTelemetry } from '../voyageLogApi';
import { TelemetryPanel } from './TelemetryPanel';

interface DiarySidebarProps {
    entries: VoyageLogEntry[];
    telemetry: VoyageLogTelemetry | null;
    /** When set, the box shows just this entry instead of the full feed. */
    selectedEntry: VoyageLogEntry | null;
    onSelectEntry: (entry: VoyageLogEntry) => void;
    onClearSelection: () => void;
    onPhotoClick: (entry: VoyageLogEntry, index: number) => void;
}

const formatDate = (iso: string): string =>
    new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

const formatFullDate = (iso: string): string =>
    new Date(iso).toLocaleDateString(undefined, {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric',
    });

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
                    <span className="flex items-center justify-center w-11 h-11 rounded-full bg-sky-500/15 border border-sky-400/30 text-sky-300 group-hover:bg-sky-500/25 group-hover:text-sky-200 group-active:scale-95 transition-all shadow-sm">
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

            <div className="flex-1 overflow-y-auto p-4 space-y-4">
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
}> = ({ entries, onSelectEntry }) => {
    return (
        <>
            <div className="shrink-0 px-4 py-3 border-b border-slate-700 bg-slate-800/80 backdrop-blur-md">
                <h2 className="text-base font-bold text-white">Voyage Log</h2>
                <p className="text-[11px] text-slate-400 uppercase tracking-widest">
                    {entries.length} {entries.length === 1 ? 'Entry' : 'Entries'}
                </p>
            </div>

            {entries.length === 0 ? (
                <div className="flex-1 flex flex-col items-center justify-center text-center px-8 gap-2">
                    <span className="text-3xl">🧭</span>
                    <p className="text-sm text-slate-400">No log entries published yet.</p>
                    <p className="text-xs text-slate-500">Check back once the passage is underway.</p>
                </div>
            ) : (
                <div className="flex-1 overflow-y-auto p-3 space-y-2">
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
};

export default function DiarySidebar({
    entries,
    telemetry,
    selectedEntry,
    onSelectEntry,
    onClearSelection,
    onPhotoClick,
}: DiarySidebarProps) {
    return (
        <div className="flex flex-col h-full bg-slate-800">
            {telemetry && <TelemetryPanel telemetry={telemetry} />}
            {selectedEntry ? (
                <EntryDetail entry={selectedEntry} onBack={onClearSelection} onPhotoClick={onPhotoClick} />
            ) : (
                <EntryList entries={entries} onSelectEntry={onSelectEntry} />
            )}
        </div>
    );
}
