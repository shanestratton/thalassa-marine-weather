/** Final SDK fetch-dispatch boundary. Cancellation hints are not Auth or crypto.
 * Private SDK calls cannot use CapacitorHttp's patched/proxied transport, which
 * does not honor AbortSignal. Original browser fetch/CORS needs device acceptance. */
import {
    isLegacyPrivateMessageAbortSignalOwned,
    isLegacyPrivateMessageAbortSignalCurrent,
    cancelLegacyPrivateMessageAbortSignal,
    PrivateMessageLegacyUnavailableError,
} from './privateMessageCutover';

const PRIVATE_PATHS = [
    '/rest/v1/chat_direct_messages',
    '/rest/v1/dm_blocks',
    '/rest/v1/rpc/get_chat_dm_block_status',
    '/rest/v1/rpc/set_chat_user_block',
    '/rest/v1/rpc/queue_dm_push',
];

export function createLegacyPrivateMessageFetchGate(options: {
    supabaseUrl: string;
    isNative: () => boolean;
    publicFetch: typeof fetch;
    /** Native must supply its preserved unpatched browser fetch, never Http/proxy. */
    getPrivateBrowserFetch: () => typeof fetch | null;
}): typeof fetch {
    const expectedOrigin = new globalThis.URL(options.supabaseUrl).origin;
    return ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        let signal: AbortSignal | null | undefined;
        let url: URL;
        let path: string;
        try {
            signal =
                init?.signal ?? (typeof Request !== 'undefined' && input instanceof Request ? input.signal : undefined);
            const value = typeof input === 'string' ? input : input instanceof globalThis.URL ? input.href : input.url;
            url = new globalThis.URL(value);
            path = decodeURIComponent(url.pathname).toLowerCase();
        } catch {
            if (signal) cancelLegacyPrivateMessageAbortSignal(signal);
            return Promise.reject(new PrivateMessageLegacyUnavailableError());
        }
        const privateRequest =
            isLegacyPrivateMessageAbortSignalOwned(signal) ||
            PRIVATE_PATHS.some((endpoint) => path === endpoint || path.startsWith(endpoint + '/'));
        if (!privateRequest) return options.publicFetch(input, init);
        const refuse = () => {
            if (signal) cancelLegacyPrivateMessageAbortSignal(signal);
            return Promise.reject(new PrivateMessageLegacyUnavailableError());
        };
        // The SDK supplies URL strings. Request bodies/headers would require
        // asynchronous copying, so unsupported private Request objects refuse.
        if (typeof Request !== 'undefined' && input instanceof Request) return refuse();
        if (url.origin !== expectedOrigin || !isLegacyPrivateMessageAbortSignalCurrent(signal)) return refuse();
        const originalUrl = url.href;
        let browserFetch: typeof fetch | null;
        let requestOptions: RequestInit;
        try {
            browserFetch = options.isNative() ? options.getPrivateBrowserFetch() : options.publicFetch;
            if (typeof browserFetch !== 'function') return refuse();
            // Capture SDK options without inspecting/logging plaintext or credentials.
            requestOptions = { ...init, signal };
        } catch {
            return refuse();
        }
        // Transport selection/options can invoke getters. ORIGINAL cancellation
        // must still hold in this last synchronous segment before browser dispatch.
        if (!isLegacyPrivateMessageAbortSignalCurrent(signal)) return refuse();
        return browserFetch(originalUrl, requestOptions);
    }) as typeof fetch;
}
