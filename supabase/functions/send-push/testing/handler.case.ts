/** Execute the real handler with fixed transport adapters and denied network.
 * Run explicitly with testing/import-map.json; this is separate from generic Edge tests.
 * The ordinary Edge typecheck still checks index.ts against the real SDK types. */
import { proof, registeredHandler } from './dependencies.ts';

const equal = (actual: unknown, expected: unknown) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw Error('Actual sender boundary assertion failed');
};
const queueId = '10000000-0000-4000-8000-000000000001';
const revision = '20000000-0000-4000-8000-000000000001';
const boatId = '30000000-0000-4000-8000-000000000001';
const ownerId = '40000000-0000-4000-8000-000000000001';
const key = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', key.privateKey));
const fixtureKey = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der))}\n-----END PRIVATE KEY-----`;
let moduleCase = 0;

async function run(
    options: {
        tokens?: number;
        current?: boolean | null;
        attempt?: boolean | null;
        badKey?: boolean;
        httpStatus?: number;
        networkError?: boolean;
        malformed?: boolean;
        lightning?: boolean;
        currentChecks?: Array<boolean | null>;
    } = {},
) {
    proof.handler = undefined;
    proof.events = [];
    proof.updates = [];
    proof.initiated = 0;
    proof.current = options.current === undefined ? true : options.current;
    proof.currentChecks = [...(options.currentChecks ?? [])];
    proof.attempt = options.attempt === undefined ? true : options.attempt;
    proof.tokens = Array.from(
        { length: options.tokens ?? 1 },
        (_, index) => ({ id: `fixture-token-${index}`, device_token: `fixture-device-${index}`, platform: 'ios' }),
    );
    const now = Date.now();
    proof.record = {
        id: queueId,
        recipient_user_id: ownerId,
        notification_type: 'overdue_notice',
        title: 'Passage check-in overdue',
        body: 'Synthetic fixture only',
        created_at: new Date(now).toISOString(),
        data: {
            overdue_watch: 1,
            boatId,
            revision,
            overdueAt: now - 60_000,
            expiresAt: now + 300_000,
            ...(options.malformed ? { extra: 'must be rejected' } : {}),
        },
    };
    if (options.lightning) {
        proof.record.notification_type = 'lightning_nearby';
        proof.record.title = 'Lightning within 20 NM';
        proof.record.data = {
            type: 'lightning_nearby',
            provider: options.malformed ? 'unknown' : 'xweather',
            source_at: now - 1000,
            expires_at: now + 59000,
            pulse_id: 'original-fixture-pulse',
        };
    }
    const environment = {
        SUPABASE_URL: 'https://fixture.invalid',
        SUPABASE_SERVICE_ROLE_KEY: 'fixture-service-role',
        APNS_KEY_ID: 'FIXTUREKEY',
        APNS_TEAM_ID: 'FIXTURETEAM',
        APNS_KEY_P8: options.badKey ? 'invalid fixture key' : fixtureKey,
        APNS_PRODUCTION: 'true',
        APNS_CRITICAL_ALERTS_ENABLED: 'true',
        APNS_BUNDLE_ID: 'com.thalassa.weather',
    };
    const previous = Object.fromEntries(Object.keys(environment).map((name) => [name, Deno.env.get(name)]));
    const originalFetch = globalThis.fetch;
    let httpCalls = 0;
    let sentAps: Record<string, unknown> | undefined;
    let expiration: string | null = null;
    try {
        for (const [name, value] of Object.entries(environment)) Deno.env.set(name, value);
        globalThis.fetch = (input, init) => {
            if (
                typeof input !== 'string' ||
                !/^https:\/\/api\.push\.apple\.com\/3\/device\/fixture-device-\d+$/.test(input)
            ) throw Error('Non-fixture transport rejected');
            if (init?.method !== 'POST' || typeof init.body !== 'string') throw Error('Expected prepared HTTP request');
            if (
                !options.lightning &&
                proof.events.filter((event) => event === 'overdue_owner_attempt').length < httpCalls + 1
            ) {
                throw Error('Missing HTTP attempt receipt');
            }
            if (options.lightning && proof.events.at(-1) !== 'lightning_watch_delivery_current') {
                throw Error('Missing immediate lightning delivery authority');
            }
            if (!new Headers(init.headers).get('authorization')?.startsWith('bearer ey')) {
                throw Error('Expected prepared synthetic JWT');
            }
            sentAps = JSON.parse(init.body).aps;
            expiration = new Headers(init.headers).get('apns-expiration');
            httpCalls++;
            proof.events.push('synthetic-apns-http');
            return options.networkError
                ? Promise.reject(Error('Synthetic uncertain transport outcome'))
                : Promise.resolve(new Response(null, { status: options.httpStatus ?? 200 }));
        };
        const target = new URL('../index.ts', import.meta.url);
        target.searchParams.set('actual-handler-proof', String(++moduleCase));
        await import(target.href);
        const response = await registeredHandler()(
            new Request('https://fixture.invalid/send-push', {
                method: 'POST',
                headers: { authorization: 'Bearer fixture-service-role', 'content-type': 'application/json' },
                body: JSON.stringify({ record: { id: queueId } }),
            }),
        );
        return {
            status: response.status,
            httpCalls,
            initiated: proof.initiated,
            events: [...proof.events],
            sentAps,
            expiration,
        };
    } finally {
        globalThis.fetch = originalFetch;
        for (const [name, value] of Object.entries(previous)) {
            if (value === undefined) Deno.env.delete(name);
            else Deno.env.set(name, value);
        }
    }
}

Deno.test('actual sender: missing owner tokens never initiate the overdue grace period', async () => {
    const result = await run({ tokens: 0 });
    equal([result.status, result.httpCalls, result.initiated], [200, 0, 0]);
    equal(result.events.includes('overdue_owner_attempt'), false);
});
Deno.test('actual sender: failed JWT preparation never initiates the overdue grace period', async () => {
    const result = await run({ badKey: true });
    equal([result.status, result.httpCalls, result.initiated], [502, 0, 0]);
    equal(result.events.includes('overdue_owner_attempt'), false);
});
Deno.test('actual sender: cancelled watch and unavailable checks never reach provider HTTP', async () => {
    const cancelled = await run({ current: false });
    equal([cancelled.httpCalls, cancelled.initiated], [0, 0]);
    const unavailable = await run({ current: null });
    equal([unavailable.status, unavailable.httpCalls, unavailable.initiated], [503, 0, 0]);
});
Deno.test('actual sender: cancellation after preparation is checked immediately before HTTP', async () => {
    const result = await run({ attempt: false });
    equal([result.httpCalls, result.initiated], [0, 0]);
    equal(result.events.includes('overdue_owner_attempt'), true);
});
Deno.test('actual sender: malformed persisted overdue facts never initiate a grace period', async () => {
    const result = await run({ malformed: true });
    equal([result.httpCalls, result.initiated], [0, 0]);
});
Deno.test('actual sender: ordinary owner HTTP follows its attempt receipt even with critical entitlement', async () => {
    const result = await run();
    equal([result.status, result.httpCalls, result.initiated], [200, 1, 1]);
    equal(result.sentAps?.['interruption-level'], 'active');
    equal(result.sentAps?.sound, 'default');
    equal(result.sentAps?.['thread-id'], 'thalassa-overdue');
});
Deno.test('actual sender: retry and multiple tokens retain one initiated logical owner attempt', async () => {
    const retried = await run({ httpStatus: 503 });
    equal([retried.status, retried.httpCalls, retried.initiated], [502, 3, 1]);
    const multiple = await run({ tokens: 2 });
    equal([multiple.status, multiple.httpCalls, multiple.initiated], [200, 2, 1]);
});
Deno.test('actual sender: uncertain HTTP outcome is attempted and never reported as delivered', async () => {
    const result = await run({ networkError: true });
    equal([result.status, result.httpCalls, result.initiated], [502, 3, 1]);
});
Deno.test('actual lightning sender: current ordinary event expires immediately at APNs', async () => {
    const result = await run({ lightning: true });
    equal([result.status, result.httpCalls, result.expiration], [200, 1, '0']);
    equal(result.sentAps?.['interruption-level'], 'active');
    equal(result.sentAps?.sound, 'default');
    equal(result.sentAps?.['thread-id'], 'thalassa-weather');
});
Deno.test('actual lightning sender: revoked owner and unknown permission stop before token lookup', async () => {
    for (const current of [false, null]) {
        const result = await run({ lightning: true, current });
        equal(result.httpCalls, 0);
        equal(result.events.includes('token-lookup'), false);
    }
});
Deno.test('actual lightning sender: revocation after JWT/body preparation stops before HTTP', async () => {
    const result = await run({ lightning: true, currentChecks: [true, true, false] });
    equal(result.httpCalls, 0);
    equal(result.events.filter((event) => event === 'lightning_watch_delivery_current').length, 3);
});
Deno.test('actual lightning sender: every retry rechecks current opt-in', async () => {
    const result = await run({ lightning: true, httpStatus: 503, currentChecks: [true, true, true, false] });
    equal(result.httpCalls, 1);
});
Deno.test('actual lightning sender: malformed original provider identity never sends', async () => {
    const result = await run({ lightning: true, malformed: true });
    equal(result.httpCalls, 0);
});
