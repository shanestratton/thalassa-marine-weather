/**
 * The app's one display form for a calendar day: 'Sun 28 Sep 2026'.
 *
 * Bare toLocaleDateString() gave '28/9/2026' on Maintenance beside
 * '27/09/2026' elsewhere (UX scorecard run 9). Zero-padded dd/mm/yyyy stays
 * inside date inputs only.
 */

// Fixed names, not Intl: en-AU spells September 'Sept' on newer ICU.
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A bare 'YYYY-MM-DD' names a calendar day, not an instant. */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 'Sun 28 Sep 2026', or '28 Sep 2026' with `weekday: false`. A bare
 * 'YYYY-MM-DD' is read as that LOCAL day (new Date('2026-09-28') is UTC
 * midnight, the 27th west of Greenwich); a timestamp is shown on the local
 * day it falls on, the same instant the due-in-days count uses. '--' stands
 * in for a missing or unreadable date.
 */
export function formatDisplayDate(value: string | null | undefined, options: { weekday?: boolean } = {}): string {
    if (!value) return '--';
    const date = DATE_ONLY.test(value) ? new Date(`${value}T00:00:00`) : new Date(value);
    if (Number.isNaN(date.getTime())) return '--';
    const day = `${date.getDate()} ${MONTH_NAMES[date.getMonth()]} ${date.getFullYear()}`;
    return options.weekday === false ? day : `${DAY_NAMES[date.getDay()]} ${day}`;
}
