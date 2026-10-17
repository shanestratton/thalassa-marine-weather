/**
 * pdfDates — how the binder PDFs write a date (130-B8).
 *
 * In the phone's own language and order: the Stores, Equipment and
 * Maintenance PDFs had 'en-AU' and 'en-GB' written in, so a skipper in
 * Florida or Brittany got Australian dates. A stored day ('2026-10-20', a due
 * day or an expiry) is that day where the phone is: new Date('2026-10-20') is
 * UTC midnight, the 19th anywhere west of Greenwich.
 *
 * Every date on those PDFs comes through here, and reads a stored day with
 * utils/localDate's readLocalDay (131-B11), as the screens do: the synced
 * '2026-10-20T00:00:00+00:00' is the 20th on paper too.
 */
import { localDaysUntil, readLocalDay, toLocalDateString } from '../../utils/localDate';

/** The local day a stored date names (readLocalDay); null if none or unreadable. */
export function pdfDateValue(value: string | Date | null | undefined): Date | null {
    return readLocalDay(value);
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
    return localDaysUntil(value, now);
}
