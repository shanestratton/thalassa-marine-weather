import assert from 'node:assert/strict';
import path from 'node:path';

const fixture = 'postgres://postgres:fixture-only-password@127.0.0.1:5432/catch140_test';
export function privateCatchFixtureConfig(env, platform) {
    assert.equal(platform, 'linux', 'Actual Linux PostgreSQL proof required');
    assert.equal(env.THALASSA_DISPOSABLE_PRIVATE_CATCH_TEST, '1', 'Explicit disposable catch proof opt-in required');
    assert.equal(
        env.PRIVATE_CATCH_TEST_DATABASE_URL,
        fixture,
        'Only the exact localhost catch140_test fixture is allowed',
    );
    assert.ok(!env.PGLITE_MODULE_PATH, 'WASM and real PostgreSQL proof runtimes cannot be mixed');
    assert.ok(
        typeof env.PG_MODULE_PATH === 'string' && path.isAbsolute(env.PG_MODULE_PATH),
        'An explicit existing local pg driver is required',
    );
    return {
        modulePath: env.PG_MODULE_PATH,
        connection: {
            host: '127.0.0.1',
            port: 5432,
            user: 'postgres',
            password: 'fixture-only-password',
            database: 'catch140_test',
            connectionTimeoutMillis: 5000,
            statement_timeout: 15000,
            query_timeout: 20000,
            application_name: 'thalassa-private-catch-disposable-proof',
        },
    };
}
export function assertPrivateCatchFixtureFacts(facts) {
    assert.equal(facts.database, 'catch140_test', 'Actual database identity must be the disposable fixture');
    assert.equal(facts.user, 'postgres', 'Actual fixture user must be postgres');
    assert.equal(Number(facts.server_version_num), 170006, 'Actual PostgreSQL 17.6 is required');
    assert.match(facts.version, /linux/i, 'The actual PostgreSQL server must run Linux');
    assert.equal(Number(facts.tables), 0, 'Fixture user schemas must be empty before any DDL');
    assert.equal(Number(facts.functions), 0, 'Fixture user functions must be empty before any DDL');
    assert.equal(Number(facts.auth_schema), 0, 'Fixture cannot contain a product auth schema');
    assert.equal(Number(facts.auth_roles), 0, 'Fixture cannot contain product auth roles');
    assert.equal(Number(facts.databases), 0, 'Fixture requires a dedicated disposable cluster');
    assert.equal(Number(facts.publications), 0, 'Fixture cannot contain existing publications');
}
