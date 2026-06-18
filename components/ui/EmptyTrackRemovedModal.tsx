/**
 * EmptyTrackRemovedModal — a friendly, prominent announcement that one or
 * more "went nowhere" (0.0 NM) tracks were tidied out of the logbook.
 *
 * Replaces the easy-to-miss toast. Big centered card, backdrop blur, a
 * 5-second countdown ring that auto-dismisses, plus a Got-it button to
 * close early. Positive/tidy framing (emerald), not destructive — this
 * is helpful housekeeping, not data loss the user should fret over.
 */
import React, { useEffect, useState } from 'react';

interface EmptyTrackRemovedModalProps {
    /** Number of empty tracks removed; null/0 = closed. */
    count: number | null;
    onClose: () => void;
}

const AUTO_DISMISS_S = 5;
// Ring geometry — circumference for the depleting countdown stroke.
const R = 46;
const C = 2 * Math.PI * R;

export const EmptyTrackRemovedModal: React.FC<EmptyTrackRemovedModalProps> = ({ count, onClose }) => {
    const open = !!count && count > 0;
    const [secondsLeft, setSecondsLeft] = useState(AUTO_DISMISS_S);

    useEffect(() => {
        if (!open) return;
        setSecondsLeft(AUTO_DISMISS_S);
        const tick = setInterval(() => setSecondsLeft((s) => Math.max(0, s - 1)), 1000);
        const done = setTimeout(onClose, AUTO_DISMISS_S * 1000);
        return () => {
            clearInterval(tick);
            clearTimeout(done);
        };
    }, [open, onClose]);

    if (!open) return null;

    const plural = count! > 1;

    return (
        <div
            className="fixed inset-0 z-[10001] flex items-center justify-center p-5"
            onClick={onClose}
            role="alertdialog"
            aria-modal="true"
            aria-label="Empty track removed"
        >
            <style>{`@keyframes tmv-ring-deplete { from { stroke-dashoffset: 0; } to { stroke-dashoffset: ${C}; } }`}</style>
            <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />

            <div
                className="relative w-full max-w-sm bg-slate-900 border border-emerald-400/25 rounded-3xl px-7 pt-8 pb-6 shadow-2xl shadow-emerald-900/30 animate-in fade-in zoom-in-95 duration-300 text-center"
                onClick={(e) => e.stopPropagation()}
            >
                {/* Countdown ring around a nautical broom/sweep icon */}
                <div className="mx-auto relative w-[120px] h-[120px] mb-5">
                    <svg className="w-full h-full -rotate-90" viewBox="0 0 120 120">
                        <circle cx="60" cy="60" r={R} fill="none" stroke="rgba(16,185,129,0.15)" strokeWidth="6" />
                        <circle
                            cx="60"
                            cy="60"
                            r={R}
                            fill="none"
                            stroke="#34d399"
                            strokeWidth="6"
                            strokeLinecap="round"
                            strokeDasharray={C}
                            style={{ animation: `tmv-ring-deplete ${AUTO_DISMISS_S}s linear forwards` }}
                        />
                    </svg>
                    <div className="absolute inset-0 flex items-center justify-center">
                        <div className="w-16 h-16 rounded-full bg-emerald-500/15 flex items-center justify-center">
                            <svg
                                className="w-9 h-9 text-emerald-400"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                                strokeWidth={1.8}
                            >
                                {/* sparkle / tidy */}
                                <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    d="M5 3v4M3 5h4M6 17v4m-2-2h4M13 3l2.5 6.5L22 12l-6.5 2.5L13 21l-2.5-6.5L4 12l6.5-2.5L13 3z"
                                />
                            </svg>
                        </div>
                    </div>
                </div>

                <h3 className="text-xl font-black text-white mb-2">
                    {plural ? `${count} empty tracks tidied away` : 'Empty track tidied away'}
                </h3>
                <p className="text-sm text-slate-300/90 leading-relaxed mb-6">
                    {plural ? 'They went nowhere' : 'It went nowhere'} —{' '}
                    <span className="font-bold text-white">0.0 NM</span> logged, so {plural ? "they're" : "it's"}{' '}
                    cleared from your logbook to keep it shipshape.
                </p>

                <button
                    onClick={onClose}
                    className="w-full py-3.5 rounded-2xl bg-emerald-500 text-white text-sm font-black uppercase tracking-widest shadow-lg shadow-emerald-500/25 active:scale-[0.97] transition-transform"
                >
                    Got it{secondsLeft > 0 ? ` · ${secondsLeft}` : ''}
                </button>
            </div>
        </div>
    );
};
