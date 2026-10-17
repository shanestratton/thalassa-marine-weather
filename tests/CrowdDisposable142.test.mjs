import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    crowdFixtureConfig,
    CROWD_DATABASE_URL,
    assertCrowdContainerCaps,
} from '../supabase/tests/crowd-disposable142.mjs';
const fixture = {
    THALASSA_DISPOSABLE_CROWD_TEST: '1',
    CROWD_TEST_DATABASE_URL: CROWD_DATABASE_URL,
    PG_MODULE_PATH: '/tmp/fixture/crowd142-pg/node_modules/pg/lib/index.js',
};
test('only exact opted-in disposable Linux fixture is admitted', () => {
    assert.equal(crowdFixtureConfig(fixture, 'linux').connection.connectionString, CROWD_DATABASE_URL);
    assert.throws(() => crowdFixtureConfig(fixture, 'win32'));
    assert.throws(() => crowdFixtureConfig({ ...fixture, THALASSA_DISPOSABLE_CROWD_TEST: '0' }, 'linux'));
});

test('actual own-container cgroup caps require512MiB,zero swap,96pids and one CPU', () => {
    const caps = { selfCgroup: '0::/', memoryMax: '536870912', swapMax: '0', pidsMax: '96', cpuMax: '100000 100000' };
    assert.doesNotThrow(() => assertCrowdContainerCaps(caps));
    for (const edit of [
        { selfCgroup: '0::/host/system.slice' },
        { memoryMax: 'max' },
        { swapMax: '536870912' },
        { pidsMax: 'max' },
        { cpuMax: 'max 100000' },
        { cpuMax: '200000 100000' },
        { extra: true },
    ])
        assert.throws(() => assertCrowdContainerCaps({ ...caps, ...edit }));
});
test('production credentials, alternate host/database and inherited PG options are refused', () => {
    for (const change of [
        { DATABASE_URL: 'product' },
        { SUPABASE_URL: 'https://production.invalid' },
        { SUPABASE_SERVICE_ROLE_KEY: 'forbidden' },
        { PGHOST: 'production.invalid' },
        { PGOPTIONS: '-c role=service_role' },
        { CROWD_TEST_DATABASE_URL: CROWD_DATABASE_URL.replace('127.0.0.1', 'localhost') },
        { CROWD_TEST_DATABASE_URL: CROWD_DATABASE_URL.replace('crowd_soundings142_test', 'postgres') },
        { PG_MODULE_PATH: 'https://module.invalid' },
    ])
        assert.throws(() => crowdFixtureConfig({ ...fixture, ...change }, 'linux'));
});
