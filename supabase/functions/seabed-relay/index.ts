/**
 * seabed-relay: where the boat's soundings land (seabed mapping, phase 1).
 *
 * Shane 2026-10-05: "also you should do the bottom mapping as a parallel add
 * in". With the owner's opt-in, the boat's Pi (or, with no Pi, one phone on
 * the boat's own instruments) logs depth below the transducer about once a
 * second while under way and sends hourly gzipped CSV batches here.
 *
 * Two callers, one door:
 *   - the Pi, with its pairing credential (X-Thalassa-Pi-Relay-Id/-Token, see
 *     _shared/pi-relay-auth.ts); its boat is the hull on its pairing, else the
 *     owner's active vessel;
 *   - the phone, with the signed-in user's JWT and the boat it names.
 * Either way the boat must be the caller's own and still active.
 *
 * Actions:
 *   config      the platform settings (switch, zones, ...): the Pi pulls them.
 *   batch       store one batch: strict parse (any bad row fails the batch),
 *               privacy zones applied again, every index figure recomputed
 *               from the file, object first and index row second (the object
 *               is removed if the row cannot be written). Idempotent on the
 *               SHA-256 of the bytes sent.
 *   delete_all  phone only: the switch off, then every object and index row
 *               of the caller, paged to the end (deleteAll.ts).
 *
 * ONE LOGGER PER BOAT. A batch from the device that is not the boat's logger
 * (capture_device_id: NULL = the Pi, else a phone) is refused with 409
 * not-logger when it ended after the logger last changed: the device that
 * stopped logging may still send what it logged before, nothing after.
 *
 * Nothing here is public. The bucket has no storage policies; batches become
 * eligible for a map or a DCDB submission 30 days after they end, and phase 1
 * builds neither.
 *
 * Deploy with JWT verification off (supabase/config.toml): the Pi holds a
 * relay token, not a user JWT. The phone's JWT is verified here.
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { requireAuthenticatedQuota, withCors } from '../_shared/auth-rate-limit.ts';
import { jsonResponse, readJsonObject } from '../_shared/http-security.ts';
import { authenticatePiRelay, readRelayCredential, touchPiRelay } from '../_shared/pi-relay-auth.ts';
import { parseSeabedZones, SEABED_CONSENT_VERSION } from '../_shared/seabedCore.ts';
import { deleteAllSoundings, type DeleteClient } from './deleteAll.ts';
import { eligibleAfter, loggerRefuses, objectPath, prepareBatch } from './ingest.ts';
import { loadPlatform, ownedActiveBoat, piBoat, type QueryClient } from './who.ts';

declare const Deno: {
    serve: (handler: (req: Request) => Promise<Response> | Response) => void;
    env: { get(key: string): string | undefined };
};

const BUCKET = 'seabed-soundings';
/** 900 KB of gzip, base64-encoded, plus the JSON around it. */
const MAX_BODY_BYTES = 1_300_000;

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

type Admin = NonNullable<ReturnType<typeof adminClient>>;

interface Caller {
    ownerId: string;
    device: 'pi' | 'phone';
    relayId: string | null;
}

async function identify(req: Request, admin: Admin): Promise<Caller | Response> {
    const relay = readRelayCredential(req, null);
    if (relay) {
        const identity = await authenticatePiRelay(admin as unknown as QueryClient, relay);
        if ('status' in identity) return json({ error: identity.error }, identity.status);
        return { ownerId: identity.ownerId, device: 'pi', relayId: identity.relayId };
    }
    // A batch an hour per boat; a generous ceiling that still stops a loop.
    const caller = await requireAuthenticatedQuota(req, 'seabed-relay', 240, 3600);
    if (caller instanceof Response) return withCors(caller, CORS);
    return { ownerId: caller.userId, device: 'phone', relayId: null };
}

async function deleteAll(admin: Admin, ownerId: string): Promise<Response> {
    const out = await deleteAllSoundings(admin as unknown as DeleteClient, ownerId, BUCKET);
    return out.ok ? json({ ok: true, removed: out.removed }) : json({ error: out.error }, 503);
}

Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

    const body = await readJsonObject(req, MAX_BODY_BYTES);
    if (!body) return json({ error: 'Body must be a JSON object under 1.3 MB' }, 413);
    const admin = adminClient();
    if (!admin) return json({ error: 'Seabed relay is not configured' }, 503);
    const db = admin as unknown as QueryClient;

    const caller = await identify(req, admin);
    if (caller instanceof Response) return caller;
    const action = body.action;

    if (action === 'delete_all') {
        if (caller.device !== 'phone') return json({ error: 'Only the signed-in owner can delete soundings' }, 403);
        return deleteAll(admin, caller.ownerId);
    }
    if (action !== 'config' && action !== 'batch') return json({ error: 'Unknown action' }, 400);

    const boat = caller.relayId
        ? await piBoat(db, caller.ownerId, caller.relayId)
        : await ownedActiveBoat(db, caller.ownerId, body.boat_id);
    if (!boat.ok) return json({ error: 'Boat lookup unavailable' }, 503);
    if (!boat.value) {
        return caller.device === 'pi'
            ? json({ error: 'No active boat of yours for this Pi', code: 'no-active-vessel' }, 409)
            : json({ error: 'That boat is not yours, or it has been released', code: 'not-owner' }, 403);
    }
    const platform = await loadPlatform(db, caller.ownerId, boat.value);
    if (!platform.ok) return json({ error: 'Platform lookup unavailable' }, 503);
    if (caller.relayId) touchPiRelay(db, caller.relayId);

    if (action === 'config') {
        const p = platform.value;
        if (!p) return json({ boat_id: boat.value, platform: null });
        return json({
            boat_id: boat.value,
            platform: {
                enabled: p.enabled,
                consent_version: p.consent_version,
                capture: p.capture_device_id === null ? 'pi' : 'phone',
                zones: parseSeabedZones(p.privacy_zones) ?? [],
                sounder_note: p.sounder_note,
                vessel: p.vessel,
                updated_at: p.updated_at,
            },
        });
    }

    // ── batch ──
    const p = platform.value;
    if (!p) return json({ error: 'Seabed mapping has not been set up for this boat', code: 'no-platform' }, 409);
    if (!p.enabled) return json({ error: 'Seabed mapping is switched off', code: 'not-enabled' }, 409);
    if (p.consent_version !== SEABED_CONSENT_VERSION) {
        return json({ error: 'The owner has not agreed to the current terms', code: 'consent-outdated' }, 409);
    }

    const prepared = await prepareBatch(body, parseSeabedZones(p.privacy_zones) ?? [], Date.now());
    if (!prepared.ok) return json({ error: prepared.error }, prepared.status);
    if (!prepared.summary) {
        return json({ ok: true, stored: false, rows: 0, privacy_dropped: prepared.privacyDropped });
    }

    const existing = await admin
        .from('seabed_batches')
        .select('id')
        .eq('owner_id', caller.ownerId)
        .eq('content_sha256', prepared.contentSha256)
        .maybeSingle();
    if (existing.error) return json({ error: 'Index lookup unavailable' }, 503);
    if (existing.data) return json({ ok: true, duplicate: true });

    const s = prepared.summary;
    if (loggerRefuses(caller.device, p.capture_device_id, p.capture_changed_at, s.t_end)) {
        return json({ error: 'Another device logs this boat now', code: 'not-logger' }, 409);
    }
    const path = objectPath(caller.ownerId, p.csb_uuid, s, prepared.contentSha256);
    const storage = admin.storage.from(BUCKET);
    const upload = await storage.upload(path, prepared.gz, { contentType: 'application/gzip', upsert: true });
    if (upload.error) {
        console.error('[seabed-relay] upload failed:', upload.error.message);
        return json({ error: 'Could not store the batch' }, 503);
    }
    const { error } = await admin.from('seabed_batches').insert({
        owner_id: caller.ownerId,
        platform_id: p.id,
        boat_id: boat.value,
        device: caller.device,
        object_path: path,
        content_sha256: prepared.contentSha256,
        bytes: prepared.gz.byteLength,
        row_count: s.row_count,
        rows_flagged: s.rows_flagged,
        rows_privacy_dropped: prepared.privacyDropped,
        t_start: s.t_start,
        t_end: s.t_end,
        min_lat: s.min_lat,
        max_lat: s.max_lat,
        min_lon: s.min_lon,
        max_lon: s.max_lon,
        crosses_antimeridian: s.crosses_antimeridian,
        track_m: s.track_m,
        depth_min: s.depth_min,
        depth_max: s.depth_max,
        flag_counts: s.flag_counts,
        quality: { hdop_median: s.hdop_median, fix_q_hist: s.fix_q_hist, device_counts: prepared.counters },
        capture_meta: prepared.meta,
        eligible_after: eligibleAfter(s),
    });
    if (error) {
        // The same bytes landing twice at once: the other request owns the row.
        if (error.code === '23505') return json({ ok: true, duplicate: true });
        await storage.remove([path]).catch(() => undefined);
        console.error('[seabed-relay] index insert failed:', error.message);
        return json({ error: 'Could not index the batch' }, 503);
    }
    return json({ ok: true, stored: true, rows: s.row_count, privacy_dropped: prepared.privacyDropped });
});
