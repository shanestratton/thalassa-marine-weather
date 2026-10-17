import assert from 'node:assert/strict';
import { test } from 'node:test';
import { presenceFixtureConfig, assertPresenceFixtureFacts } from './boat-presence-disposable.mjs';
const env = {
    THALASSA_DISPOSABLE_PRESENCE_TEST: '1',
    PRESENCE_TEST_DATABASE_URL: 'postgres://postgres:fixture-only-password@127.0.0.1:5432/presence140_test',
    PG_MODULE_PATH: '/outside/node_modules/pg/lib/index.js',
};
test('explicit connection ignores ambient PG host/options', () => {
    assert.deepEqual(
        presenceFixtureConfig({ ...env, PGHOST: 'product.invalid', PGOPTIONS: '-c search_path=public' }, 'linux')
            .connection.host,
        '127.0.0.1',
    );
});
for (const [name, change, platform] of [
    ['no opt-in', { THALASSA_DISPOSABLE_PRESENCE_TEST: '' }, 'linux'],
    ['no driver', { PG_MODULE_PATH: '' }, 'linux'],
    ['relative driver', { PG_MODULE_PATH: 'pg' }, 'linux'],
    ['WASM', { PGLITE_MODULE_PATH: '/outside/index.js' }, 'linux'],
    ['Windows', {}, 'win32'],
    ...['127.0.0.1|product.invalid', 'presence140_test|postgres', '5432|6543', 'fixture-only-password|other'].map(
        (x) => {
            const [a, b] = x.split('|');
            return [a, { PRESENCE_TEST_DATABASE_URL: env.PRESENCE_TEST_DATABASE_URL.replace(a, b) }, 'linux'];
        },
    ),
    ['URL option', { PRESENCE_TEST_DATABASE_URL: env.PRESENCE_TEST_DATABASE_URL + '?host=product.invalid' }, 'linux'],
])
    test(`refuses ${name} before driver import`, () =>
        assert.throws(() => presenceFixtureConfig({ ...env, ...change }, platform)));
const facts = {
    database: 'presence140_test',
    user: 'postgres',
    server_version_num: '170006',
    version: 'PostgreSQL17.6 Linux',
    tables: 0,
    functions: 0,
    auth_schema: 0,
    auth_roles: 0,
    databases: 0,
    publications: 0,
};
test('empty actual17.6 Linux accepted', () => assert.doesNotThrow(() => assertPresenceFixtureFacts(facts)));
for (const [key, value] of Object.entries({
    database: 'postgres',
    user: 'service_role',
    server_version_num: '170007',
    version: 'Windows',
    tables: 1,
    functions: 1,
    auth_schema: 1,
    auth_roles: 1,
    databases: 1,
    publications: 1,
}))
    test(`refuses contaminated ${key}`, () =>
        assert.throws(() => assertPresenceFixtureFacts({ ...facts, [key]: value })));
