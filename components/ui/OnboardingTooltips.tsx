/**
 * OnboardingTooltips — Contextual 3-step tooltip tour for first-time users.
 *
 * Unlike the full-screen GestureTutorial, these tooltips appear
 * anchored near relevant UI elements with a pointing arrow.
 *
 * Steps:
 *   1. "Swipe for views" — bottom-center, above the carousel
 *   2. "This is your passage planner" — top-right, near the Watch tab
 *   3. "Tap bookmark to save" — center, about the logbook
 *
 * Persists completion to localStorage.
 */
import React, { useState, useEffect, useCallback } from 'react';

const TOOLTIP_KEY = 'thalassa_tooltip_tour_v2';

interface TooltipStep {
    title: string;
    description: string;
    icon: React.ReactNode;
    position: 'top' | 'center' | 'bottom';
}

const STEPS: TooltipStep[] = [
    {
        title: 'Swipe for Views',
        description: 'Swipe left and right on the forecast cards to scrub through hours. Swipe vertically for different days.',
        icon: (
            <svg className="w-7 h-7" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 12h14M14 7l5 5-5 5M10 7L5 12l5 5" />
            </svg>
        ),
        position: 'bottom',
    },
    {
        title: 'Passage Planner',
        description: 'Plan routes, check conditions, and download GPX tracks from the Ship\'s Office > Passages tab.',
        icon: (
            <svg className="w-7 h-7" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 6.75V15m6-6v8.25m.503 3.498l4.875-2.437c.381-.19.622-.58.622-1.006V4.82c0-.836-.88-1.38-1.628-1.006l-3.869 1.934c-.317.159-.69.159-1.006 0L9.503 3.252a1.125 1.125 0 00-1.006 0L3.622 5.689C3.24 5.88 3 6.27 3 6.695V19.18c0 .836.88 1.38 1.628 1.006l3.869-1.934c.317-.159.69-.159 1.006 0l4.994 2.497c.317.158.69.158 1.006 0z" />
            </svg>
        ),
        position: 'center',
    },
    {
        title: 'Save Your Voyages',
        description: 'Every passage you plan can be saved to the logbook. Tap the bookmark icon on a completed route to save it.',
        icon: (
            <svg className="w-7 h-7" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
                <path d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0111.186 0z" />
            </svg>
        ),
        position: 'center',
    },
];

export const OnboardingTooltips: React.FC<{ onComplete?: () => void }> = ({ onComplete }) => {
    const [step, setStep] = useState(0);
    const [visible, setVisible] = useState(false);

    useEffect(() => {
        setTimeout(() => setVisible(true), 400);
    }, []);

    const handleNext = useCallback(() => {
        if (step < STEPS.length - 1) {
            setStep(s => s + 1);
        } else {
            setVisible(false);
            localStorage.setItem(TOOLTIP_KEY, 'done');
            setTimeout(() => onComplete?.(), 300);
        }
    }, [step, onComplete]);

    const handleSkip = useCallback(() => {
        setVisible(false);
        localStorage.setItem(TOOLTIP_KEY, 'done');
        setTimeout(() => onComplete?.(), 300);
    }, [onComplete]);

    const current = STEPS[step];
    const positionClass =
        current.position === 'top' ? 'items-start pt-24' :
            current.position === 'bottom' ? 'items-end pb-36' :
                'items-center';

    return (
        <div
            className={`fixed inset-0 z-[9999] flex justify-center ${positionClass} px-6 transition-all duration-300 ${visible ? 'opacity-100' : 'opacity-0 pointer-events-none'
                }`}
            style={{ background: 'radial-gradient(circle at center, rgba(0,0,0,0.7) 0%, rgba(0,0,0,0.85) 100%)' }}
            onClick={handleSkip}
        >
            <div
                className="relative max-w-sm w-full bg-slate-900/95 border border-white/10 rounded-2xl p-5 shadow-2xl shadow-black/40 backdrop-blur-xl animate-in fade-in slide-in-from-bottom-4 duration-500"
                onClick={e => e.stopPropagation()}
            >
                {/* Step dots */}
                <div className="flex justify-center gap-2 mb-4">
                    {STEPS.map((_, i) => (
                        <div
                            key={i}
                            className={`h-1.5 rounded-full transition-all duration-300 ${i === step ? 'w-6 bg-sky-400' : i < step ? 'w-1.5 bg-sky-400/50' : 'w-1.5 bg-white/15'
                                }`}
                        />
                    ))}
                </div>

                {/* Content */}
                <div className="flex items-start gap-4">
                    <div className="shrink-0 w-12 h-12 rounded-xl bg-sky-500/15 border border-sky-500/25 flex items-center justify-center text-sky-400">
                        {current.icon}
                    </div>
                    <div className="flex-1 min-w-0">
                        <h4 className="text-sm font-black text-white uppercase tracking-wider mb-1">{current.title}</h4>
                        <p className="text-sm text-white/50 leading-relaxed">{current.description}</p>
                    </div>
                </div>

                {/* Actions */}
                <div className="flex items-center justify-between mt-4 pt-3 border-t border-white/5">
                    <button
                        onClick={handleSkip}
                        className="text-sm text-white/50 hover:text-white/50 transition-colors font-medium"
                    >
                        Skip
                    </button>
                    <button
                        onClick={handleNext}
                        className="px-5 py-2 bg-sky-500/20 hover:bg-sky-500/30 border border-sky-500/30 rounded-lg text-sky-400 text-sm font-bold uppercase tracking-wider transition-all active:scale-[0.97]"
                    >
                        {step < STEPS.length - 1 ? 'Next' : 'Got it'}
                    </button>
                </div>

                {/* Step counter */}
                <p className="text-center text-[11px] text-white/40 font-bold mt-3">
                    {step + 1} of {STEPS.length}
                </p>
            </div>
        </div>
    );
};

/** Hook to manage tooltip tour visibility */
export const useOnboardingTooltips = () => {
    const [show, setShow] = useState(false);

    useEffect(() => {
        const completed = localStorage.getItem(TOOLTIP_KEY);
        if (!completed) {
            // Show after a short delay so the app loads first
            const timer = setTimeout(() => setShow(true), 3000);
            return () => clearTimeout(timer);
        }
    }, []);

    return {
        showTooltips: show,
        dismissTooltips: () => setShow(false),
        resetTooltips: () => {
            localStorage.removeItem(TOOLTIP_KEY);
        },
    };
};
