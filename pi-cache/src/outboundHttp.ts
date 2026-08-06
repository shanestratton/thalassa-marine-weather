/**
 * Server-side outbound HTTP policy.
 *
 * Chart vendors commonly redirect signed download links across public CDNs, so
 * a fixed provider allowlist would break legitimate installs. Instead we pin
 * each connection to an address resolved and checked at connect time, then
 * repeat the full policy for every redirect hop. Private boat-LAN upstreams
 * remain available only through an exact, startup-owned origin allowlist.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import {
    Agent,
    Headers,
    buildConnector,
    fetch as undiciFetch,
    type Dispatcher,
    type RequestInit,
    type Response,
} from 'undici';
import { UNSAFE_ADMIN_FLAG } from './publicBetaBoundary.js';

export const PRIVATE_UPSTREAM_ORIGINS_FLAG = 'THALASSA_UNSAFE_PRIVATE_UPSTREAM_ORIGINS';
export const UNSAFE_SUPABASE_ORIGINS_FLAG = 'THALASSA_UNSAFE_SUPABASE_ORIGINS';
export const DEFAULT_THALASSA_SUPABASE_ORIGIN = 'https://pcisdplnodrphauixcau.supabase.co';

const MAX_URL_LENGTH = 4_096;
const DEFAULT_MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const METADATA_HOSTNAMES = new Set([
    'metadata',
    'metadata.google.internal',
    'metadata.azure.internal',
    'instance-data',
]);

const alwaysBlocked = new BlockList();
for (const [network, prefix] of [
    ['0.0.0.0', 8],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['192.0.0.0', 24],
    ['192.0.2.0', 24],
    ['198.18.0.0', 15],
    ['198.51.100.0', 24],
    ['203.0.113.0', 24],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
] as const) {
    alwaysBlocked.addSubnet(network, prefix, 'ipv4');
}
// Alibaba Cloud's metadata endpoint sits inside the otherwise opt-in CGNAT
// range, so keep it non-overridable alongside link-local metadata ranges.
alwaysBlocked.addAddress('100.100.100.200', 'ipv4');
for (const [network, prefix] of [
    ['::', 128],
    ['::1', 128],
    // IPv4-compatible and translation/tunnelling prefixes can encode a
    // loopback or metadata IPv4 destination inside an apparently IPv6 URL.
    ['::', 96],
    ['64:ff9b::', 96],
    ['64:ff9b:1::', 48],
    ['2001::', 32],
    ['2002::', 16],
    ['3ffe::', 16],
    ['fe80::', 10],
    ['fec0::', 10],
    ['ff00::', 8],
    ['2001:2::', 48],
    ['2001:10::', 28],
    ['2001:20::', 28],
    ['2001:db8::', 32],
    ['3fff::', 20],
] as const) {
    alwaysBlocked.addSubnet(network, prefix, 'ipv6');
}
// AWS IMDS IPv6 endpoint.
alwaysBlocked.addAddress('fd00:ec2::254', 'ipv6');
// Google Compute Engine IMDS IPv6 endpoint. It remains forbidden even when an
// exact private origin has been enabled for an unrelated boat-LAN service.
alwaysBlocked.addAddress('fd20:ce::254', 'ipv6');

const privateOrCarrierRange = new BlockList();
for (const [network, prefix] of [
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['172.16.0.0', 12],
    ['192.168.0.0', 16],
] as const) {
    privateOrCarrierRange.addSubnet(network, prefix, 'ipv4');
}
privateOrCarrierRange.addSubnet('fc00::', 7, 'ipv6');

// Currently assigned public IPv6 unicast space is 2000::/3. Rejecting other
// non-global families by default closes future translation/reserved-prefix
// variants without weakening the explicit ULA exception above.
const globalIpv6Unicast = new BlockList();
globalIpv6Unicast.addSubnet('2000::', 3, 'ipv6');

export interface ResolvedAddress {
    address: string;
    family: 4 | 6;
}

export type AddressResolver = (hostname: string) => Promise<readonly ResolvedAddress[]>;

function stripIpv6Brackets(hostname: string): string {
    return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

function canonicalHostname(hostname: string): string {
    const unbracketed = stripIpv6Brackets(hostname).toLowerCase();
    return isIP(unbracketed) === 0 ? unbracketed.replace(/\.+$/, '') : unbracketed;
}

function hasControlCharacters(value: string): boolean {
    return [...value].some((character) => {
        const code = character.charCodeAt(0);
        return code <= 31 || code === 127;
    });
}

/** Parse and canonicalise an HTTP(S) URL without performing DNS. */
export function normaliseOutboundHttpUrl(value: string | URL): URL {
    const raw = value instanceof URL ? value.href : value;
    if (!raw || raw.length > MAX_URL_LENGTH || hasControlCharacters(raw)) {
        throw new Error('Outbound URL is empty, oversized, or contains control characters');
    }

    let parsed: URL;
    try {
        parsed = new URL(raw);
    } catch {
        throw new Error('Outbound URL is invalid');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('Only http/https outbound URLs are allowed');
    }
    if (parsed.username || parsed.password || !parsed.hostname) {
        throw new Error('Credentialed or hostless outbound URLs are not allowed');
    }

    const hostname = canonicalHostname(parsed.hostname);
    if (!hostname || METADATA_HOSTNAMES.has(hostname)) {
        throw new Error('Metadata service destinations are not allowed');
    }
    parsed.hostname = hostname;
    return parsed;
}

/** Exact origin parser used only for local startup policy, never HTTP input. */
export function normaliseExactHttpOrigin(value: string): string {
    const parsed = normaliseOutboundHttpUrl(value.trim());
    if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
        throw new Error('Configured upstream origins must not contain a path, query, or fragment');
    }
    return parsed.origin;
}

function exactOriginsFromFlag(raw: string | undefined): ReadonlySet<string> {
    const origins = new Set<string>();
    for (const candidate of (raw ?? '').split(',')) {
        const value = candidate.trim();
        if (!value || value === '*') continue;
        try {
            origins.add(normaliseExactHttpOrigin(value));
        } catch {
            // Invalid startup entries are ignored rather than widening policy.
        }
    }
    return origins;
}

/** Private destinations require both unsafe-admin mode and an exact origin. */
export function configuredPrivateUpstreamOrigins(env: NodeJS.ProcessEnv = process.env): ReadonlySet<string> {
    if (env[UNSAFE_ADMIN_FLAG] !== '1') return new Set();
    return exactOriginsFromFlag(env[PRIVATE_UPSTREAM_ORIGINS_FLAG]);
}

/**
 * Supabase authority is selected at process startup. HTTP configuration may
 * assert this value, but can never add or switch an origin at runtime.
 */
export function trustedSupabaseOrigins(env: NodeJS.ProcessEnv = process.env): ReadonlySet<string> {
    const origins = new Set<string>([DEFAULT_THALASSA_SUPABASE_ORIGIN]);
    if (env[UNSAFE_ADMIN_FLAG] === '1') {
        for (const origin of exactOriginsFromFlag(env[UNSAFE_SUPABASE_ORIGINS_FLAG])) origins.add(origin);
    }
    return origins;
}

export function resolveTrustedSupabaseOrigin(
    configured: string | undefined,
    env: NodeJS.ProcessEnv = process.env,
): string {
    const candidate = normaliseExactHttpOrigin(configured?.trim() || DEFAULT_THALASSA_SUPABASE_ORIGIN);
    if (!trustedSupabaseOrigins(env).has(candidate)) {
        throw new Error(
            `SUPABASE_URL must be the Thalassa production origin or an exact ${UNSAFE_SUPABASE_ORIGINS_FLAG} startup origin`,
        );
    }
    return candidate;
}

export function assertSupabaseOriginAssertion(value: unknown, trustedOrigin: string): void {
    if (value === undefined || value === '') return;
    if (typeof value !== 'string' || normaliseExactHttpOrigin(value) !== trustedOrigin) {
        throw new Error('The app Supabase origin does not match the Pi startup trust anchor');
    }
}

/** Pure address policy, exported for deterministic unit tests. */
export function assertAddressAllowed(address: string, allowPrivate: boolean): void {
    const normalized = stripIpv6Brackets(address).toLowerCase();
    const family = isIP(normalized);
    if (family !== 4 && family !== 6) throw new Error('DNS returned a non-IP address');
    const type = family === 4 ? 'ipv4' : 'ipv6';
    if (alwaysBlocked.check(normalized, type)) {
        throw new Error('Outbound destination resolves to a loopback, metadata, link-local, or reserved address');
    }
    if (!allowPrivate && privateOrCarrierRange.check(normalized, type)) {
        throw new Error('Outbound destination resolves to a private or carrier-grade address');
    }
    if (
        family === 6 &&
        !privateOrCarrierRange.check(normalized, 'ipv6') &&
        !globalIpv6Unicast.check(normalized, 'ipv6')
    ) {
        throw new Error('Outbound destination resolves to a non-global IPv6 address');
    }
}

function assertLiteralTargetAllowed(url: URL, allowPrivate: boolean): void {
    const hostname = stripIpv6Brackets(url.hostname);
    if (isIP(hostname) !== 0) assertAddressAllowed(hostname, allowPrivate);
}

const systemResolver: AddressResolver = async (hostname) => {
    const normalized = canonicalHostname(hostname);
    const literalFamily = isIP(normalized);
    if (literalFamily === 4 || literalFamily === 6) {
        return [{ address: normalized, family: literalFamily }];
    }
    // The Pi deliberately uses IPv4 for hostname fetches: most boat networks
    // have no routed IPv6 and Node's AAAA-first attempts cause long timeouts.
    const answers = await dnsLookup(normalized, { all: true, family: 4, verbatim: true });
    return answers.map(({ address, family }) => ({ address, family: family as 4 | 6 }));
};

/** Resolve once at connection time, reject mixed private/public answers, pin one safe address. */
export async function resolvePinnedAddress(
    hostname: string,
    allowPrivate: boolean,
    resolver: AddressResolver = systemResolver,
): Promise<ResolvedAddress> {
    const normalized = canonicalHostname(hostname);
    if (!normalized || METADATA_HOSTNAMES.has(normalized)) {
        throw new Error('Metadata service destinations are not allowed');
    }
    const answers = await resolver(normalized);
    if (answers.length === 0) throw new Error('Outbound hostname did not resolve');
    for (const answer of answers) assertAddressAllowed(answer.address, allowPrivate);
    return answers[0];
}

type Connector = ReturnType<typeof buildConnector>;

export function createPinnedConnector(
    allowPrivate: boolean,
    resolver: AddressResolver = systemResolver,
    connect: Connector = buildConnector({}),
): Connector {
    return (options, callback) => {
        const originalHostname = canonicalHostname(options.hostname);
        void resolvePinnedAddress(originalHostname, allowPrivate, resolver)
            .then(({ address }) => {
                connect(
                    {
                        ...options,
                        hostname: address,
                        host: address,
                        ...(options.protocol === 'https:' && isIP(originalHostname) === 0
                            ? { servername: options.servername || originalHostname }
                            : {}),
                    },
                    callback,
                );
            })
            .catch((error: unknown) => {
                callback(error instanceof Error ? error : new Error(String(error)), null);
            });
    };
}

let publicDispatcher: Dispatcher | undefined;
let privateDispatcher: Dispatcher | undefined;

function productionDispatcher(allowPrivate: boolean): Dispatcher {
    if (allowPrivate) {
        privateDispatcher ??= new Agent({ connect: createPinnedConnector(true) });
        return privateDispatcher;
    }
    publicDispatcher ??= new Agent({ connect: createPinnedConnector(false) });
    return publicDispatcher;
}

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface OutboundFetchRuntime {
    request: FetchLike;
    privateOrigins: () => ReadonlySet<string>;
    dispatcher: (allowPrivate: boolean) => Dispatcher | undefined;
}

const productionRuntime: OutboundFetchRuntime = {
    request: undiciFetch,
    privateOrigins: () => configuredPrivateUpstreamOrigins(),
    dispatcher: productionDispatcher,
};

const SAFE_CROSS_ORIGIN_REDIRECT_HEADERS = new Set([
    'accept',
    'accept-encoding',
    'accept-language',
    'cache-control',
    'if-modified-since',
    'if-none-match',
    'pragma',
    'range',
    'user-agent',
]);

function hasNonSafelistedRedirectHeaders(init: RequestInit): boolean {
    const headers = new Headers(init.headers);
    return [...headers.keys()].some((name) => !SAFE_CROSS_ORIGIN_REDIRECT_HEADERS.has(name));
}

/**
 * Create a fetcher so redirect behavior can be tested without external I/O.
 * Production always uses the pinned dispatcher above.
 */
export function createOutboundFetcher(runtime: OutboundFetchRuntime = productionRuntime): FetchLike {
    return async (input, init = {}) => {
        let current = normaliseOutboundHttpUrl(input);
        const privateOrigins = runtime.privateOrigins();
        const method = (init.method ?? 'GET').toUpperCase();
        const canRedirect = method === 'GET' || method === 'HEAD';
        const hasRestrictedRedirectHeaders = hasNonSafelistedRedirectHeaders(init);
        const requestInit = { ...init };
        // Callers cannot replace the pinned connector or re-enable automatic
        // redirect following around this policy.
        delete requestInit.dispatcher;
        delete requestInit.redirect;

        for (let redirects = 0; ; redirects += 1) {
            const allowPrivate = privateOrigins.has(current.origin);
            assertLiteralTargetAllowed(current, allowPrivate);
            const dispatcher = runtime.dispatcher(allowPrivate);
            const response = await runtime.request(current, {
                ...requestInit,
                redirect: 'manual',
                ...(dispatcher ? { dispatcher } : {}),
            });
            if (!REDIRECT_STATUSES.has(response.status)) return response;

            const location = response.headers.get('location');
            if (response.body) await response.body.cancel().catch(() => undefined);
            if (!location) throw new Error(`Outbound redirect from ${current.origin} omitted Location`);
            if (!canRedirect) throw new Error('Outbound redirects are not allowed for non-idempotent requests');
            if (redirects >= DEFAULT_MAX_REDIRECTS) throw new Error('Outbound redirect limit exceeded');

            const next = normaliseOutboundHttpUrl(new URL(location, current));
            if (hasRestrictedRedirectHeaders && next.origin !== current.origin) {
                throw new Error('Outbound requests with non-safelisted headers may not redirect across origins');
            }
            // The next loop chooses a new public/private dispatcher and resolves
            // again at connect time, closing public-to-private redirect SSRF.
            current = next;
        }
    };
}

export const outboundFetch = createOutboundFetcher();
