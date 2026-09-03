/**
 * Collapsible section header for the Vessel Hub menu groups.
 */
import React, { useRef } from 'react';
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
    return (
        <button
            ref={buttonRef}
            onClick={() => {
                const wasExpanded = expanded;
                triggerHaptic('light');
                onToggle(id);
                // When opening a section that sits low on the page (Account,
                // Connect, etc.), the newly-revealed card otherwise lands
                // behind the bottom tab bar. Snap the section so its bottom
                // edge aligns with the scroll container's bottom — which
                // already sits above the tab bar thanks to the wrapper's
                // bottom padding. Wait 280 ms for the 250 ms collapse
                // animation to finish so we scroll to the FINAL height.
                if (!wasExpanded) {
                    setTimeout(() => {
                        const section = buttonRef.current?.parentElement;
                        section?.scrollIntoView({ behavior: 'smooth', block: 'end', inline: 'nearest' });
                    }, 280);
                }
            }}
            className="w-full flex items-center gap-2.5 mb-2 py-3 min-h-[44px] active:opacity-70 transition-opacity"
            aria-expanded={expanded}
            aria-label={`${expanded ? 'Collapse' : 'Expand'} ${label}`}
        >
            <div className="w-1.5 h-4 rounded-full" style={{ backgroundColor: color }} />
            <span className="text-xs font-black uppercase tracking-[0.2em] flex-1 text-left" style={{ color }}>
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
