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
 * - collision_alarm: The boat Pi's night watch, a ship closing (126-04b, safety)
 * - distress_alarm: The boat Pi hears an active distress beacon (126-04b, safety)
 * - pi_watch_notice: The Pi's watch blind / no fix, or a test (126-04b, ordinary)
 * - cyclone_notice: A tropical cyclone within 600 NM of the boat (129-09, ordinary)
 * - cyclone_urgent: Within 300 NM, or its forecast track within 72 h (129-09, safety)
 * - official_warning: An official marine or coastal warning at the boat (129-06;
 *   Time Sensitive for Severe/Extreme, kept until it expires, updates quiet)
 *
 * The per-type settings (critical, thread, collapse id, sound, expiry) are in
 * ./config.ts, tested by config_test.ts.
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
import { createWakeDeliveryGuard, type WakeDeliveryDecision } from './wake-delivery.ts';
import { createWeatherWatchDeliveryGuard } from './weather-watch-delivery.ts';
import { createRadarDeliveryGuard } from './radar-delivery.ts';
import { createBuddyDeliveryGuard } from './buddy-delivery.ts';
import { encode as base64urlEncode } from 'https://deno.land/std@0.177.0/encoding/base64url.ts';
import { internalServerErrorResponse } from '../_shared/public-errors.ts';
import {
    buildAps,
    getApnsExpiration,
    getCollapseId,
    getInterruptionLevel,
    getThreadId,
    isCriticalType,
    isStaleForDelivery,
} from './config.ts';

// std@0.177 declares this encoder as taking `ArrayBuffer | string`, but at runtime it
// forwards a Uint8Array straight through (its base64 helper branches on
// `data instanceof Uint8Array` before falling back to `new Uint8Array(data)`).
// Current TypeScript lib definitions no longer treat a Uint8Array as structurally an
// ArrayBuffer, so we restate the parameter to match what the function actually accepts.
const base64url = base64urlEncode as (data: Uint8Array | ArrayBuffer | string) => string;

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
// isCriticalType, getThreadId, getCollapseId, getApnsExpiration and the aps
// dictionary live in ./config.ts (126-04b).

// ---------- SEND PUSH WITH RETRY ----------

interface PushPayload {
    title: string;
    body: string;
    data: Record<string, unknown>;
    isCritical?: boolean;
    threadId: string;
    collapseId: string | null;
    badge?: number;
    beforeAttempt?: () => Promise<WakeDeliveryDecision>;
}

interface SendResult {
    success: boolean;
    tokenInvalid?: boolean;
    statusCode?: number;
    error?: string;
    retired?: boolean;
}

async function sendApnsPush(deviceToken: string, payload: PushPayload): Promise<SendResult> {
    const bundleId = Deno.env.get('APNS_BUNDLE_ID') || 'com.thalassa.weather';
    const criticalAlertsEntitled = Deno.env.get('APNS_CRITICAL_ALERTS_ENABLED') === 'true';
    const useProduction = Deno.env.get('APNS_PRODUCTION') !== 'false';
    const host = useProduction ? 'https://api.push.apple.com' : 'https://api.sandbox.push.apple.com';

    // Build APNs payload (./config.ts buildAps: alert, thread, badge, sound, interruption level).
    const type = typeof payload.data.notification_type === 'string' ? payload.data.notification_type : 'general';
    const aps = buildAps({ ...payload, type, level: getInterruptionLevel(type, payload.data) }, criticalAlertsEntitled);

    const apnsPayload = { aps, ...payload.data };

    // ── Retry loop with exponential backoff ──
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
            const permission = payload.beforeAttempt ? await payload.beforeAttempt() : 'allow';
            if (permission !== 'allow') {
                return {
                    success: false,
                    retired: permission === 'retire',
                    error: permission === 'retire'
                        ? 'Wake alarm retired before delivery'
                        : 'Wake delivery check unavailable',
                };
            }
            const jwt = await getApnsJwt();

            const headers: Record<string, string> = {
                authorization: `bearer ${jwt}`,
                'apns-topic': bundleId,
                'apns-push-type': 'alert',
                // Every payload sent by this function is an APNs `alert`.
                // Priority 5 is a power-saving/background delivery class and
                // can defer ordinary direct messages long enough to make the
                // Notification Center feel unreliable.  Safety pushes are
                // still distinguished by their interruption level above, but
                // all visible alerts should reach the device promptly.
                'apns-priority': '10',
                'apns-expiration': getApnsExpiration(type, !!payload.isCritical, Date.now(), payload.data),
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
            // The APNs body is diagnostic data we intentionally never expose
            // or log. Cancel it explicitly so the runtime can release the
            // response stream without buffering sensitive upstream details.
            await response.body?.cancel().catch(() => undefined);
            // 410 Gone = token is no longer valid — DON'T retry, prune it
            if (statusCode === 410) {
                console.warn('APNs 410 Gone — token expired');
                return { success: false, tokenInvalid: true, statusCode };
            }

            // 400 Bad Request = malformed, don't retry
            if (statusCode === 400) {
                console.error('APNs 400 Bad Request');
                return { success: false, statusCode, error: 'APNs rejected payload' };
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

            return { success: false, statusCode, error: `APNs request failed (${statusCode})` };
        } catch {
            console.error(`APNs send failed on attempt ${attempt + 1}`);
            if (attempt < MAX_RETRIES - 1) {
                const delay = RETRY_BASE_MS * Math.pow(2, attempt);
                await new Promise((r) => setTimeout(r, delay));
                continue;
            }
            return { success: false, error: 'APNs request failed' };
        }
    }

    return { success: false, error: 'Max retries exceeded' };
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

        const requestBody = await req.json();
        if (requestBody?.action === 'capabilities') {
            // Service-role authenticated above; no queue claim, APNs request
            // or secret is returned. The Pi relay must verify this deployed
            // delivery contract before advertising its new alarm family.
            const configured = ['APNS_KEY_P8', 'APNS_KEY_ID', 'APNS_TEAM_ID']
                .every((name) => Boolean(Deno.env.get(name)));
            return new Response(
                JSON.stringify({
                    underway_alarm: configured ? 1 : 0,
                    wake_alarm: configured ? 1 : 0,
                    radar_alarm: configured ? 1 : 0,
                }),
                {
                    status: 200,
                    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
                },
            );
        }
        const { record: webhookRecord } = requestBody;

        if (!webhookRecord?.id) {
            return new Response(JSON.stringify({ error: 'Missing queue record id' }), {
                status: 400,
                headers: { 'Content-Type': 'application/json' },
            });
        }

        const supabase = createClient(Deno.env.get('SUPABASE_URL')!, serviceRoleKey);
        const { data: record, error: queueError } = await supabase.rpc('claim_push_notification', {
            p_id: webhookRecord.id,
        });
        if (queueError || !record) {
            return new Response(JSON.stringify({ error: 'Queue record is missing or already processed' }), {
                status: 409,
                headers: { 'Content-Type': 'application/json' },
            });
        }

        const { id, recipient_user_id, notification_type, title, body, data, created_at } = record;
        const releaseClaim = async (message: string) => {
            await supabase
                .from('push_notification_queue')
                .update({ processing_at: null, last_error: message.slice(0, 500) })
                .eq('id', id)
                .is('sent_at', null);
        };
        if (
            !recipient_user_id ||
            !notification_type ||
            typeof title !== 'string' ||
            typeof body !== 'string' ||
            title.length > 120 ||
            body.length > 500
        ) {
            await releaseClaim('Invalid persisted queue record');
            return new Response(JSON.stringify({ error: 'Invalid persisted queue record' }), { status: 422 });
        }

        // A Pi alarm the retry drain found late is history, not news (126-04b):
        // marked done unsent, so nothing retries it.
        if (isStaleForDelivery(notification_type, created_at, Date.now(), data ?? undefined)) {
            await supabase
                .from('push_notification_queue')
                .update({
                    sent_at: new Date().toISOString(),
                    processing_at: null,
                    last_error: 'expired before delivery',
                })
                .eq('id', id);
            return new Response(JSON.stringify({ sent: 0, message: 'Expired before delivery' }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        }
        const radarGuard = notification_type === 'radar_alarm'
            ? createRadarDeliveryGuard(id, async (queueId) => {
                const result = await supabase.rpc('pi_radar_delivery_current', { p_queue_id: queueId });
                return result.error ? null : result.data;
            })
            : undefined;
        if (radarGuard) {
            const permission = await radarGuard();
            if (permission === 'unavailable') {
                await releaseClaim('Radar delivery check unavailable');
                return new Response(JSON.stringify({ error: 'Radar delivery check unavailable' }), { status: 503 });
            }
            if (permission === 'retire') {
                await supabase.from('push_notification_queue').update({
                    sent_at: new Date().toISOString(),
                    processing_at: null,
                    last_error: 'Radar alarm no longer current',
                }).eq('id', id);
                return new Response(JSON.stringify({ sent: 0, message: 'Radar alarm no longer current' }), {
                    status: 200,
                });
            }
        }
        const wakeGuard = notification_type === 'wake_alarm'
            ? createWakeDeliveryGuard(id, async (queueId) => {
                const result = await supabase.rpc('pi_wake_delivery_current', { p_queue_id: queueId });
                return result.error ? null : result.data;
            })
            : undefined;
        if (wakeGuard) {
            const permission = await wakeGuard();
            if (permission === 'unavailable') {
                await releaseClaim('Wake delivery check unavailable');
                return new Response(JSON.stringify({ error: 'Wake delivery check unavailable' }), { status: 503 });
            }
            if (permission === 'retire') {
                await supabase.from('push_notification_queue').update({
                    sent_at: new Date().toISOString(),
                    processing_at: null,
                    last_error: 'Wake alarm no longer current',
                }).eq('id', id);
                return new Response(JSON.stringify({ sent: 0, message: 'Wake alarm no longer current' }), {
                    status: 200,
                });
            }
        }
        const weatherGuard = notification_type === 'weather_alert' && data && Object.hasOwn(data, 'weather_watch')
            ? createWeatherWatchDeliveryGuard(id, data, async (queueId) => {
                const result = await supabase.rpc('weather_watch_delivery_current', { p_queue_id: queueId });
                return result.error ? null : result.data;
            })
            : undefined;
        if (weatherGuard) {
            const decision = await weatherGuard();
            if (decision === 'unavailable') {
                await releaseClaim('Weather watch delivery check unavailable');
                return new Response(JSON.stringify({ error: 'Weather watch delivery check unavailable' }), {
                    status: 503,
                });
            }
            if (decision === 'retire') {
                await supabase.from('push_notification_queue').update({
                    sent_at: new Date().toISOString(),
                    processing_at: null,
                    last_error: 'Weather watch no longer current',
                }).eq('id', id);
                return new Response(JSON.stringify({ sent: 0, message: 'Weather watch no longer current' }), {
                    status: 200,
                });
            }
        }

        // A persisted buddy row still needs current owner/boat, consent and
        // source entitlement before this lookup and again before every attempt.
        const buddyGuard = notification_type === 'buddy_notice'
            ? createBuddyDeliveryGuard(id, data ?? {}, async (queueId) => {
                const result = await supabase.rpc('buddy_notice_delivery', { p_queue_id: queueId });
                return result.error ? null : result.data;
            })
            : undefined;
        if (buddyGuard) {
            const decision = await buddyGuard();
            if (decision === 'unavailable') {
                await releaseClaim('Buddy notice delivery check unavailable');
                return new Response(JSON.stringify({ error: 'Buddy notice delivery check unavailable' }), {
                    status: 503,
                });
            }
            if (decision === 'retire') {
                await supabase.from('push_notification_queue').update({
                    sent_at: new Date().toISOString(),
                    processing_at: null,
                    last_error: 'Buddy notice no longer current',
                }).eq('id', id);
                return new Response(JSON.stringify({ sent: 0, message: 'Buddy notice no longer current' }), {
                    status: 200,
                });
            }
        }

        // ── Look up device tokens for the recipient ──
        const { data: tokens, error } = await supabase
            .from('push_device_tokens')
            .select('id, device_token, platform')
            .eq('user_id', recipient_user_id);

        if (error) {
            console.error('Token lookup failed');
            await releaseClaim('Token lookup failed');
            return new Response(JSON.stringify({ error: 'Token lookup failed' }), {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
            });
        }

        if (!tokens || tokens.length === 0) {
            await supabase
                .from('push_notification_queue')
                .update({ sent_at: new Date().toISOString(), processing_at: null })
                .eq('id', id);
            return new Response(JSON.stringify({ sent: 0, message: 'No registered devices' }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        }

        // ── Calculate badge count (delivered unread + this notification) ──
        const { count: badgeCount } = await supabase
            .from('push_notification_queue')
            .select('id', { count: 'exact', head: true })
            .eq('recipient_user_id', recipient_user_id)
            .not('sent_at', 'is', null)
            .is('read_at', null);

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
            ...(wakeGuard || radarGuard || weatherGuard || buddyGuard
                ? { beforeAttempt: wakeGuard ?? radarGuard ?? weatherGuard ?? buddyGuard }
                : {}),
        };

        // ── Send push to all registered devices ──
        const results = await Promise.all(
            tokens.map(async (t: { id: string; device_token: string }) => {
                const result = await sendApnsPush(t.device_token, pushPayload);

                // Prune invalid tokens automatically
                if (result.tokenInvalid) {
                    console.log('Pruning invalid APNs token');
                    await supabase.from('push_device_tokens').delete().eq('id', t.id);
                }

                return result;
            }),
        );

        const sent = results.filter((r) => r.success).length;
        const pruned = results.filter((r) => r.tokenInvalid).length;
        const retired = results.filter((r) => r.retired).length;

        if (sent === 0 && pruned + retired < tokens.length) {
            const failure = results.find((result) => !result.success && !result.tokenInvalid);
            await releaseClaim(failure?.error || 'APNs delivery failed');
            return new Response(JSON.stringify({ error: 'APNs delivery failed; queued for retry' }), {
                status: 502,
                headers: { 'Content-Type': 'application/json' },
            });
        }

        // Mark notification as sent
        await supabase
            .from('push_notification_queue')
            .update({ sent_at: new Date().toISOString(), processing_at: null, last_error: null })
            .eq('id', id);

        return new Response(JSON.stringify({ sent, total: tokens.length, pruned }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
    } catch {
        console.error('[send-push] unhandled request failure');
        return internalServerErrorResponse();
    }
});
