import React from 'react';
import { MOOD, type VoyageLogEntry } from '../voyageLogApi';

interface DiarySidebarProps {
    entries: VoyageLogEntry[];
    onEntryClick: (entry: VoyageLogEntry) => void;
}

const formatDate = (iso: string): string =>
    new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

export default function DiarySidebar({ entries, onEntryClick }: DiarySidebarProps) {
    return (
        <div className="flex flex-col h-full bg-slate-800">
            {/* Header */}
            <div className="p-5 border-b border-slate-700 bg-slate-800/80 backdrop-blur-md sticky top-0 z-10">
                <h2 className="text-xl font-bold text-white">Voyage Log</h2>
                <p className="text-xs text-slate-400 mt-1 uppercase tracking-widest">
                    {entries.length} {entries.length === 1 ? 'Entry' : 'Entries'}
                </p>
            </div>

            {/* Feed */}
            {entries.length === 0 ? (
                <div className="flex-1 flex flex-col items-center justify-center text-center px-8 gap-2">
                    <span className="text-3xl">🧭</span>
                    <p className="text-sm text-slate-400">No log entries published yet.</p>
                    <p className="text-xs text-slate-500">Check back once the passage is underway.</p>
                </div>
            ) : (
                <div className="flex-1 overflow-y-auto p-4 space-y-6">
                    {entries.map((entry) => {
                        const mood = MOOD[entry.mood];
                        const canFocus = entry.latitude != null && entry.longitude != null;
                        return (
                            <button
                                key={entry.id}
                                type="button"
                                onClick={() => onEntryClick(entry)}
                                disabled={!canFocus}
                                className={`group block w-full text-left border-l-2 border-slate-700 pl-4 transition-all ${
                                    canFocus ? 'hover:border-blue-500 cursor-pointer' : 'cursor-default'
                                }`}
                            >
                                {/* Meta row */}
                                <div className="flex justify-between items-baseline mb-1.5 gap-2">
                                    <span className="text-[10px] font-mono text-blue-400 uppercase shrink-0">
                                        {formatDate(entry.created_at)}
                                    </span>
                                    <span className="text-[10px] text-slate-500 font-mono truncate">
                                        {entry.location_name}
                                    </span>
                                </div>

                                {/* Title + mood */}
                                {entry.title && (
                                    <div className="flex items-center gap-1.5 mb-1">
                                        <span className="text-sm">{mood?.emoji ?? '📍'}</span>
                                        <h3 className="text-sm font-bold text-white truncate">{entry.title}</h3>
                                    </div>
                                )}

                                {/* Body */}
                                {entry.body && (
                                    <p className="text-sm text-slate-300 leading-relaxed mb-3 whitespace-pre-line line-clamp-6">
                                        {entry.body}
                                    </p>
                                )}

                                {/* Photos */}
                                {entry.photos.length > 0 && (
                                    <div className="grid grid-cols-3 gap-1.5 mb-3">
                                        {entry.photos.slice(0, 6).map((url, i) => (
                                            <div
                                                key={i}
                                                className="aspect-square rounded-lg overflow-hidden border border-slate-700 bg-slate-900"
                                            >
                                                <img
                                                    src={url}
                                                    alt=""
                                                    loading="lazy"
                                                    className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                                                />
                                            </div>
                                        ))}
                                    </div>
                                )}

                                {/* Weather stamp */}
                                {entry.weather_summary && (
                                    <div className="flex items-center gap-2 py-1.5 border-t border-slate-700/50 text-[10px] font-mono text-slate-400">
                                        <span className="text-slate-500">⛅</span>
                                        <span className="truncate">{entry.weather_summary}</span>
                                    </div>
                                )}
                            </button>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
