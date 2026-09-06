/** Public-beta defaults for the optional pinned-TLS Pi service. */

export const UNSAFE_ADMIN_FLAG = 'THALASSA_UNSAFE_ADMIN_API';
export const APP_API_FLAG = 'THALASSA_PI_APP_API';
export const LAN_BIND_FLAG = 'THALASSA_PI_LAN_BIND';
export const CORS_ORIGINS_FLAG = 'THALASSA_CORS_ORIGINS';
/**
 * The operator's declaration of what this Pi's uplink IS. The Pi cannot tell a
 * satellite link from ordinary internet on its own, so by default it shuts its
 * internet gate on every restart until a phone re-applies the skipper's policy
 * (see DiaryRelayOutbox). A boat whose Pi only ever talks through a 4G router
 * can say so here and keep the gate open across restarts; a boat on a satellite
 * link can pin it shut. Anything else is "undeclared" — the safe default.
 * (Shane 2026-09-07: "then Tailscale becomes a pure convenience for you".)
 */
export const WAN_UPLINK_FLAG = 'THALASSA_PI_WAN_UPLINK';
export type DeclaredWanUplink = 'ordinary' | 'satellite';

export function declaredWanUplink(env: NodeJS.ProcessEnv = process.env): DeclaredWanUplink | null {
    const raw = (env[WAN_UPLINK_FLAG] ?? '').trim().toLowerCase();
    if (raw === 'ordinary' || raw === 'internet' || raw === '4g' || raw === 'lte' || raw === 'cellular')
        return 'ordinary';
    if (raw === 'satellite' || raw === 'sat') return 'satellite';
    return null;
}

export const ADMIN_API_DISABLED_CODE = 'PI_ADMIN_API_DISABLED';
export const APP_API_DISABLED_CODE = 'PI_APP_API_DISABLED';

export function unsafeAdminApiEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    return env[UNSAFE_ADMIN_FLAG] === '1';
}

/**
 * The routes the APP needs to work at all: pairing, ENC charts, the OSM
 * overlay and the diary relay.
 *
 * Split out of UNSAFE_ADMIN_API on 2026-08-07. Those four sat behind the same
 * flag as `/api/misc/proxy` (an unbounded outbound proxy), the raster-chart
 * download/delete API and a 100 MB JSON body limit — so the only way to pair a
 * phone with a Pi was to also expose all of that, on a flag whose own error
 * message says "only on an isolated trusted boat LAN". Pairing and chart sync
 * are the product, not administration.
 *
 * DEFAULTS ON, unlike every other flag here, and the asymmetry is deliberate:
 *   • Network exposure is already gated by LAN_BIND, which is opt-in and off
 *     by default. Mounted routes on a loopback-only server reach nobody.
 *   • These routes are defended in their own right — TLS with a pinned
 *     self-signed cert, TOFU pairing, and a per-payload signature.
 *   • Defaulting it off would repeat the exact trap this replaces: a flag
 *     added after a Pi was installed is absent from that Pi's .env, so the
 *     next redeploy silently switches the feature off while everything still
 *     reports healthy. Shane lost an hour to that on 2026-08-07.
 * Opt OUT explicitly with THALASSA_PI_APP_API=0.
 */
export function appApiEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    return env[APP_API_FLAG] !== '0';
}

export function appApiDisabledPayload(): { status: string; code: string; error: string } {
    return {
        status: 'disabled',
        code: APP_API_DISABLED_CODE,
        error: 'Pi app routes are disabled. Unset THALASSA_PI_APP_API (or set it to 1) to allow pairing and chart sync.',
    };
}

export function resolveBindHost(env: NodeJS.ProcessEnv = process.env): '127.0.0.1' | '0.0.0.0' {
    return env[LAN_BIND_FLAG] === '1' ? '0.0.0.0' : '127.0.0.1';
}

/**
 * Exact browser-origin allowlist. Empty means same-origin/non-browser clients
 * only. Wildcards, credentials, paths, and malformed origins are discarded.
 */
export function allowedCorsOrigins(env: NodeJS.ProcessEnv = process.env): ReadonlySet<string> {
    const raw = env[CORS_ORIGINS_FLAG] ?? '';
    const origins = raw
        .split(',')
        .map((value) => value.trim())
        .filter((value) => value.length > 0 && value !== '*')
        .flatMap((value): string[] => {
            if (value === 'capacitor://localhost' || value === 'ionic://localhost') return [value];
            try {
                const parsed = new URL(value);
                if (!['http:', 'https:'].includes(parsed.protocol)) return [];
                if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
                    return [];
                }
                return [parsed.origin];
            } catch {
                return [];
            }
        });
    return new Set(origins);
}

export interface PublicCacheStats {
    kvEntries: number;
    tileEntries: number;
    kvFresh: number;
    tileFresh: number;
    dbSizeMB: number;
}

/**
 * Intentionally excludes prefetch coordinates/user IDs, Pi identity, relay
 * owner/configuration, operation IDs, queue detail, paths, and credentials.
 */
export function publicStatusPayload(options: {
    uptime: number;
    cache: PublicCacheStats;
    bindHost: '127.0.0.1' | '0.0.0.0';
    unsafeAdminEnabled: boolean;
    /** Whether the boat is publishing its instruments to the cloud, and how it last went. No identities. */
    telemetry?: { publishing: boolean; lastOutcome: string | null; lastSentAt: number | null };
}): Record<string, unknown> {
    return {
        status: 'ok',
        service: 'thalassa-pi-cache',
        uptime: options.uptime,
        mode: 'public-beta-safe',
        network: { lanOptIn: options.bindHost === '0.0.0.0' },
        capabilities: {
            fixedProviderCache: true,
            unsafeAdminApi: options.unsafeAdminEnabled,
        },
        cache: options.cache,
        ...(options.telemetry ? { telemetry: options.telemetry } : {}),
    };
}

export function adminApiDisabledPayload(): { status: 'disabled'; code: string; error: string } {
    return {
        status: 'disabled',
        code: ADMIN_API_DISABLED_CODE,
        error: `Pi admin/private routes are disabled. Set ${UNSAFE_ADMIN_FLAG}=1 only on an isolated trusted boat LAN.`,
    };
}
