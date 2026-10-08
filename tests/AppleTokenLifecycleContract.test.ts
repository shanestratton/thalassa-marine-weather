import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), 'utf8');

describe('Sign in with Apple TN3194 token lifecycle contract', () => {
    it('sends only the one-time authorization code after Supabase has authenticated the native ID token', () => {
        const client = read('services/auth/SocialAuthService.ts');
        const supabaseSignIn = client.indexOf('await supabase.auth.signInWithIdToken');
        const edgeRegistration = client.indexOf("supabase.functions.invoke('register-apple-token'");

        expect(supabaseSignIn).toBeGreaterThan(-1);
        expect(edgeRegistration).toBeGreaterThan(supabaseSignIn);
        expect(client).toContain('body: { authorizationCode }');
        expect(client).toContain("supabase.auth.signOut({ scope: 'local' })");
        expect(client).toContain("Apple Sign-In couldn't finish securely");
        expect(client).not.toContain('APPLE_SIGN_IN_PRIVATE_KEY');
        expect(client).not.toContain('APPLE_REFRESH_TOKEN_ENCRYPTION_KEY');
    });

    it('authenticates the Edge caller, exchanges the code directly with Apple, and identity-matches the signed response', () => {
        const edge = read('supabase/functions/register-apple-token/index.ts');
        const flow = read('supabase/functions/register-apple-token/registration.ts');
        const shared = read('supabase/functions/_shared/apple-auth.ts');
        const authLookup = edge.indexOf('caller.auth.getUser()');
        const registration = edge.indexOf('await registerAppleRefreshToken(authorizationCode, callerAppleSubject');
        const codeExchange = flow.indexOf('await deps.exchangeAuthorizationCode(authorizationCode)');
        const subjectVerification = flow.indexOf('await deps.verifyIdTokenSubject(tokenExchange.idToken)');
        const subjectMatch = flow.indexOf('exchangedSubject !== callerAppleSubject');
        const firstLookup = flow.indexOf('const stored = await deps.loadStoredTokenForUser()');

        expect(authLookup).toBeGreaterThan(-1);
        expect(registration).toBeGreaterThan(authLookup);
        expect(edge).toContain('exchangeAppleAuthorizationCode(appleConfig, authorizationCode)');
        expect(edge).toContain('verifyAppleIdTokenSubject(idToken, appleConfig.clientId)');
        expect(codeExchange).toBeGreaterThan(-1);
        expect(subjectVerification).toBeGreaterThan(codeExchange);
        expect(subjectMatch).toBeGreaterThan(subjectVerification);
        expect(firstLookup).toBeGreaterThan(subjectMatch);
        expect(shared).toContain('const APPLE_TOKEN_URL = `${APPLE_ISSUER}/auth/token`');
        expect(shared).toContain("grant_type: 'authorization_code'");
        expect(shared).toContain('jwtVerify(idToken, APPLE_JWKS');
        expect(shared).toContain('issuer: APPLE_ISSUER');
        expect(shared).toContain("algorithms: ['RS256']");
    });

    it('encrypts refresh tokens with a dedicated AES-256-GCM secret before service-role persistence', () => {
        const edge = read('supabase/functions/register-apple-token/index.ts');
        const flow = read('supabase/functions/register-apple-token/registration.ts');
        const shared = read('supabase/functions/_shared/apple-auth.ts');
        const encrypted = flow.indexOf('await deps.encryptRefreshToken(refreshToken, subjectSha256)');

        expect(encrypted).toBeGreaterThan(-1);
        expect(flow.indexOf('await deps.rotateStoredToken(')).toBeGreaterThan(encrypted);
        expect(flow.indexOf('await deps.insertStoredToken(')).toBeGreaterThan(encrypted);
        expect(edge).toContain('await encryptAppleRefreshToken(refreshToken, appleConfig, user.id, subjectSha256)');
        expect(edge).toContain("admin.from('apple_sign_in_tokens')");
        expect(edge).toContain("Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')");
        expect(shared).toContain("Deno.env.get('APPLE_REFRESH_TOKEN_ENCRYPTION_KEY')");
        expect(shared).toContain("{ name: 'AES-GCM' }");
        expect(shared).toContain('rawEncryptionKey.byteLength !== 32');
        expect(shared).toContain('additionalData: toArrayBuffer(encryptionContext(userId, subjectSha256))');
        expect(flow).toContain('compensating revocation failed');
    });

    it('never revokes on a repeat sign-in: rotation keeps the newest token, compensation runs only for an untracked first sign-in, and the concurrency loser never revokes', () => {
        // Apple's /auth/revoke ends the user's whole Sign in with Apple
        // authorization for the app, not just one token (Apple email to Shane,
        // 2026-10-08 11:00: "has revoked your Sign in with Apple").
        const edge = read('supabase/functions/register-apple-token/index.ts');
        const flow = read('supabase/functions/register-apple-token/registration.ts');
        const behaviour = read('supabase/functions/register-apple-token/registration_test.ts');

        // Nothing decrypts, compares, or revokes the previously stored token.
        expect(edge).not.toContain('decryptAppleRefreshToken');
        expect(flow).not.toContain('decryptAppleRefreshToken');
        expect(`${edge}${flow}`).not.toContain('previousRefreshToken');
        // One revocation primitive, reached from exactly two guarded call sites.
        expect(edge.match(/revokeAppleRefreshToken\(/g)).toHaveLength(1);
        expect(flow.match(/deps\.revokeRefreshToken\(/g)).toHaveLength(1);
        expect(flow.match(/await revokeUntrackedToken\(/g)).toHaveLength(2);
        expect(flow).toContain(
            'if (refreshToken && !authorizationTracked && isFirstAppleSignIn(appleIdentityLinkedAt, deps.now()))',
        );
        expect(flow).toContain('untracked = (await deps.loadStoredTokenForSubject(trackedSubject)) === null');
        expect(flow).toContain('if (!subjectTracked)');
        expect(edge).toContain('callerAppleSubject, appleIdentityLinkedAt(user)');
        // Optimistic rotation stays; the loser settles against the committed row.
        expect(flow).toContain('await deps.rotateStoredToken(stored.updatedAt, replacement)');
        expect(flow).toContain('return settleLostRace(await deps.loadStoredTokenForUser(), subjectSha256)');
        expect(flow).toContain('retryable: true');
        expect(edge).toContain(".eq('updated_at', expectedUpdatedAt)");
        expect(edge).toContain(".from('apple_sign_in_tokens').insert");
        expect(edge).not.toContain(".from('apple_sign_in_tokens').upsert");

        for (const name of [
            'a repeat sign-in rotates the stored token and never revokes',
            'the concurrency loser never revokes and succeeds when the winner holds the same Apple authorization',
            'the concurrency loser returns a retryable error without revoking when the winning row is gone',
            'a lost first-insert race never revokes the winner authorization',
            'compensating revocation runs only for a first Apple sign-in whose token nothing tracks',
            'an existing Apple account with no stored token is never revoked when registration fails',
            'a persistence failure never revokes while a token is stored for the user',
            'logs never carry the authorization code or a refresh token',
        ]) {
            expect(behaviour).toContain(`Deno.test('${name}'`);
        }
    });

    it('keeps ciphertext service-role-only and cascades it with the auth user', () => {
        const migration = read('supabase/migrations/20260805090000_apple_sign_in_token_lifecycle.sql');

        expect(migration).toMatch(/user_id UUID PRIMARY KEY REFERENCES auth\.users\(id\) ON DELETE CASCADE/);
        expect(migration).toContain('ALTER TABLE public.apple_sign_in_tokens ENABLE ROW LEVEL SECURITY');
        expect(migration).toContain('ALTER TABLE public.apple_sign_in_tokens FORCE ROW LEVEL SECURITY');
        expect(migration).toContain('apple_subject_sha256 TEXT NOT NULL UNIQUE');
        expect(migration).toContain('REVOKE ALL ON TABLE public.apple_sign_in_tokens FROM authenticated');
        expect(migration).toContain(
            'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.apple_sign_in_tokens TO service_role',
        );
        expect(migration).not.toMatch(/CREATE POLICY/i);
    });

    it('revokes retained Apple consent before auth deletion and flags legacy accounts without a token', () => {
        const deletion = read('supabase/functions/delete-account/index.ts');
        const workflow = read('supabase/functions/delete-account/workflow.ts');
        const revoke = deletion.lastIndexOf('await revokeAppleCredentialBeforeDeletion(');
        const authDelete = deletion.indexOf('admin.auth.admin.deleteUser');

        expect(revoke).toBeGreaterThan(-1);
        expect(authDelete).toBeGreaterThan(revoke);
        expect(deletion).toContain(".from('apple_sign_in_tokens')");
        expect(deletion).toContain('await revokeAppleRefreshToken(appleConfig, refreshToken)');
        expect(deletion).toContain("durableState === 'complete'");
        expect(deletion).toContain("await recordAppleState(admin, user.id, leaseToken, 'revoking'");
        expect(deletion).toContain("await recordAppleState(admin, user.id, leaseToken, 'complete'");
        expect(workflow).toContain("appleRevocationRequired ? 'manual_required'");
    });

    it('pins JWT verification for both authenticated lifecycle functions', () => {
        const config = read('supabase/config.toml');

        expect(config).toMatch(/\[functions\.register-apple-token\][\s\S]*?verify_jwt = true/);
        expect(config).toMatch(/\[functions\.delete-account\][\s\S]*?verify_jwt = true/);
    });

    it('keeps the native Apple door default-off until every external lifecycle gate is live', () => {
        const signIn = read('components/SignInScreen.tsx');

        expect(signIn).toContain(
            "const APPLE_NATIVE_SIGN_IN_ENABLED = import.meta.env.VITE_APPLE_SIGN_IN_ENABLED === 'true'",
        );
        expect(signIn).toContain('const appleNativeEnabled = isNative && APPLE_NATIVE_SIGN_IN_ENABLED');
        expect(signIn).toContain('{appleEnabled && (');
        expect(signIn).toContain('{!appleNativeEnabled && (');
        expect(signIn).toContain('Apple sign-in is not enabled in this beta build; use email.');

        const gate = read('scripts/check-beta-readiness.mjs');
        expect(gate).toContain("['.env', '.env.local', '.env.production', '.env.production.local']");
        expect(gate).toContain("process.env.VITE_APPLE_SIGN_IN_ENABLED !== 'true'");
        expect(gate).toContain('appleEnabledEnvFiles.length === 0');
    });

    it('observes native revocation, cold-checks Keychain identity, and rejects stale cross-account events', () => {
        const swift = read('ios/App/App/AppleCredentialStatePlugin.swift');
        const store = read('stores/authStore.ts');
        const bootstrap = read('hooks/useAppBootstrap.ts');

        expect(swift).toContain('ASAuthorizationAppleIDProvider.credentialRevokedNotification');
        expect(swift).toContain('getCredentialState(forUserID: userID)');
        expect(swift).toContain('retainUntilConsumed: true');
        expect(swift).toContain('kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly');
        expect(store).toContain('appleSubjects(currentUser).includes(appleUserId)');
        expect(store).toContain("supabase?.auth.signOut({ scope: 'local' })");
        expect(bootstrap).toContain('handleNativeAppleCredentialRevocation(event.userId)');
    });

    it('verifies Apple server JWS claims, queues account deletion, and runs the durable deletion processor', () => {
        const shared = read('supabase/functions/_shared/apple-auth.ts');
        const receiver = read('supabase/functions/apple-server-notification/index.ts');
        const flow = read('supabase/functions/apple-server-notification/notification.ts');
        const deletion = read('supabase/functions/delete-account/index.ts');
        const queue = read('supabase/migrations/20260805091000_apple_server_notification_queue.sql');
        const config = read('supabase/config.toml');

        expect(shared).toContain('jwtVerify(signedPayload, APPLE_JWKS');
        expect(shared).toContain('audience: clientId');
        expect(shared).toContain("algorithms: ['RS256']");
        expect(receiver).toContain('await handleVerifiedAppleNotification(event, {');
        expect(receiver).toContain(".from('apple_server_notification_queue').upsert");
        expect(receiver).toContain("status: 'pending'");
        expect(receiver).toContain('`${supabaseUrl}/functions/v1/delete-account`');
        expect(receiver).toContain('body: JSON.stringify({ appleNotificationJti: jti })');
        expect(flow).toContain("action: 'already_unlinked'");
        expect(flow).toContain('if (!owner)');
        expect(flow).toContain('user_id: owner.userId');
        expect(flow).toContain('await deps.runAccountDeletion(event.jti)');
        expect(flow).toContain("action: 'account_deleted'");
        expect(deletion).toContain('requireAccountDeletionRequest');
        expect(deletion).toContain(".from('apple_server_notification_queue')");
        expect(deletion).toContain('acknowledgeAppleCredentialAlreadyRevoked');
        expect(deletion).toContain('admin.auth.admin.getUserById');
        expect(receiver).not.toContain('auth.admin.deleteUser');
        expect(flow).not.toContain('auth.admin.deleteUser');
        expect(queue).toContain('ALTER TABLE public.apple_server_notification_queue FORCE ROW LEVEL SECURITY');
        expect(config).toMatch(/\[functions\.apple-server-notification\][\s\S]*?verify_jwt = false/);
    });

    it('treats consent-revoked as a sign-out, never an account deletion, and ignores events older than the latest sign-in', () => {
        // developer.apple.com, "Processing changes for Sign in with Apple
        // accounts": consent-revoked = "The user revokes consent for your app to
        // use their Apple Account and their credentials become invalid";
        // account-deleted = "The user requests that Apple permanently delete
        // their Apple Account".
        const shared = read('supabase/functions/_shared/apple-auth.ts');
        const receiver = read('supabase/functions/apple-server-notification/index.ts');
        const signOut = read('supabase/functions/apple-server-notification/sign-out.ts');
        const flow = read('supabase/functions/apple-server-notification/notification.ts');
        const behaviour = read('supabase/functions/apple-server-notification/notification_test.ts');
        const deletion = read('supabase/functions/delete-account/index.ts');

        const consentStart = flow.indexOf("if (event.eventType === 'consent-revoked')");
        const consentEnd = flow.indexOf("action: 'signed_out'");
        expect(consentStart).toBeGreaterThan(-1);
        expect(consentEnd).toBeGreaterThan(consentStart);
        const consentBranch = flow.slice(consentStart, consentEnd);
        // TN3194: Apple's consent-revoked also follows our own deletion-time
        // revoke, so an in-progress deletion keeps its token row and sessions.
        const deletionCheck = consentBranch.indexOf('await deps.accountDeletionInProgress(owner.userId)');
        expect(deletionCheck).toBeGreaterThan(-1);
        expect(deletionCheck).toBeLessThan(consentBranch.indexOf('await deps.signOutUserSessions('));
        expect(consentBranch).toContain("action: 'deletion_in_progress'");
        expect(receiver).toContain(".from('account_deletion_jobs')");
        expect(consentBranch).toContain('await deps.signOutUserSessions(owner.userId, event.eventTime)');
        expect(consentBranch).toContain(
            'await deps.deleteStoredAppleToken(owner.userId, subjectSha256, owner.updatedAt)',
        );
        expect(consentBranch).not.toContain('queueAccountDeletion');
        expect(consentBranch).not.toContain('runAccountDeletion');
        expect(flow).toContain("event_type: 'account-deleted'");

        const staleCheck = flow.indexOf('event.eventTime.getTime() < latestSignInMs');
        expect(staleCheck).toBeGreaterThan(-1);
        expect(flow).toContain("action: 'stale_event_ignored'");
        expect(staleCheck).toBeLessThan(consentStart);
        expect(staleCheck).toBeLessThan(flow.indexOf('await deps.queueAccountDeletion('));

        expect(receiver).toContain('signOutUserSessions: (userId, startedAtOrBefore) =>');
        expect(receiver).toContain(".eq('updated_at', expectedUpdatedAt)");
        expect(signOut).toContain('DELETE FROM auth.sessions');
        expect(signOut).toContain('created_at <=');
        expect(signOut).not.toMatch(/console\.(log|info|debug)/);

        // Apple's documented name is account-deleted; the older account-delete
        // spelling is accepted as the same event.
        expect(shared).toContain("'account-delete': 'account-deleted'");
        // Apple's servers send the events claim as a JSON-encoded string (the
        // documentation example shows an object); both forms are read.
        expect(shared).toContain('const events = parseAppleEventsClaim(payload.events)');
        expect(shared).toContain('events = JSON.parse(events)');
        expect(shared).toContain('return readAppleServerNotificationClaims(payload)');

        // The destructive processor refuses any queued event that is not an
        // Apple Account deletion, before it resolves a user to delete.
        const guard = deletion.indexOf("if (queued.event_type !== 'account-deleted')");
        expect(guard).toBeGreaterThan(-1);
        expect(guard).toBeLessThan(deletion.indexOf('admin.auth.admin.getUserById'));

        for (const name of [
            'consent-revoked signs the user out and drops the stored Apple token without deleting the account',
            'consent-revoked during an account deletion leaves the token row and sessions to the deletion',
            'account-deleted is queued and processed through account deletion as before',
            'an event older than the latest sign-in is acknowledged and ignored',
            'a failed sign-out keeps the stored token so Apple can retry',
        ]) {
            expect(behaviour).toContain(`Deno.test('${name}'`);
        }
        const claimBehaviour = read('supabase/functions/_shared/apple-auth_test.ts');
        for (const name of [
            'the events claim is read when Apple sends it as a JSON-encoded string',
            'the events claim is read in the object form shown in Apple documentation',
            'a 13-digit millisecond event_time is the same instant as its seconds form',
        ]) {
            expect(claimBehaviour).toContain(`Deno.test('${name}'`);
        }
    });
});
