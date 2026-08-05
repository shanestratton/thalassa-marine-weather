import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), 'utf8');

describe('public-beta account deletion contract', () => {
    it('tolerates PostgREST schema-cache wording for optional retired tables', () => {
        const edge = read('supabase/functions/delete-account/index.ts');
        const cleanup = read('supabase/functions/delete-account/storage-cleanup.ts');

        expect(cleanup).toContain('could not find (?:the )?(?:table|relation)');
        expect(edge).toContain('{ allowMissingRetiredResource: true }');
        expect(edge.match(/allowMissingRetiredResource/g)).toHaveLength(1);
    });

    it('authenticates the caller, keeps service-role access server-side, removes UGC/media, and deletes auth last', () => {
        const edge = read('supabase/functions/delete-account/index.ts');
        const workflow = read('supabase/functions/delete-account/workflow.ts');
        const ci = read('.github/workflows/ci.yml');
        const authLookup = edge.indexOf('caller.auth.getUser()');
        const storageCleanup = edge.indexOf('await removeRecipePhotos');
        const authDeletion = edge.indexOf('admin.auth.admin.deleteUser');

        expect(edge).toContain("const CONFIRMATION = 'DELETE'");
        expect(edge).toContain("Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')");
        expect(edge).toContain("['diary-photos', user.id]");
        expect(edge).toContain("['diary-audio', user.id]");
        expect(edge).toContain("['vessel_vault', user.id]");
        expect(edge).toContain("['chat-avatars', `crew/${user.id}`]");
        expect(edge).toContain("admin.from('community_tracks').delete()");
        expect(edge).toContain("admin.from('enc_cell_submissions').delete()");
        expect(edge).toContain("admin.from('guardian_alerts').delete().eq('target_user_id', user.id)");
        expect(edge).toContain("admin.from('manifest_invites').update({ email: null })");
        expect(authLookup).toBeGreaterThan(-1);
        expect(storageCleanup).toBeGreaterThan(authLookup);
        expect(authDeletion).toBeGreaterThan(storageCleanup);
        expect(workflow).toContain('for (const cleanup of dependencies.cleanupOperations) await cleanup()');
        expect(workflow.indexOf('await dependencies.deleteAuthUser()')).toBeGreaterThan(
            workflow.indexOf('dependencies.cleanupOperations'),
        );
        expect(ci).toContain('deno test */*_test.ts');
    });

    it('exhaustively drains account storage without an object-count ceiling', () => {
        const edge = read('supabase/functions/delete-account/index.ts');
        const cleanup = read('supabase/functions/delete-account/storage-cleanup.ts');

        expect(edge).not.toContain('MAX_STORAGE_OBJECTS');
        expect(cleanup).not.toContain('MAX_STORAGE_OBJECTS');
        expect(cleanup).toContain('export async function drainStoragePrefix');
        expect(cleanup).toContain('offset: 0');
        expect(cleanup).toContain('STORAGE_REMOVE_BATCH_SIZE');
        expect(cleanup).toContain('Storage cleanup made no progress');
        expect(edge).toContain("['recipe-photos', user.id]");
    });

    it('durably drains both required recipe tables and fails before auth deletion when cleanup fails', () => {
        const edge = read('supabase/functions/delete-account/index.ts');
        const cleanup = read('supabase/functions/delete-account/storage-cleanup.ts');
        const cleanupCall = edge.indexOf('await removeRecipePhotos(admin, user.id)');
        const authDeletion = edge.indexOf('admin.auth.admin.deleteUser');

        expect(cleanup).toContain("for (const table of ['recipes', 'community_recipes'] as const)");
        expect(cleanup).toContain('afterId: string | null');
        expect(cleanup).toContain('deleteOwnedRecipeRows');
        expect(cleanup).toContain('`${userId}/${id}.jpg`');
        expect(cleanup).toContain('`${id}.jpg`');
        expect(cleanup).toContain('throw new Error(`Could not remove recipe media: ${error.message}`)');
        expect(cleanupCall).toBeGreaterThan(-1);
        expect(authDeletion).toBeGreaterThan(cleanupCall);
    });

    it('bounds hosted cleanup invocations while preserving durable retry progress', () => {
        const cleanup = read('supabase/functions/delete-account/storage-cleanup.ts');

        expect(cleanup).toContain('MAX_STORAGE_LIST_PASSES_PER_INVOCATION');
        expect(cleanup).toContain('MAX_RECIPE_PAGES_PER_TABLE_PER_INVOCATION');
        expect(cleanup).toContain('cleanup invocation budget reached; retry to resume');
        expect(cleanup).toContain('await deleteProcessedRecipeRows');
    });

    it('fails closed when a required cleanup table is absent or missing from the schema cache', () => {
        const edge = read('supabase/functions/delete-account/index.ts');
        const workflow = read('supabase/functions/delete-account/workflow.ts');

        expect(edge).toContain('requireDeletionMutation');
        expect(workflow).toContain('if (options.allowMissingRetiredResource && isMissingResource(error.message))');
        expect(workflow).toContain('throw new Error(`${label}: ${error.message}`)');
    });

    it('makes all formerly blocking identity relationships release or cascade on auth deletion', () => {
        const migration = read('supabase/migrations/20260804190000_account_deletion_support.sql');

        expect(migration).toMatch(/manifest_invites_accepted_by_fkey[\s\S]*ON DELETE SET NULL/);
        expect(migration).toMatch(/watch_assignments_assigned_by_fkey[\s\S]*ON DELETE SET NULL/);
        expect(migration).toMatch(/voyages_weather_master_id_fkey[\s\S]*ON DELETE SET NULL/);
        expect(migration).toMatch(/guardian_alerts_source_user_id_fkey[\s\S]*ON DELETE CASCADE/);
        expect(migration).toMatch(/guardian_alerts_target_user_id_fkey[\s\S]*ON DELETE CASCADE/);
        expect(migration).toMatch(/admin_audit_log_actor_id_fkey[\s\S]*ON DELETE SET NULL/);
    });

    it('holds production deletion before UI/service mutation while retaining the reviewed implementation', () => {
        const accountTab = read('components/settings/AccountTab.tsx');
        const dialog = read('components/settings/DeleteAccountDialog.tsx');
        const service = read('services/accountDeletion.ts');
        const boundary = read('services/accountDeletionPublicBetaBoundary.ts');
        const profile = JSON.parse(read('config/public-beta-features.json')) as {
            featureFlags: Record<string, boolean>;
            heldCapabilities: string[];
        };
        const deleteBody = service.slice(service.indexOf('export async function deleteCurrentAccount'));
        const hold = deleteBody.indexOf('if (!ACCOUNT_DELETION_PUBLIC_BETA_ENABLED)');
        const confirmation = deleteBody.indexOf('confirmation !== ACCOUNT_DELETION_CONFIRMATION');
        const invocation = deleteBody.indexOf("supabase.functions.invoke('delete-account'");

        expect(profile.featureFlags.VITE_ACCOUNT_DELETION_ENABLED).toBe(false);
        expect(profile.heldCapabilities).toContain('account-deletion');
        expect(boundary).toContain("import.meta.env.VITE_ACCOUNT_DELETION_ENABLED === 'true'");
        expect(boundary).toContain("ACCOUNT_DELETION_PRIVACY_EMAIL = 'privacy@thalassa.app'");
        expect(hold).toBeGreaterThan(-1);
        expect(hold).toBeLessThan(confirmation);
        expect(hold).toBeLessThan(invocation);
        expect(accountTab).toContain('ACCOUNT_DELETION_PUBLIC_BETA_ENABLED ? (');
        expect(accountTab).toContain('Account deletion temporarily unavailable');
        expect(accountTab).toContain('ACCOUNT_DELETION_PRIVACY_MAILTO');
        expect(accountTab).toContain('Delete Account and Data');
        expect(dialog).toContain('role="alertdialog"');
        expect(dialog).toContain('ACCOUNT_DELETION_CONFIRMATION');
        expect(service).toContain('purgeLocalDatabaseForUser(userId)');
        expect(service).toContain('Preferences.keys()');
        expect(service).toContain("supabase.auth.signOut({ scope: 'local' })");
        expect(service).toContain('PushNotificationService.clearUser()');
    });
});
