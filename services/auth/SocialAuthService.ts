/**
 * SocialAuthService — Sign in with Apple for iOS and the web.
 *
 * Wraps @capacitor-community/apple-sign-in for the native Apple
 * Sign-In dialog.
 *
 * The plugin returns an ID token (a JWT signed by Apple).
 * We hand that token to Supabase via `signInWithIdToken`, which
 * verifies the signature against the provider's public keys and
 * creates (or fetches) the user in `auth.users`.
 *
 * Apple also returns a one-time authorization code. Only AFTER Supabase has
 * authenticated the ID token do we send that code to our authenticated Edge
 * Function. The server exchanges it directly with Apple, identity-matches the
 * response, and stores the resulting refresh token encrypted for account
 * deletion revocation (TN3194). No Apple key or refresh token reaches this
 * client. If that registration fails, the new local session is discarded.
 *
 * Supabase requires a nonce for Apple. We generate a raw random
 *     string, SHA-256 it, pass the *hash* to Apple's plugin (Apple
 *     includes that hash in the token's `nonce` claim), and pass
 *     the *raw* nonce to Supabase, which re-hashes and compares.
 * This is the canonical Supabase Apple Sign-In pattern.
 *
 * Returns the resulting Supabase Session on success, or throws an
 * Error with a user-friendly message that the SignInScreen can
 * surface.
 */

import { SignInWithApple, type SignInWithAppleResponse } from '@capacitor-community/apple-sign-in';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '../supabase';
import { createLogger } from '../../utils/createLogger';
import { bindAppleCredentialUser, clearBoundAppleCredential } from './appleCredentialState';

const log = createLogger('SocialAuth');

/**
 * Browser Apple OAuth has its own release boundary. It is deliberately
 * independent from VITE_APPLE_SIGN_IN_ENABLED: that flag controls the native
 * capability/entitlement and was enabled only after the TN3194 native release
 * checklist completed. The web lane uses the separately configured Apple
 * Services ID and Supabase callback and can still be re-held independently.
 */
export const APPLE_WEB_SIGN_IN_ENABLED = import.meta.env.VITE_APPLE_WEB_SIGN_IN_ENABLED === 'true';

// The iOS bundle ID — matches the `aud` claim Apple includes in its
// ID token, and matches the Client ID we registered in Supabase.
const APPLE_CLIENT_ID = 'com.thalassa.weather';

// ── Nonce helpers ──────────────────────────────────────────────
/** 32-byte random hex string. Random enough to be one-shot. */
function randomNonce(): string {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
}

/** SHA-256 hex digest of a string — what we pass to Apple's plugin. */
async function sha256Hex(input: string): Promise<string> {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
    return Array.from(new Uint8Array(buf))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
}

function nativeErrorCode(error: unknown): string {
    if (!error || typeof error !== 'object' || !('code' in error)) return '';
    return String((error as { code?: unknown }).code ?? '');
}

async function discardUnsecuredAppleSession(): Promise<void> {
    if (!supabase) return;
    await clearBoundAppleCredential().catch((error) => {
        log.warn(
            'Could not clear the unsecured Apple credential binding:',
            error instanceof Error ? error.message : 'unknown error',
        );
    });
    try {
        const { error } = await supabase.auth.signOut({ scope: 'local' });
        if (error) log.warn('Could not discard the unsecured Apple session:', error.message);
    } catch (error) {
        log.warn(
            'Could not discard the unsecured Apple session:',
            error instanceof Error ? error.message : 'unknown error',
        );
    }
}

// ── Apple ──────────────────────────────────────────────────────
/**
 * Open the native Sign in with Apple dialog, mint a Supabase
 * session from the returned ID token.
 *
 * On first sign-in Apple returns the user's name + email. On
 * subsequent sign-ins it returns ONLY the user ID — so if we ever
 * need a display name, we have to capture it on the first auth.
 * The user_metadata write here handles that.
 */
export async function signInWithApple(): Promise<Session> {
    if (!supabase) throw new Error('Supabase client unavailable.');

    const rawNonce = randomNonce();
    const hashedNonce = await sha256Hex(rawNonce);

    let appleResponse: SignInWithAppleResponse;
    try {
        appleResponse = await SignInWithApple.authorize({
            clientId: APPLE_CLIENT_ID,
            redirectURI: '', // unused for native flow
            scopes: 'email name',
            state: '',
            nonce: hashedNonce,
        });
    } catch (err) {
        // User cancelled the system sheet → friendly silent return.
        // Plugin throws a CapacitorException with code 1000/1001 on cancel.
        const msg = err instanceof Error ? err.message : String(err);
        const code = nativeErrorCode(err);
        if (/cancel/i.test(msg) || /1000|1001/.test(msg) || /1000|1001/.test(code)) {
            throw new Error('CANCELLED');
        }
        log.warn('Apple authorize failed:', msg);
        throw new Error("Apple Sign-In didn't complete. Try again or use another method.");
    }

    const idToken = appleResponse.response?.identityToken;
    if (!idToken) {
        throw new Error('Apple returned no identity token. Try again.');
    }
    const authorizationCode = appleResponse.response?.authorizationCode;
    if (!authorizationCode) {
        throw new Error('Apple returned no authorization code. Try again.');
    }
    const appleUserId = appleResponse.response?.user;
    if (!appleUserId) {
        throw new Error('Apple returned no user identifier. Try again.');
    }

    const { data, error } = await supabase.auth.signInWithIdToken({
        provider: 'apple',
        token: idToken,
        nonce: rawNonce,
    });

    if (error || !data.session) {
        log.warn('Supabase signInWithIdToken (apple) failed:', error?.message);
        throw new Error(error?.message ?? "Sign-in didn't complete on our end. Try again.");
    }

    // Secure and verify the opaque Apple user binding before consuming the
    // one-time authorization code. This remains after Supabase auth, and means
    // a Keychain failure cannot leave a server-side refresh token for a sign-in
    // the client reports as failed.
    try {
        await bindAppleCredentialUser(appleUserId);
    } catch (bindingError) {
        log.warn(
            'Native Apple credential-state binding failed:',
            bindingError instanceof Error ? bindingError.message : 'unknown error',
        );
        await discardUnsecuredAppleSession();
        throw new Error("Apple Sign-In couldn't finish securely. Please try again.");
    }

    // TN3194 lifecycle registration is intentionally after authenticated
    // Supabase sign-in: the Edge Function requires this new user's access
    // token and independently matches Apple's returned subject to that user.
    const { data: registration, error: registrationError } = await supabase.functions.invoke('register-apple-token', {
        body: { authorizationCode },
    });
    if (registrationError || registration?.registered !== true) {
        log.warn('Server-side Apple token registration failed:', registrationError?.message ?? 'invalid response');
        await discardUnsecuredAppleSession();
        throw new Error("Apple Sign-In couldn't finish securely. Please try again.");
    }

    // Persist name parts to user_metadata on FIRST sign-in only — Apple
    // never returns these again. The Voyage Log byline reads them.
    const givenName = appleResponse.response?.givenName ?? null;
    const familyName = appleResponse.response?.familyName ?? null;
    if (givenName || familyName) {
        const existingMeta = data.session.user.user_metadata as { first_name?: string };
        if (!existingMeta?.first_name) {
            await supabase.auth.updateUser({
                data: {
                    first_name: givenName ?? undefined,
                    last_name: familyName ?? undefined,
                },
            });
        }
    }

    return data.session;
}

// ── Browser lane ───────────────────────────────────────────────
/**
 * Apple sign-in in a plain browser.
 *
 * A DIFFERENT MECHANISM to the native functions above, not a fallback. Native
 * uses signInWithIdToken: the plugin opens a system dialog, returns a signed ID
 * token, and we hand that straight to Supabase — one call, no navigation. A
 * browser has no such plugin, so it must use the OAuth authorization-code flow:
 * redirect to the provider, come back to Supabase's /auth/v1/callback, then
 * back here with a session. That is why this returns void rather than a
 * Session — the page unloads mid-flow and the session is picked up by
 * detectSessionInUrl on the return leg.
 *
 * WHY IT MATTERS (Shane, flagged VERY IMPORTANT 2026-07-09, deferred twice):
 * the web /plan planner is signed-in-gated. Without this, a browser's only lane
 * is email OTP — and an account born from Apple on the phone cannot use
 * it (GoTrue answers user_already_exists). So saved routes and vessel details,
 * both account-scoped, simply never arrive on the web planner.
 *
 * The browser lane is released only when its dedicated build flag agrees with
 * the configured Apple Services ID and Supabase OAuth secret. Keeping that
 * separate from the native flag prevents a website release from silently
 * claiming the iOS entitlement.
 */
export async function signInWithAppleOnWeb(): Promise<void> {
    if (!supabase) throw new Error('Sign-in is unavailable — no Supabase client.');
    if (!APPLE_WEB_SIGN_IN_ENABLED) {
        throw new Error('Apple sign-in is not enabled on the web. Use email instead.');
    }

    // Return to the page the skipper actually came from, not a hardcoded root:
    // /plan is a standalone surface and bouncing a planner session back to the
    // dashboard would lose their place. search+hash are dropped deliberately —
    // Supabase appends its own, and a stale ?code= would confuse the return leg.
    const redirectTo = `${window.location.origin}${window.location.pathname}`;

    const { error } = await supabase.auth.signInWithOAuth({
        provider: 'apple',
        options: {
            redirectTo,
        },
    });

    if (error) {
        log.warn('[web-oauth] Apple sign-in failed:', error);
        // Name the likely cause rather than echoing a raw provider string: the
        // overwhelmingly probable failure here is the missing dashboard
        // credential above, and "Unsupported provider" alone sends the reader
        // looking in the code.
        throw new Error(
            `Apple sign-in is not available on the web yet (${error.message}). ` + 'Use “Sign in with email” for now.',
        );
    }
    // No return value: signInWithOAuth navigates away. Anything after this line
    // runs only if the redirect was blocked.
}

// ── Sign out (works for any provider) ──────────────────────────
export async function signOut(): Promise<void> {
    if (!supabase) return;
    await supabase.auth.signOut();
}
