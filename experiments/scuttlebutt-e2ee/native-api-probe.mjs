/** Network-free serial iOS-simulator API/link probe; never modifies the app.
 * node native-api-probe.mjs SOURCE PREBUILD_ARCHIVE [ALREADY_BOOTED_SIMULATOR_UDID]
 * No implicit downloads, simulator boots, pod install, or app key storage.
 */
import { spawnSync } from 'node:child_process';
import { createReadStream, mkdtempSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const pin = JSON.parse(readFileSync(join(here, 'libsignal-pin.json'), 'utf8'));

function run(command, args, options = {}) {
    const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, ...options });
    if (result.error || result.status !== 0) {
        if (result.stderr) process.stderr.write(result.stderr);
        throw new Error(`${command} failed; no encryption capability is approved`);
    }
    return result.stdout.trim();
}

async function main() {
    const [sourceArg, archiveArg, simulator] = process.argv.slice(2);
    if (!sourceArg || !archiveArg || process.argv.length > 5) {
        throw new Error('Usage: node native-api-probe.mjs SOURCE ARCHIVE [BOOTED_SIMULATOR_UDID]');
    }
    if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Requires an Apple Silicon Mac');
    const source = realpathSync(sourceArg);
    const archive = realpathSync(archiveArg);
    if (run('git', ['rev-parse', 'HEAD'], { cwd: source }) !== pin.sourceCommit) throw new Error('Source pin mismatch');
    if (run('git', ['status', '--porcelain', '--untracked-files=all', '--', 'swift/Sources'], { cwd: source })) {
        throw new Error('Swift source checkout must be clean, including untracked headers/sources');
    }
    const digest = createHash('sha256');
    for await (const chunk of createReadStream(archive)) digest.update(chunk);
    if (digest.digest('hex') !== pin.prebuildSha256) throw new Error('Prebuild checksum mismatch');
    if (simulator) {
        const devices = JSON.parse(run('xcrun', ['simctl', 'list', 'devices', 'booted', '-j']));
        if (
            !Object.values(devices.devices)
                .flat()
                .some((device) => device.udid === simulator && device.state === 'Booted')
        ) {
            throw new Error('Requested simulator is not already booted; this script will not boot one');
        }
    }
    const scratch = mkdtempSync(join(tmpdir(), 'thalassa-native-e2ee-'));
    mkdirSync(join(scratch, 'modules'));
    console.log(`Isolated build artifacts: ${scratch}`);
    const binaryPath = 'target/aarch64-apple-ios-sim/release/libsignal_ffi.a';
    run('tar', ['-xzf', archive, '-C', scratch, binaryPath]);
    const sdk = run('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-path']);
    const sources = run('git', ['ls-tree', '-r', '--name-only', 'HEAD', '--', 'swift/Sources/LibSignalClient'], {
        cwd: source,
    })
        .split('\n')
        .filter((path) => path.endsWith('.swift'))
        .map((path) => join(source, path));
    if (!sources.length) throw new Error('No pinned Swift sources found');
    const ffi = join(source, 'swift/Sources/SignalFfi');
    const baseArgs = [
        '--sdk',
        'iphonesimulator',
        'swiftc',
        '-swift-version',
        '5',
        '-j',
        '1',
        '-num-threads',
        '1',
        '-target',
        'arm64-apple-ios17.0-simulator',
        '-sdk',
        sdk,
        '-module-cache-path',
        join(scratch, 'modules'),
        '-I',
        ffi,
    ];
    console.log('Compiling pinned Swift API with one worker (no Cargo or app build)');
    run('xcrun', [
        ...baseArgs,
        '-emit-library',
        '-emit-module',
        '-module-name',
        'LibSignalClient',
        '-emit-module-path',
        join(scratch, 'LibSignalClient.swiftmodule'),
        '-L',
        join(scratch, 'target/aarch64-apple-ios-sim/release'),
        '-lsignal_ffi',
        '-lc++',
        '-framework',
        'Security',
        '-framework',
        'SystemConfiguration',
        '-Xlinker',
        '-install_name',
        '-Xlinker',
        '@rpath/libLibSignalClient.dylib',
        '-o',
        join(scratch, 'libLibSignalClient.dylib'),
        ...sources,
    ]);
    run('xcrun', [
        ...baseArgs,
        '-parse-as-library',
        '-I',
        scratch,
        '-L',
        scratch,
        '-lLibSignalClient',
        '-Xlinker',
        '-rpath',
        '-Xlinker',
        '@executable_path',
        '-o',
        join(scratch, 'NativeApiProbe'),
        join(here, 'NativeApiProbe.swift'),
    ]);
    console.log('PASS Swift iOS-simulator API compilation and native linking');
    if (simulator) console.log(run('xcrun', ['simctl', 'spawn', simulator, join(scratch, 'NativeApiProbe')]));
    else console.log('NOT RUN: no booted simulator requested. Compilation does not prove message exchange.');
}
main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
});
