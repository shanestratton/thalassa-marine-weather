import assert from 'node:assert/strict';
import test from 'node:test';
import { assertComfortFixtureFacts, comfortFixtureConfig } from './private-comfort-disposable.mjs';
const env = {
    THALASSA_DISPOSABLE_PRIVATE_COMFORT_TEST: '1',
    PRIVATE_COMFORT_TEST_DATABASE_URL: 'postgres://postgres:fixture-only-password@127.0.0.1:5432/comfort141_test',
    PG_MODULE_PATH: '/existing/pg/index.js',
};
test('only exact disposable Linux fixture is accepted', () =>
    assert.equal(comfortFixtureConfig(env, 'linux').connection.database, 'comfort141_test'));
for (const [name, changed, platform] of [
    ['Windows', {}, 'win32'],
    ['missing opt-in', { THALASSA_DISPOSABLE_PRIVATE_COMFORT_TEST: '' }, 'linux'],
    [
        'product host',
        {
            PRIVATE_COMFORT_TEST_DATABASE_URL:
                'postgres://postgres:fixture-only-password@db.project.supabase.co:5432/comfort141_test',
        },
        'linux',
    ],
    [
        'wrong database',
        {
            PRIVATE_COMFORT_TEST_DATABASE_URL: env.PRIVATE_COMFORT_TEST_DATABASE_URL.replace(
                'comfort141_test',
                'postgres',
            ),
        },
        'linux',
    ],
    [
        'wrong user',
        {
            PRIVATE_COMFORT_TEST_DATABASE_URL: env.PRIVATE_COMFORT_TEST_DATABASE_URL.replace(
                'postgres:fixture',
                'service_role:fixture',
            ),
        },
        'linux',
    ],
    [
        'wrong port',
        { PRIVATE_COMFORT_TEST_DATABASE_URL: env.PRIVATE_COMFORT_TEST_DATABASE_URL.replace(':5432/', ':5433/') },
        'linux',
    ],
    [
        'query override',
        { PRIVATE_COMFORT_TEST_DATABASE_URL: `${env.PRIVATE_COMFORT_TEST_DATABASE_URL}?host=other` },
        'linux',
    ],
    ['mixed WASM', { PGLITE_MODULE_PATH: '/existing/pglite.js' }, 'linux'],
    ['relative driver', { PG_MODULE_PATH: './pg.js' }, 'linux'],
    ...['PGHOST', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD', 'PGSERVICE', 'PGSSLMODE'].map((key) => [
        `ambient ${key}`,
        { [key]: 'untrusted' },
        'linux',
    ]),
])
    test(`refuses ${name}`, () => assert.throws(() => comfortFixtureConfig({ ...env, ...changed }, platform)));
const facts = {
    database: 'comfort141_test',
    user: 'postgres',
    server_version_num: 170006,
    version: 'PostgreSQL17.6 linux',
    tables: 0,
    functions: 0,
    auth_schema: 0,
    auth_roles: 0,
    databases: 0,
    publications: 0,
};
test('only genuine empty PG17.6 cluster facts are accepted', () => assertComfortFixtureFacts(facts));
for (const [key, value] of Object.entries({
    database: 'product',
    user: 'service_role',
    server_version_num: 170007,
    version: 'WASM',
    tables: 1,
    functions: 1,
    auth_schema: 1,
    auth_roles: 1,
    databases: 1,
    publications: 1,
}))
    test(`refuses wrong server fact ${key}`, () =>
        assert.throws(() => assertComfortFixtureFacts({ ...facts, [key]: value })));
