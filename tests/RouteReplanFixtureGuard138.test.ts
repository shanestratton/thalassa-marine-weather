// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const exact = 'postgresql://postgres:fixture-only-password@127.0.0.1:5432/route_replan138_test';
const nonexistentModule = 'C:/fixture-only-do-not-connect/no-postgres-client.mjs';
function invoke(patch: Record<string, string>) {
    const env = { ...process.env };
    for (const name of Object.keys(env)) {
        if (/^PG/i.test(name) || name === 'DATABASE_URL' || name === 'THALASSA_DISPOSABLE_REPLAN_TEST')
            delete env[name];
    }
    return spawnSync(process.execPath, ['supabase/tests/route-replan-db.mjs'], {
        cwd: process.cwd(),
        env: { ...env, ...patch },
        encoding: 'utf8',
        timeout: 5000,
    });
}
describe('disposable reviewed-route database boundary', () => {
    it.each([
        exact.replace('127.0.0.1', 'localhost'),
        exact.replace(':5432/', ':5433/'),
        exact.replace('postgres:', 'reader:'),
        exact.replace('fixture-only-password', 'another-fixture-password'),
        exact.replace('/route_replan138_test', '/another_fixture'),
        exact + '?sslmode=disable',
        exact + '#fixture',
    ])('refuses a non-exact fixture connection before importing any client: %s', (url) => {
        const result = invoke({
            THALASSA_DISPOSABLE_REPLAN_TEST: '1',
            DATABASE_URL: url,
            PG_MODULE_PATH: nonexistentModule,
        });
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('Refusing a non-fixture database');
        expect(result.stderr).not.toContain('ERR_MODULE_NOT_FOUND');
    });
    it.each([
        'PG_MODULE_PATH',
        'PGHOST',
        'PGDATABASE',
        'PGPASSWORD',
        'DATABASE_URL',
        'THALASSA_DISPOSABLE_REPLAN_TEST',
    ])('refuses mixed PGlite/PG configuration before either module loads: %s', (name) => {
        const result = invoke({
            PGLITE_MODULE_PATH: nonexistentModule,
            [name]: name === 'DATABASE_URL' ? exact : 'fixture-only',
        });
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('PGlite refuses stray PostgreSQL configuration');
        expect(result.stderr).not.toContain('ERR_MODULE_NOT_FOUND');
    });
    it('requires explicit disposable opt-in even with the exact local URL', () => {
        const result = invoke({ DATABASE_URL: exact, PG_MODULE_PATH: nonexistentModule });
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('opted-in local disposable PostgreSQL required');
    });
});
