/**
 * VoyageLogService — the punter's side of the public Voyage Log.
 *
 * Owns the `voyage_log_configs` row: the per-vessel handle, publishable
 * API key, and master on/off switch that the public `voyage-log` edge
 * function reads. Diary entries themselves carry their own `is_public`
 * flag (see DiaryService) — this service only manages the config.
 */

import { createLogger } from '../utils/createLogger';
import { supabase, supabaseUrl } from './supabase';
import { getAuthIdentityScope, isAuthIdentityScopeCurrent, type AuthIdentityScope } from './authIdentityScope';

const log = createLogger('VoyageLog');

export interface VoyageLogConfig {
    id: string;
    owner_id: string;
    boat_id: string | null;
    handle: string;
    api_key: string;
    enabled: boolean;
    scope: 'personal' | 'combined';
    track_days: number;
    created_at: string;
    updated_at: string;
}

/**
 * Public renderer URL — wildcard subdomain pattern. The renderer reads
 * the handle from window.location.hostname so we don't ship a key in
 * the URL anymore (was never a secret; dropped in commit 4a987e82 when
 * we moved to <handle>.thalassawx.app).
 */
export function voyageLogPublicUrl(handle: string, _apiKey?: string): string {
    void _apiKey; // legacy callers still pass the key; ignore it.
    return `https://${handle}.thalassawx.app`;
}

/** Raw API endpoint a punter's own front-end would call. No key — drop in any handle. */
export function voyageLogApiUrl(handle: string, _apiKey?: string): string {
    void _apiKey;
    const base = (supabaseUrl || '').replace(/\/$/, '');
    return `${base}/functions/v1/voyage-log?handle=${encodeURIComponent(handle)}`;
}

interface VoyageLogOperation {
    scope: AuthIdentityScope;
    userId: string;
    userMetadata: {
        first_name?: string;
        last_name?: string;
        prefix?: string;
        nickname?: string;
    };
}

class VoyageLogServiceClass {
    /**
     * Errors are generation-scoped. A late account-A failure must never appear
     * in account B, or reappear after an A → B → A transition.
     */
    private readonly errorsByIdentity = new Map<string, { generation: number; error: string | null }>();

    /** Preserve the existing property API while making it identity-safe. */
    get lastError(): string | null {
        const scope = getAuthIdentityScope();
        const entry = this.errorsByIdentity.get(scope.key);
        return entry?.generation === scope.generation ? entry.error : null;
    }

    set lastError(error: string | null) {
        this.setError(getAuthIdentityScope(), error);
    }

    private setError(scope: AuthIdentityScope, error: string | null): void {
        if (!isAuthIdentityScopeCurrent(scope)) return;
        this.errorsByIdentity.set(scope.key, { generation: scope.generation, error });
    }

    private errorFor(scope: AuthIdentityScope): string | null {
        const entry = this.errorsByIdentity.get(scope.key);
        return entry?.generation === scope.generation ? entry.error : null;
    }

    /**
     * Capture auth once for an operation and require it to agree with the
     * synchronous identity fence. Every later query receives this immutable
     * user id; no method re-reads a potentially different auth session.
     */
    private async authenticate(scope: AuthIdentityScope, reportError: boolean): Promise<VoyageLogOperation | null> {
        if (!supabase) {
            if (reportError) this.setError(scope, 'Offline — Supabase client unavailable.');
            return null;
        }
        if (!isAuthIdentityScopeCurrent(scope)) return null;

        try {
            const { data, error } = await supabase.auth.getUser();
            if (!isAuthIdentityScopeCurrent(scope)) return null;
            if (error) {
                if (reportError) this.setError(scope, `Sign-in check failed: ${error.message}`);
                return null;
            }

            const user = data.user;
            if (!user?.id || user.id !== scope.userId) {
                if (reportError) this.setError(scope, 'You need to sign in before changing Voyage Log.');
                return null;
            }

            const rawMetadata = user.user_metadata;
            const userMetadata =
                rawMetadata && typeof rawMetadata === 'object'
                    ? (rawMetadata as VoyageLogOperation['userMetadata'])
                    : {};
            return {
                scope,
                userId: user.id,
                userMetadata: { ...userMetadata },
            };
        } catch (error) {
            if (reportError && isAuthIdentityScopeCurrent(scope)) {
                this.setError(
                    scope,
                    `Sign-in check failed: ${error instanceof Error ? error.message : 'unknown error'}`,
                );
            }
            return null;
        }
    }

    /**
     * The captured user's owned boat. Both the query and returned row are
     * checked explicitly rather than depending on RLS as the only boundary.
     */
    private async getOwnedBoatId(operation: VoyageLogOperation, reportError: boolean): Promise<string | null> {
        if (!supabase) return null;
        if (!isAuthIdentityScopeCurrent(operation.scope)) return null;

        const { data, error } = await supabase
            .from('boats')
            .select('id, owner_id')
            .eq('owner_id', operation.userId)
            .maybeSingle();
        if (!isAuthIdentityScopeCurrent(operation.scope)) return null;
        if (error) {
            log.warn('getOwnedBoatId failed:', error.message);
            if (reportError) this.setError(operation.scope, `Boat lookup failed: ${error.message}`);
            return null;
        }

        if (!data) return null;
        const row = data as { id?: unknown; owner_id?: unknown };
        if (typeof row.id !== 'string' || row.owner_id !== operation.userId) {
            if (reportError) this.setError(operation.scope, 'Boat lookup returned an invalid owner.');
            return null;
        }
        return row.id;
    }

    /**
     * The current user's voyage log config, or null if they've never set
     * one up. Returns the COMBINED-scope config for the user's owned boat
     * — that's the public face of the vessel (boat-wide, aggregates all
     * crew entries). Personal-scope configs (one per crew member per boat)
     * are managed by a different surface — VoyageLogTab's "Boats you're
     * crew on" section, which can also list the owner's own personal
     * config alongside the combined one.
     *
     * Why this needed re-scoping: after the multi-crew migration, a single
     * user can have multiple voyage_log_configs rows (personal + combined).
     * The pre-migration query (.eq('owner_id', userId).maybeSingle()) would
     * crash silently on the multi-row result, returning null and making the
     * settings tab show "Set up your Voyage Log" even though the user IS
     * set up.
     */
    async getConfig(): Promise<VoyageLogConfig | null> {
        const scope = getAuthIdentityScope();
        try {
            const operation = await this.authenticate(scope, false);
            if (!operation) return null;
            return await this.getConfigForOperation(operation);
        } catch (error) {
            if (isAuthIdentityScopeCurrent(scope)) log.warn('getConfig failed:', error);
            return null;
        }
    }

    private async getConfigForOperation(
        operation: VoyageLogOperation,
        knownBoatId?: string,
    ): Promise<VoyageLogConfig | null> {
        if (!supabase || !isAuthIdentityScopeCurrent(operation.scope)) return null;
        const boatId = knownBoatId ?? (await this.getOwnedBoatId(operation, false));
        if (!boatId || !isAuthIdentityScopeCurrent(operation.scope)) return null;

        const { data, error } = await supabase
            .from('voyage_log_configs')
            .select('*')
            .eq('owner_id', operation.userId)
            .eq('boat_id', boatId)
            .eq('scope', 'combined')
            .maybeSingle();
        if (!isAuthIdentityScopeCurrent(operation.scope)) return null;
        if (error) {
            log.warn('getConfig failed:', error.message);
            return null;
        }
        if (!data || typeof data !== 'object') return null;

        const config = data as VoyageLogConfig;
        if (config.owner_id !== operation.userId || config.boat_id !== boatId || config.scope !== 'combined') {
            log.warn('getConfig rejected an ownership-mismatched row');
            return null;
        }
        return config;
    }

    /**
     * Get-or-create the user's owned boat. For users who completed
     * onboarding before the multi-crew migration shipped, the migration
     * backfilled a boats row for them. Fresh users have a vessel_identity
     * row (from onboarding) but no boats row — nothing creates one
     * automatically. This builds it from vessel_identity and registers
     * the user as the owner boat_member at the same time so the
     * combined log (which queries by boat_member) finds them.
     */
    private async getOrCreateOwnedBoat(operation: VoyageLogOperation): Promise<string | null> {
        if (!supabase) return null;
        const existing = await this.getOwnedBoatId(operation, true);
        if (!isAuthIdentityScopeCurrent(operation.scope)) return null;
        if (existing) {
            await this.ensureOwnerMembership(operation, existing);
            return isAuthIdentityScopeCurrent(operation.scope) ? existing : null;
        }
        // A lookup error must not fall through and create a duplicate boat.
        if (this.errorFor(operation.scope)) return null;

        // Pull vessel info from onboarding's canonical store. Falls
        // back to sensible defaults if vessel_identity is empty too
        // (shouldn't happen post-onboarding, but defensive).
        const { data: vessel } = await supabase
            .from('vessel_identity')
            .select('vessel_name, vessel_type, model')
            .eq('owner_id', operation.userId)
            .maybeSingle();
        if (!isAuthIdentityScopeCurrent(operation.scope)) return null;

        const vesselRow = vessel as {
            vessel_name?: string | null;
            vessel_type?: string | null;
            model?: string | null;
        } | null;
        const name = (vesselRow?.vessel_name ?? '').trim() || 'My Boat';

        const { data: boat, error: boatErr } = await supabase
            .from('boats')
            .insert({
                owner_id: operation.userId,
                name,
                vessel_type: vesselRow?.vessel_type ?? 'sail',
                model: vesselRow?.model ?? null,
            })
            .select('id, owner_id')
            .single();
        if (!isAuthIdentityScopeCurrent(operation.scope)) return null;
        if (boatErr || !boat?.id) {
            log.warn('getOrCreateOwnedBoat failed:', boatErr?.message);
            this.setError(operation.scope, `Couldn't create your boat row: ${boatErr?.message ?? 'no id returned'}`);
            return null;
        }
        const createdBoat = boat as { id: string; owner_id?: string };
        if (createdBoat.owner_id !== operation.userId) {
            this.setError(operation.scope, "Couldn't verify the new boat's owner.");
            return null;
        }

        await this.ensureOwnerMembership(operation, createdBoat.id);
        return isAuthIdentityScopeCurrent(operation.scope) ? createdBoat.id : null;
    }

    private async ensureOwnerMembership(operation: VoyageLogOperation, boatId: string): Promise<void> {
        if (!supabase || !isAuthIdentityScopeCurrent(operation.scope)) return;
        const meta = operation.userMetadata;
        const { error: memberErr } = await supabase.from('boat_members').insert({
            boat_id: boatId,
            user_id: operation.userId,
            first_name: meta?.first_name ?? 'Crew',
            last_name: meta?.last_name ?? null,
            prefix: meta?.prefix ?? null,
            nickname: meta?.nickname ?? null,
            role: 'owner',
        });
        if (!isAuthIdentityScopeCurrent(operation.scope)) return;
        if (memberErr) {
            // PK conflict is fine — read path will pick up whatever's there.
            // Other errors (RLS, missing column) are worth surfacing.
            if (!/duplicate key|unique/i.test(memberErr.message)) {
                log.warn('boat_members insert failed:', memberErr.message);
                this.setError(operation.scope, `Couldn't register you as crew: ${memberErr.message}`);
            }
        }
    }

    /**
     * Make sure the user has a combined-scope config row and that it's
     * enabled. Creates the boat row if needed (fresh users), then the
     * config (handle + key filled server-side by voyage_log_set_handle
     * trigger). Returns the live config, or null if offline /
     * unauthenticated.
     */
    async ensureEnabled(): Promise<VoyageLogConfig | null> {
        const scope = getAuthIdentityScope();
        this.setError(scope, null);
        try {
            const operation = await this.authenticate(scope, true);
            const client = supabase;
            if (!operation || !client) return null;

            const boatId = await this.getOrCreateOwnedBoat(operation);
            if (!boatId) {
                log.warn('ensureEnabled: could not get or create boat');
                if (isAuthIdentityScopeCurrent(scope) && !this.errorFor(scope)) {
                    this.setError(scope, 'Could not get or create your boat record.');
                }
                return null;
            }

            const existing = await this.getConfigForOperation(operation, boatId);
            if (!isAuthIdentityScopeCurrent(scope)) return null;
            if (existing) {
                if (existing.enabled) return existing;
                return await this.setEnabledForOperation(operation, boatId, true);
            }

            const { data, error } = await client
                .from('voyage_log_configs')
                .insert({ owner_id: operation.userId, boat_id: boatId, scope: 'combined', enabled: true })
                .select()
                .single();
            if (!isAuthIdentityScopeCurrent(scope)) return null;

            if (error) {
                log.warn('ensureEnabled insert failed:', error.message);
                this.setError(scope, `Couldn't create Voyage Log config: ${error.message}`);
                return null;
            }
            if (!data || typeof data !== 'object') {
                this.setError(scope, "Couldn't verify the new Voyage Log config.");
                return null;
            }
            const config = data as VoyageLogConfig;
            if (config.owner_id !== operation.userId || config.boat_id !== boatId || config.scope !== 'combined') {
                this.setError(scope, "Couldn't verify the new Voyage Log config owner.");
                return null;
            }
            return config;
        } catch (error) {
            if (isAuthIdentityScopeCurrent(scope)) {
                log.warn('ensureEnabled failed:', error);
                this.setError(scope, 'Voyage Log setup failed — check signal.');
            }
            return null;
        }
    }

    /** Flip the master switch on the combined config. Returns the updated config, or null on failure. */
    async setEnabled(enabled: boolean): Promise<VoyageLogConfig | null> {
        const scope = getAuthIdentityScope();
        this.setError(scope, null);
        try {
            const operation = await this.authenticate(scope, true);
            if (!operation) return null;

            const boatId = await this.getOwnedBoatId(operation, true);
            if (!boatId) return null;
            return await this.setEnabledForOperation(operation, boatId, enabled);
        } catch (error) {
            if (isAuthIdentityScopeCurrent(scope)) {
                log.warn('setEnabled failed:', error);
                this.setError(scope, 'Voyage Log update failed — check signal.');
            }
            return null;
        }
    }

    private async setEnabledForOperation(
        operation: VoyageLogOperation,
        boatId: string,
        enabled: boolean,
    ): Promise<VoyageLogConfig | null> {
        if (!supabase || !isAuthIdentityScopeCurrent(operation.scope)) return null;
        const { data, error } = await supabase
            .from('voyage_log_configs')
            .update({ enabled })
            .eq('owner_id', operation.userId)
            .eq('boat_id', boatId)
            .eq('scope', 'combined')
            .select()
            .single();
        if (!isAuthIdentityScopeCurrent(operation.scope)) return null;

        if (error) {
            log.warn('setEnabled failed:', error.message);
            this.setError(operation.scope, `Couldn't update Voyage Log: ${error.message}`);
            return null;
        }
        if (!data || typeof data !== 'object') {
            this.setError(operation.scope, "Couldn't verify the updated Voyage Log config.");
            return null;
        }
        const config = data as VoyageLogConfig;
        if (config.owner_id !== operation.userId || config.boat_id !== boatId || config.scope !== 'combined') {
            this.setError(operation.scope, "Couldn't verify the updated Voyage Log config owner.");
            return null;
        }
        return config;
    }

    // ── Per-voyage public visibility ───────────────────────────
    // The owner's exclusion list (voyage_log_hidden_voyages): hidden voyages
    // are filtered out of the public track + live tail by the edge function,
    // while the in-app log keeps them untouched. Keeps the public page from
    // turning into spaghetti when day-sails overlap.

    /** Voyage ids currently hidden from the public page. */
    async getHiddenVoyageIds(): Promise<Set<string>> {
        const scope = getAuthIdentityScope();
        const operation = await this.authenticate(scope, false);
        if (!operation || !supabase) return new Set();
        try {
            const { data, error } = await supabase
                .from('voyage_log_hidden_voyages')
                .select('user_id, voyage_id')
                .eq('user_id', operation.userId);
            if (!isAuthIdentityScopeCurrent(scope)) return new Set();
            if (error) {
                log.warn('getHiddenVoyageIds failed:', error.message);
                return new Set();
            }
            return new Set(
                (data ?? [])
                    .filter((row) => row.user_id === operation.userId && typeof row.voyage_id === 'string')
                    .map((row) => row.voyage_id as string),
            );
        } catch (e) {
            if (isAuthIdentityScopeCurrent(scope)) log.warn('getHiddenVoyageIds failed:', e);
            return new Set();
        }
    }

    // ── Voyage ↔ passage-plan links ────────────────────────────
    // A linked voyage drives the public page's DYNAMIC destination +
    // progress (the edge fn overrides the static config destination with
    // the linked plan's endpoint while the voyage is fresh).

    /** voyage_id → plan_voyage_id for every linked voyage. */
    async getPlanLinks(): Promise<Map<string, string>> {
        const scope = getAuthIdentityScope();
        const operation = await this.authenticate(scope, false);
        if (!operation || !supabase) return new Map();
        try {
            const { data, error } = await supabase
                .from('voyage_plan_links')
                .select('user_id, voyage_id, plan_voyage_id')
                .eq('user_id', operation.userId);
            if (!isAuthIdentityScopeCurrent(scope)) return new Map();
            if (error) {
                log.warn('getPlanLinks failed:', error.message);
                return new Map();
            }
            return new Map(
                (data ?? [])
                    .filter(
                        (row) =>
                            row.user_id === operation.userId &&
                            typeof row.voyage_id === 'string' &&
                            typeof row.plan_voyage_id === 'string',
                    )
                    .map((row) => [row.voyage_id as string, row.plan_voyage_id as string]),
            );
        } catch (e) {
            if (isAuthIdentityScopeCurrent(scope)) log.warn('getPlanLinks failed:', e);
            return new Map();
        }
    }

    /** Link a voyage to a plan (planId null = unlink). */
    async setVoyagePlanLink(voyageId: string, planId: string | null): Promise<boolean> {
        const scope = getAuthIdentityScope();
        this.setError(scope, null);
        const immutableVoyageId = voyageId.trim();
        const immutablePlanId = planId?.trim() || null;
        if (!immutableVoyageId) {
            this.setError(scope, 'A voyage id is required.');
            return false;
        }
        const operation = await this.authenticate(scope, true);
        if (!operation || !supabase || !isAuthIdentityScopeCurrent(scope)) return false;

        try {
            const { error } = immutablePlanId
                ? await supabase.from('voyage_plan_links').upsert(
                      {
                          user_id: operation.userId,
                          voyage_id: immutableVoyageId,
                          plan_voyage_id: immutablePlanId,
                      },
                      { onConflict: 'user_id,voyage_id' },
                  )
                : await supabase
                      .from('voyage_plan_links')
                      .delete()
                      .eq('user_id', operation.userId)
                      .eq('voyage_id', immutableVoyageId);
            if (!isAuthIdentityScopeCurrent(scope)) return false;
            if (error) {
                log.warn('setVoyagePlanLink failed:', error.message);
                this.setError(scope, `Couldn't update the passage link: ${error.message}`);
                return false;
            }
            return true;
        } catch (e) {
            if (isAuthIdentityScopeCurrent(scope)) {
                log.warn('setVoyagePlanLink failed:', e);
                this.setError(scope, 'Passage link update failed — check signal.');
            }
            return false;
        }
    }

    /** Hide (true) or show (false) one voyage on the public page. */
    async setVoyageHidden(voyageId: string, hidden: boolean): Promise<boolean> {
        const scope = getAuthIdentityScope();
        this.setError(scope, null);
        const immutableVoyageId = voyageId.trim();
        if (!immutableVoyageId) {
            this.setError(scope, 'A voyage id is required.');
            return false;
        }
        const operation = await this.authenticate(scope, true);
        if (!operation || !supabase || !isAuthIdentityScopeCurrent(scope)) return false;

        try {
            const { error } = hidden
                ? await supabase
                      .from('voyage_log_hidden_voyages')
                      .upsert(
                          { user_id: operation.userId, voyage_id: immutableVoyageId },
                          { onConflict: 'user_id,voyage_id' },
                      )
                : await supabase
                      .from('voyage_log_hidden_voyages')
                      .delete()
                      .eq('user_id', operation.userId)
                      .eq('voyage_id', immutableVoyageId);
            if (!isAuthIdentityScopeCurrent(scope)) return false;
            if (error) {
                log.warn('setVoyageHidden failed:', error.message);
                this.setError(scope, `Couldn't update track visibility: ${error.message}`);
                return false;
            }
            return true;
        } catch (e) {
            if (isAuthIdentityScopeCurrent(scope)) {
                log.warn('setVoyageHidden failed:', e);
                this.setError(scope, 'Track visibility update failed — check signal.');
            }
            return false;
        }
    }
}

export const VoyageLogService = new VoyageLogServiceClass();
