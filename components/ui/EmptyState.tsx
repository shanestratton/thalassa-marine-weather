/**
 * EmptyState — Premium empty state component for Thalassa.
 *
 * Replaces ad-hoc "emoji + grey text" patterns with a cohesive,
 * on-brand empty state that teaches the user what to do next.
 *
 * Features:
 *   - Maritime-themed SVG wave illustration
 *   - Title + description + optional CTA button
 *   - Consistent with glassmorphic design system
 *   - Animates in with fade + slide
 */
import React from 'react';

interface EmptyStateProps {
    /** Emoji or icon to display (optional — defaults to wave illustration) */
    icon?: React.ReactNode;
    /** Main heading */
    title: string;
    /** Descriptive text explaining what to do */
    description?: string;
    /** Alias for description (backward compat) */
    subtitle?: string;
    /** CTA button label */
    actionLabel?: string;
    /** CTA button handler */
    onAction?: () => void;
    /** Secondary action label */
    secondaryLabel?: string;
    /** Secondary action handler */
    onSecondary?: () => void;
    /** Compact mode — less padding */
    compact?: boolean;
    /** Optional CSS class override */
    className?: string;
}

/** Subtle animated wave SVG */
const WaveIllustration: React.FC = () => (
    <svg width="120" height="40" viewBox="0 0 120 40" fill="none" className="mx-auto mb-3 opacity-30">
        <path
            d="M0 20 Q15 8 30 20 Q45 32 60 20 Q75 8 90 20 Q105 32 120 20"
            stroke="url(#wave-gradient)"
            strokeWidth="2"
            strokeLinecap="round"
            fill="none"
        >
            <animate
                attributeName="d"
                values="M0 20 Q15 8 30 20 Q45 32 60 20 Q75 8 90 20 Q105 32 120 20;M0 20 Q15 28 30 20 Q45 12 60 20 Q75 28 90 20 Q105 12 120 20;M0 20 Q15 8 30 20 Q45 32 60 20 Q75 8 90 20 Q105 32 120 20"
                dur="4s"
                repeatCount="indefinite"
            />
        </path>
        <defs>
            <linearGradient id="wave-gradient" x1="0" y1="0" x2="120" y2="0" gradientUnits="userSpaceOnUse">
                <stop offset="0%" stopColor="#0ea5e9" stopOpacity="0.6" />
                <stop offset="50%" stopColor="#14b8a6" stopOpacity="0.8" />
                <stop offset="100%" stopColor="#0ea5e9" stopOpacity="0.6" />
            </linearGradient>
        </defs>
    </svg>
);

export const EmptyState: React.FC<EmptyStateProps> = ({
    icon,
    title,
    description,
    subtitle,
    actionLabel,
    onAction,
    secondaryLabel,
    onSecondary,
    compact = false,
    className,
}) => {
    const text = description || subtitle;
    return (
        <div
            className={`flex flex-col items-center justify-center text-center ${compact ? 'py-6 px-4' : 'py-10 px-6'} ${className || ''}`}
            style={{ animation: 'bio-fadein 0.4s ease' }}
        >
            {icon ? <div className="text-3xl mb-3">{icon}</div> : <WaveIllustration />}

            <h3 className={`font-black text-white tracking-wide ${compact ? 'text-sm' : 'text-base'}`}>{title}</h3>

            {text && (
                <p className={`text-gray-400 mt-1.5 max-w-xs leading-relaxed ${compact ? 'text-[11px]' : 'text-xs'}`}>
                    {text}
                </p>
            )}

            {actionLabel && onAction && (
                <button
                    onClick={onAction}
                    className="mt-4 px-5 py-2.5 rounded-xl bg-sky-500/15 border border-sky-500/30 text-sky-400 text-xs font-bold uppercase tracking-wider hover:bg-sky-500/25 transition-all active:scale-95"
                >
                    {actionLabel}
                </button>
            )}

            {secondaryLabel && onSecondary && (
                <button
                    onClick={onSecondary}
                    className="mt-2 px-4 py-1.5 text-[11px] text-gray-500 hover:text-gray-300 transition-colors"
                >
                    {secondaryLabel}
                </button>
            )}
        </div>
    );
};
