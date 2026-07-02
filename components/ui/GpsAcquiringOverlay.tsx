/**
 * GpsAcquiringOverlay — the UNMISSABLE "we don't have a fix yet" state.
 *
 * Shane 2026-07-03 (departure morning): the tiny "Acquiring GPS fix…"
 * header badge is invisible in sunlight — the skipper starts tracking,
 * pockets the phone, and the first minutes of track never record. This
 * is the full-screen version: big, centred, amber, and it dismisses
 * ITSELF the instant the first trustworthy fix is recorded. A manual
 * "keep it in the background" escape drops back to the header badge for
 * flaky-GPS days (it never blocks recording — capture starts on lock
 * regardless).
 */
import React from 'react';

interface GpsAcquiringOverlayProps {
    open: boolean;
    onDismiss: () => void;
}

export const GpsAcquiringOverlay: React.FC<GpsAcquiringOverlayProps> = ({ open, onDismiss }) => {
    if (!open) return null;
    return (
        <div
            className="fixed inset-0 z-[10000] flex items-center justify-center p-6"
            role="alertdialog"
            aria-modal="true"
            aria-label="Acquiring GPS fix"
        >
            <div className="absolute inset-0 bg-slate-950/85 backdrop-blur-sm" />
            <div className="relative w-full max-w-sm text-center animate-in fade-in zoom-in-95 duration-300">
                {/* Pulsing satellite ring */}
                <div className="mx-auto relative w-36 h-36 mb-6">
                    <div className="absolute inset-0 rounded-full bg-amber-400/10 animate-ping" />
                    <div className="absolute inset-3 rounded-full bg-amber-400/15 animate-pulse" />
                    <div className="absolute inset-0 flex items-center justify-center">
                        <svg
                            className="w-16 h-16 text-amber-300"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                            strokeWidth={1.6}
                        >
                            {/* satellite dish / signal */}
                            <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                d="M12 21a9 9 0 009-9M12 17a5 5 0 005-5M12 13a1 1 0 100-2 1 1 0 000 2zM3 3l7.5 7.5"
                            />
                        </svg>
                    </div>
                </div>

                <h2 className="text-3xl font-black text-amber-300 tracking-tight mb-3">Acquiring GPS fix…</h2>
                <p className="text-base text-slate-200 leading-relaxed mb-2">
                    Hold tight — a cold start can take up to <span className="font-bold text-white">30 seconds</span>{' '}
                    with clear sky.
                </p>
                <p className="text-sm text-slate-400 leading-relaxed mb-8">
                    Recording starts automatically the moment we lock on. This screen will clear itself.
                </p>

                <button
                    onClick={onDismiss}
                    className="px-6 py-3 rounded-2xl bg-white/10 border border-white/15 text-slate-200 text-sm font-bold uppercase tracking-widest active:scale-[0.97] transition-transform"
                >
                    Keep waiting in background
                </button>
            </div>
        </div>
    );
};
