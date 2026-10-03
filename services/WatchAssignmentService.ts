/**
 * WatchAssignmentService — Per-voyage watch slot → crew member mapping.
 *
 * The watch schedule itself (rotation pattern, time slots) is generated
 * algorithmically client-side. This service records WHO is on each
 * watch and persists those assignments to Supabase so:
 *
 *   1. The skipper's UI (WatchScheduleCard) shows real crew names
 *      instead of "Watch A" / "Watch B" placeholders.
 *   2. Each crew member's WatchAlarmService can schedule local
 *      notifications 15 minutes before THEIR assigned watches.
 *   3. The send-push edge function can notify crew when the skipper
 *      publishes / updates the schedule.
 *
 * RLS: the voyage owner reads and writes the raw rows. Crew who may see the
 * watch schedule read, raw, only their OWN assigned watches, and the whole
 * bill BY NAME through get_crew_watch_bill (20261003140000): per watch,
 * assigned, yours, and a name from the person's own name record — never an
 * email or a user id. Until that migration is pushed the function is missing
 * (PGRST202 / 42883) and the raw read stands, as before.
 */

import { supabase } from './supabase';
import { createLogger } from '../utils/createLogger';
import {
    authScopedStorageKey,
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
    type AuthIdentityScope,
} from './authIdentityScope';
import type { CrewNameParts } from './floatPlanCrew';
import { isOwnWatch } from './watchAssignee';

const log = createLogger('WatchAssign');

export interface WatchAssignment {
    id: string;
    voyage_id: string;
    watch_index: number;
    watch_label: string;
    watch_time_label: string;
    assigned_crew_email: string | null;
    assigned_crew_name: string | null;
    assigned_crew_user_id?: string | null;
    assigned_at: string | null;
    assigned_by: string | null;
    created_at: string;
    updated_at: string;
    /** Crew view only: the slot is assigned, though no email came with it. */
    is_assigned?: boolean;
    /** Crew view only: the slot is the signed-in account's own. */
    is_self?: boolean;
}

/** Local fallback when Supabase is unavailable / unauthenticated. */
const localStorageKey = (voyageId: string, scope: AuthIdentityScope = getAuthIdentityScope()): string =>
    authScopedStorageKey(`thalassa_watch_assignments_${voyageId}`, scope);

function readFromLocal(voyageId: string, scope: AuthIdentityScope = getAuthIdentityScope()): WatchAssignment[] {
    try {
        // Legacy keys cannot be adopted safely: assignments name crew but
        // carry no owning account, and a crew member may share the same
        // voyage-shaped UUID namespace on a multi-user device.
        const raw = localStorage.getItem(localStorageKey(voyageId, scope));
        if (!raw) return [];
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return (parsed as WatchAssignment[]).filter((assignment) => assignment.voyage_id === voyageId);
    } catch {
        return [];
    }
}

function writeToLocal(
    voyageId: string,
    assignments: WatchAssignment[],
    scope: AuthIdentityScope = getAuthIdentityScope(),
): void {
    if (!isAuthIdentityScopeCurrent(scope)) return;
    try {
        localStorage.setItem(
            localStorageKey(voyageId, scope),
            JSON.stringify(assignments.filter((assignment) => assignment.voyage_id === voyageId)),
        );
    } catch {
        /* quota exceeded — non-fatal */
    }
}

type RemoteIdentityResult = 'match' | 'unavailable' | 'mismatch' | 'stale';

/**
 * Supabase can swap its session just before authStore publishes the matching
 * identity fence. Verify both sides around remote work so a response obtained
 * with B's token can never be cached or returned to an A-scoped caller.
 */
async function checkRemoteIdentity(
    scope: AuthIdentityScope,
): Promise<{ result: RemoteIdentityResult; email: string | null }> {
    if (!supabase || !scope.userId) return { result: 'unavailable', email: null };
    try {
        const {
            data: { user },
            error,
        } = await supabase.auth.getUser();
        if (!isAuthIdentityScopeCurrent(scope)) return { result: 'stale', email: null };
        if (error || !user) return { result: 'unavailable', email: null };
        if (user.id !== scope.userId) return { result: 'mismatch', email: null };
        return { result: 'match', email: typeof user.email === 'string' ? user.email : null };
    } catch {
        return { result: isAuthIdentityScopeCurrent(scope) ? 'unavailable' : 'stale', email: null };
    }
}

async function verifyRemoteIdentity(scope: AuthIdentityScope): Promise<RemoteIdentityResult> {
    return (await checkRemoteIdentity(scope)).result;
}

type Self = { userId: string | null; email: string | null };

/**
 * What crew's own-rows read returns (20261003140000): nothing, or only rows
 * that are this account's own watches and that it did not assign. A row this
 * account assigned, or one that is not its own, means the raw read is the
 * whole bill: the skipper's, or crew's before that migration is pushed.
 */
function isOwnRowsRead(rows: WatchAssignment[], self: Self): boolean {
    return rows.every((row) => row.assigned_by !== self.userId && isOwnWatch(row, self));
}

/**
 * The crew read failed: the last bill read, with this account's own watches
 * taken from the fresh raw read instead. That raw read is the truth about
 * whose watch it is now, so a pre-watch alarm follows a watch the skipper
 * moved, and a bad signal still never drops one.
 */
function withOwnWatches(cached: WatchAssignment[], own: WatchAssignment[], self: Self): WatchAssignment[] {
    const byIndex = new Map<number, WatchAssignment>();
    for (const row of cached) if (!isOwnWatch(row, self)) byIndex.set(row.watch_index, row);
    for (const row of own) byIndex.set(row.watch_index, row);
    return [...byIndex.values()].sort((a, b) => a.watch_index - b.watch_index);
}

type RenderName = (parts: CrewNameParts) => string;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown, max: number): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed ? trimmed.slice(0, max) : null;
}

function isMissingFunction(error: unknown): boolean {
    const code = isRecord(error) ? error.code : undefined;
    return code === 'PGRST202' || code === '42883';
}

/**
 * get_crew_watch_bill's payload → watch rows, the allow-list again client
 * side. No email, user id or assigner is ever kept, whatever the server sent.
 * Null when the payload is not the shape the function returns.
 */
function fromCrewWatchBill(value: unknown, voyageId: string, renderName: RenderName): WatchAssignment[] | null {
    if (!isRecord(value) || !Array.isArray(value.watches)) return null;
    const fetchedAt = new Date().toISOString();
    const seen = new Set<number>();
    return value.watches.flatMap((entry): WatchAssignment[] => {
        if (!isRecord(entry)) return [];
        const index = entry.watchIndex;
        if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || seen.has(index)) return [];
        const label = text(entry.watchLabel, 200);
        const timeLabel = text(entry.watchTimeLabel, 200);
        if (!label || !timeLabel) return [];
        seen.add(index);
        const assigned = entry.assigned === true;
        const name = assigned
            ? renderName({
                  prefix: text(entry.prefix, 40),
                  first_name: text(entry.firstName, 80),
                  nickname: text(entry.nickname, 80),
                  last_name: text(entry.lastName, 80),
              }).trim()
            : '';
        return [
            {
                id: `crew-view_${voyageId}_${index}`,
                voyage_id: voyageId,
                watch_index: index,
                watch_label: label,
                watch_time_label: timeLabel,
                assigned_crew_email: null,
                assigned_crew_name: name || null,
                assigned_crew_user_id: null,
                assigned_at: null,
                assigned_by: null,
                created_at: fetchedAt,
                updated_at: fetchedAt,
                is_assigned: assigned,
                is_self: assigned && entry.isSelf === true,
            },
        ];
    });
}

/**
 * The watch bill by name, for a passage this account crews on. [] when the
 * server says there is nothing to show (NULL: not crew on it). 'missing' when
 * the function is not pushed yet, so the raw read was the whole answer.
 * 'failed' (an error, an odd payload, or a lost signal after the read) keeps
 * the cached bill, so a bad signal never drops a crew member's pre-watch
 * alarms; 'discarded' only after an account switch.
 */
async function readCrewWatchBill(
    voyageId: string,
    scope: AuthIdentityScope,
): Promise<WatchAssignment[] | 'missing' | 'failed' | 'discarded'> {
    if (!supabase) return 'failed';
    const { data, error } = await supabase.rpc('get_crew_watch_bill', { p_voyage_id: voyageId });
    if (!isAuthIdentityScopeCurrent(scope)) return 'discarded';
    if (error) {
        if (isMissingFunction(error)) return 'missing';
        log.warn('crew watch bill could not be read; keeping the cached bill:', error.message);
        return 'failed';
    }
    const identity = await verifyRemoteIdentity(scope);
    if (identity === 'unavailable') {
        log.warn('crew watch bill could not be confirmed for this account; keeping the cached bill');
        return 'failed';
    }
    if (identity !== 'match') return 'discarded';
    if (data === null || data === undefined) return [];
    // The same byline grammar as the crewing view's manifest, loaded only on
    // this path so the skipper's alarms never pull it in.
    const { renderCrewDisplayName } = await import('./floatPlanCrew');
    if (!isAuthIdentityScopeCurrent(scope)) return 'discarded';
    const rows = fromCrewWatchBill(data, voyageId, (parts) => renderCrewDisplayName(parts));
    if (!rows) {
        log.warn('crew watch bill had an unexpected shape; keeping the cached bill');
        return 'failed';
    }
    return rows;
}

export const WatchAssignmentService = {
    /**
     * Load all watch assignments for a voyage. Always returns an
     * array (empty if nothing assigned yet). Tries Supabase first,
     * falls back to localStorage when offline / unauthenticated.
     */
    async list(voyageId: string): Promise<WatchAssignment[]> {
        if (!voyageId) return [];
        const scope = getAuthIdentityScope();
        if (supabase && scope.userId) {
            try {
                const before = await verifyRemoteIdentity(scope);
                if (before === 'stale' || before === 'mismatch') return [];
                if (before !== 'match') return isAuthIdentityScopeCurrent(scope) ? readFromLocal(voyageId, scope) : [];

                const { data, error } = await supabase
                    .from('watch_assignments')
                    .select('*')
                    .eq('voyage_id', voyageId)
                    .order('watch_index', { ascending: true });

                if (!isAuthIdentityScopeCurrent(scope)) return [];
                if (!error && data) {
                    const after = await checkRemoteIdentity(scope);
                    // A lost signal is not an account switch: keep the cached bill.
                    if (after.result === 'unavailable') return readFromLocal(voyageId, scope);
                    if (after.result !== 'match') return [];
                    let rows = data as WatchAssignment[];
                    // Nothing, or only this account's own watches, is what crew
                    // read raw once 20261003140000 is pushed: ask for the bill
                    // by name. A row this account assigned, or someone else's,
                    // means the raw read is the whole bill.
                    const self: Self = { userId: scope.userId, email: after.email };
                    if (isOwnRowsRead(rows, self)) {
                        const crewView = await readCrewWatchBill(voyageId, scope);
                        if (crewView === 'discarded') return [];
                        if (crewView === 'failed') return withOwnWatches(readFromLocal(voyageId, scope), rows, self);
                        if (crewView !== 'missing') rows = crewView;
                    }
                    writeToLocal(voyageId, rows, scope);
                    return rows;
                }
            } catch (e) {
                log.warn('list failed, using localStorage:', e);
            }
        }
        return isAuthIdentityScopeCurrent(scope) ? readFromLocal(voyageId, scope) : [];
    },

    /**
     * Upsert a single watch assignment. Set crewEmail/crewName to null
     * to clear an assignment without deleting the row.
     */
    async assign(
        voyageId: string,
        watchIndex: number,
        watchLabel: string,
        watchTimeLabel: string,
        crewEmail: string | null,
        crewName: string | null,
        crewUserId: string | null = null,
    ): Promise<WatchAssignment | null> {
        if (!voyageId) return null;
        const scope = getAuthIdentityScope();

        if (supabase && scope.userId) {
            try {
                const identity = await verifyRemoteIdentity(scope);
                if (identity === 'stale' || identity === 'mismatch') return null;
                if (identity === 'match') {
                    const payload = {
                        voyage_id: voyageId,
                        watch_index: watchIndex,
                        watch_label: watchLabel,
                        watch_time_label: watchTimeLabel,
                        assigned_crew_email: crewEmail,
                        assigned_crew_name: crewName,
                        assigned_crew_user_id: crewUserId,
                        assigned_at: new Date().toISOString(),
                        assigned_by: scope.userId,
                    };
                    const { data, error } = await supabase
                        .from('watch_assignments')
                        .upsert(payload, { onConflict: 'voyage_id,watch_index' })
                        .select()
                        .single();
                    if (!isAuthIdentityScopeCurrent(scope)) return null;
                    if (!error && data) {
                        const after = await verifyRemoteIdentity(scope);
                        if (after !== 'match') return null;
                        // Mirror to localStorage for offline reads
                        const cached = readFromLocal(voyageId, scope);
                        const idx = cached.findIndex((a) => a.watch_index === watchIndex);
                        const next = data as WatchAssignment;
                        if (idx >= 0) cached[idx] = next;
                        else cached.push(next);
                        writeToLocal(voyageId, cached, scope);
                        return next;
                    }
                    log.warn('Supabase upsert failed:', error?.message);
                }
            } catch (e) {
                log.warn('assign Supabase path failed:', e);
            }
        }

        if (!isAuthIdentityScopeCurrent(scope)) return null;

        // localStorage-only fallback (no auth / offline)
        const now = new Date().toISOString();
        const cached = readFromLocal(voyageId, scope);
        const idx = cached.findIndex((a) => a.watch_index === watchIndex);
        const localAssignment: WatchAssignment = {
            id: cached[idx]?.id ?? `local_${voyageId}_${watchIndex}`,
            voyage_id: voyageId,
            watch_index: watchIndex,
            watch_label: watchLabel,
            watch_time_label: watchTimeLabel,
            assigned_crew_email: crewEmail,
            assigned_crew_name: crewName,
            assigned_crew_user_id: crewUserId,
            assigned_at: now,
            assigned_by: scope.userId,
            created_at: cached[idx]?.created_at ?? now,
            updated_at: now,
        };
        if (idx >= 0) cached[idx] = localAssignment;
        else cached.push(localAssignment);
        writeToLocal(voyageId, cached, scope);
        return localAssignment;
    },

    /**
     * Publish the current watch schedule to crew. Enqueues a push
     * notification for each crew member who has at least one
     * assigned watch + dispatches a Supabase Realtime broadcast on
     * the voyage's channel so crew clients refresh their UI without
     * polling.
     *
     * Returns the number of distinct crew members notified (so the
     * UI can show "Schedule published to N crew member(s)").
     */
    async publishToCrew(voyageId: string, voyageName: string): Promise<number> {
        if (!supabase || !voyageId) return 0;
        const scope = getAuthIdentityScope();
        if (!scope.userId || (await verifyRemoteIdentity(scope)) !== 'match') return 0;
        try {
            // 1. Load all assignments
            const all = await this.list(voyageId);
            if (!isAuthIdentityScopeCurrent(scope)) return 0;
            const assigned = all.filter((a) => a.assigned_crew_email && a.assigned_crew_name);
            if (assigned.length === 0) return 0;

            // 2. Look up each crew member's user_id from vessel_crew
            //    so we can target push_notification_queue inserts.
            //    We deduplicate by email — one crew may have multiple
            //    assigned watches but they only need one push.
            const uniqueEmails = Array.from(new Set(assigned.map((a) => a.assigned_crew_email!)));
            const { data: crewRows } = await supabase
                .from('vessel_crew')
                .select('crew_email,crew_user_id')
                .eq('voyage_id', voyageId)
                .in('crew_email', uniqueEmails);
            if ((await verifyRemoteIdentity(scope)) !== 'match') return 0;
            const emailToUserId = new Map<string, string>();
            for (const r of (crewRows as { crew_email: string; crew_user_id: string }[] | null) || []) {
                if (r.crew_user_id) emailToUserId.set(r.crew_email, r.crew_user_id);
            }

            // 3. Enqueue one push per crew member, listing their first
            //    watch + total count. The send-push edge function
            //    polls push_notification_queue and fires APNs.
            const pushRequests: Array<PromiseLike<{ error: { message: string } | null }>> = [];
            for (const email of uniqueEmails) {
                const userId = emailToUserId.get(email);
                if (!userId) continue; // crew not registered / not yet accepted
                const mine = assigned.filter((a) => a.assigned_crew_email === email);
                const first = mine[0];
                pushRequests.push(
                    supabase.rpc('queue_watch_schedule_push', {
                        p_voyage_id: voyageId,
                        p_recipient_user_id: userId,
                        p_title: `⚓ Watch schedule for ${voyageName}`,
                        p_body:
                            mine.length === 1
                                ? `You have ${first.watch_label} (${first.watch_time_label} UTC)`
                                : `You have ${mine.length} watches — first: ${first.watch_label} (${first.watch_time_label})`,
                        p_data: {
                            voyageId,
                            watchIndex: first.watch_index,
                            deepLink: '/crew',
                        },
                    }),
                );
            }

            if (pushRequests.length > 0) {
                const results = await Promise.all(pushRequests);
                if (!isAuthIdentityScopeCurrent(scope)) return 0;
                const failed = results.find((result) => result.error);
                if (failed?.error) log.warn('push request failed:', failed.error.message);
            }

            // 4. Realtime broadcast — crew clients with an open
            //    voyage channel get the update instantly without
            //    waiting for the push round-trip.
            try {
                if ((await verifyRemoteIdentity(scope)) !== 'match') return 0;
                const channel = supabase.channel(`watch-schedule-${voyageId}`);
                await channel.send({
                    type: 'broadcast',
                    event: 'schedule_published',
                    payload: { voyageId, count: assigned.length, at: new Date().toISOString() },
                });
                supabase.removeChannel(channel);
                if (!isAuthIdentityScopeCurrent(scope)) return 0;
            } catch (e) {
                log.warn('realtime broadcast failed:', e);
            }

            log.info(`published watch schedule to ${pushRequests.length} crew member(s)`);
            return pushRequests.length;
        } catch (e) {
            log.warn('publishToCrew failed:', e);
            return 0;
        }
    },

    /**
     * Subscribe to schedule updates broadcast by the skipper. Each
     * crew member's WatchScheduleCard calls this to refresh its
     * assignment view when the skipper publishes — no polling, no
     * stale data.
     *
     * Returns an unsubscribe function. Caller's useEffect cleanup
     * should call it.
     */
    subscribeToUpdates(voyageId: string, onUpdate: () => void): () => void {
        if (!supabase || !voyageId) return () => {};
        const scope = getAuthIdentityScope();
        if (!scope.userId) return () => {};
        // Capture the non-null reference once so the cleanup closure
        // doesn't have to re-narrow against the module-level binding
        // (which TS sees as possibly-null).
        const sb = supabase;
        const channel = sb
            .channel(`watch-schedule-${voyageId}`)
            .on('broadcast', { event: 'schedule_published' }, () => {
                if (isAuthIdentityScopeCurrent(scope)) onUpdate();
            })
            // Also listen for direct table inserts/updates — covers
            // the case where assignments change one-at-a-time before
            // the skipper hits Publish (so crew watching the screen
            // see live updates).
            .on(
                'postgres_changes',
                {
                    event: '*',
                    schema: 'public',
                    table: 'watch_assignments',
                    filter: `voyage_id=eq.${voyageId}`,
                },
                () => {
                    if (isAuthIdentityScopeCurrent(scope)) onUpdate();
                },
            )
            .subscribe();
        let closed = false;
        const close = () => {
            if (closed) return;
            closed = true;
            sb.removeChannel(channel);
        };
        let unsubscribeIdentity = () => {};
        unsubscribeIdentity = subscribeAuthIdentityScope(() => {
            close();
            unsubscribeIdentity();
        });
        return () => {
            unsubscribeIdentity();
            close();
        };
    },

    /**
     * Clear an assignment entirely (deletes the row). Use when the
     * skipper wants to reset a slot to unassigned. Use assign() with
     * null email/name if you want to keep an empty placeholder
     * (rarely useful — delete is cleaner).
     */
    async clear(voyageId: string, watchIndex: number): Promise<boolean> {
        if (!voyageId) return false;
        const scope = getAuthIdentityScope();
        if (supabase && scope.userId) {
            try {
                const identity = await verifyRemoteIdentity(scope);
                if (identity === 'stale' || identity === 'mismatch') return false;
                if (identity !== 'match') {
                    const cached = readFromLocal(voyageId, scope).filter((a) => a.watch_index !== watchIndex);
                    writeToLocal(voyageId, cached, scope);
                    return true;
                }
                const { error } = await supabase
                    .from('watch_assignments')
                    .delete()
                    .eq('voyage_id', voyageId)
                    .eq('watch_index', watchIndex);
                if (!isAuthIdentityScopeCurrent(scope)) return false;
                if (!error) {
                    if ((await verifyRemoteIdentity(scope)) !== 'match') return false;
                    const cached = readFromLocal(voyageId, scope).filter((a) => a.watch_index !== watchIndex);
                    writeToLocal(voyageId, cached, scope);
                    return true;
                }
                log.warn('Supabase delete failed:', error?.message);
            } catch (e) {
                log.warn('clear Supabase path failed:', e);
            }
        }
        if (!isAuthIdentityScopeCurrent(scope)) return false;
        const cached = readFromLocal(voyageId, scope).filter((a) => a.watch_index !== watchIndex);
        writeToLocal(voyageId, cached, scope);
        return true;
    },

    /**
     * Clear every assignment for a voyage before its watch pattern changes.
     * Slot indexes only have meaning within one pattern, so retaining them
     * would silently put people on the wrong watch after a system switch.
     */
    async clearAll(voyageId: string): Promise<boolean> {
        if (!voyageId) return false;
        const scope = getAuthIdentityScope();
        if (supabase && scope.userId) {
            try {
                const identity = await verifyRemoteIdentity(scope);
                if (identity === 'stale' || identity === 'mismatch') return false;
                if (identity === 'match') {
                    const { error } = await supabase.from('watch_assignments').delete().eq('voyage_id', voyageId);
                    if (!isAuthIdentityScopeCurrent(scope)) return false;
                    if (!error) {
                        if ((await verifyRemoteIdentity(scope)) !== 'match') return false;
                        writeToLocal(voyageId, [], scope);
                        return true;
                    }
                    log.warn('clearAll Supabase path failed:', error.message);
                }
            } catch (e) {
                log.warn('clearAll failed:', e);
            }
        }
        if (!isAuthIdentityScopeCurrent(scope)) return false;
        writeToLocal(voyageId, [], scope);
        return true;
    },
};
