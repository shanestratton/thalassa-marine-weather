/** Fresh native execution of four exact historical provider artifacts.
 * Node24 cachedProviderBootstrap.mjs CACHE PGLITE_ARCHIVE [REMAINING_WAIT_MS] [--compile-only]
 * This does not rebuild Rust, recover an old receipt, attest binary provenance,
 * use human devices, contact a hosted relay or grant production permission.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
    chmodSync,
    copyFileSync,
    existsSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    statfsSync,
    writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { inspectSimulatorEntitlementSections } from './bridge-native/machOEntitlementEvidence.mjs';
import {
    NATIVE_PROVIDER_BOOTSTRAP_SWIFT_SOURCES,
    NATIVE_PROVIDER_BOOTSTRAP_PROOF_SOURCES,
    NATIVE_PROVIDER_BOOTSTRAP_PHASES,
    NATIVE_PROVIDER_BOOTSTRAP_CACHE_PINS,
    inspectNativeProviderBootstrapStatus,
    inspectNativeProviderBootstrapReceipt,
} from './nativeProviderBootstrapContract.mjs';
import { createNativeRelayBridge } from './relay/nativeRelayBridge.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const checkout = resolve(here, '../..');
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'thalassa-provider-bootstrap-')));
chmodSync(scratch, 0o700);
const attemptPath = join(scratch, 'attempt-receipt.json');
const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const runID = randomUUID(),
    aliceID = randomUUID(),
    bobID = randomUUID();
const bundle = `app.thalassa.research.vodozemac.${runID}`;
const attempt = {
    schemaVersion: 1,
    kind: 'cached-provider-native-bootstrap-attempt',
    runID,
    status: 'preparing',
    stage: 'inputs',
    completedPhases: [],
    sharedSlotWaitMs: 0,
    freshRustBuild: false,
    sourceBinaryProvenanceProved: false,
    independentlyReviewed: false,
    liveAuth: false,
    physicalDeviceExecution: false,
    productionTouched: false,
    humanDevicesChanged: false,
    hostedActorsChanged: false,
    nativeCompiled: false,
    adHocSimulatorSigned: false,
    researchInstallAttempted: false,
    ownedSimulatorRemoved: false,
    acceptedReceiptCreated: false,
};
const save = () => writeFileSync(attemptPath, JSON.stringify(attempt, null, 2) + '\n', { mode: 0o600 });
save();
console.info('Nonsecret provider bootstrap attempt: ' + attemptPath);
let simulator, ownedName, relay, relaySummary, statusPath;
let cacheRoot, cacheArtifacts, sourceInputs, executable, executableBeforeSigning, entitlements;
let controlPID, coordinatorAssertions;
let accepted;
let relayArchive;
const copiedSourceHashes = {};
let waited = 0,
    waitBudget = 120000;
function regular(path, max = 16 * 1024 * 1024) {
    assert(isAbsolute(path));
    // Check every ancestor: a regular leaf alone cannot rule out redirected I/O.
    for (let p = path; p !== dirname(p); p = dirname(p)) assert(!lstatSync(p).isSymbolicLink());
    const s = lstatSync(path);
    assert(s.isFile() && s.uid === process.getuid() && s.size > 0 && s.size <= max);
    return realpathSync(path);
}
function stable() {
    for (const [relative, expected] of Object.entries(sourceInputs ?? {}))
        assert.equal(hash(regular(join(checkout, relative))), expected);
    for (const [suffix, expected] of Object.entries(cacheArtifacts ?? {}))
        assert.equal(hash(regular(join(cacheRoot, suffix), 256 * 1024 * 1024)), expected);
    if (executable && attempt.adHocSimulatorSigned) assert.equal(hash(executable), attempt.signedExecutableSha256);
    if (relayArchive) assert.equal(hash(regular(relayArchive.path, 32 * 1024 * 1024)), relayArchive.sha256);
    for (const [p, expected] of Object.entries(copiedSourceHashes)) assert.equal(hash(regular(p)), expected);
    assert.equal(hash(process.execPath), '798d7f9c0d38051608d11ba87a12fbb01e92bfa457cd77ec612b5bad2a73a05e');
}
async function slot() {
    process.title = 'thalassa provider bootstrap waiting';
    for (;;) {
        const p = spawnSync('/usr/bin/pgrep', ['-fl', 'vite build|tsc|vitest'], { encoding: 'utf8', timeout: 10000 });
        assert(!p.error && [0, 1].includes(p.status));
        const others = p.stdout
            .split('\n')
            .filter(
                (s) =>
                    /^\d+\s/.test(s) &&
                    !s.startsWith(process.pid + ' ') &&
                    !/^\d+\s+(?:\/\S*\/)?(?:sh|bash|zsh|fish|env|xargs|pgrep)(?:\s|$)/.test(s),
            );
        if (waited > waitBudget || (waited > 0 && waited >= waitBudget)) {
            attempt.status = 'queued-unrun';
            throw new Error('Shared opportunity expired');
        }
        if (!others.length) {
            process.title = 'vite build slot: isolated cached provider bootstrap';
            return;
        }
        if (waited >= waitBudget) {
            attempt.status = 'queued-unrun';
            throw new Error('Shared opportunity expired');
        }
        const before = Date.now();
        await delay(Math.min(5000, waitBudget - waited));
        waited += Date.now() - before;
        attempt.sharedSlotWaitMs = waited;
        save();
    }
}
// Raw subprocess output, arguments and native failure descriptions never leave
// this private driver. Only fixed operation names, exit status and timeout facts.
function quiet(operation, bin, args, timeout = 30000, maxBuffer = 8 * 1024 * 1024, input) {
    attempt.lastOperation = operation;
    attempt.lastOperationExitStatus = null;
    attempt.lastOperationTimedOut = false;
    save();
    const r = spawnSync(bin, args, { encoding: 'utf8', timeout, maxBuffer, ...(input === undefined ? {} : { input }) });
    attempt.lastOperationExitStatus = Number.isInteger(r.status) ? r.status : null;
    attempt.lastOperationTimedOut = r.error?.code === 'ETIMEDOUT';
    if (operation === 'native-swift-compile' && (r.error || r.status !== 0)) {
        const path = join(scratch, 'private-compiler-diagnostics.txt');
        writeFileSync(path, r.stderr ?? '', { mode: 0o600, flag: 'wx' });
        attempt.compilerDiagnostics = { path, sha256: hash(path) };
    }
    save();
    assert(!r.error && r.status === 0, 'Owned bootstrap operation refused');
    return r.stdout.trim();
}
function own() {
    const all = JSON.parse(quiet('simulator-inventory', '/usr/bin/xcrun', ['simctl', 'list', 'devices', '--json']));
    const matches = Object.values(all.devices)
        .flat()
        .filter((d) => d.udid === simulator);
    assert(matches.length === 1 && matches[0].name === ownedName);
    return matches[0];
}
function exactLaunchPID(output, identifier) {
    assert(output.startsWith(identifier + ': '));
    const tail = output.slice(identifier.length + 2);
    assert(/^[1-9][0-9]{0,8}$/.test(tail));
    return Number(tail);
}

try {
    const [cacheArg, archiveArg, ...tail] = process.argv.slice(2);
    const compileOnly = tail.at(-1) === '--compile-only';
    if (compileOnly) tail.pop();
    assert(cacheArg && archiveArg && tail.length <= 1);
    if (tail.length) {
        assert(/^(?:0|[1-9][0-9]{0,5})$/.test(tail[0]) && Number(tail[0]) <= 120000);
        waitBudget = Number(tail[0]);
    }
    attempt.compileOnly = compileOnly;
    assert(process.platform === 'darwin' && process.arch === 'arm64');
    attempt.stage = 'isolated-environment';
    save();
    // CoreFoundation can add its non-secret text-encoding triplet on macOS,
    // even after env -i. No NODE_OPTIONS, DYLD_* or SIMCTL_CHILD_* is admitted.
    assert(
        Object.keys(process.env).every((key) => ['PATH', 'LANG', 'TMPDIR', '__CF_USER_TEXT_ENCODING'].includes(key)),
    );
    if (process.env.__CF_USER_TEXT_ENCODING !== undefined)
        assert(
            /^(?:0x[0-9a-fA-F]+|[0-9]+)(?::(?:0x[0-9a-fA-F]+|[0-9]+)){2}$/.test(process.env.__CF_USER_TEXT_ENCODING),
        );
    assert(
        process.env.PATH === '/usr/bin:/bin' &&
            process.env.LANG === 'en_AU.UTF-8' &&
            process.env.TMPDIR === '/private/tmp',
    );
    attempt.stage = 'node-pin';
    save();
    assert.equal(process.version, 'v24.21.0');
    assert.equal(
        hash(regular(process.execPath, 256 * 1024 * 1024)),
        '798d7f9c0d38051608d11ba87a12fbb01e92bfa457cd77ec612b5bad2a73a05e',
    );
    assert(checkout === '/Users/shanestratton/.codex/worktrees/scuttlebutt-e2ee/thalassa-marine-weather');
    assert(isAbsolute(cacheArg) && !lstatSync(cacheArg).isSymbolicLink());
    const originalCache = realpathSync(cacheArg);
    assert(lstatSync(originalCache).isDirectory() && lstatSync(originalCache).uid === process.getuid());
    attempt.stage = 'pinned-archive';
    save();
    const archive = regular(archiveArg, 32 * 1024 * 1024);
    const pglitePin = JSON.parse(readFileSync(join(here, 'relay/pglite-pin.json'), 'utf8'));
    assert.equal('sha512-' + createHash('sha512').update(readFileSync(archive)).digest('base64'), pglitePin.integrity);
    assert.equal(pglitePin.shippingApproved, false);
    const disk = statfsSync(scratch);
    assert(disk.bavail * disk.bsize > 3 * 1024 ** 3);
    const nativePin = JSON.parse(readFileSync(join(here, 'vodozemac-native-pin.json'), 'utf8'));
    assert(nativePin.version === '0.11.0' && nativePin.protocol === 'olm-v1' && nativePin.shippingApproved === false);
    assert.equal(hash(join(here, 'vodozemac-native/Cargo.toml')), nativePin.manifestSha256);
    assert.equal(hash(join(here, 'vodozemac-native/Cargo.lock')), nativePin.lockfileSha256);
    attempt.stage = 'source-snapshot';
    save();
    sourceInputs = Object.fromEntries(
        [...NATIVE_PROVIDER_BOOTSTRAP_SWIFT_SOURCES, ...NATIVE_PROVIDER_BOOTSTRAP_PROOF_SOURCES].map((p) => [
            p,
            hash(regular(join(checkout, p))),
        ]),
    );
    attempt.stage = 'pinned-artifact-copies';
    save();
    cacheRoot = join(scratch, 'cache');
    mkdirSync(cacheRoot, { mode: 0o700 });
    cacheArtifacts = {};
    for (const [suffix, expected] of Object.entries(NATIVE_PROVIDER_BOOTSTRAP_CACHE_PINS)) {
        const input = regular(join(originalCache, suffix), 256 * 1024 * 1024);
        assert.equal(hash(input), expected);
        const output = join(cacheRoot, suffix);
        mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
        copyFileSync(input, output);
        assert.equal(hash(regular(output, 256 * 1024 * 1024)), expected);
        cacheArtifacts[suffix] = expected;
    }
    attempt.cacheRoot = cacheRoot;
    attempt.cacheArtifacts = cacheArtifacts;
    attempt.sourceInputs = sourceInputs;
    attempt.providerManifestSha256 = nativePin.manifestSha256;
    attempt.providerLockSha256 = nativePin.lockfileSha256;
    save();
    const sourcesRoot = join(scratch, 'sources');
    mkdirSync(sourcesRoot, { mode: 0o700 });
    const copiedSources = NATIVE_PROVIDER_BOOTSTRAP_SWIFT_SOURCES.map((relative) => {
        const output = join(sourcesRoot, relative.split('/').at(-1));
        copyFileSync(join(checkout, relative), output);
        assert.equal(hash(output), sourceInputs[relative]);
        copiedSourceHashes[output] = sourceInputs[relative];
        return output;
    });
    const app = join(cacheRoot, 'NativeResearch.app');
    mkdirSync(app, { mode: 0o700 });
    executable = join(app, 'NativeResearch');
    const xml = join(scratch, 'simulated.xcent'),
        der = xml + '.der';
    writeFileSync(
        xml,
        `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>application-identifier</key><string>RESEARCH00.${bundle}</string><key>keychain-access-groups</key><array><string>RESEARCH00.${bundle}</string></array></dict></plist>`,
        { mode: 0o600, flag: 'wx' },
    );
    await slot();
    stable();
    attempt.stage = 'native-compile';
    save();
    quiet('simulated-entitlements-der', '/usr/bin/xcrun', [
        'derq',
        'query',
        '-f',
        'xml',
        '-i',
        xml,
        '-o',
        der,
        '--raw',
    ]);
    entitlements = { __entitlements: hash(xml), __ents_der: hash(der) };
    const sdk = quiet('simulator-sdk-path', '/usr/bin/xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-path']);
    quiet(
        'native-swift-compile',
        '/usr/bin/xcrun',
        [
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
            sdk,
            '-module-cache-path',
            join(scratch, 'modules'),
            '-I',
            join(cacheRoot, 'bindings'),
            '-Xcc',
            `-fmodule-map-file=${join(cacheRoot, 'bindings/thalassa_vodozemac_nativeFFI.modulemap')}`,
            '-Xlinker',
            '-sectcreate',
            '-Xlinker',
            '__TEXT',
            '-Xlinker',
            '__entitlements',
            '-Xlinker',
            xml,
            '-Xlinker',
            '-sectcreate',
            '-Xlinker',
            '__TEXT',
            '-Xlinker',
            '__ents_der',
            '-Xlinker',
            der,
            join(cacheRoot, 'target/aarch64-apple-ios-sim/debug/libthalassa_vodozemac_native.a'),
            '-Xlinker',
            '-no_adhoc_codesign',
            '-lsqlite3',
            '-framework',
            'Security',
            '-o',
            executable,
            join(cacheRoot, 'bindings/thalassa_vodozemac_native.swift'),
            ...copiedSources,
        ],
        180000,
    );
    assert(
        quiet('compiled-target-inspection', '/usr/bin/xcrun', ['vtool', '-show-build', executable]).includes(
            'platform IOSSIMULATOR\n',
        ),
    );
    inspectSimulatorEntitlementSections(readFileSync(executable), entitlements);
    const unsigned = spawnSync('/usr/bin/codesign', ['-dv', executable], {
        encoding: 'utf8',
        timeout: 10000,
        maxBuffer: 8192,
    });
    assert(!unsigned.error && unsigned.status !== 0 && unsigned.stderr.includes('code object is not signed at all'));
    executableBeforeSigning = hash(executable);
    attempt.nativeCompiled = true;
    attempt.compiledExecutableSha256 = executableBeforeSigning;
    attempt.entitlements = entitlements;
    stable();
    save();
    if (compileOnly) {
        attempt.status = 'compiled-only';
        attempt.stage = 'complete';
    } else {
        await slot();
        stable();
        attempt.stage = 'simulator-app-packaging';
        save();
        writeFileSync(
            join(app, 'Info.plist'),
            `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${bundle}</string><key>CFBundleExecutable</key><string>NativeResearch</string><key>CFBundleName</key><string>NativeResearch</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>1</string><key>MinimumOSVersion</key><string>17.0</string><key>LSRequiresIPhoneOS</key><true/><key>UIDeviceFamily</key><array><integer>1</integer></array><key>UILaunchScreen</key><dict/><key>UIApplicationSceneManifest</key><dict><key>UIApplicationSupportsMultipleScenes</key><false/><key>UISceneConfigurations</key><dict><key>UIWindowSceneSessionRoleApplication</key><array><dict><key>UISceneConfigurationName</key><string>Research</string><key>UISceneDelegateClassName</key><string>ThalassaNativeResearchScene</string></dict></array></dict></dict></dict></plist>`,
            { mode: 0o600, flag: 'wx' },
        );
        quiet('ad-hoc-sign-owned-app', '/usr/bin/codesign', ['--force', '--sign', '-', app]);
        attempt.adHocSimulatorSigned = true;
        attempt.signedExecutableSha256 = hash(executable);
        save();
        quiet('signed-owned-app-verify', '/usr/bin/codesign', ['--verify', '--strict', app]);
        inspectSimulatorEntitlementSections(readFileSync(executable), entitlements);
        const inventory = JSON.parse(
            quiet('runtime-inventory', '/usr/bin/xcrun', ['simctl', 'list', 'runtimes', '--json']),
        ).runtimes;
        assert(Array.isArray(inventory) && inventory.length <= 100);
        const runtimeRows = inventory.filter((r) => r.identifier === 'com.apple.CoreSimulator.SimRuntime.iOS-27-0');
        assert(runtimeRows.length === 1);
        const runtime = runtimeRows[0];
        assert(
            runtime.isAvailable === true &&
                runtime.platform === 'iOS' &&
                runtime.version === '27.0' &&
                runtime.buildversion === '24A434',
        );
        const deviceType = 'com.apple.CoreSimulator.SimDeviceType.iPhone-SE-3rd-generation';
        assert(
            runtime.supportedDeviceTypes.filter((d) => d.identifier === deviceType && d.productFamily === 'iPhone')
                .length === 1,
        );
        ownedName = 'Thalassa cached provider bootstrap ' + runID;
        attempt.stage = 'owned-simulator-create';
        save();
        simulator = quiet('owned-simulator-create', '/usr/bin/xcrun', [
            'simctl',
            'create',
            ownedName,
            deviceType,
            runtime.identifier,
        ]);
        assert(/^[0-9A-F-]{36}$/.test(simulator));
        attempt.ownedSimulator = { id: simulator, name: ownedName };
        own();
        attempt.stage = 'owned-simulator-boot';
        save();
        quiet('owned-simulator-boot', '/usr/bin/xcrun', ['simctl', 'boot', simulator]);
        quiet('owned-simulator-bootstatus', '/usr/bin/xcrun', ['simctl', 'bootstatus', simulator, '-b'], 180000);
        own();
        attempt.stage = 'owned-control-launch';
        save();
        const appInventory = quiet(
            'owned-control-inventory',
            '/usr/bin/xcrun',
            ['simctl', 'listapps', simulator],
            30000,
            1024 * 1024,
        );
        const converted = quiet(
            'owned-control-metadata-convert',
            '/usr/bin/plutil',
            ['-convert', 'json', '-o', '-', '-'],
            10000,
            1024 * 1024,
            appInventory,
        );
        const apps = JSON.parse(converted);
        assert(apps && typeof apps === 'object' && !Array.isArray(apps) && Object.keys(apps).length <= 500);
        const control = apps['com.apple.Preferences'];
        assert(
            control &&
                control.ApplicationType === 'System' &&
                (!Object.hasOwn(control, 'CFBundleIdentifier') ||
                    control.CFBundleIdentifier === 'com.apple.Preferences'),
        );
        attempt.controlSystemMetadataChecked = true;
        controlPID = exactLaunchPID(
            quiet(
                'owned-control-launch',
                '/usr/bin/xcrun',
                ['simctl', 'launch', simulator, 'com.apple.Preferences'],
                120000,
                4096,
            ),
            'com.apple.Preferences',
        );
        attempt.controlLaunchAccepted = true;
        attempt.stage = 'owned-research-install';
        save();
        own();
        attempt.researchInstallAttempted = true;
        save();
        quiet('owned-research-install', '/usr/bin/xcrun', ['simctl', 'install', simulator, app], 180000);
        const container = quiet('owned-research-container', '/usr/bin/xcrun', [
            'simctl',
            'get_app_container',
            simulator,
            bundle,
            'data',
        ]);
        assert(isAbsolute(container) && lstatSync(container).isDirectory() && !lstatSync(container).isSymbolicLink());
        statusPath = join(container, 'Documents', `probe-status-${runID}.json`);
        assert(!existsSync(statusPath));
        attempt.stage = 'local-sql-relay';
        save();
        relay = await createNativeRelayBridge({ archivePath: archive, scratch });
        const relayArchivePath = regular(join(scratch, 'native-relay/pglite.tgz'), 32 * 1024 * 1024);
        assert.equal(
            'sha512-' + createHash('sha512').update(readFileSync(relayArchivePath)).digest('base64'),
            pglitePin.integrity,
        );
        relayArchive = {
            path: relayArchivePath,
            sha256: hash(relayArchivePath),
            version: pglitePin.version,
            integrity: pglitePin.integrity,
        };
        for (const phase of NATIVE_PROVIDER_BOOTSTRAP_PHASES) {
            own();
            stable();
            attempt.stage = phase;
            attempt.launchPID = null;
            save();
            const output = quiet(
                'owned-research-launch',
                '/usr/bin/xcrun',
                [
                    'simctl',
                    'launch',
                    '--terminate-running-process',
                    simulator,
                    bundle,
                    '--probe',
                    phase,
                    runID,
                    aliceID,
                    bobID,
                ],
                30000,
                4096,
            );
            const pid = exactLaunchPID(output, bundle);
            attempt.launchPID = pid;
            save();
            const deadline = Date.now() + (phase === 'replay' ? 180000 : 60000);
            let status;
            while (Date.now() < deadline) {
                if (existsSync(statusPath)) {
                    const raw = JSON.parse(readFileSync(regular(statusPath, 65536), 'utf8'));
                    // Stale preceding phase receipts are not the new launch's
                    // completion. Never replay prepare to resolve uncertainty.
                    if (raw.runID === runID && raw.phase === phase && raw.pid === pid) {
                        status = inspectNativeProviderBootstrapStatus(raw, runID, phase, pid);
                        if (status.status !== 'running') break;
                    }
                }
                await delay(250);
            }
            attempt.nativeStatusObserved = status
                ? { phase, status: status.status, stage: status.stage }
                : { phase, status: 'missing' };
            save();
            assert(status?.status === 'passed' && status.stage === 'complete');
            if (phase === 'replay') coordinatorAssertions = status.coordinatorAssertions;
            const summary = await relay.afterPhase(phase, join(container, 'Documents'), runID);
            if (phase === 'relay-replay') {
                assert(summary);
                relaySummary = summary;
            }
            attempt.completedPhases.push({
                runID,
                phase,
                pid,
                status: 'passed',
                stage: 'complete',
                launchExitStatus: 0,
                launchTimedOut: false,
            });
            stable();
            save();
            console.info('Native provider bootstrap phase completed: ' + phase);
        }
        assert(Number.isSafeInteger(coordinatorAssertions) && coordinatorAssertions > 0);
        assert(relaySummary);
        attempt.stage = 'owned-app-uninstall';
        save();
        own();
        quiet('owned-app-uninstall', '/usr/bin/xcrun', ['simctl', 'uninstall', simulator, bundle]);
        attempt.appUninstalled = true;
        accepted = {
            schemaVersion: 1,
            kind: 'cached-provider-native-bootstrap',
            status: 'passed',
            runID,
            bundle,
            cacheRoot,
            providerPin: {
                version: nativePin.version,
                uniffiVersion: nativePin.uniffiVersion,
                protocol: nativePin.protocol,
                manifestSha256: nativePin.manifestSha256,
                lockfileSha256: nativePin.lockfileSha256,
            },
            node: { version: process.version, execPath: process.execPath, sha256: hash(process.execPath) },
            sourceHashes: Object.fromEntries(Object.entries(sourceInputs).map(([p, h]) => [join(checkout, p), h])),
            cacheArtifacts: Object.entries(cacheArtifacts).map(([p, sha256]) => ({ path: join(cacheRoot, p), sha256 })),
            compiled: {
                platform: 'iphonesimulator',
                target: 'arm64-apple-ios17.0-simulator',
                executable: { path: executable, sha256: hash(executable) },
                unsignedBeforeSign: true,
                embeddedEntitlements: {
                    xmlSha256: entitlements.__entitlements,
                    derSha256: entitlements.__ents_der,
                    measured: inspectSimulatorEntitlementSections(readFileSync(executable), entitlements),
                },
            },
            signing: { performed: true, signedOnlyOwnedApp: true, hostCodesignEntitlementsSupplied: false },
            runtime: {
                requestedRuntimeId: runtime.identifier,
                runtimeId: runtime.identifier,
                runtimeVersion: runtime.version,
                runtimeBuild: runtime.buildversion,
                deviceTypeId: deviceType,
                observedAvailable: true,
            },
            ownedSimulator: { id: simulator, name: ownedName, createdNew: true, priorDevicesMutated: false },
            controlLaunch: {
                bundle: 'com.apple.Preferences',
                exitStatus: 0,
                timedOut: false,
                returnedPID: controlPID,
                boundMs: 120000,
                systemAppMetadataChecked: true,
            },
            phases: attempt.completedPhases,
            coordinatorAssertions,
            relay: relaySummary,
            relayArchive,
            cleanup: null,
            freshRustBuild: false,
            sourceBinaryProvenanceProved: false,
            independentlyReviewed: false,
            liveAuth: false,
            physicalDeviceExecution: false,
            productionTouched: false,
            humanDevicesChanged: false,
            hostedActorsChanged: false,
            primaryTargetsBuilt: false,
            sharedSlotWaitMs: waited,
        };
        attempt.status = 'executed-awaiting-cleanup';
    }
} catch {
    if (attempt.status !== 'queued-unrun') attempt.status = 'failed';
    attempt.failedStage = attempt.stage;
    process.exitCode = 1;
    console.error('Provider bootstrap incomplete; private attempt retained without acceptance.');
} finally {
    if (relay) {
        try {
            await relay.close();
            attempt.relayClosed = true;
        } catch {
            attempt.status = 'cleanup-incomplete';
            process.exitCode = 1;
        }
    }
    if (simulator) {
        try {
            const device = own();
            if (device.state !== 'Shutdown')
                quiet('owned-simulator-shutdown', '/usr/bin/xcrun', ['simctl', 'shutdown', simulator]);
            quiet('owned-simulator-delete', '/usr/bin/xcrun', ['simctl', 'delete', simulator]);
            attempt.ownedSimulatorRemoved = true;
        } catch {
            attempt.status = 'cleanup-incomplete';
            process.exitCode = 1;
        }
    }
    if (accepted && attempt.status === 'executed-awaiting-cleanup') {
        try {
            stable();
            accepted.cleanup = {
                appUninstalled: attempt.appUninstalled === true,
                simulatorRemoved: attempt.ownedSimulatorRemoved === true,
                relayClosed: attempt.relayClosed === true,
                sourcesStable: true,
                cacheStable: true,
                executableStable: true,
            };
            accepted.sharedSlotWaitMs = waited;
            const expectedSources = Object.fromEntries(
                Object.entries(sourceInputs).map(([p, h]) => [join(checkout, p), h]),
            );
            const checked = inspectNativeProviderBootstrapReceipt(accepted, checkout, expectedSources);
            const path = join(scratch, 'provider-bootstrap-receipt.json');
            writeFileSync(path, JSON.stringify(checked, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
            attempt.acceptedReceipt = { path, sha256: hash(path) };
            attempt.acceptedReceiptCreated = true;
            attempt.status = 'passed';
            attempt.stage = 'complete';
        } catch {
            attempt.status = 'acceptance-refused';
            process.exitCode = 1;
        }
    }
    attempt.sharedSlotWaitMs = waited;
    save();
}
if (attempt.status === 'passed')
    console.info(
        'PASS fresh cached-provider native/SQL execution; not Rust provenance, HTTPS, physical devices or release readiness.',
    );
