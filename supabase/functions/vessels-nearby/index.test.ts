// Actual Edge entry point, with all transport intercepted. No database or provider access.
let handler: (request: Request) => Promise<Response>;
const originalServe = Deno.serve;
Deno.serve = ((callback: typeof handler) => {
    handler = callback;
    return {};
}) as typeof Deno.serve;
try {
    await import('./index.ts');
} finally {
    Deno.serve = originalServe;
}
const project = 'https://fictional-ais.invalid';
const owner = '11111111-1111-4111-8111-111111111111';
const originalFetch = globalThis.fetch;
const now = Date.now();
const freshRow = {
    mmsi: 970111111,
    name: 'FICTIONAL BEACON',
    lat: 50,
    lon: 1,
    nav_status: 14,
    updated_at: new Date(now - 120000).toISOString(),
    data_source: 'aishub',
    draught_m: 7.2,
    eta: '12-31 23:59',
    safety_text: 'SART ACTIVE',
    safety_text_at: new Date(now - 60000).toISOString(),
};
function assert(condition: unknown, message = 'Assertion failed'): asserts condition {
    if (!condition) throw Error(message);
}
async function runCase(
    options: { rows?: unknown; coverage?: unknown; quota?: boolean; url?: string; authorized?: boolean },
    check: (response: Response, calls: { path: string; body: Record<string, unknown> }[]) => Promise<void> | void,
) {
    const calls: { path: string; body: Record<string, unknown> }[] = [];
    const previous = new Map(
        ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY'].map((key) => [key, Deno.env.get(key)]),
    );
    Deno.env.set('SUPABASE_URL', project);
    Deno.env.set('SUPABASE_ANON_KEY', 'fictional-anon');
    Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'fictional-service');
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        assert(url.origin === project, 'Unexpected external transport');
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
        calls.push({ path: url.pathname, body });
        let result: unknown;
        if (url.pathname === '/auth/v1/user') {
            result = { id: owner, aud: 'authenticated', role: 'authenticated', email: 'fictional@example.invalid' };
        } else if (url.pathname === '/rest/v1/rpc/consume_edge_quota') result = options.quota ?? true;
        else if (url.pathname === '/rest/v1/rpc/request_ais_fleet_area') {
            result = options.coverage ?? { state: 'recent', polledAt: new Date(now).toISOString() };
        } else if (url.pathname === '/rest/v1/rpc/vessels_nearby_v135') result = options.rows ?? [freshRow];
        else throw Error('Unexpected database path');
        return Promise.resolve(
            new Response(JSON.stringify(result), { status: 200, headers: { 'Content-Type': 'application/json' } }),
        );
    }) as typeof fetch;
    try {
        const request = new Request(
            `${project}/functions/v1/vessels-nearby?${options.url ?? 'lat=50&lon=1&radius=200&limit=500'}`,
            { headers: options.authorized === false ? {} : { Authorization: 'Bearer fictional-jwt' } },
        );
        await check(await handler(request), calls);
    } finally {
        globalThis.fetch = originalFetch;
        for (const [key, value] of previous) {
            if (value === undefined) Deno.env.delete(key);
            else Deno.env.set(key, value);
        }
    }
}
Deno.test('fleet AIS Edge authenticates/meters before requesting a bounded area and preserves actual report age', async () => {
    await runCase({}, async (response, calls) => {
        assert(response.status === 200);
        const body = await response.json();
        const p = body.features[0].properties;
        assert(p.source === 'cloud' && p.informational === true && p.dataSource === 'AISHub');
        assert(
            p.updatedAt === freshRow.updated_at && p.safetyTextAt === freshRow.safety_text_at &&
                p.safetyText === 'SART ACTIVE',
        );
        assert(p.draught === 7.2 && p.eta === '12-31 23:59');
        assert(
            calls.map((c) => c.path).join('|') ===
                '/auth/v1/user|/rest/v1/rpc/consume_edge_quota|/rest/v1/rpc/request_ais_fleet_area|/rest/v1/rpc/vessels_nearby_v135',
        );
        assert(
            calls[2].body.request_owner === owner && calls[3].body.radius_m === 370400 &&
                calls[3].body.max_results === 500,
        );
    });
});
Deno.test('held licence never queries vessel data', async () => {
    await runCase({ coverage: { state: 'held' } }, async (response, calls) => {
        assert(response.status === 200);
        const body = await response.json();
        assert(body.features.length === 0 && body.coverage.state === 'held');
        assert(calls.length === 3);
    });
});
Deno.test('missing auth and exhausted quota never reach area or vessel RPC', async () => {
    await runCase({ authorized: false }, (response, calls) => {
        assert(response.status === 401);
        assert(calls.length === 0);
    });
    await runCase({ quota: false }, (response, calls) => {
        assert(response.status === 429);
        assert(calls.length === 2);
    });
});
Deno.test('out-of-bounds queries fail before service data access', async () => {
    for (const url of ['lat=91&lon=0', 'lat=50&lon=1&radius=201', 'lat=50&lon=1&limit=501']) {
        await runCase({ url }, (response, calls) => {
            assert(response.status === 400);
            assert(calls.length === 2);
        });
    }
});
Deno.test('malformed, oversized or old rows fail closed; old text cannot renew distress evidence', async () => {
    for (
        const rows of [Array(501).fill(freshRow), [{ ...freshRow, updated_at: new Date(now - 900001).toISOString() }], [
            { ...freshRow, lat: NaN },
        ]]
    ) await runCase({ rows }, (response) => assert(response.status === 502));
    await runCase(
        { rows: [{ ...freshRow, safety_text_at: new Date(now - 900001).toISOString() }] },
        async (response) => {
            assert(response.status === 200);
            const body = await response.json();
            assert(body.features[0].properties.safetyText === null);
        },
    );
});
