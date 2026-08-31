/**
 * DiaryRelayTransport — delivery policy and local Pi hand-off for diary text.
 *
 * The device outbox remains the source of truth until Supabase confirms the
 * row. A reachable Pi is therefore a second durable copy, not a risky
 * move-and-forget queue. The Pi receives an entry even when no WAN exists and
 * later forwards it with its own narrow relay credential. Direct cloud writes
 * are deliberately suppressed on satellite links.
 */

import { CapacitorHttp } from '@capacitor/core';
import { getConnectionState } from './ConnectionPriorityService';
import { getAuthIdentityScope, isAuthIdentityScopeCurrent, type AuthIdentityScope } from './authIdentityScope';
import { pinnedPiRequest } from './PiPairingService';
import { piCache } from './PiCacheService';
import { useSettingsStore } from '../stores/settingsStore';
import { getAuthenticatedFunctionHeaders } from './supabaseAuth';
import { supabaseUrl } from './supabase';
import { createLogger } from '../utils/createLogger';
import { PI_INTEGRATION_ENABLED } from './piPublicBetaBoundary';

const log = createLogger('DiaryRelayTransport');
const PAIR_TTL_MS = 10 * 60 * 1000;

export interface DiaryRelayEnvelope {
    client_operation_id: string;
    /** Monotonic revision for this logical diary entry. */
    client_revision: number;
    title: string;
    body: string;
    mood: string;
    photos: string[];
    audio_url: string | null;
    /** Storage/public URL only — the relay never carries phone-local media. */
    video_url?: string | null;
    latitude: number | null;
    longitude: number | null;
    location_name: string;
    weather_summary: string;
    weather_data?: Record<string, unknown> | null;
    voyage_id: string | null;
    /** Immutable `boats.id` carried through device, Pi, and cloud delivery. */
    boat_id?: string | null;
    tags: string[];
    is_public: boolean;
    created_at: string;
}

export interface PiDiaryRelayResult {
    accepted: boolean;
    status: 'queued' | 'synced' | 'cancelled';
    entry?: Record<string, unknown>;
}

interface PairedPi {
    relayId: string;
    pairedAt: number;
}

const pairedPis = new Map<string, PairedPi>();

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validOperationId(value: string): boolean {
    return /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function isManualSatelliteMode(): boolean {
    try {
        return useSettingsStore.getState().settings.satelliteMode === true;
    } catch {
        return false;
    }
}

/**
 * This is deliberately a permission rather than a reachability test. An
 * ordinary offline phone may still be on the Boat LAN while the Pi later
 * regains a normal WAN connection, so its already-queued diary must remain
 * eligible to leave the Pi. Satellite mode is the one state that actively
 * closes the Pi's internet gate.
 */
export function isDiaryRelayInternetAllowed(): boolean {
    if (isManualSatelliteMode()) return false;
    return getConnectionState().type !== 'satellite';
}

/**
 * Satellite mode is an explicit no-cloud policy. The Network Information API
 * is advisory, so the manual setting remains authoritative when it exists.
 */
export function canAttemptDiaryCloudDelivery(): boolean {
    if (typeof navigator === 'undefined' || !isDiaryRelayInternetAllowed()) return false;
    const connection = getConnectionState();
    // Both the browser `navigator.onLine` flag and the native connection
    // classifier can lag a restored Capacitor radio. Treat neither as proof
    // that a normal cloud route is impossible: a bounded authenticated write
    // is the liveness check. Satellite remains an explicit hard block.
    return connection.type !== 'satellite';
}

/**
 * Confirm that the actual Supabase origin is reachable. `navigator.onLine`
 * means only that a radio has a route; it does not prove the public internet.
 */
export async function hasReachableDiaryCloud(): Promise<boolean> {
    if (!canAttemptDiaryCloudDelivery()) return false;
    const base = (supabaseUrl || '').replace(/\/$/, '');
    // Unit/web-shell fallback: an injected Supabase client can be usable even
    // when this module was loaded without Vite env values. Production native
    // builds always have a concrete origin to probe.
    if (!base) return typeof navigator !== 'undefined' && navigator.onLine;
    try {
        const response = await fetch(`${base}/rest/v1/`, {
            method: 'HEAD',
            signal: AbortSignal.timeout(5_000),
        });
        return response.ok || response.status === 401 || response.status === 403;
    } catch {
        return false;
    }
}

async function postToPi<T>(path: string, body: unknown): Promise<T | null> {
    if (!PI_INTEGRATION_ENABLED || !piCache.isAvailable()) return null;
    const url = `${piCache.baseUrl}${path}`;
    try {
        // Pinned transport, no plain fallback (2026-08-07). This is the path
        // that carries the diary relay token to the Pi — the single strongest
        // reason the boat LAN went to TLS. A CapacitorHttp/fetch fallback
        // cannot complete the pinned handshake anyway, so it would only turn
        // a clear failure into a confusing one.
        const response = await pinnedPiRequest({
            url,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            data: body,
            connectTimeout: 2_500,
            readTimeout: 4_000,
            responseType: 'text',
        });
        if (response.status < 200 || response.status >= 300) return null;
        try {
            return JSON.parse(response.data) as T;
        } catch {
            return null;
        }
    } catch {
        return null;
    }
}

async function configurePiRelay(
    relay: { relayId: string; ownerId: string; token: string },
    allowInternet: boolean,
): Promise<boolean> {
    if (!PI_INTEGRATION_ENABLED) return false;
    return piCache.pushConfig({
        supabaseUrl: '',
        supabaseAnonKey: '',
        diaryRelayUrl: `${(supabaseUrl || '').replace(/\/$/, '')}/functions/v1/diary-relay`,
        diaryRelayId: relay.relayId,
        diaryRelayOwnerId: relay.ownerId,
        diaryRelayToken: relay.token,
        diaryRelayAllowInternet: allowInternet,
    });
}

/**
 * Keep the Pi's independently persisted WAN gate in step with the skipper's
 * satellite policy. `true` means a future *ordinary* connection may drain its
 * outbox; it does not assert that the phone is online right now.
 */
export async function syncPiDiaryRelayInternetPolicy(): Promise<boolean> {
    if (!PI_INTEGRATION_ENABLED) return false;
    return piCache.setDiaryRelayInternetPolicy(isDiaryRelayInternetAllowed());
}

/** Submit a complete diary revision directly to Supabase through the same
 * monotonic/tombstone-aware Edge boundary that the Pi uses. */
export async function submitDiaryDirect(entry: DiaryRelayEnvelope): Promise<Record<string, unknown> | null> {
    if (
        !validOperationId(entry.client_operation_id) ||
        !Number.isInteger(entry.client_revision) ||
        entry.client_revision < 1
    ) {
        return null;
    }
    if (!canAttemptDiaryCloudDelivery()) return null;
    const scope = getAuthIdentityScope();
    if (!scope.userId || !isAuthIdentityScopeCurrent(scope)) return null;
    const base = (supabaseUrl || '').replace(/\/$/, '');
    if (!base) return null;
    try {
        const headers = await getAuthenticatedFunctionHeaders();
        if (!isAuthIdentityScopeCurrent(scope)) return null;
        const response = await fetch(`${base}/functions/v1/diary-relay`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ action: 'upsert', entry }),
            signal: AbortSignal.timeout(12_000),
        });
        // NAME THE STATUS. This returned null for every non-2xx without reading
        // the body, so "the function is not deployed" (404), "bad JWT" (401),
        // "invalid envelope" (400) and "we are offshore" were one indistinct
        // outcome. diary-relay is the ONLY route to diary_entries, so a
        // systematic non-2xx is a permanent zero-row condition — and it was
        // exactly that for a week (the function was never deployed) with
        // nothing in the console to say so.
        //
        // 4xx is called out separately because retrying cannot fix it: the
        // request is wrong or unauthorised, and the sync loop will otherwise
        // repeat it forever at 30s intervals.
        if (!response.ok) {
            const body = await response.text().catch(() => '');
            const detail = body.slice(0, 200);
            if (response.status >= 400 && response.status < 500) {
                log.warn(
                    `[Diary] diary-relay rejected the entry (HTTP ${response.status}) — retrying cannot fix this: ${detail}`,
                );
            } else {
                log.warn(`[Diary] diary-relay unavailable (HTTP ${response.status}) — will retry: ${detail}`);
            }
            return null;
        }
        if (!isAuthIdentityScopeCurrent(scope)) return null;
        const data: unknown = await response.json();
        return isRecord(data) && data.ok === true && isRecord(data.entry) ? data.entry : null;
    } catch (error) {
        log.debug('Direct diary delivery deferred:', error);
        return null;
    }
}

/** Persist a cancellation in the Pi while on Boat LAN. The Pi will relay it
 * before any queued creates when ordinary Internet is permitted again. */
export async function cancelDiaryOnPi(clientOperationId: string): Promise<boolean> {
    if (!PI_INTEGRATION_ENABLED || !validOperationId(clientOperationId) || !piCache.isAvailable()) return false;
    const scope = getAuthIdentityScope();
    const status = piCache.getStatus();
    if (status.diaryRelayConfigured && status.diaryRelayOwnerId && status.diaryRelayOwnerId !== scope.userId)
        return false;
    const result = await postToPi<{ accepted?: unknown }>('/api/diary/cancel', {
        client_operation_id: clientOperationId,
    });
    return result?.accepted === true;
}

/** Write the authoritative cloud tombstone before a delayed Pi create can
 * resurrect an entry. This intentionally uses real authenticated cloud only. */
export async function cancelDiaryDirect(clientOperationId: string): Promise<boolean> {
    if (!validOperationId(clientOperationId) || !canAttemptDiaryCloudDelivery()) return false;
    const scope = getAuthIdentityScope();
    if (!scope.userId || !isAuthIdentityScopeCurrent(scope)) return false;
    const base = (supabaseUrl || '').replace(/\/$/, '');
    if (!base) return false;
    try {
        const headers = await getAuthenticatedFunctionHeaders();
        if (!isAuthIdentityScopeCurrent(scope)) return false;
        const response = await fetch(`${base}/functions/v1/diary-relay`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ action: 'cancel', client_operation_id: clientOperationId }),
            signal: AbortSignal.timeout(12_000),
        });
        if (!response.ok || !isAuthIdentityScopeCurrent(scope)) return false;
        const data: unknown = await response.json();
        return isRecord(data) && data.ok === true && data.cancelled === true;
    } catch (error) {
        log.debug('Direct diary cancellation deferred:', error);
        return false;
    }
}

async function pairPiWhenCloudIsAvailable(scope: AuthIdentityScope, allowInternet: boolean): Promise<boolean> {
    if (!PI_INTEGRATION_ENABLED) return false;
    if (!allowInternet || !scope.userId || !isAuthIdentityScopeCurrent(scope)) return false;
    const status = piCache.getStatus();
    const relayId = status.diaryRelayId;
    if (!relayId) return false; // graceful fallback for a Pi awaiting the relay-capable update

    const pairKey = `${scope.key}:${relayId}`;
    const paired = pairedPis.get(pairKey);
    if (paired && status.diaryRelayConfigured && Date.now() - paired.pairedAt < PAIR_TTL_MS) {
        // A policy flip still needs to reach the Pi even though its credential
        // is current. The Pi requires its own persisted policy plus this
        // envelope's flag before it will touch the WAN.
        return piCache.pushConfig({
            supabaseUrl: '',
            supabaseAnonKey: '',
            diaryRelayAllowInternet: allowInternet,
        });
    }

    try {
        const headers = await getAuthenticatedFunctionHeaders();
        if (!isAuthIdentityScopeCurrent(scope)) return false;
        const base = (supabaseUrl || '').replace(/\/$/, '');
        if (!base) return false;
        const response = await fetch(`${base}/functions/v1/diary-relay`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ action: 'pair', relay_id: relayId }),
            signal: AbortSignal.timeout(8_000),
        });
        if (!response.ok || !isAuthIdentityScopeCurrent(scope)) return false;
        const data = (await response.json()) as {
            relay_id?: unknown;
            owner_id?: unknown;
            token?: unknown;
            already_paired?: unknown;
        };
        if (data.relay_id === relayId && data.owner_id === scope.userId && data.already_paired === true) {
            // The Pi already owns the credential. Do not rotate it simply
            // because a phone reconnected; a failed LAN config write after a
            // rotation could otherwise strand every queued entry on the Pi.
            if (!status.diaryRelayConfigured || status.diaryRelayOwnerId !== scope.userId) return false;
            const configured = await piCache.pushConfig({
                supabaseUrl: '',
                supabaseAnonKey: '',
                diaryRelayAllowInternet: allowInternet,
            });
            if (configured && isAuthIdentityScopeCurrent(scope)) {
                pairedPis.set(pairKey, { relayId, pairedAt: Date.now() });
            }
            return configured;
        }
        if (
            data.relay_id !== relayId ||
            data.owner_id !== scope.userId ||
            typeof data.token !== 'string' ||
            !/^[0-9a-f]{64}$/i.test(data.token)
        ) {
            return false;
        }
        const configured = await configurePiRelay(
            { relayId, ownerId: scope.userId, token: data.token.toLowerCase() },
            allowInternet,
        );
        if (configured && isAuthIdentityScopeCurrent(scope)) {
            pairedPis.set(pairKey, { relayId, pairedAt: Date.now() });
        }
        return configured;
    } catch (error) {
        log.debug('Pi diary relay pairing deferred:', error);
        return false;
    }
}

/**
 * Hand off a durable local entry to the Pi. The caller retains its device
 * copy until this result says `synced`, so loss of Pi power or storage cannot
 * lose a skipper's words. Repeating the hand-off is intentional and is
 * deduplicated by `client_operation_id` on both the Pi and Supabase.
 */
/** Base64 a slice without materialising a giant intermediate string. */
function chunkToBase64(bytes: Uint8Array): string {
    let binary = '';
    const STEP = 0x8000;
    for (let i = 0; i < bytes.length; i += STEP) {
        binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + STEP)));
    }
    return btoa(binary);
}

/**
 * Lend the clip to the Pi: it uploads to Storage when the boat has WAN, long
 * after this phone has gone to sleep. Returns true only when the Pi holds a
 * checksum-verified copy — at which point the Pi owns the clip and the phone
 * may delete its local blob. Any failure returns false and the caller falls
 * back to the direct upload it would have done anyway.
 *
 * Chunked because the bridge cannot carry 200MB, and because boat WiFi drops
 * mid-transfer as a matter of routine — a resend of one 4MB chunk beats a
 * restart of the lot.
 */
export async function handoffVideoToPi(blob: Blob, clientOperationId: string, path: string): Promise<boolean> {
    if (!PI_INTEGRATION_ENABLED || !piCache.isAvailable() || !validOperationId(clientOperationId)) return false;
    const scope = getAuthIdentityScope();
    if (!scope.userId || !isAuthIdentityScopeCurrent(scope)) return false;
    const status = piCache.getStatus();
    // Same owner rule as the diary rows: a crew member's clip must not park
    // under the skipper's pairing.
    if (!status.diaryRelayConfigured || status.diaryRelayOwnerId !== scope.userId) return false;

    try {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const digest = await crypto.subtle.digest('SHA-256', bytes);
        const sha256 = Array.from(new Uint8Array(digest))
            .map((b) => b.toString(16).padStart(2, '0'))
            .join('');

        const begin = await pinnedPiRequest({
            url: `${piCache.baseUrl}/api/diary/video/begin`,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            data: { client_operation_id: clientOperationId, path, total_bytes: bytes.length, sha256 },
            connectTimeout: 5000,
            readTimeout: 15000,
            responseType: 'text',
        });
        if (begin.status < 200 || begin.status >= 300) return false;
        const opened = (typeof begin.data === 'string' ? JSON.parse(begin.data) : begin.data) as { id?: string };
        if (!opened.id) return false;

        const CHUNK = 4 * 1024 * 1024;
        for (let index = 0, offset = 0; offset < bytes.length; index++, offset += CHUNK) {
            const piece = chunkToBase64(bytes.subarray(offset, offset + CHUNK));
            const sent = await pinnedPiRequest({
                url: `${piCache.baseUrl}/api/diary/video/chunk/${opened.id}/${index}`,
                method: 'POST',
                headers: { 'Content-Type': 'text/plain' },
                data: piece,
                connectTimeout: 5000,
                readTimeout: 60000,
                responseType: 'text',
            });
            if (sent.status < 200 || sent.status >= 300) return false;
            if (!isAuthIdentityScopeCurrent(scope)) return false;
        }

        const done = await pinnedPiRequest({
            url: `${piCache.baseUrl}/api/diary/video/finish/${opened.id}`,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            data: {},
            connectTimeout: 5000,
            readTimeout: 60000,
            responseType: 'text',
        });
        return done.status >= 200 && done.status < 300;
    } catch (error) {
        log.warn('[DiaryVideo] Pi hand-off failed; falling back to direct upload', error);
        return false;
    }
}

export async function handoffDiaryToPi(entry: DiaryRelayEnvelope): Promise<PiDiaryRelayResult | null> {
    if (!PI_INTEGRATION_ENABLED || !entry.client_operation_id || !piCache.isAvailable()) return null;
    const scope = getAuthIdentityScope();
    if (!scope.userId || !isAuthIdentityScopeCurrent(scope)) return null;
    const status = piCache.getStatus();

    // A relay credential is bound to one owner. Do not let a crew member's
    // private diary be written under the skipper's account; their direct
    // cloud path remains available.
    if (status.diaryRelayConfigured && status.diaryRelayOwnerId && status.diaryRelayOwnerId !== scope.userId) {
        return null;
    }

    // A queue row must be bound to the same owner before it ever reaches the
    // Pi. In particular, do not enqueue an unpaired row merely because a
    // cloud probe failed: a later pairing by a different crew member could
    // otherwise attribute the private words to the wrong skipper.
    let relayReady = status.diaryRelayConfigured && status.diaryRelayOwnerId === scope.userId;
    if (relayReady) {
        // A previously paired Pi is already a safe durable sink. Do not make
        // that Boat-LAN hand-off depend on the phone being able to reach the
        // Edge Function right now: iOS commonly reports Wi-Fi online while
        // the boat LAN itself has no WAN. Keep the Pi's persisted policy in
        // step immediately. Pairing is only first-provisioning/recovery work:
        // re-pairing an already configured Pi per diary entry can burn the
        // deliberately narrow Edge quota and create a needless failure path.
        if (!isDiaryRelayInternetAllowed()) {
            // Closing the gate is safety-critical. Do not enqueue an entry
            // that the Pi could immediately forward over satellite while an
            // asynchronous policy update is still in flight.
            relayReady = await syncPiDiaryRelayInternetPolicy();
        } else {
            // Opening/refreshing a normal-WAN policy is best effort: the
            // already paired Pi remains a safe local durable sink either way.
            void syncPiDiaryRelayInternetPolicy();
        }
    } else if (canAttemptDiaryCloudDelivery()) {
        relayReady = await pairPiWhenCloudIsAvailable(scope, true);
    } else {
        // An ordinary offline phone may still be on the Boat LAN while the Pi
        // later regains a normal WAN. Satellite is the one state that closes
        // the Pi-wide gate; neither state changes ownership of queued work.
        await syncPiDiaryRelayInternetPolicy();
    }
    if (!relayReady || !isAuthIdentityScopeCurrent(scope)) return null;

    const result = await postToPi<PiDiaryRelayResult>('/api/diary/entries', {
        entry,
        allowInternet: true,
    });
    if (
        !result ||
        result.accepted !== true ||
        (result.status !== 'queued' && result.status !== 'synced' && result.status !== 'cancelled')
    ) {
        return null;
    }
    return result;
}
