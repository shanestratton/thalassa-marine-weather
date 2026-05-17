/**
 * @fileoverview "New Wave" tactical navigation button — neon glow theme
 * @module components/NavButton
 *
 * 44px min touch targets · embedded SVG icons · GPU-optimized glow
 */

import React from 'react';
import { triggerHaptic } from '../utils/system';

interface NavButtonProps {
    /** Icon element to display */
    icon: React.ReactNode;
    /** Button label text */
    label: string;
    /** Whether this tab is currently active */
    active: boolean;
    /** Click handler */
    onClick: () => void;
    /** Optional unread badge count (true = dot only, number = count) */
    badge?: boolean | number;
}

/**
 * Navigation button for the bottom tab bar.
 * Neon "New Wave" aesthetic with electric cyan glow.
 * Minimum 44×44 touch target for vessel movement/pitching safety.
 */
export const NavButton: React.FC<NavButtonProps> = ({ icon, label, active, onClick, badge }) => (
    <button
        onClick={() => {
            if (!active) triggerHaptic('light');
            onClick();
        }}
        onTouchStart={() => {}} // Forces immediate touch response
        aria-label={`Navigate to ${label}`}
        aria-current={active ? 'page' : undefined}
        role="tab"
        aria-selected={active}
        className="relative z-50 cursor-pointer flex flex-col items-center justify-center gap-1 min-w-[44px] min-h-[44px] h-full transition-all duration-200 active:scale-95 touch-manipulation"
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
                //   v1 (original): brightness 1.2 + sea-foam drop-shadow
                //      6 px @ 0.5 + scale 1.1. Three competing signals
                //      yelling at the same time.
                //   v2 (earlier today): brightness 1.08 + cyan drop-
                //      shadow 3 px @ 0.35 + scale 1.04. Cleaner, but
                //      still read brighter than intended on iOS where
                //      the OLED contrast makes glow halos punchier.
                //   v3 (here): drop the drop-shadow entirely. Keep
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
        <span
            style={{
                fontSize: 9,
                fontWeight: 900,
                textTransform: 'uppercase',
                letterSpacing: '0.1em',
                color: active ? 'rgba(255, 255, 255, 0.85)' : 'rgba(255, 255, 255, 0.45)',
                marginTop: 6,
                lineHeight: 1,
                transition: 'color 0.2s ease',
                whiteSpace: 'nowrap',
            }}
        >
            {label}
        </span>
        {active && (
            // White indicator dot under the label. The box-shadow halo
            // was removed in v3 (matched the icon's glow removal above)
            // — the dot itself at solid 0.85 alpha is already plenty
            // visible against the dark nav bar without needing a glow.
            <div
                className="absolute bottom-0.5 w-1 h-1 rounded-full pointer-events-none"
                style={{ backgroundColor: 'rgba(255, 255, 255, 0.85)' }}
                aria-hidden="true"
            />
        )}
    </button>
);
