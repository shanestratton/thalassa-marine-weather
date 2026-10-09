/**
 * pi-alarm-relay's handler (build 126, package 126-04b), with its storage
 * passed in so every rule is tested without a database (relay_test.ts).
 * index.ts wires the real one: pi_alarm_events and push_notification_queue
 * through the service role.
 *
 * Four actions, all from the Pi with its pairing credential:
 *   probe  can a push reach the owner? ({ devices }: his registered phones);
 *          also deletes resolved rows over 30 days old, a batch at a time.
 *   raise  a new alarm (or one sounding again), or a 'blind' / 'no-fix'
 *          notice: pushed at once unless a rule below holds it.
 *   sync   the Pi's open alarms, every 15 s while one is open: re-pushes the
 *          unacknowledged ones when due, records the ones acknowledged
 *          aboard, resolves the ones the Pi no longer lists, and answers the
 *          keys acknowledged (from ashore too) so the Pi silences them.
 *   test   one ordinary push labelled TEST, through the whole path.
 *
 * The rules (parse.ts): a new alarm pushes at once; an open, unacknowledged
 * one again every 2 min (close quarters every 60 s), at most 10 times; for
 * the owner in any hour at most 30 new alarms pushed and 20 re-sends, kept
 * apart so re-sends never hold back a new alarm; a notice of each kind at
 * most every 30 min; a test at most once a minute, ten an hour. Every push
 * goes to the Pi's owner, and only to him (crew come later with a register,
 * 132). A push is claimed on its row before it is queued, so two requests
 * racing on one alarm cannot both push it.
 *
 * A DANGER's acknowledgement lasts its 30-minute mute aboard and no longer
 * (MUTE_REOPEN_AFTER_MS, a little under, for the Pi learning it a sync
 * late). Whenever the Pi lists one sounding whose acknowledgement here is
 * that old, by raise or by sync, it is pushed afresh; such an old
 * acknowledgement is never answered back (the Pi would mute her for another
 * 30 min with nobody touching anything); and an acknowledgement aboard said
 * to predate her last push is a stale request, never written back.
 */
import { jsonResponse } from '../_shared/http-security.ts';
import { type PiRelayIdentity, readRelayCredential, type RelayAuthFailure } from '../_shared/pi-relay-auth.ts';
import {
    isAlarmKind,
    MAX_BODY_BYTES,
    MAX_NEW_ALARM_PUSHES_PER_HOUR,
    MAX_RESENDS,
    MAX_RESENDS_PER_HOUR,
    MAX_TESTS_PER_HOUR,
    MUTE_REOPEN_AFTER_MS,
    NOTICE_EVERY_MS,
    notificationTypeFor,
    parseRelayRequest,
    type PiAlarmInput,
    type PiAlarmKind,
    type PiAlarmPayload,
    type PiNotificationType,
    pushData,
    pushText,
    type RelayRequest,
    repushAfterMs,
    RETENTION_BATCH,
    RETENTION_MS,
    STALE_ACK_SLACK_MS,
    TEST_EVERY_MS,
} from './parse.ts';

const HOUR_MS = 60 * 60_000;

/** One row of pi_alarm_events, times in epoch ms. */
export interface PiAlarmEvent {
    id: string;
    ownerId: string;
    relayId: string;
    alarmKey: string;
    kind: PiAlarmKind;
    mmsi: number | null;
    payload: PiAlarmPayload;
    raisedAt: number;
    lastSeenAt: number;
    lastPushedAt: number | null;
    pushedCount: number;
    ackedAt: number | null;
    /** The account that acknowledged it from a phone; null when acknowledged aboard (on the Pi). */
    ackedBy: string | null;
    resolvedAt: number | null;
}

/** One push_notification_queue row. */
export interface QueuedPush {
    recipient_user_id: string;
    notification_type: PiNotificationType;
    title: string;
    body: string;
    data: Record<string, string | number | boolean>;
}

export interface PiAlarmStore {
    /** The owner's registered push devices (push_device_tokens). */
    countDevices(ownerId: string): Promise<number>;
    findEvents(relayId: string, keys: string[]): Promise<PiAlarmEvent[]>;
    /** This relay's unresolved collision, close-quarters and distress rows. */
    openEvents(relayId: string): Promise<PiAlarmEvent[]>;
    /** Null when (relay, key) already exists. */
    insertEvent(event: Omit<PiAlarmEvent, 'id'>): Promise<PiAlarmEvent | null>;
    /** False when the row is gone, or its pushed count is no longer `expectPushedCount`. */
    updateEvent(id: string, patch: Partial<PiAlarmEvent>, expectPushedCount?: number): Promise<boolean>;
    resolveEvents(ids: string[], at: number): Promise<void>;
    /** When this relay last pushed a row of this kind (notices and tests), or null. */
    lastPushedAt(relayId: string, kind: PiAlarmKind): Promise<number | null>;
    countPushedSince(relayId: string, kind: PiAlarmKind, sinceMs: number): Promise<number>;
    /** Collision and distress pushes queued for this owner since then: re-sends, or first pushes. */
    alarmPushesSince(ownerId: string, sinceMs: number, resends: boolean): Promise<number>;
    enqueuePush(push: QueuedPush): Promise<boolean>;
    pruneResolved(relayId: string, beforeMs: number, limit: number): Promise<void>;
    /** Best-effort heartbeat on the relay's own row. */
    touchRelay(relayId: string): void;
}

export interface RelayDeps {
    authenticate: (
        credential: { relayId: string; token: string } | null,
    ) => Promise<PiRelayIdentity | RelayAuthFailure>;
    /** Null when the function has no service role configured. */
    store: PiAlarmStore | null;
    now?: () => number;
    log?: (message: string) => void;
}

const CORS: Record<string, string> = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers':
        'Content-Type, Authorization, apikey, X-Thalassa-Pi-Relay-Id, X-Thalassa-Pi-Relay-Token',
};

function json(body: unknown, status = 200): Response {
    return jsonResponse(body, status, CORS);
}

/** The body as a JSON object, 'too-large' over the cap (checked before parsing), or null. */
async function readBoundedJson(req: Request, maxBytes: number): Promise<Record<string, unknown> | 'too-large' | null> {
    const declared = Number(req.headers.get('content-length') || '0');
    if (Number.isFinite(declared) && declared > maxBytes) return 'too-large';
    if (!req.body) return null;
    const reader = req.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > maxBytes) {
                await reader.cancel().catch(() => undefined);
                return 'too-large';
            }
            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    try {
        const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
        return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
    } catch {
        return null;
    }
}

interface Context {
    store: PiAlarmStore;
    identity: PiRelayIdentity;
    now: number;
    utcOffsetMin: number | null;
}

type Held = 'acked' | 'too-soon' | 'resends' | 'hourly' | 'notice' | 'repeat';
type Outcome = { pushed: boolean; acked: boolean; held?: Held };

/** Claim the push on the row, then queue it. A lost claim is someone else's push. */
async function push(ctx: Context, e: PiAlarmEvent): Promise<boolean> {
    const before = { lastPushedAt: e.lastPushedAt, pushedCount: e.pushedCount };
    const claimed = await ctx.store.updateEvent(
        e.id,
        { lastPushedAt: ctx.now, pushedCount: e.pushedCount + 1 },
        e.pushedCount,
    );
    if (!claimed) return false;
    const text = pushText(e, ctx.now, ctx.utcOffsetMin);
    const queued = await ctx.store.enqueuePush({
        recipient_user_id: ctx.identity.ownerId,
        notification_type: notificationTypeFor(e.kind),
        title: text.title,
        body: text.body,
        data: pushData(
            { key: e.alarmKey, kind: e.kind, mmsi: e.mmsi, payload: e.payload },
            e.raisedAt,
            before.pushedCount > 0,
        ),
    });
    if (!queued) {
        await ctx.store.updateEvent(e.id, before, e.pushedCount + 1);
        throw new Error('the push could not be queued');
    }
    e.lastPushedAt = ctx.now;
    e.pushedCount += 1;
    return true;
}

/** Room this hour for this push: first pushes and re-sends are counted apart. */
async function hourlyRoom(ctx: Context, resend: boolean): Promise<boolean> {
    const sent = await ctx.store.alarmPushesSince(ctx.identity.ownerId, ctx.now - HOUR_MS, resend);
    return sent < (resend ? MAX_RESENDS_PER_HOUR : MAX_NEW_ALARM_PUSHES_PER_HOUR);
}

/** A DANGER's acknowledgement older than its mute aboard: it no longer silences her. */
function muteRanOut(e: PiAlarmEvent, now: number): boolean {
    return e.kind === 'collision' && e.ackedAt !== null && now - e.ackedAt >= MUTE_REOPEN_AFTER_MS;
}

/** One alarm (or notice) from the Pi: recorded, then pushed unless a rule holds it. */
async function handleAlarm(ctx: Context, alarm: PiAlarmInput, existing: PiAlarmEvent | undefined): Promise<Outcome> {
    const { store, identity, now } = ctx;
    const notice = !isAlarmKind(alarm.kind);
    let e = existing;
    let fresh = false;
    if (!e) {
        const created = await store.insertEvent({
            ownerId: identity.ownerId,
            relayId: identity.relayId,
            alarmKey: alarm.key,
            kind: alarm.kind,
            mmsi: alarm.mmsi,
            payload: alarm.payload,
            raisedAt: now,
            lastSeenAt: now,
            lastPushedAt: null,
            pushedCount: 0,
            ackedAt: alarm.ackedMsAgo === null ? null : now - alarm.ackedMsAgo,
            ackedBy: null,
            // A notice is news once, never an open alarm.
            resolvedAt: notice ? now : null,
        });
        if (created) {
            e = created;
            fresh = true;
        } else {
            // Another request recorded it first: carry on with that row.
            e = (await store.findEvents(identity.relayId, [alarm.key]))[0];
            if (!e) throw new Error('the alarm row vanished');
        }
    }
    if (!fresh) {
        if (notice) return { pushed: false, acked: false, held: 'repeat' };
        const patch: Partial<PiAlarmEvent> = { payload: alarm.payload, lastSeenAt: now };
        if (alarm.ackedMsAgo !== null) {
            // Acknowledged aboard: no more pushes for it. Unless it is said to
            // predate her last push: then this request was built before a
            // DANGER's mute ran out and she has been pushed afresh since.
            const at = now - alarm.ackedMsAgo;
            const stale = e.lastPushedAt !== null && at < e.lastPushedAt - STALE_ACK_SLACK_MS;
            if (e.ackedAt === null && !stale) {
                patch.ackedAt = at;
                patch.ackedBy = null;
            }
        } else if (muteRanOut(e, now)) {
            // A DANGER's 30-minute mute ran out aboard and she still alarms:
            // news again, whether the Pi's raise or its next sync says so.
            patch.ackedAt = null;
            patch.ackedBy = null;
            patch.pushedCount = 0;
            patch.lastPushedAt = null;
        }
        // Listed again after it was resolved (the Pi was out of touch): open again.
        if (e.resolvedAt !== null) patch.resolvedAt = null;
        await store.updateEvent(e.id, patch);
        Object.assign(e, patch);
    }

    if (e.ackedAt !== null && !muteRanOut(e, now)) return { pushed: false, acked: true, held: 'acked' };
    // The Pi says it is acknowledged aboard: nobody to wake for it.
    if (alarm.ackedMsAgo !== null) return { pushed: false, acked: false, held: 'acked' };
    if (notice) {
        const last = await store.lastPushedAt(identity.relayId, e.kind);
        if (last !== null && now - last < NOTICE_EVERY_MS) return { pushed: false, acked: false, held: 'notice' };
        return { pushed: await push(ctx, e), acked: false };
    }
    if (e.lastPushedAt !== null && now - e.lastPushedAt < repushAfterMs(e.kind)) {
        return { pushed: false, acked: false, held: 'too-soon' };
    }
    if (e.pushedCount - 1 >= MAX_RESENDS) return { pushed: false, acked: false, held: 'resends' };
    if (!(await hourlyRoom(ctx, e.pushedCount > 0))) return { pushed: false, acked: false, held: 'hourly' };
    return { pushed: await push(ctx, e), acked: false };
}

async function raise(ctx: Context, alarm: PiAlarmInput) {
    const [existing] = await ctx.store.findEvents(ctx.identity.relayId, [alarm.key]);
    const out = await handleAlarm(ctx, alarm, existing);
    return { ok: true, pushed: out.pushed, acked: out.acked, ...(out.held ? { held: out.held } : {}) };
}

async function sync(ctx: Context, request: Extract<RelayRequest, { action: 'sync' }>) {
    const { alarms } = request;
    const known = new Map(
        (await ctx.store.findEvents(ctx.identity.relayId, alarms.map((a) => a.key))).map((e) => [e.alarmKey, e]),
    );
    const acked: string[] = [];
    let pushed = 0;
    let held = 0;
    for (const alarm of alarms) {
        const out = await handleAlarm(ctx, alarm, known.get(alarm.key));
        if (out.pushed) pushed += 1;
        if (out.acked) acked.push(alarm.key);
        if (out.held === 'hourly') held += 1;
    }
    // Open here but no longer on the Pi: her encounter (or the beacon) is over.
    const listed = new Set(request.listedKeys);
    const stale = (await ctx.store.openEvents(ctx.identity.relayId)).filter((e) => !listed.has(e.alarmKey));
    if (stale.length > 0) await ctx.store.resolveEvents(stale.map((e) => e.id), ctx.now);
    return {
        ok: true,
        acked,
        resolved: stale.length,
        pushed,
        // Held by the hourly caps (the Pi says so in its log), and entries refused.
        ...(held > 0 ? { held } : {}),
        ...(request.skipped > 0 ? { skipped: request.skipped } : {}),
    };
}

async function probe(ctx: Context) {
    const devices = await ctx.store.countDevices(ctx.identity.ownerId);
    await ctx.store.pruneResolved(ctx.identity.relayId, ctx.now - RETENTION_MS, RETENTION_BATCH);
    return { ok: true, devices };
}

async function test(ctx: Context) {
    const { store, identity, now } = ctx;
    const devices = await store.countDevices(identity.ownerId);
    const last = await store.lastPushedAt(identity.relayId, 'test');
    if (last !== null && now - last < TEST_EVERY_MS) return { ok: true, devices, queued: false, held: 'too-soon' };
    if ((await store.countPushedSince(identity.relayId, 'test', now - HOUR_MS)) >= MAX_TESTS_PER_HOUR) {
        return { ok: true, devices, queued: false, held: 'hourly' };
    }
    const event = await store.insertEvent({
        ownerId: identity.ownerId,
        relayId: identity.relayId,
        alarmKey: `test::${now}`,
        kind: 'test',
        mmsi: null,
        payload: {
            name: '',
            cpa_nm: null,
            tcpa_min: null,
            range_nm: null,
            bearing_deg: null,
            lat: null,
            lon: null,
            lost: null,
            distress_kind: null,
            position_known: null,
            silent_min: null,
            cause: null,
        },
        raisedAt: now,
        lastSeenAt: now,
        lastPushedAt: null,
        pushedCount: 0,
        ackedAt: null,
        ackedBy: null,
        resolvedAt: now,
    });
    if (!event) return { ok: true, devices, queued: false, held: 'too-soon' };
    return { ok: true, devices, queued: await push(ctx, event) };
}

export async function handlePiAlarmRelay(req: Request, deps: RelayDeps): Promise<Response> {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

    const body = await readBoundedJson(req, MAX_BODY_BYTES);
    if (body === 'too-large') return json({ error: 'payload_too_large' }, 413);
    if (body === null) return json({ error: 'invalid_json' }, 400);
    if (!deps.store) return json({ error: 'unavailable' }, 503);

    // One answer for every refusal: a caller learns nothing about which relays exist.
    const identity = await deps.authenticate(readRelayCredential(req, body));
    if ('status' in identity) {
        return identity.status === 401 ? json({ error: 'unauthorised' }, 401) : json({ error: 'unavailable' }, 503);
    }

    const parsed = parseRelayRequest(body);
    if (!parsed.ok) return json({ error: 'invalid_request', detail: parsed.error }, 400);
    const request = parsed.value;
    const ctx: Context = {
        store: deps.store,
        identity,
        now: (deps.now ?? Date.now)(),
        utcOffsetMin: request.utcOffsetMin,
    };
    try {
        const answer = request.action === 'probe'
            ? await probe(ctx)
            : request.action === 'raise'
            ? await raise(ctx, request.alarm)
            : request.action === 'sync'
            ? await sync(ctx, request)
            : await test(ctx);
        deps.store.touchRelay(identity.relayId);
        return json(answer);
    } catch (error) {
        (deps.log ?? console.error)(
            `[pi-alarm-relay] ${request.action} failed: ${error instanceof Error ? error.message : 'unknown'}`,
        );
        return json({ error: 'unavailable' }, 503);
    }
}
