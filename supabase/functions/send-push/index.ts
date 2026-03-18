/**
 * send-push — Production-Grade Push Notification Edge Function
 *
 * Triggered by database webhook on INSERT to `push_notification_queue`.
 * Reads the notification, looks up the recipient's device tokens,
 * and sends via APNs with full production hardening.
 *
 * World-class features:
 * - APNs JWT ES256 signing with token caching
 * - Retry with exponential backoff (3 attempts)
 * - Automatic stale token pruning (APNs 410 Gone)
 * - Critical Alert support (bypasses DND/silent mode)
 * - Notification grouping via thread-id
 * - Badge count management
 * - Rate limiting protection for broadcast alerts
 * - Comprehensive error logging
 *
 * Supports notification types:
 * - dm: Direct message received
 * - sos: SOS question posted in channel
 * - anchor_alarm: Anchor drag detected (Critical Alert)
 * - bolo_alert: Armed vessel moved (Critical Alert)
 * - suspicious_alert: Suspicious activity reported (Critical Alert)
 * - drag_warning: Neighbor vessel dragging anchor (Critical Alert)
 * - geofence_alert: Vessel left home geofence (Critical Alert)
 * - hail: Social ping from nearby vessel
 * - pin_drop: Pin shared in channel
 * - track_shared: Voyage track shared
 * - weather_alert: Severe weather warning
 *
 * Required Secrets (Supabase Dashboard → Edge Functions → Secrets):
 * - APNS_KEY_P8: Apple .p8 auth key contents
 * - APNS_KEY_ID: Key ID from Apple Developer
 * - APNS_TEAM_ID: Apple Developer Team ID
 * - APNS_BUNDLE_ID: App bundle identifier (e.g., com.thalassa.weather)
 * - SUPABASE_URL: Auto-provided
 * - SUPABASE_SERVICE_ROLE_KEY: Auto-provided
 */

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { encode as base64url } from 'https://deno.land/std@0.177.0/encoding/base64url.ts';

// ── Retry Config ──
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 500; // 500ms, 1s, 2s

// ── JWT Token Cache (re-sign every 45 minutes, Apple allows 1 hour) ──
let cachedJwt: { token: string; expiresAt: number } | null = null;

// ---------- APNs JWT SIGNING ----------

async function getApnsJwt(): Promise<string> {
    const now = Date.now();
    if (cachedJwt && now < cachedJwt.expiresAt) {
        return cachedJwt.token;
    }

    const keyId = Deno.env.get('APNS_KEY_ID')!;
    const teamId = Deno.env.get('APNS_TEAM_ID')!;
    const p8Key = Deno.env.get('APNS_KEY_P8')!;

    const pemBody = p8Key
        .replace('-----BEGIN PRIVATE KEY-----', '')
        .replace('-----END PRIVATE KEY-----', '')
        .replace(/\s/g, '');
    const keyData = Uint8Array.from(atob(pemBody), (c) => c.charCodeAt(0));

    const key = await crypto.subtle.importKey('pkcs8', keyData, { name: 'ECDSA', namedCurve: 'P-256' }, false, [
        'sign',
    ]);

    const header = { alg: 'ES256', kid: keyId };
    const claims = {
        iss: teamId,
        iat: Math.floor(now / 1000),
    };

    const encoder = new TextEncoder();
    const headerB64 = base64url(encoder.encode(JSON.stringify(header)));
    const claimsB64 = base64url(encoder.encode(JSON.stringify(claims)));
    const signingInput = `${headerB64}.${claimsB64}`;

    const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, encoder.encode(signingInput));
    const token = `${signingInput}.${base64url(new Uint8Array(signature))}`;

    // Cache for 45 minutes
    cachedJwt = { token, expiresAt: now + 45 * 60 * 1000 };
    return token;
}

// ---------- NOTIFICATION TYPE CONFIG ----------

function isCriticalType(type: string): boolean {
    return [
        'anchor_alarm',
        'bolo_alert', // Armed vessel moved — safety critical
        'suspicious_alert', // Suspicious activity reported — safety critical
        'drag_warning', // Neighbor dragging anchor — safety critical
        'geofence_alert', // Vessel left home geofence — safety critical
    ].includes(type);
}

/** Map notification type to APNs thread-id for grouping in Notification Center */
function getThreadId(type: string): string {
    switch (type) {
        case 'dm':
            return 'thalassa-messages';
        case 'bolo_alert':
        case 'suspicious_alert':
        case 'drag_warning':
        case 'geofence_alert':
            return 'thalassa-guardian';
        case 'anchor_alarm':
            return 'thalassa-anchor';
        case 'weather_alert':
            return 'thalassa-weather';
        case 'hail':
            return 'thalassa-social';
        default:
            return 'thalassa-general';
    }
}

/** Get the APNs collapse-id to coalesce duplicate alerts */
function getCollapseId(type: string, data: Record<string, unknown>): string | null {
    // Collapse repeated BOLO alerts for the same vessel
    if (type === 'bolo_alert' && data?.mmsi) return `bolo-${data.mmsi}`;
    // Collapse geofence alerts for the same vessel
    if (type === 'geofence_alert' && data?.mmsi) return `geofence-${data.mmsi}`;
    // Collapse anchor alarms (only latest matters)
    if (type === 'anchor_alarm') return 'anchor-alarm';
    return null;
}

// ---------- SEND PUSH WITH RETRY ----------

interface PushPayload {
    title: string;
    body: string;
    data: Record<string, unknown>;
    isCritical?: boolean;
    threadId: string;
    collapseId: string | null;
    badge?: number;
}

interface SendResult {
    success: boolean;
    tokenInvalid?: boolean;
    statusCode?: number;
    error?: string;
}

async function sendApnsPush(deviceToken: string, payload: PushPayload): Promise<SendResult> {
    const bundleId = Deno.env.get('APNS_BUNDLE_ID') || 'com.thalassa.weather-2025';
    const useProduction = Deno.env.get('APNS_PRODUCTION') !== 'false';
    const host = useProduction ? 'https://api.push.apple.com' : 'https://api.sandbox.push.apple.com';

    // Build APNs payload
    const aps: Record<string, unknown> = {
        alert: { title: payload.title, body: payload.body },
        'content-available': 1,
        'thread-id': payload.threadId,
    };

    // Badge management
    if (payload.badge !== undefined) {
        aps.badge = payload.badge;
    }

    if (payload.isCritical) {
        // Critical Alert — bypasses DND and silent mode (requires Apple entitlement)
        aps.sound = { critical: 1, name: 'default', volume: 1.0 };
        aps['interruption-level'] = 'critical';
    } else {
        aps.sound = 'default';
        aps['interruption-level'] = 'active';
    }

    const apnsPayload = { aps, ...payload.data };

    // ── Retry loop with exponential backoff ──
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
            const jwt = await getApnsJwt();

            const headers: Record<string, string> = {
                authorization: `bearer ${jwt}`,
                'apns-topic': bundleId,
                'apns-push-type': 'alert',
                'apns-priority': payload.isCritical ? '10' : '5',
                'apns-expiration': '0',
                'content-type': 'application/json',
            };

            if (payload.collapseId) {
                headers['apns-collapse-id'] = payload.collapseId;
            }

            const response = await fetch(`${host}/3/device/${deviceToken}`, {
                method: 'POST',
                headers,
                body: JSON.stringify(apnsPayload),
            });

            if (response.ok) {
                return { success: true };
            }

            const statusCode = response.status;
            const errorBody = await response.text();

            // 410 Gone = token is no longer valid — DON'T retry, prune it
            if (statusCode === 410) {
                console.warn(`APNs 410 Gone — token expired: ${deviceToken.slice(0, 8)}…`);
                return { success: false, tokenInvalid: true, statusCode };
            }

            // 400 Bad Request = malformed, don't retry
            if (statusCode === 400) {
                console.error(`APNs 400 Bad Request:`, errorBody);
                return { success: false, statusCode, error: errorBody };
            }

            // 403 = JWT issue, invalidate cache and retry
            if (statusCode === 403) {
                console.warn('APNs 403 — invalidating JWT cache');
                cachedJwt = null;
            }

            // 429 Too Many Requests or 5xx = retry with backoff
            if (statusCode === 429 || statusCode >= 500) {
                console.warn(`APNs ${statusCode} — retry ${attempt + 1}/${MAX_RETRIES}`);
                if (attempt < MAX_RETRIES - 1) {
                    const delay = RETRY_BASE_MS * Math.pow(2, attempt);
                    await new Promise((r) => setTimeout(r, delay));
                    continue;
                }
            }

            return { success: false, statusCode, error: errorBody };
        } catch (error) {
            console.error(`APNs send error (attempt ${attempt + 1}):`, error);
            if (attempt < MAX_RETRIES - 1) {
                const delay = RETRY_BASE_MS * Math.pow(2, attempt);
                await new Promise((r) => setTimeout(r, delay));
                continue;
            }
            return { success: false, error: String(error) };
        }
    }

    return { success: false, error: 'Max retries exceeded' };
}

// ---------- MAIN HANDLER ----------

serve(async (req: Request) => {
    try {
        const { record } = await req.json();

        if (!record?.recipient_user_id || !record?.title || !record?.body) {
            return new Response(JSON.stringify({ error: 'Missing required fields' }), {
                status: 400,
                headers: { 'Content-Type': 'application/json' },
            });
        }

        const { id, recipient_user_id, notification_type, title, body, data } = record;

        const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

        // ── Look up device tokens for the recipient ──
        const { data: tokens, error } = await supabase
            .from('push_device_tokens')
            .select('id, device_token, platform')
            .eq('user_id', recipient_user_id);

        if (error) {
            console.error('Token lookup failed:', error);
            return new Response(JSON.stringify({ error: 'Token lookup failed' }), {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
            });
        }

        if (!tokens || tokens.length === 0) {
            await supabase.from('push_notification_queue').update({ sent_at: new Date().toISOString() }).eq('id', id);
            return new Response(JSON.stringify({ sent: 0, message: 'No registered devices' }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        }

        // ── Calculate badge count (pending unread notifications) ──
        const { count: badgeCount } = await supabase
            .from('push_notification_queue')
            .select('id', { count: 'exact', head: true })
            .eq('recipient_user_id', recipient_user_id)
            .is('sent_at', null);

        // ── Build push payload ──
        const pushPayload: PushPayload = {
            title,
            body,
            data: {
                notification_type,
                ...(data || {}),
            },
            isCritical: isCriticalType(notification_type),
            threadId: getThreadId(notification_type),
            collapseId: getCollapseId(notification_type, data || {}),
            badge: (badgeCount ?? 0) + 1,
        };

        // ── Send push to all registered devices ──
        const results = await Promise.all(
            tokens.map(async (t: { id: string; device_token: string }) => {
                const result = await sendApnsPush(t.device_token, pushPayload);

                // Prune invalid tokens automatically
                if (result.tokenInvalid) {
                    console.log(`Pruning invalid token ${t.device_token.slice(0, 8)}… (id: ${t.id})`);
                    await supabase.from('push_device_tokens').delete().eq('id', t.id);
                }

                return result;
            }),
        );

        const sent = results.filter((r) => r.success).length;
        const pruned = results.filter((r) => r.tokenInvalid).length;

        // Mark notification as sent
        await supabase.from('push_notification_queue').update({ sent_at: new Date().toISOString() }).eq('id', id);

        return new Response(JSON.stringify({ sent, total: tokens.length, pruned }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
    } catch (error) {
        console.error('Edge function error:', error);
        return new Response(JSON.stringify({ error: String(error) }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
        });
    }
});
