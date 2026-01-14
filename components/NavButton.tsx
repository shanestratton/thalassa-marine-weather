import React from 'react';

interface NavButtonProps {
    icon: React.ReactNode;
    label: string;
    active: boolean;
    onClick: () => void;
}

export const NavButton: React.FC<NavButtonProps> = ({ icon, label, active, onClick }) => (
    <button
        onClick={onClick}
        className={`relative z-50 cursor-pointer flex flex-col items-center justify-center w-14 h-full transition-all duration-300 active:scale-90 touch-manipulation ${active ? 'text-sky-400' : 'text-gray-400 hover:text-gray-200'}`}
        style={{ pointerEvents: 'auto', touchAction: 'manipulation' }}
    >
        {icon}<span className="text-[9px] font-bold uppercase tracking-wider">{label}</span>
        {active && <div className="absolute bottom-1 w-1 h-1 bg-sky-400 rounded-full shadow-[0_0_8px_rgba(56,189,248,0.8)] pointer-events-none"></div>}
    </button>
);
