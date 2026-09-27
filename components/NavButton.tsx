/**
 * @fileoverview "New Wave" tactical navigation button — neon glow theme
 * @module components/NavButton
 *
 * 44px min touch targets · embedded SVG icons · GPU-optimized glow
 */

import React, { useCallback, useId, useRef } from 'react';
import { triggerHaptic } from '../utils/system';

interface NavButtonProps {
    /** Icon element to display */
    icon: React.ReactNode;
    /** Button label text. Also the accessible name, so Voice Control's "Tap Log" finds it. */
    label: string;
    /** Only when the name must differ from the visible label; it should still start with it. */
    ariaLabel?: string;
    /**
     * A plain gloss for a short tab word ('Obs' → 'Charts and observations'),
     * read as the button's description and shown as its pointer tooltip. The
     * name stays the visible word, so Voice Control's "Tap Obs" still works.
     */
    hint?: string;
    /** Whether this tab is the current page (announced as aria-current="page") */
    active: boolean;
    /** Click handler */
    onClick: () => void;
    /** Optional unread badge count (true = dot only, number = count) */
    badge?: boolean | number;
    /**
     * Held rather than tapped. Used by The Glass to toggle the tablet split view.
     *
     * A tab bar is pressed constantly and often on a moving boat, so the press
     * must not fire as well as the tap: whichever wins, exactly one thing
     * happens. Movement cancels it too — a thumb sliding across the bar while
     * the boat rolls is not a deliberate hold.
     */
    onLongPress?: () => void;
}

/**
 * Navigation button for the bottom tab bar.
 * Neon "New Wave" aesthetic with electric cyan glow.
 * Minimum 44×44 touch target for vessel movement/pitching safety.
 */
export const NavButton: React.FC<NavButtonProps> = ({
    icon,
    label,
    ariaLabel,
    hint,
    active,
    onClick,
    badge,
    onLongPress,
}) => {
    const hintId = useId();
    const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const held = useRef(false);
    const origin = useRef<{ x: number; y: number } | null>(null);

    const cancelHold = useCallback(() => {
        if (holdTimer.current) {
            clearTimeout(holdTimer.current);
            holdTimer.current = null;
        }
        origin.current = null;
    }, []);

    const beginHold = useCallback(
        (event: React.PointerEvent) => {
            if (!onLongPress) return;
            held.current = false;
            origin.current = { x: event.clientX, y: event.clientY };
            holdTimer.current = setTimeout(() => {
                held.current = true;
                triggerHaptic('medium');
                onLongPress();
            }, 500);
        },
        [onLongPress],
    );

    // A slide is not a hold. 10px is enough to tell a deliberate press from a
    // thumb travelling across the bar as the boat moves.
    const maybeCancelOnMove = useCallback(
        (event: React.PointerEvent) => {
            const from = origin.current;
            if (!from) return;
            if (Math.abs(event.clientX - from.x) > 10 || Math.abs(event.clientY - from.y) > 10) cancelHold();
        },
        [cancelHold],
    );

    return (
        <button
            onClick={() => {
                // The hold already did something; do not also navigate.
                if (held.current) {
                    held.current = false;
                    return;
                }
                if (!active) triggerHaptic('light');
                onClick();
            }}
            onPointerDown={beginHold}
            onPointerUp={cancelHold}
            onPointerLeave={cancelHold}
            onPointerCancel={cancelHold}
            onPointerMove={maybeCancelOnMove}
            onTouchStart={() => {}} // Forces immediate touch response
            type="button"
            // Page links in a <nav aria-label="Main">, not an ARIA tablist: the
            // name is the visible label (no "Navigate to …"), and the current
            // page is aria-current. The unread badge stays out of the name.
            aria-label={ariaLabel ?? label}
            aria-describedby={hint ? hintId : undefined}
            title={hint}
            aria-current={active ? 'page' : undefined}
            // The bottom padding keeps the label at least 8 pt off the bar's
            // edge where there is no home-indicator inset; with one, the nav's
            // own inset padding already does it and this falls to 0.
            className="relative z-50 cursor-pointer flex flex-col items-center justify-center gap-1 min-w-[44px] min-h-[44px] h-full pb-[max(0px,calc(8px_-_env(safe-area-inset-bottom)))] transition-all duration-200 active:scale-95 touch-manipulation"
            style={{
                pointerEvents: 'auto',
                touchAction: 'manipulation',
                WebkitTapHighlightColor: 'transparent',
            }}
        >
            <div
                className="relative flex items-center justify-center"
                style={{
                    // Active-state treatment, v3 — minimal (2026-05-17).
                    //
                    // History
                    // -------
                    //   v1 (original): brightness 1.2 + sea-foam drop-shadow-sm
                    //      6 px @ 0.5 + scale 1.1. Three competing signals
                    //      yelling at the same time.
                    //   v2 (earlier today): brightness 1.08 + cyan drop-
                    //      shadow 3 px @ 0.35 + scale 1.04. Cleaner, but
                    //      still read brighter than intended on iOS where
                    //      the OLED contrast makes glow halos punchier.
                    //   v3 (here): drop the drop-shadow-sm entirely. Keep
                    //      JUST brightness + scale. The icon's inherent
                    //      cyan colour (set by the parent NavBar when
                    //      active) IS the "you are here" signal — it
                    //      doesn't need a halo announcing it. The white
                    //      indicator dot below the label finishes the job.
                    //
                    // Visual A/B test PNGs at /tmp/nav-glow-test.html
                    // settled on this variant (option C — "Minimal").
                    filter: active ? 'brightness(1.10)' : 'none',
                    transform: active ? 'scale(1.03)' : 'none',
                    transition: 'all 0.2s ease-in-out',
                    willChange: 'transform, filter',
                    width: 32,
                    height: 32,
                }}
            >
                {icon}
                {badge && (
                    <span className="absolute -top-1 -right-1.5 flex items-center justify-center min-w-[14px] h-[14px] bg-red-500 rounded-full border-2 border-slate-900 shadow-lg shadow-red-500/30">
                        {typeof badge === 'number' && badge > 0 && (
                            <span className="text-[11px] font-black text-white leading-none px-0.5">
                                {badge > 99 ? '99+' : badge}
                            </span>
                        )}
                    </span>
                )}
            </div>
            <span className="relative flex flex-col items-center">
                <span
                    style={{
                        // 12, not 11: the app's legibility floor (--text-micro) —
                        // this was the one label under it on every single page.
                        fontSize: 12,
                        fontWeight: 900,
                        textTransform: 'uppercase',
                        letterSpacing: '0.08em',
                        // FIXED light-on-dark. The bar itself keeps the night
                        // palette in daylight mode (App.tsx), so the day-mode text
                        // tokens made the ACTIVE label near-black on near-black
                        // (1.08:1, measured 2026-09-25) and dimmed the rest to
                        // 2.5:1. Whatever the display mode, the label sits on
                        // rgba(10,15,20) and is coloured for that.
                        color: active ? 'rgba(255, 255, 255, 0.95)' : 'rgba(255, 255, 255, 0.72)',
                        lineHeight: 1,
                        transition: 'color 0.2s ease',
                        whiteSpace: 'nowrap',
                    }}
                >
                    {label}
                </span>
                {hint && (
                    <span id={hintId} className="sr-only">
                        {hint}
                    </span>
                )}
                {active && (
                    // White indicator dot, 3 px under the label box. Pinned to
                    // the button's bottom edge it sat on the label's baseline
                    // under LOG and ran into VESSEL at 375 pt (UX scorecard run 7).
                    // The box-shadow halo was removed in v3 (matched the icon's
                    // glow removal above); solid 0.85 alpha is plenty on the
                    // dark bar, which it sits on in every display mode.
                    <span
                        aria-hidden="true"
                        className="pointer-events-none absolute left-1/2 top-full mt-[3px] h-1 w-1 -translate-x-1/2 rounded-full"
                        style={{ backgroundColor: 'rgba(255, 255, 255, 0.85)' }}
                    />
                )}
            </span>
        </button>
    );
};
