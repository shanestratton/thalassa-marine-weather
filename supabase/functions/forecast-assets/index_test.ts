import {
    ATMOS_DATASETS,
    atmosFileBytes,
    canonicalAtmosGeneration,
} from '../../../services/weather/api/atmosContract.ts';
import { proxyReleaseAsset } from '../../../api/_releaseAssetProxy.ts';

function assert(condition: unknown, message = 'Assertion failed'): asserts condition {
    if (!condition) throw new Error(message);
}
function source() {
    const spec = ATMOS_DATASETS['gfs-atmos'];
    const run = Math.floor(Date.now() / 21_600_000) * 21_600_000;
    const iso = (ms: number) => new Date(ms - (ms % 1000)).toISOString().replace('.000Z', 'Z');
    const generation = canonicalAtmosGeneration(iso(run), 'gfs-atmos', Array(29).fill('a'.repeat(64)));
    return {
        schema_version: 2,
        dataset: { key: 'gfs-atmos', id: spec.id },
        generation,
        generated_at: iso(Date.now()),
        published_at: iso(Date.now()),
        data_start: iso(run),
        data_end: iso(run + 168 * 3_600_000),
        cadence_hours: 6,
        dimensions: { width: 360, height: 181 },
        bounds: { west: -180, south: -90, east: 179, north: 90 },
        producer: { commit: 'b'.repeat(40), run_id: 1, run_attempt: 1 },
        metadata: {
            model: spec.model,
            source_resolution_degrees: '0.25',
            display_resolution_degrees: '1',
            fields: spec.fields.join(','),
            attribution: spec.attribution,
            licence: spec.licence,
        },
        files: Array.from(
            { length: 29 },
            (_, step) => ({
                step,
                offset_hours: step * 6,
                data_time: iso(run + step * 6 * 3_600_000),
                filename: `${generation}-h${String(step).padStart(3, '0')}.bin`,
                bytes: atmosFileBytes('gfs-atmos'),
                sha256: 'a'.repeat(64),
                content_type: 'application/octet-stream',
            }),
        ),
    };
}

Deno.test('actual credential-free Edge entry: quota RPC, fixed transport and Deno import closure', async (t) => {
    const originalServe = Object.getOwnPropertyDescriptor(Deno, 'serve')!;
    const nativeFetch = globalThis.fetch;
    const originalEnv = new Map(['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'].map((key) => [key, Deno.env.get(key)]));
    let handle: ((request: Request) => Promise<Response>) | undefined;
    const events: string[] = [];
    let allowed = true, quotaError = false;
    let assetStatus = 200, redirect: string | null = null;
    const manifest = source();
    const file = 'g-20261017T000000Z-123456abcdef-h000.bin';
    const url = (path: string) => `https://project.example/functions/v1/forecast-assets/${path}`;
    const req = (path: string, headers: Record<string, string> = {}) =>
        new Request(url(path), {
            headers: { 'cf-connecting-ip': '198.51.100.2', ...headers },
        });
    try {
        Deno.env.set('SUPABASE_URL', 'https://quota.example');
        Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'synthetic-service-fixture-only');
        Object.defineProperty(Deno, 'serve', {
            configurable: true,
            value: (handler: typeof handle) => {
                handle = handler;
            },
        });
        globalThis.fetch = async (input, init) => {
            const request = new Request(input, init), address = new URL(request.url);
            if (address.origin === 'https://quota.example') {
                events.push('quota');
                assert(address.pathname === '/rest/v1/rpc/consume_public_edge_quota', 'Only quota RPC permitted');
                assert(request.headers.get('apikey') === 'synthetic-service-fixture-only');
                const body = await request.json();
                assert(
                    body.p_bucket === 'forecast_assets_public' && body.p_limit === 120 &&
                        body.p_window_seconds === 3600,
                );
                assert(/^[a-f0-9]{64}$/.test(body.p_client_hash), 'HMAC only');
                assert(!JSON.stringify(body).includes('198.51.100.2'), 'No raw IP in database');
                return new Response(quotaError ? '{"message":"fixture quota failure"}' : JSON.stringify(allowed), {
                    status: quotaError ? 500 : 200,
                    headers: { 'content-type': 'application/json' },
                });
            }
            events.push('upstream');
            assert(address.origin === 'https://github.com');
            assert(address.pathname.startsWith('/shanestratton/thalassa-ocean-data/releases/download/'));
            for (const key of ['authorization', 'cookie', 'apikey', 'cf-connecting-ip', 'x-forwarded-for']) {
                assert(!request.headers.has(key), `Client ${key} must not reach GitHub`);
            }
            assert(request.redirect === 'manual');
            if (redirect) return new Response(null, { status: 302, headers: { location: redirect } });
            if (address.pathname.endsWith('.json')) {
                const body = address.pathname.endsWith('-a.json')
                    ? manifest
                    : { ...manifest, dimensions: { width: 1, height: 1 } };
                return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
            }
            return new Response(new Uint8Array([1, 2, 3]), {
                status: assetStatus,
                headers: { 'content-type': 'application/octet-stream' },
            });
        };
        await import('./index.ts');
        assert(handle, 'The real index must register Deno.serve');
        await t.step('bare read consumes real shared public quota before fixed GitHub access', async () => {
            const response = await handle!(req(`ssh/${file}`));
            assert(response.status === 200);
            assert(events.join(',') === 'quota,upstream');
            assert(new Uint8Array(await response.arrayBuffer()).join(',') === '1,2,3');
            assert(/^[a-f0-9]{64}$/.test(response.headers.get('x-content-sha256') ?? ''));
        });
        await t.step('both current discovery slots retain science validation and one valid slot', async () => {
            events.length = 0;
            const response = await handle!(req('gfs-atmos/manifest-v2.json'));
            assert(response.status === 200);
            assert(response.headers.get('x-thalassa-valid-manifest-slots') === '1');
            assert((await response.json()).generation === manifest.generation);
            assert(events.join(',') === 'quota,upstream,upstream');
        });
        await t.step('untrusted user JWT/API key cannot bypass the public quota', async () => {
            allowed = false;
            events.length = 0;
            const response = await handle!(
                req(`ssh/${file}`, { authorization: 'Bearer private-user', apikey: 'private-client' }),
            );
            assert(response.status === 429 && response.headers.get('retry-after') === '3600');
            assert(events.join(',') === 'quota');
            allowed = true;
        });
        await t.step('quota RPC failure holds without public GitHub access', async () => {
            quotaError = true;
            events.length = 0;
            assert((await handle!(req(`ssh/${file}`))).status === 503);
            assert(events.join(',') === 'quota');
            quotaError = false;
        });
        await t.step('missing service configuration fails closed without any request', async () => {
            Deno.env.delete('SUPABASE_SERVICE_ROLE_KEY');
            events.length = 0;
            assert((await handle!(req(`ssh/${file}`))).status === 503);
            assert(events.length === 0);
            Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'synthetic-service-fixture-only');
        });
        await t.step('unknown client address fails closed', async () => {
            events.length = 0;
            assert((await handle!(new Request(url(`ssh/${file}`)))).status === 503);
            assert(events.length === 0);
        });
        await t.step('preflight has no quota and requires no credential', async () => {
            events.length = 0;
            assert((await handle!(new Request(url('ssh/manifest-v2.json'), { method: 'OPTIONS' }))).status === 204);
            assert(events.length === 0);
        });
        await t.step(
            'coordinates, alternate datasets, names, mutation and partial bodies are refused before quota',
            async () => {
                events.length = 0;
                for (
                    const path of [
                        'sst/manifest-v2.json',
                        'ssh/manifest.json',
                        'ssh/h00.bin',
                        'ssh/manifest-v2.json?lat=1',
                        'ssh/manifest-v2.json?url=https://foreign.test',
                        'ssh/manifest-v2-a.json',
                    ]
                ) {
                    assert((await handle!(req(path))).status === 400);
                }
                assert((await handle!(req(`ssh/${file}`, { range: 'bytes=0-1' }))).status === 400);
                assert(
                    (await handle!(new Request(url('ssh/manifest-v2.json'), { method: 'POST', body: '{}' }))).status ===
                        405,
                );
                assert(events.length === 0);
            },
        );
        await t.step('foreign redirect is refused without requesting that host', async () => {
            events.length = 0;
            redirect = 'https://foreign.test/private';
            assert((await handle!(req(`ssh/${file}`))).status === 502);
            assert(events.join(',') === 'quota,upstream');
            redirect = null;
        });
        await t.step('upstream error is never served as a usable object', async () => {
            assetStatus = 404;
            assert((await handle!(req(`ssh/${file}`))).status === 404);
            assetStatus = 200;
        });
        await t.step('the original legacy bridge fails closed without a Node process global', async () => {
            const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'process');
            events.length = 0;
            try {
                Object.defineProperty(globalThis, 'process', { configurable: true, value: undefined });
                assert(
                    (await proxyReleaseAsset(new Request('https://example.test/currents/manifest.json'), 'currents'))
                        .status === 410,
                );
                assert(events.length === 0);
            } finally {
                if (descriptor) Object.defineProperty(globalThis, 'process', descriptor);
                else Reflect.deleteProperty(globalThis, 'process');
            }
        });
    } finally {
        globalThis.fetch = nativeFetch;
        Object.defineProperty(Deno, 'serve', originalServe);
        for (const [key, value] of originalEnv) value === undefined ? Deno.env.delete(key) : Deno.env.set(key, value);
    }
});
