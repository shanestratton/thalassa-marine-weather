import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { authenticatePiRelay } from '../_shared/pi-relay-auth.ts';
import { createPiInternetAisHandler } from './core.ts';

const origin = Deno.env.get('SUPABASE_URL') ?? '';
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
function admin(signal: AbortSignal) {
    return createClient(origin, serviceKey, {
        auth: { persistSession: false, autoRefreshToken: false },
        global: { fetch: (input, init) => fetch(input, { ...init, signal }) },
    });
}
async function quotaHash(ownerId: string): Promise<string> {
    const key = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(serviceKey),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
    );
    const hash = new Uint8Array(
        await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('pi-internet-ais-v1:' + ownerId)),
    );
    return [...hash].map((b) => b.toString(16).padStart(2, '0')).join('');
}
Deno.serve(createPiInternetAisHandler({
    enabled: () => Deno.env.get('THALASSA_PI_INTERNET_AIS_ENABLED') === '1' && !!origin && !!serviceKey,
    now: Date.now,
    authenticate: (credential, signal) => authenticatePiRelay(admin(signal), credential, () => undefined),
    deleted: async (ownerId, signal) => {
        const { data, error } = await admin(signal).from('account_deletion_jobs').select('user_id').eq(
            'user_id',
            ownerId,
        ).maybeSingle();
        if (error) throw Error('Account status unavailable');
        return data !== null;
    },
    quota: async (ownerId, signal) => {
        const clientHash = await quotaHash(ownerId);
        for (const [suffix, limit, window] of [['hour', 120, 3600], ['minute', 4, 60]] as const) {
            const { data, error } = await admin(signal).rpc('consume_public_edge_quota', {
                p_bucket: `pi_internet_ais_${suffix}`,
                p_client_hash: clientHash,
                p_limit: limit,
                p_window_seconds: window,
            });
            if (error) throw Error('AIS quota unavailable');
            if (data !== true) return false;
        }
        return true;
    },
    coverage: async (ownerId, request, signal) => {
        const { data, error } = await admin(signal).rpc('request_ais_fleet_area', {
            request_owner: ownerId,
            query_lat: request.lat,
            query_lon: request.lon,
        });
        if (error || !data || !['held', 'queued', 'recent', 'limited'].includes(data.state)) {
            throw Error('AIS coverage unavailable');
        }
        return data.state === 'held' ? 'held' : 'limited';
    },
    query: async (request, signal) => {
        const { data, error } = await admin(signal).rpc('vessels_nearby_v135', {
            query_lat: request.lat,
            query_lon: request.lon,
            radius_m: 25 * 1852,
            max_results: 100,
        });
        if (error || !Array.isArray(data)) throw Error('AIS observations unavailable');
        return data;
    },
}));
