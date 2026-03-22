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

import { useEffect, useRef } from 'react';
import { createLogger } from '../utils/createLogger';

const log = createLogger('useRealtimeSync');
import { supabase } from '../services/supabase';
import type { RealtimeChannel } from '@supabase/supabase-js';

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
    onSyncRef.current = onSync;

    useEffect(() => {
        if (!supabase || !enabled) return;

        let channel: RealtimeChannel | null = null;

        // Small delay to avoid subscribing during rapid navigation
        const timer = setTimeout(() => {
            channel = supabase!
                .channel(`realtime-${table}`)
                .on(
                    'postgres_changes',
                    {
                        event: '*', // INSERT, UPDATE, DELETE
                        schema: 'public',
                        table: table,
                    },
                    (_payload) => {
                        // Another client changed this table — reload our data
                        log.debug(`[Realtime] ${table} changed — syncing`);
                        onSyncRef.current();
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
    }, [table, enabled]);
}

/**
 * Subscribe to realtime changes on multiple tables.
 * Useful for Maintenance which spans tasks + history.
 */
export function useRealtimeSyncMulti(tables: string[], onSync: () => void, enabled: boolean = true): void {
    const onSyncRef = useRef(onSync);
    onSyncRef.current = onSync;

    useEffect(() => {
        if (!supabase || !enabled || tables.length === 0) return;

        const channels: RealtimeChannel[] = [];

        const timer = setTimeout(() => {
            tables.forEach((table) => {
                const channel = supabase!
                    .channel(`realtime-${table}-${Date.now()}`)
                    .on(
                        'postgres_changes',
                        {
                            event: '*',
                            schema: 'public',
                            table: table,
                        },
                        (_payload) => {
                            log.debug(`[Realtime] ${table} changed — syncing`);
                            onSyncRef.current();
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
    }, [tables.join(','), enabled]);
}
