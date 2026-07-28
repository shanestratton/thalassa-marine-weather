/**
 * SocialAuthService — native Apple + Google sign-in for iOS.
 *
 * Wraps the two Capacitor plugins:
 *   - @capacitor-community/apple-sign-in  → native Apple Sign-In dialog
 *   - @codetrix-studio/capacitor-google-auth → native Google Sign-In flow
 *
 * Both plugins return an ID token (a JWT signed by Apple/Google).
 * We hand that token to Supabase via `signInWithIdToken`, which
 * verifies the signature against the provider's public keys and
 * creates (or fetches) the user in `auth.users`.
 *
 * Nonce handling differs by provider:
 *   - Apple: Supabase REQUIRES a nonce. We generate a raw random
 *     string, SHA-256 it, pass the *hash* to Apple's plugin (Apple
 *     includes that hash in the token's `nonce` claim), and pass
 *     the *raw* nonce to Supabase, which re-hashes and compares.
 *     This is the canonical Supabase Apple Sign-In pattern.
 *   - Google: we configured "Skip nonce checks" ON in Supabase's
 *     Google provider because the capacitor-google-auth plugin
 *     doesn't expose nonce control. No nonce sent.
 *
 * Returns the resulting Supabase Session on success, or throws an
 * Error with a user-friendly message that the SignInScreen can
 * surface.
 */

import { SignInWithApple, type SignInWithAppleResponse } from '@capacitor-community/apple-sign-in';
import { GoogleAuth } from '@codetrix-studio/capacitor-google-auth';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '../supabase';
import { createLogger } from '../../utils/createLogger';

const log = createLogger('SocialAuth');

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

    const { data, error } = await supabase.auth.signInWithIdToken({
        provider: 'apple',
        token: idToken,
        nonce: rawNonce,
    });

    if (error || !data.session) {
        log.warn('Supabase signInWithIdToken (apple) failed:', error?.message);
        throw new Error(error?.message ?? "Sign-in didn't complete on our end. Try again.");
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

// ── Google ─────────────────────────────────────────────────────
let googleInitialized = false;
async function ensureGoogleInitialized(): Promise<void> {
    if (googleInitialized) return;
    await GoogleAuth.initialize();
    googleInitialized = true;
}

/**
 * Open the native Google sign-in flow, mint a Supabase session
 * from the returned ID token. Supabase is configured with "Skip
 * nonce checks" for Google because the plugin doesn't expose nonce
 * control — the trade is documented at the top of this file.
 */
export async function signInWithGoogle(): Promise<Session> {
    if (!supabase) throw new Error('Supabase client unavailable.');

    await ensureGoogleInitialized();

    let googleResponse: Awaited<ReturnType<typeof GoogleAuth.signIn>>;
    try {
        googleResponse = await GoogleAuth.signIn();
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const code = nativeErrorCode(err);
        if (/cancel|popup_closed|user_cancel/i.test(msg) || /cancel|popup_closed|user_cancel/i.test(code)) {
            throw new Error('CANCELLED');
        }
        log.warn('Google signIn failed:', msg);
        throw new Error("Google Sign-In didn't complete. Try again or use another method.");
    }

    const idToken = googleResponse.authentication?.idToken;
    if (!idToken) {
        throw new Error('Google returned no identity token. Try again.');
    }

    const { data, error } = await supabase.auth.signInWithIdToken({
        provider: 'google',
        token: idToken,
    });

    if (error || !data.session) {
        log.warn('Supabase signInWithIdToken (google) failed:', error?.message);
        throw new Error(error?.message ?? "Sign-in didn't complete on our end. Try again.");
    }

    // Persist a friendly name on first sign-in. Google reliably
    // returns givenName + familyName on every sign-in (unlike Apple),
    // but we only overwrite if user_metadata is empty, so the user's
    // own edits in Settings always win.
    const givenName = googleResponse.givenName ?? null;
    const familyName = googleResponse.familyName ?? null;
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
 * Apple / Google sign-in in a plain browser.
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
 * is email OTP — and an account BORN from Apple/Google on the phone cannot use
 * it (GoTrue answers user_already_exists). So saved routes and vessel details,
 * both account-scoped, simply never arrive on the web planner.
 *
 * REQUIRES DASHBOARD CREDENTIALS THAT DO NOT EXIST YET. Until they are added
 * this will fail at the provider, by design, with a legible message rather than
 * a silent redirect to nowhere:
 *   - Google: a WEB OAuth client (the current provider has no client secret, so
 *     the authorization-code flow is impossible), with
 *     https://pcisdplnodrphauixcau.supabase.co/auth/v1/callback as an
 *     authorized redirect URI.
 *   - Apple: a SERVICES ID — the provider is currently configured with the app
 *     bundle id, which Apple will not accept for web — plus its generated
 *     secret.
 */
export async function signInWithProviderOnWeb(provider: 'apple' | 'google'): Promise<void> {
    if (!supabase) throw new Error('Sign-in is unavailable — no Supabase client.');

    // Return to the page the skipper actually came from, not a hardcoded root:
    // /plan is a standalone surface and bouncing a planner session back to the
    // dashboard would lose their place. search+hash are dropped deliberately —
    // Supabase appends its own, and a stale ?code= would confuse the return leg.
    const redirectTo = `${window.location.origin}${window.location.pathname}`;

    const { error } = await supabase.auth.signInWithOAuth({
        provider,
        options: {
            redirectTo,
            // Force the account chooser. Without it a browser already signed
            // into one Google account silently reuses it, which on a shared
            // chart-table laptop is the wrong boat's routes.
            queryParams: provider === 'google' ? { prompt: 'select_account' } : undefined,
        },
    });

    if (error) {
        log.warn(`[web-oauth] ${provider} sign-in failed:`, error);
        // Name the likely cause rather than echoing a raw provider string: the
        // overwhelmingly probable failure here is the missing dashboard
        // credential above, and "Unsupported provider" alone sends the reader
        // looking in the code.
        throw new Error(
            `${provider === 'apple' ? 'Apple' : 'Google'} sign-in is not available on the web yet ` +
                `(${error.message}). Use “Sign in with email” for now.`,
        );
    }
    // No return value: signInWithOAuth navigates away. Anything after this line
    // runs only if the redirect was blocked.
}

// ── Sign out (works for any provider) ──────────────────────────
export async function signOut(): Promise<void> {
    if (!supabase) return;
    // Also sign out of the Google plugin so the next sign-in shows the
    // account picker rather than silently reusing the previous account.
    try {
        await GoogleAuth.signOut();
    } catch {
        /* not initialized → fine */
    }
    await supabase.auth.signOut();
}
