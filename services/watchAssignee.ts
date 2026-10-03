/**
 * Whose watch is it — one rule for the alarm, The Glass's Watch page and the
 * watch schedule card, so they can never disagree.
 *
 * A watch row comes in two shapes:
 *   - the skipper's own raw row (watch_assignments), which carries the
 *     assigned crew member's email and user id;
 *   - the crew view (get_crew_watch_bill, 20261003140000), which carries
 *     neither: only is_assigned, is_self and a name from the person's own
 *     name record.
 *
 * Pure and dependency-free on purpose: tests mock WatchAssignmentService
 * wholesale, and these must survive that.
 */
import type { WatchAssignment } from './WatchAssignmentService';

type WatchRow = Pick<WatchAssignment, 'assigned_crew_email' | 'assigned_crew_user_id' | 'is_assigned' | 'is_self'>;

/** Assigned: the skipper's rule (an email is on the slot), or the crew view's flag. */
export function isWatchAssigned(row: WatchRow | null | undefined): boolean {
    if (!row) return false;
    return (
        (typeof row.assigned_crew_email === 'string' && row.assigned_crew_email.trim() !== '') ||
        row.is_assigned === true
    );
}

/**
 * The signed-in account's own watch: the crew view says so, or the row names
 * this user id, or this account's own address (case-insensitive). Never true
 * for an unassigned slot.
 */
export function isOwnWatch(
    row: WatchRow | null | undefined,
    self: { userId?: string | null; email?: string | null },
): boolean {
    if (!row || !isWatchAssigned(row)) return false;
    if (row.is_self === true) return true;
    if (self.userId && row.assigned_crew_user_id === self.userId) return true;
    const email = self.email?.trim().toLowerCase();
    return (
        !!email && typeof row.assigned_crew_email === 'string' && row.assigned_crew_email.trim().toLowerCase() === email
    );
}
