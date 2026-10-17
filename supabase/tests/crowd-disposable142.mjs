import assert from 'node:assert/strict';
import path from 'node:path';
export const CROWD_DATABASE_URL = 'postgresql://postgres:fixture-only-password@127.0.0.1:5432/crowd_soundings142_test';
export function crowdFixtureConfig(environment, platform) {
    assert.equal(platform, 'linux');
    assert.equal(environment.THALASSA_DISPOSABLE_CROWD_TEST, '1');
    assert.equal(environment.CROWD_TEST_DATABASE_URL, CROWD_DATABASE_URL);
    assert.ok(!['DATABASE_URL', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'].some((k) => environment[k]));
    assert.ok(!Object.keys(environment).some((k) => /^PG/i.test(k) && k !== 'PG_MODULE_PATH' && environment[k]));
    const modulePath = environment.PG_MODULE_PATH;
    assert.ok(
        typeof modulePath === 'string' &&
            path.isAbsolute(modulePath) &&
            modulePath.endsWith('/crowd142-pg/node_modules/pg/lib/index.js'),
    );
    return {
        modulePath,
        connection: {
            connectionString: CROWD_DATABASE_URL,
            connectionTimeoutMillis: 5000,
            statement_timeout: 15000,
            query_timeout: 18000,
            application_name: 'crowd142-disposable-proof',
        },
    };
}
export function assertCrowdFixtureFacts(facts) {
    assert.equal(facts.database, 'crowd_soundings142_test');
    assert.equal(facts.user, 'postgres');
    assert.equal(facts.version, '170006');
    for (const key of ['tables', 'functions', 'auth_schema', 'auth_roles', 'databases', 'publications'])
        assert.equal(Number(facts[key]), 0, key);
}

export function assertCrowdContainerCaps(facts) {
    assert.deepEqual(facts, {
        selfCgroup: '0::/',
        memoryMax: '536870912',
        swapMax: '0',
        pidsMax: '96',
        cpuMax: '100000 100000',
    });
}
