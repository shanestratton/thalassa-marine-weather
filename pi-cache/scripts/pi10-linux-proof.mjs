import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { bundleFixture } from './update10Fixture.mjs';
import { verifyBundle } from './update10.mjs';
import { readCabinAssets, verifyCabinArchiveInventory, verifyCabinFiles } from './cabin-package.mjs';

// Disposable Linux proof only. It cannot invoke an installer with --apply or reach a boat Pi.
assert.equal(process.env.THALASSA_DISPOSABLE_PI10_TEST, '1');
assert.equal(process.platform, 'linux');
const repository = fileURLToPath(new URL('../..', import.meta.url));
const unified = fs
    .readFileSync('/proc/self/cgroup', 'utf8')
    .trim()
    .split('\n')
    .find((line) => line.startsWith('0::'));
assert.ok(unified, 'A real unified cgroup must be observable inside the proof process');
const cgroupRoot = '/sys/fs/cgroup',
    cgroup = path.resolve(cgroupRoot, '.' + unified.slice(3));
assert.ok(cgroup.startsWith(cgroupRoot + '/'), 'Own cgroup path must remain within the kernel mount');
const kernel = (name) => fs.readFileSync(path.join(cgroup, name), 'utf8').trim();
const limits = {
    memoryMax: kernel('memory.max'),
    swapMax: kernel('memory.swap.max'),
    tasksMax: kernel('pids.max'),
    cpuMax: kernel('cpu.max'),
};
assert.equal(limits.memoryMax, '1073741824');
assert.equal(limits.swapMax, '0');
assert.equal(limits.tasksMax, '96');
const cpu = /^(\d+) (\d+)$/.exec(limits.cpuMax);
assert.ok(cpu && Number(cpu[1]) === Number(cpu[2]) && Number(cpu[1]) > 0);
process.stdout.write('ACTUAL_CGROUP ' + JSON.stringify(limits) + '\n');
const run = (command, args, timeout = 130000) => {
    const result = spawnSync(command, args, {
        cwd: path.join(repository, 'pi-cache'),
        encoding: 'utf8',
        timeout,
        maxBuffer: 2 * 1024 ** 2,
        env: process.env,
    });
    process.stdout.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
    assert.equal(result.error, undefined, 'Proof child must not time out or exceed its output bound');
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, 'Every genuine child process must exit zero');
    return result.stdout;
};
const staging = run(process.execPath, [
    '--test',
    'scripts/released-source.test.mjs',
    'scripts/cabin-package.test.mjs',
    'scripts/update10.test.mjs',
    'scripts/update8.test.mjs',
]);
assert.match(staging, /# tests 27\b/);
assert.match(staging, /# fail 0\b/);
assert.match(staging, /# skipped 0\b/);
const cabin = run(process.execPath, [
    '--import',
    'tsx',
    '--test',
    'src/readAuthorityGeneration.test.mts',
    ...fs
        .readdirSync(path.join(repository, 'pi-cache/src/cabin'))
        .filter((name) => name.endsWith('.test.mts'))
        .map((name) => `src/cabin/${name}`),
    'src/piCommandLock.test.mts',
]);
assert.match(cabin, /# tests 38\b/);
assert.match(cabin, /# fail 0\b/);
assert.match(cabin, /# skipped 0\b/);
const native = run(process.execPath, ['--import', 'tsx', 'scripts/cabin-native142-proof.mts']);
assert.match(native, /"checks":20,"failures":0,"skips":0/);
const ais = run(process.execPath, [
    '--import',
    'tsx',
    '--test',
    ...fs
        .readdirSync(path.join(repository, 'pi-cache/src/internetAis'))
        .filter((name) => name.endsWith('.test.mts'))
        .map((name) => `src/internetAis/${name}`),
]);
assert.match(ais, /# tests 16\b/);
assert.match(ais, /# fail 0\b/);
assert.match(ais, /# skipped 0\b/);
const actualDirectory = process.env.CABIN_PROOF_DIR;
assert.ok(actualDirectory && path.isAbsolute(actualDirectory));
const actualAssets = readCabinAssets(actualDirectory);
const fixture = bundleFixture({ cabinDirectory: actualDirectory });
try {
    const manifest = verifyBundle(fixture.output);
    assert.deepEqual(manifest.cabinAssets, actualAssets);
    const entries = run('tar', ['-tzf', path.join(fixture.output, 'cabin.tar.gz')])
        .trim()
        .split('\n');
    const details = run('tar', ['-tvzf', path.join(fixture.output, 'cabin.tar.gz')])
        .trim()
        .split('\n');
    verifyCabinArchiveInventory(entries, details, actualAssets);
    const extracted = path.join(fixture.root, 'actual-unpack');
    fs.mkdirSync(extracted);
    run('tar', [
        '-xzf',
        path.join(fixture.output, 'cabin.tar.gz'),
        '--directory',
        extracted,
        '--no-same-owner',
        '--no-same-permissions',
    ]);
    verifyCabinFiles(path.join(extracted, 'cabin-dist'), actualAssets);
    const plan = JSON.parse(run(process.execPath, [path.join(fixture.output, 'install.mjs')]));
    assert.match(plan.mode, /PLAN ONLY/);
    assert.equal(plan.manifest.update, 10);
    assert.match(run('sh', [path.join(fixture.output, 'rollback.sh')]), /PLAN ONLY/);
} finally {
    fixture.close();
}
process.stdout.write(
    JSON.stringify({
        schema: 1,
        tests: 81,
        sqliteChecks: 20,
        failures: 0,
        skips: 0,
        limits,
        memoryPeakBytes: kernel('memory.peak'),
        cabinAssets: actualAssets,
        releaseAuthority: 'Synthetic archive/plan only; real master/build-branch staging deliberately held',
        apply: false,
        hardware: false,
    }) + '\n',
);
