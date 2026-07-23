/**
 * send-anchor-alarm — Supabase Edge Function
 *
 * Triggered when a row is inserted into `anchor_alarm_events`.
 * Looks up device tokens for the session and sends APNs Critical Alert
 * push notifications to shore devices.
 *
 * Required Secrets (set via Supabase Dashboard → Edge Functions → Secrets):
 * - APNS_KEY_P8: The contents of your Apple .p8 auth key file
 * - APNS_KEY_ID: The Key ID from Apple Developer
 * - APNS_TEAM_ID: Your Apple Developer Team ID
 * - APNS_BUNDLE_ID: Your app's bundle identifier (e.g., com.thalassa.weather)
 * - SUPABASE_URL: Auto-provided
 * - SUPABASE_SERVICE_ROLE_KEY: Auto-provided
 */

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { encode as base64url } from 'https://deno.land/std@0.177.0/encoding/base64url.ts';

// ---------- APNs JWT SIGNING ----------

async function createApnsJwt(): Promise<string> {
    const keyId = Deno.env.get('APNS_KEY_ID')!;
    const teamId = Deno.env.get('APNS_TEAM_ID')!;
    const p8Key = Deno.env.get('APNS_KEY_P8')!;

    // Parse PEM to raw key
    const pemBody = p8Key
        .replace('-----BEGIN PRIVATE KEY-----', '')
        .replace('-----END PRIVATE KEY-----', '')
        .replace(/\s/g, '');
    const keyData = Uint8Array.from(atob(pemBody), (c) => c.charCodeAt(0));

    const key = await crypto.subtle.importKey('pkcs8', keyData, { name: 'ECDSA', namedCurve: 'P-256' }, false, [
        'sign',
    ]);

    // JWT header + claims
    const header = { alg: 'ES256', kid: keyId };
    const claims = {
        iss: teamId,
        iat: Math.floor(Date.now() / 1000),
    };

    const encoder = new TextEncoder();
    const headerB64 = base64url(encoder.encode(JSON.stringify(header)));
    const claimsB64 = base64url(encoder.encode(JSON.stringify(claims)));
    const signingInput = `${headerB64}.${claimsB64}`;

    // Sign with ES256
    const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, encoder.encode(signingInput));

    // Convert DER signature to raw r || s format for JWT
    const sigB64 = base64url(new Uint8Array(signature));

    return `${signingInput}.${sigB64}`;
}

// ---------- SEND PUSH ----------

async function sendApnsPush(
    deviceToken: string,
    title: string,
    body: string,
    data: Record<string, unknown>,
): Promise<boolean> {
    const bundleId = Deno.env.get('APNS_BUNDLE_ID') || 'com.thalassa.weather';
    const criticalAlertsEntitled = Deno.env.get('APNS_CRITICAL_ALERTS_ENABLED') === 'true';
    const jwt = await createApnsJwt();

    // Use production APNs (switch to api.sandbox.push.apple.com for dev)
    const useProduction = Deno.env.get('APNS_PRODUCTION') !== 'false';
    const host = useProduction ? 'https://api.push.apple.com' : 'https://api.sandbox.push.apple.com';

    const alertSound = criticalAlertsEntitled ? { critical: 1, name: 'default', volume: 1.0 } : 'default';
    const payload = {
        aps: {
            alert: { title, body },
            sound: alertSound,
            'interruption-level': criticalAlertsEntitled ? 'critical' : 'time-sensitive',
            'content-available': 1,
            badge: 1,
        },
        ...data,
    };

    try {
        const response = await fetch(`${host}/3/device/${deviceToken}`, {
            method: 'POST',
            headers: {
                authorization: `bearer ${jwt}`,
                'apns-topic': bundleId,
                'apns-push-type': 'alert',
                'apns-priority': '10',
                'apns-expiration': '0',
                'content-type': 'application/json',
            },
            body: JSON.stringify(payload),
        });

        if (response.ok) {
            return true;
        } else {
            const errorBody = await response.text();
            return false;
        }
    } catch (error) {
        return false;
    }
}

// ---------- MAIN HANDLER ----------

serve(async (req: Request) => {
    try {
        if (req.method !== 'POST') {
            return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });
        }

        const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
        if (!serviceRoleKey) {
            return new Response(JSON.stringify({ error: 'Server configuration error' }), { status: 500 });
        }
        if (req.headers.get('authorization') !== `Bearer ${serviceRoleKey}`) {
            return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
        }

        const { record: webhookRecord } = await req.json();

        if (!webhookRecord?.id) {
            return new Response(JSON.stringify({ error: 'Missing alarm record id' }), {
                status: 400,
            });
        }

        const supabase = createClient(Deno.env.get('SUPABASE_URL')!, serviceRoleKey);
        const { data: record, error: eventError } = await supabase.rpc('claim_anchor_alarm_event', {
            p_id: webhookRecord.id,
        });
        if (eventError || !record) {
            return new Response(JSON.stringify({ error: 'Alarm record is missing, stale, or already processed' }), {
                status: 409,
            });
        }

        const { id, session_code, distance_m, swing_radius_m, vessel_lat, vessel_lon } = record;
        const releaseClaim = async (message: string) => {
            await supabase
                .from('anchor_alarm_events')
                .update({ processing_at: null, last_error: message.slice(0, 500) })
                .eq('id', id)
                .is('notified_at', null);
        };

        // Look up device tokens for this session
        const { data: tokens, error } = await supabase
            .from('anchor_alarm_tokens')
            .select('device_token, platform')
            .eq('session_code', session_code);

        if (error) {
            await releaseClaim(`Token lookup failed: ${error.message}`);
            return new Response(JSON.stringify({ error: 'Token lookup failed' }), {
                status: 500,
            });
        }

        if (!tokens || tokens.length === 0) {
            await supabase
                .from('anchor_alarm_events')
                .update({ notified_at: new Date().toISOString(), processing_at: null })
                .eq('id', id);
            return new Response(JSON.stringify({ sent: 0, message: 'No tokens' }), {
                status: 200,
            });
        }

        // Send push to all registered shore devices
        const distanceStr = Math.round(distance_m);
        const radiusStr = Math.round(swing_radius_m);
        const title = '⚓ ANCHOR DRAG ALARM';
        const body = `Your vessel has drifted ${distanceStr}m from anchor (${radiusStr}m swing radius). Check immediately!`;

        const results = await Promise.all(
            tokens.map((t: { device_token: string }) =>
                sendApnsPush(t.device_token, title, body, {
                    alarm_type: 'anchor_drag',
                    session_code,
                    distance_m,
                    swing_radius_m,
                    vessel_lat,
                    vessel_lon,
                }),
            ),
        );

        const sent = results.filter(Boolean).length;

        if (sent === 0) {
            await releaseClaim('APNs delivery failed');
            return new Response(JSON.stringify({ error: 'APNs delivery failed; queued for retry' }), {
                status: 502,
                headers: { 'Content-Type': 'application/json' },
            });
        }

        await supabase
            .from('anchor_alarm_events')
            .update({ notified_at: new Date().toISOString(), processing_at: null, last_error: null })
            .eq('id', id);

        return new Response(JSON.stringify({ sent, total: tokens.length }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
    } catch (error) {
        return new Response(JSON.stringify({ error: String(error) }), {
            status: 500,
        });
    }
});
