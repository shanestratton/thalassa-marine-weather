/**
 * TimePicker24 — departure time as two native selects (24 hours × 5-minute
 * steps), replacing <input type="time"> in both depart cards.
 *
 * Why not the native time input: on the web it renders the locale's AM/PM
 * suffix, which CLIPPED in the narrow card (Shane 2026-07-17: "i cannot see
 * the am/pm part of the time… better still, maybe make it a 24hr time") —
 * and a native input's display format follows the OS locale, it cannot be
 * forced to 24 h. Selects render as wheels on iOS and dropdowns on desktop,
 * and always read HH : MM.
 *
 * Behaviour (Shane 2026-07-17):
 * - `value` null shows the CURRENT time (floored to the 5-min step) without
 *   committing it — "leaving now" stays the state until the punter picks.
 * - Past options are disabled (greyed) when the chosen date is today — you
 *   can't plan to leave an hour ago. Future dates disable nothing.
 */
import React from 'react';

const pad = (n: number): string => String(n).padStart(2, '0');

/** Local YYYY-MM-DD for "is the chosen date today?" checks. */
export const localDateStr = (d: Date = new Date()): string =>
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

interface TimePicker24Props {
    /** Committed departure time, or null = "leaving now" (display-only now). */
    value: { h: number; m: number } | null;
    /** Chosen departure date 'YYYY-MM-DD' ('' = today) — drives past-greying. */
    dateStr: string;
    onChange: (h: number, m: number) => void;
    /** Applied to both selects — the parent owns sizing/colour so the two
     *  depart cards keep their own scales. */
    selectClassName?: string;
}

export const TimePicker24: React.FC<TimePicker24Props> = ({ value, dateStr, onChange, selectClassName = '' }) => {
    const now = new Date();
    const isToday = !dateStr || dateStr === localDateStr(now);
    const h = value?.h ?? now.getHours();
    const m = Math.floor((value?.m ?? now.getMinutes()) / 5) * 5;
    const nowBucket = Math.floor(now.getMinutes() / 5) * 5;
    return (
        <div className="flex min-w-0 items-center gap-1">
            <select
                value={pad(h)}
                onChange={(e) => onChange(Number(e.target.value), m)}
                aria-label="Departure hour (24-hour)"
                className={selectClassName}
            >
                {Array.from({ length: 24 }, (_, i) => (
                    <option key={i} value={pad(i)} disabled={isToday && i < now.getHours()}>
                        {pad(i)}
                    </option>
                ))}
            </select>
            <span className="font-black text-gray-500">:</span>
            <select
                value={pad(m)}
                onChange={(e) => onChange(h, Number(e.target.value))}
                aria-label="Departure minutes"
                className={selectClassName}
            >
                {Array.from({ length: 12 }, (_, i) => {
                    const mm = i * 5;
                    return (
                        <option
                            key={mm}
                            value={pad(mm)}
                            disabled={isToday && h === now.getHours() && mm < nowBucket}
                        >
                            {pad(mm)}
                        </option>
                    );
                })}
            </select>
        </div>
    );
};
