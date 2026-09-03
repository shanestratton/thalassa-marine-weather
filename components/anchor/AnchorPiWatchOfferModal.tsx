/**
 * The offer to hand the anchor watch to the boat's Pi.
 *
 * Shane 2026-09-03: "can we make it a modal box centred of course, with the pi
 * questions in there and a nice big fat beautiful button to push."
 *
 * A modal of its own rather than a ConfirmDialog, because this is not a
 * confirmation — it is a choice between two different places to keep the
 * watch, and the skipper deserves to see what each one means before pressing
 * anything. Centred and portalled, per the standing rule that every modal is
 * centred and clear of the tab bar with its own internal scroll: a bottom
 * sheet here would put the very button being offered underneath the tab bar.
 */
import React, { useRef } from 'react';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { OverlayPortal } from '../ui/OverlayPortal';

interface Props {
    isOpen: boolean;
    /** Disables the button and says so while the handoff is in flight. */
    busy: boolean;
    /** True once the Pi has told us it can actually see the vessel. */
    piHasFix: boolean;
    onAccept: () => void;
    onDecline: () => void;
}

const POINTS: Array<{ icon: string; text: string }> = [
    { icon: '⚡', text: 'Mains powered — it will not go flat at 3 a.m.' },
    { icon: '🛰️', text: 'Wired to the boat’s own GPS, not a phone in a pocket' },
    { icon: '🌙', text: 'Never sleeps, and never leaves the vessel' },
];

export const AnchorPiWatchOfferModal: React.FC<Props> = ({ isOpen, busy, piHasFix, onAccept, onDecline }) => {
    const declineRef = useRef<HTMLButtonElement>(null);
    const ref = useFocusTrap<HTMLDivElement>(isOpen, { initialFocusRef: declineRef, onEscape: onDecline });
    if (!isOpen) return null;

    return (
        <OverlayPortal
            className="flex items-center justify-center p-4"
            onClick={onDecline}
            role="dialog"
            aria-modal="true"
            aria-labelledby="pi-watch-offer-title"
            ref={ref}
        >
            <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />
            <div
                className="relative w-full max-w-sm max-h-[80vh] overflow-y-auto overscroll-contain rounded-3xl border border-sky-400/25 bg-slate-900 p-6 shadow-[0_20px_60px_rgba(0,0,0,0.6)] animate-in fade-in zoom-in-95 duration-200"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="mb-4 flex flex-col items-center text-center">
                    <div className="mb-3 flex h-16 w-16 items-center justify-center rounded-2xl border border-sky-400/30 bg-sky-500/10 text-3xl">
                        ⚓
                    </div>
                    <h2 id="pi-watch-offer-title" className="text-xl font-black tracking-tight text-white">
                        Let the boat keep the watch?
                    </h2>
                    <p className="mt-1 text-sm font-semibold text-sky-300">
                        {piHasFix ? 'Your Pi is aboard and has a fix' : 'Your Pi is aboard and ready'}
                    </p>
                </div>

                <ul className="mb-5 space-y-2">
                    {POINTS.map((p) => (
                        <li
                            key={p.text}
                            className="flex items-start gap-3 rounded-xl border border-white/[0.06] bg-white/[0.03] px-3 py-2.5"
                        >
                            <span className="text-base leading-5">{p.icon}</span>
                            <span className="text-[13px] font-medium leading-5 text-slate-200">{p.text}</span>
                        </li>
                    ))}
                </ul>

                <p className="mb-5 text-[13px] leading-5 text-slate-400">
                    Say yes and this phone becomes your <span className="font-bold text-slate-200">shore monitor</span>
                    &nbsp;— it connects itself, with no code to type, so you can take it ashore and still watch the
                    boat.
                </p>

                <button
                    onClick={onAccept}
                    disabled={busy}
                    className="min-h-[64px] w-full rounded-2xl bg-linear-to-r from-sky-500 to-cyan-500 px-4 text-lg font-black tracking-tight text-white shadow-[0_10px_30px_rgba(14,165,233,0.35)] transition-all active:scale-[0.98] disabled:opacity-60"
                >
                    {busy ? 'Handing over…' : 'Yes — the Pi watches'}
                </button>
                <button
                    ref={declineRef}
                    onClick={onDecline}
                    disabled={busy}
                    className="mt-2 min-h-[48px] w-full rounded-2xl border border-white/10 px-4 text-sm font-bold text-slate-300 transition-all active:scale-[0.98] disabled:opacity-60"
                >
                    No, this phone keeps it
                </button>
            </div>
        </OverlayPortal>
    );
};
