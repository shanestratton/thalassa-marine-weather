/**
 * DiaryPublishModal — "Share this to your Voyage Log?"
 *
 * Shown once, right after a new diary entry is saved. Offers the punter
 * a choice: keep the entry private (default) or publish it to their
 * public Voyage Log. Publishing flips the entry's is_public flag and,
 * on first use, provisions their voyage_log_configs row.
 */

import React, { useState } from 'react';
import { DiaryEntry, MOOD_CONFIG } from '../../services/DiaryService';
import { DiaryService } from '../../services/DiaryService';
import { VoyageLogService, voyageLogPublicUrl } from '../../services/VoyageLogService';
import { triggerHaptic } from '../../utils/system';

type Phase = 'prompt' | 'publishing' | 'published';

interface DiaryPublishModalProps {
    entry: DiaryEntry;
    /** Dismiss without publishing — entry stays private. */
    onKeepPrivate: () => void;
    /** Entry was published; receives the entry with is_public flipped on. */
    onPublished: (entry: DiaryEntry) => void;
}

export const DiaryPublishModal: React.FC<DiaryPublishModalProps> = ({ entry, onKeepPrivate, onPublished }) => {
    const [phase, setPhase] = useState<Phase>('prompt');
    const [publicUrl, setPublicUrl] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);

    const mood = MOOD_CONFIG[entry.mood];
    const photoCount = entry.photos?.length ?? 0;

    const handlePublish = async () => {
        setPhase('publishing');
        triggerHaptic('medium');

        // Provision/enable the voyage log and publish the entry in parallel.
        // setEntryPublished is race-safe — it resolves the offline-first id
        // and forces the flag on the real server row.
        const [config, ok] = await Promise.all([
            VoyageLogService.ensureEnabled(),
            DiaryService.setEntryPublished(entry.id, true),
        ]);

        if (ok) {
            onPublished({ ...entry, is_public: true });
        }
        if (config) {
            setPublicUrl(voyageLogPublicUrl(config.handle, config.api_key));
        }
        setPhase('published');
        triggerHaptic('light');
    };

    const handleCopy = async () => {
        if (!publicUrl) return;
        try {
            await navigator.clipboard.writeText(publicUrl);
            setCopied(true);
            triggerHaptic('light');
            setTimeout(() => setCopied(false), 2000);
        } catch {
            /* clipboard unavailable — the URL is still on screen to copy by hand */
        }
    };

    return (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
            <div className="w-full max-w-md bg-slate-900 border border-white/10 rounded-3xl shadow-2xl slide-up-enter overflow-hidden">
                {/* ── Header ── */}
                <div className="px-6 pt-6 pb-4 bg-gradient-to-b from-sky-500/10 to-transparent text-center">
                    <div className="mx-auto w-14 h-14 rounded-2xl bg-sky-500/15 border border-sky-500/20 flex items-center justify-center text-3xl">
                        {phase === 'published' ? '🌍' : '⚓'}
                    </div>
                    <h2 className="mt-3 text-xl font-extrabold text-white">
                        {phase === 'published' ? 'Published to your Voyage Log' : 'Share to your Voyage Log?'}
                    </h2>
                    <p className="mt-1 text-[13px] text-gray-400 leading-relaxed">
                        {phase === 'published'
                            ? 'Anyone with your log link can now read this entry.'
                            : 'Publish this entry to your public voyage page. Your private diary stays private — only what you publish is shared.'}
                    </p>
                </div>

                {/* ── Entry preview ── */}
                <div className="mx-6 mb-2 p-3 rounded-2xl bg-white/[0.03] border border-white/[0.06] flex items-center gap-3">
                    <span className="text-2xl shrink-0">{mood.emoji}</span>
                    <div className="min-w-0 flex-1">
                        <p className="text-sm font-bold text-white truncate">{entry.title || 'Untitled entry'}</p>
                        <p className="text-[11px] text-gray-500 truncate">
                            {entry.location_name || 'No location'}
                            {photoCount > 0 && ` · ${photoCount} photo${photoCount === 1 ? '' : 's'}`}
                        </p>
                    </div>
                </div>

                {/* ── Published: share link ── */}
                {phase === 'published' && (
                    <div className="px-6 pt-2 pb-1">
                        {publicUrl ? (
                            <button
                                onClick={handleCopy}
                                aria-label="Copy your voyage log link"
                                className="w-full flex items-center gap-2 p-3 rounded-xl bg-sky-500/10 border border-sky-500/20 text-left transition-colors hover:bg-sky-500/15"
                            >
                                <svg
                                    className="w-4 h-4 text-sky-400 shrink-0"
                                    fill="none"
                                    viewBox="0 0 24 24"
                                    stroke="currentColor"
                                    strokeWidth={2}
                                >
                                    <path
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m13.35-.622l1.757-1.757a4.5 4.5 0 00-6.364-6.364l-4.5 4.5a4.5 4.5 0 001.242 7.244"
                                    />
                                </svg>
                                <span className="text-xs font-mono text-sky-300 truncate flex-1">{publicUrl}</span>
                                <span className="text-[11px] font-bold text-sky-400 uppercase tracking-wider shrink-0">
                                    {copied ? 'Copied' : 'Copy'}
                                </span>
                            </button>
                        ) : (
                            <p className="text-[12px] text-amber-400/90 bg-amber-500/10 border border-amber-500/20 rounded-xl p-3 leading-relaxed">
                                Entry marked to publish. Your voyage log will go live once you're back online.
                            </p>
                        )}
                    </div>
                )}

                {/* ── Actions ── */}
                <div className="p-6 pt-4 flex gap-3">
                    {phase === 'published' ? (
                        <button
                            onClick={onKeepPrivate}
                            aria-label="Done"
                            className="flex-1 py-3 rounded-xl bg-sky-600 hover:bg-sky-500 text-white font-bold text-sm transition-colors active:scale-[0.98]"
                        >
                            Done
                        </button>
                    ) : (
                        <>
                            <button
                                onClick={onKeepPrivate}
                                disabled={phase === 'publishing'}
                                aria-label="Keep this entry private"
                                className="flex-1 py-3 rounded-xl bg-white/5 border border-white/[0.08] text-gray-300 font-bold text-sm hover:bg-white/10 transition-colors active:scale-[0.98] disabled:opacity-50"
                            >
                                Keep Private
                            </button>
                            <button
                                onClick={handlePublish}
                                disabled={phase === 'publishing'}
                                aria-label="Publish this entry to your voyage log"
                                className="flex-[1.4] py-3 rounded-xl bg-sky-600 hover:bg-sky-500 disabled:bg-gray-700 disabled:text-gray-400 text-white font-bold text-sm transition-colors active:scale-[0.98] flex items-center justify-center gap-2"
                            >
                                {phase === 'publishing' ? (
                                    <>
                                        <span className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" />
                                        Publishing…
                                    </>
                                ) : (
                                    'Publish'
                                )}
                            </button>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
};
