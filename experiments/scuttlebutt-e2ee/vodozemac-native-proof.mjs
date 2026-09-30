/** Isolated native proof. No app edits, automatic downloads or simulator boot.
 * node vodozemac-native-proof.mjs CARGO CARGO_HOME SCRATCH [BOOTED_SIMULATOR_UDID]
 * Set matching isolated RUSTUP_HOME. SCRATCH must be an existing temporary dir.
 * This runner reserves the shared heavy-build slot, compiles serially and never
 * touches a real phone, Thalassa Keychain namespace, Supabase or app project.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
    existsSync,
    lstatSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    realpathSync,
    statfsSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const crate = join(here, 'vodozemac-native');
const [cargo, cacheArg, scratchArg, simulator, ...extra] = process.argv.slice(2);
assert(cargo && cacheArg && scratchArg && !extra.length, 'Provide CARGO CARGO_HOME SCRATCH [BOOTED_SIMULATOR]');
assert([cargo, cacheArg, scratchArg].every(isAbsolute), 'Absolute paths required');
assert(process.platform === 'darwin' && process.arch === 'arm64', 'Apple Silicon research runner only');
const cache = realpathSync(cacheArg);
const scratch = realpathSync(scratchArg);
assert(
    scratch.startsWith('/private/tmp/') || scratch.startsWith(realpathSync(tmpdir()) + '/'),
    'Artifacts must stay in a temporary directory',
);
// Reusing a build cache must never redirect writes through a child symlink.
function checkOutputTree(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        assert(entry.isFile() || entry.isDirectory(), 'Research output tree contains a link or special file');
        if (entry.isDirectory()) checkOutputTree(join(directory, entry.name));
    }
}
checkOutputTree(scratch);
assert(statfsSync(scratch).bavail * statfsSync(scratch).bsize > 3 * 1024 ** 3, 'Keep at least 3 GiB free');
const env = {
    ...process.env,
    CARGO_HOME: cache,
    CARGO_TARGET_DIR: join(scratch, 'target'),
    CARGO_BUILD_JOBS: '1',
    CARGO_INCREMENTAL: '0',
    CARGO_NET_OFFLINE: 'true',
    IPHONEOS_DEPLOYMENT_TARGET: '17.0',
    PATH: `${dirname(cargo)}:${process.env.PATH ?? '/usr/bin:/bin'}`,
};
const digest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const lockDigest = digest(join(crate, 'Cargo.lock'));
const nativePin = JSON.parse(readFileSync(join(here, 'vodozemac-native-pin.json'), 'utf8'));
assert.equal(nativePin.shippingApproved, false, 'A research runner cannot approve shipping');
assert.equal(digest(join(crate, 'Cargo.toml')), nativePin.manifestSha256, 'Review and repin changed manifest');
assert.equal(lockDigest, nativePin.lockfileSha256, 'Review and repin changed dependency lock');

function run(command, args, { capture = false, timeout = 600_000, ...options } = {}) {
    const result = spawnSync(command, args, {
        cwd: crate,
        env,
        encoding: 'utf8',
        maxBuffer: 8 * 1024 * 1024,
        timeout,
        stdio: capture ? 'pipe' : 'inherit',
        ...options,
    });
    if (result.error || result.status !== 0) {
        if (capture && result.stderr) process.stderr.write(result.stderr);
        const outcome = result.error?.code === 'ETIMEDOUT' ? 'timed out; execution outcome unknown' : 'failed';
        throw new Error(`Research command ${outcome}: ${command.split('/').pop()} (no production changes)`);
    }
    return result.stdout?.trim() ?? '';
}

async function buildSlot() {
    let announced = false;
    for (;;) {
        const check = spawnSync('/usr/bin/pgrep', ['-fl', 'vite build|tsc|vitest'], { encoding: 'utf8' });
        assert(
            !check.error && (check.status === 0 || check.status === 1),
            'Process enumeration failed; cannot assume build slot is free',
        );
        const others = check.stdout
            .trim()
            .split('\n')
            .filter((line) => {
                if (!line || Number(line.split(' ')[0]) === process.pid) return false;
                // A shell's command text can mention the guard regex while it is
                // merely waiting. Actual node/npm/compiler children match separately.
                // Counting guard-only shells creates a mutual-wait deadlock.
                return !/^\d+\s+(?:\/\S*\/)?(?:sh|bash|zsh|fish)\s/.test(line);
            });
        if (!others.length) break;
        // Yield our reservation while waiting so the other builder can finish.
        process.title = 'thalassa native research waiting';
        if (!announced) console.log('Waiting for the shared Mac build slot.');
        announced = true;
        await new Promise((resolve) => setTimeout(resolve, 10_000));
    }
    // Visible to Claude's agreed pgrep pattern for this serial native build.
    process.title = 'vite build slot: isolated E2EE native proof';
}

await buildSlot();
const metadata = JSON.parse(
    run(cargo, ['metadata', '--locked', '--offline', '--format-version', '1', '--features', 'tooling'], {
        capture: true,
    }),
);
const provider = metadata.packages.filter((pkg) => pkg.name === 'vodozemac');
assert.equal(provider.length, 1);
assert.equal(provider[0].version, nativePin.version);
assert.equal(provider[0].license, 'Apache-2.0');
assert.deepEqual(metadata.resolve.nodes.find((node) => node.id === provider[0].id).features, []);
for (const pkg of metadata.packages.filter((pkg) => pkg.name === 'uniffi' || pkg.name.startsWith('uniffi_'))) {
    assert.equal(pkg.version, nativePin.uniffiVersion, 'Generator and runtime versions must match');
}
const providerPin = JSON.parse(readFileSync(join(here, 'vodozemac-pin.json'), 'utf8'));
const providerSource = dirname(provider[0].manifest_path);
const archive = join(cache, 'registry/cache', dirname(providerSource).split('/').pop(), 'vodozemac-0.11.0.crate');
assert.equal(digest(archive), providerPin.crateSha256);
assert.equal(
    JSON.parse(readFileSync(join(providerSource, '.cargo_vcs_info.json'), 'utf8')).git.sha1,
    providerPin.sourceCommit,
);
const pinnedSource = join(scratch, 'verified-provider');
mkdirSync(pinnedSource, { recursive: true });
run('/usr/bin/tar', ['-xzf', archive, '-C', pinnedSource]);
// Reject modified cached provider source before compiling it.
function verifyTree(original, cached) {
    const names = readdirSync(original, { withFileTypes: true });
    assert.deepEqual(
        names.map((n) => n.name).sort(),
        readdirSync(cached)
            .filter((n) => n !== '.cargo-ok')
            .sort(),
    );
    for (const entry of names) {
        assert(entry.isDirectory() || entry.isFile(), 'No provider source links');
        const a = join(original, entry.name),
            b = join(cached, entry.name);
        assert(!lstatSync(b).isSymbolicLink(), 'No cached provider source links');
        if (entry.isDirectory()) verifyTree(a, b);
        else assert.equal(digest(a), digest(b), 'Provider source hash mismatch');
    }
}
verifyTree(join(pinnedSource, 'vodozemac-0.11.0'), providerSource);
console.log('Pinned unchanged Olm v1; generated UniFFI boundary; synthetic research only.');

await buildSlot();
run(cargo, ['test', '--locked', '--offline', '--jobs', '1', '--tests', '--', '--test-threads=1']);
await buildSlot();
run(cargo, ['build', '--locked', '--offline', '--jobs', '1', '--features', 'tooling']);
const bindings = join(scratch, 'bindings');
mkdirSync(bindings, { recursive: true });
run(join(scratch, 'target/debug/uniffi-bindgen'), [
    'generate',
    '--library',
    join(scratch, 'target/debug/libthalassa_vodozemac_native.dylib'),
    '--language',
    'swift',
    '--out-dir',
    bindings,
]);
// Only library/runtime features on iOS, never the host binding generator.
for (const target of ['aarch64-apple-ios-sim', 'aarch64-apple-ios']) {
    await buildSlot();
    run(cargo, ['build', '--locked', '--offline', '--jobs', '1', '--lib', '--target', target]);
}

const swiftBindings = readdirSync(bindings).filter((name) => name.endsWith('.swift'));
const moduleMaps = readdirSync(bindings).filter((name) => name.endsWith('.modulemap'));
assert.equal(swiftBindings.length, 1);
assert.equal(moduleMaps.length, 1);
const bundle = `app.thalassa.research.vodozemac.${randomUUID().toLowerCase()}`;
const app = join(scratch, 'NativeResearch.app');
mkdirSync(app, { recursive: true });
mkdirSync(join(scratch, 'swift-modules'), { recursive: true });
// Match Xcode simulator packaging: simulated iOS entitlements are embedded
// sections, not restricted entitlements in the host macOS code signature.
// This does not sign/provision a physical phone or relax Keychain policy.
const entitlements = join(scratch, 'research.simulated.xcent');
const derEntitlements = entitlements + '.der';
writeFileSync(
    entitlements,
    `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>application-identifier</key><string>RESEARCH00.${bundle}</string><key>keychain-access-groups</key><array><string>RESEARCH00.${bundle}</string></array></dict></plist>`,
);
run('xcrun', ['derq', 'query', '-f', 'xml', '-i', entitlements, '-o', derEntitlements, '--raw']);
const sources = [
    join(bindings, swiftBindings[0]),
    ...[
        'VodozemacSealedStore.swift',
        'VodozemacSealedStoreProbe.swift',
        'VodozemacDmFrame.swift',
        'VodozemacDmFrameProbe.swift',
        'VodozemacDmCoordinator.swift',
        'VodozemacDmCoordinatorProbe.swift',
        'VodozemacDmRestartProbe.swift',
        'VodozemacNativeProbe.swift',
    ].map((name) => join(here, name)),
];
for (const [sdkName, target, rustTarget, output] of [
    ['iphonesimulator', 'arm64-apple-ios17.0-simulator', 'aarch64-apple-ios-sim', join(app, 'NativeResearch')],
    ['iphoneos', 'arm64-apple-ios17.0', 'aarch64-apple-ios', join(scratch, 'NativeResearch-device-unsigned')],
]) {
    await buildSlot();
    const sdk = run('xcrun', ['--sdk', sdkName, '--show-sdk-path'], { capture: true });
    run('xcrun', [
        '--sdk',
        sdkName,
        'swiftc',
        '-swift-version',
        '5',
        '-j',
        '1',
        '-num-threads',
        '1',
        '-parse-as-library',
        '-target',
        target,
        '-sdk',
        sdk,
        '-module-cache-path',
        join(scratch, 'swift-modules'),
        '-I',
        bindings,
        '-Xcc',
        `-fmodule-map-file=${join(bindings, moduleMaps[0])}`,
        ...(sdkName === 'iphonesimulator'
            ? [
                  '-Xlinker',
                  '-sectcreate',
                  '-Xlinker',
                  '__TEXT',
                  '-Xlinker',
                  '__entitlements',
                  '-Xlinker',
                  entitlements,
                  '-Xlinker',
                  '-sectcreate',
                  '-Xlinker',
                  '__TEXT',
                  '-Xlinker',
                  '__ents_der',
                  '-Xlinker',
                  derEntitlements,
              ]
            : []),
        join(scratch, 'target', rustTarget, 'debug/libthalassa_vodozemac_native.a'),
        '-lsqlite3',
        '-framework',
        'Security',
        '-o',
        output,
        ...sources,
    ]);
}
console.log('PASS simulator and physical-iPhone target compilation/linking (not physical device execution).');
writeFileSync(
    join(app, 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${bundle}</string><key>CFBundleExecutable</key><string>NativeResearch</string><key>CFBundleName</key><string>NativeResearch</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>1</string><key>MinimumOSVersion</key><string>17.0</string><key>LSRequiresIPhoneOS</key><true/><key>UIDeviceFamily</key><array><integer>1</integer></array><key>UILaunchScreen</key><dict/><key>UIApplicationSceneManifest</key><dict><key>UIApplicationSupportsMultipleScenes</key><false/><key>UISceneConfigurations</key><dict><key>UIWindowSceneSessionRoleApplication</key><array><dict><key>UISceneConfigurationName</key><string>Research</string><key>UISceneDelegateClassName</key><string>ThalassaNativeResearchScene</string></dict></array></dict></dict></dict></plist>`,
);
run('/usr/bin/codesign', ['--force', '--sign', '-', app]);
assert.equal(digest(join(crate, 'Cargo.lock')), lockDigest, 'Build must not alter dependency lock');
if (simulator) {
    const devices = JSON.parse(run('xcrun', ['simctl', 'list', 'devices', 'booted', '-j'], { capture: true }));
    assert(
        Object.values(devices.devices)
            .flat()
            .some((d) => d.udid === simulator && d.state === 'Booted'),
        'Only an explicitly selected booted simulator can run',
    );
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    const receiptPath = join(scratch, `run-${ids[0]}.json`);
    const receipt = {
        bundle,
        simulator,
        runID: ids[0],
        aliceID: ids[1],
        bobID: ids[2],
        phase: 'install',
        status: 'running',
        completedPhases: [],
        physicalDeviceProtectionVerified: false,
    };
    const saveReceipt = () => writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
    saveReceipt();
    console.log(`Nonsecret run/cleanup receipt: ${receiptPath}`);
    let cleaned = false;
    try {
        run('xcrun', ['simctl', 'install', simulator, app]);
        const container = run('xcrun', ['simctl', 'get_app_container', simulator, bundle, 'data'], { capture: true });
        assert(isAbsolute(container), 'Expected the exact installed research app container');
        const statusPath = join(container, 'Documents', `probe-status-${ids[0]}.json`);
        receipt.container = container;
        for (const phase of [
            'prepare',
            'receive',
            'reply',
            'verify',
            'replay',
            'cleanup',
            'dm-prepare',
            'dm-receive',
            'dm-reply',
            'dm-verify',
            'dm-replay',
            'dm-cleanup',
        ]) {
            receipt.phase = phase;
            receipt.observation = 'launch-outcome-unknown';
            delete receipt.pid;
            saveReceipt();
            const output = run(
                'xcrun',
                ['simctl', 'launch', '--terminate-running-process', simulator, bundle, '--probe', phase, ...ids],
                // A cold simulator can complete the launch after simctl's timeout.
                // Never retry prepare automatically or infer that keys were not made.
                { capture: true, timeout: 180_000 },
            );
            const pid = Number(output.match(/: (\d+)\s*$/)?.[1]);
            assert(Number.isSafeInteger(pid) && pid > 0, 'Missing research process ID');
            receipt.pid = pid;
            receipt.observation = 'awaiting-app-receipt';
            saveReceipt();
            const deadline = Date.now() + 60_000;
            let status;
            let lastStage;
            while (Date.now() < deadline) {
                if (existsSync(statusPath)) {
                    assert(!lstatSync(statusPath).isSymbolicLink(), 'Refuse redirected status receipt');
                    const candidate = JSON.parse(readFileSync(statusPath, 'utf8'));
                    if (candidate.runID === ids[0] && candidate.phase === phase && candidate.pid === pid)
                        status = candidate;
                    if (status?.stage !== lastStage) {
                        lastStage = status?.stage;
                        if (lastStage) console.log(`Native ${phase}: ${lastStage}`);
                    }
                    if (status?.status === 'passed' || status?.status === 'failed') break;
                }
                await new Promise((resolve) => setTimeout(resolve, 500));
            }
            if (status?.status === 'failed') {
                receipt.status = 'failed';
                receipt.observation = 'app-reported-failure';
            }
            assert.equal(
                status?.status,
                'passed',
                `Native ${phase} did not pass; last stage: ${lastStage ?? 'no app receipt'}`,
            );
            receipt.completedPhases.push({ phase, pid });
            if (phase === 'replay') {
                assert(
                    Number.isSafeInteger(status.coordinatorAssertions) && status.coordinatorAssertions > 0,
                    'Missing native coordinator assertion count',
                );
                receipt.coordinatorAssertions = status.coordinatorAssertions;
                console.log(`PASS native DM coordinator: ${status.coordinatorAssertions} assertions`);
            }
            receipt.observation = 'app-reported-pass';
            saveReceipt();
            console.log(`PASS native research phase: ${phase}`);
            if (phase === 'replay')
                console.log(
                    'NOT VERIFIED: hardware file protection and locked-device access require a physical iPhone.',
                );
        }
        receipt.phase = 'uninstall';
        receipt.proofStatus = 'passed';
        receipt.observation = 'uninstall-outcome-unknown';
        saveReceipt();
        run('xcrun', ['simctl', 'uninstall', simulator, bundle]);
        cleaned = true;
        receipt.status = 'passed';
        receipt.observation = 'cleanup-and-uninstall-complete';
    } finally {
        // Missing observation is not a failed assertion: the app may finish late.
        if (!cleaned && receipt.status !== 'failed') receipt.status = 'incomplete';
        saveReceipt();
        if (!cleaned)
            console.log(
                `Reconcile the saved receipt before retrying; namespace may remain for exact cleanup: ${bundle}`,
            );
    }
    console.log('PASS process-restart native encryption and encrypted Keychain-backed storage in simulator.');
} else console.log('NOT RUN: no simulator selected; compilation alone is not restart/Keychain evidence.');
console.log(`Artifacts: ${scratch}. No production integration, two-phone or independent-security-review claim.`);
