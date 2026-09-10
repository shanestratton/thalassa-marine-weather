/**
 * Collapsible section header for the Vessel Hub menu groups.
 */
import React, { useEffect, useRef } from 'react';
import { triggerHaptic } from '../../utils/system';

/** Collapsible section header with colored pip and chevron.
 *  Tap target: min-h-[44px] meets Apple HIG minimum so wet-handed
 *  taps on a heeled boat actually hit. The previous py-1 was ~24pt
 *  and missed half the time. */
export const SectionHeader: React.FC<{
    color: string;
    label: string;
    id: string;
    expanded: boolean;
    onToggle: (id: string) => void;
}> = ({ color, label, id, expanded, onToggle }) => {
    const buttonRef = useRef<HTMLButtonElement>(null);
    const revealRequested = useRef(false);

    useEffect(() => {
        if (!expanded || !revealRequested.current) return;
        revealRequested.current = false;
        const button = buttonRef.current;
        const section = button?.parentElement;
        const content = button?.nextElementSibling;
        const port = section?.parentElement;
        if (!section || !content || !port) return;

        let cancelled = false;
        const gestures = ['pointerdown', 'touchmove', 'wheel', 'keydown'] as const;
        const removeListeners = () => {
            for (const event of gestures) port.removeEventListener(event, cancel);
        };
        const cancel = () => {
            cancelled = true;
            cancelAnimationFrame(frame);
            removeListeners();
        };
        // Start after React commits the expanded state. A fixed 280ms delay
        // from the tap can expire before the 250ms grid transition ends when
        // its first rendering frame is late, leaving the last row clipped.
        const frame = requestAnimationFrame(async () => {
            if (cancelled || !section.isConnected || button?.getAttribute('aria-expanded') !== 'true') return;
            void content.getBoundingClientRect();
            // Only this wrapper's finite expansion, never animations on its
            // descendants (which can include continuously running indicators).
            const animations = content.getAnimations().filter((animation) => {
                const end = animation.effect?.getComputedTiming().endTime;
                return (
                    typeof end === 'number' &&
                    Number.isFinite(end) &&
                    (animation.playState === 'running' || animation.pending)
                );
            });
            await Promise.allSettled(animations.map((animation) => animation.finished));
            removeListeners();
            if (cancelled || !section.isConnected || button?.getAttribute('aria-expanded') !== 'true') return;
            section.scrollIntoView({ behavior: 'smooth', block: 'end', inline: 'nearest' });
        });
        // A fresh gesture belongs to the user, not this pending automatic
        // reveal. Closing/reopening or leaving the pane also cancels it.
        for (const event of gestures) port.addEventListener(event, cancel, { passive: true });
        return cancel;
    }, [expanded, id]);

    return (
        <button
            ref={buttonRef}
            onClick={() => {
                revealRequested.current = !expanded;
                triggerHaptic('light');
                onToggle(id);
            }}
            className="w-full flex items-center gap-2.5 mb-2 py-3 min-h-[44px] active:opacity-70 transition-opacity"
            aria-expanded={expanded}
            aria-label={`${expanded ? 'Collapse' : 'Expand'} ${label}`}
        >
            <div className="w-1.5 h-4 rounded-full" style={{ backgroundColor: color }} />
            <span
                className="ui-section-heading text-xs font-bold uppercase tracking-[0.2em] flex-1 text-left"
                style={{ color }}
            >
                {label}
            </span>
            <svg
                className="w-4 h-4 transition-transform duration-200"
                style={{
                    color,
                    opacity: 0.6,
                    transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)',
                }}
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2.5}
            >
                <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
            </svg>
        </button>
    );
};
