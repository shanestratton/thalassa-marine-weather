/**
 * pdfDates — how the binder PDFs write a date (130-B8).
 *
 * In the phone's own language and order: the Stores, Equipment and
 * Maintenance PDFs had 'en-AU' and 'en-GB' written in, so a skipper in
 * Florida or Brittany got Australian dates. A stored day ('2026-10-20', a due
 * day or an expiry) is that day where the phone is: new Date('2026-10-20') is
 * UTC midnight, the 19th anywhere west of Greenwich.
 *
 * Every date on those PDFs comes through here, so 131-B11's local-day helper
 * can take over reading a stored day in this one file.
 */
import { toLocalDateString } from '../../utils/localDate';

/** A bare 'YYYY-MM-DD' names a calendar day, not an instant. */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

/** The moment a stored date means: a bare day is local midnight, a timestamp is itself. null if unreadable. */
export function pdfDateValue(value: string | Date | null | undefined): Date | null {
    if (!value) return null;
    const date =
        value instanceof Date ? value : DATE_ONLY.test(value) ? new Date(`${value}T00:00:00`) : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
}

/** '13 Oct 2026' as the phone writes it ('Oct 13, 2026' in the US); '—' for no date. */
export function pdfShortDate(value: string | Date | null | undefined, locales?: string | string[]): string {
    const date = pdfDateValue(value);
    if (!date) return '—';
    return date.toLocaleDateString(locales, { day: 'numeric', month: 'short', year: 'numeric' });
}

/** '13 October 2026' as the phone writes it: the day a PDF was made. */
export function pdfLongDate(date: Date, locales?: string | string[]): string {
    return date.toLocaleDateString(locales, { day: 'numeric', month: 'long', year: 'numeric' });
}

/** The local day in a file name: 'Ships_Stores_2026-10-13.pdf', not the UTC one. */
export function pdfFileDay(date: Date): string {
    return toLocalDateString(date);
}

/**
 * Whole days from today to a stored date, on the phone's calendar: 0 today,
 * negative once past. null for no date.
 */
export function pdfDaysUntil(value: string | null | undefined, now: Date): number | null {
    const date = pdfDateValue(value);
    if (!date) return null;
    const day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return Math.round((day.getTime() - today.getTime()) / DAY_MS);
}
