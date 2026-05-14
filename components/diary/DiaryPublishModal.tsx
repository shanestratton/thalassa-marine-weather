/**
 * DiaryPublishModal — Voyage Log publish checkpoint.
 *
 * Shown after a diary entry is saved (new OR edited). State-aware:
 *   - private entry → offer to publish it to the public Voyage Log
 *   - public entry  → show the share link, offer to unpublish
 * Publishing provisions the voyage_log_configs row on first use.
 */

import React, { useEffect, useState } from 'react';
import { DiaryEntry, DiaryService, MOOD_CONFIG } from '../../services/DiaryService';
import { VoyageLogService, voyageLogPublicUrl } from '../../services/VoyageLogService';
import { triggerHaptic } from '../../utils/system';

type Phase = 'choose' | 'working' | 'done';

interface DiaryPublishModalProps {
    entry: DiaryEntry;
    /** Dismiss the modal. */
    onClose: () => void;
    /** Publish state changed — receives the entry with is_public updated. */
    onPublishChange: (entry: DiaryEntry) => void;
}

export const DiaryPublishModal: React.FC<DiaryPublishModalProps> = ({ entry, onClose, onPublishChange }) => {
    const startsPublic = !!entry.is_public;
    const [phase, setPhase] = useState<Phase>('choose');
    // What the last action did — drives the 'done' screen copy.
    const [result, setResult] = useState<'published' | 'unpublished' | null>(null);
    const [publicUrl, setPublicUrl] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);

    const mood = MOOD_CONFIG[entry.mood] || MOOD_CONFIG.neutral;
    const photoCount = entry.photos?.length ?? 0;
    const working = phase === 'working';

    // Already public? Fetch the share link so it shows on the manage screen.
    useEffect(() => {
        if (!startsPublic) return;
        let cancelled = false;
        void VoyageLogService.getConfig().then((cfg) => {
            if (!cancelled && cfg) setPublicUrl(voyageLogPublicUrl(cfg.handle, cfg.api_key));
        });
        return () => {
            cancelled = true;
        };
    }, [startsPublic]);

    const handlePublish = async () => {
        setPhase('working');
        triggerHaptic('medium');
        const [config, ok] = await Promise.all([
            VoyageLogService.ensureEnabled(),
            DiaryService.setEntryPublished(entry.id, true),
        ]);
        if (ok) onPublishChange({ ...entry, is_public: true });
        if (config) setPublicUrl(voyageLogPublicUrl(config.handle, config.api_key));
        setResult('published');
        setPhase('done');
        triggerHaptic('light');
    };

    const handleUnpublish = async () => {
        setPhase('working');
        triggerHaptic('medium');
        const ok = await DiaryService.setEntryPublished(entry.id, false);
        if (ok) onPublishChange({ ...entry, is_public: false });
        setResult('unpublished');
        setPhase('done');
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

    // ── Screen copy ───────────────────────────────────────────────
    let icon = '⚓';
    let heading = 'Share to your Voyage Log?';
    let blurb =
        'Publish this entry to your public voyage page. Your private diary stays private — only what you publish is shared.';
    if (phase === 'done' && result === 'published') {
        icon = '🌍';
        heading = 'Published to your Voyage Log';
        blurb = 'Anyone with your log link can now read this entry.';
    } else if (phase === 'done' && result === 'unpublished') {
        icon = '🔒';
        heading = 'Removed from your Voyage Log';
        blurb = 'This entry is private again — it no longer appears on your public page.';
    } else if (startsPublic) {
        icon = '🌍';
        heading = 'On your Voyage Log';
        blurb = 'This entry is live on your public voyage page.';
    }

    // Show the share link on the manage screen and after publishing —
    // but not after an unpublish, and not mid-action.
    const showLink = !working && result !== 'unpublished' && (startsPublic || result === 'published');

    return (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
            <div className="w-full max-w-md bg-slate-900 border border-white/10 rounded-3xl shadow-2xl slide-up-enter overflow-hidden">
                {/* ── Header ── */}
                <div className="px-6 pt-6 pb-4 bg-gradient-to-b from-sky-500/10 to-transparent text-center">
                    <div className="mx-auto w-14 h-14 rounded-2xl bg-sky-500/15 border border-sky-500/20 flex items-center justify-center text-3xl">
                        {icon}
                    </div>
                    <h2 className="mt-3 text-xl font-extrabold text-white">{heading}</h2>
                    <p className="mt-1 text-[13px] text-gray-400 leading-relaxed">{blurb}</p>
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

                {/* ── Share link ── */}
                {showLink && (
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
                    {phase === 'done' ? (
                        <button
                            onClick={onClose}
                            aria-label="Done"
                            className="flex-1 py-3 rounded-xl bg-sky-600 hover:bg-sky-500 text-white font-bold text-sm transition-colors active:scale-[0.98]"
                        >
                            Done
                        </button>
                    ) : startsPublic ? (
                        <>
                            <button
                                onClick={handleUnpublish}
                                disabled={working}
                                aria-label="Remove this entry from your voyage log"
                                className="flex-1 py-3 rounded-xl bg-white/5 border border-white/[0.08] text-amber-300 font-bold text-sm hover:bg-white/10 transition-colors active:scale-[0.98] disabled:opacity-50 flex items-center justify-center gap-2"
                            >
                                {working ? (
                                    <>
                                        <span className="w-4 h-4 border-2 border-amber-300/40 border-t-amber-300 rounded-full animate-spin" />
                                        Removing…
                                    </>
                                ) : (
                                    'Unpublish'
                                )}
                            </button>
                            <button
                                onClick={onClose}
                                disabled={working}
                                aria-label="Done"
                                className="flex-1 py-3 rounded-xl bg-sky-600 hover:bg-sky-500 disabled:opacity-50 text-white font-bold text-sm transition-colors active:scale-[0.98]"
                            >
                                Done
                            </button>
                        </>
                    ) : (
                        <>
                            <button
                                onClick={onClose}
                                disabled={working}
                                aria-label="Keep this entry private"
                                className="flex-1 py-3 rounded-xl bg-white/5 border border-white/[0.08] text-gray-300 font-bold text-sm hover:bg-white/10 transition-colors active:scale-[0.98] disabled:opacity-50"
                            >
                                Keep Private
                            </button>
                            <button
                                onClick={handlePublish}
                                disabled={working}
                                aria-label="Publish this entry to your voyage log"
                                className="flex-[1.4] py-3 rounded-xl bg-sky-600 hover:bg-sky-500 disabled:bg-gray-700 disabled:text-gray-400 text-white font-bold text-sm transition-colors active:scale-[0.98] flex items-center justify-center gap-2"
                            >
                                {working ? (
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
