/**
 * BackButton — the one header back chevron.
 *
 * There were 14 hand-rolled back buttons in the tree and they had drifted into
 * three different looks: this rounded square (PageHeader, and therefore most
 * pages), a round pill with a text "‹" glyph in the
 * Scuttlebutt header, and a couple of inline text links. Shane spotted the odd
 * one out. Rather than hand-copy the markup a fourth time, it lives here.
 *
 * The 44x44 minimum is deliberate and not negotiable: it is the marine touch
 * target — a wet, cold hand on a moving boat — and it is the reason this uses
 * padding plus min-w/min-h rather than a fixed w-/h- pair, so the hit area
 * holds even if the icon changes size.
 *
 * Inline text-link "back" affordances (CrewDetailView, PlaceholderScreens) are
 * a genuinely different pattern and are NOT in scope for this component.
 */
import React from 'react';

interface BackButtonProps {
    onClick: () => void;
    /** Accessible name. Defaults to "Go back", which is what most callers used. */
    label?: string;
    /** Extra classes for layout only — do not restyle the chrome here. */
    className?: string;
}

/** Ref-forwarding, because overlay callers focus this button as the first
 *  focusable element in a focus trap. */
export const BackButton = React.forwardRef<HTMLButtonElement, BackButtonProps>(
    ({ onClick, label = 'Go back', className = '' }, ref) => (
        <button
            ref={ref}
            type="button"
            onClick={onClick}
            aria-label={label}
            className={`press flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl bg-white/5 p-2 transition-colors hover:bg-white/10 ${className}`}
        >
            <svg
                className="h-5 w-5 text-gray-400"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
            >
                <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
            </svg>
        </button>
    ),
);
BackButton.displayName = 'BackButton';
