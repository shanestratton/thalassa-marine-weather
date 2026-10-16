import { createOverdueWorker, type OverdueDependencies } from './handler.ts';
import { nonceHash, revokeNonce } from '../anchor-alert-messaging/transport.ts';
import { createOverdueDeliveryGuards } from '../send-push/overdue-delivery.ts';
const now = 1800000000000,
    id = '10000000-0000-4000-8000-000000000001',
    revision = '20000000-0000-4000-8000-000000000001';
const values: Record<string, string> = {
    SUPABASE_SERVICE_ROLE_KEY: 'fixture-service',
    OVERDUE_WATCH_ENABLED: '1',
    SHORE_MESSAGING_ENABLED: '1',
    SHORE_REVOKE_HMAC_KEY: 'b'.repeat(64),
    TELEGRAM_BOT_ID: '456',
};
const env = { get: (k: string) => values[k] };
const eq = (a: unknown, b: unknown) => {
    if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error('Unexpected result');
};
const request = (body: unknown = { action: 'work' }, auth = 'Bearer fixture-service') =>
    new Request('https://edge.fixture.invalid/overdue-watch', {
        method: 'POST',
        headers: { authorization: auth },
        body: JSON.stringify(body),
    });
async function fixture() {
    const calls: { name: string; args: unknown }[] = [], sent: { to: string; text: string; key: string }[] = [];
    const row = {
        id,
        revision,
        contactRevision: revision,
        contactId: id,
        revokeKey: revision,
        revokeHash: await nonceHash(await revokeNonce(env, id, revision)),
        channel: 'email',
        address: 'recipient@example.invalid',
        chatId: null,
        botId: null,
        plan: {
            vesselLabel: 'Fixture vessel',
            from: 'Harbour',
            to: 'Anchorage',
            departureAt: now - 3600000,
            etaAt: null,
            overdueAt: now - 1200000,
            persons: 2,
        },
        position: { lat: 0, lon: 0, at: now - 7200000 },
        rescueRegion: 'au',
        ownerAttemptedAt: now - 660000,
        preparedAt: now,
    };
    let claimed = false;
    const deps: OverdueDependencies = {
        now: () => now,
        monotonic: () => 0,
        rpc: async (name, args) => {
            calls.push({ name, args });
            if (name === 'overdue_watch_work') return { after: null };
            if (name === 'overdue_contact_claim') {
                if (claimed) return null;
                claimed = true;
                return row;
            }
            if (name === 'overdue_contact_guard') return true;
            return null;
        },
        email: async (to, text, key) => {
            sent.push({ to, text, key });
            return true;
        },
        telegram: async () => {
            throw new Error('No Telegram expected');
        },
    };
    return { calls, sent, row, deps, handler: createOverdueWorker(env, deps) };
}
Deno.test('service authentication and default-off env precede every source/provider call', async () => {
    const f = await fixture();
    eq((await f.handler(request({}, 'Bearer caller'))).status, 401);
    eq(f.calls, []);
    const h = createOverdueWorker({ get: (k) => k === 'OVERDUE_WATCH_ENABLED' ? '0' : values[k] }, f.deps);
    eq((await h(request())).status, 503);
    eq(f.calls, []);
    eq(f.sent, []);
});
Deno.test('worker accepts only fixed bounded action; no caller recipients/positions/URL or GET', async () => {
    const f = await fixture();
    eq((await f.handler(new Request('https://edge.fixture.invalid/overdue-watch'))).status, 405);
    for (
        const body of [
            { action: 'work', to: 'recipient@example.invalid' },
            { action: 'work', position: { lat: 0, lon: 0 } },
            { action: 'work', url: 'https://bad.invalid' },
            { action: 'x'.repeat(5000) },
        ]
    ) eq((await f.handler(request(body))).status, 400);
    eq(f.calls, []);
    eq(f.sent, []);
});
Deno.test('fixed personal notice reports attempt and original saved position age, never delivery/rescue activation', async () => {
    const f = await fixture();
    eq((await f.handler(request())).status, 200);
    eq(f.sent.length, 1);
    eq(f.sent[0].to, 'recipient@example.invalid');
    eq(f.sent[0].key, `shore-${id}-alarm`);
    for (
        const word of [
            'attempt began',
            'delivery is unconfirmed',
            '120 minutes old',
            'not live tracking',
            'not proof of distress',
            'has not contacted any rescue agency',
            '+61 2 6230 6811',
        ]
    ) eq(f.sent[0].text.includes(word), true);
    eq(f.calls.at(-1), { name: 'overdue_worker_finish', args: { p_success: true } });
});
Deno.test('last guard cancellation prevents provider call; unknown source time never becomes0', async () => {
    const f = await fixture(), rpc = f.deps.rpc;
    f.deps.rpc = (name, args) => name === 'overdue_contact_guard' ? Promise.resolve(false) : rpc(name, args);
    eq((await f.handler(request())).status, 200);
    eq(f.sent, []);
    const invalid = await fixture();
    invalid.row.ownerAttemptedAt = 0;
    eq((await invalid.handler(request())).status, 503);
    eq(invalid.sent, []);
});
Deno.test('wrong revocation key, stale/future/incoherent owner attempt or medical/route payload fails closed', async () => {
    for (
        const patch of [{ revokeHash: 'wrong' }, { ownerAttemptedAt: now + 1 }, { ownerAttemptedAt: now - 3600000 }, {
            plan: { vesselLabel: 'Unbounded', medical: 'private' },
        }]
    ) {
        const f = await fixture();
        Object.assign(f.row, patch);
        eq((await f.handler(request())).status, 503);
        eq(f.sent, []);
    }
});
Deno.test('quota/backlog/deadline or uncertain provider outcome cannot advertise fresh complete readiness', async () => {
    const f = await fixture(), rpc = f.deps.rpc;
    f.deps.rpc = (name, args) => name === 'overdue_contact_claim' ? Promise.resolve({ more: true }) : rpc(name, args);
    eq((await f.handler(request())).status, 503);
    eq(f.calls.at(-1), { name: 'overdue_worker_finish', args: { p_success: false } });
    const uncertain = await fixture();
    uncertain.deps.email = async () => false;
    eq((await uncertain.handler(request())).status, 503);
    const expired = await fixture();
    let tick = 0;
    expired.deps.monotonic = () => tick++ * 13000;
    eq((await expired.handler(request())).status, 503);
    eq(expired.sent, []);
});
Deno.test('email retry keeps its exact prepared body and key as wall-clock age advances', async () => {
    const first = await fixture(), retry = await fixture();
    retry.deps.now = () => now + 60000;
    await first.handler(request());
    await retry.handler(request());
    eq(retry.sent, first.sent);
    eq(first.sent[0].text.includes('at that preparation time'), true);
});
Deno.test('owner preflight never records an attempted HTTP; only explicit beforeHttp and valid current identity do', async () => {
    let reads = 0, attempts = 0;
    const data = { overdue_watch: 1, boatId: id, revision, overdueAt: now - 1000, expiresAt: now + 600000 };
    const g = createOverdueDeliveryGuards(id, data, async () => {
        reads++;
        return true;
    }, async () => {
        attempts++;
        return true;
    }, () => now);
    eq(await g.current(), 'allow');
    eq(reads, 1);
    eq(attempts, 0);
    eq(await g.beforeHttp(), 'allow');
    eq(attempts, 1);
    const expired = createOverdueDeliveryGuards(id, { ...data, expiresAt: now }, async () => true, async () => {
        attempts++;
        return true;
    }, () => now);
    eq(await expired.beforeHttp(), 'retire');
    eq(attempts, 1);
});
Deno.test('owner CAS/cancel false retires, unknown DB remains unavailable and never claims delivered', async () => {
    const data = { overdue_watch: 1, boatId: id, revision, overdueAt: now - 1000, expiresAt: now + 600000 };
    eq(
        await createOverdueDeliveryGuards(id, data, async () => false, async () => false, () => now).beforeHttp(),
        'retire',
    );
    eq(
        await createOverdueDeliveryGuards(id, data, async () => null, async () => {
            throw new Error('private');
        }, () => now).beforeHttp(),
        'unavailable',
    );
});
