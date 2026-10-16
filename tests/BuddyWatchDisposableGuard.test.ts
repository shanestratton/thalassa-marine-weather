import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'thalassa-buddy-guard-'));
const modulePath = join(root, 'fake-pg.mjs');
// This module has no socket/HTTP dependency. If URL validation lets an unsafe
// target reach the driver, its load marker makes the regression fail.
writeFileSync(
    modulePath,
    `import {appendFileSync} from 'node:fs';
const log=(value)=>appendFileSync(process.env.BUDDY_GUARD_LOG,value+'\\n');log('loaded');
export class Pool {
 async connect(){log('connected');return{release(){log('released')},async query(sql){
  log(sql);
  if(sql.includes('current_database'))return{rows:[{name:process.env.BUDDY_GUARD_DATABASE||'buddy137_test'}]};
  if(sql==='SHOW server_version')return{rows:[{server_version:process.env.BUDDY_GUARD_VERSION||'17.6'}]};
  if(sql.includes('FROM pg_tables'))return{rows:[{n:Number(process.env.BUDDY_GUARD_TABLES||0)}]};
  throw Error('fixture DDL must not run');
 }}}async end(){log('closed')}
}`,
);
afterAll(() => {
    for (const name of readdirSync(root)) unlinkSync(join(root, name));
    rmdirSync(root);
});

const fixture = 'postgres://postgres:fixture-only-password@127.0.0.1:5432/buddy137_test';
let sequence = 0;
function run(extra: Record<string, string | undefined>) {
    const log = join(root, `attempt-${++sequence}.log`);
    const env = {
        ...process.env,
        THALASSA_DISPOSABLE_BUDDY_TEST: '1',
        BUDDY_TEST_DATABASE_URL: fixture,
        PG_MODULE_PATH: modulePath,
        PGLITE_MODULE_PATH: undefined,
        BUDDY_GUARD_DATABASE: undefined,
        BUDDY_GUARD_VERSION: undefined,
        BUDDY_GUARD_TABLES: undefined,
        ...extra,
        BUDDY_GUARD_LOG: log,
    };
    const result = spawnSync(process.execPath, ['supabase/tests/buddy-watch-db.mjs'], {
        env,
        encoding: 'utf8',
        timeout: 5000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    return { stderr: result.stderr, log: existsSync(log) ? readFileSync(log, 'utf8') : '' };
}
describe('buddy proof is confined to its explicit disposable database', () => {
    for (const url of [
        fixture.replace('127.0.0.1', 'example.test'),
        fixture.replace(':5432/', ':5433/'),
        fixture.replace(':5432/', '/'),
        fixture.replace('postgres:', 'https:'),
        fixture.replace('postgres:fixture-only-password', 'other:fixture-only-password'),
        fixture.replace('fixture-only-password', 'other'),
        fixture.replace('buddy137_test', 'other'),
        `${fixture}?host=example.test`,
        `${fixture}?options=-csearch_path=public`,
        `${fixture}#fragment`,
    ])
        it(`refuses ${url.replace(/\/\/[^@]+@/, '//<fixture>@')} before loading a database driver`, () => {
            const result = run({ BUDDY_TEST_DATABASE_URL: url });
            expect(result.stderr).toContain('Only an explicit empty localhost buddy137_test database is allowed');
            expect(result.log).toBe('');
        });
    for (const extra of [
        { BUDDY_GUARD_DATABASE: 'other' },
        { BUDDY_GUARD_VERSION: '17.7' },
        { BUDDY_GUARD_TABLES: '1' },
    ])
        it(`checks live database identity/version/emptiness before DDL: ${JSON.stringify(extra)}`, () => {
            const result = run(extra);
            expect(result.stderr).toContain('Refusing a nonempty or different PostgreSQL fixture');
            expect(result.log).toContain('connected');
            expect(result.log).toContain('closed');
            expect(result.log).not.toMatch(/CREATE|ALTER|INSERT/);
        });
    for (const extra of [
        { PG_MODULE_PATH: modulePath, BUDDY_TEST_DATABASE_URL: undefined },
        { PG_MODULE_PATH: undefined, BUDDY_TEST_DATABASE_URL: fixture },
    ])
        it(`refuses conflicting PostgreSQL variables in PGlite mode: ${Object.keys(extra).join(',')}`, () => {
            const result = run({ THALASSA_DISPOSABLE_BUDDY_TEST: undefined, PGLITE_MODULE_PATH: modulePath, ...extra });
            expect(result.stderr).toContain(
                'Explicit isolated PGlite or opted-in disposable PostgreSQL fixture required',
            );
            expect(result.log).toBe('');
        });
});
