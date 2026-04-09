/**
 * FirstRunHint — Contextual onboarding tooltip for Thalassa.
 *
 * Shows a subtle, pulsing hint the first time a user encounters a feature.
 * Dismisses on tap and stores dismissal in localStorage so it only shows once.
 *
 * Usage:
 *   <FirstRunHint id="map-layers" message="Tap here to toggle chart layers">
 *     <LayerButton />
 *   </FirstRunHint>
 */
import React, { useState, useEffect } from 'react';

interface FirstRunHintProps {
    /** Unique ID for this hint (persisted in localStorage) */
    id: string;
    /** Hint message text */
    message: string;
    /** Position of the tooltip relative to child */
    position?: 'top' | 'bottom' | 'left' | 'right';
    /** Delay before showing (ms) — gives the page time to render */
    delay?: number;
    /** Children to wrap */
    children: React.ReactNode;
}

const STORAGE_PREFIX = 'thalassa_hint_';

export const FirstRunHint: React.FC<FirstRunHintProps> = ({
    id,
    message,
    position = 'bottom',
    delay = 1500,
    children,
}) => {
    const [visible, setVisible] = useState(false);

    useEffect(() => {
        const dismissed = localStorage.getItem(`${STORAGE_PREFIX}${id}`);
        if (dismissed) return;

        const timer = setTimeout(() => setVisible(true), delay);
        return () => clearTimeout(timer);
    }, [id, delay]);

    const dismiss = () => {
        setVisible(false);
        localStorage.setItem(`${STORAGE_PREFIX}${id}`, '1');
    };

    const positionClasses: Record<string, string> = {
        top: 'bottom-full left-1/2 -translate-x-1/2 mb-2',
        bottom: 'top-full left-1/2 -translate-x-1/2 mt-2',
        left: 'right-full top-1/2 -translate-y-1/2 mr-2',
        right: 'left-full top-1/2 -translate-y-1/2 ml-2',
    };

    const arrowClasses: Record<string, string> = {
        top: 'top-full left-1/2 -translate-x-1/2 border-l-transparent border-r-transparent border-b-transparent border-t-sky-500/30',
        bottom: 'bottom-full left-1/2 -translate-x-1/2 border-l-transparent border-r-transparent border-t-transparent border-b-sky-500/30',
        left: 'left-full top-1/2 -translate-y-1/2 border-t-transparent border-b-transparent border-r-transparent border-l-sky-500/30',
        right: 'right-full top-1/2 -translate-y-1/2 border-t-transparent border-b-transparent border-l-transparent border-r-sky-500/30',
    };

    return (
        <div className="relative w-full">
            {/* Must be full-width so child rows stretch to match siblings */}
            {children}

            {visible && (
                <div
                    className={`absolute z-[1000] ${positionClasses[position]}`}
                    style={{ animation: 'bio-fadein 0.3s ease' }}
                >
                    <button
                        onClick={dismiss}
                        className="relative px-3 py-2 rounded-xl text-[11px] text-sky-300 font-bold whitespace-nowrap max-w-[200px] text-center leading-relaxed"
                        style={{
                            background: 'rgba(14, 165, 233, 0.12)',
                            backdropFilter: 'blur(12px)',
                            WebkitBackdropFilter: 'blur(12px)',
                            border: '1px solid rgba(14, 165, 233, 0.25)',
                            boxShadow: '0 4px 20px rgba(14, 165, 233, 0.15)',
                        }}
                    >
                        {message}
                        {/* Pulsing dot */}
                        <span className="absolute -top-1 -right-1 w-2.5 h-2.5 bg-sky-400 rounded-full animate-pulse shadow-lg shadow-sky-400/50" />
                    </button>
                    {/* Arrow */}
                    <div className={`absolute w-0 h-0 border-[5px] ${arrowClasses[position]}`} />
                </div>
            )}
        </div>
    );
};

/** Utility: Reset all hints (for testing) */
export const resetAllHints = () => {
    const keys = Object.keys(localStorage).filter((k) => k.startsWith(STORAGE_PREFIX));
    keys.forEach((k) => localStorage.removeItem(k));
};
