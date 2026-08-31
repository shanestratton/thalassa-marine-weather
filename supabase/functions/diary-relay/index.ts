// deno-lint-ignore-file no-explicit-any
/**
 * diary-relay — secure store-and-forward ingestion for the boat Pi.
 *
 * A signed-in device first pairs a Pi instance (`action: "pair"`). The
 * function returns a random bearer that is stored by the Pi, while only its
 * SHA-256 digest is retained in `pi_diary_relays`. The Pi can subsequently
 * POST an already-persisted diary envelope without holding a Supabase service
 * role key. The entry is revisioned by `(user_id, client_operation_id)`, so a
 * delayed Pi snapshot cannot overwrite a newer device edit. A durable
 * cancellation fence also makes a deleted operation impossible to resurrect.
 *
 * This function must be deployed with JWT verification disabled: the `pair`
 * action authenticates a real user explicitly, while ingestion uses the
 * dedicated per-Pi bearer header.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { requireAuthenticatedQuota, withCors } from '../_shared/auth-rate-limit.ts';
import { jsonResponse, parseCoordinate, readJsonObject } from '../_shared/http-security.ts';

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

const RELAY_ID_RE = /^[A-Za-z0-9_-]{16,128}$/;
const OPERATION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const TOKEN_RE = /^[0-9a-f]{64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MOODS = new Set(['epic', 'good', 'neutral', 'rough', 'storm']);
const MAX_CLIENT_REVISION = 999_999_999;

type RelayRow = {
    owner_id: string;
    token_hash: string;
    enabled: boolean;
};

type NormalizedDiaryEntry = Record<string, unknown> & {
    client_operation_id: string;
    client_revision: number;
    is_public: boolean;
};

function json(body: unknown, status = 200): Response {
    return jsonResponse(body, status, CORS);
}

function boundedString(value: unknown, max: number, fallback = ''): string {
    if (typeof value !== 'string') return fallback;
    return value.trim().slice(0, max);
}

function boundedNullableString(value: unknown, max: number): string | null {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value !== 'string') return null;
    const trimmed = value.trim().slice(0, max);
    return trimmed || null;
}

/**
 * `boat_id` is optional for legacy diary rows, but when supplied it must be
 * a real UUID. Ownership is enforced again by the database relay RPC; this
 * normalization simply prevents malformed Pi/device payloads from becoming
 * an unbound foreign-looking identifier in the durable database write.
 */
function nullableBoatId(value: unknown): string | null {
    const candidate = boundedNullableString(value, 64);
    return candidate && UUID_RE.test(candidate) ? candidate.toLowerCase() : null;
}

function boundedStringArray(value: unknown, maxItems: number, maxItemLength: number): string[] {
    if (!Array.isArray(value)) return [];
    const values: string[] = [];
    for (const item of value) {
        const cleaned = boundedString(item, maxItemLength);
        if (cleaned && !values.includes(cleaned)) values.push(cleaned);
        if (values.length >= maxItems) break;
    }
    return values;
}

function validIso(value: unknown): string | null {
    if (typeof value !== 'string' || value.length > 64) return null;
    const time = Date.parse(value);
    return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function ownedStorageRef(value: unknown, bucket: 'diary-photos' | 'diary-audio', ownerId: string): string | null {
    if (typeof value !== 'string' || value.length > 2048) return null;
    const prefix = `storage:${bucket}:${ownerId}/`;
    return value.startsWith(prefix) ? value : null;
}

function weatherData(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const raw = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    const description = boundedString(raw.description, 240);
    if (description) output.description = description;
    for (const key of ['airTemp', 'seaTemp', 'windSpeed', 'humidity', 'rain']) {
        const candidate = raw[key];
        if (typeof candidate === 'number' && Number.isFinite(candidate) && Math.abs(candidate) <= 10_000) {
            output[key] = candidate;
        }
    }
    const windDir = boundedString(raw.windDir, 12);
    if (windDir) output.windDir = windDir;
    return Object.keys(output).length > 0 ? output : null;
}

function normalizeClientRevision(value: unknown): number | null {
    // The first deployed relay did not send revisions. Treat that legacy
    // envelope as revision 1, but never coerce malformed values to a revision
    // that could unexpectedly win an ordering race.
    if (value === null || value === undefined || value === '') return 1;
    const revision = typeof value === 'number'
        ? value
        : typeof value === 'string' && /^[1-9][0-9]{0,8}$/.test(value)
        ? Number(value)
        : NaN;
    return Number.isSafeInteger(revision) && revision >= 1 && revision <= MAX_CLIENT_REVISION ? revision : null;
}

function normalizeEntry(value: unknown, ownerId: string): NormalizedDiaryEntry | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const raw = value as Record<string, unknown>;
    const clientOperationId = boundedString(raw.client_operation_id, 128);
    if (!OPERATION_ID_RE.test(clientOperationId)) return null;
    const clientRevision = normalizeClientRevision(raw.client_revision);
    if (clientRevision === null) return null;

    const mood = boundedString(raw.mood, 16, 'neutral');
    const latitude = raw.latitude === null || raw.latitude === undefined ? null : parseCoordinate(raw.latitude, 'lat');
    const longitude = raw.longitude === null || raw.longitude === undefined
        ? null
        : parseCoordinate(raw.longitude, 'lon');
    if (
        (raw.latitude !== null && raw.latitude !== undefined && latitude === null) ||
        (raw.longitude !== null && raw.longitude !== undefined && longitude === null)
    ) {
        return null;
    }

    const photos = boundedStringArray(raw.photos, 12, 2048)
        .map((photo) => ownedStorageRef(photo, 'diary-photos', ownerId))
        .filter((photo): photo is string => Boolean(photo));
    const audioUrl = ownedStorageRef(raw.audio_url, 'diary-audio', ownerId);
    const videoUrl = ownedStorageRef(raw.video_url, 'diary-video', ownerId);
    const createdAt = validIso(raw.created_at) ?? new Date().toISOString();

    return {
        user_id: ownerId,
        client_operation_id: clientOperationId,
        client_revision: clientRevision,
        title: boundedString(raw.title, 2_000),
        body: boundedString(raw.body, 100_000),
        mood: MOODS.has(mood) ? mood : 'neutral',
        photos,
        audio_url: audioUrl,
        video_url: videoUrl,
        latitude,
        longitude,
        location_name: boundedString(raw.location_name, 1_000),
        weather_summary: boundedString(raw.weather_summary, 2_000),
        weather_data: weatherData(raw.weather_data),
        voyage_id: boundedNullableString(raw.voyage_id, 512),
        boat_id: nullableBoatId(raw.boat_id),
        tags: boundedStringArray(raw.tags, 30, 100),
        is_public: raw.is_public === true,
        created_at: createdAt,
    };
}

function bytesToHex(bytes: Uint8Array): string {
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256(value: string): Promise<string> {
    return bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))));
}

function secureEqual(left: string, right: string): boolean {
    if (left.length !== right.length) return false;
    let different = 0;
    for (let index = 0; index < left.length; index++) different |= left.charCodeAt(index) ^ right.charCodeAt(index);
    return different === 0;
}

function randomToken(): string {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return bytesToHex(bytes);
}

async function adminClient() {
    const url = Deno.env.get('SUPABASE_URL');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!url || !serviceRoleKey) return null;
    return createClient(url, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
}

type RelayAuthorization = {
    ownerId: string;
    relayId: string;
    admin: NonNullable<Awaited<ReturnType<typeof adminClient>>>;
};

type RelayPairing = Pick<RelayRow, 'owner_id' | 'enabled'>;

async function loadRelayPairing(
    admin: RelayAuthorization['admin'],
    relayId: string,
): Promise<{ relay: RelayPairing | null; unavailable: boolean }> {
    const { data, error } = await admin
        .from('pi_diary_relays')
        .select('owner_id, enabled')
        .eq('relay_id', relayId)
        .maybeSingle();
    if (error) {
        console.error('[diary-relay] pair lookup failed:', error.message);
        return { relay: null, unavailable: true };
    }

    if (!data) return { relay: null, unavailable: false };
    const relay = data as Partial<RelayPairing>;
    if (typeof relay.owner_id !== 'string' || typeof relay.enabled !== 'boolean') {
        console.error('[diary-relay] pair lookup returned an invalid relay row');
        return { relay: null, unavailable: true };
    }
    return { relay: { owner_id: relay.owner_id, enabled: relay.enabled }, unavailable: false };
}

function existingPairingResponse(relay: RelayPairing, relayId: string, ownerId: string): Response {
    if (relay.owner_id !== ownerId) {
        return json({ error: 'This Pi is paired to another skipper' }, 403);
    }

    // A disabled pairing is deliberately inert. Do not make ordinary app
    // retries re-enable it or mint a new bearer: an explicit recovery/reset
    // flow must own that state transition.
    if (!relay.enabled) {
        return json({ error: 'This Pi pairing is disabled; reset it before pairing again' }, 409);
    }

    // A phone never needs to know the Pi's bearer after the initial pairing:
    // the Pi already holds it durably. Reissuing a token every time a phone
    // reconnects creates a dangerous failure window where a Boat-LAN handoff
    // fails after the server has invalidated the Pi's working credential.
    return json({ relay_id: relayId, owner_id: ownerId, already_paired: true });
}

async function pairRelay(req: Request, body: Record<string, unknown>): Promise<Response> {
    const caller = await requireAuthenticatedQuota(req, 'pi_diary_pair', 24, 86_400);
    if (caller instanceof Response) return withCors(caller, CORS);

    const relayId = boundedString(body.relay_id, 128);
    if (!RELAY_ID_RE.test(relayId)) return json({ error: 'Invalid Pi relay id' }, 400);

    const admin = await adminClient();
    if (!admin) return json({ error: 'Diary relay is not configured' }, 503);

    const beforeClaim = await loadRelayPairing(admin, relayId);
    if (beforeClaim.unavailable) {
        return json({ error: 'Diary relay unavailable' }, 503);
    }
    if (beforeClaim.relay) return existingPairingResponse(beforeClaim.relay, relayId, caller.userId);

    const token = randomToken();
    const tokenHash = await sha256(token);
    const { error: pairError } = await admin.from('pi_diary_relays').insert({
        relay_id: relayId,
        owner_id: caller.userId,
        token_hash: tokenHash,
        enabled: true,
        updated_at: new Date().toISOString(),
    });
    if (!pairError) {
        return json({ relay_id: relayId, owner_id: caller.userId, token });
    }

    // `relay_id` is unique. The insert is the atomic first claim; if another
    // request claims it between our read and insert, never write over that
    // row. Re-read the winner and expose only a stable same-owner pairing.
    if (pairError.code === '23505') {
        const afterConflict = await loadRelayPairing(admin, relayId);
        if (afterConflict.unavailable) return json({ error: 'Diary relay unavailable' }, 503);
        if (afterConflict.relay) return existingPairingResponse(afterConflict.relay, relayId, caller.userId);

        // A concurrent administrative delete can make a unique conflict
        // briefly unobservable. Retrying an update here would be unsafe,
        // because it could claim a newly-created row from another skipper.
        console.error('[diary-relay] pair conflict had no readable winner');
        return json({ error: 'Diary relay unavailable' }, 503);
    }

    console.error('[diary-relay] pair insert failed:', pairError.message);
    return json({ error: 'Diary relay unavailable' }, 503);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasRelayCredentialHeaders(req: Request): boolean {
    return Boolean(
        req.headers.get('x-thalassa-pi-relay-id')?.trim() || req.headers.get('x-thalassa-pi-relay-token')?.trim(),
    );
}

async function authenticateRelay(req: Request): Promise<RelayAuthorization | Response> {
    const relayId = req.headers.get('x-thalassa-pi-relay-id')?.trim() ?? '';
    const token = req.headers.get('x-thalassa-pi-relay-token')?.trim().toLowerCase() ?? '';
    if (!RELAY_ID_RE.test(relayId) || !TOKEN_RE.test(token)) return json({ error: 'Invalid relay credentials' }, 401);

    const admin = await adminClient();
    if (!admin) return json({ error: 'Diary relay is not configured' }, 503);

    const { data: relay, error: relayError } = await admin
        .from('pi_diary_relays')
        .select('owner_id, token_hash, enabled')
        .eq('relay_id', relayId)
        .maybeSingle();
    if (relayError || !relay) {
        if (relayError) console.error('[diary-relay] relay lookup failed:', relayError.message);
        return json({ error: 'Relay not recognised' }, 401);
    }
    const relayRow = relay as RelayRow;
    if (!relayRow.enabled || !secureEqual(await sha256(token), relayRow.token_hash)) {
        return json({ error: 'Relay not authorised' }, 401);
    }

    return { ownerId: relayRow.owner_id, relayId, admin };
}

function touchRelay(admin: RelayAuthorization['admin'], relayId: string | undefined): void {
    if (!relayId) return;
    // Best effort only: a heartbeat failure cannot turn a committed envelope
    // into a retry or leak an operational detail to a Pi.
    void admin.from('pi_diary_relays').update({ last_seen_at: new Date().toISOString() }).eq('relay_id', relayId);
}

async function persistEntry(
    admin: RelayAuthorization['admin'],
    ownerId: string,
    entry: NormalizedDiaryEntry,
    relayId?: string,
): Promise<Response> {
    const { data, error } = await admin.rpc('diary_relay_upsert_entry', {
        p_owner_id: ownerId,
        p_entry: entry,
    });
    if (error) {
        console.error('[diary-relay] revisioned diary upsert failed:', error.message);
        return json({ error: 'Diary relay write failed' }, 503);
    }

    const outcome = Array.isArray(data) ? data[0] : data;
    if (!isRecord(outcome)) {
        console.error('[diary-relay] revisioned diary upsert returned no outcome');
        return json({ error: 'Diary relay write failed' }, 503);
    }
    if (outcome.status === 'cancelled') {
        touchRelay(admin, relayId);
        return json(
            {
                ok: false,
                cancelled: true,
                client_operation_id: entry.client_operation_id,
            },
            409,
        );
    }

    if ((outcome.status !== 'accepted' && outcome.status !== 'stale') || !isRecord(outcome.entry)) {
        console.error('[diary-relay] revisioned diary upsert returned an invalid outcome');
        return json({ error: 'Diary relay write failed' }, 503);
    }

    touchRelay(admin, relayId);
    return json({ ok: true, status: outcome.status, entry: outcome.entry });
}

async function deviceUpsert(req: Request, body: Record<string, unknown>): Promise<Response> {
    const caller = await requireAuthenticatedQuota(req, 'diary_relay_upsert', 10_000, 86_400);
    if (caller instanceof Response) return withCors(caller, CORS);

    const entry = normalizeEntry(body.entry, caller.userId);
    if (!entry) return json({ error: 'Invalid diary entry envelope' }, 400);

    const admin = await adminClient();
    if (!admin) return json({ error: 'Diary relay is not configured' }, 503);
    return persistEntry(admin, caller.userId, entry);
}

function cancellationOperationId(body: Record<string, unknown>): string | null {
    const direct = boundedString(body.client_operation_id ?? body.operation_id, 128);
    if (OPERATION_ID_RE.test(direct)) return direct;

    if (isRecord(body.entry)) {
        const nested = boundedString(body.entry.client_operation_id, 128);
        if (OPERATION_ID_RE.test(nested)) return nested;
    }
    return null;
}

async function persistCancellation(
    admin: RelayAuthorization['admin'],
    ownerId: string,
    operationId: string,
    relayId?: string,
): Promise<Response> {
    const { data, error } = await admin.rpc('diary_relay_cancel_entry', {
        p_owner_id: ownerId,
        p_client_operation_id: operationId,
    });
    if (error) {
        console.error('[diary-relay] diary cancellation failed:', error.message);
        return json({ error: 'Diary cancellation failed' }, 503);
    }

    const outcome = Array.isArray(data) ? data[0] : data;
    if (!isRecord(outcome) || outcome.status !== 'cancelled') {
        console.error('[diary-relay] diary cancellation returned an invalid outcome');
        return json({ error: 'Diary cancellation failed' }, 503);
    }

    touchRelay(admin, relayId);
    return json({ ok: true, cancelled: true, client_operation_id: operationId });
}

async function cancelDiary(req: Request, body: Record<string, unknown>): Promise<Response> {
    const operationId = cancellationOperationId(body);
    if (!operationId) return json({ error: 'Invalid diary cancellation operation id' }, 400);

    // A Pi needs no user JWT after pairing. If either relay header is present,
    // require a complete valid pair rather than silently falling through to a
    // user session (which would make a malformed Pi retry ambiguous).
    if (hasRelayCredentialHeaders(req)) {
        const relay = await authenticateRelay(req);
        if (relay instanceof Response) return relay;
        return persistCancellation(relay.admin, relay.ownerId, operationId, relay.relayId);
    }

    const caller = await requireAuthenticatedQuota(req, 'diary_relay_cancel', 1_000, 86_400);
    if (caller instanceof Response) return withCors(caller, CORS);

    const admin = await adminClient();
    if (!admin) return json({ error: 'Diary relay is not configured' }, 503);
    return persistCancellation(admin, caller.userId, operationId);
}

/**
 * A signed upload URL for ONE video object in the paired skipper's folder.
 *
 * The Pi holds a diary clip it received over the boat LAN and needs somewhere
 * to put it when WAN returns. It authenticates exactly as it does to write a
 * diary row, and the grant is as narrow as storage allows: one object, in the
 * caller's own folder, in the diary-video bucket, with the URL's built-in
 * expiry. The Pi never sees a credential it could reuse for anything else.
 */
async function videoUploadUrl(req: Request, body: Record<string, unknown>): Promise<Response> {
    const relay = await authenticateRelay(req);
    if (relay instanceof Response) return relay;

    const path = typeof body.path === 'string' ? body.path : '';
    if (!/^[0-9a-f-]{16,64}\/[0-9]{10,16}\.(mp4|mov)$/.test(path) || !path.startsWith(`${relay.ownerId}/`)) {
        return json({ error: 'Video path must be a single object in your own folder' }, 400);
    }

    const { data, error } = await relay.admin.storage.from('diary-video').createSignedUploadUrl(path);
    if (error || !data?.signedUrl) {
        console.error('[diary-relay] signed upload URL failed:', error?.message);
        return json({ error: 'Could not create an upload grant' }, 503);
    }
    return json({ url: data.signedUrl, path });
}

async function ingestRelay(req: Request, body: Record<string, unknown>): Promise<Response> {
    const relay = await authenticateRelay(req);
    if (relay instanceof Response) return relay;

    const entry = normalizeEntry(body.entry, relay.ownerId);
    if (!entry) return json({ error: 'Invalid diary entry envelope' }, 400);
    return persistEntry(relay.admin, relay.ownerId, entry, relay.relayId);
}

Deno.serve(async (req: Request) => {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (req.method !== 'POST') return json({ error: 'POST required' }, 405);

    const body = await readJsonObject(req, 160_000);
    if (!body) return json({ error: 'A JSON body is required' }, 400);

    if (body.action === 'pair') return pairRelay(req, body);
    if (body.action === 'upsert') return deviceUpsert(req, body);
    if (body.action === 'cancel' || body.action === 'delete') return cancelDiary(req, body);
    if (body.action === 'video-upload-url') return videoUploadUrl(req, body);
    return ingestRelay(req, body);
});
