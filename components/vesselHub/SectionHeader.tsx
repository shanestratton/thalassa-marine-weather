/**
 * Section headings for the Vessel Hub: the static label and the collapsible
 * header built on it.
 */
import React, { useEffect, useRef } from 'react';
import { triggerHaptic } from '../../utils/system';

/** The Settings pages' section-label style (SettingsPrimitives' Section and
 *  SettingsModal's menu labels), so the hub, the Boat Binder and Settings
 *  wear one heading: a sky dot and sky caps. It used to be a coloured bar in a
 *  different hue per section (pink Music, cyan Settings & Connect), which read
 *  as decoration beside the safety deck's state colours (UX scorecard run 7,
 *  C-section-heading-styles / C-vessel-seven-accents). text-sky-300 takes the
 *  daylight ink from styles/legibility.css like the Settings headings do. */
const LABEL_TEXT = 'ui-section-heading text-label font-bold uppercase tracking-[0.15em] text-sky-300';

/** span, not div: a heading may only hold phrasing content. As a flex item it
 *  is blockified, so it still takes w/h. */
const LabelDot: React.FC = () => (
    <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-sky-500 shadow-lg shadow-sky-500/50" />
);

/** Static section label: an h2 in the one hub heading style. */
export const SectionLabel: React.FC<{ children: React.ReactNode; className?: string }> = ({
    children,
    className = '',
}) => (
    <h2 className={`${LABEL_TEXT} flex items-center gap-2 ${className}`}>
        <LabelDot />
        {children}
    </h2>
);

/** Collapsible section header: the same label, with a disclosure chevron.
 *  Tap target: min-h-[44px] meets Apple HIG minimum so wet-handed
 *  taps on a heeled boat actually hit. The previous py-1 was ~24pt
 *  and missed half the time.
 *
 *  It is the section's h2 (the page's h1 is the hub title), with the toggle
 *  button inside it, the standard disclosure-heading pattern. The button's
 *  name is the plain label and never changes; open or closed is announced
 *  from aria-expanded, so a screen reader does not hear "Expand Atmosphere"
 *  become a different control called "Collapse Atmosphere" (UX referee).
 *  `controlsId` is the id of the panel it opens, for aria-controls. */
export const SectionHeader: React.FC<{
    label: string;
    id: string;
    expanded: boolean;
    onToggle: (id: string) => void;
    controlsId?: string;
}> = ({ label, id, expanded, onToggle, controlsId }) => {
    const headingRef = useRef<HTMLHeadingElement>(null);
    const buttonRef = useRef<HTMLButtonElement>(null);
    const revealRequested = useRef(false);

    useEffect(() => {
        if (!expanded || !revealRequested.current) return;
        revealRequested.current = false;
        const button = buttonRef.current;
        // The heading wraps the button, so the section and its collapsible
        // content are the HEADING's parent and next sibling.
        const heading = headingRef.current;
        const section = heading?.parentElement;
        const content = heading?.nextElementSibling;
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
        // No bottom margin: two collapsed headers sat ~40pt apart (UX scorecard
        // run 6). The gap to the rows lives inside the collapsible content, so
        // it animates open with them and costs nothing while closed.
        <h2 ref={headingRef}>
            <button
                ref={buttonRef}
                type="button"
                onClick={() => {
                    revealRequested.current = !expanded;
                    triggerHaptic('light');
                    onToggle(id);
                }}
                className="w-full flex items-center gap-2 py-3 min-h-[44px] active:opacity-70 transition-opacity"
                aria-expanded={expanded}
                aria-controls={controlsId}
                aria-label={label}
            >
                <LabelDot />
                <span className={`${LABEL_TEXT} flex-1 text-left`}>{label}</span>
                {/* Full ink in the label's colour: at 60 % opacity the daylight
                    chevrons measured 2.4-2.9:1 on the #e2e8f0 page (UX scorecard
                    run 7, L-vessel-daylight-chevrons). */}
                <svg
                    aria-hidden="true"
                    className="w-4 h-4 shrink-0 text-sky-300 transition-transform duration-200"
                    style={{
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
        </h2>
    );
};
