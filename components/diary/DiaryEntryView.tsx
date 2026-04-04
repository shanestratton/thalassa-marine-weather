/**
 * DiaryEntryView — Full-screen read view for a single diary entry.
 *
 * Extracted from DiaryPage to reduce component size.
 */

import React from 'react';
import { DiaryEntry, MOOD_CONFIG } from '../../services/DiaryService';
import { AudioWidget } from './AudioWidget';
import { UndoToast } from '../ui/UndoToast';

// ── Helpers ─────────────────────────────────────────────────────
const formatDate = (iso: string): string => {
    const d = new Date(iso);
    return d.toLocaleDateString('en-AU', {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        year: 'numeric',
    });
};

const formatTime = (iso: string): string => {
    return new Date(iso).toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' });
};

const formatCoord = (lat: number, lon: number): string => {
    const latDir = lat >= 0 ? 'N' : 'S';
    const lonDir = lon >= 0 ? 'E' : 'W';
    return `${Math.abs(lat).toFixed(4)}°${latDir}, ${Math.abs(lon).toFixed(4)}°${lonDir}`;
};

interface DiaryEntryViewProps {
    entry: DiaryEntry;
    firstName?: string;
    isPlaying: boolean;
    transcribing: boolean;
    deletedItem: DiaryEntry | null;
    onBack: () => void;
    onEdit: (entry: DiaryEntry) => void;
    onTogglePlayback: (url: string) => void;
    onTranscribe: (url: string) => void;
    onUndo: () => void;
    onDismissDelete: () => void;
}

export const DiaryEntryView: React.FC<DiaryEntryViewProps> = React.memo(
    ({
        entry: e,
        firstName,
        isPlaying,
        transcribing,
        deletedItem,
        onBack,
        onEdit,
        onTogglePlayback,
        onTranscribe,
        onUndo,
        onDismissDelete,
    }) => {
        const moodCfg = MOOD_CONFIG[e.mood] || MOOD_CONFIG.neutral;
        const hasCoords = e.latitude != null && e.longitude != null;

        return (
            <div className="flex flex-col h-full bg-slate-950 text-white">
                {/* Header */}
                <div className="shrink-0 px-4 pt-4 pb-3">
                    <div className="flex items-center gap-3">
                        <button
                            aria-label="Go back"
                            onClick={onBack}
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
                        <div className="flex-1 min-w-0">
                            <h1 className="text-lg font-extrabold text-white truncate">{e.title}</h1>
                        </div>
                        <button
                            aria-label="Edit item details"
                            onClick={() => onEdit(e)}
                            className="p-2 rounded-xl bg-white/5 hover:bg-white/10 transition-colors"
                        >
                            <svg
                                className="w-5 h-5 text-sky-400"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                                strokeWidth={1.5}
                            >
                                <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10"
                                />
                            </svg>
                        </button>
                    </div>
                </div>

                {/* Content */}
                <div className="flex-1 overflow-y-auto">
                    {e.photos.length > 0 && (
                        <div className="flex gap-1 overflow-x-auto snap-x snap-mandatory">
                            {e.photos.map((url, i) => (
                                <img
                                    key={i}
                                    src={url}
                                    alt=""
                                    className="w-full h-56 object-cover snap-center shrink-0"
                                />
                            ))}
                        </div>
                    )}

                    <div className="p-5 space-y-4">
                        {/* 1. Date & Time */}
                        <div className="flex items-center gap-2 text-xs text-gray-400">
                            <span className="font-mono">{formatDate(e.created_at)}</span>
                            <span>•</span>
                            <span className="font-mono">{formatTime(e.created_at)}</span>
                        </div>

                        {/* 2. Heading — {Name}'s Diary: {title} */}
                        <h2 className="text-lg font-extrabold text-white leading-tight">
                            {firstName ? `${firstName}'s Diary: ` : ''}
                            {e.title || 'Untitled'}
                        </h2>

                        {/* 3. Mood badge */}
                        <div className="flex items-center gap-2">
                            <span className="text-lg">{moodCfg.emoji}</span>
                            <span className={`text-sm font-bold uppercase tracking-wider ${moodCfg.color}`}>
                                {moodCfg.label}
                            </span>
                        </div>

                        {/* 4. Body (diary text) */}
                        {e.body && (
                            <div className="text-sm text-gray-200 leading-relaxed whitespace-pre-wrap">{e.body}</div>
                        )}

                        {/* 5. Voice Memo */}
                        {e.audio_url && (
                            <AudioWidget
                                url={e.audio_url}
                                isPlaying={isPlaying}
                                transcribing={transcribing}
                                onTogglePlayback={onTogglePlayback}
                                onTranscribe={onTranscribe}
                                allowTranscribe={true}
                            />
                        )}

                        {/* 6. Tags */}
                        {e.tags.length > 0 && (
                            <div className="flex flex-wrap gap-2 pt-2">
                                {e.tags.map((tag) => (
                                    <span
                                        key={tag}
                                        className="text-[11px] font-bold text-sky-400/60 bg-sky-500/10 px-2 py-1 rounded-full uppercase tracking-wider"
                                    >
                                        #{tag}
                                    </span>
                                ))}
                            </div>
                        )}

                        {/* 7. Pin Location + Weather (only if pin dropped) */}
                        {hasCoords && (
                            <div className="bg-gradient-to-br from-sky-500/[0.06] to-emerald-500/[0.04] border border-white/[0.08] rounded-2xl p-4 space-y-3">
                                {/* Position */}
                                <div className="flex items-center gap-2.5">
                                    <div className="p-2 bg-sky-500/15 rounded-lg">
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
                                    </div>
                                    <div className="flex-1">
                                        <p className="text-[11px] font-bold text-sky-400/60 uppercase tracking-wider">
                                            Position
                                        </p>
                                        <p className="text-sm font-bold text-white font-mono tracking-wide">
                                            {formatCoord(e.latitude!, e.longitude!)}
                                        </p>
                                        {e.location_name && !e.location_name.includes('°') && (
                                            <p className="text-xs text-gray-400 mt-0.5">{e.location_name}</p>
                                        )}
                                    </div>
                                </div>

                                {/* Weather Grid (only if weather_data exists) */}
                                {e.weather_data && (
                                    <div className="border-t border-white/[0.06] pt-3">
                                        <p className="text-[11px] font-bold text-emerald-400/60 uppercase tracking-wider mb-2">
                                            🌤 Weather at Location
                                        </p>
                                        {e.weather_data.description && (
                                            <p className="text-xs text-gray-300 mb-2 italic">
                                                {e.weather_data.description}
                                            </p>
                                        )}
                                        <div className="grid grid-cols-3 gap-2">
                                            {e.weather_data.airTemp != null && (
                                                <div className="bg-white/[0.04] rounded-xl p-2.5 text-center">
                                                    <p className="text-[11px] text-gray-400 uppercase tracking-wider">
                                                        Air
                                                    </p>
                                                    <p className="text-sm font-bold text-white">
                                                        {e.weather_data.airTemp}°C
                                                    </p>
                                                </div>
                                            )}
                                            {e.weather_data.seaTemp != null && (
                                                <div className="bg-white/[0.04] rounded-xl p-2.5 text-center">
                                                    <p className="text-[11px] text-gray-400 uppercase tracking-wider">
                                                        Sea
                                                    </p>
                                                    <p className="text-sm font-bold text-sky-300">
                                                        {e.weather_data.seaTemp}°C
                                                    </p>
                                                </div>
                                            )}
                                            {e.weather_data.windSpeed != null && (
                                                <div className="bg-white/[0.04] rounded-xl p-2.5 text-center">
                                                    <p className="text-[11px] text-gray-400 uppercase tracking-wider">
                                                        Wind
                                                    </p>
                                                    <p className="text-sm font-bold text-white">
                                                        {e.weather_data.windSpeed}kts
                                                        {e.weather_data.windDir ? ` ${e.weather_data.windDir}` : ''}
                                                    </p>
                                                </div>
                                            )}
                                            {e.weather_data.humidity != null && (
                                                <div className="bg-white/[0.04] rounded-xl p-2.5 text-center">
                                                    <p className="text-[11px] text-gray-400 uppercase tracking-wider">
                                                        Humidity
                                                    </p>
                                                    <p className="text-sm font-bold text-white">
                                                        {e.weather_data.humidity}%
                                                    </p>
                                                </div>
                                            )}
                                            {e.weather_data.rain != null && (
                                                <div className="bg-white/[0.04] rounded-xl p-2.5 text-center">
                                                    <p className="text-[11px] text-gray-400 uppercase tracking-wider">
                                                        Rain
                                                    </p>
                                                    <p className="text-sm font-bold text-white">
                                                        {e.weather_data.rain}mm
                                                    </p>
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                )}
                                {/* Fall back to text summary if no structured data */}
                                {!e.weather_data && e.weather_summary && (
                                    <div className="border-t border-white/[0.06] pt-3">
                                        <p className="text-xs text-gray-400 italic">🌤 {e.weather_summary}</p>
                                    </div>
                                )}
                            </div>
                        )}

                        {/* Location name only (no coords) */}
                        {!hasCoords && e.location_name && (
                            <div className="flex items-center gap-2 text-xs text-sky-400/70">
                                <svg
                                    className="w-3.5 h-3.5"
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
                                <span className="font-medium">{e.location_name}</span>
                            </div>
                        )}

                        {/* Weather summary (no pin, fallback) */}
                        {!hasCoords && e.weather_summary && (
                            <div className="text-xs text-gray-400 italic bg-white/[0.03] rounded-xl p-3 border border-white/5">
                                🌤 {e.weather_summary}
                            </div>
                        )}

                        {e._offline && (
                            <div className="flex items-center gap-2 text-[11px] text-amber-400/70 bg-amber-500/10 rounded-lg px-3 py-2 border border-amber-500/10">
                                <span>⏳</span>
                                <span className="font-bold uppercase tracking-wider">
                                    Pending sync — will upload when online
                                </span>
                            </div>
                        )}
                    </div>
                </div>

                {/* Undo toast */}
                <UndoToast
                    isOpen={!!deletedItem}
                    message={`"${deletedItem?.title}" deleted`}
                    onUndo={onUndo}
                    onDismiss={onDismissDelete}
                    duration={5000}
                />
            </div>
        );
    },
);
