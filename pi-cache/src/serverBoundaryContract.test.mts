import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = readFileSync(new URL('./server.ts', import.meta.url), 'utf8');

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
