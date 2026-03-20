/**
 * AudioWidget — Reusable audio playback widget for diary entries.
 *
 * Extracted from DiaryPage for reuse in entry detail view and compose form.
 */

import React from 'react';

interface AudioWidgetProps {
    url: string;
    isPlaying: boolean;
    transcribing: boolean;
    onTogglePlayback: (url: string) => void;
    onTranscribe?: (url: string) => void;
    onRemove?: () => void;
    allowTranscribe?: boolean;
    allowRemove?: boolean;
}

export const AudioWidget: React.FC<AudioWidgetProps> = React.memo(
    ({ url, isPlaying, transcribing, onTogglePlayback, onTranscribe, onRemove, allowTranscribe, allowRemove }) => (
        <div className="bg-gradient-to-r from-emerald-500/10 to-emerald-500/10 border border-emerald-500/15 rounded-xl p-3">
            <div className="flex items-center gap-2.5">
                <button
                    aria-label="Go back"
                    onClick={() => onTogglePlayback(url)}
                    className="p-2.5 bg-emerald-500/20 rounded-full hover:bg-emerald-500/30 transition-colors active:scale-95"
                >
                    {isPlaying ? (
                        <svg className="w-5 h-5 text-emerald-400" fill="currentColor" viewBox="0 0 24 24">
                            <rect x="6" y="4" width="4" height="16" rx="1" />
                            <rect x="14" y="4" width="4" height="16" rx="1" />
                        </svg>
                    ) : (
                        <svg className="w-5 h-5 text-emerald-400" fill="currentColor" viewBox="0 0 24 24">
                            <path d="M8 5v14l11-7z" />
                        </svg>
                    )}
                </button>
                <div className="flex-1">
                    <p className="text-[11px] font-bold text-emerald-400/70 uppercase tracking-wider">Voice Memo</p>
                    <div className="flex items-center gap-1 mt-0.5">
                        {/* Waveform visualization */}
                        {[3, 5, 8, 12, 6, 10, 4, 7, 11, 5, 8, 3, 6, 9, 4].map((h, i) => (
                            <div
                                key={i}
                                className={`w-1 rounded-full transition-all ${isPlaying ? 'bg-emerald-400 animate-pulse' : 'bg-emerald-500/30'}`}
                                style={{ height: `${h}px`, animationDelay: `${i * 0.1}s` }}
                            />
                        ))}
                    </div>
                </div>
                <div className="flex items-center gap-1">
                    {allowTranscribe && onTranscribe && (
                        <button
                            aria-label="Transcribe"
                            onClick={() => onTranscribe(url)}
                            disabled={transcribing}
                            className="px-3 py-1.5 bg-white/5 border border-white/10 rounded-lg text-[11px] font-bold text-purple-300 hover:bg-purple-500/15 transition-colors disabled:opacity-40"
                            title="Transcribe to text"
                        >
                            {transcribing ? '⏳' : '📝'} {transcribing ? 'Transcribing…' : 'To Text'}
                        </button>
                    )}
                    {allowRemove && onRemove && (
                        <button
                            aria-label="Remove"
                            onClick={onRemove}
                            className="p-1.5 rounded-lg hover:bg-red-500/20 transition-colors"
                        >
                            <svg
                                className="w-4 h-4 text-red-400/60"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                                strokeWidth={1.5}
                            >
                                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                            </svg>
                        </button>
                    )}
                </div>
            </div>
        </div>
    ),
);
