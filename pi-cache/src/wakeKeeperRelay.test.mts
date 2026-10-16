import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WakeRelay } from './wakeKeeper/relay.js';
import { WakeEpisodes } from './wakeKeeper/episodes.js';
import {
    wakeCloudContext,
    wakeCloudContextKey,
    parseWakeCloudContext,
    type WakeRelayPass,
} from './wakeKeeper/relayProtocol.js';
import { defaultWakeRules, wakeRulesCanonical } from './wakeRule/wakeRule.js';
import { wakeHash, wakePairingId, type WakeConfiguration, type WakeRuleStatus } from './wakeKeeper/contract.js';
const owner = '00000000-0000-4000-8000-000000000001',
    pi = '00000000-0000-4000-8000-000000000002';
const now = Date.parse('2026-10-17T00:00:00Z'),
    instance = '00000000-0000-4000-8000-000000000005',
    revision = '00000000-0000-4000-8000-000000000006';
function fixture() {
    const rules = defaultWakeRules(),
        feedId = `pi:${pi}:${'b'.repeat(24)}`;
    rules[1] = {
        ...rules[1],
        enabled: true,
        selection: { feedId, sensorId: 'fictional.1', reference: 'true-water' },
        threshold: 25,
    };
    const config: WakeConfiguration = {
        schema: 1,
        revision: '00000000-0000-4000-8000-000000000004',
        draftM: 2,
        configuredAt: now - 1000,
        binding: {
            ownerId: owner,
            piDeviceId: pi,
            pairingId: wakePairingId(owner, pi, 'fictional-relay-identity'),
            deviceId: '00000000-0000-4000-8000-000000000003',
            enrollmentRevision: 'a'.repeat(64),
            feedId,
        },
        rules,
        rulesDigest: wakeHash(wakeRulesCanonical(rules, 2)),
    };
    const rows: WakeRuleStatus[] = rules.map((r) => ({
        preset: r.preset,
        status: r.enabled ? 'active' : 'disabled',
        active: r.enabled,
        audible: r.enabled,
        quiet: false,
        lastAt: r.enabled ? now : null,
        value: r.enabled ? 30 : null,
    }));
    const episodes = new WakeEpisodes(),
        pass = episodes.pass(config, instance, rows, now);
    return { config, rows, episodes, pass };
}
function relayFixture(handler?: (body: Record<string, unknown>) => Response | Promise<Response>) {
    const data = {
        now,
        owner: owner as string | null,
        credentials: { relayId: 'fictional-relay-identity', token: 'fictional-not-a-product-token' } as {
            relayId: string;
            token: string;
        } | null,
        allowed: true,
        current: true,
        calls: [] as Record<string, unknown>[],
        acks: [] as string[],
        remote: null as unknown,
        revision: null as string | null,
    };
    const fetchImpl: typeof fetch = async (_input, init) => {
        assert.equal(init?.redirect, 'error');
        assert.equal(init?.cache, 'no-store');
        const body = JSON.parse(String(init?.body));
        data.calls.push(body);
        if (handler) return handler(body);
        if (body.action === 'probe')
            return Response.json({
                ok: true,
                devices: 1,
                wake: { v: 1, enabled: true },
                context: data.remote,
                contextRevision: data.revision,
                retired: false,
            });
        if (body.action === 'bind') {
            data.remote = body.context;
            data.revision = revision;
            return Response.json({
                ok: true,
                wake: { v: 1, enabled: true },
                contextRevision: revision,
                queued: 0,
                acked: [],
            });
        }
        if (body.action === 'retire')
            return Response.json({
                ok: true,
                retired: true,
                wake: { v: 1, enabled: true },
                contextRevision: '00000000-0000-4000-8000-000000000007',
                queued: 0,
                acked: [],
            });
        const pass = body as unknown as WakeRelayPass;
        return Response.json({
            ok: true,
            wake: { v: 1, enabled: true },
            contextRevision: revision,
            queued: 1,
            acked: pass.states.flatMap((s) => (s.alarm ? [s.alarm.key] : [])),
        });
    };
    const relay = new WakeRelay({
        endpoint: 'https://pcisdplnodrphauixcau.supabase.co/functions/v1/pi-alarm-relay',
        fetchImpl,
        anonKey: () => 'fictional-public-gateway-key',
        credentials: () => data.credentials,
        ownerId: () => data.owner,
        internetAllowed: () => data.allowed,
        now: () => data.now,
    });
    const update = (pass: WakeRelayPass | null) =>
        relay.update(
            pass,
            () => data.current,
            (_key, keys) => data.acks.push(...keys),
        );
    return { data, relay, update };
}
test('episodes retain original raise/source clocks through unknown and reset only on actual clear/context change', () => {
    const f = fixture(),
        first = f.pass.states[1].alarm!;
    assert.equal(first.raisedAt, now);
    assert.equal(first.sourceAt, now);
    f.episodes.acknowledge(wakeCloudContextKey(f.pass.context), [first.key], now + 500);
    f.rows[1] = { ...f.rows[1], status: 'unknown', value: null };
    const unknown = f.episodes.pass(f.config, instance, f.rows, now + 20_000).states[1].alarm!;
    assert.equal(unknown.key, first.key);
    assert.equal(unknown.sourceAt, now);
    assert.equal(unknown.value, null);
    assert.equal(unknown.ackedAt, now + 500);
    f.rows[1] = { ...f.rows[1], active: false, status: 'watching' };
    assert.equal(f.episodes.pass(f.config, instance, f.rows, now + 21_000).states[1].alarm, null);
    f.rows[1] = { ...f.rows[1], active: true, status: 'active', lastAt: now + 22_000, value: 31 };
    const next = f.episodes.pass(f.config, instance, f.rows, now + 22_000).states[1].alarm!;
    assert.notEqual(next.key, first.key);
    assert.equal(next.ackedAt, null);
    f.episodes.acknowledge('old-context', [next.key], now + 23_000);
    assert.equal(f.episodes.episode('wind-above')?.ackedAt, null);
});
test('context comparison handles real JSONB object key order without relaxing identities or quiet policy', () => {
    const { config } = fixture(),
        c = wakeCloudContext(config, instance);
    const reverse = (v: unknown): unknown =>
        Array.isArray(v)
            ? v.map(reverse)
            : v && typeof v === 'object'
              ? Object.fromEntries(
                    Object.entries(v)
                        .reverse()
                        .map(([k, x]) => [k, reverse(x)]),
                )
              : v;
    assert.equal(wakeCloudContextKey(parseWakeCloudContext(reverse(c))!), wakeCloudContextKey(c));
    c.rules[1].quietHours = { startMinute: 1380, endMinute: 360, utcOffsetMinutes: 600 };
    assert.notEqual(wakeCloudContextKey(c), wakeCloudContextKey(wakeCloudContext(config, instance)));
});
test('fixed authenticated probe/bind/sync proves support and only then returns ready; stale status loses green', async () => {
    const f = relayFixture(),
        p = fixture().pass;
    assert.equal(f.relay.status().capability, 0);
    f.update(p);
    await f.relay.settled();
    assert.deepEqual(
        f.data.calls.map((c) => c.action),
        ['probe', 'bind', 'sync'],
    );
    assert.equal(f.relay.status().state, 'ready');
    assert.equal(f.relay.status().capability, 1);
    assert.deepEqual(f.data.acks, [p.states[1].alarm!.key]);
    f.data.now += 30_001;
    assert.equal(f.relay.status().capability, 0);
});
test('offline/unpaired makes no request and an old or unknown capability never binds or sends', async () => {
    for (const state of ['offline', 'unpaired', 'old']) {
        const f = relayFixture(() =>
            Response.json({
                ok: true,
                devices: 1,
                context: null,
                contextRevision: null,
                retired: false,
                wake: { v: 1, enabled: false },
            }),
        );
        if (state === 'offline') f.data.allowed = false;
        if (state === 'unpaired') f.data.credentials = null;
        f.update(fixture().pass);
        await f.relay.settled();
        assert.equal(f.relay.status().capability, 0);
        assert.equal(f.data.calls.length, state === 'old' ? 1 : 0);
    }
});
test('a delayed successful reply after owner/session retirement cannot acknowledge or show ready', async () => {
    let finish!: (r: Response) => void;
    const f = relayFixture(
        () =>
            new Promise((resolve) => {
                finish = resolve;
            }),
    );
    f.update(fixture().pass);
    assert.equal(f.data.calls.length, 1);
    f.data.current = false;
    f.data.owner = '00000000-0000-4000-8000-000000000099';
    finish(
        Response.json({
            ok: true,
            devices: 1,
            wake: { v: 1, enabled: true },
            context: null,
            contextRevision: null,
            retired: false,
        }),
    );
    await f.relay.settled();
    assert.equal(f.data.calls.length, 1);
    assert.equal(f.data.acks.length, 0);
    assert.equal(f.relay.status().capability, 0);
});
test('a cloud profile conflict remains reviewable and never auto-binds on later polls', async () => {
    const f = relayFixture(),
        p = fixture().pass;
    f.data.remote = { ...p.context, rulesDigest: 'e'.repeat(64) };
    f.data.revision = revision;
    f.update(p);
    await f.relay.settled();
    assert.deepEqual(
        f.data.calls.map((c) => c.action),
        ['probe'],
    );
    assert.equal(f.relay.status().state, 'conflict');
    f.data.now += 5000;
    f.update(p);
    await f.relay.settled();
    assert.deepEqual(
        f.data.calls.map((c) => c.action),
        ['probe', 'probe'],
    );
});
test('explicit review binds only a fresh displayed cloud revision; changed remote revision needs another review', async () => {
    const f = relayFixture(),
        p = fixture().pass;
    f.data.remote = { ...p.context, rulesDigest: 'e'.repeat(64) };
    f.data.revision = revision;
    f.update(p);
    await f.relay.settled();
    assert.equal(f.relay.status().conflict?.revision, revision);
    assert.equal(f.relay.status().conflict?.rules.length, 8);
    assert.equal(f.relay.review('00000000-0000-4000-8000-000000000099', wakeCloudContextKey(p.context)), false);
    assert.equal(f.relay.review(revision, 'wrong-local-context'), false);
    f.data.revision = '00000000-0000-4000-8000-000000000088';
    assert.equal(f.relay.review(revision, wakeCloudContextKey(p.context)), true);
    await f.relay.settled();
    assert.equal(f.relay.status().state, 'conflict');
    assert.equal(
        f.data.calls.some((c) => c.action === 'bind'),
        false,
    );
    assert.equal(f.relay.review(f.data.revision, wakeCloudContextKey(p.context)), true);
    await f.relay.settled();
    assert.equal(f.relay.status().state, 'ready');
    assert.equal(f.data.calls.filter((c) => c.action === 'bind').length, 1);
});
test('retirement sends only the exact owned revision and drops readiness synchronously', async () => {
    const f = relayFixture();
    f.update(fixture().pass);
    await f.relay.settled();
    f.relay.retire();
    assert.equal(f.relay.status().capability, 0);
    await f.relay.settled();
    const request = f.data.calls.at(-1)!;
    assert.equal(request.action, 'retire');
    assert.equal(request.contextRevision, revision);
    assert.equal(f.relay.status().capability, 0);
});
test('oversized response, redirect/network failure and malformed ACKs cannot claim readiness', async () => {
    for (const reply of [
        () => new Response('x'.repeat(8193)),
        () => {
            throw Error('synthetic redirect refusal');
        },
        () =>
            Response.json({
                ok: true,
                wake: { v: 1, enabled: true },
                devices: 1,
                contextRevision: null,
                context: null,
                retired: 'wrong',
            }),
    ]) {
        const f = relayFixture(reply);
        f.update(fixture().pass);
        await f.relay.settled();
        assert.equal(f.relay.status().capability, 0);
        assert.equal(f.data.acks.length, 0);
    }
    assert.throws(
        () =>
            new WakeRelay({
                endpoint: 'https://example.test/other',
                fetchImpl: fetch,
                anonKey: () => '',
                credentials: () => null,
                ownerId: () => null,
                internetAllowed: () => true,
            }),
    );
});
