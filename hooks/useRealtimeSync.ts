/**
 * useRealtimeSync — Subscribe to Supabase Realtime for instant crew sync.
 *
 * When a crew member adds/updates/deletes a record on a shared register,
 * this hook triggers a reload on all other connected clients viewing the
 * same register. Uses WebSocket (battery-friendly) — only active while
 * the component is mounted.
 *
 * Usage:
 *   useRealtimeSync('inventory_items', loadItems);
 *
 * The subscription is automatically cleaned up on unmount. One page holds one
 * channel, whatever its table count. RLS limits what the socket delivers: the
 * Supabase client authenticates realtime with the signed-in session's token.
 * Every join (the first, and each rejoin after a drop) asks the sync engine to
 * catch up, since realtime never replays what it missed; a channel the server
 * closes for good is opened again.
 */

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createLogger } from '../utils/createLogger';

const log = createLogger('useRealtimeSync');
import { supabase } from '../services/supabase';
import type { RealtimeChannel } from '@supabase/supabase-js';
import {
    applyRealtimeChange,
    getLocalDatabaseSession,
    isLocalDatabaseSessionCurrent,
    type LocalDatabaseSession,
} from '../services/vessel/LocalDatabase';
import {
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
    type AuthIdentityScope,
} from '../services/authIdentityScope';

let channelInstance = 0;

interface RealtimeRow {
    id?: unknown;
    updated_at?: unknown;
    created_at?: unknown;
    [key: string]: unknown;
}

interface RealtimePayload {
    eventType: 'INSERT' | 'UPDATE' | 'DELETE';
    new: RealtimeRow;
    old: RealtimeRow;
}

const subscribeIdentitySnapshot = (notify: () => void): (() => void) => subscribeAuthIdentityScope(() => notify());
const getIdentitySnapshot = (): AuthIdentityScope => getAuthIdentityScope();

function captureDatabaseSession(scope: AuthIdentityScope): LocalDatabaseSession | null {
    try {
        const session = getLocalDatabaseSession();
        return session.identity === scope.userId ? session : null;
    } catch {
        // The local database deliberately blocks access while its account
        // files are switching. A later reconciliation will populate the new
        // scope; applying this old realtime payload would be unsafe.
        return null;
    }
}

async function applyChange(
    table: string,
    payload: RealtimePayload,
    onSync: () => void,
    scope: AuthIdentityScope,
    isActive: () => boolean,
): Promise<void> {
    if (!isActive() || !isAuthIdentityScopeCurrent(scope)) return;

    if (table === 'vessel_crew') {
        // Membership/permission changes expand or contract the RLS-visible
        // snapshot. Replaying an old incremental cursor is insufficient.
        if (!isActive() || !isAuthIdentityScopeCurrent(scope)) return;
        onSync();
        void import('../services/vessel/SyncService')
            .then(({ requestFullReconciliation }) => {
                if (!isActive() || !isAuthIdentityScopeCurrent(scope)) return;
                return requestFullReconciliation().catch((error) =>
                    log.warn('[Realtime] Full membership reconciliation failed:', error),
                );
            })
            .catch((error) => log.warn('[Realtime] Could not load membership reconciliation:', error));
        return;
    }

    const rawRecord = payload.eventType === 'DELETE' ? payload.old : payload.new;
    if (typeof rawRecord?.id !== 'string' || !rawRecord.id) {
        log.warn(`[Realtime] ${table} change did not include a record ID`);
        return;
    }

    const databaseSession = captureDatabaseSession(scope);
    if (!databaseSession) return;

    await applyRealtimeChange(
        table,
        payload.eventType,
        {
            ...rawRecord,
            id: rawRecord.id,
            updated_at: typeof rawRecord.updated_at === 'string' ? rawRecord.updated_at : undefined,
            created_at: typeof rawRecord.created_at === 'string' ? rawRecord.created_at : undefined,
        },
        databaseSession,
    );
    if (isActive() && isAuthIdentityScopeCurrent(scope) && isLocalDatabaseSessionCurrent(databaseSession)) {
        onSync();
    }
}

/**
 * Subscribe, then fetch. Realtime never replays what happened before a
 * channel joined, nor while it was down, so every join asks the sync engine to
 * catch up (deletes included): the first one, because the page has just opened
 * and this device may have missed changes while nothing was listening (the
 * iPad sat on the Nav Station while the phone deleted a Stores item), and
 * every rejoin after a drop (realtime-js rejoins an errored channel on its
 * own). The sync engine debounces and spaces these.
 */
function requestCatchUpAfterJoin(scope: AuthIdentityScope, isActive: () => boolean): void {
    void import('../services/vessel/SyncService')
        .then(({ requestCatchUpSync }) => {
            if (!isActive() || !isAuthIdentityScopeCurrent(scope)) return;
            requestCatchUpSync();
        })
        .catch((error) => log.warn('[Realtime] Could not request a catch-up sync:', error));
}

/**
 * A channel realtime-js has CLOSED for good (the server closed it, say after
 * a long background with an expired token, or a binding mismatch made the
 * client leave it) never rejoins by itself. The page opens a new one after
 * this backoff, a few times at most: past that, the foreground catch-up and
 * the five-minute cycle still bring changes in.
 */
const REOPEN_BASE_DELAY_MS = 2000;
const REOPEN_MAX_DELAY_MS = 30_000;
const REOPEN_MAX_ATTEMPTS = 6;
/**
 * Only a join that stays up this long earns a fresh set of reopens. Reset on
 * every join, a server that accepts a channel and closes it at once had the
 * page reopening it (and asking for a catch-up) every couple of seconds for
 * as long as the page stayed open.
 */
const REOPEN_STABLE_MS = 60_000;

/**
 * One realtime channel for one open page, with a postgres_changes binding per
 * table (Maintenance listens to tasks AND history on the same socket channel).
 */
function useRealtimeChannel(tables: readonly string[], onSync: () => void, enabled: boolean): void {
    const onSyncRef = useRef(onSync);
    const [channelId] = useState(() => ++channelInstance);
    const identityScope = useSyncExternalStore(subscribeIdentitySnapshot, getIdentitySnapshot, getIdentitySnapshot);
    onSyncRef.current = onSync;
    const tableKey = tables.join(',');

    useEffect(() => {
        const client = supabase;
        const subscribedTables = tableKey ? tableKey.split(',') : [];
        if (!client || !enabled || subscribedTables.length === 0) return;

        let active = true;
        let channel: RealtimeChannel | null = null;
        let reopenAttempts = 0;
        let reopenTimer: ReturnType<typeof setTimeout> | null = null;
        let stableTimer: ReturnType<typeof setTimeout> | null = null;
        const clearStableTimer = () => {
            if (stableTimer) clearTimeout(stableTimer);
            stableTimer = null;
        };
        const isActive = () => active;
        const label = subscribedTables.join(', ');

        const open = (attempt: number) => {
            if (!active || !isAuthIdentityScopeCurrent(identityScope)) return;
            try {
                let next = client.channel(
                    `realtime-${subscribedTables.join('+')}-${channelId}-${identityScope.generation}${
                        attempt > 0 ? `-r${attempt}` : ''
                    }`,
                );
                for (const table of subscribedTables) {
                    next = next.on(
                        'postgres_changes',
                        {
                            event: '*', // INSERT, UPDATE, DELETE
                            schema: 'public',
                            table,
                        },
                        (payload) => {
                            if (!active || !isAuthIdentityScopeCurrent(identityScope)) return;
                            // Apply the actual row payload to the offline mirror.
                            // In particular, DELETE cannot be recovered by the
                            // timestamp-only periodic pull.
                            log.debug(`[Realtime] ${table} changed — syncing`);
                            void applyChange(
                                table,
                                payload as unknown as RealtimePayload,
                                () => onSyncRef.current(),
                                identityScope,
                                isActive,
                            ).catch((error) => {
                                if (!active) return;
                                log.warn(`[Realtime] Failed to apply ${table} change:`, error);
                                // Server-only subscriptions such as vessel_crew
                                // have no LocalDatabase mirror. Only notify its
                                // caller while this channel still owns the active
                                // account; stale channels fail closed.
                                if (isAuthIdentityScopeCurrent(identityScope)) onSyncRef.current();
                            });
                        },
                    );
                }
                const opened = next;
                channel = opened;
                opened.subscribe((status) => {
                    // A status from a channel this page already let go of
                    // (unmounted, or closed and replaced) changes nothing.
                    if (!active || channel !== opened) return;
                    clearStableTimer();
                    if (status === 'SUBSCRIBED') {
                        stableTimer = setTimeout(() => {
                            stableTimer = null;
                            reopenAttempts = 0;
                        }, REOPEN_STABLE_MS);
                        log.debug(`[Realtime] Joined ${label} — catching up`);
                        requestCatchUpAfterJoin(identityScope, isActive);
                    } else if (status === 'CLOSED') {
                        // realtime-js already removed it from the socket.
                        channel = null;
                        reopenLater();
                    }
                });
            } catch (error) {
                if (active) log.warn(`[Realtime] Could not subscribe to ${label}:`, error);
            }
        };

        const reopenLater = () => {
            if (!active || reopenTimer) return;
            if (reopenAttempts >= REOPEN_MAX_ATTEMPTS) {
                log.warn(`[Realtime] ${label} channel keeps closing; relying on catch-up syncs`);
                return;
            }
            const delay = Math.min(REOPEN_MAX_DELAY_MS, REOPEN_BASE_DELAY_MS * 2 ** reopenAttempts);
            reopenAttempts += 1;
            const attempt = reopenAttempts;
            reopenTimer = setTimeout(() => {
                reopenTimer = null;
                open(attempt);
            }, delay);
        };

        // Small delay to avoid subscribing during rapid navigation
        const timer = setTimeout(() => open(0), 300);

        return () => {
            active = false;
            clearTimeout(timer);
            clearStableTimer();
            if (reopenTimer) clearTimeout(reopenTimer);
            reopenTimer = null;
            if (channel) {
                client.removeChannel(channel);
            }
        };
    }, [channelId, tableKey, enabled, identityScope]);
}

/**
 * Subscribe to realtime changes on a Supabase table.
 * Calls `onSync` whenever any INSERT, UPDATE, or DELETE occurs.
 *
 * @param table - The Supabase table name (e.g., 'inventory_items')
 * @param onSync - Callback to reload data (e.g., loadItems)
 * @param enabled - Optional flag to enable/disable the subscription
 */
export function useRealtimeSync(table: string, onSync: () => void, enabled: boolean = true): void {
    useRealtimeChannel([table], onSync, enabled);
}

/**
 * Subscribe to realtime changes on multiple tables, on ONE channel.
 * Useful for Maintenance which spans tasks + history.
 */
export function useRealtimeSyncMulti(tables: string[], onSync: () => void, enabled: boolean = true): void {
    useRealtimeChannel(tables, onSync, enabled);
}
