/**
 * RegisterButton — Reusable register toggle button for crew permissions.
 *
 * Shows a register glyph + label with a checkmark indicator: the Crew & Float
 * Plan page's line glyphs in its one accent (2026-10-06), not emoji.
 * Used in InviteCrewModal.
 */
import React from 'react';
import { type SharedRegister, REGISTER_LABELS } from '../../services/CrewService';
import { RegisterGlyph } from './crewGlyphs';

interface RegisterButtonProps {
    reg: SharedRegister;
    selected: boolean;
    onToggle: () => void;
}

export const RegisterButton: React.FC<RegisterButtonProps> = ({ reg, selected, onToggle }) => (
    <button
        aria-label={`Share ${REGISTER_LABELS[reg]}`}
        aria-pressed={selected}
        type="button"
        onClick={onToggle}
        className={`p-3 rounded-xl border text-left transition-all active:scale-95 ${
            selected
                ? 'bg-sky-500/15 border-sky-500/40 shadow-lg shadow-sky-500/5'
                : 'bg-white/3 border-white/6 hover:bg-white/5'
        }`}
    >
        <div className="flex items-center gap-2">
            <RegisterGlyph register={reg} className="crew-accent h-4 w-4 shrink-0" />
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
