/** Real dispatch gate/core policy with synthetic browser/native transport.
 * No HTTP, CORS, physical WebView or server enforcement is executed. */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
let identity: typeof import('../services/authIdentityScope');
let policy: typeof import('../services/chat/e2ee/privateMessageCutover');
let createGate: typeof import('../services/chat/e2ee/legacyPrivateMessageFetchGate').createLegacyPrivateMessageFetchGate;
const origin = 'https://fixture.supabase.test';
const privateUrl = origin + '/rest/v1/chat_direct_messages?select=id';
let publicFetch: ReturnType<typeof vi.fn<typeof fetch>>, browserFetch: ReturnType<typeof vi.fn<typeof fetch>>;
beforeEach(async () => {
    vi.resetModules();
    identity = await import('../services/authIdentityScope');
    identity.setAuthIdentityScope('fetch-owner');
    policy = await import('../services/chat/e2ee/privateMessageCutover');
    ({ createLegacyPrivateMessageFetchGate: createGate } =
        await import('../services/chat/e2ee/legacyPrivateMessageFetchGate'));
    publicFetch = vi.fn<typeof fetch>(async () => new Response('{}'));
    browserFetch = vi.fn<typeof fetch>(async () => new Response('{}'));
});
afterEach(() => vi.restoreAllMocks());
function admitted() {
    const permit = policy.captureLegacyPrivateMessagePermit(identity.getAuthIdentityScope(), 'fetch-peer');
    const scope = policy.captureLegacyPrivateMessageAbortScope(permit);
    if (!scope) throw new Error('Synthetic request scope not admitted');
    return scope;
}
const gate = (native = true, getPrivateBrowserFetch = () => browserFetch as typeof fetch | null) =>
    createGate({
        supabaseUrl: origin,
        isNative: () => native,
        publicFetch,
        getPrivateBrowserFetch,
    });

describe('final legacy private SDK fetch dispatch gate', () => {
    it('uses direct preserved browser fetch, never patched native HTTP/proxy, for an admitted private request', async () => {
        const scope = admitted();
        await gate()(privateUrl, { method: 'POST', body: 'Synthetic private body', signal: scope.signal });
        expect(publicFetch).not.toHaveBeenCalled();
        expect(browserFetch).toHaveBeenCalledWith(privateUrl, expect.objectContaining({ signal: scope.signal }));
        scope.dispose();
    });
    it.each(['cutover', 'identity'] as const)(
        'refuses after a held SDK token lookup and %s before any transport dispatch',
        async (boundary) => {
            const scope = admitted(),
                fetch = gate();
            let release!: () => void;
            const token = new Promise<void>((done) => {
                release = done;
            });
            const work = (async () => {
                await token;
                return fetch(privateUrl, { signal: scope.signal });
            })();
            if (boundary === 'cutover') policy.requireNativePrivateMessagesForScope(identity.getAuthIdentityScope());
            else identity.setAuthIdentityScope('different-fetch-owner');
            release();
            await expect(work).rejects.toBeInstanceOf(policy.PrivateMessageLegacyUnavailableError);
            expect(publicFetch).not.toHaveBeenCalled();
            expect(browserFetch).not.toHaveBeenCalled();
            scope.dispose();
        },
    );
    it.each([undefined, new AbortController().signal] as const)(
        'refuses private endpoints without an ORIGINAL owned signal',
        async (signal) => {
            await expect(gate()(privateUrl, { signal })).rejects.toBeInstanceOf(
                policy.PrivateMessageLegacyUnavailableError,
            );
            expect(browserFetch).not.toHaveBeenCalled();
            expect(publicFetch).not.toHaveBeenCalled();
        },
    );
    it('refuses disposed owned scopes instead of falling back to native HTTP', async () => {
        const scope = admitted();
        scope.dispose();
        await expect(gate()(privateUrl, { signal: scope.signal })).rejects.toBeInstanceOf(
            policy.PrivateMessageLegacyUnavailableError,
        );
        expect(browserFetch).not.toHaveBeenCalled();
        expect(publicFetch).not.toHaveBeenCalled();
    });
    it('cancels original scope when native browser transport is missing, so SDK error wrapping cannot authorize queue fallback', async () => {
        const scope = admitted();
        await expect(gate(true, () => null)(privateUrl, { signal: scope.signal })).rejects.toBeInstanceOf(
            policy.PrivateMessageLegacyUnavailableError,
        );
        expect(scope.signal.aborted).toBe(true);
        expect(policy.isLegacyPrivateMessageAbortSignalCurrent(scope.signal)).toBe(false);
        expect(publicFetch).not.toHaveBeenCalled();
        scope.dispose();
    });
    it('rechecks after transport selection and refuses reentrant cutover', async () => {
        const scope = admitted();
        const fetch = gate(true, () => {
            policy.requireNativePrivateMessagesForScope(identity.getAuthIdentityScope());
            return browserFetch;
        });
        await expect(fetch(privateUrl, { signal: scope.signal })).rejects.toBeInstanceOf(
            policy.PrivateMessageLegacyUnavailableError,
        );
        expect(browserFetch).not.toHaveBeenCalled();
        scope.dispose();
    });
    it('pins URL bytes before mutable URL alias changes during transport selection', async () => {
        const scope = admitted(),
            url = new URL(privateUrl);
        const fetch = gate(true, () => {
            url.href = 'https://other.test/rest/v1/chat_direct_messages';
            return browserFetch;
        });
        await fetch(url, { signal: scope.signal });
        expect(browserFetch.mock.calls[0][0]).toBe(privateUrl);
        scope.dispose();
    });
    it('refuses a private request to another origin and cancels its original scope', async () => {
        const scope = admitted();
        await expect(
            gate()('https://other.test/rest/v1/chat_direct_messages', { signal: scope.signal }),
        ).rejects.toBeInstanceOf(policy.PrivateMessageLegacyUnavailableError);
        expect(scope.signal.aborted).toBe(true);
        expect(browserFetch).not.toHaveBeenCalled();
        scope.dispose();
    });
    it('keeps an owned profile query private even though that endpoint also serves public callers', async () => {
        const scope = admitted();
        await gate()(origin + '/rest/v1/chat_profiles', { signal: scope.signal });
        expect(browserFetch).toHaveBeenCalledOnce();
        expect(publicFetch).not.toHaveBeenCalled();
        scope.dispose();
    });
    it.each(['/auth/v1/user', '/rest/v1/chat_messages', '/rest/v1/rpc/guardian_disarm'])(
        'preserves ordinary transport for nonprivate %s after cutover',
        async (path) => {
            policy.requireNativePrivateMessagesForScope(identity.getAuthIdentityScope());
            await gate()(origin + path, { method: 'POST', body: 'Synthetic public/safety control' });
            expect(publicFetch).toHaveBeenCalledOnce();
            expect(browserFetch).not.toHaveBeenCalled();
        },
    );
});
