import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
assert.equal(process.platform, 'linux');
assert.equal(process.env.THALASSA_DISPOSABLE_PI9_TEST, '1');
const row = fs
    .readFileSync('/proc/self/cgroup', 'utf8')
    .trim()
    .split('\n')
    .find((s) => s.startsWith('0::'));
assert.ok(row);
const root = '/sys/fs/cgroup',
    own = path.resolve(root, '.' + row.slice(3));
assert.ok(own.startsWith(root + '/'));
const kernel = (name) => fs.readFileSync(path.join(own, name), 'utf8').trim();
const limits = {
    memoryMax: kernel('memory.max'),
    swapMax: kernel('memory.swap.max'),
    tasksMax: kernel('pids.max'),
    cpuMax: kernel('cpu.max'),
};
assert.equal(limits.memoryMax, '536870912');
assert.equal(limits.swapMax, '0');
assert.equal(limits.tasksMax, '96');
const cpu = /^(\d+) (\d+)$/.exec(limits.cpuMax);
assert.ok(cpu && Number(cpu[1]) === Number(cpu[2]) && Number(cpu[1]) > 0);
process.stdout.write('ACTUAL_CGROUP ' + JSON.stringify(limits) + '\n');
const child = spawnSync(
    process.execPath,
    [
        '--test',
        '--test-reporter=tap',
        'scripts/released-source141.test.mjs',
        'scripts/update9.test.mjs',
        'scripts/update8.test.mjs',
    ],
    { encoding: 'utf8', timeout: 100000, maxBuffer: 2 * 1024 ** 2, env: process.env },
);
process.stdout.write(child.stdout ?? '');
process.stderr.write(child.stderr ?? '');
assert.equal(child.error, undefined);
assert.equal(child.signal, null);
assert.equal(child.status, 0);
assert.match(child.stdout, /# tests 22\b/);
assert.match(child.stdout, /# fail 0\b/);
assert.match(child.stdout, /# skipped 0\b/);
process.stdout.write(
    JSON.stringify({
        schema: 1,
        tests: 22,
        failures: 0,
        skips: 0,
        limits,
        memoryPeakBytes: kernel('memory.peak'),
        releaseAuthority: 'Synthetic archive/plan and pre-release refusal only; no actual master/build-branch staging',
        installerApply: false,
        hardware: false,
    }) + '\n',
);
