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
 *   Capacitor Preferences (`@capacitor/preferences`). On iOS this is
 *   backed by Keychain — encrypted at rest, survives reinstalls only
 *   if iCloud Keychain is on.
 *
 * Auth flow (PKCE, no client secret — the iOS bundle isn't a
 * "confidential client" by Google's classification, so PKCE is the
 * right primitive here):
 *   1. User toggles "Email access" ON in Settings → Calypso Integrations.
 *   2. Settings calls beginAuthorization() — generates a PKCE
 *      code_verifier (cached in Preferences), derives the
 *      code_challenge, builds the authorization URL.
 *   3. Settings opens the URL via @capacitor/browser. User signs in
 *      and consents on Google's screens.
 *   4. Google redirects to our reversed-client-ID URL scheme:
 *      `com.googleusercontent.apps.<reversed>:/oauth2redirect?code=...`
 *      The Capacitor App.addListener('appUrlOpen') in the settings UI
 *      catches the redirect and pulls the `code` query param.
 *   5. Settings calls completeAuthorization(code) — exchanges the
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
 * Storage keys for the OAuth tokens. Prefixed with `calypso:gmail:`
 * so they're discoverable + clearable as a group when the skipper
 * disables the integration.
 */
const KEY_ACCESS_TOKEN = 'calypso:gmail:access_token';
const KEY_REFRESH_TOKEN = 'calypso:gmail:refresh_token';
const KEY_TOKEN_EXPIRY = 'calypso:gmail:token_expiry'; // unix ms
const KEY_EMAIL = 'calypso:gmail:email';
/** PKCE verifier — set when beginAuthorization() runs, consumed +
 *  cleared by completeAuthorization() once the code has been exchanged.
 *  Cached in Preferences so it survives the app being backgrounded
 *  while the user is on Google's consent screen. */
const KEY_PKCE_VERIFIER = 'calypso:gmail:pkce_verifier';

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

async function loadTokens(): Promise<StoredTokens | null> {
    const [{ value: access }, { value: refresh }, { value: expiryStr }, { value: email }] = await Promise.all([
        Preferences.get({ key: KEY_ACCESS_TOKEN }),
        Preferences.get({ key: KEY_REFRESH_TOKEN }),
        Preferences.get({ key: KEY_TOKEN_EXPIRY }),
        Preferences.get({ key: KEY_EMAIL }),
    ]);
    if (!access || !refresh || !expiryStr || !email) return null;
    const expiresAt = parseInt(expiryStr, 10);
    if (!Number.isFinite(expiresAt)) return null;
    return { access, refresh, expiresAt, email };
}

async function saveTokens(tokens: StoredTokens): Promise<void> {
    await Promise.all([
        Preferences.set({ key: KEY_ACCESS_TOKEN, value: tokens.access }),
        Preferences.set({ key: KEY_REFRESH_TOKEN, value: tokens.refresh }),
        Preferences.set({ key: KEY_TOKEN_EXPIRY, value: String(tokens.expiresAt) }),
        Preferences.set({ key: KEY_EMAIL, value: tokens.email }),
    ]);
}

export async function clearGmailTokens(): Promise<void> {
    await Promise.all([
        Preferences.remove({ key: KEY_ACCESS_TOKEN }),
        Preferences.remove({ key: KEY_REFRESH_TOKEN }),
        Preferences.remove({ key: KEY_TOKEN_EXPIRY }),
        Preferences.remove({ key: KEY_EMAIL }),
    ]);
}

export async function getConnectedEmail(): Promise<string | null> {
    const t = await loadTokens();
    return t?.email ?? null;
}

export async function isGmailConfigured(): Promise<boolean> {
    return GOOGLE_OAUTH_CLIENT_ID.length > 0;
}

export async function isGmailConnected(): Promise<boolean> {
    const t = await loadTokens();
    return t !== null;
}

// ── Token refresh ──────────────────────────────────────────────────────

async function refreshAccessToken(refresh: string): Promise<{ access: string; expiresAt: number } | null> {
    if (!GOOGLE_OAUTH_CLIENT_ID) return null;
    try {
        const r = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: GOOGLE_OAUTH_CLIENT_ID,
                refresh_token: refresh,
                grant_type: 'refresh_token',
            }).toString(),
        });
        if (!r.ok) return null;
        const data = (await r.json()) as { access_token?: string; expires_in?: number };
        if (!data.access_token) return null;
        const expiresIn = data.expires_in ?? 3600;
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
async function getValidAccessToken(): Promise<string | null> {
    const tokens = await loadTokens();
    if (!tokens) return null;
    // Refresh 60 seconds before actual expiry to avoid race
    if (Date.now() < tokens.expiresAt - 60_000) return tokens.access;
    const refreshed = await refreshAccessToken(tokens.refresh);
    if (!refreshed) return null;
    const updated: StoredTokens = { ...tokens, access: refreshed.access, expiresAt: refreshed.expiresAt };
    await saveTokens(updated);
    return updated.access;
}

// ── PKCE helpers ───────────────────────────────────────────────────────

/**
 * Generate a high-entropy PKCE code_verifier per RFC 7636 §4.1 — a
 * random URL-safe string between 43 and 128 chars. We use 96 bytes of
 * crypto-randomness encoded as base64url (= 128 chars before stripping
 * padding), which sits comfortably inside the spec range.
 */
function generateCodeVerifier(): string {
    const bytes = new Uint8Array(96);
    crypto.getRandomValues(bytes);
    return base64UrlEncode(bytes);
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
    const verifier = generateCodeVerifier();
    const challenge = await deriveCodeChallenge(verifier);
    await Preferences.set({ key: KEY_PKCE_VERIFIER, value: verifier });

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
 * parsed `?code=...` out of the query string, and is handing it back
 * to us. We pull the cached verifier, exchange the auth code for an
 * access + refresh token at Google's token endpoint, fetch the
 * connected user's email via the userinfo endpoint, and persist
 * everything via Capacitor Preferences (Keychain on iOS).
 *
 * Returns the connected email on success, null on any failure
 * (network, expired code, mismatched verifier, missing refresh_token).
 * On failure the cached verifier is cleared so the next attempt
 * starts fresh.
 */
export async function completeAuthorization(code: string): Promise<string | null> {
    if (!GOOGLE_OAUTH_CLIENT_ID || !code) return null;
    const { value: verifier } = await Preferences.get({ key: KEY_PKCE_VERIFIER });
    if (!verifier) return null;

    try {
        const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: GOOGLE_OAUTH_CLIENT_ID,
                code,
                code_verifier: verifier,
                grant_type: 'authorization_code',
                redirect_uri: redirectUri(),
            }).toString(),
        });
        if (!tokenResp.ok) {
            await Preferences.remove({ key: KEY_PKCE_VERIFIER });
            return null;
        }
        const tokenData = (await tokenResp.json()) as {
            access_token?: string;
            refresh_token?: string;
            expires_in?: number;
        };
        if (!tokenData.access_token || !tokenData.refresh_token) {
            await Preferences.remove({ key: KEY_PKCE_VERIFIER });
            return null;
        }

        // Fetch the user's primary email so the settings UI can show
        // "Connected as cap'n@gmail.com". Single-purpose call — we
        // don't keep the userinfo around beyond the email string.
        const infoResp = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
            headers: { Authorization: `Bearer ${tokenData.access_token}` },
        });
        const info = infoResp.ok ? ((await infoResp.json()) as { email?: string }) : null;
        const email = info?.email ?? 'unknown@gmail.com';

        const expiresIn = tokenData.expires_in ?? 3600;
        await saveTokens({
            access: tokenData.access_token,
            refresh: tokenData.refresh_token,
            expiresAt: Date.now() + expiresIn * 1000,
            email,
        });
        await Preferences.remove({ key: KEY_PKCE_VERIFIER });
        return email;
    } catch {
        await Preferences.remove({ key: KEY_PKCE_VERIFIER });
        return null;
    }
}

/**
 * Parse the `code` parameter out of an OAuth callback URL like
 * `com.googleusercontent.apps.<id>:/oauth2redirect?code=4/...&scope=...`.
 *
 * Custom URL schemes don't parse cleanly with the standard URL
 * constructor on every platform (single-slash form trips iOS's parser
 * historically), so we fall back to a manual query-string split.
 */
export function extractAuthCodeFromCallbackUrl(callbackUrl: string): string | null {
    if (!callbackUrl) return null;
    const queryIdx = callbackUrl.indexOf('?');
    if (queryIdx < 0) return null;
    const qs = callbackUrl.slice(queryIdx + 1);
    const params = new URLSearchParams(qs);
    const code = params.get('code');
    return code && code.length > 0 ? code : null;
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

async function gmailFetch<T>(path: string, accessToken: string, init?: RequestInit): Promise<T | null> {
    try {
        const r = await fetch(`https://gmail.googleapis.com/gmail/v1${path}`, {
            ...init,
            headers: {
                ...(init?.headers || {}),
                Authorization: `Bearer ${accessToken}`,
                ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
            },
        });
        if (!r.ok) return null;
        return (await r.json()) as T;
    } catch {
        return null;
    }
}

// ── Tool implementations (dispatched from orchestrator) ───────────────

/**
 * Search the inbox using Gmail's full search syntax (`from:`, `subject:`,
 * `is:unread`, etc.). Returns up to `max` thread summaries.
 */
export async function searchEmails(query: string, max: number): Promise<{ content: string; isError: boolean }> {
    const access = await getValidAccessToken();
    if (!access) {
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
    );
    if (!list || !list.messages || list.messages.length === 0) {
        return { content: JSON.stringify({ matches: [], query }), isError: false };
    }
    // Fetch thumbnail metadata for each (subject + sender + snippet)
    const thumbs = await Promise.all(
        list.messages.slice(0, 10).map(async (m) => {
            const msg = await gmailFetch<GmailMessage>(
                `/users/me/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
                access,
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
    const access = await getValidAccessToken();
    if (!access) {
        return { content: 'ERROR: Gmail is not connected.', isError: true };
    }
    const msg = await gmailFetch<GmailMessage>(`/users/me/messages/${messageId}?format=full`, access);
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
    const access = await getValidAccessToken();
    if (!access) {
        return { content: 'ERROR: Gmail is not connected.', isError: true };
    }
    if (!to || !subject) {
        return { content: 'ERROR: draft requires both to and subject', isError: true };
    }
    // Build RFC 2822 message
    const raw = [`To: ${to}`, `Subject: ${subject}`, '', body || ''].join('\r\n');
    const encoded = btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const result = await gmailFetch<{ id: string; message: { id: string; threadId: string } }>(
        `/users/me/drafts`,
        access,
        {
            method: 'POST',
            body: JSON.stringify({ message: { raw: encoded } }),
        },
    );
    if (!result || !result.id) {
        return { content: 'ERROR: Gmail rejected the draft', isError: true };
    }
    return {
        content: JSON.stringify({
            draft_id: result.id,
            message_id: result.message.id,
            to,
            subject,
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
    const access = await getValidAccessToken();
    if (!access) {
        return { content: 'ERROR: Gmail is not connected.', isError: true };
    }
    if (!draftId) {
        return { content: 'ERROR: send_draft requires a draft_id from a recent draft_email call', isError: true };
    }
    const result = await gmailFetch<{ id: string; threadId: string }>(`/users/me/drafts/send`, access, {
        method: 'POST',
        body: JSON.stringify({ id: draftId }),
    });
    if (!result || !result.id) {
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
