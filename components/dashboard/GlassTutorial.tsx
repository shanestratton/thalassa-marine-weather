/**
 * GlassTutorial — first-time user coach marks for The Glass.
 *
 * Shows a short 3-slide modal the first time a user lands on the
 * Dashboard, walking them through the non-obvious gestures that
 * otherwise stay hidden:
 *   1. Tap the chevron to toggle between Full and Essential modes
 *      (Essential mode shows the map alongside the weather).
 *   2. Swipe horizontally to step through future hours within a day.
 *   3. Swipe vertically to step through different days (today → +7).
 *
 * Dismissal sticks in localStorage so the modal never shows twice.
 * Rendered unconditionally in Dashboard — the component handles its
 * own gating and will render null if already dismissed or on non-
 * native web platforms (where the launch experience differs).
 */

import React, { useCallback, useState } from 'react';

const STORAGE_KEY = 'thalassa_glass_tutorial_seen';

interface Slide {
    title: string;
    subtitle: string;
    /** Visual illustration for the gesture / target element. */
    visual: React.ReactNode;
    gradient: string;
}

const SLIDES: Slide[] = [
    {
        title: 'Essential Mode',
        subtitle:
            'Tap the chevron next to the high/low temperature to collapse The Glass and see the live map alongside your weather. Tap again to expand back.',
        visual: <ChevronVisual />,
        gradient: 'from-sky-500/20 to-cyan-500/10',
    },
    {
        title: 'Future Hours',
        subtitle: 'Swipe the weather card left or right to step through the forecast hour by hour.',
        visual: <HorizontalSwipeVisual />,
        gradient: 'from-emerald-500/20 to-teal-500/10',
    },
    {
        title: 'Future Days',
        subtitle: 'Swipe up or down on the weather card to move through the 7-day forecast, day by day.',
        visual: <VerticalSwipeVisual />,
        gradient: 'from-amber-500/20 to-orange-500/10',
    },
];

export const GlassTutorial: React.FC = () => {
    const [visible, setVisible] = useState(() => {
        try {
            return !localStorage.getItem(STORAGE_KEY);
        } catch {
            return true;
        }
    });
    const [current, setCurrent] = useState(0);

    const dismiss = useCallback(() => {
        try {
            localStorage.setItem(STORAGE_KEY, 'true');
        } catch {
            /* private mode, storage full, whatever — tutorial just re-appears */
        }
        setVisible(false);
    }, []);

    const next = useCallback(() => {
        if (current < SLIDES.length - 1) {
            setCurrent((c) => c + 1);
        } else {
            dismiss();
        }
    }, [current, dismiss]);

    if (!visible) return null;

    const slide = SLIDES[current];
    const isLast = current === SLIDES.length - 1;

    return (
        <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/80 backdrop-blur-sm p-6">
            <div className="w-full max-w-sm animate-in fade-in zoom-in-95 duration-300">
                <div className="bg-slate-900 border border-white/10 rounded-3xl overflow-hidden shadow-2xl">
                    {/* Visual area — gradient backdrop with the animated illustration */}
                    <div
                        className={`relative h-48 bg-gradient-to-br ${slide.gradient} flex items-center justify-center`}
                    >
                        {slide.visual}
                    </div>

                    {/* Copy */}
                    <div className="px-6 pt-5 pb-6">
                        <h2 className="text-xl font-extrabold text-white mb-1.5">{slide.title}</h2>
                        <p className="text-sm text-white/60 leading-relaxed mb-6">{slide.subtitle}</p>

                        {/* Dots + nav */}
                        <div className="flex items-center justify-between">
                            <div className="flex gap-2">
                                {SLIDES.map((_, i) => (
                                    <div
                                        key={i}
                                        className={`h-2 rounded-full transition-all duration-300 ${
                                            i === current ? 'w-6 bg-sky-400' : 'w-2 bg-white/20'
                                        }`}
                                    />
                                ))}
                            </div>
                            <div className="flex items-center gap-3">
                                {!isLast && (
                                    <button
                                        aria-label="Skip tutorial"
                                        onClick={dismiss}
                                        className="text-sm text-white/30 hover:text-white/60 transition-colors"
                                    >
                                        Skip
                                    </button>
                                )}
                                <button
                                    aria-label={isLast ? 'Finish tutorial' : 'Next tip'}
                                    onClick={next}
                                    className="px-5 py-2.5 rounded-xl bg-sky-500/20 border border-sky-500/30 text-sky-400 text-sm font-bold hover:bg-sky-500/30 transition-all active:scale-95"
                                >
                                    {isLast ? 'Got it' : 'Next'}
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};

// ── Illustrations ───────────────────────────────────────────────────

/**
 * Mini mock of the HeroHeader with the tappable chevron highlighted.
 * The chevron pulses softly (pure CSS) to draw the eye.
 */
function ChevronVisual() {
    return (
        <div className="relative flex items-center gap-3 px-4 py-3 rounded-xl bg-white/[0.08] border border-white/10 shadow-xl">
            <span className="text-4xl font-mono font-bold text-white leading-none">22°</span>
            <div className="flex flex-col items-start gap-1">
                <span className="text-[10px] font-bold text-sky-400 uppercase tracking-widest">Sunny</span>
                <div className="flex items-center gap-2 text-xs text-white/60">
                    <span>↑25°</span>
                    <span>↓18°</span>
                </div>
            </div>
            {/* Chevron pip — pulses to draw the eye */}
            <div className="relative w-9 h-9 rounded-full bg-sky-500/20 border border-sky-400/50 flex items-center justify-center shrink-0">
                <svg
                    className="w-4 h-4 text-sky-300"
                    viewBox="0 0 20 20"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2.5}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                >
                    <path d="M5 8l5 5 5-5" />
                </svg>
                {/* Pulsing ring */}
                <span className="absolute inset-0 rounded-full border-2 border-sky-400/60 animate-ping" />
            </div>
        </div>
    );
}

/**
 * Card + left↔right double-headed arrow + "hours" labels. A small
 * finger icon drifts across to suggest the swipe.
 */
function HorizontalSwipeVisual() {
    return (
        <div className="relative w-56 h-28 rounded-xl bg-white/[0.06] border border-white/10 shadow-xl flex items-center justify-center overflow-hidden">
            {/* Mini hour strip */}
            <div className="absolute inset-x-0 top-3 flex justify-around text-[10px] font-mono text-white/40 font-bold">
                <span>09</span>
                <span className="text-white">10</span>
                <span>11</span>
                <span>12</span>
                <span>13</span>
            </div>
            {/* Arrow */}
            <svg className="w-32 h-8 text-sky-300 mt-4" viewBox="0 0 120 20" fill="none">
                <path d="M10 10h100" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
                <path d="M10 10l6-6m-6 6l6 6" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
                <path d="M110 10l-6-6m6 6l-6 6" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
            </svg>
            {/* Finger hint */}
            <div
                className="absolute bottom-3 w-5 h-5 rounded-full bg-sky-400/80 shadow-[0_0_12px_rgba(56,189,248,0.6)]"
                style={{ animation: 'swipe-x 2.2s ease-in-out infinite' }}
            />
            {/* Inline keyframes scoped via style tag so we don't bloat index.css for a one-off */}
            <style>{`
                @keyframes swipe-x {
                    0%, 100% { transform: translateX(-70px); opacity: 0.5; }
                    50% { transform: translateX(70px); opacity: 1; }
                }
            `}</style>
        </div>
    );
}

/**
 * Card + up↕down arrow + day labels. Finger drifts vertically.
 */
function VerticalSwipeVisual() {
    return (
        <div className="relative w-56 h-32 rounded-xl bg-white/[0.06] border border-white/10 shadow-xl flex items-center justify-center overflow-hidden">
            {/* Mini day column */}
            <div className="absolute left-4 inset-y-3 flex flex-col justify-between text-[10px] font-mono text-white/40 font-bold">
                <span>MON</span>
                <span className="text-white">TUE</span>
                <span>WED</span>
                <span>THU</span>
            </div>
            {/* Arrow */}
            <svg className="w-6 h-20 text-amber-300 ml-10" viewBox="0 0 20 80" fill="none">
                <path d="M10 10v60" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
                <path d="M10 10l-6 6m6-6l6 6" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
                <path d="M10 70l-6-6m6 6l6-6" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
            </svg>
            {/* Finger hint */}
            <div
                className="absolute right-8 w-5 h-5 rounded-full bg-amber-400/80 shadow-[0_0_12px_rgba(251,191,36,0.6)]"
                style={{ animation: 'swipe-y 2.2s ease-in-out infinite' }}
            />
            <style>{`
                @keyframes swipe-y {
                    0%, 100% { transform: translateY(-40px); opacity: 0.5; }
                    50% { transform: translateY(40px); opacity: 1; }
                }
            `}</style>
        </div>
    );
}

export default GlassTutorial;
