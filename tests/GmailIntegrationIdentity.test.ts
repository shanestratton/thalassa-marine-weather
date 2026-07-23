import { beforeEach, describe, expect, it, vi } from 'vitest';

interface Deferred<T> {
    promise: Promise<T>;
    resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

const harness = vi.hoisted(() => ({
    preferences: {} as Record<string, string>,
    getCalls: [] as string[],
    setCalls: [] as Array<{ key: string; value: string }>,
    removeCalls: [] as string[],
    setGates: new Map<string, Array<Promise<void>>>(),
    removeGates: new Map<string, Array<Promise<void>>>(),
    fetch: vi.fn(),
}));

vi.mock('@capacitor/preferences', () => ({
    Preferences: {
        get: vi.fn(async ({ key }: { key: string }) => {
            harness.getCalls.push(key);
            return { value: harness.preferences[key] ?? null };
        }),
        set: vi.fn(async ({ key, value }: { key: string; value: string }) => {
            harness.setCalls.push({ key, value });
            const gates = harness.setGates.get(key);
            if (gates?.length) await gates.shift();
            harness.preferences[key] = value;
        }),
        remove: vi.fn(async ({ key }: { key: string }) => {
            harness.removeCalls.push(key);
            const gates = harness.removeGates.get(key);
            if (gates?.length) await gates.shift();
            delete harness.preferences[key];
        }),
    },
}));

const CLIENT_ID = 'thalassa-tests.apps.googleusercontent.com';
const REDIRECT_URI = 'com.googleusercontent.apps.thalassa-tests:/oauth2redirect';
const CREDENTIALS_BASE_KEY = 'calypso:gmail:credentials:v2';
const PENDING_BASE_KEY = 'calypso:gmail:oauth_pending:v2';
const LEGACY_KEYS = [
    'calypso:gmail:access_token',
    'calypso:gmail:refresh_token',
    'calypso:gmail:token_expiry',
    'calypso:gmail:email',
    'calypso:gmail:pkce_verifier',
    'calypso:gmail:oauth_state',
] as const;

type GmailModule = typeof import('../services/voice/integrations/gmail');
type IdentityModule = typeof import('../services/authIdentityScope');
type IdentityScope = ReturnType<IdentityModule['getAuthIdentityScope']>;

function jsonResponse(body: unknown, ok = true): Response {
    return {
        ok,
        status: ok ? 200 : 400,
        json: vi.fn(async () => body),
    } as unknown as Response;
}

function credentialEnvelope(scope: IdentityScope, email: string, expiresAt = Date.now() + 3_600_000) {
    return {
        version: 2,
        ownerKey: scope.key,
        ownerUserId: scope.userId,
        access: `access-${email}`,
        refresh: `refresh-${email}`,
        expiresAt,
        email,
        updatedAt: Date.now(),
    };
}

function resetHarness(): void {
    for (const key of Object.keys(harness.preferences)) delete harness.preferences[key];
    harness.getCalls.length = 0;
    harness.setCalls.length = 0;
    harness.removeCalls.length = 0;
    harness.setGates.clear();
    harness.removeGates.clear();
    harness.fetch.mockReset();
    harness.fetch.mockRejectedValue(new Error('Unexpected fetch'));
    vi.stubGlobal('fetch', harness.fetch);
}

async function freshModules(
    userId: string | null = 'account-a',
): Promise<{ gmail: GmailModule; identity: IdentityModule }> {
    vi.resetModules();
    vi.stubEnv('VITE_GOOGLE_OAUTH_CLIENT_ID', CLIENT_ID);
    const identity = await import('../services/authIdentityScope');
    identity.setAuthIdentityScope(userId);
    const gmail = await import('../services/voice/integrations/gmail');
    return { gmail, identity };
}

function scopedKey(identity: IdentityModule, base: string, scope: IdentityScope): string {
    return identity.authScopedStorageKey(base, scope);
}

function stateFromAuthorizationUrl(url: string): string {
    return new URL(url).searchParams.get('state') ?? '';
}

function callbackUrl(code: string, state: string): string {
    return `${REDIRECT_URI}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;
}

beforeEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    resetHarness();
});

describe('Gmail OAuth account and generation boundaries', () => {
    it('stores PKCE + state and credentials in exact owner-tagged account envelopes', async () => {
        const { gmail, identity } = await freshModules();
        const accountA = identity.getAuthIdentityScope();

        const authorizationUrl = await gmail.beginAuthorization();
        expect(authorizationUrl).not.toBeNull();
        const parsedAuthorizationUrl = new URL(authorizationUrl!);
        const state = parsedAuthorizationUrl.searchParams.get('state');
        expect(state).toHaveLength(43);
        expect(parsedAuthorizationUrl.searchParams.get('code_challenge_method')).toBe('S256');

        const pendingKey = scopedKey(identity, PENDING_BASE_KEY, accountA);
        const pending = JSON.parse(harness.preferences[pendingKey]);
        expect(pending).toMatchObject({
            version: 2,
            ownerKey: accountA.key,
            ownerUserId: 'account-a',
            generation: accountA.generation,
            state,
        });
        expect(pending.verifier.length).toBeGreaterThanOrEqual(43);

        harness.fetch
            .mockResolvedValueOnce(
                jsonResponse({
                    access_token: 'access-a',
                    refresh_token: 'refresh-a',
                    expires_in: 1800,
                }),
            )
            .mockResolvedValueOnce(jsonResponse({ email: 'a@example.com' }));

        await expect(gmail.completeAuthorization('code-a', state!)).resolves.toBe('a@example.com');
        expect(harness.preferences[pendingKey]).toBeUndefined();

        const credentialKey = scopedKey(identity, CREDENTIALS_BASE_KEY, accountA);
        expect(JSON.parse(harness.preferences[credentialKey])).toMatchObject({
            version: 2,
            ownerKey: accountA.key,
            ownerUserId: 'account-a',
            access: 'access-a',
            refresh: 'refresh-a',
            email: 'a@example.com',
        });

        identity.setAuthIdentityScope('account-b');
        await expect(gmail.getConnectedEmail()).resolves.toBeNull();
        identity.setAuthIdentityScope('account-a');
        await expect(gmail.getConnectedEmail()).resolves.toBe('a@example.com');
    });

    it('rejects anonymous OAuth and deletes unowned v1 secrets instead of assigning them to the next user', async () => {
        for (const key of LEGACY_KEYS) harness.preferences[key] = `legacy-${key}`;

        const { gmail, identity } = await freshModules(null);
        await expect(gmail.getConnectedEmail()).resolves.toBeNull();
        await expect(gmail.beginAuthorization()).resolves.toBeNull();

        for (const key of LEGACY_KEYS) expect(harness.preferences[key]).toBeUndefined();
        expect(
            harness.preferences[scopedKey(identity, CREDENTIALS_BASE_KEY, identity.getAuthIdentityScope())],
        ).toBeUndefined();

        identity.setAuthIdentityScope('account-a');
        await expect(gmail.isGmailConnected()).resolves.toBe(false);
        expect(Object.keys(harness.preferences)).toHaveLength(0);
    });

    it('clears only the initiating account while preserving another account credentials', async () => {
        const { gmail, identity } = await freshModules();
        const accountA = identity.getAuthIdentityScope();
        identity.setAuthIdentityScope('account-b');
        const accountB = identity.getAuthIdentityScope();

        const accountAKey = scopedKey(identity, CREDENTIALS_BASE_KEY, accountA);
        const accountBKey = scopedKey(identity, CREDENTIALS_BASE_KEY, accountB);
        harness.preferences[accountAKey] = JSON.stringify(credentialEnvelope(accountA, 'a@example.com'));
        harness.preferences[accountBKey] = JSON.stringify(credentialEnvelope(accountB, 'b@example.com'));

        identity.setAuthIdentityScope('account-a');
        await expect(gmail.clearGmailTokens()).resolves.toBe(true);
        expect(harness.preferences[accountAKey]).toBeUndefined();
        expect(harness.preferences[accountBKey]).toBeDefined();

        identity.setAuthIdentityScope('account-b');
        await expect(gmail.getConnectedEmail()).resolves.toBe('b@example.com');
    });

    it('synchronously hides account A credentials from anonymous and account B after logout', async () => {
        const { gmail, identity } = await freshModules();
        const accountA = identity.getAuthIdentityScope();
        harness.preferences[scopedKey(identity, CREDENTIALS_BASE_KEY, accountA)] = JSON.stringify(
            credentialEnvelope(accountA, 'a@example.com'),
        );
        await expect(gmail.getConnectedEmail()).resolves.toBe('a@example.com');

        identity.setAuthIdentityScope(null);
        await expect(gmail.getConnectedEmail()).resolves.toBeNull();
        await expect(gmail.searchEmails('', 5)).resolves.toMatchObject({ isError: true });
        identity.setAuthIdentityScope('account-b');
        await expect(gmail.getConnectedEmail()).resolves.toBeNull();
        expect(harness.fetch).not.toHaveBeenCalled();
    });

    it('rejects and quarantines an owner-mismatched envelope even when it is placed under the current key', async () => {
        const { gmail, identity } = await freshModules();
        const accountA = identity.getAuthIdentityScope();
        identity.setAuthIdentityScope('account-b');
        const accountB = identity.getAuthIdentityScope();
        identity.setAuthIdentityScope('account-a');
        const accountAKey = scopedKey(identity, CREDENTIALS_BASE_KEY, accountA);
        harness.preferences[accountAKey] = JSON.stringify(credentialEnvelope(accountB, 'b@example.com'));

        await expect(gmail.getConnectedEmail()).resolves.toBeNull();
        expect(harness.preferences[accountAKey]).toBeUndefined();
    });

    it('never retargets an A clear onto B when identity changes during an awaited bridge call', async () => {
        const legacyRemovalGate = deferred<void>();
        harness.removeGates.set(LEGACY_KEYS[0], [legacyRemovalGate.promise]);
        const { gmail, identity } = await freshModules();
        const accountA = identity.getAuthIdentityScope();
        identity.setAuthIdentityScope('account-b');
        const accountB = identity.getAuthIdentityScope();
        const accountAKey = scopedKey(identity, CREDENTIALS_BASE_KEY, accountA);
        const accountBKey = scopedKey(identity, CREDENTIALS_BASE_KEY, accountB);
        harness.preferences[accountAKey] = JSON.stringify(credentialEnvelope(accountA, 'a@example.com'));
        harness.preferences[accountBKey] = JSON.stringify(credentialEnvelope(accountB, 'b@example.com'));

        identity.setAuthIdentityScope('account-a');
        const pendingClear = gmail.clearGmailTokens();
        await vi.waitFor(() => expect(harness.removeCalls).toContain(LEGACY_KEYS[0]));

        identity.setAuthIdentityScope('account-b');
        legacyRemovalGate.resolve();

        await expect(pendingClear).resolves.toBe(false);
        expect(JSON.parse(harness.preferences[accountAKey]).email).toBe('a@example.com');
        expect(JSON.parse(harness.preferences[accountBKey]).email).toBe('b@example.com');
    });

    it('rejects forged, duplicate, lookalike, and cross-account callback state without consuming the valid flow', async () => {
        const { gmail, identity } = await freshModules();
        const aUrl = (await gmail.beginAuthorization())!;
        const aState = stateFromAuthorizationUrl(aUrl);

        expect(gmail.extractAuthCallbackFromUrl(callbackUrl('code-a', aState))).toEqual({
            code: 'code-a',
            state: aState,
        });
        expect(
            gmail.extractAuthCallbackFromUrl(`${callbackUrl('code-a', aState)}&state=${encodeURIComponent(aState)}`),
        ).toBeNull();
        expect(gmail.extractAuthCallbackFromUrl(`evil.${callbackUrl('code-a', aState)}`)).toBeNull();
        expect(gmail.extractAuthCallbackFromUrl(`${REDIRECT_URI}?error=access_denied&state=${aState}`)).toBeNull();

        await expect(
            gmail.completeAuthorization('forged-code', 'forged-state-that-is-long-enough'),
        ).resolves.toBeNull();
        expect(harness.fetch).not.toHaveBeenCalled();

        identity.setAuthIdentityScope('account-b');
        const bScope = identity.getAuthIdentityScope();
        const bUrl = (await gmail.beginAuthorization())!;
        const bState = stateFromAuthorizationUrl(bUrl);
        const bPendingKey = scopedKey(identity, PENDING_BASE_KEY, bScope);

        await expect(gmail.completeAuthorization('code-from-a', aState)).resolves.toBeNull();
        expect(harness.fetch).not.toHaveBeenCalled();
        expect(harness.preferences[bPendingKey]).toBeDefined();

        harness.fetch
            .mockResolvedValueOnce(
                jsonResponse({
                    access_token: 'access-b',
                    refresh_token: 'refresh-b',
                    expires_in: 3600,
                }),
            )
            .mockResolvedValueOnce(jsonResponse({ email: 'b@example.com' }));
        await expect(gmail.completeAuthorization('code-b', bState)).resolves.toBe('b@example.com');
    });

    it('aborts and discards an access-token refresh that resolves after A → B', async () => {
        const { gmail, identity } = await freshModules();
        const accountA = identity.getAuthIdentityScope();
        const credentialKey = scopedKey(identity, CREDENTIALS_BASE_KEY, accountA);
        harness.preferences[credentialKey] = JSON.stringify(
            credentialEnvelope(accountA, 'a@example.com', Date.now() - 1),
        );
        const refreshResponse = deferred<Response>();
        let refreshSignal: AbortSignal | undefined;
        harness.fetch.mockImplementationOnce((_input: RequestInfo | URL, init?: RequestInit) => {
            refreshSignal = init?.signal ?? undefined;
            return refreshResponse.promise;
        });

        const pendingSearch = gmail.searchEmails('is:unread', 5);
        await vi.waitFor(() => expect(harness.fetch).toHaveBeenCalledTimes(1));

        identity.setAuthIdentityScope('account-b');
        expect(refreshSignal?.aborted).toBe(true);
        refreshResponse.resolve(jsonResponse({ access_token: 'stale-access-a', expires_in: 3600 }));

        await expect(pendingSearch).resolves.toMatchObject({ isError: true });
        expect(harness.fetch).toHaveBeenCalledTimes(1);
        expect(JSON.parse(harness.preferences[credentialKey]).access).toBe('access-a@example.com');
        await expect(gmail.getConnectedEmail()).resolves.toBeNull();
    });

    it('prevents clear-during-refresh from resurrecting the disconnected account', async () => {
        const { gmail, identity } = await freshModules();
        const accountA = identity.getAuthIdentityScope();
        const credentialKey = scopedKey(identity, CREDENTIALS_BASE_KEY, accountA);
        harness.preferences[credentialKey] = JSON.stringify(
            credentialEnvelope(accountA, 'a@example.com', Date.now() - 1),
        );
        const refreshResponse = deferred<Response>();
        let refreshSignal: AbortSignal | undefined;
        harness.fetch.mockImplementationOnce((_input: RequestInfo | URL, init?: RequestInit) => {
            refreshSignal = init?.signal ?? undefined;
            return refreshResponse.promise;
        });

        const pendingSearch = gmail.searchEmails('', 5);
        await vi.waitFor(() => expect(harness.fetch).toHaveBeenCalledTimes(1));
        await expect(gmail.clearGmailTokens()).resolves.toBe(true);
        expect(refreshSignal?.aborted).toBe(true);
        refreshResponse.resolve(jsonResponse({ access_token: 'resurrected-access', expires_in: 3600 }));

        await expect(pendingSearch).resolves.toMatchObject({ isError: true });
        expect(harness.preferences[credentialKey]).toBeUndefined();
        await expect(gmail.isGmailConnected()).resolves.toBe(false);
    });

    it('aborts a callback exchange and never commits A credentials after switching to B', async () => {
        const { gmail, identity } = await freshModules();
        const accountA = identity.getAuthIdentityScope();
        const state = stateFromAuthorizationUrl((await gmail.beginAuthorization())!);
        const tokenResponse = deferred<Response>();
        let tokenSignal: AbortSignal | undefined;
        harness.fetch.mockImplementationOnce((_input: RequestInfo | URL, init?: RequestInit) => {
            tokenSignal = init?.signal ?? undefined;
            return tokenResponse.promise;
        });

        const completion = gmail.completeAuthorization('code-a', state);
        await vi.waitFor(() => expect(harness.fetch).toHaveBeenCalledTimes(1));

        identity.setAuthIdentityScope('account-b');
        const accountB = identity.getAuthIdentityScope();
        const accountBKey = scopedKey(identity, CREDENTIALS_BASE_KEY, accountB);
        harness.preferences[accountBKey] = JSON.stringify(credentialEnvelope(accountB, 'b@example.com'));
        expect(tokenSignal?.aborted).toBe(true);

        tokenResponse.resolve(
            jsonResponse({
                access_token: 'stale-access-a',
                refresh_token: 'stale-refresh-a',
                expires_in: 3600,
            }),
        );
        await expect(completion).resolves.toBeNull();
        expect(harness.fetch).toHaveBeenCalledTimes(1);
        expect(harness.preferences[scopedKey(identity, CREDENTIALS_BASE_KEY, accountA)]).toBeUndefined();
        expect(JSON.parse(harness.preferences[accountBKey]).email).toBe('b@example.com');
    });

    it('rolls back PKCE material if account A changes while its bridge write is in flight', async () => {
        const { gmail, identity } = await freshModules();
        const accountA = identity.getAuthIdentityScope();
        const pendingKey = scopedKey(identity, PENDING_BASE_KEY, accountA);
        const writeGate = deferred<void>();
        harness.setGates.set(pendingKey, [writeGate.promise]);

        const authorization = gmail.beginAuthorization();
        await vi.waitFor(() => expect(harness.setCalls.some((call) => call.key === pendingKey)).toBe(true));

        identity.setAuthIdentityScope('account-b');
        writeGate.resolve();

        await expect(authorization).resolves.toBeNull();
        expect(harness.preferences[pendingKey]).toBeUndefined();
        expect(harness.fetch).not.toHaveBeenCalled();
    });

    it('rolls back a credential bridge write if identity changes while the write is in flight', async () => {
        const { gmail, identity } = await freshModules();
        const accountA = identity.getAuthIdentityScope();
        const credentialKey = scopedKey(identity, CREDENTIALS_BASE_KEY, accountA);
        const state = stateFromAuthorizationUrl((await gmail.beginAuthorization())!);
        const writeGate = deferred<void>();
        harness.setGates.set(credentialKey, [writeGate.promise]);
        harness.fetch
            .mockResolvedValueOnce(
                jsonResponse({
                    access_token: 'access-a',
                    refresh_token: 'refresh-a',
                    expires_in: 3600,
                }),
            )
            .mockResolvedValueOnce(jsonResponse({ email: 'a@example.com' }));

        const completion = gmail.completeAuthorization('code-a', state);
        await vi.waitFor(() => expect(harness.setCalls.some((call) => call.key === credentialKey)).toBe(true));

        identity.setAuthIdentityScope('account-b');
        writeGate.resolve();
        await expect(completion).resolves.toBeNull();
        expect(harness.preferences[credentialKey]).toBeUndefined();
    });

    it('aborts an in-flight Gmail write and never returns A response data to B', async () => {
        const { gmail, identity } = await freshModules();
        const accountA = identity.getAuthIdentityScope();
        harness.preferences[scopedKey(identity, CREDENTIALS_BASE_KEY, accountA)] = JSON.stringify(
            credentialEnvelope(accountA, 'a@example.com'),
        );
        const sendResponse = deferred<Response>();
        let sendSignal: AbortSignal | undefined;
        harness.fetch.mockImplementationOnce((_input: RequestInfo | URL, init?: RequestInit) => {
            sendSignal = init?.signal ?? undefined;
            return sendResponse.promise;
        });

        const pendingSend = gmail.sendDraft('draft-a');
        await vi.waitFor(() => expect(harness.fetch).toHaveBeenCalledTimes(1));
        identity.setAuthIdentityScope('account-b');
        expect(sendSignal?.aborted).toBe(true);
        sendResponse.resolve(jsonResponse({ id: 'message-a', threadId: 'thread-a' }));

        const result = await pendingSend;
        expect(result).toMatchObject({ isError: true });
        expect(result.content).not.toContain('message-a');
        expect(result.content).not.toContain('thread-a');
    });

    it('rejects header/path injection and encodes Unicode drafts as UTF-8 base64url', async () => {
        const { gmail, identity } = await freshModules();
        const accountA = identity.getAuthIdentityScope();
        harness.preferences[scopedKey(identity, CREDENTIALS_BASE_KEY, accountA)] = JSON.stringify(
            credentialEnvelope(accountA, 'a@example.com'),
        );

        await expect(gmail.draftEmail('mate@example.com\r\nBcc: thief@example.com', 'Hello', 'Body')).resolves.toEqual(
            expect.objectContaining({ isError: true }),
        );
        await expect(gmail.draftEmail('mate@example.com', 'Hello\nBcc: thief@example.com', 'Body')).resolves.toEqual(
            expect.objectContaining({ isError: true }),
        );
        await expect(gmail.readEmail('../drafts')).resolves.toEqual(expect.objectContaining({ isError: true }));
        await expect(gmail.sendDraft('../../messages')).resolves.toEqual(expect.objectContaining({ isError: true }));
        await expect(gmail.searchEmails('from:mate@example.com\nin:anywhere', 5)).resolves.toEqual(
            expect.objectContaining({ isError: true }),
        );
        expect(harness.fetch).not.toHaveBeenCalled();

        harness.fetch.mockResolvedValueOnce(
            jsonResponse({
                id: 'draft-1',
                message: { id: 'message-1', threadId: 'thread-1' },
            }),
        );
        await expect(gmail.draftEmail('mate@example.com', 'Weather 🌊', 'G’day from Moreton Bay ⛵')).resolves.toEqual(
            expect.objectContaining({ isError: false }),
        );

        const init = harness.fetch.mock.calls[0][1] as RequestInit;
        const raw = (JSON.parse(String(init.body)) as { message: { raw: string } }).message.raw;
        const base64 = raw
            .replace(/-/g, '+')
            .replace(/_/g, '/')
            .padEnd(Math.ceil(raw.length / 4) * 4, '=');
        const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
        expect(new TextDecoder().decode(bytes)).toContain('Subject: Weather 🌊\r\n\r\nG’day from Moreton Bay ⛵');
    });
});
