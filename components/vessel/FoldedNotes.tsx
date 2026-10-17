import React, { useState } from 'react';
import { FormField } from '../ui/FormField';

/**
 * A binder sheet's notes, folded away until wanted (132-B19): one 'Add
 * notes' row instead of an empty box, so the fields a paper or a part needs
 * fit an SE above Save. Notes already written show open, and once open the
 * field stays open, emptied or not. The tap that opens it puts the cursor in
 * it.
 */
export const FoldedNotes: React.FC<{
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
    rows?: number;
}> = ({ value, onChange, placeholder, rows = 2 }) => {
    const [open, setOpen] = useState(() => value.trim() !== '');
    const [tapped, setTapped] = useState(false);

    if (open || value.trim() !== '') {
        return (
            <FormField
                label="Notes (optional)"
                type="textarea"
                value={value}
                onChange={onChange}
                placeholder={placeholder}
                rows={rows}
                autoFocus={tapped}
            />
        );
    }
    return (
        <button
            type="button"
            onClick={() => {
                setOpen(true);
                setTapped(true);
            }}
            className="flex min-h-[44px] w-full items-center gap-2 rounded-xl border border-dashed border-white/15 bg-white/5 px-3 text-left text-sm font-bold text-gray-400 transition-colors hover:text-white"
        >
            <svg
                aria-hidden="true"
                className="h-4 w-4 shrink-0"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2.5}
            >
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
            </svg>
            Add notes
        </button>
    );
};
