/**
 * pi-alarm-relay — the boat's Pi wakes the skipper's locked phone (build 126,
 * package 126-04b).
 *
 * The Pi keeps the night watch (pi-cache/src/aisWatch.ts): it grades every
 * AIS target all night with the phone's own collision rule and hears distress
 * beacons on the boat's own radio. A suspended phone hears none of it. This
 * function takes the Pi's alarm and queues a push for the Pi's owner in
 * push_notification_queue, which send-push delivers (Time Sensitive, or
 * Critical where Apple has granted it; the anchor alarm's sound; one
 * notification per vessel). Its rules, its words and its storage are in
 * relay.ts and parse.ts; this file only wires the real storage.
 *
 * DELIVERED AT ONCE. The queue row is handed to send-push straight away (a
 * background POST with the service key, as the queue's own drain makes), not
 * left for the every-minute retry-pending-push drain: a collision alarm a
 * minute late has lost a quarter of an inshore TCPA. send-push claims the row
 * atomically (claim_push_notification), so the drain finding it too cannot
 * send it twice; if this hand-off fails, the drain still delivers it.
 *
 * GATEWAY AUTH, as anchor-relay. Not on the credentialless list
 * (tests/SupabaseEdgeJwtPolicyContract.test.ts): it keeps the project default
 * verify_jwt = true. The Pi presents the public anon key at the gateway, and
 * its real identity is the pairing credential checked inside
 * (_shared/pi-relay-auth.ts: the bearer's SHA-256 in pi_diary_relays). The
 * Pi never holds a service key and can only ever push to its own owner.
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { authenticatePiRelay, touchPiRelay } from '../_shared/pi-relay-auth.ts';
import type { PiAlarmKind, PiAlarmPayload } from './parse.ts';
import { handlePiAlarmRelay, type PiAlarmEvent, type PiAlarmStore } from './relay.ts';

declare const Deno: {
    serve: (handler: (req: Request) => Promise<Response> | Response) => void;
    env: { get(key: string): string | undefined };
};
/** Supabase's edge runtime keeps a promise handed to it running after the response. */
declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void } | undefined;

const COLUMNS =
    'id, owner_id, relay_id, alarm_key, kind, mmsi, payload, raised_at, last_seen_at, last_pushed_at, pushed_count, acked_at, acked_by, resolved_at';
const ALARM_KINDS = ['collision', 'close-quarters', 'distress'];
const ALARM_TYPES = ['collision_alarm', 'distress_alarm'];

// deno-lint-ignore no-explicit-any
type Admin = any;

const ms = (iso: unknown): number | null => (typeof iso === 'string' ? Date.parse(iso) : null);
const iso = (value: number | null | undefined): string | null =>
    value === null || value === undefined ? null : new Date(value).toISOString();

function fromRow(r: Record<string, unknown>): PiAlarmEvent {
    return {
        id: String(r.id),
        ownerId: String(r.owner_id),
        relayId: String(r.relay_id),
        alarmKey: String(r.alarm_key),
        kind: r.kind as PiAlarmKind,
        mmsi: typeof r.mmsi === 'number' ? r.mmsi : null,
        payload: (r.payload ?? {}) as PiAlarmPayload,
        raisedAt: ms(r.raised_at) ?? 0,
        lastSeenAt: ms(r.last_seen_at) ?? 0,
        lastPushedAt: ms(r.last_pushed_at),
        pushedCount: typeof r.pushed_count === 'number' ? r.pushed_count : 0,
        ackedAt: ms(r.acked_at),
        ackedBy: typeof r.acked_by === 'string' ? r.acked_by : null,
        resolvedAt: ms(r.resolved_at),
    };
}

function toRow(patch: Partial<PiAlarmEvent>): Record<string, unknown> {
    const row: Record<string, unknown> = {};
    if (patch.ownerId !== undefined) row.owner_id = patch.ownerId;
    if (patch.relayId !== undefined) row.relay_id = patch.relayId;
    if (patch.alarmKey !== undefined) row.alarm_key = patch.alarmKey;
    if (patch.kind !== undefined) row.kind = patch.kind;
    if (patch.mmsi !== undefined) row.mmsi = patch.mmsi;
    if (patch.payload !== undefined) row.payload = patch.payload;
    if (patch.raisedAt !== undefined) row.raised_at = iso(patch.raisedAt);
    if (patch.lastSeenAt !== undefined) row.last_seen_at = iso(patch.lastSeenAt);
    if (patch.lastPushedAt !== undefined) row.last_pushed_at = iso(patch.lastPushedAt);
    if (patch.pushedCount !== undefined) row.pushed_count = patch.pushedCount;
    if (patch.ackedAt !== undefined) row.acked_at = iso(patch.ackedAt);
    if (patch.ackedBy !== undefined) row.acked_by = patch.ackedBy;
    if (patch.resolvedAt !== undefined) row.resolved_at = iso(patch.resolvedAt);
    return row;
}

function must<T>(result: { data: T; error: { message: string } | null }, what: string): T {
    if (result.error) throw new Error(`${what}: ${result.error.message}`);
    return result.data;
}

/** Hand one queue row to send-push now; the drain is the fallback. Never throws, never waits. */
function deliverNow(id: string): void {
    const url = Deno.env.get('SUPABASE_URL');
    const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!url || !key) return;
    const work = fetch(`${url.replace(/\/+$/, '')}/functions/v1/send-push`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ record: { id } }),
    })
        .then((res) => res.body?.cancel())
        .catch(() => undefined);
    if (typeof EdgeRuntime !== 'undefined') EdgeRuntime.waitUntil(work);
}

function supabaseStore(admin: Admin): PiAlarmStore {
    const events = () => admin.from('pi_alarm_events');
    return {
        async countDevices(ownerId) {
            const res = await admin.from('push_device_tokens').select('id', { count: 'exact', head: true }).eq(
                'user_id',
                ownerId,
            );
            if (res.error) throw new Error(`device count: ${res.error.message}`);
            return typeof res.count === 'number' ? res.count : 0;
        },
        async findEvents(relayId, keys) {
            if (keys.length === 0) return [];
            const rows = must(
                await events().select(COLUMNS).eq('relay_id', relayId).in('alarm_key', keys),
                'find',
            ) as Record<string, unknown>[] | null;
            return (rows ?? []).map(fromRow);
        },
        async openEvents(relayId) {
            const rows = must(
                await events().select(COLUMNS).eq('relay_id', relayId).is('resolved_at', null).in('kind', ALARM_KINDS)
                    .limit(100),
                'open',
            ) as Record<string, unknown>[] | null;
            return (rows ?? []).map(fromRow);
        },
        async insertEvent(event) {
            const res = await events().insert(toRow(event)).select(COLUMNS).maybeSingle();
            if (res.error) {
                if (res.error.code === '23505') return null; // (relay, key) already there
                throw new Error(`insert: ${res.error.message}`);
            }
            return res.data ? fromRow(res.data as Record<string, unknown>) : null;
        },
        async updateEvent(id, patch, expectPushedCount) {
            let query = events().update(toRow(patch)).eq('id', id);
            if (expectPushedCount !== undefined) query = query.eq('pushed_count', expectPushedCount);
            const rows = must(await query.select('id'), 'update') as unknown[] | null;
            return (rows ?? []).length === 1;
        },
        async resolveEvents(ids, at) {
            if (ids.length === 0) return;
            must(await events().update({ resolved_at: iso(at) }).in('id', ids), 'resolve');
        },
        async lastPushedAt(relayId, kind) {
            const rows = must(
                await events().select('last_pushed_at').eq('relay_id', relayId).eq('kind', kind)
                    .not('last_pushed_at', 'is', null).order('last_pushed_at', { ascending: false }).limit(1),
                'last push',
            ) as Array<{ last_pushed_at: string }> | null;
            return rows && rows.length > 0 ? ms(rows[0].last_pushed_at) : null;
        },
        async countPushedSince(relayId, kind, sinceMs) {
            const res = await events().select('id', { count: 'exact', head: true }).eq('relay_id', relayId).eq(
                'kind',
                kind,
            ).gte('last_pushed_at', iso(sinceMs));
            if (res.error) throw new Error(`count: ${res.error.message}`);
            return typeof res.count === 'number' ? res.count : 0;
        },
        async alarmPushesSince(ownerId, sinceMs, resends) {
            // relay.ts marks every alarm push data.resend true or false.
            const res = await admin.from('push_notification_queue').select('id', { count: 'exact', head: true }).eq(
                'recipient_user_id',
                ownerId,
            ).in('notification_type', ALARM_TYPES).gte('created_at', iso(sinceMs)).eq(
                'data->>resend',
                resends ? 'true' : 'false',
            );
            if (res.error) throw new Error(`hourly count: ${res.error.message}`);
            return typeof res.count === 'number' ? res.count : 0;
        },
        async enqueuePush(push) {
            const res = await admin.from('push_notification_queue').insert(push).select('id').single();
            if (res.error || !res.data) {
                console.error(`[pi-alarm-relay] queue insert failed: ${res.error?.message ?? 'no row'}`);
                return false;
            }
            deliverNow(String((res.data as { id: unknown }).id));
            return true;
        },
        async pruneResolved(relayId, beforeMs, limit) {
            const rows = must(
                await events().select('id').eq('relay_id', relayId).lt('resolved_at', iso(beforeMs)).limit(limit),
                'prune',
            ) as Array<{ id: string }> | null;
            const ids = (rows ?? []).map((r) => r.id);
            if (ids.length > 0) must(await events().delete().in('id', ids), 'prune delete');
        },
        touchRelay(relayId) {
            touchPiRelay(admin, relayId);
        },
    };
}

function adminClient(): Admin | null {
    const url = Deno.env.get('SUPABASE_URL');
    const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!url || !key) return null;
    return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

Deno.serve((req) => {
    const admin = adminClient();
    return handlePiAlarmRelay(req, {
        authenticate: (credential) =>
            admin
                ? authenticatePiRelay(admin, credential)
                : Promise.resolve({ status: 503 as const, error: 'unavailable' }),
        store: admin ? supabaseStore(admin) : null,
    });
});
