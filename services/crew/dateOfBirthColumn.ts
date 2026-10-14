/**
 * Does crew_float_plan_details have its date_of_birth column yet? (129-14)
 *
 * The column comes with a HELD migration
 * (supabase/held-migrations/20261014181400_crew_float_plan_details_date_of_birth.sql)
 * that Shane pushes himself. Until it is live PostgREST refuses a write or a
 * read that names it, so both sides of the float plan try it, and on that one
 * refusal ask again without it: the age-only row and read they used before
 * 129. An absent column is remembered for an hour (the push may happen while
 * the app is open), so a session does not pay the refused request each time.
 * Any other refusal is not this one.
 */

/** How long a session believes the column is absent before trying it again. */
const ABSENT_RECHECK_MS = 60 * 60_000;

let absentAt: number | null = null;

/** True while this session has seen the server refuse the column, within the hour. */
export function dateOfBirthColumnAbsent(now = Date.now()): boolean {
    return absentAt !== null && now - absentAt < ABSENT_RECHECK_MS;
}

/** The server refused the column: write and read without it for a while. */
export function noteDateOfBirthColumnAbsent(now = Date.now()): void {
    absentAt = now;
}

/**
 * The server's "no such column" for date_of_birth: Postgres's 42703 (a read
 * or a write) or PostgREST's PGRST204 (not in its schema cache), naming it.
 */
export function isDateOfBirthColumnMissing(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const { code, message } = error as { code?: unknown; message?: unknown };
    return (
        (code === '42703' || code === 'PGRST204') && typeof message === 'string' && message.includes('date_of_birth')
    );
}
