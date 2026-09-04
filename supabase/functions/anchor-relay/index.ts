/**
 * anchor-relay — lets the boat's Pi broadcast Shore Watch, so a skipper needs
 * a Pi OR a tablet aboard, not both.
 *
 * Shane 2026-08-29: "lets wire up the shore watch to the pi, as long as it
 * still works device to device and pi to device."
 *
 * WHY THIS FUNCTION EXISTS AT ALL. The anchor-watch channel is created with
 * `private: true` (services/AnchorWatchSyncService.ts), so publishing to it
 * needs an authenticated Supabase session. Putting one on the Pi would leave a
 * long-lived user credential on a boat computer that can be stolen with the
 * boat. The diary relay already answered this correctly — the Pi holds only a
 * scoped per-Pi relay credential, never a Supabase key — so this reuses that
 * same identity (`pi_diary_relays`) rather than minting a second secret for
 * the same machine. One Pi, one credential, one place to revoke.
 *
 * The table name is historical; the credential is per-Pi, not per-feature.
 *
 * TWO ACTIONS.
 *
 *   authorise — called by the SIGNED-IN APP with a user JWT. Records that this
 *   relay may broadcast to this session code, until this time. The relay
 *   credential proves WHICH PI is calling and nothing about which channel it
 *   may talk to; anchor-watch sessions live only on the devices, so without
 *   this binding a compromised Pi could broadcast a fabricated position to any
 *   code it could guess.
 *
 *   broadcast — called by the PI with its relay credential. Verified against
 *   the binding, then published server-side with the service role. The shore
 *   device subscribes exactly as it does to a phone and cannot tell the
 *   difference, which is the property that keeps device-to-device working
 *   untouched.
 *
 * The Pi never learns the service role key, never joins Realtime, and can only
 * reach the one channel its owner authorised while that authorisation lasts.
 *
 * GATEWAY AUTH. This function is NOT on the credentialless allowlist and does
 * not want to be — it takes the project default, verify_jwt = true. Callers
 * present the ANON key at the gateway, which is a JWT and is public by
 * definition, and real identity is then established inside: the relay token
 * hash for the Pi, getUser() for the app's authorise call. Adding a durable
 * gateway bypass is a decision with its own approval (see
 * tests/SupabaseEdgeJwtPolicyContract.test.ts) and this design does not need
 * one.
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

/** Matches the app's session-code generator exactly. */
const SESSION_CODE_RE = /^[A-Za-z0-9]{12}$/;
const RELAY_ID_RE = /^[A-Za-z0-9_-]{16,128}$/;
/** A position is small. Anything larger is not an anchor report. */
const MAX_BODY_BYTES = 8 * 1024;
/**
 * How long one authorisation lasts. The app refreshes it while the watch runs,
 * so this is a lapse window, not a session length — a standing permission to
 * broadcast someone's boat position is not a thing to hand out.
 */
const AUTHORISATION_TTL_MS = 6 * 60 * 60 * 1000;

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { ...CORS, 'Content-Type': 'application/json' },
    });
}

async function sha256(value: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time compare, so a token hash cannot be probed a byte at a time. */
function secureEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}

function adminClient() {
    const url = Deno.env.get('SUPABASE_URL');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!url || !serviceRoleKey) return null;
    return createClient(url, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
}

Deno.serve(async (req: Request) => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
    if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

    const admin = adminClient();
    if (!admin) return json({ error: 'unavailable' }, 503);

    const raw = await req.text();
    if (raw.length > MAX_BODY_BYTES) return json({ error: 'payload_too_large' }, 413);

    let body: Record<string, unknown>;
    try {
        body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
        return json({ error: 'invalid_json' }, 400);
    }

    const relayId = typeof body.relay_id === 'string' ? body.relay_id.trim() : '';
    const sessionCode = typeof body.session_code === 'string' ? body.session_code.trim() : '';
    if (!RELAY_ID_RE.test(relayId)) return json({ error: 'invalid_relay_id' }, 400);
    if (!SESSION_CODE_RE.test(sessionCode)) return json({ error: 'invalid_session_code' }, 400);

    // ── authorise: the signed-in app grants this Pi one channel, for a while ──
    if (body.action === 'authorise') {
        const authHeader = req.headers.get('Authorization') ?? '';
        const jwt = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
        if (!jwt) return json({ error: 'unauthorised' }, 401);

        const { data: userData, error: userError } = await admin.auth.getUser(jwt);
        if (userError || !userData?.user) return json({ error: 'unauthorised' }, 401);
        const ownerId = userData.user.id;

        // The caller must own the relay they are authorising. Without this a
        // signed-in user could point somebody else's Pi at their own channel.
        const { data: relay, error: relayError } = await admin
            .from('pi_diary_relays')
            .select('owner_id, enabled')
            .eq('relay_id', relayId)
            .maybeSingle();
        if (relayError) return json({ error: 'unavailable' }, 503);
        if (!relay || relay.owner_id !== ownerId || !relay.enabled) return json({ error: 'forbidden' }, 403);

        const now = Date.now();
        const { error: writeError } = await admin.from('pi_anchor_sessions').upsert(
            {
                relay_id: relayId,
                owner_id: ownerId,
                session_code: sessionCode,
                authorised_at: new Date(now).toISOString(),
                expires_at: new Date(now + AUTHORISATION_TTL_MS).toISOString(),
            },
            { onConflict: 'relay_id' },
        );
        if (writeError) {
            console.error('[anchor-relay] authorise failed:', writeError.message);
            return json({ error: 'unavailable' }, 503);
        }
        return json({ authorised: true, expires_in_ms: AUTHORISATION_TTL_MS });
    }

    // ── broadcast: the Pi, with its relay credential ──
    const token = typeof body.token === 'string' ? body.token : '';
    if (!token) return json({ error: 'unauthorised' }, 401);

    const { data: relay, error: relayError } = await admin
        .from('pi_diary_relays')
        .select('owner_id, token_hash, enabled')
        .eq('relay_id', relayId)
        .maybeSingle();
    if (relayError) return json({ error: 'unavailable' }, 503);
    // One shape of answer whether the relay is unknown, disabled or the token
    // is wrong — a prober learns nothing from which it was.
    if (!relay || !relay.enabled || !secureEqual(await sha256(token), relay.token_hash)) {
        return json({ error: 'unauthorised' }, 401);
    }

    const { data: binding, error: bindingError } = await admin
        .from('pi_anchor_sessions')
        .select('session_code, owner_id, expires_at')
        .eq('relay_id', relayId)
        .maybeSingle();
    if (bindingError) return json({ error: 'unavailable' }, 503);
    if (
        !binding ||
        binding.owner_id !== relay.owner_id ||
        binding.session_code !== sessionCode ||
        Date.parse(binding.expires_at) <= Date.now()
    ) {
        // Not authorised for THIS channel, or the watch has lapsed. Distinct
        // from a bad credential so the Pi can tell "ask the app to re-authorise"
        // from "my token is wrong".
        return json({ error: 'not_authorised_for_session' }, 403);
    }

    const payload = body.payload;
    if (!payload || typeof payload !== 'object') return json({ error: 'invalid_payload' }, 400);

    // Publish server-side. The Pi never joins Realtime and never sees a key.
    const url = Deno.env.get('SUPABASE_URL');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const response = await fetch(`${url}/realtime/v1/api/broadcast`, {
        method: 'POST',
        headers: {
            apikey: serviceRoleKey as string,
            Authorization: `Bearer ${serviceRoleKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            messages: [
                {
                    topic: `anchor-watch-${sessionCode}`,
                    event: 'position',
                    private: true,
                    payload: { ...(payload as Record<string, unknown>), type: 'position', timestamp: Date.now() },
                },
            ],
        }),
    });
    if (!response.ok) {
        console.error('[anchor-relay] broadcast failed:', response.status);
        return json({ error: 'broadcast_failed' }, 502);
    }

    // ── A PI-DETECTED DRAG MUST BE ABLE TO WAKE A LOCKED PHONE ──
    //
    // Until now the ONLY route from a dragging boat to the skipper was the
    // realtime broadcast above, landing in a foregrounded WKWebView with the
    // anchor page mounted. Asleep, pocketed, or on any other screen: nothing.
    // anchor_alarm_events had exactly one writer in the whole codebase, gated
    // on role === 'vessel' — a phone aboard. The Pi could never reach it, so
    // the one setup designed to let the skipper LEAVE THE BOAT was the one
    // with no push path.
    //
    // Inserting here closes it: the row fires the on_anchor_alarm_insert
    // trigger, which calls send-anchor-alarm, which pushes via APNs — and
    // retry_pending_anchor_alarms sweeps anything that failed.
    const p = payload as Record<string, unknown>;
    if (p.isAlarm === true) {
        // RISING EDGE ONLY. The Pi POSTs every 10s, so a level-triggered
        // insert would queue 360 alerts an hour. The Pi already confirms a
        // drag over three consecutive fixes before it ever sets this, so an
        // edge here is a confirmed drag, not a GPS spike.
        const { data: recent } = await admin
            .from('anchor_alarm_events')
            .select('id')
            .eq('session_code', sessionCode)
            .gt('created_at', new Date(Date.now() - 10 * 60_000).toISOString())
            .limit(1);
        if (!recent || recent.length === 0) {
            const vessel = (p.vessel ?? {}) as Record<string, unknown>;
            // user_id comes from the VERIFIED relay owner, never the request
            // body — the binding checks above already matched owner, session
            // code and a live expiry before we got here.
            const { error: alarmError } = await admin.from('anchor_alarm_events').insert({
                session_code: sessionCode,
                user_id: relay.owner_id,
                distance_m: typeof p.distance === 'number' ? p.distance : 0,
                swing_radius_m: typeof p.swingRadius === 'number' ? p.swingRadius : 0,
                vessel_lat: typeof vessel.latitude === 'number' ? vessel.latitude : null,
                vessel_lon: typeof vessel.longitude === 'number' ? vessel.longitude : null,
            });
            if (alarmError) console.error('[anchor-relay] alarm insert failed:', alarmError.message);
            else console.log(`[anchor-relay] drag alarm raised for ${sessionCode}`);
        }
    }

    void admin.from('pi_diary_relays').update({ last_seen_at: new Date().toISOString() }).eq('relay_id', relayId);
    return json({ delivered: true });
});
