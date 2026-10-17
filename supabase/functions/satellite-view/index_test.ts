function assert(condition: unknown, message = 'Assertion failed'): asserts condition {
    if (!condition) throw new Error(message);
}
Deno.test('actual public satellite entry uses real HMAC quota and fixed bounded provider transport', async (t) => {
    const serve = Object.getOwnPropertyDescriptor(Deno, 'serve')!, nativeFetch = globalThis.fetch;
    // Synthetic method stubs only: canonical CI grants no ambient env or network
    // permissions, and the test never reads or changes the real host environment.
    const methods = ['get', 'set', 'delete'] as const;
    const descriptors = new Map(methods.map((name) => [name, Object.getOwnPropertyDescriptor(Deno.env, name)]));
    const environment = new Map<string, string>();
    let handle: ((request: Request) => Promise<Response>) | undefined, allowed: unknown = true;
    const events: string[] = [];
    let quotaError = false, providerStatus = 200, missing = false;
    const now = () => new Date(Math.floor(Date.now() / 600000) * 600000).toISOString().replace('.000Z', 'Z');
    const url = (query = '?action=times&product=himawari-ir') =>
        'https://project.example/functions/v1/satellite-view' + query;
    const request = (query?: string, headers: Record<string, string> = {}) =>
        new Request(url(query), { headers: { 'cf-connecting-ip': '198.51.100.2', ...headers } });
    try {
        Object.defineProperties(Deno.env, {
            get: { configurable: true, value: (key: string) => environment.get(key) },
            set: {
                configurable: true,
                value: (key: string, value: string) => {
                    environment.set(key, value);
                },
            },
            delete: {
                configurable: true,
                value: (key: string) => {
                    environment.delete(key);
                },
            },
        });
        Deno.env.set('SUPABASE_URL', 'https://quota.example');
        Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'synthetic-service-fixture-only');
        Deno.env.delete('SATELLITE_VIEW_ENABLED');
        Object.defineProperty(Deno, 'serve', {
            configurable: true,
            value: (callback: typeof handle) => {
                handle = callback;
            },
        });
        globalThis.fetch = async (input, init) => {
            const req = new Request(input, init), target = new URL(req.url);
            if (target.origin === 'https://quota.example') {
                events.push('quota');
                assert(target.pathname === '/rest/v1/rpc/consume_public_edge_quota');
                assert(req.headers.get('apikey') === 'synthetic-service-fixture-only');
                const body = await req.json();
                assert(
                    body.p_bucket === 'satellite_view_public' && body.p_limit === 120 && body.p_window_seconds === 3600,
                );
                assert(/^[a-f0-9]{64}$/.test(body.p_client_hash) && !JSON.stringify(body).includes('198.51.100.2'));
                return new Response(quotaError ? '{}' : JSON.stringify(allowed), {
                    status: quotaError ? 500 : 200,
                    headers: { 'content-type': 'application/json' },
                });
            }
            events.push('provider');
            assert(target.origin === 'https://gibs.earthdata.nasa.gov');
            assert(req.redirect === 'error');
            assert(req.credentials === 'omit');
            for (const header of ['authorization', 'cookie', 'apikey', 'cf-connecting-ip', 'x-forwarded-for']) {
                assert(!req.headers.has(header), 'No client ' + header);
            }
            if (target.pathname.includes('/wmts/')) {
                return new Response(
                    `<Domains><DimensionDomain><ows:Identifier>time</ows:Identifier><Domain>${
                        missing ? '2020-01-01T00:00:00Z' : now()
                    }</Domain><Size>1</Size></DimensionDomain></Domains>`,
                    { status: providerStatus, headers: { 'content-type': 'text/xml' } },
                );
            }
            assert(target.pathname === '/wms/epsg3857/best/wms.cgi');
            const data = new Uint8Array(33);
            data.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
            const view = new DataView(data.buffer);
            view.setUint32(16, 1);
            view.setUint32(20, 1);
            return new Response(data, { headers: { 'content-type': 'image/png' } });
        };
        await import('./index.ts');
        assert(handle, 'Actual Deno.serve registration');
        await t.step('literal server gate OFF does not consume quota or request imagery', async () => {
            assert((await handle!(request())).status === 503);
            assert(events.length === 0);
        });
        Deno.env.set('SATELLITE_VIEW_ENABLED', 'true');
        await t.step('bare metadata read consumes quota then one fixed source', async () => {
            const r = await handle!(request());
            assert(r.status === 200);
            assert((await r.json()).product === 'himawari-ir');
            assert(events.join(',') === 'quota,provider');
        });
        await t.step('complete original image path retains listed time/window and post-image membership', async () => {
            events.length = 0;
            const r = await handle!(
                request(`?action=image&product=himawari-ir&time=${now()}&bbox=-1,-1,1,1&width=1&height=1`),
            );
            assert(r.status === 200);
            assert(r.headers.get('x-thalassa-listed-time') === now());
            assert(r.headers.get('x-thalassa-satellite-window') === '-1,-1,1,1:1x1');
            assert((await r.arrayBuffer()).byteLength === 33);
            assert(events.join(',') === 'quota,provider,provider,provider');
        });
        await t.step('user credential cannot bypass public quota or reach providers', async () => {
            events.length = 0;
            assert(
                (await handle!(
                    request(undefined, { authorization: 'Bearer private', cookie: 'private', apikey: 'private' }),
                )).status === 200,
            );
            assert(events.join(',') === 'quota,provider');
        });
        for (const value of [false, null, [], {}, 'true', 1, [true]]) {
            await t.step('only literal RPC true is authority: ' + JSON.stringify(value), async () => {
                events.length = 0;
                allowed = value;
                assert((await handle!(request())).status === 429);
                assert(events.join(',') === 'quota');
            });
        }
        allowed = true;
        await t.step('quota errors hold before provider access', async () => {
            events.length = 0;
            quotaError = true;
            assert((await handle!(request())).status === 503);
            assert(events.join(',') === 'quota');
            quotaError = false;
        });
        await t.step('malformed endpoints/queries do not consume quota', async () => {
            events.length = 0;
            for (
                const q of [
                    '/nested?action=times&product=himawari-ir',
                    '?action=times&product=unknown',
                    '?action=times&product=himawari-ir&url=https://bad.test',
                ]
            ) assert((await handle!(request(q))).status === 400);
            assert(events.length === 0);
        });
        await t.step('stale original metadata is unavailable without a fabricated new clock', async () => {
            events.length = 0;
            missing = true;
            assert((await handle!(request())).status === 502);
            assert(events.join(',') === 'quota,provider');
            missing = false;
        });
        await t.step('upstream HTTP error is held and never served as valid data', async () => {
            providerStatus = 503;
            assert((await handle!(request())).status === 502);
            providerStatus = 200;
        });
        await t.step('credential-free preflight needs no quota/provider read', async () => {
            events.length = 0;
            assert((await handle!(new Request(url(''), { method: 'OPTIONS' }))).status === 204);
            assert(events.length === 0);
        });
    } finally {
        globalThis.fetch = nativeFetch;
        Object.defineProperty(Deno, 'serve', serve);
        for (const name of methods) {
            const descriptor = descriptors.get(name);
            if (descriptor) Object.defineProperty(Deno.env, name, descriptor);
            else Reflect.deleteProperty(Deno.env, name);
        }
    }
});
