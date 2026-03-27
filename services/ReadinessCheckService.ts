/**
 * ReadinessCheckService — Supabase audit trail for passage readiness checklists.
 *
 * OFFLINE-FIRST architecture:
 *   - All check states saved to localStorage immediately (instant UI)
 *   - Syncs to Supabase in background with 300ms debounce
 *   - Falls back gracefully when offline or table doesn't exist
 *
 * Table: passage_readiness_checks
 */

import { createLogger } from '../utils/createLogger';
import { supabase } from './supabase';

const log = createLogger('ReadinessCheck');

// ── Types ──────────────────────────────────────────────────────

export interface CheckState {
    checked: boolean;
    checked_at: string | null;
    checked_by_name: string | null;
    metadata?: Record<string, unknown>;
}

/** Full row shape on Supabase */
interface ReadinessCheckRow {
    id?: string;
    voyage_id: string;
    user_id: string;
    card_key: string;
    item_key: string;
    checked: boolean;
    checked_at: string | null;
    checked_by_name: string | null;
    metadata: Record<string, unknown>;
    created_at?: string;
    updated_at?: string;
}

// ── Constants ──────────────────────────────────────────────────

const TABLE = 'passage_readiness_checks';
const CACHE_PREFIX = 'thalassa_readiness_';

// ── Service ────────────────────────────────────────────────────

class ReadinessCheckServiceClass {
    private _debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
    private _tableExists: boolean | null = null;

    // ── Upsert (tick/untick) ───────────────────────────────────

    /**
     * Record a check state change. Saves to localStorage immediately,
     * then syncs to Supabase with 300ms debounce.
     */
    async upsertCheck(
        voyageId: string,
        cardKey: string,
        itemKey: string,
        checked: boolean,
        metadata?: Record<string, unknown>,
    ): Promise<void> {
        const now = new Date().toISOString();

        // 1. Save to localStorage immediately (instant UI feedback)
        const localData = this._getLocalChecks(voyageId);
        if (!localData[cardKey]) localData[cardKey] = {};
        localData[cardKey][itemKey] = {
            checked,
            checked_at: checked ? now : null,
            checked_by_name: null, // Will be filled with auth user on sync
            ...(metadata ? { metadata } : {}),
        };
        this._saveLocalChecks(voyageId, localData);

        // 2. Debounce Supabase sync (300ms)
        const debounceKey = `${voyageId}:${cardKey}:${itemKey}`;
        const existing = this._debounceTimers.get(debounceKey);
        if (existing) clearTimeout(existing);

        this._debounceTimers.set(
            debounceKey,
            setTimeout(() => {
                this._syncToSupabase(voyageId, cardKey, itemKey, checked, now, metadata);
                this._debounceTimers.delete(debounceKey);
            }, 300),
        );
    }

    // ── Load ───────────────────────────────────────────────────

    /**
     * Load all check states for a voyage.
     * Returns localStorage data immediately, then background-refreshes from Supabase.
     */
    async loadChecks(voyageId: string): Promise<Record<string, Record<string, CheckState>>> {
        // 1. Return localStorage data immediately
        const localData = this._getLocalChecks(voyageId);

        // 2. Background refresh from Supabase (non-blocking)
        this._refreshFromSupabase(voyageId);

        return localData;
    }

    /**
     * Load checks for a specific card only.
     */
    async loadCardChecks(voyageId: string, cardKey: string): Promise<Record<string, CheckState>> {
        const allChecks = await this.loadChecks(voyageId);
        return allChecks[cardKey] || {};
    }

    // ── Clear ──────────────────────────────────────────────────

    /**
     * Clear all checks for a voyage (or specific card).
     */
    async clearChecks(voyageId: string, cardKey?: string): Promise<void> {
        if (cardKey) {
            const localData = this._getLocalChecks(voyageId);
            delete localData[cardKey];
            this._saveLocalChecks(voyageId, localData);
        } else {
            try {
                localStorage.removeItem(CACHE_PREFIX + voyageId);
            } catch {
                /* ignore */
            }
        }

        // Clear from Supabase too
        if (!supabase) return;
        try {
            const user = (await supabase.auth.getUser()).data.user;
            if (!user) return;

            let query = supabase.from(TABLE).delete().eq('voyage_id', voyageId).eq('user_id', user.id);
            if (cardKey) query = query.eq('card_key', cardKey);
            await query;
        } catch (e) {
            log.warn('Clear from Supabase failed:', e);
        }
    }

    // ── Supabase Sync ──────────────────────────────────────────

    private async _syncToSupabase(
        voyageId: string,
        cardKey: string,
        itemKey: string,
        checked: boolean,
        checkedAt: string,
        metadata?: Record<string, unknown>,
    ): Promise<void> {
        if (!supabase) return;

        try {
            const user = (await supabase.auth.getUser()).data.user;
            if (!user) {
                log.warn('No authenticated user — skipping Supabase sync');
                return;
            }

            // Check if table exists (only probe once per session)
            if (this._tableExists === null) {
                this._tableExists = await this._probeTable();
            }
            if (!this._tableExists) return;

            const displayName = user.user_metadata?.display_name || user.email || 'Unknown';

            const row: ReadinessCheckRow = {
                voyage_id: voyageId,
                user_id: user.id,
                card_key: cardKey,
                item_key: itemKey,
                checked,
                checked_at: checked ? checkedAt : null,
                checked_by_name: displayName,
                metadata: metadata || {},
            };

            const { error } = await supabase.from(TABLE).upsert(row, { onConflict: 'voyage_id,card_key,item_key' });

            if (error) {
                log.warn(`Supabase upsert failed for ${cardKey}/${itemKey}:`, error.message);
            }
        } catch (e) {
            log.warn('Supabase sync failed (will retry from localStorage):', e);
        }
    }

    private async _refreshFromSupabase(voyageId: string): Promise<void> {
        if (!supabase) return;

        try {
            const user = (await supabase.auth.getUser()).data.user;
            if (!user) return;

            // Check table exists
            if (this._tableExists === null) {
                this._tableExists = await this._probeTable();
            }
            if (!this._tableExists) return;

            const { data, error } = await supabase
                .from(TABLE)
                .select('card_key, item_key, checked, checked_at, checked_by_name, metadata')
                .eq('voyage_id', voyageId)
                .eq('user_id', user.id);

            if (error || !data) return;

            // Merge server data with local data (server wins if newer)
            const localData = this._getLocalChecks(voyageId);
            let updated = false;

            for (const row of data as ReadinessCheckRow[]) {
                if (!localData[row.card_key]) localData[row.card_key] = {};
                const localItem = localData[row.card_key][row.item_key];

                // Server wins if local doesn't have this item, or if server has a newer timestamp
                if (
                    !localItem ||
                    (row.checked_at && (!localItem.checked_at || row.checked_at > localItem.checked_at))
                ) {
                    localData[row.card_key][row.item_key] = {
                        checked: row.checked,
                        checked_at: row.checked_at,
                        checked_by_name: row.checked_by_name,
                        metadata: row.metadata,
                    };
                    updated = true;
                }
            }

            if (updated) {
                this._saveLocalChecks(voyageId, localData);
            }
        } catch (e) {
            log.warn('Supabase refresh failed:', e);
        }
    }

    /**
     * Lightweight probe to check if the table exists.
     * Avoids noisy errors during development before migration runs.
     */
    private async _probeTable(): Promise<boolean> {
        if (!supabase) return false;
        try {
            const { error } = await supabase.from(TABLE).select('id').limit(0);
            if (error) {
                log.info(`Table '${TABLE}' not found — running in localStorage-only mode`);
                return false;
            }
            return true;
        } catch {
            return false;
        }
    }

    // ── localStorage ───────────────────────────────────────────

    private _getLocalChecks(voyageId: string): Record<string, Record<string, CheckState>> {
        try {
            const raw = localStorage.getItem(CACHE_PREFIX + voyageId);
            return raw ? JSON.parse(raw) : {};
        } catch {
            return {};
        }
    }

    private _saveLocalChecks(voyageId: string, data: Record<string, Record<string, CheckState>>): void {
        try {
            localStorage.setItem(CACHE_PREFIX + voyageId, JSON.stringify(data));
        } catch (e) {
            log.warn('localStorage write failed:', e);
        }
    }
}

// ── Singleton ──────────────────────────────────────────────────

export const ReadinessCheckService = new ReadinessCheckServiceClass();
