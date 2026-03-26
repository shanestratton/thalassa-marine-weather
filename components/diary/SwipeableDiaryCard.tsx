/**
 * SwipeableDiaryCard — Individual diary entry card with swipe-to-delete
 *
 * Extracted from DiaryPage for:
 * 1. React.memo — prevents re-renders when sibling entries change
 * 2. Module-level definition — stable component reference across parent renders
 */

import React from 'react';
import { DiaryEntry, MOOD_CONFIG } from '../../services/DiaryService';
import { useSwipeable } from '../../hooks/useSwipeable';
import { Share } from '@capacitor/share';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { Capacitor } from '@capacitor/core';

import { createLogger } from '../../utils/createLogger';

const log = createLogger('SwipeableDiaryCard');

/** Format lat/lon to a human-readable coordinate string */
const formatCoord = (lat: number, lon: number): string => {
    const latDir = lat >= 0 ? 'N' : 'S';
    const lonDir = lon >= 0 ? 'E' : 'W';
    return `${Math.abs(lat).toFixed(4)}°${latDir}, ${Math.abs(lon).toFixed(4)}°${lonDir}`;
};

interface SwipeableDiaryCardProps {
    entry: DiaryEntry;
    onTap: () => void;
    onDelete: () => void;
    onEdit: () => void;
    selected: boolean;
    onToggleSelect: () => void;
}

export const SwipeableDiaryCard: React.FC<SwipeableDiaryCardProps> = React.memo(
    ({ entry, onTap, onDelete, onEdit, selected, onToggleSelect }) => {
        const { swipeOffset, isSwiping, resetSwipe, ref } = useSwipeable();
        const moodCfg = MOOD_CONFIG[entry.mood] || MOOD_CONFIG.neutral;
        const entryHasCoords = entry.latitude != null && entry.longitude != null;

        const sharingRef = React.useRef(false);
        const handleShare = async (e: React.MouseEvent) => {
            e.stopPropagation();
            e.preventDefault();
            if (sharingRef.current) return; // Guard against double-tap
            sharingRef.current = true;

            const lines: string[] = [];
            lines.push(`📓 ${entry.title}`);
            lines.push(`${moodCfg.emoji} ${moodCfg.label || entry.mood}`);
            if (entry.body) lines.push('', entry.body);
            if (entry.location_name) lines.push('', `📍 ${entry.location_name}`);
            else if (entryHasCoords) lines.push('', `📍 ${formatCoord(entry.latitude!, entry.longitude!)}`);
            lines.push('', `🕐 ${new Date(entry.created_at).toLocaleString()}`);
            const text = lines.join('\n');

            // Prepare photo file:// URIs for native share
            const fileUris: string[] = [];
            if (Capacitor.isNativePlatform()) {
                const photoUrls = (entry.photos || []).filter(
                    (p) =>
                        p.startsWith('http://') ||
                        p.startsWith('https://') ||
                        p.startsWith('blob:') ||
                        p.startsWith('data:'),
                );
                // Download/convert each photo to cache and collect file:// URIs
                await Promise.all(
                    photoUrls.map(async (url, i) => {
                        try {
                            let base64: string;
                            if (url.startsWith('data:')) {
                                // data: URI — extract the base64 payload directly
                                base64 = url.split(',')[1] || '';
                            } else {
                                // http(s): or blob: — fetch then convert
                                const resp = await fetch(url);
                                const blob = await resp.blob();
                                const reader = new FileReader();
                                base64 = await new Promise<string>((resolve) => {
                                    reader.onloadend = () => resolve((reader.result as string).split(',')[1]);
                                    reader.readAsDataURL(blob);
                                });
                            }
                            if (!base64) return;
                            const ext = url.match(/\.(jpe?g|png|webp|gif)/i)?.[1] || 'jpg';
                            const fileName = `diary_share_${i}.${ext}`;
                            const result = await Filesystem.writeFile({
                                path: fileName,
                                data: base64,
                                directory: Directory.Cache,
                            });
                            fileUris.push(result.uri);
                        } catch (e) { console.warn("Suppressed:", e);
                            // Skip undownloadable photos — share text only
                        }
                    }),
                );
            }

            try {
                await Share.share({
                    title: entry.title,
                    text,
                    ...(fileUris.length > 0 ? { files: fileUris } : {}),
                    dialogTitle: 'Share diary entry',
                });
            } catch (e) { console.warn("Suppressed:", e);
                // User cancelled or share not available — silent
            } finally {
                sharingRef.current = false;
                // Clean up cached files
                for (const uri of fileUris) {
                    const fileName = uri.split('/').pop();
                    if (fileName) {
                        Filesystem.deleteFile({ path: fileName, directory: Directory.Cache }).catch((e) => {
                            log.warn(`[SwipeableDiaryCard]`, e);
                        });
                    }
                }
            }
        };

        return (
            <div className="relative overflow-hidden rounded-2xl">
                {/* Delete button (revealed on swipe) */}
                <div
                    className={`absolute right-0 top-0 bottom-0 w-20 bg-red-600 flex items-center justify-center rounded-r-2xl transition-opacity ${swipeOffset > 0 ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
                    onClick={() => {
                        resetSwipe();
                        onDelete();
                    }}
                >
                    <div className="text-center text-white">
                        <svg className="w-5 h-5 mx-auto mb-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                            />
                        </svg>
                        <span className="text-[11px] font-bold">Delete</span>
                    </div>
                </div>

                {/* Main card (slides on swipe) */}
                <div
                    className={`relative transition-transform ${isSwiping ? '' : 'duration-200'} flex items-stretch border ${selected ? 'border-sky-500/50' : 'border-white/5'} rounded-2xl overflow-hidden bg-white/[0.03]`}
                    style={{ transform: `translateX(-${swipeOffset}px)` }}
                    ref={ref}
                    onClick={() => {
                        if (swipeOffset === 0) onTap();
                    }}
                >
                    {/* Selection checkbox */}
                    <button
                        onClick={(e) => {
                            e.stopPropagation();
                            onToggleSelect();
                        }}
                        className="shrink-0 flex items-center justify-center w-10 ml-1"
                        aria-label={selected ? 'Deselect' : 'Select'}
                    >
                        <div
                            className={`w-5 h-5 rounded-full border-2 flex items-center justify-center transition-all ${
                                selected ? 'bg-sky-500 border-sky-500' : 'border-gray-500/40 bg-transparent'
                            }`}
                        >
                            {selected && (
                                <svg
                                    className="w-3 h-3 text-white"
                                    fill="none"
                                    viewBox="0 0 24 24"
                                    stroke="currentColor"
                                    strokeWidth={3}
                                >
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                                </svg>
                            )}
                        </div>
                    </button>

                    {/* Blue accent bar */}
                    <div className="w-1.5 shrink-0 bg-sky-500" />

                    {/* Content */}
                    <div className="flex-1 p-4">
                        {/* Mood badge — top of card */}
                        <div className="flex items-center gap-1.5 mb-1.5">
                            <span className="text-micro">{moodCfg.emoji}</span>
                            <span className="text-micro font-bold text-gray-400 uppercase tracking-widest">
                                {moodCfg.label || entry.mood}
                            </span>
                            {entry.audio_url && (
                                <span className="text-[11px] text-emerald-400 bg-emerald-500/15 px-1.5 py-0.5 rounded-full font-bold">
                                    🎙️
                                </span>
                            )}
                            {entry._offline && (
                                <span className="text-[11px] text-amber-400 bg-amber-500/15 px-1.5 py-0.5 rounded-full font-bold">
                                    PENDING
                                </span>
                            )}
                        </div>
                        <div className="flex items-center justify-between gap-3">
                            <div className="flex-1 text-left min-w-0">
                                <h4 className="text-sm font-black text-white tracking-wide mb-0.5 truncate">
                                    {entry.title}
                                </h4>
                                <p className="text-label text-gray-400 line-clamp-2 leading-relaxed">
                                    {entry.body || (entry.audio_url ? 'Voice memo attached' : '')}
                                </p>
                                {entryHasCoords && (
                                    <div className="flex items-center gap-1.5 mt-1.5 text-[11px] text-sky-500/60">
                                        <svg
                                            className="w-3 h-3 shrink-0"
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
                                        <span className="font-mono font-medium">
                                            {formatCoord(entry.latitude!, entry.longitude!)}
                                        </span>
                                        {entry.location_name && !entry.location_name.includes('°') && (
                                            <span className="text-gray-400 truncate">— {entry.location_name}</span>
                                        )}
                                    </div>
                                )}
                                {!entryHasCoords && entry.location_name && (
                                    <div className="flex items-center gap-1.5 mt-1.5 text-[11px] text-sky-500/50">
                                        <svg
                                            className="w-3 h-3 shrink-0"
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
                                        <span className="font-medium truncate">{entry.location_name}</span>
                                    </div>
                                )}
                            </div>

                            {/* Share + Edit buttons — vertically centered */}
                            <div className="shrink-0 flex flex-col items-center gap-1 self-center">
                                <button
                                    onClick={handleShare}
                                    className="p-2 rounded-lg hover:bg-white/10 transition-colors"
                                    aria-label="Share entry"
                                >
                                    <svg
                                        className="w-4 h-4 text-sky-400/60"
                                        fill="none"
                                        viewBox="0 0 24 24"
                                        stroke="currentColor"
                                        strokeWidth={1.5}
                                    >
                                        <path
                                            strokeLinecap="round"
                                            strokeLinejoin="round"
                                            d="M7.217 10.907a2.25 2.25 0 100 2.186m0-2.186c.18.324.283.696.283 1.093s-.103.77-.283 1.093m0-2.186l9.566-5.314m-9.566 7.5l9.566 5.314m0 0a2.25 2.25 0 103.935 2.186 2.25 2.25 0 00-3.935-2.186zm0-12.814a2.25 2.25 0 103.933-2.185 2.25 2.25 0 00-3.933 2.185z"
                                        />
                                    </svg>
                                </button>
                                <button
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        onEdit();
                                    }}
                                    className="p-2 rounded-lg hover:bg-white/10 transition-colors"
                                    aria-label="Edit entry"
                                >
                                    <svg
                                        className="w-4 h-4 text-slate-400"
                                        fill="none"
                                        viewBox="0 0 24 24"
                                        stroke="currentColor"
                                        strokeWidth={1.5}
                                    >
                                        <path
                                            strokeLinecap="round"
                                            strokeLinejoin="round"
                                            d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931z"
                                        />
                                    </svg>
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        );
    },
);

SwipeableDiaryCard.displayName = 'SwipeableDiaryCard';
