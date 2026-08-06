/**
 * Sign in with Google — native (PKCE) and web (OAuth redirect).
 *
 * Why this is not built on services/voice/integrations/gmail.ts
 * ────────────────────────────────────────────────────────────
 * That module solves the opposite problem. It connects a Google account to an
 * ALREADY SIGNED-IN user, so every key it touches is account-scoped through
 * `getAuthIdentityScope().userId` — which is null at sign-in time, by
 * definition. Reusing it would mean weakening that scoping for the one caller
 * that must not have it. The PKCE mechanics are ~40 lines, so this file owns
 * its own, and the two never share storage.
 *
 * Native flow (iOS)
 * ─────────────────
 *   1. Generate a PKCE verifier, a CSRF `state`, and a `nonce`.
 *   2. Open Google's consent screen in the system browser (@capacitor/browser).
 *   3. Google redirects to the reversed-client-ID scheme, caught by a one-shot
 *      `appUrlOpen` listener owned by this call — so the caller just awaits a
 *      promise instead of wiring redirect plumbing into the sign-in screen.
 *   4. Exchange the code for tokens, take the `id_token`, and hand it to
 *      Supabase's `signInWithIdToken`, which verifies it against Google's
 *      public keys.
 *
 * NONCE, and how it differs from Apple. Apple's plugin wants the SHA-256 of
 * the nonce and echoes that hash in the token claim, so SocialAuthService
 * sends Apple the hash and Supabase the raw value. Google echoes the nonce
 * VERBATIM, so the same raw string goes to both. Sending Google a hash the way
 * Apple wants it would produce a token whose claim never matches what Supabase
 * is told to expect, and every sign-in would fail validation.
 *
 * No client secret: an iOS bundle is a public client by Google's
 * classification, so PKCE is the correct primitive and there is nothing here
 * worth extracting from the binary.
 *
 * Nothing is persisted. The verifier, state and nonce live for the duration of
 * one call and die with it — a half-finished sign-in leaves no residue.
 */

import { App, type URLOpenListenerEvent } from '@capacitor/app';
import { Browser } from '@capacitor/browser';
import { Capacitor } from '@capacitor/core';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '../supabase';
import { createLogger } from '../../utils/createLogger';

const log = createLogger('GoogleSignIn');

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

/** Identity only. No Gmail, Drive or Calendar scope belongs in a sign-in. */
const SCOPES = 'openid email profile';

/** How long to wait for the user to finish at Google before giving up. */
const REDIRECT_TIMEOUT_MS = 5 * 60 * 1000;

const GOOGLE_OAUTH_CLIENT_ID =
    (typeof import.meta !== 'undefined' && import.meta.env?.VITE_GOOGLE_OAUTH_CLIENT_ID) || '';

/**
 * Off unless explicitly switched on. Turning this on without the Supabase
 * Google provider configured produces a button that fails at Google, which is
 * worse than no button — so the default is the honest one.
 */
export const GOOGLE_SIGN_IN_ENABLED =
    import.meta.env.VITE_GOOGLE_SIGN_IN_ENABLED === 'true' && GOOGLE_OAUTH_CLIENT_ID !== '';

// ── PKCE / redirect helpers ────────────────────────────────────────

function randomUrlSafe(bytes = 32): string {
    const raw = new Uint8Array(bytes);
    crypto.getRandomValues(raw);
    return Array.from(raw, (b) => b.toString(16).padStart(2, '0')).join('');
}

function base64UrlEncode(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function codeChallengeOf(verifier: string): Promise<string> {
    return base64UrlEncode(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
}

/**
 * `com.googleusercontent.apps.<id>` — Google's iOS convention. Note the single
 * slash in the redirect below: `scheme:/path`, not `scheme://path`, which is
 * what Google's iOS clients expect and what gmail.ts already uses.
 */
function reversedClientIdScheme(): string {
    if (!GOOGLE_OAUTH_CLIENT_ID) return '';
    return `com.googleusercontent.apps.${GOOGLE_OAUTH_CLIENT_ID.replace(/\.apps\.googleusercontent\.com$/, '')}`;
}

function nativeRedirectUri(): string {
    const scheme = reversedClientIdScheme();
    return scheme ? `${scheme}:/oauth2redirect` : '';
}

/**
 * Wait for Google to hand control back to the app.
 *
 * Owns its listener and always removes it — including on timeout and on the
 * user simply closing the browser — so a cancelled sign-in cannot leave a
 * listener behind that hijacks an unrelated deep link later.
 */
async function awaitRedirect(expectedState: string): Promise<string> {
    const redirectPrefix = nativeRedirectUri();

    return new Promise<string>((resolve, reject) => {
        let settled = false;
        let urlHandle: { remove: () => Promise<void> } | undefined;
        let closeHandle: { remove: () => Promise<void> } | undefined;
        const finish = (fn: () => void) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            void urlHandle?.remove().catch(() => undefined);
            void closeHandle?.remove().catch(() => undefined);
            void Browser.close().catch(() => undefined);
            fn();
        };

        // Backstop: the skipper walks away mid-consent. Without this the
        // promise — and the sign-in screen's spinner — would live forever.
        const timer = setTimeout(() => finish(() => reject(new Error('CANCELLED'))), REDIRECT_TIMEOUT_MS);

        void App.addListener('appUrlOpen', (event: URLOpenListenerEvent) => {
            // Ignore deep links that are not this flow's redirect — the app
            // handles others, and consuming them here would break them.
            if (!redirectPrefix || !event.url?.startsWith(redirectPrefix)) return;

            let params: URLSearchParams;
            try {
                params = new URL(event.url.replace(':/', '://')).searchParams;
            } catch {
                finish(() => reject(new Error('Google returned a redirect we could not read.')));
                return;
            }

            // CSRF: a code that came back under a different state is not ours.
            if (params.get('state') !== expectedState) {
                log.warn('discarding a Google redirect whose state did not match this flow');
                finish(() => reject(new Error('Google sign-in could not be verified. Try again.')));
                return;
            }
            if (params.get('error')) {
                finish(() => reject(new Error('CANCELLED')));
                return;
            }
            const code = params.get('code');
            if (!code) {
                finish(() => reject(new Error('Google returned no authorization code. Try again.')));
                return;
            }
            finish(() => resolve(code));
        }).then((handle) => {
            urlHandle = handle;
            if (settled) void handle.remove().catch(() => undefined);
        });

        // The user dismissing the browser IS a cancellation. Without this the
        // promise would hang until the timeout with the screen spinning.
        void Browser.addListener('browserFinished', () => {
            // Give the redirect listener a beat to win the race when the
            // browser closes *because* the redirect fired.
            setTimeout(() => finish(() => reject(new Error('CANCELLED'))), 400);
        }).then((handle) => {
            closeHandle = handle;
            if (settled) void handle.remove().catch(() => undefined);
        });
    });
}

// ── Flows ──────────────────────────────────────────────────────────

/**
 * Native Google sign-in. Resolves with the Supabase session, or throws
 * `CANCELLED` when the skipper backs out — which the sign-in screen treats as
 * a silent no-op rather than an error.
 */
export async function signInWithGoogle(): Promise<Session> {
    if (!supabase) throw new Error('Sign-in is unavailable — no Supabase client.');
    if (!GOOGLE_SIGN_IN_ENABLED) {
        throw new Error('Google sign-in is not enabled in this build. Use email instead.');
    }
    // Mirrors the Apple split: the caller picks the lane, because the two are
    // different mechanisms rather than fallbacks for each other.
    if (!Capacitor.isNativePlatform()) {
        throw new Error('Native Google sign-in was called on the web — use signInWithGoogleOnWeb.');
    }

    const verifier = randomUrlSafe();
    const state = randomUrlSafe(16);
    const nonce = randomUrlSafe(16);
    const redirectUri = nativeRedirectUri();

    const authUrl = `${AUTH_ENDPOINT}?${new URLSearchParams({
        client_id: GOOGLE_OAUTH_CLIENT_ID,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: SCOPES,
        code_challenge: await codeChallengeOf(verifier),
        code_challenge_method: 'S256',
        state,
        nonce,
        // Always show the chooser: a boat's phone may be shared, and silently
        // reusing whichever Google account was last used is a bad surprise.
        prompt: 'select_account',
    }).toString()}`;

    const redirectPromise = awaitRedirect(state);
    await Browser.open({ url: authUrl, presentationStyle: 'popover' });
    const code = await redirectPromise;

    const tokenRes = await fetch(TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id: GOOGLE_OAUTH_CLIENT_ID,
            code,
            code_verifier: verifier,
            grant_type: 'authorization_code',
            redirect_uri: redirectUri,
        }).toString(),
    });
    if (!tokenRes.ok) {
        log.warn(`Google token exchange failed: HTTP ${tokenRes.status}`);
        throw new Error("Google sign-in didn't complete. Try again or use another method.");
    }

    const { id_token: idToken } = (await tokenRes.json()) as { id_token?: string };
    if (!idToken) throw new Error('Google returned no identity token. Try again.');

    // Raw nonce, not a hash — see the header note on how this differs from Apple.
    const { data, error } = await supabase.auth.signInWithIdToken({
        provider: 'google',
        token: idToken,
        nonce,
    });
    if (error || !data.session) {
        log.warn('Supabase signInWithIdToken (google) failed:', error?.message);
        // The overwhelmingly likely cause is the iOS client ID missing from
        // the Supabase provider's authorized client list. Name it rather than
        // echoing a raw provider string.
        throw new Error(
            error?.message ??
                "Google sign-in didn't complete on our end. Check the client ID is authorized in Supabase.",
        );
    }
    return data.session;
}

/**
 * Browser lane. Like the Apple web flow, this returns void because
 * `signInWithOAuth` navigates away — the session is picked up by
 * `detectSessionInUrl` on the return leg.
 */
export async function signInWithGoogleOnWeb(): Promise<void> {
    if (!supabase) throw new Error('Sign-in is unavailable — no Supabase client.');
    if (!GOOGLE_SIGN_IN_ENABLED) {
        throw new Error('Google sign-in is not enabled in this build. Use email instead.');
    }

    // Return to the page they came from — /plan is a standalone surface and
    // bouncing a planner session to the dashboard would lose their place.
    const redirectTo = `${window.location.origin}${window.location.pathname}`;
    const { error } = await supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo } });
    if (error) {
        log.warn('[web-oauth] Google sign-in failed:', error);
        throw new Error(`Google sign-in is not available yet (${error.message}). Use “Sign in with email” for now.`);
    }
}
