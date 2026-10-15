/**
 * The LOCAL calendar date as "YYYY-MM-DD".
 *
 * `new Date().toISOString().split('T')[0]` is the UTC date, which in
 * Queensland is yesterday until 10:00 every morning. MaintenanceHub used it
 * for "today" on repairs and for the first due date of new tasks, so a task
 * created over breakfast was due a day early (audit 2026-09-02). Use this
 * wherever a date is a calendar day in the skipper's life rather than an
 * instant.
 */
export function toLocalDateString(d: Date = new Date()): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

/** A bare 'YYYY-MM-DD' names a calendar day, not an instant. */
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * A day kept in a timestamp column: the server hands '2026-11-01' back as
 * that day's UTC midnight, '2026-11-01T00:00:00+00:00', and
 * new Date('2026-11-01').toISOString() wrote '2026-11-01T00:00:00.000Z'.
 */
const SYNCED_DAY = /^(\d{4})-(\d{2})-(\d{2})[T ]00:00(?::00(?:\.0+)?)?(?:Z|[+-]00(?::?00)?)$/;

const DAY_MS = 86_400_000;

/**
 * The local calendar day a stored date names, as local midnight (131-B11).
 *
 * Due, expiry, warranty and install dates are days, not instants. Both
 * '2026-11-01' and the synced '2026-11-01T00:00:00+00:00' are 1 November
 * wherever the phone is: new Date() makes either one UTC midnight, the 31st
 * west of Greenwich, so Stores, Documents and Equipment showed those dates a
 * day early in the Americas, and a date input given the synced form showed
 * blank (STORES-07, EQ-2, MAINT-07, DOC-5). Any other timestamp, and a Date,
 * is a moment: the local day it falls on. Null for no date or an unreadable
 * one, '2026-02-30' included.
 */
export function readLocalDay(value: string | Date | null | undefined): Date | null {
    if (!value) return null;
    if (typeof value !== 'string') {
        if (Number.isNaN(value.getTime())) return null;
        return new Date(value.getFullYear(), value.getMonth(), value.getDate());
    }
    const day = DATE_ONLY.exec(value) ?? SYNCED_DAY.exec(value);
    if (day) {
        const [year, month, date] = [Number(day[1]), Number(day[2]) - 1, Number(day[3])];
        const local = new Date(year, month, date);
        return local.getFullYear() === year && local.getMonth() === month && local.getDate() === date ? local : null;
    }
    const moment = new Date(value);
    if (Number.isNaN(moment.getTime())) return null;
    return new Date(moment.getFullYear(), moment.getMonth(), moment.getDate());
}

/** The stored day as a date input holds it, 'YYYY-MM-DD'; '' for none. */
export function localDayString(value: string | Date | null | undefined): string {
    const day = readLocalDay(value);
    return day ? toLocalDateString(day) : '';
}

/**
 * The local day `days` after `from`'s, as local midnight. Calendar days, not
 * 24-hour steps, so a daylight-saving change never moves it a day.
 */
export function addLocalDays(from: Date, days: number): Date {
    return new Date(from.getFullYear(), from.getMonth(), from.getDate() + days);
}

/**
 * Whole local calendar days from today to a stored day: 0 today, 1 tomorrow,
 * -1 yesterday. Math.round absorbs a daylight-saving 23- or 25-hour day.
 * Null for no date or an unreadable one.
 */
export function localDaysUntil(value: string | Date | null | undefined, now: Date = new Date()): number | null {
    const day = readLocalDay(value);
    if (!day) return null;
    return Math.round((day.getTime() - addLocalDays(now, 0).getTime()) / DAY_MS);
}
