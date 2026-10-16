import { type BuddyDependencies, buddyDependencies, createBuddyWatchHandler, runBuddyWatch } from './handler.ts';
import { createBuddyDeliveryGuard } from '../send-push/buddy-delivery.ts';
const eq = (a: unknown, b: unknown) => {
    if (JSON.stringify(a) !== JSON.stringify(b)) {
        throw new Error(`Expected ${JSON.stringify(b)}, received ${JSON.stringify(a)}`);
    }
};
const now = Date.parse('2026-10-17T07:00:00Z'),
    id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const row = (n = 1) => ({
    id: id(n),
    revision: id(900),
    configuration: { mmsi: 234567890, label: 'Fictional', enabled: true, area: null },
    stateRevision: null,
    state: null,
    facts: { at: now - 1000, sog: 0, navStatus: 5, distanceNm: null },
});
function fixture(rows: unknown = []) {
    const ticks: boolean[] = [], applied: unknown[][] = [];
    const deps: BuddyDependencies = {
        now: () => now,
        work: () => Promise.resolve(rows),
        apply: (...args) => {
            applied.push(args);
            return Promise.resolve(true);
        },
        finish: (s) => {
            ticks.push(s);
            return Promise.resolve();
        },
    };
    return { deps, ticks, applied };
}
Deno.test('service auth/method/body door precedes work and accepts no source/coordinates', async () => {
    const f = fixture(),
        handler = createBuddyWatchHandler({
            get: (n) => n === 'SUPABASE_SERVICE_ROLE_KEY' ? 'fixture-token' : undefined,
        }, f.deps);
    for (
        const [method, auth, body, status] of [['GET', 'fixture-token', undefined, 405], ['POST', 'wrong', '{}', 401], [
            'POST',
            'fixture-token',
            '{"mmsi":234567890}',
            400,
        ], ['POST', 'fixture-token', 'x'.repeat(129), 400]] as const
    ) {
        eq(
            (await handler(
                new Request('https://edge.synthetic.invalid', {
                    method,
                    headers: { authorization: `Bearer ${auth}` },
                    body,
                }),
            )).status,
            status,
        );
    }
    eq(f.ticks, []);
    eq(
        (await handler(
            new Request('https://edge.synthetic.invalid', {
                method: 'POST',
                headers: { authorization: 'Bearer fixture-token' },
                body: '{}',
            }),
        )).status,
        200,
    );
    eq(f.ticks, [true]);
});
Deno.test('actual pure original-clock evaluator receives validated fixed source facts', async () => {
    const f = fixture([row()]);
    eq(await runBuddyWatch(f.deps), { complete: true, checked: 1 });
    eq(f.applied.length, 1);
    eq((f.applied[0][4] as { event: unknown }).event, null);
    eq(f.ticks, [true]);
});
Deno.test('held/malformed/oversized/nonmonotonic pages never advertise readiness', async () => {
    for (
        const rows of [
            null,
            [{ ...row(), facts: { ...row().facts, at: '' } }],
            Array.from({ length: 33 }, (_, i) => row(i + 1)),
            [row(2), row(1)],
            [{ ...row(), configuration: { ...row().configuration, url: 'https://bad' } }],
        ]
    ) {
        const f = fixture(rows);
        eq((await runBuddyWatch(f.deps)).complete, false);
        eq(f.ticks, [false]);
    }
});
Deno.test('page/cold-start deadline bounds refuse tail completeness and perform no provider calls', async () => {
    const f = fixture();
    let calls = 0;
    f.deps.work = () => Promise.resolve(Array.from({ length: 32 }, (_, i) => row(++calls)));
    eq(await runBuddyWatch(f.deps), { complete: false, checked: 256 });
    eq(f.ticks, [false]);
    const deadline = fixture([row()]);
    let clock = now;
    deadline.deps.now = () => clock;
    deadline.deps.work = () => {
        clock += 16000;
        return Promise.resolve([row()]);
    };
    eq((await runBuddyWatch(deadline.deps)).complete, false);
    eq(deadline.applied.length, 0);
});
Deno.test('database transport only uses fixed RPCs, rejects redirects and caps streamed bodies', async () => {
    const urls: string[] = [],
        env = {
            get: (n: string) =>
                n === 'SUPABASE_URL'
                    ? 'https://database.synthetic.invalid'
                    : n === 'SUPABASE_SERVICE_ROLE_KEY'
                    ? 'fixture-key'
                    : undefined,
        };
    const deps = buddyDependencies(
        env,
        ((input, init) => {
            urls.push(String(input));
            eq(init?.redirect, 'error');
            return Promise.resolve(new Response('[]'));
        }) as typeof fetch,
    );
    await deps.work(null);
    eq(urls, ['https://database.synthetic.invalid/rest/v1/rpc/buddy_watch_work']);
    const bounded = buddyDependencies(env, (() => Promise.resolve(new Response('x'.repeat(128001)))) as typeof fetch);
    let refused = false;
    try {
        await bounded.work(null);
    } catch {
        refused = true;
    }
    eq(refused, true);
});
Deno.test('prepared delivery guard keeps original fact clocks and rechecks every attempt', async () => {
    let reads = 0;
    const data = {
        buddy_watch: 1,
        watch_id: id(1),
        revision: id(2),
        receipt_id: id(3),
        event: 'entered',
        observed_at: now - 1000,
    };
    const guard = createBuddyDeliveryGuard(
        '10000000-0000-4000-8000-000000000001',
        data,
        () => Promise.resolve(++reads === 1),
        () => now,
    );
    eq(await guard(), 'allow');
    eq(await guard(), 'retire');
    eq(reads, 2);
    const bad = createBuddyDeliveryGuard(id(1), { ...data, observed_at: now + 1 }, () => {
        throw new Error('must not read');
    }, () => now);
    eq(await bad(), 'retire');
});
