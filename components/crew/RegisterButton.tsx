/**
 * RegisterButton — Reusable register toggle button for crew permissions.
 *
 * Shows a register icon + label with a checkmark indicator.
 * Used in both InviteCrewModal and Edit Permissions modal.
 */
import React from 'react';
import { type SharedRegister, REGISTER_LABELS, REGISTER_ICONS } from '../../services/CrewService';

interface RegisterButtonProps {
    reg: SharedRegister;
    selected: boolean;
    onToggle: () => void;
}

export const RegisterButton: React.FC<RegisterButtonProps> = ({ reg, selected, onToggle }) => (
    <button
        aria-label="Register your vessel"
        type="button"
        onClick={onToggle}
        className={`p-3 rounded-xl border text-left transition-all active:scale-95 ${
            selected
                ? 'bg-sky-500/15 border-sky-500/40 shadow-lg shadow-sky-500/5'
                : 'bg-white/[0.03] border-white/[0.06] hover:bg-white/[0.05]'
        }`}
    >
        <div className="flex items-center gap-2">
            <span className="text-lg">{REGISTER_ICONS[reg]}</span>
            <p className={`text-xs font-bold ${selected ? 'text-sky-300' : 'text-white'}`}>{REGISTER_LABELS[reg]}</p>
        </div>
        <div
            className={`mt-2 w-4 h-4 rounded-md border-2 flex items-center justify-center ${selected ? 'bg-sky-500 border-sky-500' : 'border-white/20'}`}
        >
            {selected && (
                <svg
                    className="w-2.5 h-2.5 text-white"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={3}
                >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                </svg>
            )}
        </div>
    </button>
);
