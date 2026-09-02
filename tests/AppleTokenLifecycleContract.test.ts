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
        const shared = read('supabase/functions/_shared/apple-auth.ts');
        const authLookup = edge.indexOf('caller.auth.getUser()');
        const codeExchange = edge.indexOf('exchangeAppleAuthorizationCode(appleConfig, authorizationCode)');
        const subjectVerification = edge.indexOf(
            'verifyAppleIdTokenSubject(tokenExchange.idToken, appleConfig.clientId)',
        );
        const subjectMatch = edge.indexOf('exchangedSubject !== callerAppleSubject');

        expect(authLookup).toBeGreaterThan(-1);
        expect(codeExchange).toBeGreaterThan(authLookup);
        expect(subjectVerification).toBeGreaterThan(codeExchange);
        expect(subjectMatch).toBeGreaterThan(subjectVerification);
        expect(shared).toContain('const APPLE_TOKEN_URL = `${APPLE_ISSUER}/auth/token`');
        expect(shared).toContain("grant_type: 'authorization_code'");
        expect(shared).toContain('jwtVerify(idToken, APPLE_JWKS');
        expect(shared).toContain('issuer: APPLE_ISSUER');
        expect(shared).toContain("algorithms: ['RS256']");
    });

    it('encrypts refresh tokens with a dedicated AES-256-GCM secret before service-role persistence', () => {
        const edge = read('supabase/functions/register-apple-token/index.ts');
        const shared = read('supabase/functions/_shared/apple-auth.ts');
        const encrypted = edge.indexOf('await encryptAppleRefreshToken');
        const persisted = edge.indexOf("admin.from('apple_sign_in_tokens')");

        expect(encrypted).toBeGreaterThan(-1);
        expect(persisted).toBeGreaterThan(encrypted);
        expect(edge).toContain("Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')");
        expect(shared).toContain("Deno.env.get('APPLE_REFRESH_TOKEN_ENCRYPTION_KEY')");
        expect(shared).toContain("{ name: 'AES-GCM' }");
        expect(shared).toContain('rawEncryptionKey.byteLength !== 32');
        expect(shared).toContain('additionalData: toArrayBuffer(encryptionContext(userId, subjectSha256))');
        expect(edge).toContain('compensating revocation failed');
    });

    it('revokes a superseded refresh token and uses optimistic rotation so repeat sign-in cannot orphan credentials', () => {
        const edge = read('supabase/functions/register-apple-token/index.ts');

        expect(edge).toContain('await decryptAppleRefreshToken');
        expect(edge).toContain('if (previousRefreshToken !== refreshToken)');
        expect(edge).toContain('await revokeAppleRefreshToken(appleConfig, previousRefreshToken)');
        expect(edge).toContain(".eq('updated_at', previous.updated_at)");
        expect(edge).toContain('Apple token rotation conflict');
        expect(edge).toContain(".from('apple_sign_in_tokens').insert");
        expect(edge).toContain('const { data: concurrentWinner, error: winnerLookupError }');
        expect(edge).toContain('if (winnerRefreshToken === refreshToken)');
        expect(edge).toContain('refreshTokenNeedsCompensatingRevocation = false');
        expect(edge).not.toContain(".from('apple_sign_in_tokens').upsert");
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

    it('verifies Apple server JWS claims, queues destructive events, and runs the durable deletion processor', () => {
        const shared = read('supabase/functions/_shared/apple-auth.ts');
        const receiver = read('supabase/functions/apple-server-notification/index.ts');
        const deletion = read('supabase/functions/delete-account/index.ts');
        const queue = read('supabase/migrations/20260805091000_apple_server_notification_queue.sql');
        const config = read('supabase/config.toml');

        expect(shared).toContain('jwtVerify(signedPayload, APPLE_JWKS');
        expect(shared).toContain('audience: clientId');
        expect(shared).toContain("algorithms: ['RS256']");
        expect(receiver).toContain(".from('apple_server_notification_queue').upsert");
        expect(receiver).toContain("action: 'already_unlinked'");
        expect(receiver).toContain('if (!tokenOwner?.user_id)');
        expect(receiver).toContain('user_id: tokenOwner.user_id');
        expect(receiver).toContain("status: 'pending'");
        expect(receiver).toContain('`${supabaseUrl}/functions/v1/delete-account`');
        expect(receiver).toContain('appleNotificationJti: event.jti');
        expect(receiver).toContain("action: 'account_deleted'");
        expect(deletion).toContain('requireAccountDeletionRequest');
        expect(deletion).toContain(".from('apple_server_notification_queue')");
        expect(deletion).toContain('acknowledgeAppleCredentialAlreadyRevoked');
        expect(deletion).toContain('admin.auth.admin.getUserById');
        expect(receiver).not.toContain('auth.admin.deleteUser');
        expect(queue).toContain('ALTER TABLE public.apple_server_notification_queue FORCE ROW LEVEL SECURITY');
        expect(config).toMatch(/\[functions\.apple-server-notification\][\s\S]*?verify_jwt = false/);
    });
});
