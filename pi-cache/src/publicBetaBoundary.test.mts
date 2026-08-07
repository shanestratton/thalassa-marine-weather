import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    ADMIN_API_DISABLED_CODE,
    adminApiDisabledPayload,
    allowedCorsOrigins,
    publicStatusPayload,
    resolveBindHost,
    unsafeAdminApiEnabled,
    APP_API_DISABLED_CODE,
    appApiDisabledPayload,
    appApiEnabled,
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

test('app routes default ON so pairing and chart sync work out of the box', () => {
    // Deliberately the opposite default to every other flag here. These four
    // route groups ARE the product; network exposure is gated separately by
    // LAN_BIND (off by default), so mounting them on a loopback-only server
    // reaches nobody. Defaulting off would repeat the 2026-08-07 trap: a flag
    // absent from an existing Pi's .env silently kills the feature on the next
    // redeploy while everything still reports healthy.
    assert.equal(appApiEnabled({} as NodeJS.ProcessEnv), true);
    assert.equal(appApiEnabled({ THALASSA_PI_APP_API: '1' }), true);
    assert.equal(appApiEnabled({ THALASSA_PI_APP_API: '' }), true);
    // Opting out is explicit and exact.
    assert.equal(appApiEnabled({ THALASSA_PI_APP_API: '0' }), false);
    assert.equal(appApiEnabled({ THALASSA_PI_APP_API: 'false' }), true);
});

test('app routes do not depend on the unsafe admin flag', () => {
    // The whole point of the split: pairing a phone must not require exposing
    // /api/misc/proxy, the raster-chart download/delete API, and a 100 MB body
    // limit — on a flag whose own message says "isolated trusted boat LAN".
    const adminOff = { THALASSA_UNSAFE_ADMIN_API: '0' } as NodeJS.ProcessEnv;
    assert.equal(unsafeAdminApiEnabled(adminOff), false);
    assert.equal(appApiEnabled(adminOff), true);
});

test('disabled app-API response names the flag that fixes it', () => {
    const payload = appApiDisabledPayload();
    assert.equal(payload.code, APP_API_DISABLED_CODE);
    assert.notEqual(payload.code, ADMIN_API_DISABLED_CODE);
    assert.match(payload.error, /THALASSA_PI_APP_API/);
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
