/**
 * Dates of birth (129-14, Shane 2026-10-14: "in the vessel profile, can we
 * change punters age for date of birth. Otherwise we will have to change the
 * age every year. This only shows up in the float plan").
 *
 * A date of birth is a calendar date, stored as yyyy-mm-dd with no time and
 * no time zone: the day someone was born does not move when the phone
 * crosses the date line. So it is never read through new Date(text), which
 * takes "1979-03-04" as UTC midnight and shows 3 March west of Greenwich.
 * An age is worked out from it on a calendar day: today on the phone for the
 * editor, the departure day for the float plan.
 *
 * Pure and import-free.
 */

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
/** Earlier than this is a typing slip, not a crew member (the server's bound too). */
const EARLIEST = '1900-01-01';

function parts(value: unknown): [number, number, number] | null {
    if (typeof value !== 'string') return null;
    const match = ISO_DAY.exec(value);
    if (!match) return null;
    const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
    // Date.UTC rolls 30 February over into March: a real date comes back as itself.
    const check = new Date(Date.UTC(year, month - 1, day));
    if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
    return [year, month, day];
}

/** A real calendar date as yyyy-mm-dd, from 1900 on. */
export function isBirthDate(value: unknown): value is string {
    return parts(value) !== null && (value as string) >= EARLIEST;
}

/**
 * Whole years on `onDay` (yyyy-mm-dd). The age goes up on the first day whose
 * month and day are the birth month and day or later, so a 29 February
 * birthday is reached on 1 March in a common year. Null for a date after
 * `onDay`, or for anything that is not a date.
 */
export function ageOn(dateOfBirth: unknown, onDay: string): number | null {
    const born = isBirthDate(dateOfBirth) ? parts(dateOfBirth) : null;
    const on = parts(onDay);
    if (!born || !on) return null;
    const reached = on[1] > born[1] || (on[1] === born[1] && on[2] >= born[2]);
    const age = on[0] - born[0] - (reached ? 0 : 1);
    return age >= 0 ? age : null;
}

const pad = (value: number, width = 2) => String(value).padStart(width, '0');

/** This phone's own calendar day, yyyy-mm-dd: its local date, never UTC's (toISOString). */
export function localDay(now: Date = new Date()): string {
    return `${pad(now.getFullYear(), 4)}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** The calendar day of `ms` in an IANA zone, yyyy-mm-dd; this phone's own day for an unknown zone. */
export function dayIn(ms: number, timeZone?: string): string {
    if (timeZone) {
        try {
            const fields = new Intl.DateTimeFormat('en-US', {
                timeZone,
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
            }).formatToParts(ms);
            const field = (type: string) => fields.find((part) => part.type === type)?.value ?? '';
            const day = `${field('year')}-${field('month')}-${field('day')}`;
            if (parts(day)) return day;
        } catch {
            /* an unknown zone: the phone's own day */
        }
    }
    return localDay(new Date(ms));
}
