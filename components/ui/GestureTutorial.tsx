import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { t } from '../../theme';
import {
    authScopedStorageKey,
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
    type AuthIdentityScope,
} from '../../services/authIdentityScope';

interface GestureTutorialProps {
    onDismiss: () => void;
    onNeverShow?: () => void;
}

/**
 * First-time user tutorial overlay showing gesture hints
 */
export const GestureTutorial: React.FC<GestureTutorialProps> = ({ onDismiss, onNeverShow }) => {
    const [step, setStep] = useState(0);
    const [isVisible, setIsVisible] = useState(false);
    const fadeTimerRef = useRef<number | null>(null);
    const dismissTimerRef = useRef<number | null>(null);
    const isDismissingRef = useRef(false);
    const primaryActionRef = useRef<HTMLButtonElement>(null);

    useEffect(() => {
        // Fade in
        fadeTimerRef.current = window.setTimeout(() => setIsVisible(true), 100);
        return () => {
            if (fadeTimerRef.current !== null) window.clearTimeout(fadeTimerRef.current);
            if (dismissTimerRef.current !== null) window.clearTimeout(dismissTimerRef.current);
        };
    }, []);

    const steps = [
        {
            title: 'Swipe Horizontally',
            description: 'Scrub through hours to see weather changes throughout the day',
            icon: (
                <svg className="w-16 h-16 text-sky-400" viewBox="0 0 64 64" fill="none">
                    <path
                        d="M8 32h48M48 32l-8-8M48 32l-8 8M16 32l8-8M16 32l8 8"
                        stroke="currentColor"
                        strokeWidth="3"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                    />
                </svg>
            ),
        },
        {
            title: 'Swipe Vertically',
            description: 'Navigate between days - up for tomorrow, down for yesterday',
            icon: (
                <svg className="w-16 h-16 text-sky-400" viewBox="0 0 64 64" fill="none">
                    <path
                        d="M32 8v48M32 8l-8 8M32 8l8 8M32 56l-8-8M32 56l8-8"
                        stroke="currentColor"
                        strokeWidth="3"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                    />
                </svg>
            ),
        },
        {
            title: 'Essential & Full Modes',
            description:
                'Toggle between quick glance (Essential) and detailed view (Full) using the button in the header',
            icon: (
                <div className="flex gap-3">
                    <div className="px-3 py-1.5 bg-sky-500/30 border border-sky-400/50 rounded-lg text-sky-300 font-bold text-sm">
                        ESS
                    </div>
                    <div
                        className={`px-3 py-1.5 bg-white/10 ${t.border.strong} rounded-lg text-white/60 font-bold text-sm`}
                    >
                        FULL
                    </div>
                </div>
            ),
        },
        {
            title: 'Delete Voyages',
            description: "In the Ship's Log, swipe left on any voyage to reveal the delete option",
            icon: (
                <svg className="w-16 h-16 text-red-400" viewBox="0 0 64 64" fill="none">
                    <path
                        d="M48 32H16M16 32l8-8M16 32l8 8"
                        stroke="currentColor"
                        strokeWidth="3"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                    />
                    <rect
                        x="44"
                        y="24"
                        width="12"
                        height="16"
                        rx="2"
                        fill="currentColor"
                        fillOpacity="0.3"
                        stroke="currentColor"
                        strokeWidth="2"
                    />
                    <path
                        d="M50 28v8M50 28l-2 2M50 28l2 2"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                    />
                </svg>
            ),
        },
    ];

    const currentStep = steps[step];

    const handleDismiss = useCallback(() => {
        if (isDismissingRef.current) return;
        isDismissingRef.current = true;
        if (fadeTimerRef.current !== null) {
            window.clearTimeout(fadeTimerRef.current);
            fadeTimerRef.current = null;
        }
        setIsVisible(false);
        dismissTimerRef.current = window.setTimeout(onDismiss, 300);
    }, [onDismiss]);

    const dialogRef = useFocusTrap<HTMLDivElement>(isVisible, {
        initialFocusRef: primaryActionRef,
        onEscape: handleDismiss,
    });

    const handleNext = () => {
        if (step < steps.length - 1) {
            setStep(step + 1);
        } else {
            handleDismiss();
        }
    };

    return (
        <div
            role="presentation"
            className={`fixed inset-0 z-[1000] bg-black/80 flex items-center justify-center p-6 transition-opacity duration-300 ${
                isVisible ? 'opacity-100' : 'opacity-0'
            }`}
            onClick={handleDismiss}
        >
            <div
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-hidden={isVisible ? undefined : true}
                aria-labelledby="gesture-tutorial-title"
                aria-describedby="gesture-tutorial-progress gesture-tutorial-description"
                className={`bg-gray-900/95 ${t.border.default} rounded-2xl p-6 max-w-sm w-full shadow-2xl`}
                onClick={(e) => e.stopPropagation()}
            >
                <p id="gesture-tutorial-progress" className="sr-only">
                    Step {step + 1} of {steps.length}
                </p>

                {/* Step indicator */}
                <div aria-hidden="true" className="flex justify-center gap-2 mb-6">
                    {steps.map((_, i) => (
                        <div
                            key={i}
                            className={`w-2 h-2 rounded-full transition-colors ${
                                i === step ? 'bg-sky-400' : 'bg-white/20'
                            }`}
                        />
                    ))}
                </div>

                {/* Icon */}
                <div aria-hidden="true" className="flex justify-center mb-4">
                    {currentStep.icon}
                </div>

                {/* Title */}
                <h3 id="gesture-tutorial-title" className="text-white text-xl font-bold text-center mb-2">
                    {currentStep.title}
                </h3>

                {/* Description */}
                <p id="gesture-tutorial-description" className="text-white/70 text-center mb-6">
                    {currentStep.description}
                </p>

                {/* Buttons */}
                <div className="space-y-3">
                    <button
                        ref={primaryActionRef}
                        onClick={handleNext}
                        className="w-full py-3 bg-sky-600 hover:bg-sky-500 text-white font-semibold rounded-lg transition-colors min-h-[48px]"
                        aria-label={
                            step < steps.length - 1 ? `Next: ${steps[step + 1].title}` : 'Finish gesture tutorial'
                        }
                    >
                        {step < steps.length - 1 ? 'Next' : 'Get Started'}
                    </button>

                    {step === steps.length - 1 && onNeverShow && (
                        <button
                            aria-label="Never show gesture tutorial again"
                            onClick={() => {
                                onNeverShow();
                                handleDismiss();
                            }}
                            className="w-full py-2 text-white/60 hover:text-white/70 text-sm transition-colors"
                        >
                            Don't show again
                        </button>
                    )}
                </div>

                {/* Skip button */}
                {step < steps.length - 1 && (
                    <button
                        onClick={handleDismiss}
                        className="w-full mt-3 py-2 text-white/60 hover:text-white/70 text-sm transition-colors"
                        aria-label="Skip gesture tutorial"
                    >
                        Skip tutorial
                    </button>
                )}
            </div>
        </div>
    );
};

// Storage key for tutorial state
const TUTORIAL_KEY = 'thalassa_tutorial_completed';
const subscribeIdentitySnapshot = (notify: () => void): (() => void) => subscribeAuthIdentityScope(() => notify());
const getIdentitySnapshot = (): AuthIdentityScope => getAuthIdentityScope();

/**
 * Hook to manage tutorial visibility
 */
export const useTutorial = () => {
    const identityScope = useSyncExternalStore(subscribeIdentitySnapshot, getIdentitySnapshot, getIdentitySnapshot);
    const [visibleScope, setVisibleScope] = useState<AuthIdentityScope | null>(null);
    const showTutorial =
        visibleScope !== null &&
        visibleScope.key === identityScope.key &&
        visibleScope.generation === identityScope.generation &&
        isAuthIdentityScopeCurrent(visibleScope);

    useEffect(() => {
        const actionScope = identityScope;
        // Check if tutorial was completed
        const completed = localStorage.getItem(authScopedStorageKey(TUTORIAL_KEY, actionScope));
        if (!completed) {
            // Delay showing tutorial until app is loaded
            const timer = window.setTimeout(() => {
                if (isAuthIdentityScopeCurrent(actionScope)) setVisibleScope(actionScope);
            }, 2000);
            return () => window.clearTimeout(timer);
        }
        return undefined;
    }, [identityScope]);

    const dismissTutorial = () => {
        if (!isAuthIdentityScopeCurrent(identityScope)) return;
        setVisibleScope(null);
        localStorage.setItem(authScopedStorageKey(TUTORIAL_KEY, identityScope), 'true');
    };

    const neverShowAgain = () => {
        if (!isAuthIdentityScopeCurrent(identityScope)) return;
        localStorage.setItem(authScopedStorageKey(TUTORIAL_KEY, identityScope), 'never');
    };

    const resetTutorial = () => {
        localStorage.removeItem(authScopedStorageKey(TUTORIAL_KEY, identityScope));
    };

    return {
        showTutorial,
        dismissTutorial,
        neverShowAgain,
        resetTutorial,
    };
};
