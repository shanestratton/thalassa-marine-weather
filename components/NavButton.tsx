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
                filter: active ? 'brightness(1.2) drop-shadow(0 0 6px rgba(0, 230, 118, 0.5))' : 'none',
                transform: active ? 'scale(1.1)' : 'none',
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
                        <span className="text-[8px] font-black text-white leading-none px-0.5">
                            {badge > 99 ? '99+' : badge}
                        </span>
                    )}
                </span>
            )}
        </div>
        <span
            style={{
                fontSize: 10,
                fontWeight: 900,
                textTransform: 'uppercase',
                letterSpacing: '0.15em',
                color: active ? 'rgba(255, 255, 255, 0.85)' : 'rgba(255, 255, 255, 0.45)',
                marginTop: 6,
                lineHeight: 1,
                transition: 'color 0.2s ease',
            }}
        >
            {label}
        </span>
        {active && (
            <div
                className="absolute bottom-0.5 w-1 h-1 rounded-full pointer-events-none"
                style={{
                    backgroundColor: 'rgba(255, 255, 255, 0.85)',
                    boxShadow: '0 0 4px rgba(255, 255, 255, 0.4)',
                }}
                aria-hidden="true"
            />
        )}
    </button>
);
