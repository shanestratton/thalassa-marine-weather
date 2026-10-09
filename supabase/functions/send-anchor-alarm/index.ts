/**
 * send-anchor-alarm — Supabase Edge Function
 *
 * Triggered when a row is inserted into `anchor_alarm_events`.
 * Looks up device tokens for the session and sends time-sensitive APNs
 * notifications to shore devices. Critical Alerts remain separately gated
 * on Apple approval, signing entitlement and device permission.
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
import { internalServerErrorResponse } from '../_shared/public-errors.ts';
import { anchorAlarmMessage, phoneWatchAlarmCurrent, piWatchEndsSoon } from '../_shared/anchor-alarm.ts';

// ---------- APNs JWT SIGNING ----------

type ApnsEnvironment = 'production' | 'sandbox';
// Packaged at the root of the iOS app bundle. Older installs without the
// asset fall back to the system sound; this is not a continuous background
// siren and normal iOS sound/Focus settings still apply.
const ANCHOR_ALARM_SOUND = 'thalassa-anchor-alarm.wav';
type CachedApnsJwt = {
    keyId: string;
    teamId: string;
    p8Key: string;
    issuedAt: number;
    expiresAt: number;
    token: Promise<string>;
};
const cachedApnsJwts = new Map<string, CachedApnsJwt>();

function sandboxCredentialsConfigured(): boolean {
    return !!Deno.env.get('APNS_SANDBOX_KEY_ID')?.trim() && !!Deno.env.get('APNS_SANDBOX_KEY_P8')?.trim();
}

async function createApnsJwt(environment: ApnsEnvironment = 'production'): Promise<string> {
    // Explicit legacy sandbox mode can still use an older dual-environment
    // key. Production fallback, however, requires dedicated sandbox secrets.
    const dedicatedSandbox = environment === 'sandbox' && sandboxCredentialsConfigured();
    const keyId = (Deno.env.get(dedicatedSandbox ? 'APNS_SANDBOX_KEY_ID' : 'APNS_KEY_ID') ?? '').trim();
    const teamId = (dedicatedSandbox ? Deno.env.get('APNS_SANDBOX_TEAM_ID')?.trim() : undefined) ||
        (Deno.env.get('APNS_TEAM_ID') ?? '').trim();
    const p8Key = Deno.env.get(dedicatedSandbox ? 'APNS_SANDBOX_KEY_P8' : 'APNS_KEY_P8') ?? '';
    if (!/^[A-Za-z0-9]{10}$/.test(keyId) || !/^[A-Za-z0-9]{10}$/.test(teamId) || !p8Key.trim()) {
        throw new Error('Invalid APNs signing configuration');
    }
    const now = Date.now();
    const cacheId = `${keyId}:${teamId}`;
    const cachedApnsJwt = cachedApnsJwts.get(cacheId);
    if (
        cachedApnsJwt &&
        cachedApnsJwt.keyId === keyId &&
        cachedApnsJwt.teamId === teamId &&
        cachedApnsJwt.p8Key === p8Key &&
        now >= cachedApnsJwt.issuedAt &&
        now < cachedApnsJwt.expiresAt
    ) {
        return cachedApnsJwt.token;
    }

    // Share both completed and in-flight signing across shore devices. Apple
    // expects token reuse; never reuse a token after credential rotation.
    const token = (async () => {
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
        // base64url() takes `ArrayBuffer | string` and UTF-8 encodes a string itself,
        // so handing it the JSON directly yields the same bytes as pre-encoding here.
        // Deno's current lib types no longer accept a Uint8Array in that position.
        const headerB64 = base64url(JSON.stringify(header));
        const claimsB64 = base64url(JSON.stringify(claims));
        const signingInput = `${headerB64}.${claimsB64}`;

        // Sign with ES256
        const signature = await crypto.subtle.sign(
            { name: 'ECDSA', hash: 'SHA-256' },
            key,
            encoder.encode(signingInput),
        );

        // WebCrypto already returns the 64-byte raw r || s signature JWT requires.
        // Do not DER-encode or convert it again.
        const sigB64 = base64url(signature);

        return `${signingInput}.${sigB64}`;
    })();
    const entry = { keyId, teamId, p8Key, issuedAt: now, expiresAt: now + 45 * 60_000, token };
    cachedApnsJwts.set(cacheId, entry);
    // Only two credential sets are expected; bound retained rotation history.
    if (cachedApnsJwts.size > 4) cachedApnsJwts.delete(cachedApnsJwts.keys().next().value!);
    try {
        return await token;
    } catch (error) {
        if (cachedApnsJwts.get(cacheId) === entry) cachedApnsJwts.delete(cacheId);
        throw error;
    }
}

// ---------- SEND PUSH ----------

async function sendApnsPush(
    deviceToken: string,
    title: string,
    body: string,
    data: Record<string, unknown>,
    failure: (reason: string) => void,
): Promise<boolean> {
    let stage = 'signing';
    try {
        const bundleId = Deno.env.get('APNS_BUNDLE_ID') || 'com.thalassa.weather';
        const urgentAlarm = ['drag', 'gps_lost', 'contact_lost'].includes(String(data.alarm_kind ?? 'drag'));
        const criticalAlertsEntitled = urgentAlarm && Deno.env.get('APNS_CRITICAL_ALERTS_ENABLED') === 'true';
        // Keep signing inside the guarded delivery path. A missing or rotated
        // APNs key must turn into a normal failed delivery so the queue claim
        // is released and the scheduled retry can recover after it is fixed.
        const useProduction = Deno.env.get('APNS_PRODUCTION') !== 'false';

        // A session-renewal reminder must not sound like a confirmed drag or
        // loss of monitoring. Keep it ordinary even after Critical approval.
        const soundName = urgentAlarm ? ANCHOR_ALARM_SOUND : 'default';
        const alertSound = criticalAlertsEntitled ? { critical: 1, name: soundName, volume: 1.0 } : soundName;
        const payload = {
            aps: {
                alert: { title, body },
                sound: alertSound,
                'interruption-level': criticalAlertsEntitled ? 'critical' : 'time-sensitive',
                // No 'content-available' — see send-push: there is no background
                // handler to wake, and the alarm is an alert, delivered as one.
                badge: 1,
            },
            ...data,
            // The app's notification tap router relies on this exact value.
            // Put it last so an untrusted/accidental caller payload cannot
            // send an anchor alarm to the wrong screen.
            notification_type: 'anchor_alarm',
        };

        const deliver = async (environment: ApnsEnvironment) => {
            stage = `${environment} signing`;
            const jwt = await createApnsJwt(environment);
            const host = environment === 'production'
                ? 'https://api.push.apple.com'
                : 'https://api.sandbox.push.apple.com';
            stage = `${environment} transport`;
            const response = await fetch(`${host}/3/device/${deviceToken}`, {
                method: 'POST',
                headers: {
                    authorization: `bearer ${jwt}`,
                    'apns-topic': bundleId,
                    'apns-push-type': 'alert',
                    'apns-priority': '10',
                    // Permit a temporarily disconnected shore phone to receive
                    // the alert, without delivering it outside the event lifetime.
                    'apns-expiration': String(data.expires_at_seconds),
                    'content-type': 'application/json',
                },
                body: JSON.stringify(payload),
                signal: AbortSignal.timeout(15_000),
            });

            if (response.ok) return { ok: true, status: response.status, reason: '' };
            const errorBody = await response.json().catch(() => ({}));
            // Store only Apple's short reason code, never tokens or credentials.
            const reason = typeof errorBody.reason === 'string' && /^[A-Za-z]{1,80}$/.test(errorBody.reason)
                ? errorBody.reason
                : 'Rejected';
            return { ok: false, status: response.status, reason };
        };
        const environment: ApnsEnvironment = useProduction ? 'production' : 'sandbox';
        const response = await deliver(environment);
        if (response.ok) return true;
        // Old Xcode registrations lack environment metadata. Retry only the
        // definitive production/device-environment mismatch, never an accepted
        // push, auth failure, timeout, throttling or a transient server error.
        if (useProduction && response.status === 400 && response.reason === 'BadDeviceToken') {
            if (!sandboxCredentialsConfigured()) {
                failure('APNs production 400 BadDeviceToken; sandbox credentials not configured');
                return false;
            }
            const fallback = await deliver('sandbox');
            if (fallback.ok) return true;
            failure(`APNs sandbox ${fallback.status} ${fallback.reason}`);
            return false;
        }
        failure(`APNs ${environment} ${response.status} ${response.reason}`);
        return false;
    } catch {
        failure(`APNs ${stage} failed`);
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

        const { record: webhookRecord, reminder: reminderRequested } = await req.json();
        const reminder = reminderRequested === true;

        if (!webhookRecord?.id) {
            return new Response(JSON.stringify({ error: 'Missing alarm record id' }), {
                status: 400,
            });
        }

        const supabase = createClient(Deno.env.get('SUPABASE_URL')!, serviceRoleKey);
        // Original event retry state is never reset to manufacture reminders.
        // Reminder sends instead acquire an independent atomic device claim.
        const { data: record, error: eventError } = reminder
            ? await supabase.from('anchor_alarm_events').select('*').eq('id', webhookRecord.id).maybeSingle()
            : await supabase.rpc('claim_anchor_alarm_event', { p_id: webhookRecord.id });
        if (eventError || !record) {
            return new Response(JSON.stringify({ error: 'Alarm record is missing, stale, or already processed' }), {
                status: 409,
            });
        }

        const { id, session_code, distance_m, swing_radius_m, vessel_lat, vessel_lon } = record;
        if (reminder && (record.resolved_at || record.incident_id !== id)) {
            return new Response(JSON.stringify({ sent: 0, message: 'No current reminder incident' }), { status: 200 });
        }
        const releaseClaim = async (message: string) => {
            if (reminder) return;
            await supabase
                .from('anchor_alarm_events')
                .update({ processing_at: null, last_error: message.slice(0, 500) })
                .eq('id', id)
                .is('notified_at', null);
        };

        // The boat's PHONE keeps this watch (126-03b): judged on its own
        // check-ins, never against a Pi binding. Only such rows exist after
        // the DB push, so a function deployed first never asks for columns
        // that are not there yet.
        const phoneKept = record.watchkeeper === 'phone';
        const sessionColumns: string = phoneKept ? 'expires_at,vessel_heartbeat_at,vessel_state' : 'expires_at';
        type SessionRow = { expires_at: string; vessel_heartbeat_at?: string | null; vessel_state?: string | null };
        // A stopped/expired session never keeps retrying a stale alarm.
        const { data: session, error: sessionError } = await supabase
            .from('anchor_watch_sessions')
            .select(sessionColumns)
            .eq('session_code', session_code)
            .maybeSingle<SessionRow>();
        if (sessionError) {
            await releaseClaim('Session lookup failed');
            return new Response(JSON.stringify({ error: 'Session lookup failed' }), { status: 503 });
        }
        if (!session || Date.parse(session.expires_at) <= Date.now()) {
            await supabase
                .from('anchor_alarm_events')
                .update({
                    resolved_at: new Date().toISOString(),
                    processing_at: null,
                    last_error: 'Session expired or ended',
                })
                .eq('id', id);
            return new Response(JSON.stringify({ sent: 0, message: 'Session expired or ended' }), { status: 200 });
        }

        // Look up device tokens for this session
        const { data: tokens, error } = await supabase
            .from('anchor_alarm_tokens')
            .select('id, device_token, platform, supports_reminders')
            .eq('session_code', session_code);

        if (error) {
            await releaseClaim('Token lookup failed');
            return new Response(JSON.stringify({ error: 'Token lookup failed' }), {
                status: 500,
            });
        }

        if (!tokens || tokens.length === 0) {
            // Joining/re-registering can race the alarm. No device receiving
            // it is NOT a successful notification; retain it for the sweeper.
            await releaseClaim('No shore device tokens; queued for retry');
            return new Response(JSON.stringify({ sent: 0, queued: true, message: 'No tokens' }), {
                status: 200,
            });
        }

        // Send push to all registered shore devices
        const { title, body, kind } = anchorAlarmMessage(record);
        let observedAt = record.created_at;
        let stillRelevant: boolean;
        let knownEndedOrRecovered: boolean;
        if (phoneKept) {
            // A beat since (or a weighed anchor) ends a quiet-phone page; the
            // phone's own drag push is good for 120 s. No Pi binding is read:
            // a silent one left by a refused hand-off once swallowed it.
            const heartbeatAt = session.vessel_heartbeat_at ? Date.parse(session.vessel_heartbeat_at) : null;
            stillRelevant = phoneWatchAlarmCurrent({
                kind,
                createdAt: Date.parse(record.created_at),
                heartbeatAt: Number.isFinite(heartbeatAt) ? heartbeatAt : null,
                vesselState: session.vessel_state ?? null,
                now: Date.now(),
            });
            knownEndedOrRecovered = true;
            if (kind === 'contact_lost') observedAt = new Date().toISOString();
        } else {
            // APNs acceptance cannot be recalled when the boat recovers. Recheck
            // current server-observed Pi state before every attempt and allow only
            // a short APNs delivery window, never an hour of queued old alarms.
            let bindingQuery = supabase
                .from('pi_anchor_sessions')
                .select('relay_id,last_heartbeat_at,gps_available,is_dragging,expires_at,authorised_at')
                .eq('session_code', session_code)
                .eq('owner_id', record.user_id);
            // A session can have more than one relay. Limit only after selecting
            // the event's exact watchkeeper, never resolve it based on another Pi.
            if (record.pi_relay_id) bindingQuery = bindingQuery.eq('relay_id', record.pi_relay_id);
            const { data: bindings, error: bindingError } = await bindingQuery.limit(1);
            if (bindingError) {
                await releaseClaim('Watch-state lookup failed');
                return new Response(JSON.stringify({ error: 'Watch-state lookup failed' }), { status: 503 });
            }
            const binding = bindings?.find(
                (candidate: { relay_id: string }) => !record.pi_relay_id || candidate.relay_id === record.pi_relay_id,
            );
            let relayEnabled = !record.pi_relay_id;
            if (record.pi_relay_id) {
                const { data: relay, error: relayError } = await supabase
                    .from('pi_diary_relays')
                    .select('enabled')
                    .eq('relay_id', record.pi_relay_id)
                    .eq('owner_id', record.user_id)
                    .maybeSingle();
                if (relayError) {
                    await releaseClaim('Relay status lookup failed');
                    return new Response(JSON.stringify({ error: 'Relay status lookup failed' }), { status: 503 });
                }
                relayEnabled = relay?.enabled === true;
            }
            const heartbeat = binding?.last_heartbeat_at ? Date.parse(binding.last_heartbeat_at) : 0;
            const fresh = binding && Date.parse(binding.expires_at) > Date.now() && Date.now() - heartbeat <= 35_000;
            stillRelevant = !record.pi_relay_id && Date.now() - Date.parse(record.created_at) <= 120_000;
            if (binding && relayEnabled && Date.parse(binding.expires_at) > Date.now()) {
                stillRelevant = kind === 'drag'
                    ? !!fresh && binding.gps_available && binding.is_dragging
                    : kind === 'gps_lost'
                    ? !!fresh && !binding.gps_available
                    : kind === 'contact_lost'
                    ? Date.now() - heartbeat > 60_000
                    // The 7-day lease from the skipper's last authorisation ends within 12 h
                    // (126-03b), or, before the DB push rolls sessions, the session itself
                    // ends within 15 min: a deploy ahead of the push still warns.
                    : piWatchEndsSoon(Date.parse(binding.authorised_at), Date.now()) ||
                        Date.parse(session.expires_at) - Date.now() <= 15 * 60_000;
                observedAt = kind === 'drag' || kind === 'gps_lost'
                    ? binding.last_heartbeat_at
                    : new Date().toISOString();
            }
            knownEndedOrRecovered = !record.pi_relay_id ||
                !binding ||
                !relayEnabled ||
                Date.parse(binding.expires_at) <= Date.now() ||
                (kind === 'drag' && !!fresh && binding.gps_available && !binding.is_dragging) ||
                (kind === 'gps_lost' && !!fresh && binding.gps_available) ||
                (kind === 'contact_lost' && Date.now() - heartbeat <= 60_000) ||
                kind === 'session_expiring';
        }
        if (!stillRelevant) {
            if (!knownEndedOrRecovered) {
                // A delayed heartbeat (or loss of GPS during a drag) is not
                // evidence that the boat recovered. Do not destroy incident
                // identity or the device ACK while awaiting a fresh report.
                await releaseClaim('Current alarm condition awaiting a fresh observation');
                return new Response(JSON.stringify({ sent: 0, queued: true, message: 'Awaiting fresh observation' }), {
                    status: 200,
                });
            }
            await supabase
                .from('anchor_alarm_events')
                .update({
                    resolved_at: new Date().toISOString(),
                    processing_at: null,
                    last_error: 'Condition recovered or unconfirmed stale event',
                })
                .eq('id', id);
            return new Response(JSON.stringify({ sent: 0, message: 'Alarm no longer current' }), { status: 200 });
        }
        const reportedTime = new Date(observedAt).toISOString().slice(11, 19);
        // The original event's metre/coordinate values are not a fresh fix.
        // Reminder validity is current, but do not describe old measurements
        // as if the latest heartbeat had supplied them to this function.
        const messageBody = reminder && kind === 'drag'
            ? 'The boat still reports an anchor drag alarm. Check the boat immediately.'
            : body;
        const timedBody = kind === 'session_expiring' ? messageBody : `${messageBody} Reported ${reportedTime} UTC.`;
        const alreadySent = new Set<string>(record.notified_device_tokens ?? []);
        type ShoreToken = { id: string; device_token: string; platform: string; supports_reminders?: boolean };
        const pending = tokens.filter((t: ShoreToken) =>
            reminder ? t.supports_reminders === true && !!record.incident_id : !alreadySent.has(t.device_token)
        );
        const failures: string[] = [];

        const results = await Promise.all(
            pending.map(async (t: ShoreToken) => {
                if (t.platform !== 'ios') return { ok: false, accepted: false };
                const data: Record<string, unknown> = {
                    alarm_type: kind === 'drag' ? 'anchor_drag' : kind,
                    alarm_kind: kind,
                    // Which keeper went quiet; shipped apps ignore it and read contact_lost.
                    ...(phoneKept ? { watchkeeper: 'phone' } : {}),
                    session_code,
                    ...(reminder ? {} : { distance_m, swing_radius_m, vessel_lat, vessel_lon }),
                    observed_at: observedAt,
                    expires_at_seconds: Math.floor(
                        Math.min(Date.now() + 60_000, Date.parse(session.expires_at)) / 1000,
                    ),
                };
                // Old clients cannot acknowledge repetitions. Preserve their
                // existing one-shot path; only upgraded registrations opt in.
                let delivery: { incident_id: string; claim_id: string; incident_started_at: string } | null = null;
                if (t.supports_reminders && record.incident_id) {
                    const claim = await supabase.rpc('claim_anchor_alarm_delivery', {
                        p_event_id: id,
                        p_token_id: t.id,
                    });
                    if (claim.error) {
                        failures.push('Device delivery claim failed');
                        return { ok: false, accepted: false };
                    }
                    if (!claim.data) return { ok: true, accepted: false };
                    delivery = claim.data;
                    Object.assign(data, {
                        incident_id: delivery!.incident_id,
                        incident_started_at: delivery!.incident_started_at,
                        token_id: t.id,
                    });
                    // Recheck ACK, ownership and live Pi condition immediately
                    // before external delivery. APNs already accepted cannot
                    // be recalled if recovery/ACK happens in the final race.
                    const current = await supabase.rpc('anchor_alarm_delivery_is_current', {
                        p_incident_id: delivery!.incident_id,
                        p_token_id: t.id,
                        p_claim_id: delivery!.claim_id,
                    });
                    if (current.error || current.data !== true) {
                        await supabase.rpc('finish_anchor_alarm_delivery', {
                            p_incident_id: delivery!.incident_id,
                            p_token_id: t.id,
                            p_claim_id: delivery!.claim_id,
                            p_accepted: false,
                        });
                        if (current.error) failures.push('Device delivery validation failed');
                        return { ok: !current.error, accepted: false };
                    }
                }
                const accepted = await sendApnsPush(
                    t.device_token,
                    title,
                    timedBody,
                    data,
                    (reason) => failures.push(reason),
                );
                if (delivery) {
                    const finish = await supabase.rpc('finish_anchor_alarm_delivery', {
                        p_incident_id: delivery.incident_id,
                        p_token_id: t.id,
                        p_claim_id: delivery.claim_id,
                        p_accepted: accepted,
                    });
                    // A failed completion cannot trigger an immediate resend:
                    // the two-minute claim remains held until its lease lapses.
                    if (finish.error) failures.push('Device delivery completion failed');
                }
                return { ok: accepted, accepted };
            }),
        );

        const sent = results.filter((result) => result.accepted).length;
        results.forEach((result, index) => {
            if (result.accepted) alreadySent.add(pending[index].device_token);
        });
        if (!reminder && sent > 0) {
            await supabase
                .from('anchor_alarm_events')
                .update({ notified_device_tokens: [...alreadySent] })
                .eq('id', id);
        }

        if (results.some((result) => !result.ok)) {
            await releaseClaim(
                `APNs delivery failed: ${[...new Set(failures)].join('; ') || 'Unsupported device platform'}`,
            );
            return new Response(JSON.stringify({ error: 'APNs delivery failed; queued for retry' }), {
                status: 502,
                headers: { 'Content-Type': 'application/json' },
            });
        }

        if (!reminder) {
            await supabase
                .from('anchor_alarm_events')
                .update({ notified_at: new Date().toISOString(), processing_at: null, last_error: null })
                .eq('id', id);
        }

        return new Response(JSON.stringify({ sent, total: tokens.length }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
    } catch {
        console.error('[send-anchor-alarm] unhandled request failure');
        return internalServerErrorResponse();
    }
});
