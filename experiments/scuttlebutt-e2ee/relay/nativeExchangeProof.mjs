/**
 * Isolated simulator-native Olm → ordinary URLSession HTTPS → on-disk SQL proof.
 * Usage: node --experimental-strip-types nativeExchangeProof.mjs NATIVE_CACHE PGLITE_ARCHIVE
 * Creates and removes ONE disposable simulator; never uses an existing device.
 * Its fresh localhost CA is trusted only in that disposable simulator, after a
 * negative untrusted-TLS check. No system CA, physical phone or app is changed.
 * Cached generated bindings/static provider binaries are reused and hashed;
 * this is not a fresh Rust build or a two-physical-iPhone/auth-account test.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
    existsSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    realpathSync,
    statfsSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createNativeExchangeServer } from './nativeExchangeServer.mjs';

assert.equal(process.platform, 'darwin');
assert.equal(process.arch, 'arm64');
const [cacheArg, archiveArg, ...options] = process.argv.slice(2);
// Focused native Auth/relay URLProtocol + private-message regression only:
// no localhost server, SQL, custom CA or actual HTTPS exchange in this mode.
const accountModeOnly = options.at(-1) === '--account-mode-only';
if (accountModeOnly) options.pop();
assert(
    cacheArg &&
        archiveArg &&
        [cacheArg, archiveArg].every(isAbsolute) &&
        (options.length === 0 ||
            (options.length === 2 && options[0] === '--native-exchange-receipt' && isAbsolute(options[1]))),
    'Provide the existing cache/archive and only an optional completed native-exchange receipt',
);
assert(!lstatSync(cacheArg).isSymbolicLink() && lstatSync(cacheArg).isDirectory());
assert(!lstatSync(archiveArg).isSymbolicLink() && lstatSync(archiveArg).isFile());
const cache = realpathSync(cacheArg),
    archivePath = realpathSync(archiveArg);
const here = dirname(fileURLToPath(import.meta.url)),
    experiment = join(here, '..');
const nativePin = JSON.parse(readFileSync(join(experiment, 'vodozemac-native-pin.json'), 'utf8'));
assert.equal(nativePin.shippingApproved, false);
assert.equal(nativePin.protocol, 'olm-v1');
const digest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
assert.equal(digest(join(experiment, 'vodozemac-native/Cargo.toml')), nativePin.manifestSha256);
assert.equal(digest(join(experiment, 'vodozemac-native/Cargo.lock')), nativePin.lockfileSha256);
const bindings = join(cache, 'bindings');
const swiftBindings = readdirSync(bindings).filter((name) => name.endsWith('.swift'));
const moduleMaps = readdirSync(bindings).filter((name) => name.endsWith('.modulemap'));
assert.equal(swiftBindings.length, 1);
assert.equal(moduleMaps.length, 1);
const providerArchive = join(cache, 'target/aarch64-apple-ios-sim/debug/libthalassa_vodozemac_native.a');
const cacheInputs = [providerArchive, ...readdirSync(bindings).map((name) => join(bindings, name))];
for (const path of cacheInputs) assert(!lstatSync(path).isSymbolicLink() && lstatSync(path).isFile());
// A previous successful native research run is required before reusing its
// cache. Its receipt is evidence of execution, NOT an artifact-signing chain.
const priorReceipts = readdirSync(cache).filter((name) => /^run-[0-9a-f-]+\.json$/.test(name));
const originalPriorPassed = priorReceipts.some((name) => {
    const path = join(cache, name);
    if (lstatSync(path).isSymbolicLink() || lstatSync(path).size > 64 * 1024) return false;
    const value = JSON.parse(readFileSync(path, 'utf8'));
    return (
        value.status === 'passed' &&
        value.observation === 'cleanup-and-uninstall-complete' &&
        Array.isArray(value.completedPhases) &&
        value.completedPhases.some((phase) => phase.phase === 'relay-replay')
    );
});
const cacheHashes = Object.fromEntries(cacheInputs.map((path) => [path, digest(path)]));
let priorExchangeEvidenceSha256;
if (options.length) {
    const path = options[1];
    assert(!lstatSync(path).isSymbolicLink() && lstatSync(path).isFile() && lstatSync(path).size < 256 * 1024);
    const bytes = readFileSync(path);
    const previous = JSON.parse(bytes.toString('utf8'));
    const historicalPhases = [
        'tls-refuse',
        'prepare',
        'opening',
        'retry',
        'reply',
        'successor',
        'verify',
        'recovery',
        'cleanup',
    ];
    const phases =
        previous.completedPhases?.length === 10
            ? [
                  'tls-refuse',
                  'prepare',
                  'private-messages',
                  'opening',
                  'retry',
                  'reply',
                  'successor',
                  'verify',
                  'recovery',
                  'cleanup',
              ]
            : historicalPhases;
    assert(
        previous.status === 'passed' &&
            previous.observation === 'native-encrypted-https-sql-proof-passed' &&
            previous.disposableSimulatorRemoved === true &&
            previous.physicalPhoneExecution === false &&
            previous.providerManifestSha256 === nativePin.manifestSha256 &&
            previous.providerLockSha256 === nativePin.lockfileSha256 &&
            Array.isArray(previous.completedPhases) &&
            previous.completedPhases.length === phases.length &&
            previous.completedPhases.every(
                (value, index) => value.phase === phases[index] && value.stage === 'complete',
            ) &&
            previous.cacheHashes &&
            typeof previous.cacheHashes === 'object' &&
            Object.keys(previous.cacheHashes).sort().join('\n') === Object.keys(cacheHashes).sort().join('\n') &&
            Object.entries(cacheHashes).every(([path, hash]) => previous.cacheHashes[path] === hash),
        'Completed exchange evidence must match every exact cached artifact and pinned provider',
    );
    priorExchangeEvidenceSha256 = createHash('sha256').update(bytes).digest('hex');
} else assert(originalPriorPassed, 'Cache must belong to a completed native PostgreSQL research proof');
const scratch = mkdtempSync(join(tmpdir(), 'thalassa-native-exchange-'));
assert(statfsSync(scratch).bavail * statfsSync(scratch).bsize > 3 * 1024 ** 3, 'Keep at least 3 GiB free');

process.title = 'thalassa native exchange waiting';
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
    if (!announced) console.log('Waiting for shared-Mac build slot (native HTTPS exchange).');
    announced = true;
    await delay(5000);
}
process.title = 'vite build slot: isolated native HTTPS exchange';
const run = (args, { timeout = 120_000, quiet = false } = {}) => {
    const result = spawnSync('/usr/bin/xcrun', args, { encoding: 'utf8', timeout, maxBuffer: 1024 * 1024 });
    if (!quiet && result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    assert(!result.error && result.status === 0, 'Research simulator command failed; no production changes');
    return result.stdout.trim();
};
const bundle = `app.thalassa.research.exchange.${randomUUID().toLowerCase()}`;
const runID = randomUUID(),
    aliceID = randomUUID(),
    bobID = randomUUID();
const receiptPath = join(scratch, 'exchange-run.json');
const receipt = {
    runID,
    aliceID,
    bobID,
    bundle,
    status: 'running',
    phase: 'build',
    completedPhases: [],
    cacheHashes,
    priorExchangeEvidenceSha256,
    providerManifestSha256: nativePin.manifestSha256,
    providerLockSha256: nativePin.lockfileSha256,
    fixtureAuth: true,
    cachedArtifactProvenanceIndependentlyVerified: false,
    physicalPhoneExecution: false,
    tlsPolicy: accountModeOnly
        ? 'synthetic-urlprotocol-no-ca-or-server'
        : 'ordinary-urlsession-disposable-simulator-root',
    accountModeOnly,
};
const saveReceipt = () => writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
saveReceipt();
console.log(`Nonsecret native exchange receipt: ${receiptPath}`);
let simulator;
let relay;
let failure;
try {
    const app = join(scratch, 'NativeExchange.app');
    mkdirSync(app, { mode: 0o700 });
    const entitlements = join(scratch, 'research.simulated.xcent'),
        derEntitlements = entitlements + '.der';
    writeFileSync(
        entitlements,
        `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>application-identifier</key><string>RESEARCH00.${bundle}</string><key>keychain-access-groups</key><array><string>RESEARCH00.${bundle}</string></array></dict></plist>`,
        { mode: 0o600, flag: 'wx' },
    );
    run(['derq', 'query', '-f', 'xml', '-i', entitlements, '-o', derEntitlements, '--raw']);
    const sources = [
        join(bindings, swiftBindings[0]),
        ...[
            'VodozemacSealedStore.swift',
            'VodozemacDmFrame.swift',
            'VodozemacDmCoordinator.swift',
            'VodozemacMessageOperations.swift',
            'VodozemacDmCoordinatorProbe.swift',
            'VodozemacEnrollmentIntentProbe.swift',
            'VodozemacRelayCodec.swift',
            'VodozemacRelayTransport.swift',
            'VodozemacSupabaseAuth.swift',
            'VodozemacAuthSession.swift',
            'VodozemacAuthProbe.swift',
            'VodozemacAccountDirectory.swift',
            'VodozemacSessionFacade.swift',
            'VodozemacAccountDirectoryProbe.swift',
            'VodozemacMessageAuthorityProbe.swift',
            'VodozemacPairingHistoryProbe.swift',
            'VodozemacScopedRelayProbe.swift',
            'VodozemacScopedEnrollmentProbe.swift',
            'VodozemacReadinessProbe.swift',
            'VodozemacResearchBridgeProbe.swift',
            'VodozemacAccountModeProbe.swift',
            'VodozemacRelayPolicy.swift',
            'VodozemacRelayResult.swift',
            'VodozemacRelayResultProbe.swift',
            'VodozemacLifecycleProbe.swift',
            'VodozemacUnresolvedProbe.swift',
            'VodozemacRelayClient.swift',
            'VodozemacScopedRelayClient.swift',
            'VodozemacExchangeProbe.swift',
        ].map((name) => join(experiment, name)),
        join(experiment, 'bridge-native/ResearchMessagingAdapter.swift'),
        join(experiment, 'bridge-native/ResearchPrivateMessageAdapter.swift'),
    ];
    for (const path of sources) assert(!lstatSync(path).isSymbolicLink() && lstatSync(path).isFile());
    receipt.sourceHashes = Object.fromEntries(sources.map((path) => [path, digest(path)]));
    saveReceipt();
    const executable = join(app, 'NativeExchange');
    const sdkPath = run(['--sdk', 'iphonesimulator', '--show-sdk-path'], { quiet: true });
    run([
        '--sdk',
        'iphonesimulator',
        'swiftc',
        '-swift-version',
        '5',
        '-j',
        '1',
        '-num-threads',
        '1',
        '-parse-as-library',
        '-target',
        'arm64-apple-ios17.0-simulator',
        '-sdk',
        sdkPath,
        '-module-cache-path',
        join(scratch, 'modules'),
        '-I',
        bindings,
        '-Xcc',
        `-fmodule-map-file=${join(bindings, moduleMaps[0])}`,
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
        providerArchive,
        '-lsqlite3',
        '-framework',
        'Security',
        '-o',
        executable,
        ...sources,
    ]);
    assert(run(['vtool', '-show-build', executable], { quiet: true }).includes('platform IOSSIMULATOR\n'));
    for (const [path, expected] of Object.entries(cacheHashes))
        assert.equal(digest(path), expected, 'Cached generated binding/static library must not change during this run');
    for (const [path, expected] of Object.entries(receipt.sourceHashes))
        assert.equal(digest(path), expected, 'Native research sources must not change during compilation');
    writeFileSync(
        join(app, 'Info.plist'),
        `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${bundle}</string><key>CFBundleExecutable</key><string>NativeExchange</string><key>CFBundleName</key><string>NativeExchange</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>1</string><key>MinimumOSVersion</key><string>17.0</string><key>LSRequiresIPhoneOS</key><true/><key>UIDeviceFamily</key><array><integer>1</integer></array><key>UILaunchScreen</key><dict/><key>NSLocalNetworkUsageDescription</key><string>Disposable local encryption research only.</string><key>UIApplicationSceneManifest</key><dict><key>UIApplicationSupportsMultipleScenes</key><false/><key>UISceneConfigurations</key><dict><key>UIWindowSceneSessionRoleApplication</key><array><dict><key>UISceneConfigurationName</key><string>Research</string><key>UISceneDelegateClassName</key><string>ThalassaNativeExchangeScene</string></dict></array></dict></dict></dict></plist>`,
        { mode: 0o600, flag: 'wx' },
    );
    const signed = spawnSync('/usr/bin/codesign', ['--force', '--sign', '-', app], {
        encoding: 'utf8',
        timeout: 30_000,
    });
    assert(!signed.error && signed.status === 0, 'Ad-hoc sign only this isolated simulator app');
    receipt.phase = 'simulator-create';
    saveReceipt();
    const runtimes = JSON.parse(run(['simctl', 'list', 'runtimes', '--json'], { quiet: true })).runtimes;
    const runtime = runtimes.find(
        (value) =>
            value.isAvailable &&
            value.platform === 'iOS' &&
            value.identifier === 'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
    );
    assert(runtime, 'An already installed iOS 26.5 runtime is required; never download runtimes');
    const phoneTypes = runtime.supportedDeviceTypes.filter((value) => value.productFamily === 'iPhone');
    const deviceType = (
        phoneTypes.find(
            (value) => value.identifier === 'com.apple.CoreSimulator.SimDeviceType.iPhone-SE-3rd-generation',
        ) ?? phoneTypes[0]
    ).identifier;
    receipt.simulatorDeviceType = deviceType;
    const name = `Thalassa E2EE disposable ${runID}`;
    const created = run(['simctl', 'create', name, deviceType, runtime.identifier], { quiet: true });
    assert(/^[0-9A-Fa-f-]{36}$/.test(created), 'Must capture exact newly created simulator ID');
    simulator = created;
    receipt.simulator = simulator;
    receipt.simulatorName = name;
    saveReceipt();
    // Every device mutation below targets only the newly returned UUID.
    const ownDevice = () => {
        const devices = JSON.parse(run(['simctl', 'list', 'devices', '--json'], { quiet: true })).devices;
        const matches = Object.values(devices)
            .flat()
            .filter((value) => value.udid === simulator);
        assert.equal(matches.length, 1);
        assert.equal(matches[0].name, name, 'Never mutate a pre-existing or differently owned simulator');
        return matches[0];
    };
    ownDevice();
    run(['simctl', 'boot', simulator], { quiet: true });
    // Cold first boot can be slow on the shared 8 GB Mac. Keep its progress
    // observable, and postpone the SQL/WASM allocation until boot completes.
    await new Promise((resolve, reject) => {
        const child = spawn('/usr/bin/xcrun', ['simctl', 'bootstatus', simulator, '-b'], {
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        const timer = setTimeout(() => child.kill('SIGTERM'), 600_000);
        child.stdout.on('data', (data) => process.stdout.write(data));
        child.stderr.on('data', (data) => process.stderr.write(data));
        child.once('error', (error) => {
            clearTimeout(timer);
            reject(error);
        });
        child.once('exit', (code) => {
            clearTimeout(timer);
            if (code === 0) resolve();
            else reject(new Error('Disposable simulator boot did not complete; no message tests ran'));
        });
    });
    run(['simctl', 'install', simulator, app], { timeout: 180_000, quiet: true });
    if (!accountModeOnly) relay = await createNativeExchangeServer({ archivePath, scratch });
    receipt.origin = relay?.origin ?? 'https://account-mode-fixture.invalid';
    saveReceipt();
    const container = run(['simctl', 'get_app_container', simulator, bundle, 'data'], { quiet: true });
    assert(isAbsolute(container));
    const statusPath = join(container, 'Documents', `exchange-status-${runID.toLowerCase()}.json`);
    const launch = async (phase) => {
        ownDevice();
        receipt.phase = phase;
        receipt.observation = 'launch-outcome-unknown';
        delete receipt.pid;
        saveReceipt();
        const output = run(
            [
                'simctl',
                'launch',
                '--terminate-running-process',
                simulator,
                bundle,
                '--exchange',
                phase,
                runID,
                aliceID,
                bobID,
                receipt.origin,
            ],
            { timeout: 180_000, quiet: true },
        );
        const pid = Number(output.match(/: (\d+)\s*$/)?.[1]);
        assert(Number.isSafeInteger(pid) && pid > 0);
        receipt.pid = pid;
        receipt.observation = 'awaiting-app-receipt';
        saveReceipt();
        // Preparation now runs the complete storage/Auth/directory/authority
        // regression suites and their owned-fixture cleanup. A slow simulator
        // may exceed a minute; this HARNESS bound never extends any native Auth
        // lease, HTTP timeout or held-lock fixture deadline.
        // Shared-Mac regression-batch budget only. Native verified leases,
        // policy permits, HTTP deadlines and held-gate bounds are unchanged.
        const deadline =
            Date.now() +
            (phase === 'prepare' ? 600_000 : ['private-messages', 'account-mode'].includes(phase) ? 180_000 : 60_000);
        let status;
        while (Date.now() < deadline) {
            if (existsSync(statusPath)) {
                assert(!lstatSync(statusPath).isSymbolicLink() && lstatSync(statusPath).size < 64 * 1024);
                const candidate = JSON.parse(readFileSync(statusPath, 'utf8'));
                if (candidate.runID === runID.toLowerCase() && candidate.phase === phase && candidate.pid === pid)
                    status = candidate;
                if (status?.status === 'passed' || status?.status === 'failed') break;
            }
            await delay(250); // Keep Node HTTPS server available while the app runs.
        }
        // Retain only fixed native labels/counts before removing the disposable
        // device, so an assertion failure is diagnosable without retaining keys.
        receipt.lastNativeStatus = status
            ? { phase, status: status.status, stage: status.stage }
            : { phase, status: 'missing' };
        if (status?.status !== 'passed' && status?.status !== 'failed') {
            try {
                process.kill(pid, 0);
                receipt.nativeProcessAliveAtDeadline = true;
            } catch {
                receipt.nativeProcessAliveAtDeadline = false;
            }
            if (receipt.nativeProcessAliveAtDeadline) {
                const samplePath = join(scratch, `native-timeout-${phase}.sample`);
                const sampled = spawnSync('/usr/bin/sample', [String(pid), '1', '1', '-file', samplePath], {
                    encoding: 'utf8',
                    timeout: 10000,
                    maxBuffer: 1024 * 1024,
                });
                receipt.timeoutStackSampleCaptured = sampled.status === 0 && existsSync(samplePath);
                if (receipt.timeoutStackSampleCaptured) receipt.timeoutStackSamplePath = samplePath;
            }
        }
        saveReceipt();
        assert.equal(
            status?.status,
            'passed',
            `Native ${phase} failed or unresolved (${status?.stage ?? 'missing'}); only sanitized app receipt inspected`,
        );
        if (phase === 'prepare') {
            assert(Number.isSafeInteger(status.authFixtureAssertions) && status.authFixtureAssertions > 0);
            receipt.nativeAuthFixtureAssertions = status.authFixtureAssertions;
            assert(
                Number.isSafeInteger(status.accountDirectoryFixtureAssertions) &&
                    status.accountDirectoryFixtureAssertions > 0,
            );
            receipt.nativeAccountDirectoryFixtureAssertions = status.accountDirectoryFixtureAssertions;
            assert(
                Number.isSafeInteger(status.enrollmentIntentFixtureAssertions) &&
                    status.enrollmentIntentFixtureAssertions > 0,
            );
            receipt.nativeEnrollmentIntentFixtureAssertions = status.enrollmentIntentFixtureAssertions;
            assert(
                Number.isSafeInteger(status.messageAuthorityFixtureAssertions) &&
                    status.messageAuthorityFixtureAssertions > 0,
            );
            receipt.nativeMessageAuthorityFixtureAssertions = status.messageAuthorityFixtureAssertions;
            assert(
                Number.isSafeInteger(status.pairingHistoryFixtureAssertions) &&
                    status.pairingHistoryFixtureAssertions > 0,
            );
            receipt.nativePairingHistoryFixtureAssertions = status.pairingHistoryFixtureAssertions;
            assert(
                Number.isSafeInteger(status.scopedRelayFixtureAssertions) && status.scopedRelayFixtureAssertions > 0,
            );
            receipt.nativeScopedRelayFixtureAssertions = status.scopedRelayFixtureAssertions;
            assert(
                Number.isSafeInteger(status.scopedEnrollmentFixtureAssertions) &&
                    status.scopedEnrollmentFixtureAssertions > 0,
            );
            receipt.nativeScopedEnrollmentFixtureAssertions = status.scopedEnrollmentFixtureAssertions;
            assert(Number.isSafeInteger(status.readinessFixtureAssertions) && status.readinessFixtureAssertions > 0);
            receipt.nativeReadinessFixtureAssertions = status.readinessFixtureAssertions;
            assert(Number.isSafeInteger(status.bridgeFixtureAssertions) && status.bridgeFixtureAssertions > 0);
            receipt.nativeBridgeFixtureAssertions = status.bridgeFixtureAssertions;
        }
        if (phase === 'private-messages') {
            assert(
                Number.isSafeInteger(status.privateMessageFixtureAssertions) &&
                    status.privateMessageFixtureAssertions > 0,
            );
            receipt.nativePrivateMessageFixtureAssertions = status.privateMessageFixtureAssertions;
        }
        if (phase === 'account-mode') {
            assert(
                Number.isSafeInteger(status.accountModeFixtureAssertions) && status.accountModeFixtureAssertions > 0,
            );
            receipt.nativeAccountModeFixtureAssertions = status.accountModeFixtureAssertions;
        }
        receipt.completedPhases.push({
            phase,
            pid,
            stage: status.stage,
            ...(phase === 'prepare'
                ? { enrollmentIntentFixtureAssertions: status.enrollmentIntentFixtureAssertions }
                : {}),
        });
        receipt.observation = 'app-reported-pass';
        saveReceipt();
        console.log(
            `PASS native ${accountModeOnly ? 'synthetic Auth/relay fixture' : 'HTTPS exchange'} phase: ${phase}`,
        );
    };
    if (accountModeOnly) {
        await launch('account-mode');
        await launch('private-messages');
        receipt.status = 'passed';
        receipt.observation = 'native-account-mode-and-private-message-fixtures-passed';
    } else {
        await launch('tls-refuse');
        const beforeTrust = relay.counters();
        assert(beforeTrust.tlsRefusals > 0, 'Native negative check must actually attempt and reject a TLS handshake');
        assert.equal(beforeTrust.httpRequests, 0, 'Untrusted TLS must not reach the HTTP/Auth gateway');
        assert.equal(beforeTrust.authRequests, 0);
        receipt.phase = 'disposable-simulator-trust';
        saveReceipt();
        ownDevice();
        run(['simctl', 'keychain', simulator, 'add-root-cert', relay.certPath], { quiet: true });
        receipt.rootAddedOnlyToNewSimulator = true;
        saveReceipt();
        for (const phase of [
            'prepare',
            'private-messages',
            'opening',
            'retry',
            'reply',
            'successor',
            'verify',
            'recovery',
            'cleanup',
        ]) {
            await launch(phase);
            if (phase === 'opening') {
                await relay.verify({ expectedDecisions: 1, expectedFaults: { lostResponses: 1 } });
                await relay.reopen();
            }
        }
        receipt.serverVerification = await relay.verify({
            expectedDecisions: 4,
            expectedMessages: 4,
            expectedClientIds: ['exchange-opening', 'exchange-reply', 'exchange-successor', 'exchange-recovery'],
            forbiddenPlaintexts: [
                'Native HTTPS research opening',
                'Native HTTPS research reply',
                'Native HTTPS research successor',
                'Native HTTPS research recovery',
            ],
            expectedFaults: { lostResponses: 1, wrongReceipts: 1, malformedLists: 1, poisonLists: 8 },
        });
        await relay.reopen();
        receipt.status = 'passed';
        receipt.observation = 'native-encrypted-https-sql-proof-passed';
    }
} catch (error) {
    failure = error;
    receipt.status = 'failed';
    receipt.observation = 'failed-or-incomplete-check-keys-not-reused';
} finally {
    // The fresh simulator is solely owned by this runner. Removing it also
    // removes the deliberately added fixture CA. No existing device is reset.
    if (simulator) {
        try {
            const devices = JSON.parse(run(['simctl', 'list', 'devices', '--json'], { quiet: true })).devices;
            const target = Object.values(devices)
                .flat()
                .find((value) => value.udid === simulator);
            assert(target && target.name === receipt.simulatorName);
            if (target.state !== 'Shutdown') run(['simctl', 'shutdown', simulator], { quiet: true });
            run(['simctl', 'delete', simulator], { quiet: true });
            receipt.disposableSimulatorRemoved = true;
        } catch (error) {
            failure ??= error;
            receipt.status = 'incomplete';
            receipt.disposableSimulatorRemoved = false;
        }
    }
    try {
        if (relay) {
            receipt.serverCounters = relay.counters();
            await relay.close();
        }
    } catch (error) {
        failure ??= error;
        receipt.status = 'incomplete';
    }
    saveReceipt();
}
console.log(`Research artifacts retained: ${scratch}`);
if (failure) throw failure;
console.log(
    accountModeOnly
        ? 'PASS native account mode and private-message synthetic fixtures; no SQL/network/CA proof.'
        : 'PASS native Olm ↔ ordinary TLS ↔ SQL with restarts and unresolved/retry checks.',
);
console.log('Disposable simulator removed. NOT two phones, live Auth or independent security review.');
