import React, { useState, useEffect } from 'react';

interface GestureTutorialProps {
    onDismiss: () => void;
    onNeverShow?: () => void;
}

/**
 * First-time user tutorial overlay showing gesture hints
 */
export const GestureTutorial: React.FC<GestureTutorialProps> = ({
    onDismiss,
    onNeverShow,
}) => {
    const [step, setStep] = useState(0);
    const [isVisible, setIsVisible] = useState(false);

    useEffect(() => {
        // Fade in
        setTimeout(() => setIsVisible(true), 100);
    }, []);

    const steps = [
        {
            title: "Swipe Horizontally",
            description: "Scrub through hours to see weather changes throughout the day",
            icon: (
                <svg className="w-16 h-16 text-cyan-400" viewBox="0 0 64 64" fill="none">
                    <path d="M8 32h48M48 32l-8-8M48 32l-8 8M16 32l8-8M16 32l8 8"
                        stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
            ),
        },
        {
            title: "Swipe Vertically",
            description: "Navigate between days - up for tomorrow, down for yesterday",
            icon: (
                <svg className="w-16 h-16 text-cyan-400" viewBox="0 0 64 64" fill="none">
                    <path d="M32 8v48M32 8l-8 8M32 8l8 8M32 56l-8-8M32 56l8-8"
                        stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
            ),
        },
        {
            title: "Essential & Full Modes",
            description: "Toggle between quick glance (Essential) and detailed view (Full) using the button in the header",
            icon: (
                <div className="flex gap-3">
                    <div className="px-3 py-1.5 bg-cyan-500/30 border border-cyan-400/50 rounded-lg text-cyan-300 font-bold text-sm">ESS</div>
                    <div className="px-3 py-1.5 bg-white/10 border border-white/20 rounded-lg text-white/60 font-bold text-sm">FULL</div>
                </div>
            ),
        },
    ];

    const currentStep = steps[step];

    const handleNext = () => {
        if (step < steps.length - 1) {
            setStep(step + 1);
        } else {
            handleDismiss();
        }
    };

    const handleDismiss = () => {
        setIsVisible(false);
        setTimeout(onDismiss, 300);
    };

    return (
        <div
            className={`fixed inset-0 z-[1000] bg-black/80 backdrop-blur-sm flex items-center justify-center p-6 transition-opacity duration-300 ${isVisible ? 'opacity-100' : 'opacity-0'
                }`}
            onClick={handleDismiss}
        >
            <div
                className="bg-gray-900/95 border border-white/10 rounded-2xl p-6 max-w-sm w-full shadow-2xl"
                onClick={(e) => e.stopPropagation()}
            >
                {/* Step indicator */}
                <div className="flex justify-center gap-2 mb-6">
                    {steps.map((_, i) => (
                        <div
                            key={i}
                            className={`w-2 h-2 rounded-full transition-colors ${i === step ? 'bg-cyan-400' : 'bg-white/20'
                                }`}
                        />
                    ))}
                </div>

                {/* Icon */}
                <div className="flex justify-center mb-4">
                    {currentStep.icon}
                </div>

                {/* Title */}
                <h3 className="text-white text-xl font-bold text-center mb-2">
                    {currentStep.title}
                </h3>

                {/* Description */}
                <p className="text-white/70 text-center mb-6">
                    {currentStep.description}
                </p>

                {/* Buttons */}
                <div className="space-y-3">
                    <button
                        onClick={handleNext}
                        className="w-full py-3 bg-cyan-600 hover:bg-cyan-500 text-white font-semibold rounded-lg transition-colors min-h-[48px]"
                    >
                        {step < steps.length - 1 ? 'Next' : 'Get Started'}
                    </button>

                    {step === steps.length - 1 && onNeverShow && (
                        <button
                            onClick={() => {
                                onNeverShow();
                                handleDismiss();
                            }}
                            className="w-full py-2 text-white/50 hover:text-white/70 text-sm transition-colors"
                        >
                            Don't show again
                        </button>
                    )}
                </div>

                {/* Skip button */}
                {step < steps.length - 1 && (
                    <button
                        onClick={handleDismiss}
                        className="w-full mt-3 py-2 text-white/50 hover:text-white/70 text-sm transition-colors"
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

/**
 * Hook to manage tutorial visibility
 */
export const useTutorial = () => {
    const [showTutorial, setShowTutorial] = useState(false);

    useEffect(() => {
        // Check if tutorial was completed
        const completed = localStorage.getItem(TUTORIAL_KEY);
        if (!completed) {
            // Delay showing tutorial until app is loaded
            setTimeout(() => setShowTutorial(true), 2000);
        }
    }, []);

    const dismissTutorial = () => {
        setShowTutorial(false);
        localStorage.setItem(TUTORIAL_KEY, 'true');
    };

    const neverShowAgain = () => {
        localStorage.setItem(TUTORIAL_KEY, 'never');
    };

    const resetTutorial = () => {
        localStorage.removeItem(TUTORIAL_KEY);
    };

    return {
        showTutorial,
        dismissTutorial,
        neverShowAgain,
        resetTutorial,
    };
};
