/** Compile the exact successful simulator sources for physical iOS, unsigned.
 * Uses existing cached provider code, NOT a fresh Rust build or phone execution.
 * node deviceCompile.mjs NATIVE_CACHE SUCCESSFUL_EXCHANGE_RECEIPT
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, mkdtempSync, readFileSync, realpathSync, statfsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const [cacheArg, receiptArg, ...extra] = process.argv.slice(2);
assert(cacheArg && receiptArg && !extra.length && process.platform === 'darwin' && process.arch === 'arm64');
assert(!lstatSync(cacheArg).isSymbolicLink() && !lstatSync(receiptArg).isSymbolicLink());
const cache = realpathSync(cacheArg),
    sourceReceipt = realpathSync(receiptArg);
assert(lstatSync(sourceReceipt).isFile() && lstatSync(sourceReceipt).size < 64 * 1024);
const prior = JSON.parse(readFileSync(sourceReceipt, 'utf8'));
assert(prior.status === 'passed' && prior.disposableSimulatorRemoved === true && prior.fixtureAuth === true);
assert(prior.completedPhases?.length === 9 && prior.nativeAccountDirectoryFixtureAssertions > 0);
const experiment = fileURLToPath(new URL('../', import.meta.url));
const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const pin = JSON.parse(readFileSync(join(experiment, 'vodozemac-native-pin.json'), 'utf8'));
assert(pin.shippingApproved === false && pin.protocol === 'olm-v1');
assert.equal(hash(join(experiment, 'vodozemac-native/Cargo.toml')), pin.manifestSha256);
assert.equal(hash(join(experiment, 'vodozemac-native/Cargo.lock')), pin.lockfileSha256);
const sources = Object.keys(prior.sourceHashes);
assert(sources.length >= 16 && sources.length <= 30);
for (const path of sources) {
    assert(!lstatSync(path).isSymbolicLink() && lstatSync(path).isFile());
    const actual = realpathSync(path);
    assert(actual.startsWith(experiment) || actual.startsWith(join(cache, 'bindings') + '/'));
    assert(path.endsWith('.swift'));
    assert.equal(hash(path), prior.sourceHashes[path], 'Compile exactly the simulator-tested sources');
}
const map = Object.keys(prior.cacheHashes).filter((path) => path.endsWith('.modulemap'));
assert(map.length === 1 && realpathSync(map[0]).startsWith(join(cache, 'bindings') + '/'));
for (const [path, expected] of Object.entries(prior.cacheHashes)) {
    assert(!lstatSync(path).isSymbolicLink() && realpathSync(path).startsWith(cache + '/'));
    assert.equal(hash(path), expected);
}
const provider = join(cache, 'target/aarch64-apple-ios/debug/libthalassa_vodozemac_native.a');
assert(!lstatSync(provider).isSymbolicLink() && lstatSync(provider).isFile());
const providerHash = hash(provider);
const scratch = mkdtempSync(join(tmpdir(), 'thalassa-e2ee-device-compile-'));
assert(statfsSync(scratch).bavail * statfsSync(scratch).bsize > 3 * 1024 ** 3);
process.title = 'thalassa device compile waiting';
let announced = false;
for (;;) {
    const check = spawnSync('/usr/bin/pgrep', ['-fl', 'vite build|tsc|vitest'], { encoding: 'utf8' });
    assert(!check.error && [0, 1].includes(check.status));
    const others = check.stdout
        .trim()
        .split('\n')
        .filter(
            (line) =>
                /^\d+\s/.test(line) &&
                !line.startsWith(`${process.pid} `) &&
                !/^\d+\s+(?:\/\S*\/)?(?:sh|bash|zsh|fish|tail|grep|rg|pgrep)\s/.test(line),
        );
    if (!others.length) break;
    if (!announced) console.info('Waiting for shared build slot.');
    announced = true;
    await delay(5000);
}
process.title = 'vite build slot: isolated E2EE physical-target compilation';
const result = {
    status: 'running',
    physicalDeviceExecution: false,
    signedOrInstalled: false,
    freshRustBuild: false,
    independentlyVerifiedCachedProvenance: false,
    codeSignatureCheckedAbsent: false,
    sourceReceiptSha256: hash(sourceReceipt),
    sourceHashes: prior.sourceHashes,
    providerSha256: providerHash,
    sourceReceipt,
    artifact: join(scratch, 'NativeExchange-device-unsigned'),
};
const output = join(scratch, 'compile.json');
const save = () => writeFileSync(output, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
save();
console.info(`Nonsecret physical-target compile receipt: ${output}`);
try {
    const sdk = spawnSync('/usr/bin/xcrun', ['--sdk', 'iphoneos', '--show-sdk-path'], {
        encoding: 'utf8',
        timeout: 30000,
    });
    assert(!sdk.error && sdk.status === 0);
    const compiled = spawnSync(
        '/usr/bin/xcrun',
        [
            '--sdk',
            'iphoneos',
            'swiftc',
            '-swift-version',
            '5',
            '-j',
            '1',
            '-num-threads',
            '1',
            '-parse-as-library',
            '-target',
            'arm64-apple-ios17.0',
            '-sdk',
            sdk.stdout.trim(),
            '-module-cache-path',
            join(scratch, 'modules'),
            '-I',
            join(cache, 'bindings'),
            '-Xcc',
            `-fmodule-map-file=${map[0]}`,
            provider,
            '-lsqlite3',
            '-framework',
            'Security',
            '-Xlinker',
            '-no_adhoc_codesign',
            '-o',
            result.artifact,
            ...sources,
        ],
        { stdio: 'inherit', timeout: 300000 },
    );
    assert(!compiled.error && compiled.status === 0, 'Physical target compilation failed');
    const platform = spawnSync('/usr/bin/xcrun', ['vtool', '-show-build', result.artifact], {
        encoding: 'utf8',
        timeout: 30000,
    });
    assert(!platform.error && platform.status === 0 && /platform\s+IOS\s/.test(platform.stdout));
    const signature = spawnSync('/usr/bin/codesign', ['-dv', '--verbose=4', result.artifact], {
        encoding: 'utf8',
        timeout: 30000,
    });
    assert(!signature.error && signature.status !== 0 && /code object is not signed at all/.test(signature.stderr));
    result.codeSignatureCheckedAbsent = true;
    for (const path of sources) assert.equal(hash(path), prior.sourceHashes[path]);
    for (const [path, expected] of Object.entries(prior.cacheHashes)) assert.equal(hash(path), expected);
    assert.equal(hash(provider), providerHash);
    result.status = 'passed';
    result.artifactSha256 = hash(result.artifact);
    console.info(
        'PASS exact simulator-tested sources compile/link for physical iOS. NOT signed, installed or executed.',
    );
} catch (error) {
    result.status = 'failed';
    throw error;
} finally {
    save();
}
