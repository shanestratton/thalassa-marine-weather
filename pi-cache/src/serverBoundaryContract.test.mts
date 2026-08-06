import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = readFileSync(new URL('./server.ts', import.meta.url), 'utf8');
const proxySource = readFileSync(new URL('./proxy.ts', import.meta.url), 'utf8');
const encRouteSource = readFileSync(new URL('./routes/enc.ts', import.meta.url), 'utf8');
const chartRouteSource = readFileSync(new URL('./routes/charts.ts', import.meta.url), 'utf8');
const diaryRelaySource = readFileSync(new URL('./diaryRelayOutbox.ts', import.meta.url), 'utf8');
const osmServiceSource = readFileSync(new URL('./services/osm.ts', import.meta.url), 'utf8');

test('server binds through the loopback-default policy and restricts CORS', () => {
    assert.match(source, /server\.listen\(PORT, BIND_HOST/);
    assert.match(source, /CORS_ORIGINS\.has\(origin\)/);
    assert.doesNotMatch(source, /app\.use\(cors\(\)\)/);
});

test('the API is served over TLS anchored to the pairing identity', () => {
    // The app validates this certificate by comparing its public key to the
    // one it pinned at pairing, so express must never be handed to a plain
    // http listener — there is no CA to fall back on and no cleartext lane.
    assert.match(source, /https\.createServer\(\{ key: tls\.keyPem, cert: tls\.certPem/);
    assert.match(source, /minVersion: 'TLSv1\.2'/);
    assert.doesNotMatch(source, /http\.createServer\(app\)/);
});

test('the plaintext port is a signpost, never a data path or a redirect', () => {
    // A 30x would put the requested path back on the wire in clear, which is
    // exactly what the TLS switch was for.
    const signpost = source.slice(source.indexOf('const plaintextSignpost'));
    assert.match(signpost, /writeHead\(400/);
    assert.doesNotMatch(signpost, /writeHead\(30\d/);
    assert.doesNotMatch(signpost, /Location/);
});

test('all mutable/private Pi surfaces share the unsafe-admin gate', () => {
    for (const route of [
        "app.post('/api/configure', requireUnsafeAdmin",
        "app.post('/cache/purge', requireUnsafeAdmin",
        "app.get('/api/passthrough', requireUnsafeAdmin",
        "app.get('/api/passthrough-tile', requireUnsafeAdmin",
        "app.use('/api/misc/proxy', requireUnsafeAdmin)",
    ]) {
        assert.equal(source.includes(route), true, `${route} is not guarded`);
    }
    for (const prefix of ['/api/charts', '/api/enc', '/api/osm', '/api/pair', '/api/diary']) {
        assert.equal(source.includes(`'${prefix}'`), true, `${prefix} is absent from the disabled prefix list`);
    }
    assert.match(source, /app\.use\(prefix, requireUnsafeAdmin\)/);
});

test('ENC watcher and app hosting require unsafe opt-in', () => {
    assert.match(source, /UNSAFE_ADMIN_API_ENABLED && process\.env\.ENC_WATCHER_ENABLED === 'true'/);
    assert.match(source, /UNSAFE_ADMIN_API_ENABLED && fs\.existsSync/);
});

test('public status is built only from the redacted payload helper', () => {
    const statusStart = source.indexOf("app.get('/status'");
    const nextRoute = source.indexOf("app.get('/api/admin/status'", statusStart);
    const statusBlock = source.slice(statusStart, nextRoute);
    assert.match(statusBlock, /publicStatusPayload/);
    assert.doesNotMatch(statusBlock, /PREFETCH_|ownerId|diaryRelay|cacheDir/);
});

test('all user-directed upstream requests cross the pinned outbound policy', () => {
    for (const [name, routeSource] of [
        ['ENC', encRouteSource],
        ['chart', chartRouteSource],
    ] as const) {
        assert.match(routeSource, /outboundFetch/);
        assert.doesNotMatch(routeSource, /\bfetch\s*\(/, `${name} route retained a direct fetch sink`);
    }
    assert.match(proxySource, /import \{ outboundFetch \}/);
    assert.doesNotMatch(proxySource, /\bfetch\s*\(/, 'generic proxy retained a direct fetch sink');
    assert.match(osmServiceSource, /outboundFetch\(OVERPASS_URL/);
    assert.doesNotMatch(osmServiceSource, /\bfetch\s*\(/, 'Overpass retained a direct fetch sink');
});

test('HTTP configuration may assert but never mutate or persist a new Supabase authority', () => {
    assert.match(source, /const SUPABASE_ORIGIN = resolveTrustedSupabaseOrigin\(process\.env\.SUPABASE_URL\)/);
    assert.match(source, /assertSupabaseOriginAssertion\(supabaseUrl, SUPABASE_ORIGIN\)/);
    assert.doesNotMatch(source, /proxyConfig\.supabaseUrl\s*=/);
    assert.equal(source.match(/SUPABASE_ORIGIN\s*=/g)?.length, 1, 'the startup trust anchor became mutable');
    assert.match(source, /envLines\.push\(`SUPABASE_URL=\$\{SUPABASE_ORIGIN\}`\)/);

    const routeStart = source.indexOf("app.post('/api/configure'");
    const routeEnd = source.indexOf("app.post('/cache/purge'", routeStart);
    const configureRoute = source.slice(routeStart, routeEnd);
    assert.ok(
        configureRoute.indexOf('assertSupabaseOriginAssertion') <
            configureRoute.indexOf('applyDiaryRelayConfiguration'),
        'origin validation must precede every persisted/mutable configuration side effect',
    );
});

test('diary relay endpoint and production transport inherit the startup Supabase trust anchor', () => {
    assert.match(source, /new DiaryRelayOutbox\(CACHE_DIR, \{ trustedSupabaseOrigin: SUPABASE_ORIGIN \}\)/);
    assert.match(diaryRelaySource, /parsed\.href !== trustedRelayEndpoint/);
    assert.match(diaryRelaySource, /this\.fetchImpl\s*=\s*options\.fetchImpl \?\?/);
    assert.match(diaryRelaySource, /outboundFetch\(url,/);
    assert.doesNotMatch(diaryRelaySource, /\bfetch\s*\(/, 'diary relay retained a direct global fetch sink');

    const migration = diaryRelaySource.indexOf('this.invalidateUntrustedPersistedRelayUrls()');
    const startupSweep = diaryRelaySource.indexOf('queueMicrotask');
    assert.ok(migration > 0 && migration < startupSweep, 'legacy relay URLs must be invalidated before startup I/O');
    for (const table of ['diary_relay_config', 'diary_relay_outbox', 'diary_relay_cancellations']) {
        assert.match(
            diaryRelaySource.slice(diaryRelaySource.indexOf('private invalidateUntrustedPersistedRelayUrls')),
            new RegExp(`UPDATE ${table}`),
        );
    }
});
