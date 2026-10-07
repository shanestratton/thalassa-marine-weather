/**
 * Your memberships (the boats you crew on) as CONTENT, not as an array
 * reference (2026-10-07 tidy-up).
 *
 * Every accept, decline, invite and permission save reloads them, and the
 * local leave, remove and undo paths rebuild the array. The page's passage
 * access check re-ran on each new array, so a reload that changed nothing
 * started a fresh check (and, before the paint windows, painted the
 * remembered grant again). It now re-runs only when the rows really change.
 */
import type { CrewMember } from '../../services/CrewService';

const byId = (a: CrewMember, b: CrewMember) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * One string that changes exactly when the rows' content does, in any order:
 * every field of every row, sorted by id, so an Undo that puts a row back at
 * the end reads the same as before it was taken out.
 */
export function membershipsContentKey(rows: readonly CrewMember[]): string {
    return JSON.stringify([...rows].sort(byId));
}

/**
 * `next`, unless it holds exactly what `previous` does (the same rows, the
 * same order, every field), in which case `previous` itself, so React keeps
 * the reference and nothing downstream re-runs.
 */
export function keepMembershipsIfUnchanged(previous: CrewMember[], next: CrewMember[]): CrewMember[] {
    if (previous === next) return previous;
    return JSON.stringify(previous) === JSON.stringify(next) ? previous : next;
}

/**
 * Puts rows back (an Undo, a removal the server refused) without listing any
 * of them twice: a reload may already have brought one back, and a second
 * copy is a second card with the same key.
 */
export function appendRowsNotListed(list: CrewMember[], rows: readonly CrewMember[]): CrewMember[] {
    const listed = new Set(list.map((row) => row.id));
    const missing = rows.filter((row) => !listed.has(row.id));
    return missing.length === 0 ? list : [...list, ...missing];
}
