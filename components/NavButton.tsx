/**
 * @fileoverview Navigation button component for bottom tab bar
 * @module components/NavButton
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
 * Includes accessibility features for screen readers.
 * Optimized for instant response on tap.
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
        className={`relative z-50 cursor-pointer flex flex-col items-center justify-center gap-0.5 w-16 h-full transition-colors duration-75 active:scale-95 touch-manipulation ${active ? 'text-sky-400' : 'text-gray-400 hover:text-gray-200 active:text-sky-300'}`}
        style={{ pointerEvents: 'auto', touchAction: 'manipulation', WebkitTapHighlightColor: 'transparent' }}
    >
        <div className="relative">
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
            className={`text-[11px] font-bold uppercase tracking-wider leading-none mt-0.5 ${active ? 'text-sky-400' : 'text-gray-500'}`}
        >
            {label}
        </span>
        {active && (
            <div
                className="absolute bottom-0.5 w-1 h-1 bg-sky-400 rounded-full shadow-[0_0_8px_rgba(56,189,248,0.8)] pointer-events-none"
                aria-hidden="true"
            ></div>
        )}
    </button>
);
