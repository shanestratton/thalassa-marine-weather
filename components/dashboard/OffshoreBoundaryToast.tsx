/**
 * OffshoreBoundaryToast — Glassmorphism slide-down notification
 * shown for 5 s when the vessel crosses the 20 nm offshore boundary.
 *
 * Renders via a portal so it sits above everything (z-[9998]).
 * Plays a submarine sonar ping via Web Audio API to get the punter's attention.
 */
import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

// ── Submarine sonar ping via Web Audio API ──
// Short ~300ms sine sweep with exponential decay — unmistakable sonar "ping"
function playSubmarinePing() {
    try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
        const now = ctx.currentTime;

        // Primary ping — 1200 Hz sine with fast decay
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(1200, now);
        osc.frequency.exponentialRampToValueAtTime(800, now + 0.3);
        gain.gain.setValueAtTime(0.35, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.6);
        osc.connect(gain).connect(ctx.destination);
        osc.start(now);
        osc.stop(now + 0.6);

        // Echo ping — delayed 180ms, quieter, slightly higher
        const osc2 = ctx.createOscillator();
        const gain2 = ctx.createGain();
        osc2.type = 'sine';
        osc2.frequency.setValueAtTime(1400, now + 0.18);
        osc2.frequency.exponentialRampToValueAtTime(900, now + 0.45);
        gain2.gain.setValueAtTime(0, now);
        gain2.gain.setValueAtTime(0.15, now + 0.18);
        gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.7);
        osc2.connect(gain2).connect(ctx.destination);
        osc2.start(now + 0.18);
        osc2.stop(now + 0.7);

        // Clean up AudioContext after sounds finish
        setTimeout(() => ctx.close().catch(() => {}), 1000);
    } catch {
        /* Web Audio not available — silent fallback */
    }
}

interface Props {
    visible: boolean;
    modelName: string;
}

export const OffshoreBoundaryToast: React.FC<Props> = React.memo(({ visible, modelName }) => {
    // Mount / animate lifecycle: mount → slide in → hold → slide out → unmount
    const [mounted, setMounted] = useState(false);
    const [show, setShow] = useState(false);
    const hasPlayedRef = useRef(false);

    useEffect(() => {
        if (visible) {
            setMounted(true);
            // Trigger enter animation on next frame
            requestAnimationFrame(() => requestAnimationFrame(() => setShow(true)));
            // Play submarine ping once per toast appearance
            if (!hasPlayedRef.current) {
                hasPlayedRef.current = true;
                playSubmarinePing();
            }
        } else {
            setShow(false);
            hasPlayedRef.current = false;
            // Unmount after exit animation completes (500 ms)
            const timer = setTimeout(() => setMounted(false), 500);
            return () => clearTimeout(timer);
        }
    }, [visible]);

    if (!mounted) return null;

    return createPortal(
        <div
            className="fixed left-0 right-0 z-[9998] flex justify-center pointer-events-none"
            style={{ top: 'calc(env(safe-area-inset-top, 0px) + 12px)' }}
        >
            <div
                className={`
                    pointer-events-auto mx-4 max-w-md w-full
                    bg-slate-900/80 backdrop-blur-xl
                    border border-white/[0.08]
                    rounded-2xl shadow-2xl shadow-sky-500/10
                    px-5 py-4
                    transition-all duration-500 ease-out
                    ${show ? 'opacity-100 translate-y-0' : 'opacity-0 -translate-y-6'}
                `}
            >
                {/* Accent glow bar */}
                <div className="absolute inset-x-0 top-0 h-[2px] rounded-t-2xl bg-gradient-to-r from-transparent via-sky-500 to-transparent opacity-60" />

                <div className="flex items-start gap-3">
                    {/* Pulsing radar icon */}
                    <div className="relative shrink-0 mt-0.5">
                        <div className="w-8 h-8 rounded-full bg-sky-500/20 flex items-center justify-center">
                            <svg
                                className="w-4 h-4 text-sky-400"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                                strokeWidth={2}
                            >
                                <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    d="M9.348 14.652a3.75 3.75 0 010-5.304m5.304 0a3.75 3.75 0 010 5.304m-7.425 2.121a6.75 6.75 0 010-9.546m9.546 0a6.75 6.75 0 010 9.546M5.106 18.894c-3.808-3.808-3.808-9.98 0-13.788m13.788 0c3.808 3.808 3.808 9.98 0 13.788"
                                />
                            </svg>
                        </div>
                        {/* Ping */}
                        <div className="absolute inset-0 rounded-full bg-sky-400/30 animate-ping" />
                    </div>

                    <div className="flex-1 min-w-0">
                        <p className="text-xs font-black text-sky-400 uppercase tracking-[0.15em] mb-1">
                            Offshore Boundary Reached
                        </p>
                        <p className="text-sm text-gray-300 leading-relaxed">
                            Now sourcing high-resolution <span className="text-white font-bold">{modelName}</span>{' '}
                            model.
                        </p>
                    </div>
                </div>
            </div>
        </div>,
        document.body,
    );
});

OffshoreBoundaryToast.displayName = 'OffshoreBoundaryToast';
