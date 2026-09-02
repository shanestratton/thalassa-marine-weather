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
