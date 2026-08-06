/**
 * delete-account — authenticated, irreversible account and data deletion.
 *
 * The caller must present its real Supabase access token and an exact typed
 * confirmation. Service-role access never leaves this function. Uploaded
 * media and user-generated rows that do not naturally cascade are removed
 * before auth.admin.deleteUser() deletes the account and all CASCADE-owned
 * application rows.
 */
import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
    appleSubjectForAuthenticatedUser,
    decryptAppleRefreshToken,
    readAppleServerConfig,
    revokeAppleRefreshToken,
} from '../_shared/apple-auth.ts';
import { jsonResponse } from '../_shared/http-security.ts';
import { drainExactStorageManifest, type StorageManifestGateway } from './storage-cleanup.ts';
import {
    authenticateDeletionCaller,
    requireDeletionMutation,
    requireExactDeletionRequest,
    runAccountDeletionWorkflow,
} from './workflow.ts';

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const json = (body: unknown, status = 200): Response => jsonResponse(body, status, CORS);
const CONFIRMATION = 'DELETE';

interface StoredAppleToken {
    refresh_token_ciphertext: string;
    refresh_token_iv: string;
    encryption_version: number;
    apple_subject_sha256: string;
}

type AppleRevocationState = 'pending' | 'revoking' | 'complete' | 'manual_required' | 'not_applicable';

interface DeletionClaim {
    acquired: boolean;
    current_phase: string;
    current_apple_revocation_state: AppleRevocationState;
    current_apple_subject_sha256: string | null;
    is_completed: boolean;
}

const DELETION_PHASE_RANK: Record<string, number> = {
    requested: 0,
    apple_revocation: 10,
    storage_capture: 20,
    storage_cleanup: 30,
    storage_verified: 40,
    survivor_scrub: 50,
    ready_for_auth_delete: 60,
    auth_deleting: 70,
    completed: 80,
};

function deletionPhaseRank(phase: string): number {
    const rank = DELETION_PHASE_RANK[phase];
    if (rank === undefined) throw new Error('Deletion claim returned an unknown phase');
    return rank;
}

function firstRpcRow<T>(data: unknown): T | null {
    if (Array.isArray(data)) return (data[0] as T | undefined) ?? null;
    return data && typeof data === 'object' ? (data as T) : null;
}

async function requireRpc(
    admin: SupabaseClient,
    name: string,
    args: Record<string, unknown>,
    label: string,
): Promise<unknown> {
    const { data, error } = await admin.rpc(name, args);
    if (error) throw new Error(`${label}: ${error.message}`);
    return data;
}

async function advancePhase(
    admin: SupabaseClient,
    userId: string,
    leaseToken: string,
    phase: string,
): Promise<void> {
    await requireRpc(
        admin,
        'advance_account_deletion_phase',
        {
            p_user_id: userId,
            p_lease_token: leaseToken,
            p_phase: phase,
            p_lease_seconds: 300,
        },
        `Could not checkpoint ${phase}`,
    );
}

async function recordAppleState(
    admin: SupabaseClient,
    userId: string,
    leaseToken: string,
    state: Exclude<AppleRevocationState, 'pending'>,
    subjectSha256: string | null = null,
): Promise<void> {
    await requireRpc(
        admin,
        'record_account_deletion_apple_state',
        {
            p_user_id: userId,
            p_lease_token: leaseToken,
            p_state: state,
            p_apple_subject_sha256: subjectSha256,
        },
        'Could not checkpoint Apple revocation',
    );
}

function userHasAppleIdentity(user: {
    app_metadata?: Record<string, unknown>;
    identities?:
        | Array<{
            provider?: unknown;
            identity_id?: unknown;
            identity_data?: Record<string, unknown> | null;
        }>
        | null;
}): boolean {
    if (appleSubjectForAuthenticatedUser(user)) return true;
    const providers = user.app_metadata?.providers;
    return (
        user.app_metadata?.provider === 'apple' ||
        (Array.isArray(providers) && providers.some((provider) => provider === 'apple'))
    );
}

/**
 * Revoke a retained Apple refresh token before any account data is removed.
 * A pre-TN3194 Apple account may have no retained token; Apple requires those
 * users to be directed to manually remove the app's authorization, but their
 * deletion request must still be fulfilled.
 */
async function revokeAppleCredentialBeforeDeletion(
    admin: SupabaseClient,
    user: {
        id: string;
        app_metadata?: Record<string, unknown>;
        identities?:
            | Array<{
                provider?: unknown;
                identity_id?: unknown;
                identity_data?: Record<string, unknown> | null;
            }>
            | null;
    },
    leaseToken: string,
    durableState: AppleRevocationState,
): Promise<boolean> {
    if (durableState === 'complete' || durableState === 'not_applicable') return false;
    if (durableState === 'manual_required') return true;

    const legacyManualRevocationRequired = userHasAppleIdentity(user);
    const { data, error } = await admin
        .from('apple_sign_in_tokens')
        .select('refresh_token_ciphertext, refresh_token_iv, encryption_version, apple_subject_sha256')
        .eq('user_id', user.id)
        .maybeSingle();
    if (error) {
        throw new Error(`Could not load Apple revocation credential: ${error.message}`);
    }
    if (!data) {
        if (durableState === 'revoking') {
            throw new Error('Apple revocation credential disappeared during a resumable deletion');
        }
        await recordAppleState(
            admin,
            user.id,
            leaseToken,
            legacyManualRevocationRequired ? 'manual_required' : 'not_applicable',
        );
        return legacyManualRevocationRequired;
    }

    const row = data as StoredAppleToken;
    if (durableState === 'pending') {
        await recordAppleState(admin, user.id, leaseToken, 'revoking', row.apple_subject_sha256);
    }
    const appleConfig = await readAppleServerConfig();
    if (!appleConfig) throw new Error('Apple token revocation is not configured');
    const refreshToken = await decryptAppleRefreshToken(
        row.refresh_token_ciphertext,
        row.refresh_token_iv,
        row.encryption_version,
        appleConfig,
        user.id,
        row.apple_subject_sha256,
    );
    await revokeAppleRefreshToken(appleConfig, refreshToken);
    await recordAppleState(admin, user.id, leaseToken, 'complete', row.apple_subject_sha256);
    return false;
}

function storageManifestGateway(admin: SupabaseClient, userId: string): StorageManifestGateway {
    return {
        listPending: async (limit) => {
            const { data, error } = await admin
                .from('account_deletion_storage_items')
                .select('bucket_id, object_name')
                .eq('user_id', userId)
                .is('remove_requested_at', null)
                .order('bucket_id', { ascending: true })
                .order('object_name', { ascending: true })
                .limit(limit);
            return {
                data: Array.isArray(data)
                    ? data.map((item) => ({
                        bucketId: String(item.bucket_id),
                        objectName: String(item.object_name),
                    }))
                    : null,
                error,
            };
        },
        remove: async (bucket, paths) => await admin.storage.from(bucket).remove([...paths]),
        markRemoveRequested: async (items) => {
            const bucket = items[0]?.bucketId;
            if (!bucket || items.some((item) => item.bucketId !== bucket)) {
                return { data: null, error: { message: 'Storage checkpoint batch mixed buckets' } };
            }
            const { data, error } = await admin
                .from('account_deletion_storage_items')
                .update({ remove_requested_at: new Date().toISOString() })
                .eq('user_id', userId)
                .eq('bucket_id', bucket)
                .in(
                    'object_name',
                    items.map((item) => item.objectName),
                )
                .is('remove_requested_at', null)
                .select('bucket_id, object_name');
            return {
                data: Array.isArray(data)
                    ? data.map((item) => ({
                        bucketId: String(item.bucket_id),
                        objectName: String(item.object_name),
                    }))
                    : null,
                error,
            };
        },
    };
}

async function captureDrainAndVerifyStorage(
    admin: SupabaseClient,
    userId: string,
    leaseToken: string,
): Promise<{ complete: boolean; processed: number }> {
    await requireRpc(
        admin,
        'capture_account_deletion_storage',
        { p_user_id: userId, p_lease_token: leaseToken },
        'Could not capture account Storage manifest',
    );
    const drained = await drainExactStorageManifest(storageManifestGateway(admin, userId));
    if (!drained.complete) return drained;

    const verification = await requireRpc(
        admin,
        'verify_account_deletion_storage_empty',
        { p_user_id: userId, p_lease_token: leaseToken },
        'Could not verify account Storage cleanup',
    );
    const survivors = typeof verification === 'number' ? verification : Number(verification);
    if (!Number.isSafeInteger(survivors) || survivors < 0) {
        throw new Error('Account Storage verifier returned an invalid survivor count');
    }
    return { complete: survivors === 0, processed: drained.processed };
}

function deletionFailureCode(error: unknown): string {
    const message = error instanceof Error ? error.message.toLowerCase() : '';
    if (message.includes('apple')) return 'apple_revocation_failed';
    if (message.includes('storage')) return 'storage_cleanup_failed';
    if (message.includes('survivor') || message.includes('chart submission')) return 'survivor_scrub_failed';
    if (message.includes('delete account') || message.includes('auth')) return 'auth_deletion_failed';
    return 'account_deletion_failed';
}

async function recordFailure(
    admin: SupabaseClient,
    userId: string,
    leaseToken: string,
    code: string,
): Promise<void> {
    const { error } = await admin.rpc('record_account_deletion_failure', {
        p_user_id: userId,
        p_lease_token: leaseToken,
        p_error_code: code,
    });
    if (error) console.error('[delete-account] could not checkpoint failure:', error.message);
}

serve(async (req: Request) => {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (req.method !== 'POST') return json({ error: 'POST required' }, 405);

    const requestGate = await requireExactDeletionRequest(req, CONFIRMATION);
    if (!requestGate.ok) return json({ error: requestGate.error }, requestGate.status);
    const { authorization } = requestGate;

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !anonKey || !serviceRoleKey) {
        return json({ error: 'Account deletion is not configured' }, 503);
    }

    const caller = createClient(supabaseUrl, anonKey, {
        global: { headers: { Authorization: authorization } },
        auth: { persistSession: false, autoRefreshToken: false },
    });
    const user = await authenticateDeletionCaller(() => caller.auth.getUser());
    if (!user) return json({ error: 'Invalid or expired session' }, 401);

    const admin = createClient(supabaseUrl, serviceRoleKey, {
        auth: { persistSession: false, autoRefreshToken: false },
    });

    const leaseToken = crypto.randomUUID();
    let claim: DeletionClaim | null = null;
    try {
        const claimData = await requireRpc(
            admin,
            'claim_account_deletion',
            {
                p_user_id: user.id,
                p_lease_token: leaseToken,
                p_lease_seconds: 300,
            },
            'Could not start durable account deletion',
        );
        claim = firstRpcRow<DeletionClaim>(claimData);
        if (!claim) throw new Error('Deletion claim returned no verifiable state');
        if (claim.is_completed) {
            throw new Error('Deletion tombstone is complete while the authenticated user still exists');
        }
        if (!claim.acquired) {
            return json(
                {
                    deleted: false,
                    deletionInProgress: true,
                    phase: claim.current_phase,
                    message: 'Account deletion is already running. Wait a moment, then retry to confirm completion.',
                },
                202,
            );
        }
        const resumedPhaseRank = deletionPhaseRank(claim.current_phase);

        const result = await runAccountDeletionWorkflow({
            revokeAppleCredential: async () =>
                await revokeAppleCredentialBeforeDeletion(
                    admin,
                    user,
                    leaseToken,
                    claim!.current_apple_revocation_state,
                ),
            drainStorage: async () =>
                resumedPhaseRank >= DELETION_PHASE_RANK.storage_verified
                    ? { complete: true, processed: 0 }
                    : await captureDrainAndVerifyStorage(admin, user.id, leaseToken),
            scrubSurvivors: async () => {
                if (resumedPhaseRank >= DELETION_PHASE_RANK.ready_for_auth_delete) return;
                await advancePhase(admin, user.id, leaseToken, 'survivor_scrub');
                // This is the sole deliberately optional historical table. A
                // missing retired table is acceptable; every other cleanup is
                // performed and verified atomically by the database RPC.
                await requireDeletionMutation(
                    admin.from('enc_cell_submissions').delete().eq('owner_id', user.id),
                    'Could not delete chart submissions',
                    { allowMissingRetiredResource: true },
                );
                const scrubResult = await requireRpc(
                    admin,
                    'scrub_account_deletion_survivors',
                    { p_user_id: user.id, p_lease_token: leaseToken },
                    'Could not scrub and verify account survivors',
                );
                const scrub = scrubResult && typeof scrubResult === 'object'
                    ? (scrubResult as { verified?: unknown })
                    : null;
                if (scrub?.verified !== true) {
                    throw new Error('Account survivor scrub returned no verification');
                }
            },
            markAuthDeleting: async () => {
                if (resumedPhaseRank < DELETION_PHASE_RANK.auth_deleting) {
                    await advancePhase(admin, user.id, leaseToken, 'auth_deleting');
                }
            },
            deleteAuthUser: async () => {
                const { error: deleteError } = await admin.auth.admin.deleteUser(user.id, false);
                if (deleteError) throw new Error(`Could not delete account: ${deleteError.message}`);
            },
            completeDeletion: async () => {
                let lastError: Error | null = null;
                for (let attempt = 0; attempt < 3; attempt += 1) {
                    try {
                        await requireRpc(
                            admin,
                            'complete_account_deletion',
                            { p_user_id: user.id, p_lease_token: leaseToken },
                            'Could not complete account tombstone',
                        );
                        return;
                    } catch (error) {
                        lastError = error instanceof Error ? error : new Error(String(error));
                    }
                }
                throw lastError ?? new Error('Could not complete account tombstone');
            },
        });

        if (!result.deleted) {
            await recordFailure(admin, user.id, leaseToken, 'storage_cleanup_budget');
            return json(
                {
                    ...result,
                    message:
                        'Account deletion has started and is write-fenced. Some data may already be removed; retry to continue safely.',
                },
                202,
            );
        }
        return json(result);
    } catch (error) {
        console.error('[delete-account] deletion failed:', error);
        if (claim?.acquired) {
            await recordFailure(admin, user.id, leaseToken, deletionFailureCode(error));
        }
        return json(
            {
                error:
                    'Account deletion could not be confirmed complete. If it started, the account remains write-fenced and some data may already be removed. Retry to continue safely.',
                deletionInProgress: claim?.acquired === true,
                phase: claim?.current_phase ?? 'claim',
            },
            503,
        );
    }
});
