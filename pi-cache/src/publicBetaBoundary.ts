/** Public-beta defaults for the optional Pi HTTP service. */

export const UNSAFE_ADMIN_FLAG = 'THALASSA_UNSAFE_ADMIN_API';
export const LAN_BIND_FLAG = 'THALASSA_PI_LAN_BIND';
export const CORS_ORIGINS_FLAG = 'THALASSA_CORS_ORIGINS';

export const ADMIN_API_DISABLED_CODE = 'PI_ADMIN_API_DISABLED';

export function unsafeAdminApiEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    return env[UNSAFE_ADMIN_FLAG] === '1';
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
    };
}

export function adminApiDisabledPayload(): { status: 'disabled'; code: string; error: string } {
    return {
        status: 'disabled',
        code: ADMIN_API_DISABLED_CODE,
        error: `Pi admin/private routes are disabled. Set ${UNSAFE_ADMIN_FLAG}=1 only for explicit unsafe development.`,
    };
}
