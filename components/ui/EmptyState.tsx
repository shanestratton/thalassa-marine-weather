/**
 * EmptyState — Premium empty state component for Thalassa.
 *
 * Replaces ad-hoc "emoji + grey text" patterns with a cohesive,
 * on-brand empty state that teaches the user what to do next.
 *
 * One recipe with UnavailableNotice (UX scorecard run 7: the empty and
 * unavailable pages were drawn three ways): the icon sits in the same round
 * chip, the heading has the same weight and size, the copy the same measure,
 * and the action is the house secondary Button, centred. The difference left
 * is deliberate: an unavailable page sits in a tinted card because it states
 * a condition; an empty list does not.
 *
 * Features:
 *   - Maritime-themed SVG wave illustration when there is no icon
 *   - Title + description + optional centred action
 *   - Animates in with fade + slide
 */
import React from 'react';
import { Button } from './Button';

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
    <svg
        aria-hidden="true"
        width="120"
        height="40"
        viewBox="0 0 120 40"
        fill="none"
        className="mx-auto mb-3 opacity-30"
    >
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
            {/* Decoration: an emoji icon read aloud ("fork and knife with plate")
                only repeats the title. The chip is UnavailableNotice's, and it
                sets any stroke icon to 24 px whatever size the caller drew. */}
            {icon ? (
                <div
                    aria-hidden="true"
                    className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-sky-400/15 text-2xl leading-none text-sky-300 [&_svg]:h-6 [&_svg]:w-6"
                >
                    {icon}
                </div>
            ) : (
                <WaveIllustration />
            )}

            {/* h2: it sits directly under the page's h1, so h3 skipped a level. */}
            <h2 className={`font-bold text-white text-balance ${compact ? 'text-base' : 'text-lg'}`}>{title}</h2>

            {text && <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-slate-400 text-pretty">{text}</p>}

            {actionLabel && onAction && (
                <Button
                    variant="secondary"
                    /* Called with NO arguments, on purpose. Passing the handler
                       straight to onClick handed the MouseEvent to whatever the
                       caller wired in, and the Ship's Office loaders take an
                       identity scope as their first (defaulted) parameter, so
                       the event landed in that slot, the identity guard bailed,
                       and "Try again" did nothing at all (MaintenanceHub,
                       InventoryList; found by the 2026-09-02 audit). Fixed here
                       once rather than at every call site. */
                    onClick={() => onAction()}
                    className="mt-5 text-white"
                >
                    {actionLabel}
                </Button>
            )}

            {secondaryLabel && onSecondary && (
                <button
                    type="button"
                    onClick={() => onSecondary()}
                    className="mt-2 min-h-11 px-4 text-sm text-slate-400 transition-colors hover:text-slate-200"
                >
                    {secondaryLabel}
                </button>
            )}
        </div>
    );
};
