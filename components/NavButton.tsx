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
}

/**
 * Navigation button for the bottom tab bar.
 * Includes accessibility features for screen readers.
 * Optimized for instant response on tap.
 */
export const NavButton: React.FC<NavButtonProps> = ({ icon, label, active, onClick }) => (
    <button
        onClick={() => {
            if (!active) triggerHaptic('light');
            onClick();
        }}
        onTouchStart={() => { }} // Forces immediate touch response
        aria-label={`Navigate to ${label}`}
        aria-current={active ? 'page' : undefined}
        role="tab"
        aria-selected={active}
        className={`relative z-50 cursor-pointer flex flex-col items-center justify-center gap-0.5 w-14 h-full transition-colors duration-75 active:scale-95 touch-manipulation ${active ? 'text-sky-400' : 'text-gray-400 hover:text-gray-200 active:text-sky-300'}`}
        style={{ pointerEvents: 'auto', touchAction: 'manipulation', WebkitTapHighlightColor: 'transparent' }}
    >
        {icon}
        <span className={`text-[9px] font-bold uppercase tracking-wider leading-none mt-0.5 ${active ? 'text-sky-400' : 'text-gray-500'}`}>{label}</span>
        {active && <div className="absolute bottom-0.5 w-1 h-1 bg-sky-400 rounded-full shadow-[0_0_8px_rgba(56,189,248,0.8)] pointer-events-none" aria-hidden="true"></div>}
    </button>
);
