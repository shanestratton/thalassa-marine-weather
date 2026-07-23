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
import {
    authScopedStorageKey,
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
    type AuthIdentityScope,
} from './authIdentityScope';

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

    constructor() {
        subscribeAuthIdentityScope(() => {
            for (const timer of this._debounceTimers.values()) clearTimeout(timer);
            this._debounceTimers.clear();
            this._tableExists = null;
        });
    }

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
        const scope = getAuthIdentityScope();
        const now = new Date().toISOString();

        // 1. Save to localStorage immediately (instant UI feedback)
        const localData = this._getLocalChecks(voyageId, scope);
        if (!localData[cardKey]) localData[cardKey] = {};
        localData[cardKey][itemKey] = {
            checked,
            checked_at: checked ? now : null,
            checked_by_name: null, // Will be filled with auth user on sync
            ...(metadata ? { metadata } : {}),
        };
        this._saveLocalChecks(voyageId, localData, scope);

        // 2. Debounce Supabase sync (300ms)
        const debounceKey = this._debounceKey(scope, voyageId, cardKey, itemKey);
        const existing = this._debounceTimers.get(debounceKey);
        if (existing) clearTimeout(existing);

        const timer = setTimeout(() => {
            if (this._debounceTimers.get(debounceKey) !== timer) return;
            this._debounceTimers.delete(debounceKey);
            if (!isAuthIdentityScopeCurrent(scope)) return;
            void this._syncToSupabase(voyageId, cardKey, itemKey, checked, now, scope, metadata);
        }, 300);
        this._debounceTimers.set(debounceKey, timer);
    }

    // ── Load ───────────────────────────────────────────────────

    /**
     * Load all check states for a voyage.
     * Returns localStorage data immediately, then background-refreshes from Supabase.
     */
    async loadChecks(voyageId: string): Promise<Record<string, Record<string, CheckState>>> {
        const scope = getAuthIdentityScope();
        // 1. Return localStorage data immediately
        const localData = this._getLocalChecks(voyageId, scope);

        // 2. Background refresh from Supabase (non-blocking)
        void this._refreshFromSupabase(voyageId, scope);

        // Yield once so an auth transition already queued by Supabase cannot
        // deliver the previous account's snapshot to the next account's UI.
        await Promise.resolve();
        return isAuthIdentityScopeCurrent(scope) ? localData : this._getLocalChecks(voyageId);
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
        const scope = getAuthIdentityScope();
        this._cancelDebounces(scope, voyageId, cardKey);
        if (cardKey) {
            const localData = this._getLocalChecks(voyageId, scope);
            delete localData[cardKey];
            this._saveLocalChecks(voyageId, localData, scope);
        } else {
            try {
                localStorage.removeItem(this._storageKey(voyageId, scope));
            } catch {
                /* ignore */
            }
        }

        // Clear from Supabase too
        if (!supabase || !scope.userId || !isAuthIdentityScopeCurrent(scope)) return;
        try {
            const user = (await supabase.auth.getUser()).data.user;
            if (!isAuthIdentityScopeCurrent(scope) || user?.id !== scope.userId) return;

            let query = supabase.from(TABLE).delete().eq('voyage_id', voyageId).eq('user_id', scope.userId);
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
        scope: AuthIdentityScope,
        metadata?: Record<string, unknown>,
    ): Promise<void> {
        if (!supabase || !scope.userId || !isAuthIdentityScopeCurrent(scope)) return;

        try {
            const user = (await supabase.auth.getUser()).data.user;
            if (!isAuthIdentityScopeCurrent(scope) || user?.id !== scope.userId) {
                log.warn('No authenticated user — skipping Supabase sync');
                return;
            }

            // Check if table exists (only probe once per session)
            if (this._tableExists === null) {
                const exists = await this._probeTable(scope);
                if (!isAuthIdentityScopeCurrent(scope)) return;
                this._tableExists = exists;
            }
            if (!this._tableExists) return;

            const displayName = user.user_metadata?.display_name || user.email || 'Unknown';

            const row: ReadinessCheckRow = {
                voyage_id: voyageId,
                user_id: scope.userId,
                card_key: cardKey,
                item_key: itemKey,
                checked,
                checked_at: checked ? checkedAt : null,
                checked_by_name: displayName,
                metadata: metadata || {},
            };

            const { error } = await supabase.from(TABLE).upsert(row, { onConflict: 'voyage_id,card_key,item_key' });

            if (!isAuthIdentityScopeCurrent(scope)) return;
            if (error) {
                log.warn(`Supabase upsert failed for ${cardKey}/${itemKey}:`, error.message);
            }
        } catch (e) {
            log.warn('Supabase sync failed (will retry from localStorage):', e);
        }
    }

    private async _refreshFromSupabase(voyageId: string, scope: AuthIdentityScope): Promise<void> {
        if (!supabase || !scope.userId || !isAuthIdentityScopeCurrent(scope)) return;

        try {
            const user = (await supabase.auth.getUser()).data.user;
            if (!isAuthIdentityScopeCurrent(scope) || user?.id !== scope.userId) return;

            // Check table exists
            if (this._tableExists === null) {
                const exists = await this._probeTable(scope);
                if (!isAuthIdentityScopeCurrent(scope)) return;
                this._tableExists = exists;
            }
            if (!this._tableExists) return;

            const { data, error } = await supabase
                .from(TABLE)
                .select('card_key, item_key, checked, checked_at, checked_by_name, metadata')
                .eq('voyage_id', voyageId)
                .eq('user_id', scope.userId);

            if (!isAuthIdentityScopeCurrent(scope)) return;
            if (error || !data) return;

            // Merge server data with local data (server wins if newer)
            const localData = this._getLocalChecks(voyageId, scope);
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

            if (updated && isAuthIdentityScopeCurrent(scope)) {
                this._saveLocalChecks(voyageId, localData, scope);
            }
        } catch (e) {
            log.warn('Supabase refresh failed:', e);
        }
    }

    /**
     * Lightweight probe to check if the table exists.
     * Avoids noisy errors during development before migration runs.
     */
    private async _probeTable(scope: AuthIdentityScope): Promise<boolean> {
        if (!supabase || !isAuthIdentityScopeCurrent(scope)) return false;
        try {
            const { error } = await supabase.from(TABLE).select('id').limit(0);
            if (!isAuthIdentityScopeCurrent(scope)) return false;
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

    private _storageKey(voyageId: string, scope: AuthIdentityScope = getAuthIdentityScope()): string {
        return authScopedStorageKey(CACHE_PREFIX + voyageId, scope);
    }

    private _getLocalChecks(
        voyageId: string,
        scope: AuthIdentityScope = getAuthIdentityScope(),
    ): Record<string, Record<string, CheckState>> {
        try {
            // Unscoped legacy rows cannot be attributed safely and are never
            // imported into the current account.
            const raw = localStorage.getItem(this._storageKey(voyageId, scope));
            return raw ? JSON.parse(raw) : {};
        } catch {
            return {};
        }
    }

    private _saveLocalChecks(
        voyageId: string,
        data: Record<string, Record<string, CheckState>>,
        scope: AuthIdentityScope = getAuthIdentityScope(),
    ): void {
        if (!isAuthIdentityScopeCurrent(scope)) return;
        const key = this._storageKey(voyageId, scope);
        const payload = JSON.stringify(data);
        try {
            localStorage.setItem(key, payload);
        } catch {
            // Quota exceeded — happens on iOS WKWebView after many
            // voyages accumulate (~5MB cap). Prune all OTHER voyage
            // caches and retry. We keep only the current voyage's
            // checks; older voyages re-hydrate from supabase on demand.
            // Better than spamming the console with quota warnings on
            // every check toggle.
            try {
                this._pruneOtherVoyageCaches(voyageId, scope);
                localStorage.setItem(key, payload);
            } catch {
                // Even after pruning we can't write — the single
                // payload exceeds quota. Last resort: drop metadata
                // (notes, photos) and try just the boolean state.
                try {
                    const minimal: Record<string, Record<string, CheckState>> = {};
                    for (const [card, items] of Object.entries(data)) {
                        minimal[card] = {};
                        for (const [item, state] of Object.entries(items)) {
                            minimal[card][item] = {
                                checked: state.checked,
                                checked_at: state.checked_at,
                                checked_by_name: state.checked_by_name,
                            };
                        }
                    }
                    localStorage.setItem(key, JSON.stringify(minimal));
                } catch {
                    /* truly out of room — supabase remains source of truth */
                }
            }
        }
    }

    /**
     * Drop every readiness cache except the current voyage's. Called
     * when localStorage hits quota — frees space for the live voyage
     * while leaving supabase as the durable record for older trips.
     */
    private _pruneOtherVoyageCaches(currentVoyageId: string, scope: AuthIdentityScope): void {
        const keep = this._storageKey(currentVoyageId, scope);
        const scopeSuffix = `::${encodeURIComponent(scope.key)}`;
        const toRemove: string[] = [];
        try {
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k && k.startsWith(CACHE_PREFIX) && k.endsWith(scopeSuffix) && k !== keep) {
                    toRemove.push(k);
                }
            }
            for (const k of toRemove) localStorage.removeItem(k);
        } catch {
            /* non-critical */
        }
    }

    private _debounceKey(scope: AuthIdentityScope, voyageId: string, cardKey: string, itemKey: string): string {
        return `${scope.key}\u0000${voyageId}\u0000${cardKey}\u0000${itemKey}`;
    }

    private _cancelDebounces(scope: AuthIdentityScope, voyageId: string, cardKey?: string): void {
        const prefix = `${scope.key}\u0000${voyageId}\u0000${cardKey ? `${cardKey}\u0000` : ''}`;
        for (const [key, timer] of this._debounceTimers) {
            if (!key.startsWith(prefix)) continue;
            clearTimeout(timer);
            this._debounceTimers.delete(key);
        }
    }
}

// ── Singleton ──────────────────────────────────────────────────

export const ReadinessCheckService = new ReadinessCheckServiceClass();
