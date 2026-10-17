import { requireAuthenticatedQuota } from '../_shared/auth-rate-limit.ts';
import { handleLicensedLightning } from './handler.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

Deno.serve((request) =>
    handleLicensedLightning(request, {
        authorize: async (req) => {
            const caller = await requireAuthenticatedQuota(req, 'licensed-lightning', 12, 3600);
            return caller instanceof Response ? caller : null;
        },
        reserve: async () => {
            const limit = Number(Deno.env.get('LIGHTNING_MAX_REQUESTS_DAY'));
            const burst = Number(Deno.env.get('LIGHTNING_MAX_REQUESTS_MINUTE'));
            const url = Deno.env.get('SUPABASE_URL'), key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
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
            if (Deno.env.get('LIGHTNING_LICENSE_ADMISSION') !== 'xweather-display-push-v1') return null;
            const clientId = Deno.env.get('XWEATHER_CLIENT_ID'), secret = Deno.env.get('XWEATHER_CLIENT_SECRET');
            const expiresAt = Number(Deno.env.get('LIGHTNING_LICENSE_EXPIRES_MS'));
            return clientId && secret ? { clientId, secret, expiresAt, display: true, push: true } : null;
        },
        fetch,
        now: Date.now,
    })
);
