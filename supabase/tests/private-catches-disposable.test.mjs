import assert from 'node:assert/strict';
import { test } from 'node:test';
import { privateCatchFixtureConfig, assertPrivateCatchFixtureFacts } from './private-catches-disposable.mjs';
const env = {
    THALASSA_DISPOSABLE_PRIVATE_CATCH_TEST: '1',
    PRIVATE_CATCH_TEST_DATABASE_URL: 'postgres://postgres:fixture-only-password@127.0.0.1:5432/catch140_test',
    PG_MODULE_PATH: '/outside/node_modules/pg/lib/index.js',
};
test('exact disposable connection fields have no environment fallback', () => {
    const config = privateCatchFixtureConfig({ ...env, PGHOST: 'product.invalid', PGDATABASE: 'postgres' }, 'linux');
    assert.equal(config.connection.host, '127.0.0.1');
    assert.equal(config.connection.database, 'catch140_test');
    assert.equal(config.connection.user, 'postgres');
});
for (const [label, change, platform] of [
    ['missing opt-in', { THALASSA_DISPOSABLE_PRIVATE_CATCH_TEST: '' }, 'linux'],
    ['missing driver', { PG_MODULE_PATH: '' }, 'linux'],
    ['relative driver', { PG_MODULE_PATH: 'pg' }, 'linux'],
    ['mixed WASM runtime', { PGLITE_MODULE_PATH: '/outside/pglite.js' }, 'linux'],
    ['Windows execution', {}, 'win32'],
    [
        'remote host',
        {
            PRIVATE_CATCH_TEST_DATABASE_URL: env.PRIVATE_CATCH_TEST_DATABASE_URL.replace(
                '127.0.0.1',
                'product.invalid',
            ),
        },
        'linux',
    ],
    [
        'different database',
        { PRIVATE_CATCH_TEST_DATABASE_URL: env.PRIVATE_CATCH_TEST_DATABASE_URL.replace('catch140_test', 'postgres') },
        'linux',
    ],
    [
        'different port',
        { PRIVATE_CATCH_TEST_DATABASE_URL: env.PRIVATE_CATCH_TEST_DATABASE_URL.replace('5432', '6543') },
        'linux',
    ],
    [
        'query override',
        { PRIVATE_CATCH_TEST_DATABASE_URL: env.PRIVATE_CATCH_TEST_DATABASE_URL + '?host=product.invalid' },
        'linux',
    ],
    [
        'different credential',
        {
            PRIVATE_CATCH_TEST_DATABASE_URL: env.PRIVATE_CATCH_TEST_DATABASE_URL.replace(
                'fixture-only-password',
                'another-password',
            ),
        },
        'linux',
    ],
])
    test(`refuses ${label} before a driver can be imported`, () =>
        assert.throws(() => privateCatchFixtureConfig({ ...env, ...change }, platform)));
const facts = {
    database: 'catch140_test',
    user: 'postgres',
    server_version_num: 170006,
    version: 'PostgreSQL 17.6 on x86_64-pc-linux-gnu',
    tables: 0,
    functions: 0,
    auth_schema: 0,
    auth_roles: 0,
    databases: 0,
    publications: 0,
};
test('admits independently queried empty Linux 17.6 fixture facts', () =>
    assert.doesNotThrow(() => assertPrivateCatchFixtureFacts(facts)));
for (const [key, value] of Object.entries({
    database: 'postgres',
    user: 'service_role',
    server_version_num: 170007,
    version: 'PostgreSQL 17.6 Windows',
    tables: 1,
    functions: 1,
    auth_schema: 1,
    auth_roles: 3,
    databases: 1,
    publications: 1,
}))
    test(`refuses actual fixture mismatch ${key} before any DDL`, () =>
        assert.throws(() => assertPrivateCatchFixtureFacts({ ...facts, [key]: value })));
