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
import {
    drainStoragePrefix,
    type RecipeMediaGateway,
    removeAllRecipePhotos,
    type StorageBucketGateway,
} from './storage-cleanup.ts';
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

async function removePrefix(admin: SupabaseClient, bucket: string, prefix: string): Promise<void> {
    const bucketClient = admin.storage.from(bucket);
    const storage: StorageBucketGateway = {
        list: async (path, options) => await bucketClient.list(path, options),
        remove: async (paths) => await bucketClient.remove([...paths]),
    };
    await drainStoragePrefix(storage, bucket, prefix);
}

async function removeRecipePhotos(admin: SupabaseClient, userId: string): Promise<void> {
    const recipePhotos = admin.storage.from('recipe-photos');
    const gateway: RecipeMediaGateway = {
        listOwnedRecipeIds: async (table, ownerId, afterId, limit) => {
            let query = admin
                .from(table)
                .select('id')
                .eq('user_id', ownerId)
                .order('id', { ascending: true })
                .limit(limit);
            if (afterId !== null) query = query.gt('id', afterId);
            return await query;
        },
        removeRecipePhotos: async (paths) => await recipePhotos.remove([...paths]),
        deleteOwnedRecipeRows: async (table, ownerId, ids) =>
            await admin.from(table).delete().eq('user_id', ownerId).in('id', [...ids]).select('id'),
    };
    await removeAllRecipePhotos(gateway, userId);
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
): Promise<boolean> {
    const legacyManualRevocationRequired = userHasAppleIdentity(user);
    const { data, error } = await admin
        .from('apple_sign_in_tokens')
        .select('refresh_token_ciphertext, refresh_token_iv, encryption_version, apple_subject_sha256')
        .eq('user_id', user.id)
        .maybeSingle();
    if (error) {
        throw new Error(`Could not load Apple revocation credential: ${error.message}`);
    }
    if (!data) return legacyManualRevocationRequired;

    const row = data as StoredAppleToken;
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
    return false;
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

    try {
        const userPrefixes = [
            ['chat-avatars', user.id],
            ['chat-avatars', `dating/${user.id}`],
            ['chat-avatars', `crew/${user.id}`],
            ['crew-list-photos', user.id],
            ['diary-photos', user.id],
            ['diary-audio', user.id],
            ['vessel_vault', user.id],
            ['marketplace-images', user.id],
            // Drain the whole owner folder independently of recipe rows so an
            // abandoned upload cannot survive account deletion.
            ['recipe-photos', user.id],
        ] as const;
        const cleanupOperations: Array<() => Promise<void>> = [
            ...userPrefixes.map(
                ([bucket, prefix]) => async () => {
                    await removePrefix(admin, bucket, prefix);
                },
            ),
            async () => await removeRecipePhotos(admin, user.id),
            // Shared user-generated content must disappear rather than merely
            // lose its owner id. Moderation/approval history is retained only
            // after removing direct identity and free-form audit details.
            async () =>
                await requireDeletionMutation(
                    admin.from('community_tracks').delete().eq('user_id', user.id),
                    'Could not delete shared tracks',
                ),
            async () =>
                await requireDeletionMutation(
                    admin.from('enc_cell_submissions').delete().eq('owner_id', user.id),
                    'Could not delete chart submissions',
                    { allowMissingRetiredResource: true },
                ),
            async () =>
                await requireDeletionMutation(
                    admin.from('guardian_alerts').delete().eq('source_user_id', user.id),
                    'Could not delete Guardian reports',
                ),
            async () =>
                await requireDeletionMutation(
                    admin.from('guardian_alerts').delete().eq('target_user_id', user.id),
                    'Could not delete Guardian alerts addressed to the account',
                ),
            ...(user.email
                ? [
                    async () =>
                        await requireDeletionMutation(
                            admin.from('manifest_invites').update({ email: null }).eq('email', user.email!),
                            'Could not redact manifest invitations addressed to the account',
                        ),
                ]
                : []),
            async () =>
                await requireDeletionMutation(
                    admin.from('chat_channels').delete().eq('proposed_by', user.id).eq('status', 'pending'),
                    'Could not delete pending channels',
                ),
            async () =>
                await requireDeletionMutation(
                    admin
                        .from('chat_channels')
                        .update({
                            proposed_by: null,
                            owner_id: null,
                            name: 'Archived community channel',
                            description: '',
                            region: null,
                            icon: '🌊',
                        })
                        .or(`proposed_by.eq.${user.id},owner_id.eq.${user.id}`),
                    'Could not anonymize active channels',
                ),
            async () =>
                await requireDeletionMutation(
                    admin
                        .from('admin_audit_log')
                        .update({ actor_id: null, details: { account_deleted: true } })
                        .eq('actor_id', user.id),
                    'Could not redact audit history',
                ),
        ];

        const result = await runAccountDeletionWorkflow({
            // Apple consent is revoked while the authenticated user and
            // encrypted credential still exist. Any failure prevents auth
            // deletion and leaves the account available.
            revokeAppleCredential: async () => await revokeAppleCredentialBeforeDeletion(admin, user),
            cleanupOperations,
            deleteAuthUser: async () => {
                const { error: deleteError } = await admin.auth.admin.deleteUser(user.id, false);
                if (deleteError) throw new Error(`Could not delete account: ${deleteError.message}`);
            },
        });
        return json(result);
    } catch (error) {
        console.error('[delete-account] deletion failed:', error);
        return json(
            {
                error: 'Account deletion could not be completed. Your account remains available; please retry.',
            },
            503,
        );
    }
});
