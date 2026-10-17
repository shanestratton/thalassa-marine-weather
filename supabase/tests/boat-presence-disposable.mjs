import assert from 'node:assert/strict';
import path from 'node:path';
const fixture = 'postgres://postgres:fixture-only-password@127.0.0.1:5432/presence140_test';
export function presenceFixtureConfig(env, platform) {
    assert.equal(platform, 'linux', 'Actual Linux PostgreSQL proof required');
    assert.equal(env.THALASSA_DISPOSABLE_PRESENCE_TEST, '1', 'Explicit disposable presence proof opt-in required');
    assert.equal(
        env.PRESENCE_TEST_DATABASE_URL,
        fixture,
        'Only the exact localhost presence140_test fixture is allowed',
    );
    assert.ok(!env.PGLITE_MODULE_PATH, 'Do not mix WASM and actual server proofs');
    assert.ok(
        typeof env.PG_MODULE_PATH === 'string' && path.isAbsolute(env.PG_MODULE_PATH),
        'Existing absolute local pg driver required',
    );
    return {
        modulePath: env.PG_MODULE_PATH,
        connection: {
            host: '127.0.0.1',
            port: 5432,
            user: 'postgres',
            password: 'fixture-only-password',
            database: 'presence140_test',
            connectionTimeoutMillis: 5000,
            statement_timeout: 15000,
            query_timeout: 20000,
            application_name: 'thalassa-presence-disposable-proof',
        },
    };
}
export function assertPresenceFixtureFacts(facts) {
    assert.equal(facts.database, 'presence140_test');
    assert.equal(facts.user, 'postgres');
    assert.equal(Number(facts.server_version_num), 170006, 'Actual PostgreSQL17.6 required');
    assert.match(facts.version, /linux/i);
    for (const key of ['tables', 'functions', 'auth_schema', 'auth_roles', 'databases', 'publications'])
        assert.equal(Number(facts[key]), 0, `Empty dedicated fixture: ${key}`);
}
