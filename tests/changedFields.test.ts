/**
 * Edits that don't undo other people's changes (126-B9c, binder audit
 * 2026-10-09: EQ-4, STORES-04).
 *
 * An edit sheet opens on a copy of the row. changedFields keeps only what the
 * sailor changed against that copy, so a Save never puts back a field another
 * device (or the crew) changed meanwhile. countDelta turns a count typed into
 * the sheet into a change against the count the sheet opened on.
 *
 * Fictional gear only: a 'Watermaker' and 'AA batteries', on no particular coast.
 */
import { describe, expect, it } from 'vitest';
import { changedFields, countDelta } from '../utils/changedFields';

const watermaker = {
    equipment_name: 'Watermaker',
    make: 'Fictional Pumps',
    model: 'WM-40',
    serial_number: 'WM-0001',
    installation_date: '2024-03-01' as string | null,
    warranty_expiry: null as string | null,
    notes: null as string | null,
    hours: 120,
};

describe('changedFields', () => {
    it('returns only the keys whose values differ', () => {
        expect(
            changedFields(watermaker, {
                equipment_name: 'Watermaker',
                make: 'Fictional Pumps',
                model: 'WM-40',
                serial_number: 'WM-0002',
                installation_date: '2024-03-01',
                warranty_expiry: null,
                notes: 'Membrane pickled for the lay-up',
            }),
        ).toEqual({ serial_number: 'WM-0002', notes: 'Membrane pickled for the lay-up' });
    });

    it('returns an empty object when nothing changed', () => {
        expect(changedFields(watermaker, { ...watermaker })).toEqual({});
    });

    it("counts '' and null (and a missing value) as the same blank", () => {
        // The forms show null as '' and save '' as null.
        expect(changedFields(watermaker, { warranty_expiry: '', notes: null })).toEqual({});
        expect(changedFields({ ...watermaker, notes: '' as string | null }, { notes: null })).toEqual({});
        expect(changedFields({ notes: undefined as string | null | undefined }, { notes: '' })).toEqual({});
        // A blank made real, and a real value blanked, are changes.
        expect(changedFields(watermaker, { notes: 'Flushed' })).toEqual({ notes: 'Flushed' });
        expect(changedFields(watermaker, { installation_date: null })).toEqual({ installation_date: null });
    });

    it('compares numbers exactly: 0 is not blank, and a tiny change is a change', () => {
        expect(changedFields(watermaker, { hours: 120 })).toEqual({});
        expect(changedFields(watermaker, { hours: 120.001 })).toEqual({ hours: 120.001 });
        expect(changedFields(watermaker, { hours: 0 })).toEqual({ hours: 0 });
        expect(changedFields({ min_quantity: 0 as number | null }, { min_quantity: null })).toEqual({
            min_quantity: null,
        });
    });

    it('looks only at the keys the form sends', () => {
        // hours is not on the form, so it is never sent, whatever the row holds.
        expect(Object.keys(changedFields(watermaker, { model: 'WM-60' }))).toEqual(['model']);
    });
});

describe('countDelta', () => {
    it('is the change from the count the sheet opened on', () => {
        // 'AA batteries' opened at 12; the skipper typed 10.
        expect(countDelta(12, 10)).toBe(-2);
        expect(countDelta(12, 15)).toBe(3);
        expect(countDelta(12, 12)).toBe(0);
    });

    it('rounds to three places, so decimal counts never carry float noise', () => {
        expect(countDelta(1.5, 0.75)).toBe(-0.75);
        expect(countDelta(0.3, 0.1)).toBe(-0.2);
        expect(countDelta(0.1, 0.3)).toBe(0.2);
        expect(countDelta(2.2, 2.2)).toBe(0);
    });

    it('treats a count the row never had as 0, as the delta outbox does', () => {
        expect(countDelta(Number.NaN, 4)).toBe(4);
        expect(countDelta(undefined as unknown as number, 4)).toBe(4);
    });
});
