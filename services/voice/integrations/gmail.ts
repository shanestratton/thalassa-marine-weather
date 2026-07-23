/**
 * Gmail integration for Calypso — OAuth 2.0 (PKCE) + Gmail REST API.
 *
 * Scopes:
 *   gmail.readonly  — search + read messages
 *   gmail.compose   — create + edit drafts
 *   gmail.send      — send email
 *
 * NOT requested:
 *   gmail.modify    — full account write (delete, move, re-label).
 *                     Out of scope for v1; voice-driven destruction
 *                     of email is too high-risk.
 *
 * Token storage:
 *   Capacitor Preferences (`@capacitor/preferences`). This is an
 *   account-scoped persistence boundary, NOT a secrets vault: iOS uses
 *   UserDefaults and the web implementation uses localStorage. A future
 *   native secure-storage backend should move the refresh token into the
 *   Keychain/Keystore. Until then, never log or mirror these values.
 *
 * Auth flow (PKCE, no client secret — the iOS bundle isn't a
 * "confidential client" by Google's classification, so PKCE is the
 * right primitive here):
 *   1. User toggles "Email access" ON in Settings → Calypso Integrations.
 *   2. Settings calls beginAuthorization() — generates a PKCE
 *      code_verifier + CSRF state (cached in account-scoped Preferences),
 *      derives the code_challenge, and builds the authorization URL.
 *   3. Settings opens the URL via @capacitor/browser. User signs in
 *      and consents on Google's screens.
 *   4. Google redirects to our reversed-client-ID URL scheme:
 *      `com.googleusercontent.apps.<reversed>:/oauth2redirect?code=...&state=...`
 *      The Capacitor App.addListener('appUrlOpen') in the settings UI
 *      catches the redirect and pulls the `code` + `state` query params.
 *   5. Settings calls completeAuthorization(code, state) — validates the
 *      exact account-owned flow, then exchanges the
 *      code (+ cached verifier) for access + refresh tokens, fetches
 *      the user's email via the userinfo endpoint, persists everything.
 *   6. Settings UI shows "Connected as cap'n@gmail.com".
 *
 * Tools registered with Calypso when this is enabled:
 *   search_emails({ query, max })  — Gmail search syntax, returns thread list
 *   read_email({ thread_id })       — full thread, oldest message first
 *   draft_email({ to, subject, body }) — saves as draft, NOT sent
 *   send_draft({ draft_id })        — sends an existing draft (requires
 *                                      explicit confirmation step in UX)
 *   inbox_summary({ limit })        — top N unread, subject + sender
 *
 * Configuration prerequisites (one-time, by the skipper):
 *   1. Create a Google Cloud project at https://console.cloud.google.com/
 *   2. Enable the Gmail API for the project
 *   3. Configure OAuth consent screen (External, scopes listed above)
 *   4. Create OAuth client ID (type: iOS, bundle ID matching the app's)
 *   5. Add the client ID to .env.local:
 *        VITE_GOOGLE_OAUTH_CLIENT_ID=...apps.googleusercontent.com
 *   6. Add the iOS URL scheme to ios/App/App/Info.plist (CFBundleURLTypes)
 *      using the reversed client ID
 *
 * The current scaffolding gracefully fails (returns "not configured"
 * to Calypso) when the env var is missing — works for dev without
 * blocking other voice features.
 */

import { Preferences } from '@capacitor/preferences';
import {
    authScopedStorageKey,
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
    type AuthIdentityScope,
} from '../../authIdentityScope';

const GOOGLE_OAUTH_CLIENT_ID =
    (typeof import.meta !== 'undefined' && import.meta.env?.VITE_GOOGLE_OAUTH_CLIENT_ID) || '';

/**
 * Reversed-client-ID URL scheme for the OAuth redirect. Google's iOS
 * client docs prescribe this exact format: take the client ID, strip
 * the `.apps.googleusercontent.com` suffix, and prepend
 * `com.googleusercontent.apps.`. Single colon + single forward slash
 * separator is standard for Google's OAuth iOS flows (not `://`).
 */
function reversedClientIdScheme(): string {
    if (!GOOGLE_OAUTH_CLIENT_ID) return '';
    const trimmed = GOOGLE_OAUTH_CLIENT_ID.replace(/\.apps\.googleusercontent\.com$/, '');
    return `com.googleusercontent.apps.${trimmed}`;
}

function redirectUri(): string {
    const scheme = reversedClientIdScheme();
    if (!scheme) return '';
    return `${scheme}:/oauth2redirect`;
}

/**
 * Tokens are kept in one owner-tagged envelope so readers never observe a
 * half-written access/refresh/email tuple. The Preferences key itself is also
 * account scoped. PKCE material is stored separately because it is consumed
 * before credentials are committed.
 */
const KEY_CREDENTIALS = 'calypso:gmail:credentials:v2';
const KEY_OAUTH_PENDING = 'calypso:gmail:oauth_pending:v2';

/**
 * v1 stored unowned secrets in global keys. There is no trustworthy mapping
 * from those values to a Thalassa account, so adopting them for whichever user
 * happens to sign in first would leak one skipper's Gmail to another. They are
 * quarantined by deletion rather than migrated.
 */
const LEGACY_UNOWNED_KEYS = [
    'calypso:gmail:access_token',
    'calypso:gmail:refresh_token',
    'calypso:gmail:token_expiry',
    'calypso:gmail:email',
    'calypso:gmail:pkce_verifier',
    'calypso:gmail:oauth_state',
] as const;

const CREDENTIAL_VERSION = 2;
const OAUTH_PENDING_VERSION = 2;
const OAUTH_PENDING_TTL_MS = 10 * 60_000;

const GMAIL_SCOPES = [
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.compose',
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/userinfo.email',
];

// ── Token storage helpers ──────────────────────────────────────────────

interface StoredTokens {
    access: string;
    refresh: string;
    expiresAt: number;
    email: string;
}

interface StoredCredentialEnvelope extends StoredTokens {
    version: typeof CREDENTIAL_VERSION;
    ownerKey: string;
    ownerUserId: string;
    updatedAt: number;
}

interface PendingOAuthEnvelope {
    version: typeof OAUTH_PENDING_VERSION;
    ownerKey: string;
    ownerUserId: string;
    runtimeId: string;
    generation: number;
    oauthEpoch: number;
    verifier: string;
    state: string;
    issuedAt: number;
}

interface OperationContext {
    scope: AuthIdentityScope;
    credentialEpoch: number;
    oauthEpoch?: number;
}

interface ActiveRequest {
    context: OperationContext;
    controller: AbortController;
}

const credentialEpochs = new Map<string, number>();
const oauthEpochs = new Map<string, number>();
const storageChains = new Map<string, Promise<void>>();
const activeRequests = new Set<ActiveRequest>();
let legacyScrubPromise: Promise<void> | null = null;
let runtimeId: string | null = null;

function credentialsKey(scope: AuthIdentityScope): string {
    return authScopedStorageKey(KEY_CREDENTIALS, scope);
}

function pendingOAuthKey(scope: AuthIdentityScope): string {
    return authScopedStorageKey(KEY_OAUTH_PENDING, scope);
}

function epochFor(map: Map<string, number>, scope: AuthIdentityScope): number {
    return map.get(scope.key) ?? 0;
}

function makeCredentialContext(): OperationContext | null {
    const scope = getAuthIdentityScope();
    if (!scope.userId) return null;
    return {
        scope,
        credentialEpoch: epochFor(credentialEpochs, scope),
    };
}

function isOperationCurrent(context: OperationContext): boolean {
    return (
        isAuthIdentityScopeCurrent(context.scope) &&
        context.scope.userId !== null &&
        epochFor(credentialEpochs, context.scope) === context.credentialEpoch &&
        (context.oauthEpoch === undefined || epochFor(oauthEpochs, context.scope) === context.oauthEpoch)
    );
}

function abortInvalidRequests(): void {
    for (const request of activeRequests) {
        if (!isOperationCurrent(request.context)) request.controller.abort();
    }
}

function invalidateCredentialOperations(scope: AuthIdentityScope): number {
    const next = epochFor(credentialEpochs, scope) + 1;
    credentialEpochs.set(scope.key, next);
    abortInvalidRequests();
    return next;
}

function startOAuthFlow(scope: AuthIdentityScope): number {
    const next = epochFor(oauthEpochs, scope) + 1;
    oauthEpochs.set(scope.key, next);
    abortInvalidRequests();
    return next;
}

function invalidateOAuthFlows(scope: AuthIdentityScope): void {
    oauthEpochs.set(scope.key, epochFor(oauthEpochs, scope) + 1);
    abortInvalidRequests();
}

subscribeAuthIdentityScope((_next, previous) => {
    abortInvalidRequests();
    if (previous.userId) {
        // PKCE verifiers are single-login, short-lived secrets. They never
        // need to survive a Thalassa account transition.
        void queueStorageMutation(pendingOAuthKey(previous), async () => {
            await Preferences.remove({ key: pendingOAuthKey(previous) });
        }).catch(() => undefined);
    }
});

function queueStorageMutation<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = storageChains.get(key) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(task);
    const tail = result.then(
        () => undefined,
        () => undefined,
    );
    storageChains.set(key, tail);
    void tail.finally(() => {
        if (storageChains.get(key) === tail) storageChains.delete(key);
    });
    return result;
}

async function awaitStorageIdle(key: string): Promise<void> {
    const pending = storageChains.get(key);
    if (pending) await pending;
}

async function scrubUnownedLegacyState(): Promise<void> {
    if (!legacyScrubPromise) {
        const attempt = queueStorageMutation('calypso:gmail:legacy-scrub', async () => {
            const results = await Promise.allSettled(LEGACY_UNOWNED_KEYS.map((key) => Preferences.remove({ key })));
            if (results.some((result) => result.status === 'rejected')) {
                throw new Error('Could not remove all unowned legacy Gmail credentials');
            }
        });
        legacyScrubPromise = attempt;
        void attempt.catch(() => {
            if (legacyScrubPromise === attempt) legacyScrubPromise = null;
        });
    }
    await legacyScrubPromise.catch(() => undefined);
}

function parseCredentialEnvelope(value: string, scope: AuthIdentityScope): StoredCredentialEnvelope | null {
    try {
        const parsed = JSON.parse(value) as Partial<StoredCredentialEnvelope>;
        if (
            parsed.version !== CREDENTIAL_VERSION ||
            parsed.ownerKey !== scope.key ||
            parsed.ownerUserId !== scope.userId ||
            typeof parsed.access !== 'string' ||
            parsed.access.length === 0 ||
            typeof parsed.refresh !== 'string' ||
            parsed.refresh.length === 0 ||
            typeof parsed.email !== 'string' ||
            parsed.email.length === 0 ||
            typeof parsed.expiresAt !== 'number' ||
            !Number.isFinite(parsed.expiresAt) ||
            typeof parsed.updatedAt !== 'number' ||
            !Number.isFinite(parsed.updatedAt)
        ) {
            return null;
        }
        return parsed as StoredCredentialEnvelope;
    } catch {
        return null;
    }
}

function parsePendingOAuthEnvelope(value: string, scope: AuthIdentityScope): PendingOAuthEnvelope | null {
    try {
        const parsed = JSON.parse(value) as Partial<PendingOAuthEnvelope>;
        if (
            parsed.version !== OAUTH_PENDING_VERSION ||
            parsed.ownerKey !== scope.key ||
            parsed.ownerUserId !== scope.userId ||
            parsed.runtimeId !== getRuntimeId() ||
            parsed.generation !== scope.generation ||
            typeof parsed.oauthEpoch !== 'number' ||
            !Number.isInteger(parsed.oauthEpoch) ||
            typeof parsed.verifier !== 'string' ||
            parsed.verifier.length < 43 ||
            typeof parsed.state !== 'string' ||
            parsed.state.length < 32 ||
            typeof parsed.issuedAt !== 'number' ||
            !Number.isFinite(parsed.issuedAt) ||
            parsed.issuedAt > Date.now() + 60_000 ||
            Date.now() - parsed.issuedAt > OAUTH_PENDING_TTL_MS
        ) {
            return null;
        }
        return parsed as PendingOAuthEnvelope;
    } catch {
        return null;
    }
}

async function loadTokens(context: OperationContext): Promise<StoredTokens | null> {
    await scrubUnownedLegacyState();
    if (!isOperationCurrent(context)) return null;

    const key = credentialsKey(context.scope);
    await awaitStorageIdle(key);
    if (!isOperationCurrent(context)) return null;

    const { value } = await Preferences.get({ key });
    if (!isOperationCurrent(context) || !value) return null;

    const envelope = parseCredentialEnvelope(value, context.scope);
    if (!envelope) {
        await queueStorageMutation(key, async () => {
            if (!isOperationCurrent(context)) return;
            const latest = await Preferences.get({ key });
            if (!isOperationCurrent(context) || latest.value !== value) return;
            await Preferences.remove({ key });
        });
        return null;
    }
    return {
        access: envelope.access,
        refresh: envelope.refresh,
        expiresAt: envelope.expiresAt,
        email: envelope.email,
    };
}

/**
 * Commit a single credential envelope. If identity changes while the native
 * bridge write is in flight, restore the previous exact-account value before
 * allowing another mutation for that account to proceed.
 */
async function commitScopedValue(key: string, serialized: string, context: OperationContext): Promise<boolean> {
    return queueStorageMutation(key, async () => {
        if (!isOperationCurrent(context)) return false;
        const previous = await Preferences.get({ key });
        if (!isOperationCurrent(context)) return false;

        await Preferences.set({ key, value: serialized });
        if (isOperationCurrent(context)) return true;

        if (previous.value === null) {
            await Preferences.remove({ key });
        } else {
            await Preferences.set({ key, value: previous.value });
        }
        return false;
    });
}

async function saveTokens(tokens: StoredTokens, context: OperationContext): Promise<boolean> {
    const envelope: StoredCredentialEnvelope = {
        version: CREDENTIAL_VERSION,
        ownerKey: context.scope.key,
        ownerUserId: context.scope.userId!,
        ...tokens,
        updatedAt: Date.now(),
    };
    return commitScopedValue(credentialsKey(context.scope), JSON.stringify(envelope), context);
}

async function savePendingOAuth(pending: PendingOAuthEnvelope, context: OperationContext): Promise<boolean> {
    return commitScopedValue(pendingOAuthKey(context.scope), JSON.stringify(pending), context);
}

async function consumePendingOAuth(
    scope: AuthIdentityScope,
    expectedState: string,
): Promise<PendingOAuthEnvelope | null> {
    const key = pendingOAuthKey(scope);
    return queueStorageMutation(key, async () => {
        if (!isAuthIdentityScopeCurrent(scope) || !scope.userId) return null;
        const { value } = await Preferences.get({ key });
        if (!isAuthIdentityScopeCurrent(scope) || !value) return null;

        const pending = parsePendingOAuthEnvelope(value, scope);
        if (!pending) {
            await Preferences.remove({ key });
            return null;
        }
        // A stray/forged callback must not cancel the skipper's valid flow.
        if (pending.state !== expectedState || epochFor(oauthEpochs, scope) !== pending.oauthEpoch) return null;

        await Preferences.remove({ key });
        if (!isAuthIdentityScopeCurrent(scope)) return null;
        return pending;
    });
}

/**
 * Disconnect only the account that initiated this call. Epoch invalidation is
 * synchronous, so an already-running refresh/OAuth/tool request cannot
 * repopulate credentials after the clear.
 */
export async function clearGmailTokens(): Promise<boolean> {
    const scope = getAuthIdentityScope();
    if (!scope.userId) {
        await scrubUnownedLegacyState();
        return false;
    }

    invalidateCredentialOperations(scope);
    invalidateOAuthFlows(scope);
    await scrubUnownedLegacyState();
    if (!isAuthIdentityScopeCurrent(scope)) return false;

    const keys = [credentialsKey(scope), pendingOAuthKey(scope)];
    const removals = keys.map((key) =>
        queueStorageMutation(key, async () => {
            if (!isAuthIdentityScopeCurrent(scope)) return false;
            await Preferences.remove({ key });
            return isAuthIdentityScopeCurrent(scope);
        }),
    );
    const results = await Promise.all(removals);
    return isAuthIdentityScopeCurrent(scope) && results.every(Boolean);
}

export async function getConnectedEmail(): Promise<string | null> {
    const context = makeCredentialContext();
    if (!context) {
        await scrubUnownedLegacyState();
        return null;
    }
    const tokens = await loadTokens(context);
    if (!isOperationCurrent(context)) return null;
    return tokens?.email ?? null;
}

export async function isGmailConfigured(): Promise<boolean> {
    return GOOGLE_OAUTH_CLIENT_ID.length > 0;
}

export async function isGmailConnected(): Promise<boolean> {
    const context = makeCredentialContext();
    if (!context) {
        await scrubUnownedLegacyState();
        return false;
    }
    const tokens = await loadTokens(context);
    return isOperationCurrent(context) && tokens !== null;
}

// ── Token refresh ──────────────────────────────────────────────────────

async function scopedFetch(input: string, init: RequestInit, context: OperationContext): Promise<Response | null> {
    if (!isOperationCurrent(context)) return null;
    const controller = new AbortController();
    const request: ActiveRequest = { context, controller };
    activeRequests.add(request);
    try {
        const response = await fetch(input, { ...init, signal: controller.signal });
        if (!isOperationCurrent(context)) return null;
        return response;
    } catch {
        return null;
    } finally {
        activeRequests.delete(request);
    }
}

async function refreshAccessToken(
    refresh: string,
    context: OperationContext,
): Promise<{ access: string; expiresAt: number } | null> {
    if (!GOOGLE_OAUTH_CLIENT_ID || !isOperationCurrent(context)) return null;
    try {
        const r = await scopedFetch(
            'https://oauth2.googleapis.com/token',
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    client_id: GOOGLE_OAUTH_CLIENT_ID,
                    refresh_token: refresh,
                    grant_type: 'refresh_token',
                }).toString(),
            },
            context,
        );
        if (!r || !r.ok || !isOperationCurrent(context)) return null;
        const data = (await r.json()) as { access_token?: string; expires_in?: number };
        if (!isOperationCurrent(context) || typeof data.access_token !== 'string' || !data.access_token) return null;
        const expiresIn =
            typeof data.expires_in === 'number' && Number.isFinite(data.expires_in) && data.expires_in > 0
                ? data.expires_in
                : 3600;
        return {
            access: data.access_token,
            expiresAt: Date.now() + expiresIn * 1000,
        };
    } catch {
        return null;
    }
}

/**
 * Get a valid access token — refreshes on demand if the cached one
 * is expired. Returns null if no tokens stored or refresh failed.
 */
async function getValidAccessToken(context: OperationContext): Promise<string | null> {
    const tokens = await loadTokens(context);
    if (!tokens || !isOperationCurrent(context)) return null;
    // Refresh 60 seconds before actual expiry to avoid race
    if (Date.now() < tokens.expiresAt - 60_000) return tokens.access;
    const refreshed = await refreshAccessToken(tokens.refresh, context);
    if (!refreshed || !isOperationCurrent(context)) return null;
    const updated: StoredTokens = { ...tokens, access: refreshed.access, expiresAt: refreshed.expiresAt };
    const saved = await saveTokens(updated, context);
    return saved && isOperationCurrent(context) ? updated.access : null;
}

// ── PKCE helpers ───────────────────────────────────────────────────────

/**
 * Generate a high-entropy PKCE code_verifier per RFC 7636 §4.1 — a
 * random URL-safe string between 43 and 128 chars. We use 96 bytes of
 * crypto-randomness encoded as base64url (= 128 chars before stripping
 * padding), which sits comfortably inside the spec range.
 */
function generateCodeVerifier(): string {
    return generateRandomToken(96);
}

function generateOAuthState(): string {
    return generateRandomToken(32);
}

function generateRandomToken(byteLength: number): string {
    const bytes = new Uint8Array(byteLength);
    crypto.getRandomValues(bytes);
    return base64UrlEncode(bytes);
}

function getRuntimeId(): string {
    runtimeId ??= generateRandomToken(24);
    return runtimeId;
}

/**
 * Derive the code_challenge from a verifier per RFC 7636 §4.2. We use
 * the S256 transform exclusively (Google requires it for PKCE flows
 * without a client secret) — never `plain`.
 */
async function deriveCodeChallenge(verifier: string): Promise<string> {
    const enc = new TextEncoder().encode(verifier);
    const digest = await crypto.subtle.digest('SHA-256', enc);
    return base64UrlEncode(new Uint8Array(digest));
}

function base64UrlEncode(bytes: Uint8Array): string {
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ── OAuth authorization (entry point from settings UI) ────────────────

/**
 * Step 1 of OAuth: kick off the consent flow. Generates a fresh PKCE
 * code_verifier, caches it in Preferences (so it survives the app
 * being backgrounded while the user is on Google's screens), derives
 * the S256 code_challenge, and returns the authorization URL the
 * caller should open via @capacitor/browser.
 *
 * Returns null if the integration isn't configured (no client ID in
 * .env). Caller should show a setup-instructions message in that case.
 */
export async function beginAuthorization(): Promise<string | null> {
    if (!GOOGLE_OAUTH_CLIENT_ID) return null;
    const scope = getAuthIdentityScope();
    if (!scope.userId) {
        await scrubUnownedLegacyState();
        return null;
    }
    const oauthEpoch = startOAuthFlow(scope);
    const context: OperationContext = {
        scope,
        credentialEpoch: epochFor(credentialEpochs, scope),
        oauthEpoch,
    };
    await scrubUnownedLegacyState();
    if (!isOperationCurrent(context)) return null;

    let verifier: string;
    let state: string;
    let challenge: string;
    try {
        verifier = generateCodeVerifier();
        state = generateOAuthState();
        challenge = await deriveCodeChallenge(verifier);
    } catch {
        return null;
    }
    if (!isOperationCurrent(context)) return null;

    const pending: PendingOAuthEnvelope = {
        version: OAUTH_PENDING_VERSION,
        ownerKey: scope.key,
        ownerUserId: scope.userId,
        runtimeId: getRuntimeId(),
        generation: scope.generation,
        oauthEpoch,
        verifier,
        state,
        issuedAt: Date.now(),
    };
    if (!(await savePendingOAuth(pending, context)) || !isOperationCurrent(context)) return null;

    const params = new URLSearchParams({
        client_id: GOOGLE_OAUTH_CLIENT_ID,
        redirect_uri: redirectUri(),
        response_type: 'code',
        scope: GMAIL_SCOPES.join(' '),
        access_type: 'offline',
        // `prompt=consent` forces Google to re-issue a refresh_token
        // even on re-auth — without it, returning users get only an
        // access_token and we can't keep them connected long-term.
        prompt: 'consent',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state,
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

/**
 * Backward-compat alias for the old Settings UI call. Same as
 * beginAuthorization() — exists so the settings tab compiles while
 * we transition. Remove once all callers have moved to the new name.
 */
export async function getAuthorizationUrl(): Promise<string | null> {
    return beginAuthorization();
}

/**
 * Step 2 of OAuth: the redirect handler caught the callback URL,
 * parsed `?code=...&state=...` out of the query string, and is handing
 * it back to us. We atomically consume the exact account-owned flow,
 * exchange the auth code for an
 * access + refresh token at Google's token endpoint, fetch the
 * connected user's email via the userinfo endpoint, and persist
 * everything via account-scoped Capacitor Preferences.
 *
 * Returns the connected email on success, null on any failure
 * (network, expired code, mismatched verifier, missing refresh_token).
 * A callback with matching state consumes its verifier exactly once, even if
 * the later exchange fails. A state mismatch leaves the valid flow untouched.
 */
export async function completeAuthorization(code: string, state: string): Promise<string | null> {
    if (!GOOGLE_OAUTH_CLIENT_ID || !code || !state) return null;
    const scope = getAuthIdentityScope();
    if (!scope.userId) {
        await scrubUnownedLegacyState();
        return null;
    }
    await scrubUnownedLegacyState();
    if (!isAuthIdentityScopeCurrent(scope)) return null;

    const pending = await consumePendingOAuth(scope, state);
    if (!pending || !isAuthIdentityScopeCurrent(scope)) return null;
    // A successfully owned callback supersedes any refresh/tool request that
    // started with the previous credential set.
    const credentialEpoch = invalidateCredentialOperations(scope);
    const context: OperationContext = {
        scope,
        credentialEpoch,
        oauthEpoch: pending.oauthEpoch,
    };
    if (!isOperationCurrent(context)) return null;

    try {
        const tokenResp = await scopedFetch(
            'https://oauth2.googleapis.com/token',
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    client_id: GOOGLE_OAUTH_CLIENT_ID,
                    code,
                    code_verifier: pending.verifier,
                    grant_type: 'authorization_code',
                    redirect_uri: redirectUri(),
                }).toString(),
            },
            context,
        );
        if (!tokenResp || !tokenResp.ok || !isOperationCurrent(context)) return null;
        const tokenData = (await tokenResp.json()) as {
            access_token?: string;
            refresh_token?: string;
            expires_in?: number;
        };
        if (
            !isOperationCurrent(context) ||
            typeof tokenData.access_token !== 'string' ||
            !tokenData.access_token ||
            typeof tokenData.refresh_token !== 'string' ||
            !tokenData.refresh_token
        )
            return null;

        // Fetch the user's primary email so the settings UI can show
        // "Connected as cap'n@gmail.com". Single-purpose call — we
        // don't keep the userinfo around beyond the email string.
        const infoResp = await scopedFetch(
            'https://www.googleapis.com/oauth2/v2/userinfo',
            {
                headers: { Authorization: `Bearer ${tokenData.access_token}` },
            },
            context,
        );
        if (!infoResp || !infoResp.ok || !isOperationCurrent(context)) return null;
        const info = (await infoResp.json()) as { email?: string };
        if (!isOperationCurrent(context)) return null;
        const email = typeof info.email === 'string' ? info.email.trim() : '';
        if (!email || !email.includes('@') || email.length > 320) return null;

        const expiresIn =
            typeof tokenData.expires_in === 'number' &&
            Number.isFinite(tokenData.expires_in) &&
            tokenData.expires_in > 0
                ? tokenData.expires_in
                : 3600;
        const saved = await saveTokens(
            {
                access: tokenData.access_token,
                refresh: tokenData.refresh_token,
                expiresAt: Date.now() + expiresIn * 1000,
                email,
            },
            context,
        );
        return saved && isOperationCurrent(context) ? email : null;
    } catch {
        return null;
    }
}

export interface GmailOAuthCallback {
    code: string;
    state: string;
}

/**
 * Parse the `code` + CSRF `state` parameters out of the exact configured
 * callback URL. Duplicate parameters and lookalike schemes/paths are rejected.
 *
 * Custom URL schemes don't parse cleanly with the standard URL
 * constructor on every platform (single-slash form trips iOS's parser
 * historically), so we fall back to a manual query-string split.
 */
export function extractAuthCallbackFromUrl(callbackUrl: string): GmailOAuthCallback | null {
    if (!callbackUrl) return null;
    const queryIdx = callbackUrl.indexOf('?');
    if (queryIdx < 0) return null;
    if (callbackUrl.slice(0, queryIdx) !== redirectUri()) return null;

    const fragmentIdx = callbackUrl.indexOf('#', queryIdx + 1);
    const qs = callbackUrl.slice(queryIdx + 1, fragmentIdx < 0 ? undefined : fragmentIdx);
    const params = new URLSearchParams(qs);
    const codes = params.getAll('code');
    const states = params.getAll('state');
    if (params.has('error') || codes.length !== 1 || states.length !== 1) return null;
    const code = codes[0]?.trim() ?? '';
    const state = states[0]?.trim() ?? '';
    if (!code || !state || code.length > 4096 || state.length > 1024) return null;
    return { code, state };
}

// ── Gmail API helpers (used by the Calypso tools below) ───────────────

interface GmailMessage {
    id: string;
    threadId: string;
    snippet: string;
    payload?: {
        headers?: Array<{ name: string; value: string }>;
        body?: { data?: string; size?: number };
        parts?: GmailMessagePart[];
    };
}

interface GmailMessagePart {
    mimeType?: string;
    body?: { data?: string; size?: number };
    parts?: GmailMessagePart[];
}

function decodeBase64Url(s: string): string {
    const padded = s.replace(/-/g, '+').replace(/_/g, '/');
    try {
        return atob(padded);
    } catch {
        return '';
    }
}

function getHeader(msg: GmailMessage, name: string): string | undefined {
    const h = msg.payload?.headers?.find((x) => x.name.toLowerCase() === name.toLowerCase());
    return h?.value;
}

function extractPlainBody(msg: GmailMessage): string {
    function walk(part: GmailMessagePart): string {
        if (part.mimeType === 'text/plain' && part.body?.data) {
            return decodeBase64Url(part.body.data);
        }
        for (const sub of part.parts ?? []) {
            const txt = walk(sub);
            if (txt) return txt;
        }
        return '';
    }
    if (msg.payload) return walk(msg.payload as GmailMessagePart);
    return '';
}

async function gmailFetch<T>(
    path: string,
    accessToken: string,
    context: OperationContext,
    init?: RequestInit,
): Promise<T | null> {
    if (!isOperationCurrent(context)) return null;
    try {
        const headers = new Headers(init?.headers);
        headers.set('Authorization', `Bearer ${accessToken}`);
        if (init?.body) headers.set('Content-Type', 'application/json');
        const r = await scopedFetch(
            `https://gmail.googleapis.com/gmail/v1${path}`,
            {
                ...init,
                headers,
            },
            context,
        );
        if (!r || !r.ok || !isOperationCurrent(context)) return null;
        const data = (await r.json()) as T;
        return isOperationCurrent(context) ? data : null;
    } catch {
        return null;
    }
}

// ── Tool implementations (dispatched from orchestrator) ───────────────

function hasUnsafeHeaderCharacters(value: string): boolean {
    for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        if (code <= 31 || code === 127) return true;
    }
    return false;
}

function normalizeGmailResourceId(value: string): string | null {
    const normalized = value.trim();
    return normalized.length > 0 && normalized.length <= 256 && /^[A-Za-z0-9_-]+$/u.test(normalized)
        ? normalized
        : null;
}

/**
 * Search the inbox using Gmail's full search syntax (`from:`, `subject:`,
 * `is:unread`, etc.). Returns up to `max` thread summaries.
 */
export async function searchEmails(query: string, max: number): Promise<{ content: string; isError: boolean }> {
    if (query.length > 2048 || hasUnsafeHeaderCharacters(query)) {
        return { content: 'ERROR: Gmail search query is invalid or too long.', isError: true };
    }
    const context = makeCredentialContext();
    if (!context) return gmailNotConnectedResult();
    const access = await getValidAccessToken(context);
    if (!access || !isOperationCurrent(context)) {
        return {
            content:
                'ERROR: Gmail is not connected. Ask the skipper to enable email access in Settings → Calypso Integrations.',
            isError: true,
        };
    }
    const params = new URLSearchParams({
        q: query || '',
        maxResults: String(Math.min(Math.max(1, max || 10), 25)),
    });
    const list = await gmailFetch<{ messages?: Array<{ id: string; threadId: string }> }>(
        `/users/me/messages?${params.toString()}`,
        access,
        context,
    );
    if (!isOperationCurrent(context)) return gmailOperationCancelledResult();
    if (!list || !list.messages || list.messages.length === 0) {
        return { content: JSON.stringify({ matches: [], query }), isError: false };
    }
    // Fetch thumbnail metadata for each (subject + sender + snippet)
    const thumbs = await Promise.all(
        list.messages.slice(0, 10).map(async (m) => {
            const msg = await gmailFetch<GmailMessage>(
                `/users/me/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
                access,
                context,
            );
            if (!msg) return null;
            return {
                id: m.id,
                thread_id: m.threadId,
                from: getHeader(msg, 'From'),
                subject: getHeader(msg, 'Subject'),
                date: getHeader(msg, 'Date'),
                snippet: msg.snippet,
            };
        }),
    );
    if (!isOperationCurrent(context)) return gmailOperationCancelledResult();
    return {
        content: JSON.stringify({
            matches: thumbs.filter((t) => t !== null),
            query,
            note: 'Read aloud subject + sender, summarise snippet. Do NOT read full body unless skipper asks "read it" — call read_email for that.',
        }),
        isError: false,
    };
}

/**
 * Fetch the full body of a single email by message id. Returns plain
 * text content (no HTML) for natural narration via TTS.
 */
export async function readEmail(messageId: string): Promise<{ content: string; isError: boolean }> {
    const safeMessageId = normalizeGmailResourceId(messageId);
    if (!safeMessageId) return { content: 'ERROR: invalid Gmail message id.', isError: true };
    const context = makeCredentialContext();
    if (!context) return gmailNotConnectedResult();
    const access = await getValidAccessToken(context);
    if (!access || !isOperationCurrent(context)) {
        return { content: 'ERROR: Gmail is not connected.', isError: true };
    }
    const msg = await gmailFetch<GmailMessage>(
        `/users/me/messages/${encodeURIComponent(safeMessageId)}?format=full`,
        access,
        context,
    );
    if (!isOperationCurrent(context)) return gmailOperationCancelledResult();
    if (!msg) {
        return { content: `ERROR: could not fetch message ${messageId}`, isError: true };
    }
    const body = extractPlainBody(msg);
    return {
        content: JSON.stringify({
            from: getHeader(msg, 'From'),
            to: getHeader(msg, 'To'),
            subject: getHeader(msg, 'Subject'),
            date: getHeader(msg, 'Date'),
            body: body.slice(0, 8000), // cap so a huge thread doesn't blow Calypso's context
            truncated: body.length > 8000,
        }),
        isError: false,
    };
}

/**
 * Create a draft email. Calypso reads back what she's about to draft
 * before calling this — the draft lands in Gmail's Drafts folder, NOT
 * sent. The skipper either says "send it" (separate send_draft call)
 * or edits the draft manually in Gmail.
 */
export async function draftEmail(
    to: string,
    subject: string,
    body: string,
): Promise<{ content: string; isError: boolean }> {
    const safeTo = to.trim();
    const safeSubject = subject.trim();
    if (
        !safeTo ||
        !safeSubject ||
        safeTo.length > 1000 ||
        safeSubject.length > 500 ||
        body.length > 100_000 ||
        hasUnsafeHeaderCharacters(safeTo) ||
        hasUnsafeHeaderCharacters(safeSubject)
    ) {
        return { content: 'ERROR: draft requires both to and subject', isError: true };
    }
    const context = makeCredentialContext();
    if (!context) return gmailNotConnectedResult();
    const access = await getValidAccessToken(context);
    if (!access || !isOperationCurrent(context)) {
        return { content: 'ERROR: Gmail is not connected.', isError: true };
    }
    // Build RFC 2822 message
    const raw = [`To: ${safeTo}`, `Subject: ${safeSubject}`, '', body || ''].join('\r\n');
    const encoded = base64UrlEncode(new TextEncoder().encode(raw));
    const result = await gmailFetch<{ id: string; message: { id: string; threadId: string } }>(
        `/users/me/drafts`,
        access,
        context,
        {
            method: 'POST',
            body: JSON.stringify({ message: { raw: encoded } }),
        },
    );
    if (!isOperationCurrent(context)) return gmailOperationCancelledResult();
    if (!result?.id || !result.message?.id) {
        return { content: 'ERROR: Gmail rejected the draft', isError: true };
    }
    return {
        content: JSON.stringify({
            draft_id: result.id,
            message_id: result.message.id,
            to: safeTo,
            subject: safeSubject,
            preview: (body || '').slice(0, 200),
            note: 'Draft saved. Call send_draft with this draft_id to actually send. Read the preview back to the skipper for confirmation first.',
        }),
        isError: false,
    };
}

/**
 * Send a previously-drafted email. Requires explicit draft_id from a
 * recent draftEmail() call — Calypso never calls this without prior
 * drafting + skipper confirmation.
 */
export async function sendDraft(draftId: string): Promise<{ content: string; isError: boolean }> {
    const safeDraftId = normalizeGmailResourceId(draftId);
    if (!safeDraftId) {
        return { content: 'ERROR: send_draft requires a draft_id from a recent draft_email call', isError: true };
    }
    const context = makeCredentialContext();
    if (!context) return gmailNotConnectedResult();
    const access = await getValidAccessToken(context);
    if (!access || !isOperationCurrent(context)) {
        return { content: 'ERROR: Gmail is not connected.', isError: true };
    }
    const result = await gmailFetch<{ id: string; threadId: string }>(`/users/me/drafts/send`, access, context, {
        method: 'POST',
        body: JSON.stringify({ id: safeDraftId }),
    });
    if (!isOperationCurrent(context)) return gmailOperationCancelledResult();
    if (!result?.id || !result.threadId) {
        return { content: 'ERROR: Gmail rejected the send', isError: true };
    }
    return {
        content: JSON.stringify({
            sent: true,
            message_id: result.id,
            thread_id: result.threadId,
        }),
        isError: false,
    };
}

/**
 * Quick inbox summary — top N unread message thumbnails. Useful for
 * "any emails today" / "what's in my inbox" voice prompts.
 */
export async function inboxSummary(limit: number): Promise<{ content: string; isError: boolean }> {
    return searchEmails('is:unread in:inbox', Math.min(Math.max(1, limit || 5), 15));
}

function gmailNotConnectedResult(): { content: string; isError: boolean } {
    return {
        content:
            'ERROR: Gmail is not connected. Ask the skipper to enable email access in Settings → Calypso Integrations.',
        isError: true,
    };
}

function gmailOperationCancelledResult(): { content: string; isError: boolean } {
    return {
        content: 'ERROR: Gmail operation cancelled because the signed-in Thalassa account changed.',
        isError: true,
    };
}
