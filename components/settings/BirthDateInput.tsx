/**
 * A date of birth, in the platform's own date picker (129-14).
 *
 * The field shows what is being typed, not only what is saved. Chromium (the
 * web build) reports a date field's value while the year is still going in,
 * digit by digit: 0001-04-03, 0019-04-03, 0197-04-03, then 1979-04-03. And
 * while one part is being retyped it reports an empty value with
 * validity.badInput set. A field held to the saved date put the empty value
 * back after the first digit, which wiped what had been typed, and it took a
 * part being retyped for a cleared date. So the draft lives here, and only a
 * whole date from 1900 on is handed up. A cleared date is handed up when every
 * part is empty: at once when the browser says so (an iPhone's Reset, or the
 * last part emptied), and otherwise when the field is left. A field left part
 * typed goes back to the saved date. iOS hands over whole dates from its
 * picker, so it never sees the in-between values.
 */
import React, { useState } from 'react';
import { isBirthDate } from '../../services/crew/dateOfBirth';

interface BirthDateInputProps {
    /** The saved date, yyyy-mm-dd, or '' for none. */
    saved: string;
    /** The latest date offered: this phone's own today. */
    max: string;
    /** A whole date from 1900 on, or undefined when the field was emptied. */
    onCommit: (dateOfBirth: string | undefined) => void;
    'aria-label': string;
    'aria-describedby'?: string;
    className?: string;
}

/** True when the browser holds part of a date it cannot report yet. */
const partTyped = (input: HTMLInputElement) => input.validity?.badInput === true;

export const BirthDateInput: React.FC<BirthDateInputProps> = ({ saved, max, onCommit, className, ...aria }) => {
    const [draft, setDraft] = useState(saved);
    // A date saved from elsewhere (another phone, the store) replaces the draft.
    const [seen, setSeen] = useState(saved);
    if (saved !== seen) {
        setSeen(saved);
        setDraft(saved);
    }
    return (
        <input
            type="date"
            min="1900-01-01"
            max={max}
            {...aria}
            value={draft}
            onChange={(event) => {
                const value = event.target.value;
                setDraft(value);
                if (isBirthDate(value)) {
                    if (value !== saved) onCommit(value);
                } else if (!value && !partTyped(event.target) && saved) onCommit(undefined);
            }}
            onBlur={(event) => {
                if (isBirthDate(draft)) return;
                if (!draft && !partTyped(event.target)) {
                    if (saved) onCommit(undefined);
                    return;
                }
                // Left part typed, or a year before 1900: the saved date, never half of one.
                setDraft(saved);
            }}
            className={className}
        />
    );
};
