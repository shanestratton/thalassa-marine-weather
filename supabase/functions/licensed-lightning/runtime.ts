import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import type { LightningPorts } from './handler.ts';
export interface LightningEnvironment {
    get(name: string): string | undefined;
}
/** Shared admission and atomic request budget for explicit reads and the service-only watch. */
export function lightningRuntime(
    authorize: LightningPorts['authorize'],
    env: LightningEnvironment,
    fetcher: typeof fetch = fetch,
    now = Date.now,
): LightningPorts {
    return {
        authorize,
        reserve: async () => {
            const limit = Number(env.get('LIGHTNING_MAX_REQUESTS_DAY'));
            const burst = Number(env.get('LIGHTNING_MAX_REQUESTS_MINUTE'));
            const url = env.get('SUPABASE_URL'), key = env.get('SUPABASE_SERVICE_ROLE_KEY');
            if (
                !url || !key || !Number.isInteger(limit) || limit < 1 || limit > 2880 ||
                !Number.isInteger(burst) || burst < 1 || burst > 10
            ) return false;
            const clientHash = [
                ...new Uint8Array(
                    await crypto.subtle.digest(
                        'SHA-256',
                        new TextEncoder().encode('thalassa-licensed-lightning-global-v1'),
                    ),
                ),
            ]
                .map((byte) => byte.toString(16).padStart(2, '0')).join('');
            const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
            // Existing service-only, row-locked quota RPC. Failed/aborted reads stay reserved;
            // no refund/retry can reset the shared cost ceiling.
            for (
                const [bucket, ceiling, seconds] of [
                    ['lightning_global_day', limit, 86400],
                    ['lightning_global_minute', burst, 60],
                ] as const
            ) {
                const { data, error } = await admin.rpc('consume_public_edge_quota', {
                    p_bucket: bucket,
                    p_client_hash: clientHash,
                    p_limit: ceiling,
                    p_window_seconds: seconds,
                });
                if (error || data !== true) return false;
            }
            return true;
        },
        admission: () => {
            // A saved historical API key alone never establishes present redistribution/push rights.
            if (env.get('LIGHTNING_LICENSE_ADMISSION') !== 'xweather-display-push-v1') return null;
            const clientId = env.get('XWEATHER_CLIENT_ID'), secret = env.get('XWEATHER_CLIENT_SECRET');
            const expiresAt = Number(env.get('LIGHTNING_LICENSE_EXPIRES_MS'));
            return clientId && secret ? { clientId, secret, expiresAt, display: true, push: true } : null;
        },
        fetch: fetcher,
        now,
    };
}
