import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    ADMIN_API_DISABLED_CODE,
    adminApiDisabledPayload,
    allowedCorsOrigins,
    publicStatusPayload,
    resolveBindHost,
    unsafeAdminApiEnabled,
} from './publicBetaBoundary.js';

test('Pi server is loopback/admin-off/CORS-closed by default', () => {
    const env = {} as NodeJS.ProcessEnv;
    assert.equal(resolveBindHost(env), '127.0.0.1');
    assert.equal(unsafeAdminApiEnabled(env), false);
    assert.deepEqual([...allowedCorsOrigins(env)], []);
});

test('LAN and unsafe admin each require their exact explicit opt-in', () => {
    assert.equal(resolveBindHost({ THALASSA_PI_LAN_BIND: 'true' }), '127.0.0.1');
    assert.equal(resolveBindHost({ THALASSA_PI_LAN_BIND: '1' }), '0.0.0.0');
    assert.equal(unsafeAdminApiEnabled({ THALASSA_UNSAFE_ADMIN_API: 'true' }), false);
    assert.equal(unsafeAdminApiEnabled({ THALASSA_UNSAFE_ADMIN_API: '1' }), true);
});

test('CORS uses exact origins and never accepts wildcard/credentials/paths', () => {
    const origins = allowedCorsOrigins({
        THALASSA_CORS_ORIGINS:
            '*, https://thalassawx.app, https://user:pass@example.com, https://example.com/path, capacitor://localhost, javascript:alert(1)',
    });
    assert.deepEqual([...origins], ['https://thalassawx.app', 'capacitor://localhost']);
    assert.equal(origins.has('*'), false);
});

test('public status excludes coordinates, owner IDs, relay details, and paths', () => {
    const payload = publicStatusPayload({
        uptime: 12,
        bindHost: '127.0.0.1',
        unsafeAdminEnabled: false,
        cache: { kvEntries: 1, tileEntries: 2, kvFresh: 1, tileFresh: 2, dbSizeMB: 3 },
    });
    const encoded = JSON.stringify(payload);
    for (const forbidden of [
        'prefetchLat',
        'prefetchLon',
        'ownerId',
        'relayId',
        'diaryRelay',
        'cacheDir',
        'deviceId',
    ]) {
        assert.equal(encoded.includes(forbidden), false, `public status leaked ${forbidden}`);
    }
});

test('disabled admin response is explicit and stable', () => {
    const payload = adminApiDisabledPayload();
    assert.equal(payload.status, 'disabled');
    assert.equal(payload.code, ADMIN_API_DISABLED_CODE);
    assert.match(payload.error, /THALASSA_UNSAFE_ADMIN_API=1/);
});
