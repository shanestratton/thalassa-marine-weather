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
        subtitle: 'Swipe left or right on the tide chart to step through the forecast hour by hour.',
        visual: <HorizontalSwipeVisual />,
        gradient: 'from-emerald-500/20 to-teal-500/10',
    },
    {
        title: 'Future Days',
        subtitle: 'Swipe up or down on the tide chart to move through the 7-day forecast, day by day.',
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
 * Layout mirrors the real component: big temp left, condition text
 * centre, hi/lo temps **stacked vertically** on the right with the
 * chevron pip next to them. The pip pulses to draw the eye.
 */
function ChevronVisual() {
    return (
        <div className="relative flex items-center gap-3 px-4 py-3 rounded-xl bg-white/[0.08] border border-white/10 shadow-xl">
            {/* LEFT: big temp */}
            <span className="text-4xl font-mono font-bold text-white leading-none">22°</span>

            {/* MIDDLE: condition label */}
            <div className="flex flex-col items-start">
                <span className="text-[10px] font-bold text-sky-400 uppercase tracking-widest">Sunny</span>
            </div>

            {/* RIGHT: hi/lo stacked vertically + chevron pip */}
            <div className="flex items-center gap-2 ml-auto">
                <div className="flex flex-col items-end gap-0.5">
                    <div className="flex items-center gap-0.5 text-[10px] text-white/70 font-mono font-bold">
                        <svg className="w-2 h-2 text-amber-400" viewBox="0 0 8 8" fill="currentColor">
                            <path d="M4 1L7 5H1L4 1Z" />
                        </svg>
                        <span>25°</span>
                    </div>
                    <div className="flex items-center gap-0.5 text-[10px] text-white/70 font-mono font-bold">
                        <svg className="w-2 h-2 text-sky-400" viewBox="0 0 8 8" fill="currentColor">
                            <path d="M4 7L1 3H7L4 7Z" />
                        </svg>
                        <span>18°</span>
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
        </div>
    );
}

/**
 * Mini tide-graph mock with a horizontal swipe indicator. The actual
 * hour-scrubbing gesture on The Glass happens on the tide chart (not
 * the weather card) — swipe left/right to scrub through the day's
 * hours. The wavy SVG path fakes a tide curve; the finger dot drifts
 * horizontally along it to telegraph the gesture.
 */
function HorizontalSwipeVisual() {
    return (
        <div className="relative w-56 h-28 rounded-xl bg-white/[0.06] border border-white/10 shadow-xl overflow-hidden">
            {/* Hour labels along the top */}
            <div className="absolute inset-x-0 top-2 flex justify-around text-[9px] font-mono text-white/40 font-bold">
                <span>09</span>
                <span>10</span>
                <span className="text-sky-300">11</span>
                <span>12</span>
                <span>13</span>
            </div>

            {/* Tide curve — the actual scrubbable target */}
            <svg
                className="absolute inset-x-2 top-6 w-[calc(100%-16px)] h-14 text-sky-400/70"
                viewBox="0 0 200 60"
                fill="none"
                preserveAspectRatio="none"
            >
                {/* Filled area under the curve */}
                <path
                    d="M 0 45 C 20 10 40 10 60 30 S 100 55 120 30 S 160 5 200 35 L 200 60 L 0 60 Z"
                    fill="currentColor"
                    opacity="0.15"
                />
                {/* Tide curve itself */}
                <path
                    d="M 0 45 C 20 10 40 10 60 30 S 100 55 120 30 S 160 5 200 35"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                />
                {/* Current-position indicator */}
                <line x1="100" y1="6" x2="100" y2="54" stroke="rgba(56,189,248,0.6)" strokeWidth="1" />
                <circle cx="100" cy="42" r="3" fill="rgb(56,189,248)" />
            </svg>

            {/* Horizontal swipe arrow */}
            <svg
                className="absolute bottom-2 left-1/2 -translate-x-1/2 w-24 h-4 text-sky-300"
                viewBox="0 0 120 16"
                fill="none"
            >
                <path d="M10 8h100" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" />
                <path d="M10 8l6-5m-6 5l6 5" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" />
                <path d="M110 8l-6-5m6 5l-6 5" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" />
            </svg>

            {/* Finger hint drifting across the graph */}
            <div
                className="absolute top-1/2 -translate-y-1/2 w-5 h-5 rounded-full bg-sky-400/80 shadow-[0_0_12px_rgba(56,189,248,0.6)]"
                style={{ animation: 'tut-swipe-x 2.2s ease-in-out infinite' }}
            />
            <style>{`
                @keyframes tut-swipe-x {
                    0%, 100% { transform: translate(-60px, -50%); opacity: 0.4; }
                    50% { transform: translate(60px, -50%); opacity: 1; }
                }
            `}</style>
        </div>
    );
}

/**
 * Same tide-graph mock but with a vertical swipe indicator. Swiping
 * the tide chart up or down steps through the 7-day forecast,
 * with each day showing its own curve when the user settles.
 */
function VerticalSwipeVisual() {
    return (
        <div className="relative w-56 h-32 rounded-xl bg-white/[0.06] border border-white/10 shadow-xl overflow-hidden">
            {/* Day labels down the left side */}
            <div className="absolute left-2 inset-y-3 flex flex-col justify-between text-[9px] font-mono text-white/40 font-bold">
                <span>MON</span>
                <span className="text-amber-300">TUE</span>
                <span>WED</span>
                <span>THU</span>
            </div>

            {/* Tide curve */}
            <svg
                className="absolute right-2 top-3 w-[calc(100%-36px)] h-[calc(100%-24px)] text-amber-400/70"
                viewBox="0 0 200 70"
                fill="none"
                preserveAspectRatio="none"
            >
                <path
                    d="M 0 50 C 20 15 40 15 60 35 S 100 60 120 35 S 160 10 200 40 L 200 70 L 0 70 Z"
                    fill="currentColor"
                    opacity="0.15"
                />
                <path
                    d="M 0 50 C 20 15 40 15 60 35 S 100 60 120 35 S 160 10 200 40"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                />
            </svg>

            {/* Vertical swipe arrow — centred on the graph */}
            <svg
                className="absolute top-1/2 right-6 -translate-y-1/2 w-4 h-20 text-amber-300"
                viewBox="0 0 16 80"
                fill="none"
            >
                <path d="M8 8v64" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" />
                <path d="M8 8l-5 6m5-6l5 6" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" />
                <path d="M8 72l-5-6m5 6l5-6" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" />
            </svg>

            {/* Finger hint drifting vertically */}
            <div
                className="absolute right-14 top-1/2 w-5 h-5 rounded-full bg-amber-400/80 shadow-[0_0_12px_rgba(251,191,36,0.6)]"
                style={{ animation: 'tut-swipe-y 2.2s ease-in-out infinite' }}
            />
            <style>{`
                @keyframes tut-swipe-y {
                    0%, 100% { transform: translateY(-40px); opacity: 0.4; }
                    50% { transform: translateY(40px); opacity: 1; }
                }
            `}</style>
        </div>
    );
}

export default GlassTutorial;
