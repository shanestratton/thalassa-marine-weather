/**
 * telemetry-relay — the boat's live instrument snapshot, from the Pi.
 *
 * Shane 2026-09-06: the Pi is the primary device — it has the boat's GPS and
 * the whole bus — and crew should see the Instrument Panel anywhere with no
 * VPN. The Pi POSTs a snapshot every few seconds; this function checks its
 * pairing credential (the same bearer the diary relay issued, see
 * _shared/pi-relay-auth.ts), bounds every field, and upserts ONE row per
 * skipper in `vessel_telemetry`. Row-level security lets the skipper and the
 * boat's crew read it; nothing else can.
 *
 * Deploy with JWT verification off: the Pi holds a relay token, not a user JWT.
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { jsonResponse, readJsonObject } from '../_shared/http-security.ts';
import { authenticatePiRelay, readRelayCredential, touchPiRelay } from '../_shared/pi-relay-auth.ts';
import { parseTelemetryBody } from './parse.ts';

declare const Deno: {
    serve: (handler: (req: Request) => Promise<Response> | Response) => void;
    env: { get(key: string): string | undefined };
};

const CORS: Record<string, string> = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers':
        'Content-Type, Authorization, apikey, X-Thalassa-Pi-Relay-Id, X-Thalassa-Pi-Relay-Token',
};

function json(body: unknown, status = 200): Response {
    return jsonResponse(body, status, CORS);
}

function adminClient() {
    const url = Deno.env.get('SUPABASE_URL');
    const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!url || !key) return null;
    return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

    const body = await readJsonObject(req, 16_384);
    if (!body) return json({ error: 'Body must be a JSON object under 16 KiB' }, 400);

    const admin = adminClient();
    if (!admin) return json({ error: 'Telemetry relay is not configured' }, 503);

    const identity = await authenticatePiRelay(admin, readRelayCredential(req, body));
    if ('status' in identity) return json({ error: identity.error }, identity.status);

    const parsed = parseTelemetryBody(body);
    if (!parsed.ok) return json({ error: parsed.error }, 400);

    // The Pi does not know which of the skipper's boats it is bolted to; the
    // skipper's active vessel does. Null when they have not chosen one — the
    // owner still reads the row, only boat-scoped crew reads wait for it.
    const { data: active } = await admin
        .from('user_active_vessels')
        .select('boat_id')
        .eq('user_id', identity.ownerId)
        .maybeSingle();
    const boatId = typeof (active as { boat_id?: unknown } | null)?.boat_id === 'string'
        ? (active as { boat_id: string }).boat_id
        : null;

    const { error } = await admin.from('vessel_telemetry').upsert(
        { owner_id: identity.ownerId, boat_id: boatId, ...parsed.row, updated_at: new Date().toISOString() },
        { onConflict: 'owner_id' },
    );
    if (error) {
        console.error('[telemetry-relay] upsert failed:', error.message);
        return json({ error: 'Could not store the snapshot' }, 503);
    }
    touchPiRelay(admin, identity.relayId);
    return json({ ok: true, boat_id: boatId, reported_at: parsed.row.reported_at });
});
