/**
 * Server-side research adapter, deliberately unwired from the application.
 * The host supplies one trusted Supabase project origin and a PUBLIC API key.
 * Each credential is checked with that project's Auth server afresh; neither
 * local JWT claims, user metadata nor a shared Supabase session select actors.
 * Mock transport tests do not establish live Auth or production readiness.
 * https://supabase.com/docs/guides/auth/jwts
 */
export interface SupabaseResearchAuthConfig {
    readonly supabaseUrl: string;
    readonly publicApiKey: string;
    readonly fetch?: typeof globalThis.fetch;
    readonly timeoutMs?: number;
}

const MAX_CREDENTIAL_BYTES = 8192;
const MAX_RESPONSE_BYTES = 512 * 1024;
const BEARER = /^[A-Za-z0-9._~+/-]+=*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const invalidConfig = (): never => {
    throw new Error('Invalid research Supabase Auth configuration');
};

function safeBearer(value: unknown): value is string {
    // Restrict to RFC 6750 bearer characters, rejecting whitespace, control
    // characters and non-ASCII input before it can enter any request header.
    return (
        typeof value === 'string' &&
        value.length > 0 &&
        value.length <= MAX_CREDENTIAL_BYTES &&
        BEARER.exec(value)?.[0] === value
    );
}

function isPublicApiKey(value: unknown): value is string {
    if (!safeBearer(value)) return false;
    if (value.startsWith('sb_publishable_')) return value.length > 'sb_publishable_'.length;
    // Older projects use JWT-shaped anon keys. Decode only this trusted CONFIG
    // field to reject accidental service_role keys; it never authenticates a
    // user, and no user credential or user claims are decoded locally.
    try {
        const parts = value.split('.');
        if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) return false;
        const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
        const payload: unknown = JSON.parse(globalThis.atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')));
        return (
            !!payload &&
            typeof payload === 'object' &&
            !Array.isArray(payload) &&
            (payload as Record<string, unknown>).role === 'anon'
        );
    } catch {
        return false;
    }
}

function projectEndpoint(value: unknown): string {
    if (typeof value !== 'string') return invalidConfig();
    try {
        const url = new URL(value);
        if (
            url.protocol !== 'https:' ||
            url.username ||
            url.password ||
            url.search ||
            url.hash ||
            url.pathname !== '/' ||
            (value !== url.origin && value !== `${url.origin}/`)
        )
            return invalidConfig();
        return `${url.origin}/auth/v1/user`;
    } catch {
        return invalidConfig();
    }
}

async function boundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
    if (response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
        throw new Error('Invalid Auth response');
    }
    const declaredLength = response.headers.get('content-length');
    if (
        declaredLength !== null &&
        (!/^(0|[1-9][0-9]*)$/.test(declaredLength) || Number(declaredLength) > MAX_RESPONSE_BYTES)
    )
        throw new Error('Invalid Auth response');
    if (!response.body) throw new Error('Invalid Auth response');

    const reader = response.body.getReader();
    const cancel = () => {
        void reader.cancel().catch(() => undefined);
    };
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let complete = false;
    let received = 0;
    let serialized = '';
    signal.addEventListener('abort', cancel, { once: true });
    try {
        for (;;) {
            if (signal.aborted) throw new Error('Auth request unavailable');
            const { done, value } = await reader.read();
            if (signal.aborted) throw new Error('Auth request unavailable');
            if (done) break;
            if (!(value instanceof Uint8Array)) throw new Error('Invalid Auth response');
            received += value.byteLength;
            if (received > MAX_RESPONSE_BYTES) throw new Error('Invalid Auth response');
            serialized += decoder.decode(value, { stream: true });
        }
        serialized += decoder.decode();
        const parsed: unknown = JSON.parse(serialized);
        complete = true;
        return parsed;
    } finally {
        signal.removeEventListener('abort', cancel);
        if (!complete) cancel();
        reader.releaseLock();
    }
}

/** Fresh server-confirmed user identity only; every operational failure is null. */
export function createSupabaseResearchAuthenticator(
    config: SupabaseResearchAuthConfig,
): (credential: string) => Promise<{ userId: string } | null> {
    if (!config || typeof config !== 'object') return invalidConfig();
    const endpoint = projectEndpoint(config.supabaseUrl);
    const publicApiKey = config.publicApiKey;
    const fetchRequest = config.fetch === undefined ? globalThis.fetch : config.fetch;
    const timeoutMs = config.timeoutMs === undefined ? 5000 : config.timeoutMs;
    if (
        !isPublicApiKey(publicApiKey) ||
        typeof fetchRequest !== 'function' ||
        !Number.isSafeInteger(timeoutMs) ||
        timeoutMs < 1 ||
        timeoutMs > 10_000
    )
        return invalidConfig();

    return async (credential) => {
        if (!safeBearer(credential)) return null;
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const expired = new Promise<null>((resolve) => {
            timer = setTimeout(() => {
                controller.abort();
                resolve(null);
            }, timeoutMs);
        });
        const authenticate = async (): Promise<{ userId: string } | null> => {
            const response = await fetchRequest(endpoint, {
                method: 'GET',
                headers: {
                    Accept: 'application/json',
                    Authorization: `Bearer ${credential}`,
                    apikey: publicApiKey,
                },
                cache: 'no-store',
                redirect: 'error',
                credentials: 'omit',
                signal: controller.signal,
            });
            try {
                if (
                    controller.signal.aborted ||
                    response.status !== 200 ||
                    response.redirected ||
                    (response.url && response.url !== endpoint)
                )
                    return null;
                const user = await boundedJson(response, controller.signal);
                if (
                    controller.signal.aborted ||
                    !user ||
                    typeof user !== 'object' ||
                    Array.isArray(user) ||
                    !Object.hasOwn(user, 'id')
                )
                    return null;
                const id = (user as Record<string, unknown>).id;
                // Extra Auth response fields are ignored, including editable
                // metadata, roles and any body actor or claimed user identity.
                return typeof id === 'string' && UUID.exec(id)?.[0] === id ? Object.freeze({ userId: id }) : null;
            } finally {
                // Reject unconsumed bodies too (for example an invalid media
                // type or declared length), without waiting for cancellation.
                void response.body?.cancel().catch(() => undefined);
            }
        };
        try {
            // Also bound fetch/body implementations that ignore AbortSignal.
            return await Promise.race([authenticate(), expired]);
        } catch {
            return null;
        } finally {
            clearTimeout(timer);
            controller.abort();
        }
    };
}
