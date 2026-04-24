/**
 * CoachMark — Reusable one-shot affordance overlay.
 *
 * Pattern:
 *   - Appears once per install (tracked via localStorage `thalassa_*_seen` keys
 *     so it survives app restarts but not fresh installs)
 *   - Dismisses on tap, ESC, timeout, or explicit programmatic close
 *   - Non-blocking — positioned absolutely with pointer-events: none on the
 *     backdrop so the underlying UI stays fully interactive
 *   - Never shouts — subtle glow + arrow that draws the eye without
 *     pre-empting the user's own exploration
 *
 * Usage:
 *   <CoachMark
 *       seenKey="thalassa_hero_pin_coach_v1"
 *       visibleWhen={heroMetric === 'temp'}
 *       anchor="top-right"
 *       message="Tap to pin any metric here"
 *       ttlMs={6000}
 *   />
 *
 * Composition with the affordance it's teaching is by DOM positioning —
 * CoachMark is placed as a sibling inside the container that wraps the
 * interactive element, and uses `anchor` to point itself at the right
 * corner. No cross-component ref-plumbing required.
 */
import React, { useEffect, useState } from 'react';

type CoachMarkAnchor = 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left' | 'center';

interface CoachMarkProps {
    /** localStorage key — set to '1' when dismissed so it never fires again. */
    seenKey: string;
    /** Render gate. Coach mark only evaluates the seen flag when this is true. */
    visibleWhen: boolean;
    /** Where on the parent container to position the mark. */
    anchor?: CoachMarkAnchor;
    /** The coach copy. One sentence, imperative voice. */
    message: string;
    /** Auto-dismiss after this many ms. Default 6000. */
    ttlMs?: number;
    /** Delay before first render — gives the mounting animation room. */
    initialDelayMs?: number;
    /** Which direction the arrow points. Defaults to opposite of anchor. */
    arrow?: 'up' | 'down' | 'left' | 'right';
    /** Extra class merged onto the outer wrapper (custom positioning). */
    className?: string;
}

const ANCHOR_CLASSES: Record<CoachMarkAnchor, string> = {
    'top-right': 'top-2 right-2 items-end',
    'top-left': 'top-2 left-2 items-start',
    'bottom-right': 'bottom-2 right-2 items-end',
    'bottom-left': 'bottom-2 left-2 items-start',
    center: 'top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 items-center',
};

const DEFAULT_ARROW: Record<CoachMarkAnchor, 'up' | 'down' | 'left' | 'right'> = {
    'top-right': 'up',
    'top-left': 'up',
    'bottom-right': 'down',
    'bottom-left': 'down',
    center: 'down',
};

/** Small triangular arrow pointing at the affordance. */
const ArrowGlyph: React.FC<{ direction: 'up' | 'down' | 'left' | 'right' }> = ({ direction }) => {
    const rotation = direction === 'up' ? 0 : direction === 'right' ? 90 : direction === 'down' ? 180 : 270;
    return (
        <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="currentColor"
            style={{ transform: `rotate(${rotation}deg)` }}
            aria-hidden="true"
        >
            <path d="M12 2 L22 16 L2 16 Z" />
        </svg>
    );
};

export const CoachMark: React.FC<CoachMarkProps> = ({
    seenKey,
    visibleWhen,
    anchor = 'top-right',
    message,
    ttlMs = 6000,
    initialDelayMs = 800,
    arrow,
    className = '',
}) => {
    // Lazy-initialise from localStorage so SSR or non-DOM environments don't
    // crash. Default to true (already seen) if localStorage is unavailable —
    // skipping the coach is safer than showing it in an unknown environment.
    const [seen, setSeen] = useState<boolean>(() => {
        try {
            return localStorage.getItem(seenKey) === '1';
        } catch {
            return true;
        }
    });
    const [showing, setShowing] = useState(false);

    // Mount effect: gate on seen + visibleWhen, then delay show, then auto-hide.
    useEffect(() => {
        if (seen || !visibleWhen) {
            setShowing(false);
            return;
        }
        const showT = setTimeout(() => setShowing(true), initialDelayMs);
        const hideT = setTimeout(() => {
            setShowing(false);
            try {
                localStorage.setItem(seenKey, '1');
            } catch {
                /* no-op */
            }
            setSeen(true);
        }, initialDelayMs + ttlMs);
        return () => {
            clearTimeout(showT);
            clearTimeout(hideT);
        };
    }, [seen, visibleWhen, initialDelayMs, ttlMs, seenKey]);

    // ESC dismisses the coach immediately.
    useEffect(() => {
        if (!showing) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                setShowing(false);
                try {
                    localStorage.setItem(seenKey, '1');
                } catch {
                    /* no-op */
                }
                setSeen(true);
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [showing, seenKey]);

    if (!showing) return null;

    const arrowDir = arrow ?? DEFAULT_ARROW[anchor];
    const anchorClass = ANCHOR_CLASSES[anchor];
    // Stack arrow above the message when pointing up, below when pointing
    // down. Side-pointing arrows go inline to the appropriate edge.
    const stackDir =
        arrowDir === 'up'
            ? 'flex-col'
            : arrowDir === 'down'
              ? 'flex-col-reverse'
              : arrowDir === 'right'
                ? 'flex-row-reverse'
                : 'flex-row';

    return (
        <div
            className={`absolute z-[200] flex ${stackDir} gap-1 pointer-events-none ${anchorClass} ${className} animate-in fade-in slide-in-from-bottom-2 duration-300`}
            role="status"
            aria-live="polite"
        >
            <span className="text-sky-300 drop-shadow-[0_0_6px_rgba(56,189,248,0.6)] animate-bounce-subtle">
                <ArrowGlyph direction={arrowDir} />
            </span>
            <div
                className="px-2.5 py-1.5 rounded-lg bg-slate-900/95 border border-sky-400/40 text-[11px] font-semibold uppercase tracking-wider text-sky-200 shadow-lg max-w-[220px] leading-tight text-center"
                style={{
                    boxShadow: '0 0 20px -4px rgba(56,189,248,0.4), 0 4px 12px rgba(0,0,0,0.4)',
                }}
            >
                {message}
            </div>
        </div>
    );
};

CoachMark.displayName = 'CoachMark';
