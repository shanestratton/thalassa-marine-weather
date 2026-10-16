import { normaliseRouteConstraints, type RouteConstraintPoint } from './routeConstraintTypes';
export const ROUTE_CONSTRAINT_NOTES_PREFIX = '__route_constraints__::';
const MAX_NOTE_BYTES = 32768;
/** Absent is legacy/unknown. Null is present but invalid and must stay a re-plan hold. */
export function recoverRouteConstraints(notes: string | null | undefined): RouteConstraintPoint[] | null | undefined {
    if (typeof notes !== 'string') return undefined;
    const rows = notes.split('\n').filter((row) => row.startsWith(ROUTE_CONSTRAINT_NOTES_PREFIX));
    if (!rows.length) return undefined;
    if (rows.length !== 1 || rows[0].length > MAX_NOTE_BYTES) return null;
    try {
        const json = rows[0].slice(ROUTE_CONSTRAINT_NOTES_PREFIX.length);
        if (new TextEncoder().encode(json).byteLength > MAX_NOTE_BYTES) return null;
        return normaliseRouteConstraints(JSON.parse(json));
    } catch {
        return null;
    }
}
export function routeConstraintNotes(value: RouteConstraintPoint[] | null | undefined): string {
    if (value === undefined) return '';
    const clean = normaliseRouteConstraints(value);
    if (!clean) throw Error('The saved route constraints are unreadable. Review the route before saving.');
    const json = JSON.stringify(clean);
    if (new TextEncoder().encode(json).byteLength > MAX_NOTE_BYTES)
        throw Error('The saved route constraints exceed their bounded size.');
    return `\n${ROUTE_CONSTRAINT_NOTES_PREFIX}${json}`;
}
