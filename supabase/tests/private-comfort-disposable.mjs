import assert from 'node:assert/strict';
import path from 'node:path';
const fixture = 'postgres://postgres:fixture-only-password@127.0.0.1:5432/comfort141_test';
export function comfortFixtureConfig(env, platform) {
    assert.equal(platform, 'linux', 'Actual Linux PostgreSQL proof required');
    assert.equal(
        env.THALASSA_DISPOSABLE_PRIVATE_COMFORT_TEST,
        '1',
        'Explicit disposable comfort proof opt-in required',
    );
    assert.equal(env.PRIVATE_COMFORT_TEST_DATABASE_URL, fixture, 'Only exact localhost comfort141_test is allowed');
    assert.ok(!env.PGLITE_MODULE_PATH, 'Do not mix WASM and actual PostgreSQL proof');
    assert.ok(
        typeof env.PG_MODULE_PATH === 'string' && path.isAbsolute(env.PG_MODULE_PATH),
        'Existing absolute local pg driver required',
    );
    for (const [key, value] of Object.entries(env))
        if (/^(PGHOST|PGPORT|PGDATABASE|PGUSER|PGPASSWORD|PGSERVICE|PGSSLMODE)$/.test(key))
            assert.ok(!value, 'No ambient PostgreSQL connection settings');
    return {
        modulePath: env.PG_MODULE_PATH,
        connection: {
            host: '127.0.0.1',
            port: 5432,
            user: 'postgres',
            password: 'fixture-only-password',
            database: 'comfort141_test',
            connectionTimeoutMillis: 5000,
            statement_timeout: 15000,
            query_timeout: 20000,
            application_name: 'thalassa-private-comfort-disposable-proof',
        },
    };
}
export function assertComfortFixtureFacts(facts) {
    assert.equal(facts.database, 'comfort141_test');
    assert.equal(facts.user, 'postgres');
    assert.equal(Number(facts.server_version_num), 170006, 'Actual PostgreSQL17.6 required');
    assert.match(facts.version, /linux/i);
    for (const key of ['tables', 'functions', 'auth_schema', 'auth_roles', 'databases', 'publications'])
        assert.equal(Number(facts[key]), 0, `Empty dedicated fixture: ${key}`);
}
