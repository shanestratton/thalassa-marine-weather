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
 * The subscription is automatically cleaned up on unmount.
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
): Promise<void> {
    if (!isAuthIdentityScopeCurrent(scope)) return;

    if (table === 'vessel_crew') {
        // Membership/permission changes expand or contract the RLS-visible
        // snapshot. Replaying an old incremental cursor is insufficient.
        if (!isAuthIdentityScopeCurrent(scope)) return;
        onSync();
        void import('../services/vessel/SyncService')
            .then(({ requestFullReconciliation }) => {
                if (!isAuthIdentityScopeCurrent(scope)) return;
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
    if (isAuthIdentityScopeCurrent(scope) && isLocalDatabaseSessionCurrent(databaseSession)) {
        onSync();
    }
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
    const onSyncRef = useRef(onSync);
    const [channelId] = useState(() => ++channelInstance);
    const identityScope = useSyncExternalStore(subscribeIdentitySnapshot, getIdentitySnapshot, getIdentitySnapshot);
    onSyncRef.current = onSync;

    useEffect(() => {
        if (!supabase || !enabled) return;

        let channel: RealtimeChannel | null = null;

        // Small delay to avoid subscribing during rapid navigation
        const timer = setTimeout(() => {
            if (!isAuthIdentityScopeCurrent(identityScope)) return;
            channel = supabase!
                .channel(`realtime-${table}-${channelId}-${identityScope.generation}`)
                .on(
                    'postgres_changes',
                    {
                        event: '*', // INSERT, UPDATE, DELETE
                        schema: 'public',
                        table: table,
                    },
                    (payload) => {
                        if (!isAuthIdentityScopeCurrent(identityScope)) return;
                        // Apply the actual row payload to the offline mirror.
                        // In particular, DELETE cannot be recovered by the
                        // timestamp-only periodic pull.
                        log.debug(`[Realtime] ${table} changed — syncing`);
                        void applyChange(
                            table,
                            payload as unknown as RealtimePayload,
                            () => onSyncRef.current(),
                            identityScope,
                        ).catch((error) => {
                            log.warn(`[Realtime] Failed to apply ${table} change:`, error);
                            // Server-only subscriptions such as vessel_crew
                            // have no LocalDatabase mirror. Only notify its
                            // caller while this channel still owns the active
                            // account; stale channels fail closed.
                            if (isAuthIdentityScopeCurrent(identityScope)) onSyncRef.current();
                        });
                    },
                )
                .subscribe((status) => {
                    if (status === 'SUBSCRIBED') {
                        log.debug(`[Realtime] Listening on ${table}`);
                    }
                });
        }, 300);

        return () => {
            clearTimeout(timer);
            if (channel) {
                supabase!.removeChannel(channel);
            }
        };
    }, [channelId, table, enabled, identityScope]);
}

/**
 * Subscribe to realtime changes on multiple tables.
 * Useful for Maintenance which spans tasks + history.
 */
export function useRealtimeSyncMulti(tables: string[], onSync: () => void, enabled: boolean = true): void {
    const onSyncRef = useRef(onSync);
    const [channelId] = useState(() => ++channelInstance);
    const identityScope = useSyncExternalStore(subscribeIdentitySnapshot, getIdentitySnapshot, getIdentitySnapshot);
    onSyncRef.current = onSync;

    useEffect(() => {
        if (!supabase || !enabled || tables.length === 0) return;

        const channels: RealtimeChannel[] = [];

        const timer = setTimeout(() => {
            if (!isAuthIdentityScopeCurrent(identityScope)) return;
            tables.forEach((table) => {
                const channel = supabase!
                    .channel(`realtime-${table}-${channelId}-${identityScope.generation}`)
                    .on(
                        'postgres_changes',
                        {
                            event: '*',
                            schema: 'public',
                            table: table,
                        },
                        (payload) => {
                            if (!isAuthIdentityScopeCurrent(identityScope)) return;
                            log.debug(`[Realtime] ${table} changed — syncing`);
                            void applyChange(
                                table,
                                payload as unknown as RealtimePayload,
                                () => onSyncRef.current(),
                                identityScope,
                            ).catch((error) => {
                                log.warn(`[Realtime] Failed to apply ${table} change:`, error);
                                if (isAuthIdentityScopeCurrent(identityScope)) onSyncRef.current();
                            });
                        },
                    )
                    .subscribe();

                channels.push(channel);
            });
        }, 300);

        return () => {
            clearTimeout(timer);
            channels.forEach((ch) => supabase!.removeChannel(ch));
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [channelId, tables.join(','), enabled, identityScope]);
}
