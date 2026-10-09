/** Owned WK full-root fixture. Synthetic Auth only, no human/production/hosted actors.
 * Node24 fullAppUiProof.mjs CACHE FRAMEWORK_RECEIPT EXCHANGE_RECEIPT WEB_RECEIPT WEB_RECEIPT_SHA256
 * Node24 fullAppUiProof.mjs --resume-unsigned BUILD_RECEIPT BUILD_SHA256 WEB_RECEIPT WEB_SHA256 [REMAINING_WAIT_MS] [--runtime EXACT_INSTALLED_ID] [--control-launch-probe]
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Buffer } from 'node:buffer';
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
    createFullAppNativeResource,
    inspectFullAppNativeReceipt,
    inspectFullAppNativeEnvelope,
    inspectFullAppNativeResource,
    FULL_APP_NATIVE_PHASES,
    FULL_APP_NATIVE_SCENARIO,
} from './fullAppUiContract.mjs';
import {
    inspectFullAppCachedBuild,
    inspectCachedResumeOptions,
    inspectCachedRuntimeSelection,
    inspectFailedLaunchObservation,
    inspectControlLaunchMetadata,
    inspectControlLaunchObservation,
    FULL_APP_CONTROL_BUNDLE,
} from './fullAppUiResumeContract.mjs';
import { inspectSimulatorEntitlementSections } from './machOEntitlementEvidence.mjs';

const here = dirname(fileURLToPath(import.meta.url)),
    checkout = resolve(here, '../../..');
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'thalassa-full-root-native-')));
chmodSync(scratch, 0o700);
const attemptID = randomUUID();
let runID = randomUUID(),
    nonce = randomBytes(32).toString('hex');
const receiptPath = join(scratch, 'run-receipt.json'),
    bundle = 'app.thalassa.research.scuttlebutt-auth';
const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const receipt = {
    version: 1,
    runID,
    attemptID,
    scenario: FULL_APP_NATIVE_SCENARIO,
    status: 'preparing',
    phase: 'inputs',
    scratch,
    realFullAppNativeStartupAccepted: false,
    actualEncryptionProved: false,
    syntheticSdkAndNativeAuth: true,
    liveAuthProved: false,
    physicalDeviceExecution: false,
    productionTouched: false,
    humanDevicesChanged: false,
    hostedActorsChanged: false,
    primaryCapSyncExecuted: false,
    sourceHashes: {},
    startedAtUTC: new Date().toISOString(),
};
const save = () => writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
save();
console.info('Nonsecret full-root native receipt: ' + receiptPath);
let simulator, ownedName, web, cache, frameworkReceipt, prior, webReceipt, expectedWebHash;
let expectedStatusFile, expectedPhaseFile;
let cachedBuildPath, cachedBuildHash, cachedPlan;
let requestedRuntimeId = null;
let controlLaunchProbe = false;
let waited = 0;
let waitBudget = 120000;
function regular(path, limit = 16 * 1024 * 1024) {
    assert(isAbsolute(path));
    const s = lstatSync(path);
    assert(s.isFile() && !s.isSymbolicLink() && s.size > 0 && s.size <= limit);
    return realpathSync(path);
}
function stable() {
    for (const [name, expected] of Object.entries(receipt.sourceHashes))
        assert(hash(join(checkout, name)) === expected);
    if (web) {
        assert(hash(webReceipt) === expectedWebHash);
        for (const row of [...web.sourceInputs, ...web.proofSources, ...web.artifacts])
            assert(hash(row.path) === row.sha256);
    }
    if (cachedPlan) {
        assert(hash(cachedBuildPath) === cachedBuildHash);
        for (const [path, expected] of Object.entries(cachedPlan.sourceHashes)) assert(hash(path) === expected);
        assert.deepEqual(treeHashes(cachedPlan.artifactRoot), cachedPlan.artifactHashes);
        assert.deepEqual(treeHashes(cachedPlan.bindingRoot), cachedPlan.bindings);
        assert(hash(cachedPlan.providerPath) === cachedPlan.providerHash);
        for (const framework of cachedPlan.frameworkPlans)
            assert.deepEqual(treeHashes(framework.root), framework.hashes);
    }
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
async function slot() {
    process.title = 'thalassa native-root awaiting shared slot';
    for (;;) {
        const p = spawnSync('/usr/bin/pgrep', ['-fl', 'vite build|tsc|vitest'], { encoding: 'utf8', timeout: 10000 });
        assert(!p.error && [0, 1].includes(p.status));
        const other = p.stdout
            .split('\n')
            .filter(
                (s) =>
                    /^\d+\s/.test(s) &&
                    !s.startsWith(process.pid + ' ') &&
                    !/^\d+\s+(?:\/\S*\/)?(?:sh|bash|zsh|fish|env|xargs|pgrep)\s/.test(s),
            );
        if (!other.length) {
            process.title = 'vite build slot: isolated full-root native fixture';
            return;
        }
        if (waited >= waitBudget) {
            receipt.status = 'queued-unrun';
            throw new Error('Owned shared opportunity expired');
        }
        const before = Date.now();
        await delay(Math.min(5000, waitBudget - waited));
        waited += Date.now() - before;
    }
}
function operationName(bin, args) {
    if (bin === process.execPath) return 'native-build';
    if (bin === '/usr/bin/codesign') return 'codesign-owned-copy';
    if (bin === '/usr/bin/xcrun' && args[0] === 'simctl') {
        return (
            {
                list: 'simulator-inventory',
                listapps: 'owned-control-app-inventory',
                create: 'simulator-create',
                boot: 'simulator-boot',
                bootstatus: 'simulator-bootstatus',
                install: 'simulator-install',
                get_app_container: 'owned-app-container',
                launch:
                    args[args.length - 1] === FULL_APP_CONTROL_BUNDLE ? 'owned-control-app-launch' : 'owned-app-launch',
                shutdown: 'owned-simulator-shutdown',
                delete: 'owned-simulator-delete',
            }[args[1]] ?? 'unknown-owned-operation'
        );
    }
    return 'unknown-owned-operation';
}
function quiet(bin, args, timeout = 30000, maxBuffer = 8 * 1024 * 1024) {
    receipt.lastOperation = operationName(bin, args);
    receipt.lastOperationExitStatus = null;
    receipt.lastOperationTimedOut = false;
    save();
    const r = spawnSync(bin, args, { encoding: 'utf8', timeout, maxBuffer });
    receipt.lastOperationExitStatus = Number.isInteger(r.status) ? r.status : null;
    receipt.lastOperationTimedOut = r.error?.code === 'ETIMEDOUT';
    if (receipt.lastOperation === 'owned-app-launch') {
        const found = r.stdout?.match(/^app\.thalassa\.research\.scuttlebutt-auth: ([1-9][0-9]{0,8})\s*$/);
        receipt.ownedLaunchPID = found ? Number(found[1]) : null;
    }
    if (receipt.lastOperation === 'owned-control-app-launch') {
        receipt.controlLaunchObservation = inspectControlLaunchObservation({
            exitStatus: receipt.lastOperationExitStatus,
            timedOut: receipt.lastOperationTimedOut,
            stdout: r.stdout ?? '',
        });
    }
    save();
    if (receipt.phase === 'native-build') {
        const path = r.stdout?.match(/Nonsecret research messaging build receipt: (\/[^\n]+)/)?.[1];
        if (path && existsSync(path)) {
            receipt.buildReceipt = { path, sha256: hash(path) };
            const child = JSON.parse(readFileSync(path, 'utf8'));
            if (Number.isSafeInteger(child.sharedSlotWaitMs) && child.sharedSlotWaitMs >= 0) {
                waited += child.sharedSlotWaitMs;
            }
            if (child.status === 'queued-unrun') receipt.status = 'queued-unrun';
            save();
        }
    }
    assert(!r.error && r.status === 0, 'Owned full-root native step refused');
    return r.stdout.trim();
}
function own() {
    const list = JSON.parse(quiet('/usr/bin/xcrun', ['simctl', 'list', 'devices', '--json'])).devices;
    const rows = Object.values(list)
        .flat()
        .filter((d) => d.udid === simulator);
    assert(rows.length === 1 && rows[0].name === ownedName);
    return rows[0];
}
function verifyCachedNative(build, plan) {
    for (const [path, expected] of Object.entries(plan.sourceHashes)) assert(hash(regular(path)) === expected);
    assert.deepEqual(treeHashes(plan.artifactRoot), plan.artifactHashes);
    assert.deepEqual(treeHashes(plan.bindingRoot), plan.bindings);
    assert(hash(regular(plan.providerPath, 512 * 1024 * 1024)) === plan.providerHash);
    const pin = JSON.parse(readFileSync(join(here, '../vodozemac-native-pin.json'), 'utf8'));
    assert(pin.provider === 'vodozemac' && pin.protocol === 'olm-v1' && pin.shippingApproved === false);
    assert(plan.providerManifestHash === pin.manifestSha256 && plan.providerLockHash === pin.lockfileSha256);
    assert(
        hash(join(here, '../vodozemac-native/Cargo.toml')) === pin.manifestSha256 &&
            hash(join(here, '../vodozemac-native/Cargo.lock')) === pin.lockfileSha256,
    );
    for (const framework of plan.frameworkPlans) assert.deepEqual(treeHashes(framework.root), framework.hashes);
    assert.deepEqual(treeHashes(join(plan.artifactRoot, 'public')), plan.nativePublicHashes);
    const webHashes = Object.fromEntries(web.artifacts.map((row) => [relative(web.dist, row.path), row.sha256]));
    assert.deepEqual(webHashes, plan.originalWebHashes);
    const originalHtml = readFileSync(join(web.dist, 'index.html'), 'utf8');
    const permitted = 'connect-src https://kmtupdvwdgbhtssqqova.supabase.co';
    assert(originalHtml.split(permitted).length === 2 && !originalHtml.includes("connect-src 'none'"));
    assert(
        readFileSync(join(plan.artifactRoot, 'public/index.html'), 'utf8') ===
            originalHtml.replace(permitted, "connect-src 'none'; frame-src 'none'"),
    );
    assert(hash(regular(plan.resourcePath, 128 * 1024)) === plan.resourceHash);
    const resource = inspectFullAppNativeResource(
        JSON.parse(readFileSync(plan.resourcePath, 'utf8')),
        readFileSync(join(here, '../full-app-pilot/nativeUiFixture.js'), 'utf8'),
    );
    const researchPath = regular(join(plan.artifactRoot, 'research-config.json'), 16384);
    assert(hash(researchPath) === plan.researchConfigHash);
    const research = JSON.parse(readFileSync(researchPath, 'utf8'));
    assert(
        Object.keys(research).sort().join(',') === 'conversationId,projectOrigin,publicApiKey' &&
            research.projectOrigin === 'https://kmtupdvwdgbhtssqqova.supabase.co' &&
            research.conversationId === 'thalassa-e2ee-pilot-auth-v1' &&
            research.publicApiKey === 'sb_publishable_research_local_ui_fixture',
    );
    const config = JSON.parse(readFileSync(regular(join(plan.artifactRoot, 'capacitor.config.json'), 16384), 'utf8'));
    assert(
        Object.keys(config).sort().join(',') === 'appId,appName,ios,loggingBehavior,plugins,webDir' &&
            config.appId === bundle &&
            config.appName === 'Scuttlebutt Auth Research' &&
            config.webDir === 'public' &&
            config.loggingBehavior === 'none' &&
            Object.keys(config.plugins).join(',') === 'CapacitorHttp' &&
            Object.keys(config.plugins.CapacitorHttp).join(',') === 'enabled' &&
            config.plugins.CapacitorHttp.enabled === false &&
            Object.keys(config.ios).sort().join(',') === 'loggingBehavior,webContentsDebuggingEnabled' &&
            config.ios.loggingBehavior === 'none' &&
            config.ios.webContentsDebuggingEnabled === false,
    );
    assert(hash(join(here, 'machOEntitlementEvidence.mjs')) === plan.entitlementInspectorHash);
    const measured = inspectSimulatorEntitlementSections(
        readFileSync(plan.executablePath),
        plan.expectedEntitlementSections,
    );
    assert.deepEqual(measured, build.simulatorLinkEntitlements.measuredSections);
    const signature = spawnSync('/usr/bin/codesign', ['-dv', '--verbose=4', plan.executablePath], {
        encoding: 'utf8',
        timeout: 30000,
    });
    assert(!signature.error && signature.status !== 0 && /code object is not signed at all/.test(signature.stderr));
    receipt.cachedOriginalUnsignedChecked = true;
    receipt.cachedEntitlementSectionsRemeasured = measured;
    return resource;
}
try {
    assert(checkout === '/Users/shanestratton/.codex/worktrees/scuttlebutt-e2ee/thalassa-marine-weather');
    assert(process.platform === 'darwin' && process.arch === 'arm64' && /^v24\./.test(process.version));
    const extra = process.argv.slice(2);
    const resume = extra[0] === '--resume-unsigned';
    if (resume) {
        assert(extra.length >= 5 && extra.length <= 9);
        [cachedBuildPath, cachedBuildHash, webReceipt, expectedWebHash] = extra.slice(1, 5);
        const options = inspectCachedResumeOptions(extra.slice(5));
        if (options.remainingWaitMs !== null) waitBudget = options.remainingWaitMs;
        requestedRuntimeId = options.requestedRuntimeId;
        controlLaunchProbe = options.controlLaunchProbe === true;
    } else {
        assert(extra.length === 5 || extra.length === 6);
        [cache, frameworkReceipt, prior, webReceipt, expectedWebHash] = extra;
    }
    if (!resume && extra.length === 6) {
        assert(/^(?:0|[1-9][0-9]{0,5})$/.exec(extra[5])?.[0] === extra[5] && Number(extra[5]) <= 120000);
        waitBudget = Number(extra[5]);
    }
    receipt.initialRemainingSlotBudgetMs = waitBudget;
    for (const path of resume ? [cachedBuildPath, webReceipt] : [cache, frameworkReceipt, prior, webReceipt])
        assert(isAbsolute(path));
    assert(/^[0-9a-f]{64}$/.test(expectedWebHash) && expectedWebHash.length === 64);
    regular(webReceipt);
    assert(hash(webReceipt) === expectedWebHash);
    web = inspectWindowBuildReceipt(JSON.parse(readFileSync(webReceipt, 'utf8')), checkout);
    receipt.preservedWebReceipt = { path: webReceipt, sha256: expectedWebHash };
    receipt.webRecompiled = false;
    const paths = [
        'bridge-native/fullAppUiProof.mjs',
        'bridge-native/fullAppUiContract.mjs',
        'bridge-native/fullAppUiResumeContract.mjs',
        'bridge-native/build.mjs',
        'bridge-native/generate_project.rb',
        'bridge-native/machOEntitlementEvidence.mjs',
        'bridge-native/ResearchApp.swift',
        'bridge-native/ResearchLocalUiFixture.swift',
        'bridge-native/ResearchFullAppHttpFence.swift',
        'bridge-native/ResearchAuthHost.swift',
        'bridge-native/ScuttlebuttResearchAuthPlugin.swift',
        'full-app-pilot/nativeUiFixture.js',
    ];
    receipt.sourceHashes = Object.fromEntries(
        paths.map((name) => ['experiments/scuttlebutt-e2ee/' + name, hash(join(here, '..', name))]),
    );
    stable();
    let build;
    if (resume) {
        assert(/^[0-9a-f]{64}$/.test(cachedBuildHash) && cachedBuildHash.length === 64);
        regular(cachedBuildPath);
        assert(hash(cachedBuildPath) === cachedBuildHash);
        build = JSON.parse(readFileSync(cachedBuildPath, 'utf8'));
        cachedPlan = inspectFullAppCachedBuild(build, checkout, expectedWebHash);
        const resource = verifyCachedNative(build, cachedPlan);
        runID = resource.runID;
        nonce = resource.nonce;
        receipt.runID = runID;
        receipt.fixtureResource = { path: cachedPlan.resourcePath, sha256: cachedPlan.resourceHash };
        receipt.buildReceipt = { path: cachedBuildPath, sha256: cachedBuildHash };
        receipt.originalCompileProof = {
            builderSha256: cachedPlan.originalBuilderHash,
            contractSha256: cachedPlan.originalContractHash,
            sourceHashes: cachedPlan.sourceHashes,
            providerSha256: cachedPlan.providerHash,
            frameworkReceiptSha256: cachedPlan.frameworkReceiptHash,
            priorExchangeReceiptSha256: cachedPlan.priorExchangeReceiptHash,
        };
        receipt.currentUncompiledResumeToolHashes = Object.fromEntries(
            ['fullAppUiProof.mjs', 'fullAppUiResumeContract.mjs', 'fullAppUiContract.mjs'].map((name) => [
                name,
                hash(join(here, name)),
            ]),
        );
        receipt.nativeRecompiled = false;
        receipt.cachedUnsignedResume = true;
        receipt.originalFixtureBindingRetained = true;
        receipt.phase = 'cached-native-preflight';
        save();
    } else {
        regular(frameworkReceipt);
        regular(prior);
        const frameworks = JSON.parse(readFileSync(frameworkReceipt, 'utf8'));
        assert(frameworks.status === 'passed');
        receipt.frameworkReceipt = { path: frameworkReceipt, sha256: hash(frameworkReceipt) };
        receipt.nativeExchangeReceipt = { path: prior, sha256: hash(prior) };
        const resource = createFullAppNativeResource(
            readFileSync(join(here, '../full-app-pilot/nativeUiFixture.js'), 'utf8'),
            runID,
            nonce,
        );
        const fixture = join(scratch, 'fixture-resource.json');
        writeFileSync(fixture, JSON.stringify(resource), { mode: 0o600, flag: 'wx' });
        receipt.fixtureResource = { path: fixture, sha256: hash(fixture) };
        await slot();
        stable();
        receipt.phase = 'native-build';
        save();
        // The child holds its own heavy-job reservation; do not deadlock against this parent.
        process.title = 'thalassa native-root awaiting owned compile';
        const output = quiet(
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
                prior,
                '--local-ui-frameworks-receipt',
                frameworkReceipt,
                '--full-app-web-receipt',
                webReceipt,
                '--slot-wait-ms',
                String(Math.max(0, waitBudget - waited)),
            ],
            450000,
        );
        const buildPath = output.match(/Nonsecret research messaging build receipt: (\/[^\n]+)/)?.[1];
        assert(buildPath);
        build = JSON.parse(readFileSync(buildPath, 'utf8'));
        assert(
            build.status === 'passed' &&
                build.platform === 'iphonesimulator' &&
                build.fullAppUiFixture === true &&
                build.localUiFixture === true &&
                build.protectedUiFixture === false &&
                build.unsignedApplication === true &&
                build.applicationSignatureCheckedAbsent === true &&
                build.primaryCapSyncExecuted === false &&
                build.fullAppWebReceiptSha256 === expectedWebHash &&
                build.localUiFixtureResourceSha256 === hash(fixture),
        );
        receipt.buildReceipt = { path: buildPath, sha256: hash(buildPath) };
        receipt.nativeRecompiled = true;
        receipt.cachedUnsignedResume = false;
    }
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
    assert.deepEqual(treeHashes(build.artifact), build.artifactHashes);
    receipt.unsignedOriginalPreserved = true;
    const runtimes = JSON.parse(quiet('/usr/bin/xcrun', ['simctl', 'list', 'runtimes', '--json'])).runtimes;
    const selection = resume ? inspectCachedRuntimeSelection(runtimes, requestedRuntimeId) : null;
    if (selection) receipt.runtimeSelection = selection;
    const runtime = runtimes.find(
        (r) =>
            r.isAvailable && r.identifier === (selection?.runtimeId ?? 'com.apple.CoreSimulator.SimRuntime.iOS-26-5'),
    );
    assert(runtime, 'Existing runtime required; no download');
    const type = runtime.supportedDeviceTypes.find(
        (t) =>
            t.identifier ===
            (selection?.deviceTypeId ?? 'com.apple.CoreSimulator.SimDeviceType.iPhone-SE-3rd-generation'),
    );
    assert(type);
    ownedName = resume ? 'Thalassa full-root replay ' + attemptID : 'Thalassa full-root ' + runID;
    simulator = quiet('/usr/bin/xcrun', ['simctl', 'create', ownedName, type.identifier, runtime.identifier]);
    assert(/^[0-9A-F-]{36}$/.test(simulator) && simulator.length === 36);
    receipt.ownedSimulator = { id: simulator, name: ownedName };
    receipt.phase = 'owned-simulator-boot';
    save();
    own();
    quiet('/usr/bin/xcrun', ['simctl', 'boot', simulator]);
    quiet('/usr/bin/xcrun', ['simctl', 'bootstatus', simulator, '-b'], 180000);
    own();
    if (controlLaunchProbe) {
        receipt.phase = 'owned-control-launch-probe';
        receipt.controlLaunchBundle = FULL_APP_CONTROL_BUNDLE;
        receipt.controlLaunchBoundMs = 30000;
        receipt.researchInstallAttempted = false;
        save();
        const inventory = quiet('/usr/bin/xcrun', ['simctl', 'listapps', simulator], 30000, 1024 * 1024);
        assert(Buffer.byteLength(inventory, 'utf8') <= 1024 * 1024);
        receipt.lastOperation = 'owned-control-app-metadata-convert';
        receipt.lastOperationExitStatus = null;
        receipt.lastOperationTimedOut = false;
        save();
        const converted = spawnSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], {
            input: inventory,
            encoding: 'utf8',
            timeout: 10000,
            maxBuffer: 1024 * 1024,
        });
        receipt.lastOperationExitStatus = Number.isInteger(converted.status) ? converted.status : null;
        receipt.lastOperationTimedOut = converted.error?.code === 'ETIMEDOUT';
        assert(!converted.error && converted.status === 0);
        receipt.controlAppMetadata = inspectControlLaunchMetadata(JSON.parse(converted.stdout));
        save();
        quiet('/usr/bin/xcrun', ['simctl', 'launch', simulator, FULL_APP_CONTROL_BUNDLE], 30000, 4096);
        assert(receipt.controlLaunchObservation.launchCallAccepted);
        receipt.controlLaunchReturnedPIDAlive = null;
        try {
            process.kill(receipt.controlLaunchObservation.returnedPID, 0);
            receipt.controlLaunchReturnedPIDAlive = true;
        } catch (error) {
            receipt.controlLaunchReturnedPIDAlive = error?.code === 'EPERM' ? null : false;
        }
        // Signal0 is only a liveness observation, not process identity or native acceptance.
        receipt.researchInstallAttempted = true;
        save();
    }
    quiet('/usr/bin/xcrun', ['simctl', 'install', simulator, app], 180000);
    const container = quiet('/usr/bin/xcrun', ['simctl', 'get_app_container', simulator, bundle, 'data']);
    assert(isAbsolute(container));
    const statusFile = join(container, 'Documents/research-local-ui-status-' + runID + '.json');
    expectedStatusFile = statusFile;
    expectedPhaseFile = join(container, 'Documents/research-local-ui-phase.json');
    receipt.expectedNativeFilePresent = existsSync(expectedStatusFile);
    receipt.expectedPhaseFilePresent = existsSync(expectedPhaseFile);
    assert(!existsSync(statusFile));
    receipt.phase = 'actual-full-root-native';
    save();
    quiet('/usr/bin/xcrun', ['simctl', 'launch', '--terminate-running-process', simulator, bundle]);
    const deadline = Date.now() + 120000;
    let native;
    receipt.lastOperation = 'native-status-poll';
    receipt.lastOperationExitStatus = null;
    receipt.lastOperationTimedOut = false;
    save();
    while (Date.now() < deadline) {
        if (Number.isInteger(receipt.ownedLaunchPID)) {
            try {
                process.kill(receipt.ownedLaunchPID, 0);
                receipt.ownedLaunchPIDAlive = true;
            } catch (error) {
                receipt.ownedLaunchPIDAlive = error?.code === 'EPERM' ? null : false;
            }
        }
        receipt.expectedNativeFilePresent = existsSync(statusFile);
        receipt.expectedPhaseFilePresent = existsSync(expectedPhaseFile);
        if (existsSync(statusFile)) {
            regular(statusFile, 65536);
            native = JSON.parse(readFileSync(statusFile, 'utf8'));
            assert(
                native.version === 2 &&
                    native.runID === runID &&
                    native.nonce === nonce &&
                    native.scenario === FULL_APP_NATIVE_SCENARIO,
            );
            if (native.status !== 'running') break;
        }
        await delay(250);
    }
    receipt.nativeStatusDeadlineReached = !native || native.status === 'running';
    save();
    const phaseFile = expectedPhaseFile;
    if (existsSync(phaseFile)) {
        regular(phaseFile, 4096);
        const phase = JSON.parse(readFileSync(phaseFile, 'utf8'));
        assert(
            phase.version === 1 &&
                Object.keys(phase).length === 2 &&
                [
                    ...FULL_APP_NATIVE_PHASES,
                    'application-launched',
                    'scene-connected',
                    'bridge-created',
                    'fixture-install-failed',
                ].includes(phase.phase),
        );
        receipt.nativeLaunchPhase = phase.phase;
    }
    if (native) {
        receipt.lastOperation = 'native-envelope-validate';
        receipt.lastOperationExitStatus = null;
        receipt.lastOperationTimedOut = false;
        save();
        // No arbitrary container JSON is copied, even for a failed/running run.
        // This preserves only strict fixed facts and grants no final acceptance.
        native = inspectFullAppNativeEnvelope(native, runID, nonce);
        const copy = join(scratch, 'native-receipt.json');
        writeFileSync(copy, JSON.stringify(native, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
        receipt.nativeReceipt = { path: copy, sha256: hash(copy) };
        save();
    }
    receipt.lastOperation = 'native-final-validate';
    receipt.lastOperationExitStatus = null;
    receipt.lastOperationTimedOut = false;
    save();
    inspectFullAppNativeReceipt(native, runID, nonce);
    stable();
    receipt.status = 'passed';
    receipt.phase = 'complete';
    receipt.realFullAppNativeStartupAccepted = true;
} catch {
    if (receipt.status !== 'queued-unrun') receipt.status = 'failed';
    receipt.failedOrQueuedPhase = receipt.phase;
    receipt.failedOperation = receipt.lastOperation ?? null;
    receipt.failedOperationExitStatus = receipt.lastOperationExitStatus ?? null;
    receipt.failedOperationTimedOut = receipt.lastOperationTimedOut ?? false;
    if (receipt.failedOperation === 'owned-app-launch' && expectedStatusFile && expectedPhaseFile) {
        // Read each known owned file once before cleanup. No relaunch, retry,
        // raw container JSON or error body is retained, and failure stays failure.
        const nativeFilePresent = existsSync(expectedStatusFile),
            phaseFilePresent = existsSync(expectedPhaseFile);
        receipt.launchFailureCapture = {
            status: 'refused',
            nativeFilePresent,
            phaseFilePresent,
            outerDriverAccepted: false,
        };
        try {
            const phaseRaw = phaseFilePresent
                ? JSON.parse(readFileSync(regular(expectedPhaseFile, 4096), 'utf8'))
                : null;
            const nativeRaw = nativeFilePresent
                ? JSON.parse(readFileSync(regular(expectedStatusFile, 65536), 'utf8'))
                : null;
            const observation = inspectFailedLaunchObservation(
                {
                    operation: receipt.failedOperation,
                    exitStatus: receipt.failedOperationExitStatus,
                    timedOut: receipt.failedOperationTimedOut,
                },
                phaseRaw,
                nativeRaw,
                runID,
                nonce,
            );
            const path = join(scratch, 'launch-failure-observations.json');
            writeFileSync(path, JSON.stringify(observation, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
            receipt.launchFailureObservation = { path, sha256: hash(path) };
            receipt.launchFailureCapture = {
                status: observation.captureStatus,
                nativeFilePresent,
                phaseFilePresent,
                outerDriverAccepted: false,
                observedNativeFinalValidated: observation.observedNativeFinalValidated,
            };
            receipt.nativeLaunchPhase = observation.nativeLaunchPhase;
        } catch {
            // Only fixed absence/refusal facts survive malformed or unbounded files.
        }
    }
    process.exitCode = 1;
    console.error('Full-root native fixture incomplete; bounded owned receipt retained.');
} finally {
    receipt.lastOperationBeforeCleanup = receipt.lastOperation ?? null;
    receipt.expectedNativeFilePresent = expectedStatusFile ? existsSync(expectedStatusFile) : null;
    receipt.expectedPhaseFilePresent = expectedPhaseFile ? existsSync(expectedPhaseFile) : null;
    if (simulator) {
        try {
            const d = own();
            if (d.state !== 'Shutdown') quiet('/usr/bin/xcrun', ['simctl', 'shutdown', simulator]);
            quiet('/usr/bin/xcrun', ['simctl', 'delete', simulator]);
            receipt.ownedSimulatorRemoved = true;
        } catch {
            receipt.ownedSimulatorRemoved = false;
            receipt.status = 'cleanup-incomplete';
            process.exitCode = 1;
        }
    }
    receipt.sharedSlotWaitMs = waited;
    receipt.completedAtUTC = new Date().toISOString();
    save();
}
if (receipt.status === 'passed')
    console.info(
        'PASS isolated native full-root startup with synthetic Auth; no encrypted exchange, physical or release acceptance.',
    );
