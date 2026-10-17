import { underwayCapabilityReady } from './underway-capability.ts';
function assert(value: unknown, note: string): void {
    if (!value) throw new Error(note);
}
const URL_BASE = 'https://example.supabase.co';
const KEY = 'fixture-only-key';
Deno.test('underway readiness requires both exact schema and deployed push contract versions', async () => {
    let calls = 0;
    const fetcher: typeof fetch = async (url, init) => {
        calls++;
        assert(String(url) === `${URL_BASE}/functions/v1/send-push`, 'fixed same-project endpoint');
        assert(init?.method === 'POST' && init.redirect === 'error', 'bounded internal POST, no redirect');
        assert(new Headers(init?.headers).get('Authorization') === `Bearer ${KEY}`, 'service authentication');
        assert(init?.body === '{"action":"capabilities"}', 'never a queue id or chart payload');
        return Response.json({ underway_alarm: 1 });
    };
    assert(!await underwayCapabilityReady(async () => null, URL_BASE, KEY, fetcher), 'missing schema');
    assert(!await underwayCapabilityReady(async () => '1', URL_BASE, KEY, fetcher), 'schema type mismatch');
    assert(calls === 0, 'no push-service call before schema readiness');
    assert(await underwayCapabilityReady(async () => 1, URL_BASE, KEY, fetcher), 'both deployed');
    assert(calls === 1, 'one read-only capability call');
});
Deno.test('old, unavailable, malformed and oversized push-service answers never enable underway', async () => {
    const answers = [
        () => Response.json({ error: 'Missing queue record id' }, { status: 400 }),
        () => Response.json({ underway_alarm: 0 }),
        () => Response.json({ underway_alarm: '1' }),
        () => new Response('<html>no</html>'),
        () => new Response('x'.repeat(1_025)),
    ];
    for (const answer of answers) {
        assert(!await underwayCapabilityReady(async () => 1, URL_BASE, KEY, async () => answer()), 'fail closed');
    }
    assert(
        !await underwayCapabilityReady(
            async () => {
                throw new Error('RPC unavailable');
            },
            URL_BASE,
            KEY,
        ),
        'RPC error',
    );
    assert(
        !await underwayCapabilityReady(async () => 1, URL_BASE, KEY, async () => {
            throw new Error('timeout');
        }),
        'network failure',
    );
});
