/** Isolated native URLSession fixture proof. No Rust, app edits, downloads,
 * simulator/phone install, trust override or live credentials. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

assert.equal(process.platform, 'darwin');
assert.equal(process.arch, 'arm64');
const here = dirname(fileURLToPath(import.meta.url));
const sources = ['VodozemacRelayTransport.swift', 'VodozemacRelayTransportProbe.swift'].map((name) =>
    join(here, '..', name),
);
process.title = 'thalassa native transport waiting';
let announced = false;
for (;;) {
    const check = spawnSync('/usr/bin/pgrep', ['-fl', 'vite build|tsc|vitest'], { encoding: 'utf8' });
    assert(!check.error && [0, 1].includes(check.status), 'Cannot assume a free shared build slot');
    const others = check.stdout
        .trim()
        .split('\n')
        .filter(
            (line) =>
                line &&
                Number(line.split(' ')[0]) !== process.pid &&
                !/^\d+\s+(?:\/\S*\/)?(?:sh|bash|zsh|fish|tail|grep|rg|pgrep)\s/.test(line),
        );
    if (!others.length) break;
    if (!announced) console.log('Waiting for the shared Mac build slot (native network fixture proof).');
    announced = true;
    await delay(5000);
}
process.title = 'vite build slot: isolated native transport proof';
const scratch = mkdtempSync(join(tmpdir(), 'thalassa-native-network-'));
const run = (args, timeout = 120000) => {
    const result = spawnSync('/usr/bin/xcrun', args, { encoding: 'utf8', timeout, maxBuffer: 1024 * 1024 });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    assert(!result.error && result.status === 0, 'Native network research command failed; no app changes');
    return result.stdout.trim();
};
const executable = join(scratch, 'transport-probe');
run([
    '--sdk',
    'macosx',
    'swiftc',
    '-swift-version',
    '5',
    '-j',
    '1',
    '-num-threads',
    '1',
    '-module-cache-path',
    join(scratch, 'modules'),
    '-parse-as-library',
    ...sources,
    '-o',
    executable,
]);
const probe = spawnSync(executable, [], { encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 });
if (probe.stdout) process.stdout.write(probe.stdout);
if (probe.stderr) process.stderr.write(probe.stderr);
assert(!probe.error && probe.status === 0, 'Host URLSession fixture proof did not pass');
for (const [sdk, target] of [
    ['iphonesimulator', 'arm64-apple-ios17.0-simulator'],
    ['iphoneos', 'arm64-apple-ios17.0'],
]) {
    const sdkPath = run(['--sdk', sdk, '--show-sdk-path']);
    const output = join(scratch, sdk);
    run([
        '--sdk',
        sdk,
        'swiftc',
        '-swift-version',
        '5',
        '-j',
        '1',
        '-num-threads',
        '1',
        '-module-cache-path',
        join(scratch, 'modules'),
        '-parse-as-library',
        '-sdk',
        sdkPath,
        '-target',
        target,
        ...sources,
        '-o',
        output,
    ]);
    const buildInfo = run(['vtool', '-show-build', output]);
    assert(
        buildInfo.includes(`platform ${sdk === 'iphoneos' ? 'IOS\n' : 'IOSSIMULATOR\n'}`),
        'Verify the actual Mach-O target platform',
    );
    console.log(`PASS ${sdk} native transport compilation/linking; NOT physical/simulator execution`);
}
console.log(`Native network fixture artifacts retained: ${scratch}`);
