/**
 * How the binder PDFs write a date (130-B8): the phone's own style, and a
 * stored day ('2026-10-20') on that day wherever the phone is.
 */
import { describe, expect, it } from 'vitest';
import { pdfDateValue, pdfDaysUntil, pdfFileDay, pdfLongDate, pdfShortDate } from '../services/pdf/pdfDates';

describe('pdfDates', () => {
    it("writes a date in the phone's language and order", () => {
        expect(pdfShortDate('2026-10-20', 'en-US')).toBe('Oct 20, 2026');
        expect(pdfShortDate('2026-10-20', 'en-GB')).toBe('20 Oct 2026');
        expect(pdfShortDate('2026-10-20', 'de-DE')).toBe('20. Okt. 2026');
        expect(pdfLongDate(new Date(2026, 9, 13), 'en-US')).toBe('October 13, 2026');
        expect(pdfLongDate(new Date(2026, 9, 13), 'fr-FR')).toBe('13 octobre 2026');
        // Left to the phone by default.
        expect(pdfShortDate('2026-10-20')).toBe(
            new Date(2026, 9, 20).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }),
        );
    });

    it('reads a stored day as that local day, never the UTC one', () => {
        const day = pdfDateValue('2026-10-20');
        expect([day?.getFullYear(), day?.getMonth(), day?.getDate(), day?.getHours()]).toEqual([2026, 9, 20, 0]);
        // A timestamp stays the instant it names.
        expect(pdfDateValue('2026-10-20T03:00:00.000Z')?.getTime()).toBe(Date.UTC(2026, 9, 20, 3));
    });

    it("says '—' for no date or an unreadable one", () => {
        expect(pdfShortDate(null)).toBe('—');
        expect(pdfShortDate(undefined)).toBe('—');
        expect(pdfShortDate('')).toBe('—');
        expect(pdfShortDate('not a date')).toBe('—');
        expect(pdfDaysUntil(null, new Date())).toBeNull();
    });

    it('names a file by the local day', () => {
        // Half past midnight local: the UTC day is still yesterday east of Greenwich.
        expect(pdfFileDay(new Date(2026, 9, 13, 0, 30))).toBe('2026-10-13');
    });

    it('counts whole days on the phone’s calendar', () => {
        const now = new Date(2026, 9, 13, 23, 30);
        expect(pdfDaysUntil('2026-10-13', now)).toBe(0);
        expect(pdfDaysUntil('2026-10-14', now)).toBe(1);
        expect(pdfDaysUntil('2026-10-12', now)).toBe(-1);
        expect(pdfDaysUntil('2027-01-11', now)).toBe(90);
    });
});
