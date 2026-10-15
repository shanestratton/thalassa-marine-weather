/**
 * The unit picker on the Stores Add and Edit forms (131-B14): Count, or a
 * weight or a volume in the skipper's unit system. A row's own unit stays as
 * written (storesUnits.unitChoices). Locked on a row the Grocery List made.
 */
import React from 'react';
import { unitChoices, type StoresUnitSystem } from '../../../services/vessel/storesUnits';

export const UnitSelect: React.FC<{
    units: StoresUnitSystem;
    value: string;
    /** The row's unit as stored (Edit), so it is always one of the choices. */
    current?: string | null;
    onChange: (unit: string) => void;
    disabled?: boolean;
}> = ({ units, value, current, onChange, disabled }) => (
    <label className="block">
        <span className="ui-field-label text-label font-bold text-gray-300 uppercase tracking-widest">Unit</span>
        <select
            value={value}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
            className="w-full min-h-11 mt-0.5 bg-white/5 border border-white/10 rounded-xl px-2 text-sm text-white disabled:opacity-60"
        >
            {unitChoices(units, current).map((choice) => (
                <option key={choice.value} value={choice.value}>
                    {choice.label}
                </option>
            ))}
        </select>
    </label>
);
