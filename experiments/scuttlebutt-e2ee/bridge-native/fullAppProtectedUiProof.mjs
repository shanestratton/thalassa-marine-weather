/** Fresh owned full-App protected exchange fixture. Synthetic Auth/relay only.
 * Node24 fullAppProtectedUiProof.mjs CACHE FRAMEWORK_RECEIPT EXCHANGE_RECEIPT WEB_RECEIPT WEB_SHA [REMAINING_WAIT_MS]
 * No cached-app resume: this scenario requires its own source-bound native build.
 */
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
    chmodSync,
    cpSync,
    existsSync,
    lstatSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    realpathSync,
    writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { inspectWindowBuildReceipt } from '../full-app-pilot/windowProofContract.mjs';
import {
    createFullAppProtectedNativeResource,
    inspectFullAppProtectedNativeResource,
    inspectFullAppProtectedNativeEnvelope,
    inspectFullAppProtectedNativeReceipt,
    FULL_APP_PROTECTED_NATIVE_SCENARIO,
    FULL_APP_PROTECTED_NATIVE_PHASES,
    inspectFullAppProtectedWait,
    addFullAppProtectedChildWait,
    requireFullAppProtectedCleanup,
} from './fullAppProtectedUiContract.mjs';
import {
    inspectCachedRuntimeSelection,
    inspectControlLaunchMetadata,
    inspectControlLaunchObservation,
    FULL_APP_CONTROL_BUNDLE,
    FULL_APP_CONTROL_LAUNCH_BOUND_MS,
} from './fullAppUiResumeContract.mjs';
import { inspectSimulatorEntitlementSections } from './machOEntitlementEvidence.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const checkout = resolve(here, '../../..');
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'thalassa-full-root-protected-')));
chmodSync(scratch, 0o700);
const attemptID = randomUUID(),
    runID = randomUUID(),
    nonce = randomBytes(32).toString('hex');
const bundle = 'app.thalassa.research.scuttlebutt-auth';
const receiptPath = join(scratch, 'run-receipt.json');
const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const receipt = {
    version: 1,
    attemptID,
    runID,
    scenario: FULL_APP_PROTECTED_NATIVE_SCENARIO,
    status: 'preparing',
    phase: 'inputs',
    scratch,
    nativeProtectedExchangeAccepted: false,
    syntheticSdkAuthAndRelay: true,
    liveAuthProved: false,
    liveRelayProved: false,
    physicalDeviceExecution: false,
    realOsLifecycleProved: false,
    independentlyReviewed: false,
    productionTouched: false,
    humanDevicesChanged: false,
    hostedActorsChanged: false,
    primaryCapSyncExecuted: false,
    sourceHashes: {},
    startedAtUTC: new Date().toISOString(),
};
const save = () => writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
save();
console.info('Nonsecret full-root protected native receipt: ' + receiptPath);
let simulator, ownedName, statusFile, phaseFile, web, webReceipt, expectedWebHash;
let waited = 0,
    waitBudget = 120000;
let prerequisiteInputs = [],
    builtInputs = [],
    nativeObservationPassed = false;
function regular(path, limit = 16 * 1024 * 1024) {
    assert(isAbsolute(path));
    for (let p = path; p !== dirname(p); p = dirname(p)) assert(!lstatSync(p).isSymbolicLink());
    const s = lstatSync(path);
    assert(s.isFile() && s.uid === process.getuid() && s.size > 0 && s.size <= limit);
    return realpathSync(path);
}
function treeHashes(root) {
    const result = {};
    const visit = (dir) => {
        assert(!lstatSync(dir).isSymbolicLink());
        for (const e of readdirSync(dir, { withFileTypes: true })) {
            const path = join(dir, e.name);
            assert(!e.isSymbolicLink());
            if (e.isDirectory()) visit(path);
            else {
                assert(e.isFile());
                result[relative(root, path)] = hash(path);
            }
            assert(Object.keys(result).length <= 20000);
        }
    };
    visit(root);
    return result;
}
function stable() {
    assert.equal(hash(process.execPath), '798d7f9c0d38051608d11ba87a12fbb01e92bfa457cd77ec612b5bad2a73a05e');
    for (const row of [...prerequisiteInputs, ...builtInputs])
        assert.equal(hash(regular(row.path, 256 * 1024 * 1024)), row.sha256);
    for (const [name, expected] of Object.entries(receipt.sourceHashes))
        assert(hash(join(checkout, name)) === expected);
    if (web) {
        assert(hash(webReceipt) === expectedWebHash);
        for (const row of [...web.sourceInputs, ...web.proofSources, ...web.artifacts])
            assert(hash(row.path) === row.sha256);
    }
}
async function slot() {
    process.title = 'thalassa protected-root awaiting shared slot';
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
        const decision = inspectFullAppProtectedWait({
            limitMs: waitBudget,
            spentMs: waited,
            otherHeavyProcesses: others.length,
        });
        if (decision === 'exhausted') {
            receipt.status = 'queued-unrun';
            throw new Error('Shared opportunity expired');
        }
        if (decision === 'ready') {
            process.title = 'vite build slot: isolated protected full-root fixture';
            return;
        }
        const before = Date.now();
        await delay(Math.min(5000, waitBudget - waited));
        waited += Date.now() - before;
        receipt.sharedSlotWaitMs = waited;
        save();
    }
}
function operationName(bin, args) {
    if (bin === process.execPath) return 'native-build';
    if (bin === '/usr/bin/codesign') return 'codesign-owned-copy';
    if (bin === '/usr/bin/plutil') return 'owned-control-metadata-convert';
    if (bin === '/usr/bin/xcrun' && args[0] === 'simctl')
        return (
            {
                list: 'simulator-inventory',
                listapps: 'owned-control-app-inventory',
                create: 'simulator-create',
                boot: 'simulator-boot',
                bootstatus: 'simulator-bootstatus',
                install: 'simulator-install',
                get_app_container: 'owned-app-container',
                shutdown: 'owned-simulator-shutdown',
                delete: 'owned-simulator-delete',
                launch: args.at(-1) === FULL_APP_CONTROL_BUNDLE ? 'owned-control-app-launch' : 'owned-app-launch',
            }[args[1]] ?? 'unknown-owned-operation'
        );
    return 'unknown-owned-operation';
}
function quiet(bin, args, timeout = 30000, maxBuffer = 8 * 1024 * 1024, input) {
    receipt.lastOperation = operationName(bin, args);
    receipt.lastOperationExitStatus = null;
    receipt.lastOperationTimedOut = false;
    save();
    const r = spawnSync(bin, args, { encoding: 'utf8', timeout, maxBuffer, ...(input === undefined ? {} : { input }) });
    receipt.lastOperationExitStatus = Number.isInteger(r.status) ? r.status : null;
    receipt.lastOperationTimedOut = r.error?.code === 'ETIMEDOUT';
    if (receipt.lastOperation === 'owned-app-launch') {
        const found = /^app\.thalassa\.research\.scuttlebutt-auth: ([1-9][0-9]{0,8})\s*$/.exec(r.stdout ?? '');
        receipt.ownedLaunchPID = found ? Number(found[1]) : null;
    }
    if (receipt.lastOperation === 'owned-control-app-launch')
        receipt.controlLaunchObservation = inspectControlLaunchObservation({
            exitStatus: receipt.lastOperationExitStatus,
            timedOut: receipt.lastOperationTimedOut,
            stdout: r.stdout ?? '',
        });
    if (receipt.phase === 'native-build') {
        const path = r.stdout?.match(/Nonsecret research messaging build receipt: (\/[^\n]+)/)?.[1];
        if (path && existsSync(path)) {
            regular(path);
            receipt.buildReceipt = { path, sha256: hash(path) };
            const child = JSON.parse(readFileSync(path, 'utf8'));
            const accounting = addFullAppProtectedChildWait({
                limitMs: waitBudget,
                spentMs: waited,
                childSpentMs: child.sharedSlotWaitMs,
                childStatus: child.status,
            });
            waited = accounting.spentMs;
            receipt.sharedSlotWaitMs = waited;
            if (accounting.queued) receipt.status = 'queued-unrun';
        }
    }
    save();
    assert(!r.error && r.status === 0, 'Owned protected full-root step refused');
    return r.stdout.trim();
}
function own() {
    const inventory = JSON.parse(quiet('/usr/bin/xcrun', ['simctl', 'list', 'devices', '--json'])).devices;
    const rows = Object.values(inventory)
        .flat()
        .filter((d) => d.udid === simulator);
    assert(rows.length === 1 && rows[0].name === ownedName);
    return rows[0];
}
function readPhase() {
    if (!phaseFile || !existsSync(phaseFile)) return null;
    const p = JSON.parse(readFileSync(regular(phaseFile, 4096), 'utf8'));
    assert(
        p.version === 1 &&
            Object.keys(p).sort().join(',') === 'phase,version' &&
            FULL_APP_PROTECTED_NATIVE_PHASES.includes(p.phase),
    );
    return p.phase;
}
function copyNativeEnvelope() {
    if (!statusFile || !existsSync(statusFile)) return null;
    const raw = JSON.parse(readFileSync(regular(statusFile, 65536), 'utf8'));
    const native = inspectFullAppProtectedNativeEnvelope(raw, runID, nonce);
    const copy = join(scratch, 'native-receipt.json');
    assert(!existsSync(copy));
    writeFileSync(copy, JSON.stringify(native, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    receipt.nativeReceipt = { path: copy, sha256: hash(copy) };
    return native;
}
try {
    assert(checkout === '/Users/shanestratton/.codex/worktrees/scuttlebutt-e2ee/thalassa-marine-weather');
    assert(process.platform === 'darwin' && process.arch === 'arm64');
    assert.equal(process.version, 'v24.21.0');
    assert.equal(process.execPath, '/opt/homebrew/Cellar/node@24/24.21.0_2/bin/node');
    assert.equal(
        hash(regular(process.execPath, 256 * 1024 * 1024)),
        '798d7f9c0d38051608d11ba87a12fbb01e92bfa457cd77ec612b5bad2a73a05e',
    );
    assert(
        Object.keys(process.env).every((key) => ['PATH', 'LANG', 'TMPDIR', '__CF_USER_TEXT_ENCODING'].includes(key)),
    );
    assert(
        process.env.PATH === '/usr/bin:/bin' &&
            process.env.LANG === 'en_AU.UTF-8' &&
            process.env.TMPDIR === '/private/tmp',
    );
    if (process.env.__CF_USER_TEXT_ENCODING !== undefined)
        assert(
            /^(?:0x[0-9a-fA-F]+|[0-9]+)(?::(?:0x[0-9a-fA-F]+|[0-9]+)){2}$/.test(process.env.__CF_USER_TEXT_ENCODING),
        );
    const args = process.argv.slice(2);
    assert(args.length === 5 || args.length === 6);
    const [cache, frameworksPath, priorPath] = args;
    [webReceipt, expectedWebHash] = args.slice(3, 5);
    if (args.length === 6) {
        assert(/^(?:0|[1-9][0-9]{0,5})$/.exec(args[5])?.[0] === args[5] && Number(args[5]) <= 120000);
        waitBudget = Number(args[5]);
    }
    receipt.initialRemainingSlotBudgetMs = waitBudget;
    for (const p of [cache, frameworksPath, priorPath, webReceipt]) assert(isAbsolute(p));
    regular(frameworksPath);
    regular(priorPath);
    // Pin this legitimately regenerated prerequisite; a guessed marker or
    // hash-matching archive alone cannot supply completed exchange evidence.
    assert.equal(hash(priorPath), '19e7c0b7208d890365c0bddaab4c9e309d5cd2d6be4bb0ec3502004d0ec56016');
    const prior = JSON.parse(readFileSync(priorPath, 'utf8'));
    assert(prior.status === 'passed' && prior.observation === 'native-encrypted-https-sql-proof-passed');
    prerequisiteInputs = [
        { path: priorPath, sha256: hash(priorPath) },
        ...Object.entries(prior.sourceHashes).map(([path, sha256]) => ({ path, sha256 })),
        ...Object.entries(prior.cacheHashes).map(([path, sha256]) => ({ path, sha256 })),
        prior.providerBootstrapEvidence,
        { path: frameworksPath, sha256: hash(frameworksPath) },
    ];
    assert(Object.keys(prior.sourceHashes).length === 61 && Object.keys(prior.cacheHashes).length === 4);
    for (const [path, sha256] of Object.entries(prior.sourceHashes)) {
        assert(path.startsWith(checkout + '/'));
        assert.equal(hash(regular(path)), sha256);
    }
    for (const [path, sha256] of Object.entries(prior.cacheHashes)) {
        assert.equal(hash(regular(join(cache, relative(prior.cacheRoot, path)), 256 * 1024 * 1024)), sha256);
    }
    regular(webReceipt);
    assert(
        /^[0-9a-f]{64}$/.test(expectedWebHash) && expectedWebHash.length === 64 && hash(webReceipt) === expectedWebHash,
    );
    web = inspectWindowBuildReceipt(JSON.parse(readFileSync(webReceipt, 'utf8')), checkout);
    receipt.preservedWebReceipt = { path: webReceipt, sha256: expectedWebHash };
    receipt.webRecompiled = false;
    const frameworks = JSON.parse(readFileSync(frameworksPath, 'utf8'));
    assert(frameworks.status === 'passed');
    receipt.frameworkReceipt = { path: frameworksPath, sha256: hash(frameworksPath) };
    receipt.nativeExchangeReceipt = { path: priorPath, sha256: hash(priorPath) };
    const names = [
        'bridge-native/fullAppProtectedUiProof.mjs',
        'bridge-native/fullAppProtectedUiContract.mjs',
        'bridge-native/fullAppUiContract.mjs',
        'bridge-native/fullAppUiResumeContract.mjs',
        'bridge-native/build.mjs',
        'bridge-native/generate_project.rb',
        'bridge-native/machOEntitlementEvidence.mjs',
        'bridge-native/ResearchApp.swift',
        'bridge-native/ScuttlebuttResearchAuthPlugin.swift',
        'bridge-native/ResearchAuthHost.swift',
        'bridge-native/ResearchLocalUiFixture.swift',
        'bridge-native/ResearchFullAppProtectedUiFixture.swift',
        'bridge-native/ResearchFullAppProtectedHttpFence.swift',
        'bridge-native/ResearchProtectedUiFixture.swift',
        'bridge-native/ResearchProtectedUiRelay.swift',
        'full-app-pilot/nativeProtectedUiFixture.js',
    ];
    receipt.sourceHashes = Object.fromEntries(
        names.map((n) => ['experiments/scuttlebutt-e2ee/' + n, hash(join(here, '..', n))]),
    );
    const template = readFileSync(join(here, '../full-app-pilot/nativeProtectedUiFixture.js'), 'utf8');
    const resource = createFullAppProtectedNativeResource(template, runID, nonce);
    inspectFullAppProtectedNativeResource(resource, template);
    const fixture = join(scratch, 'fixture-resource.json');
    writeFileSync(fixture, JSON.stringify(resource), { mode: 0o600, flag: 'wx' });
    receipt.fixtureResource = { path: fixture, sha256: hash(fixture) };
    stable();
    await slot();
    stable();
    receipt.phase = 'native-build';
    save();
    process.title = 'thalassa protected-root awaiting owned compile';
    quiet(
        process.execPath,
        [
            join(here, 'build.mjs'),
            cache,
            frameworks.products,
            web.dist,
            '--platform',
            'iphonesimulator',
            '--local-ui-fixture-file',
            fixture,
            '--prior-native-exchange-receipt',
            priorPath,
            '--local-ui-frameworks-receipt',
            frameworksPath,
            '--full-app-web-receipt',
            webReceipt,
            '--slot-wait-ms',
            String(Math.max(0, waitBudget - waited)),
        ],
        450000,
    );
    assert(receipt.buildReceipt);
    const build = JSON.parse(readFileSync(receipt.buildReceipt.path, 'utf8'));
    assert(
        build.status === 'passed' &&
            build.platform === 'iphonesimulator' &&
            build.compileOnly === true &&
            build.localUiFixture === true &&
            build.fullAppProtectedUiFixture === true &&
            build.fullAppUiFixture === false &&
            build.protectedUiFixture === false &&
            build.unsignedApplication === true &&
            build.applicationSignatureCheckedAbsent === true &&
            build.signingPerformed === false &&
            build.primaryCapSyncExecuted === false &&
            build.fullAppWebReceiptSha256 === expectedWebHash &&
            build.localUiFixtureResourceSha256 === hash(fixture) &&
            build.fullAppFixtureContractSha256 === hash(join(here, 'fullAppProtectedUiContract.mjs')),
    );
    receipt.nativeRecompiled = true;
    builtInputs = Object.entries(build.sourceHashes).map(([path, sha256]) => ({ path, sha256 }));
    for (const [p, h] of Object.entries(build.sourceHashes)) assert(hash(regular(p)) === h);
    await slot();
    stable();
    receipt.phase = 'ad-hoc-sign-owned-copy';
    save();
    assert.deepEqual(treeHashes(build.artifact), build.artifactHashes);
    const app = join(scratch, 'signed-fixture/ScuttlebuttResearchAuth.app');
    cpSync(build.artifact, app, { recursive: true, errorOnExist: true, force: false });
    assert.deepEqual(treeHashes(app), build.artifactHashes);
    for (const name of ['Capacitor', 'Cordova'])
        quiet('/usr/bin/codesign', ['--force', '--sign', '-', join(app, 'Frameworks', name + '.framework')]);
    quiet('/usr/bin/codesign', ['--force', '--sign', '-', app]);
    assert(
        build.simulatorLinkEntitlements?.embeddedInMachO === true &&
            build.simulatorLinkEntitlements.hostCodesignGrant === false,
    );
    receipt.hostCodesignEntitlementsSupplied = false;
    receipt.signedOnlyOwnedCopy = true;
    receipt.signedArtifactHashes = treeHashes(app);
    receipt.measuredSignedEntitlementSections = inspectSimulatorEntitlementSections(
        readFileSync(join(app, 'ScuttlebuttResearchAuth')),
        {
            __entitlements: build.simulatorLinkEntitlements.xmlSha256,
            __ents_der: build.simulatorLinkEntitlements.derSha256,
        },
    );
    assert.deepEqual(treeHashes(build.artifact), build.artifactHashes);
    receipt.unsignedOriginalPreserved = true;
    const inventory = JSON.parse(quiet('/usr/bin/xcrun', ['simctl', 'list', 'runtimes', '--json'])).runtimes;
    const selected = inspectCachedRuntimeSelection(inventory, 'com.apple.CoreSimulator.SimRuntime.iOS-27-0');
    receipt.runtimeSelection = selected;
    ownedName = 'Thalassa full-root protected ' + attemptID;
    simulator = quiet('/usr/bin/xcrun', ['simctl', 'create', ownedName, selected.deviceTypeId, selected.runtimeId]);
    assert(/^[0-9A-F-]{36}$/.test(simulator) && simulator.length === 36);
    receipt.ownedSimulator = { id: simulator, name: ownedName };
    receipt.phase = 'owned-simulator-boot';
    save();
    own();
    quiet('/usr/bin/xcrun', ['simctl', 'boot', simulator]);
    quiet('/usr/bin/xcrun', ['simctl', 'bootstatus', simulator, '-b'], 180000);
    own();
    receipt.phase = 'owned-control-launch-probe';
    receipt.controlLaunchBundle = FULL_APP_CONTROL_BUNDLE;
    receipt.controlLaunchBoundMs = FULL_APP_CONTROL_LAUNCH_BOUND_MS;
    receipt.researchInstallAttempted = false;
    save();
    const apps = quiet('/usr/bin/xcrun', ['simctl', 'listapps', simulator], 30000, 1024 * 1024);
    assert(Buffer.byteLength(apps, 'utf8') <= 1024 * 1024);
    const converted = quiet('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], 10000, 1024 * 1024, apps);
    receipt.controlAppMetadata = inspectControlLaunchMetadata(JSON.parse(converted));
    save();
    quiet(
        '/usr/bin/xcrun',
        ['simctl', 'launch', simulator, FULL_APP_CONTROL_BUNDLE],
        FULL_APP_CONTROL_LAUNCH_BOUND_MS,
        4096,
    );
    assert(receipt.controlLaunchObservation.launchCallAccepted);
    receipt.researchInstallAttempted = true;
    save();
    quiet('/usr/bin/xcrun', ['simctl', 'install', simulator, app], 180000);
    const container = quiet('/usr/bin/xcrun', ['simctl', 'get_app_container', simulator, bundle, 'data']);
    assert(isAbsolute(container));
    statusFile = join(container, 'Documents/research-full-app-protected-ui-status-' + runID + '.json');
    phaseFile = join(container, 'Documents/research-full-app-protected-ui-phase.json');
    assert(!existsSync(statusFile));
    receipt.phase = 'actual-full-root-protected';
    save();
    quiet('/usr/bin/xcrun', ['simctl', 'launch', '--terminate-running-process', simulator, bundle]);
    assert(Number.isSafeInteger(receipt.ownedLaunchPID) && receipt.ownedLaunchPID > 0);
    const deadline = Date.now() + 180000;
    let status = null;
    receipt.lastOperation = 'native-status-poll';
    receipt.lastOperationExitStatus = null;
    receipt.lastOperationTimedOut = false;
    save();
    while (Date.now() < deadline) {
        if (existsSync(statusFile)) {
            const parsed = JSON.parse(readFileSync(regular(statusFile, 65536), 'utf8'));
            const checked = inspectFullAppProtectedNativeEnvelope(parsed, runID, nonce);
            status = checked.status;
            if (status !== 'running') break;
        }
        await delay(250);
    }
    receipt.nativeStatusDeadlineReached = status === null || status === 'running';
    receipt.nativeLaunchPhase = readPhase();
    const native = copyNativeEnvelope();
    save();
    receipt.lastOperation = 'native-final-validate';
    save();
    inspectFullAppProtectedNativeReceipt(native, runID, nonce);
    stable();
    for (const [p, h] of Object.entries(build.sourceHashes)) assert(hash(p) === h);
    nativeObservationPassed = true;
    receipt.status = 'native-observed-cleanup-pending';
    receipt.phase = 'owned-cleanup';
} catch {
    if (receipt.status !== 'queued-unrun') receipt.status = 'failed';
    receipt.failedOrQueuedPhase = receipt.phase;
    receipt.failedOperation = receipt.lastOperation ?? null;
    receipt.failedOperationExitStatus = receipt.lastOperationExitStatus ?? null;
    receipt.failedOperationTimedOut = receipt.lastOperationTimedOut ?? false;
    if (statusFile && phaseFile && !receipt.nativeReceipt) {
        receipt.failedObservationCapture = {
            phaseFilePresent: existsSync(phaseFile),
            nativeFilePresent: existsSync(statusFile),
            outerDriverAccepted: false,
        };
        try {
            receipt.nativeLaunchPhase = readPhase();
            copyNativeEnvelope();
        } catch {
            /* Fixed presence/refusal only; no arbitrary JSON retained. */
        }
    }
    process.exitCode = 1;
    console.error('Protected full-root fixture incomplete; bounded owned receipt retained.');
} finally {
    receipt.lastOperationBeforeCleanup = receipt.lastOperation ?? null;
    receipt.expectedNativeFilePresent = statusFile ? existsSync(statusFile) : null;
    receipt.expectedPhaseFilePresent = phaseFile ? existsSync(phaseFile) : null;
    if (simulator) {
        try {
            const d = own();
            if (d.state !== 'Shutdown') quiet('/usr/bin/xcrun', ['simctl', 'shutdown', simulator]);
            quiet('/usr/bin/xcrun', ['simctl', 'delete', simulator]);
            const all = Object.values(
                JSON.parse(quiet('/usr/bin/xcrun', ['simctl', 'list', 'devices', '--json'])).devices,
            ).flat();
            const idAbsent = !all.some((d) => d.udid === simulator),
                nameAbsent = !all.some((d) => d.name === ownedName);
            stable();
            requireFullAppProtectedCleanup({ idAbsent, nameAbsent, sourcesUnchanged: true });
            receipt.ownedSimulatorRemoved = true;
            receipt.cleanup = { idAbsent, nameAbsent, sourcesUnchanged: true };
        } catch {
            receipt.ownedSimulatorRemoved = false;
            receipt.status = 'cleanup-incomplete';
            process.exitCode = 1;
        }
    }
    if (nativeObservationPassed && receipt.ownedSimulatorRemoved === true) {
        receipt.status = 'passed';
        receipt.phase = 'complete';
        receipt.nativeProtectedExchangeAccepted = true;
    }
    receipt.sharedSlotWaitMs = waited;
    receipt.completedAtUTC = new Date().toISOString();
    save();
}
if (receipt.status === 'passed')
    console.info(
        'PASS scoped native-provider full-root exchange over synthetic Auth/relay; no physical, OS-lifecycle or release acceptance.',
    );
