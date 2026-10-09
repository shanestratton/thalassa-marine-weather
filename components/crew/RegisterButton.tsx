/**
 * RegisterButton — Reusable register toggle button for crew permissions.
 *
 * Shows a register glyph + label with a checkmark indicator: the Crew & Float
 * Plan page's line glyphs in its one accent (2026-10-06), not emoji.
 * Used in InviteCrewModal.
 *
 * RegisterNotes draws a register's note (REGISTER_NOTES: "Crew IDs stay with
 * you" for Documents, 126-B4) as one line under the grid, and the tick points
 * at it with aria-describedby. Under the grid, not in the chip: at 320 pt in
 * wide fonts the chip has about 60 px beside its tick box, so a note there
 * would wrap to three lines and make the chip's row taller.
 */
import React from 'react';
import { type SharedRegister, REGISTER_LABELS, REGISTER_NOTES } from '../../services/CrewService';
import { RegisterGlyph } from './crewGlyphs';

/** The id of a register's note line, under a grid whose notes share `baseId`. */
export function registerNoteId(baseId: string, reg: SharedRegister): string | undefined {
    return REGISTER_NOTES[reg] ? `${baseId}-${reg}-note` : undefined;
}

/** One line per noted register in the grid, glyph first like the chip it describes. */
export const RegisterNotes: React.FC<{ registers: ReadonlyArray<SharedRegister>; baseId: string }> = ({
    registers,
    baseId,
}) => {
    const noted = registers.filter((reg) => REGISTER_NOTES[reg]);
    if (noted.length === 0) return null;
    return (
        <div className="mt-2 ml-1 space-y-1">
            {noted.map((reg) => (
                <p
                    key={reg}
                    id={registerNoteId(baseId, reg)}
                    className="flex items-center gap-1.5 text-xs text-gray-400"
                >
                    <RegisterGlyph register={reg} className="crew-accent h-3.5 w-3.5 shrink-0" />
                    {REGISTER_NOTES[reg]}
                </p>
            ))}
        </div>
    );
};

interface RegisterButtonProps {
    reg: SharedRegister;
    selected: boolean;
    onToggle: () => void;
    /** The grid's RegisterNotes baseId: a noted register's tick is described by its note. */
    noteBaseId?: string;
}

export const RegisterButton: React.FC<RegisterButtonProps> = ({ reg, selected, onToggle, noteBaseId }) => (
    <button
        aria-label={`Share ${REGISTER_LABELS[reg]}`}
        aria-describedby={noteBaseId ? registerNoteId(noteBaseId, reg) : undefined}
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
