/**
 * Edits that don't undo other people's changes (126-B9c; binder audit
 * 2026-10-09: EQ-4, STORES-04).
 *
 * An edit sheet opens on a copy of the row. Sending every field back on Save
 * put the copy's values over whatever another device, or the crew, changed
 * while the sheet was open. The sheets now send only the fields the sailor
 * changed, measured against the row as the sheet opened; the last writer wins
 * per field, not per row.
 */

/** '' and null (or a missing value) are one blank: the forms show null as '' and save '' as null. */
const blank = (value: unknown): unknown => (value === '' || value === undefined ? null : value);

/** The fields of `after` (the form's values) that differ from `before` (the row as the sheet opened). */
export function changedFields<T extends object>(before: T, after: Partial<T>): Partial<T> {
    const changes: Partial<T> = {};
    for (const key of Object.keys(after) as (keyof T)[]) {
        if (blank(before[key]) !== blank(after[key])) changes[key] = after[key];
    }
    return changes;
}

/**
 * A count typed into an edit sheet, as a change against the count the sheet
 * opened on ("took 2", not "set to 10"), so it adds up with the ± buttons'
 * and the Galley's deltas made meanwhile. Three places, so a decimal count
 * carries no float noise; a count the row never had is 0, as in deltaLocal.
 */
export const countDelta = (before: number, after: number): number =>
    Math.round((after - (Number.isFinite(before) ? before : 0)) * 1000) / 1000;

/** The detail page closes with this when its item is deleted elsewhere. */
export const REMOVED_ELSEWHERE = 'Removed on another device';
/** A Save that found its row gone: the write returned null, so nothing was saved. */
export const REMOVED_NOTHING_SAVED = 'This item was removed on another device. Nothing was saved.';
