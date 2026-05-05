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
 * RLS: voyage owner manages, accepted crew members can read.
 */

import { supabase } from './supabase';
import { createLogger } from '../utils/createLogger';

const log = createLogger('WatchAssign');

export interface WatchAssignment {
    id: string;
    voyage_id: string;
    watch_index: number;
    watch_label: string;
    watch_time_label: string;
    assigned_crew_email: string | null;
    assigned_crew_name: string | null;
    assigned_at: string | null;
    assigned_by: string | null;
    created_at: string;
    updated_at: string;
}

/** Local fallback when Supabase is unavailable / unauthenticated. */
const localStorageKey = (voyageId: string): string => `thalassa_watch_assignments_${voyageId}`;

function readFromLocal(voyageId: string): WatchAssignment[] {
    try {
        const raw = localStorage.getItem(localStorageKey(voyageId));
        return raw ? (JSON.parse(raw) as WatchAssignment[]) : [];
    } catch {
        return [];
    }
}

function writeToLocal(voyageId: string, assignments: WatchAssignment[]): void {
    try {
        localStorage.setItem(localStorageKey(voyageId), JSON.stringify(assignments));
    } catch {
        /* quota exceeded — non-fatal */
    }
}

export const WatchAssignmentService = {
    /**
     * Load all watch assignments for a voyage. Always returns an
     * array (empty if nothing assigned yet). Tries Supabase first,
     * falls back to localStorage when offline / unauthenticated.
     */
    async list(voyageId: string): Promise<WatchAssignment[]> {
        if (!voyageId) return [];
        if (supabase) {
            try {
                const { data, error } = await supabase
                    .from('watch_assignments')
                    .select('*')
                    .eq('voyage_id', voyageId)
                    .order('watch_index', { ascending: true });
                if (!error && data) {
                    writeToLocal(voyageId, data as WatchAssignment[]);
                    return data as WatchAssignment[];
                }
            } catch (e) {
                log.warn('list failed, using localStorage:', e);
            }
        }
        return readFromLocal(voyageId);
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
    ): Promise<WatchAssignment | null> {
        if (!voyageId) return null;

        if (supabase) {
            try {
                const {
                    data: { user },
                } = await supabase.auth.getUser();
                if (user) {
                    const payload = {
                        voyage_id: voyageId,
                        watch_index: watchIndex,
                        watch_label: watchLabel,
                        watch_time_label: watchTimeLabel,
                        assigned_crew_email: crewEmail,
                        assigned_crew_name: crewName,
                        assigned_at: new Date().toISOString(),
                        assigned_by: user.id,
                    };
                    const { data, error } = await supabase
                        .from('watch_assignments')
                        .upsert(payload, { onConflict: 'voyage_id,watch_index' })
                        .select()
                        .single();
                    if (!error && data) {
                        // Mirror to localStorage for offline reads
                        const cached = readFromLocal(voyageId);
                        const idx = cached.findIndex((a) => a.watch_index === watchIndex);
                        const next = data as WatchAssignment;
                        if (idx >= 0) cached[idx] = next;
                        else cached.push(next);
                        writeToLocal(voyageId, cached);
                        return next;
                    }
                    log.warn('Supabase upsert failed:', error?.message);
                }
            } catch (e) {
                log.warn('assign Supabase path failed:', e);
            }
        }

        // localStorage-only fallback (no auth / offline)
        const now = new Date().toISOString();
        const cached = readFromLocal(voyageId);
        const idx = cached.findIndex((a) => a.watch_index === watchIndex);
        const localAssignment: WatchAssignment = {
            id: cached[idx]?.id ?? `local_${voyageId}_${watchIndex}`,
            voyage_id: voyageId,
            watch_index: watchIndex,
            watch_label: watchLabel,
            watch_time_label: watchTimeLabel,
            assigned_crew_email: crewEmail,
            assigned_crew_name: crewName,
            assigned_at: now,
            assigned_by: null,
            created_at: cached[idx]?.created_at ?? now,
            updated_at: now,
        };
        if (idx >= 0) cached[idx] = localAssignment;
        else cached.push(localAssignment);
        writeToLocal(voyageId, cached);
        return localAssignment;
    },

    /**
     * Clear an assignment entirely (deletes the row). Use when the
     * skipper wants to reset a slot to unassigned. Use assign() with
     * null email/name if you want to keep an empty placeholder
     * (rarely useful — delete is cleaner).
     */
    async clear(voyageId: string, watchIndex: number): Promise<boolean> {
        if (!voyageId) return false;
        if (supabase) {
            try {
                const { error } = await supabase
                    .from('watch_assignments')
                    .delete()
                    .eq('voyage_id', voyageId)
                    .eq('watch_index', watchIndex);
                if (!error) {
                    const cached = readFromLocal(voyageId).filter((a) => a.watch_index !== watchIndex);
                    writeToLocal(voyageId, cached);
                    return true;
                }
                log.warn('Supabase delete failed:', error?.message);
            } catch (e) {
                log.warn('clear Supabase path failed:', e);
            }
        }
        const cached = readFromLocal(voyageId).filter((a) => a.watch_index !== watchIndex);
        writeToLocal(voyageId, cached);
        return true;
    },
};
