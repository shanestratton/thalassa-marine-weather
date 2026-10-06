/**
 * RegisterChips — the registers a crew row shares, as one tidy grid
 * (styles/crew-page.css .crew-chips): a line glyph in the page's accent and the
 * register's name. Used on the skipper's crew cards, a pending invite and the
 * crewing view's boat card, so all three read alike.
 */
import React from 'react';
import { REGISTER_LABELS, type SharedRegister } from '../../services/CrewService';
import { RegisterGlyph } from './crewGlyphs';

export const RegisterChips: React.FC<{
    registers: readonly SharedRegister[];
    /** The list's name for VoiceOver. */
    label?: string;
    className?: string;
}> = ({ registers, label = 'Shared registers', className = '' }) =>
    registers.length > 0 ? (
        <ul aria-label={label} className={`crew-chips ${className}`.trim()}>
            {registers.map((register) => (
                <li key={register} className="crew-chip">
                    <RegisterGlyph register={register} />
                    <span>{REGISTER_LABELS[register] ?? register}</span>
                </li>
            ))}
        </ul>
    ) : null;
