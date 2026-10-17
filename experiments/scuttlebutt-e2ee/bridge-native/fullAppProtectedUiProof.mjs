/** Fresh owned full-App protected exchange fixture. Synthetic Auth/relay only.
 * Node24 fullAppProtectedUiProof.mjs CACHE FRAMEWORK_RECEIPT EXCHANGE_RECEIPT WEB_RECEIPT WEB_SHA [REMAINING_WAIT_MS]
 * No cached-app resume: this scenario requires its own source-bound native build.
 */
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
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
    inspectFullAppSceneProtectedEnvelope,
    inspectFullAppSceneProtectedPrefix,
} from './fullAppProtectedUiContract.mjs';
import {
    createResearchSceneLifecycleResource,
    createResearchSceneProtectedUiResource,
    inspectResearchSceneLifecycleEvidence,
    researchSceneProtectedProofHash,
    requireResearchSceneProtectedDriverStage,
    RESEARCH_SCENE_LIFECYCLE_SCENARIO,
} from './researchSceneLifecycleContract.mjs';
import {
    inspectCachedRuntimeSelection,
    inspectControlLaunchMetadata,
    inspectControlLaunchObservation,
    FULL_APP_CONTROL_BUNDLE,
    FULL_APP_CONTROL_LAUNCH_BOUND_MS,
} from './fullAppUiResumeContract.mjs';
import { inspectSimulatorEntitlementSections } from './machOEntitlementEvidence.mjs';
import { inspectFirstInboxStageEvidence } from './firstInboxStageContract.mjs';
import { inspectSceneFinishStageEvidence } from './sceneFinishStageContract.mjs';
import { inspectSceneProgressStageEvidence } from './sceneProgressStageContract.mjs';
import { inspectSceneClosureCorrelationDiagnostic } from './sceneClosureCorrelationDiagnostic.mjs';
import { inspectSceneAuthorityTimingEvidence } from './sceneAuthorityTimingContract.mjs';
import { summarizeOwnedLaunchDiagnostic } from './ownedLaunchDiagnostic.mjs';

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
let sceneProof = false,
    sceneFixtureFile,
    protectedFixtureFile,
    protectedTemplate,
    ownedDocuments,
    scenePins,
    sceneBaseline;
let waited = 0,
    waitBudget = 120000;
let prerequisiteInputs = [],
    builtInputs = [],
    nativeObservationPassed = false,
    firstInboxDiagnosticCaptureComplete = false,
    sceneFinishDiagnosticCaptureComplete = false,
    sceneProgressDiagnosticCaptureComplete = false,
    sceneClosureDiagnosticCaptureComplete = false,
    sceneClosureDiagnosticAttempted = false,
    sceneAuthorityTimingDiagnosticCaptureComplete = false,
    sceneAuthorityTimingDiagnosticAttempted = false;
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
    const launchStarted = receipt.lastOperation === 'owned-app-launch' ? performance.now() : null;
    const r = spawnSync(bin, args, { encoding: 'utf8', timeout, maxBuffer, ...(input === undefined ? {} : { input }) });
    receipt.lastOperationExitStatus = Number.isInteger(r.status) ? r.status : null;
    receipt.lastOperationTimedOut = r.error?.code === 'ETIMEDOUT';
    if (receipt.lastOperation === 'owned-app-launch') {
        const found = /^app\.thalassa\.research\.scuttlebutt-auth: ([1-9][0-9]{0,8})\s*$/.exec(r.stdout ?? '');
        receipt.ownedLaunchPID = found ? Number(found[1]) : null;
        try {
            // At most initial + foreground attempts. These detached values
            // cannot replace the original PID/failure or admit native polling.
            const diagnostics = receipt.ownedLaunchDiagnostics ?? [];
            assert(diagnostics.length < 2 && launchStarted !== null);
            const diagnostic = summarizeOwnedLaunchDiagnostic({
                status: Number.isInteger(r.status) ? r.status : null,
                signal: r.signal ?? null,
                errorCode: r.error?.code ?? null,
                stdout: r.stdout ?? '',
                stderr: r.stderr ?? '',
                durationMs: Math.ceil(performance.now() - launchStarted),
                boundMs: timeout,
            });
            receipt.ownedLaunchDiagnostics = [...diagnostics, diagnostic];
            receipt.ownedLaunchDiagnosticStatus = 'observed-unaccepted';
        } catch {
            receipt.ownedLaunchDiagnosticStatus = 'refused';
        }
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
            if (accounting.outcome === 'failed') {
                receipt.status = 'failed';
                save();
                throw new Error('Owned child build failed');
            }
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
    const native = (sceneProof ? inspectFullAppSceneProtectedEnvelope : inspectFullAppProtectedNativeEnvelope)(
        raw,
        runID,
        nonce,
    );
    const copy = join(scratch, 'native-receipt.json');
    assert(!existsSync(copy));
    writeFileSync(copy, JSON.stringify(native, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    receipt.nativeReceipt = { path: copy, sha256: hash(copy) };
    return native;
}
function sceneFiles() {
    if (!ownedDocuments || !existsSync(ownedDocuments)) return null;
    assert(!lstatSync(ownedDocuments).isSymbolicLink() && lstatSync(ownedDocuments).isDirectory());
    const prefix = 'research-scene-lifecycle-' + runID + '-';
    const directories = readdirSync(ownedDocuments).filter((name) => name.startsWith(prefix));
    assert(directories.length <= 1);
    if (!directories.length) return null;
    const epoch = directories[0].slice(prefix.length);
    assert(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(epoch));
    const directory = join(ownedDocuments, directories[0]);
    assert(lstatSync(directory).isDirectory() && !lstatSync(directory).isSymbolicLink());
    return {
        epoch,
        observer: join(directory, 'scene-observer.json'),
        closure: join(directory, 'scene-ui-closure.json'),
        firstInboxDiagnostic: join(directory, 'scene-first-inbox-stage.json'),
        finishDiagnostic: join(directory, 'scene-finish-stage.json'),
        progressDiagnostic: join(directory, 'scene-progress-stage.json'),
        authorityTiming: join(directory, 'scene-authority-timing.json'),
    };
}
function inspectSceneObservation(raw, diagnostic = false) {
    const independentPid = scenePins?.pid ?? receipt.ownedLaunchPID;
    // A file-supplied PID is used only to validate an explicitly unaccepted
    // diagnostic shape. It can NEVER supply the driver's launch identity.
    const expectedPid = diagnostic && !Number.isSafeInteger(independentPid) ? raw.process?.pid : independentPid;
    const observed = inspectResearchSceneLifecycleEvidence(raw, {
        runID,
        nonce,
        resourceSHA256: hash(sceneFixtureFile),
        pid: expectedPid,
    });
    if (scenePins) assert(observed.process.epoch === scenePins.epoch && observed.process.pid === scenePins.pid);
    return observed;
}
function sceneObservation(diagnostic = false) {
    const files = sceneFiles();
    if (!files || !existsSync(files.observer)) return null;
    return inspectSceneObservation(JSON.parse(readFileSync(regular(files.observer, 65536), 'utf8')), diagnostic);
}
function captureFirstInboxStageDiagnostic() {
    if (!sceneProof) return;
    firstInboxDiagnosticCaptureComplete = false;
    receipt.firstInboxStageDiagnosticStatus = 'no-file';
    receipt.firstInboxDiagnosticCaptureComplete = false;
    try {
        const files = sceneFiles();
        if (!files || !existsSync(files.firstInboxDiagnostic)) return;
        // The recorder intentionally owns no identities. Its provenance comes
        // only from this owned launch, strict observer and pinned parent inputs.
        assert(Number.isSafeInteger(receipt.ownedLaunchPID) && receipt.ownedLaunchPID > 0);
        const observerSource = regular(files.observer, 65536);
        const directory = lstatSync(dirname(observerSource));
        assert(directory.uid === process.getuid() && (directory.mode & 0o7777) === 0o700);
        assert((lstatSync(observerSource).mode & 0o7777) === 0o600);
        const observerBytes = readFileSync(observerSource);
        assert(observerBytes.length > 0 && observerBytes.length <= 65536);
        const observerSourceSHA256 = createHash('sha256').update(observerBytes).digest('hex');
        const observer = inspectSceneObservation(JSON.parse(observerBytes.toString('utf8')));
        assert(observer.process.pid === receipt.ownedLaunchPID);
        assert(observer.process.epoch === files.epoch);
        assert(hash(sceneFixtureFile) === receipt.sceneFixtureResource.sha256);
        assert(hash(protectedFixtureFile) === receipt.fixtureResource.sha256);
        for (const [name, expected] of Object.entries(receipt.sourceHashes))
            assert(hash(regular(join(checkout, name))) === expected);
        const source = regular(files.firstInboxDiagnostic, 4096);
        assert((lstatSync(source).mode & 0o7777) === 0o600);
        const diagnosticBytes = readFileSync(source);
        assert(diagnosticBytes.length > 0 && diagnosticBytes.length <= 4096);
        const sourceSHA256 = createHash('sha256').update(diagnosticBytes).digest('hex');
        const diagnostic = JSON.parse(diagnosticBytes.toString('utf8'));
        const inspection = inspectFirstInboxStageEvidence(diagnostic);
        const path = join(scratch, 'first-inbox-stage-diagnostic.json');
        const observerPath = join(scratch, 'first-inbox-scene-observer.json');
        // After strict admission retain the exact bytes, not reconstructed JSON.
        // No arbitrary failed input or raw parser error is preserved here.
        writeFileSync(path, diagnosticBytes, { mode: 0o600, flag: 'wx' });
        writeFileSync(observerPath, observerBytes, { mode: 0o600, flag: 'wx' });
        assert(hash(regular(source, 4096)) === sourceSHA256);
        assert(hash(regular(observerSource, 65536)) === observerSourceSHA256);
        receipt.firstInboxStageDiagnostic = {
            path,
            sha256: hash(path),
            sourceSHA256,
            inspection,
            binding: {
                runID,
                resourceSHA256: receipt.sceneFixtureResource.sha256,
                protectedResourceSHA256: receipt.fixtureResource.sha256,
                pid: observer.process.pid,
                epoch: observer.process.epoch,
                observerReceipt: {
                    path: observerPath,
                    sha256: hash(observerPath),
                    sourceSHA256: observerSourceSHA256,
                },
            },
            acceptanceEvidence: false,
            wholeRunAccepted: false,
        };
        receipt.firstInboxStageDiagnosticStatus = 'observed-unaccepted';
        firstInboxDiagnosticCaptureComplete = inspection.status === 'completed' && inspection.selectedAttempts === 1;
    } catch {
        receipt.firstInboxStageDiagnosticStatus = 'refused';
    }
    receipt.firstInboxDiagnosticCaptureComplete = firstInboxDiagnosticCaptureComplete;
    save();
}
function captureLatestSceneNativeDiagnostic() {
    if (!sceneProof) return;
    receipt.latestSceneNativeDiagnosticStatus = 'no-file';
    try {
        if (!statusFile || !existsSync(statusFile)) return;
        const source = regular(statusFile, 65536);
        assert((lstatSync(source).mode & 0o7777) === 0o600);
        const bytes = readFileSync(source);
        const inspected = inspectFullAppSceneProtectedEnvelope(JSON.parse(bytes.toString('utf8')), runID, nonce);
        const sourceSHA256 = createHash('sha256').update(bytes).digest('hex');
        const path = join(scratch, 'latest-scene-native-diagnostic.json');
        // The prefix remains immutable. A later failed report is diagnostic,
        // never a substitute prefix or a way to promote lifecycle acceptance.
        writeFileSync(path, bytes, { mode: 0o600, flag: 'wx' });
        assert(hash(source) === sourceSHA256 && hash(path) === sourceSHA256);
        receipt.latestSceneNativeDiagnostic = {
            path,
            sha256: sourceSHA256,
            sourceSHA256,
            status: inspected.status,
            phase: inspected.phase,
            afterProtectedPrefix: !!receipt.nativeReceipt,
            acceptanceEvidence: false,
            wholeRunAccepted: false,
        };
        receipt.latestSceneNativeDiagnosticStatus = 'observed-unaccepted';
    } catch {
        receipt.latestSceneNativeDiagnosticStatus = 'refused';
    }
    save();
}
function captureSceneFinishStageDiagnostic() {
    if (!sceneProof) return;
    sceneFinishDiagnosticCaptureComplete = false;
    receipt.sceneFinishStageDiagnosticStatus = 'no-file';
    receipt.sceneFinishDiagnosticCaptureComplete = false;
    try {
        const files = sceneFiles();
        if (!files || !existsSync(files.finishDiagnostic)) return;
        // Passive capture performs no SDK/Auth/native operations. Only the
        // independent owned launch and strict observer establish provenance.
        assert(Number.isSafeInteger(receipt.ownedLaunchPID) && receipt.ownedLaunchPID > 0);
        const observerSource = regular(files.observer, 65536);
        const directory = lstatSync(dirname(observerSource));
        assert(directory.uid === process.getuid() && (directory.mode & 0o7777) === 0o700);
        assert((lstatSync(observerSource).mode & 0o7777) === 0o600);
        const observerBytes = readFileSync(observerSource);
        assert(observerBytes.length > 0 && observerBytes.length <= 65536);
        const observerSourceSHA256 = createHash('sha256').update(observerBytes).digest('hex');
        const observer = inspectSceneObservation(JSON.parse(observerBytes.toString('utf8')));
        assert(observer.process.pid === receipt.ownedLaunchPID);
        assert(observer.process.epoch === files.epoch);
        assert(hash(regular(sceneFixtureFile, 65536)) === receipt.sceneFixtureResource.sha256);
        assert(hash(regular(protectedFixtureFile, 128 * 1024)) === receipt.fixtureResource.sha256);
        for (const [name, expected] of Object.entries(receipt.sourceHashes))
            assert(hash(regular(join(checkout, name))) === expected);
        const source = regular(files.finishDiagnostic, 4096);
        assert((lstatSync(source).mode & 0o7777) === 0o600);
        const diagnosticBytes = readFileSync(source);
        assert(diagnosticBytes.length > 0 && diagnosticBytes.length <= 4096);
        const sourceSHA256 = createHash('sha256').update(diagnosticBytes).digest('hex');
        const inspection = inspectSceneFinishStageEvidence(JSON.parse(diagnosticBytes.toString('utf8')));
        const privateDirectory = lstatSync(scratch);
        assert(privateDirectory.uid === process.getuid() && (privateDirectory.mode & 0o7777) === 0o700);
        const path = join(scratch, 'scene-finish-stage-diagnostic.json');
        const observerPath = join(scratch, 'scene-finish-scene-observer.json');
        // Preserve only admitted exact bytes, never arbitrary failed JSON or
        // parser errors. A valid unselected 0/0 snapshot is still instrumentation.
        writeFileSync(path, diagnosticBytes, { mode: 0o600, flag: 'wx' });
        writeFileSync(observerPath, observerBytes, { mode: 0o600, flag: 'wx' });
        assert((lstatSync(path).mode & 0o7777) === 0o600);
        assert((lstatSync(observerPath).mode & 0o7777) === 0o600);
        assert(hash(regular(source, 4096)) === sourceSHA256);
        assert(hash(regular(observerSource, 65536)) === observerSourceSHA256);
        assert(hash(regular(path, 4096)) === sourceSHA256);
        assert(hash(regular(observerPath, 65536)) === observerSourceSHA256);
        receipt.sceneFinishStageDiagnostic = {
            path,
            sha256: sourceSHA256,
            sourceSHA256,
            inspection,
            binding: {
                runID,
                resourceSHA256: receipt.sceneFixtureResource.sha256,
                protectedResourceSHA256: receipt.fixtureResource.sha256,
                pid: observer.process.pid,
                epoch: observer.process.epoch,
                observerReceipt: {
                    path: observerPath,
                    sha256: observerSourceSHA256,
                    sourceSHA256: observerSourceSHA256,
                },
            },
            acceptanceEvidence: false,
            wholeRunAccepted: false,
        };
        receipt.sceneFinishStageDiagnosticStatus = 'observed-unaccepted';
        sceneFinishDiagnosticCaptureComplete = true;
    } catch {
        receipt.sceneFinishStageDiagnosticStatus = 'refused';
    }
    receipt.sceneFinishDiagnosticCaptureComplete = sceneFinishDiagnosticCaptureComplete;
    save();
}
function captureSceneProgressStageDiagnostic() {
    if (!sceneProof) return;
    sceneProgressDiagnosticCaptureComplete = false;
    receipt.sceneProgressStageDiagnosticStatus = 'no-file';
    receipt.sceneProgressDiagnosticCaptureComplete = false;
    try {
        const files = sceneFiles();
        if (!files || !existsSync(files.progressDiagnostic)) return;
        assert(Number.isSafeInteger(receipt.ownedLaunchPID) && receipt.ownedLaunchPID > 0);
        const observerSource = regular(files.observer, 65536);
        const directory = lstatSync(dirname(observerSource));
        assert(directory.uid === process.getuid() && (directory.mode & 0o7777) === 0o700);
        assert((lstatSync(observerSource).mode & 0o7777) === 0o600);
        const observerBytes = readFileSync(observerSource);
        assert(observerBytes.length > 0 && observerBytes.length <= 65536);
        const observerSourceSHA256 = createHash('sha256').update(observerBytes).digest('hex');
        const observer = inspectSceneObservation(JSON.parse(observerBytes.toString('utf8')));
        assert(observer.process.pid === receipt.ownedLaunchPID && observer.process.epoch === files.epoch);
        assert(hash(regular(sceneFixtureFile, 65536)) === receipt.sceneFixtureResource.sha256);
        assert(hash(regular(protectedFixtureFile, 128 * 1024)) === receipt.fixtureResource.sha256);
        for (const [name, expected] of Object.entries(receipt.sourceHashes))
            assert(hash(regular(join(checkout, name))) === expected);
        const source = regular(files.progressDiagnostic, 16384);
        assert((lstatSync(source).mode & 0o7777) === 0o600);
        const diagnosticBytes = readFileSync(source);
        assert(diagnosticBytes.length > 0 && diagnosticBytes.length <= 16384);
        const sourceSHA256 = createHash('sha256').update(diagnosticBytes).digest('hex');
        const inspection = inspectSceneProgressStageEvidence(JSON.parse(diagnosticBytes.toString('utf8')));
        const privateDirectory = lstatSync(scratch);
        assert(privateDirectory.uid === process.getuid() && (privateDirectory.mode & 0o7777) === 0o700);
        const path = join(scratch, 'scene-progress-stage-diagnostic.json');
        const observerPath = join(scratch, 'scene-progress-scene-observer.json');
        // Exact admitted bounded bytes only. Current entered phase is not a
        // terminal status, a fresh native counter sample or acceptance proof.
        writeFileSync(path, diagnosticBytes, { mode: 0o600, flag: 'wx' });
        writeFileSync(observerPath, observerBytes, { mode: 0o600, flag: 'wx' });
        assert((lstatSync(path).mode & 0o7777) === 0o600);
        assert((lstatSync(observerPath).mode & 0o7777) === 0o600);
        assert(hash(regular(source, 16384)) === sourceSHA256 && hash(regular(path, 16384)) === sourceSHA256);
        assert(hash(regular(observerSource, 65536)) === observerSourceSHA256);
        assert(hash(regular(observerPath, 65536)) === observerSourceSHA256);
        receipt.sceneProgressStageDiagnostic = {
            path,
            sha256: sourceSHA256,
            sourceSHA256,
            inspection,
            binding: {
                runID,
                resourceSHA256: receipt.sceneFixtureResource.sha256,
                protectedResourceSHA256: receipt.fixtureResource.sha256,
                pid: observer.process.pid,
                epoch: observer.process.epoch,
                observerReceipt: {
                    path: observerPath,
                    sha256: observerSourceSHA256,
                    sourceSHA256: observerSourceSHA256,
                },
            },
            acceptanceEvidence: false,
            wholeRunAccepted: false,
        };
        receipt.sceneProgressStageDiagnosticStatus = 'observed-unaccepted';
        sceneProgressDiagnosticCaptureComplete = inspection.entries.length > 0;
    } catch {
        receipt.sceneProgressStageDiagnosticStatus = 'refused';
    }
    receipt.sceneProgressDiagnosticCaptureComplete = sceneProgressDiagnosticCaptureComplete;
    save();
}
function captureSceneClosureDiagnostic() {
    if (!sceneProof || sceneClosureDiagnosticAttempted) return;
    sceneClosureDiagnosticAttempted = true;
    let boundary = 'input-file';
    sceneClosureDiagnosticCaptureComplete = false;
    receipt.sceneClosureDiagnosticStatus = 'no-file';
    receipt.sceneClosureDiagnosticCaptureComplete = false;
    try {
        const files = sceneFiles();
        if (!files || !existsSync(files.closure)) return;
        boundary = 'launch-and-sources';
        assert(scenePins && sceneBaseline);
        assert(Number.isSafeInteger(receipt.ownedLaunchPID) && receipt.ownedLaunchPID > 0);
        const observerSource = regular(files.observer, 65536);
        const directory = lstatSync(dirname(observerSource));
        assert(directory.uid === process.getuid() && (directory.mode & 0o7777) === 0o700);
        assert((lstatSync(observerSource).mode & 0o7777) === 0o600);
        const observerBytes = readFileSync(observerSource);
        assert(observerBytes.length > 0 && observerBytes.length <= 65536);
        const observerSourceSHA256 = createHash('sha256').update(observerBytes).digest('hex');
        const observer = inspectSceneObservation(JSON.parse(observerBytes.toString('utf8')));
        assert(observer.process.pid === receipt.ownedLaunchPID && observer.process.epoch === files.epoch);
        assert(hash(regular(sceneFixtureFile, 65536)) === receipt.sceneFixtureResource.sha256);
        assert(hash(regular(protectedFixtureFile, 128 * 1024)) === receipt.fixtureResource.sha256);
        for (const [name, expected] of Object.entries(receipt.sourceHashes))
            assert(hash(regular(join(checkout, name))) === expected);
        assert(scenePins.pid === observer.process.pid && scenePins.epoch === observer.process.epoch);
        boundary = 'private-file';
        const source = regular(files.closure, 16384);
        assert((lstatSync(source).mode & 0o7777) === 0o600);
        const diagnosticBytes = readFileSync(source);
        assert(diagnosticBytes.length > 0 && diagnosticBytes.length <= 16384);
        const sourceSHA256 = createHash('sha256').update(diagnosticBytes).digest('hex');
        boundary = 'shape-and-bindings';
        const pin = Object.fromEntries(Object.entries(scenePins).filter(([key]) => key !== 'sourceBindings'));
        const inspection = inspectSceneClosureCorrelationDiagnostic(
            { closure: JSON.parse(diagnosticBytes.toString('utf8')), protectedReport: sceneBaseline },
            pin,
        );
        boundary = 'copy';
        const privateDirectory = lstatSync(scratch);
        assert(privateDirectory.uid === process.getuid() && (privateDirectory.mode & 0o7777) === 0o700);
        const path = join(scratch, 'scene-closure-diagnostic.json');
        const observerPath = join(scratch, 'scene-closure-observer.json');
        // Preserve only strictly admitted exact bytes BEFORE full correlation can
        // refuse them. Boolean diagnostics grant no authority or stage acceptance.
        writeFileSync(path, diagnosticBytes, { mode: 0o600, flag: 'wx' });
        writeFileSync(observerPath, observerBytes, { mode: 0o600, flag: 'wx' });
        assert((lstatSync(path).mode & 0o7777) === 0o600);
        assert((lstatSync(observerPath).mode & 0o7777) === 0o600);
        assert(hash(regular(source, 16384)) === sourceSHA256 && hash(regular(path, 16384)) === sourceSHA256);
        assert(hash(regular(observerSource, 65536)) === observerSourceSHA256);
        assert(hash(regular(observerPath, 65536)) === observerSourceSHA256);
        receipt.sceneClosureDiagnostic = {
            path,
            sha256: sourceSHA256,
            sourceSHA256,
            inspection,
            binding: {
                runID,
                resourceSHA256: receipt.sceneFixtureResource.sha256,
                protectedResourceSHA256: receipt.fixtureResource.sha256,
                pid: observer.process.pid,
                epoch: observer.process.epoch,
                observerReceipt: {
                    path: observerPath,
                    sha256: observerSourceSHA256,
                    sourceSHA256: observerSourceSHA256,
                },
            },
            acceptanceEvidence: false,
            wholeRunAccepted: false,
        };
        receipt.sceneClosureDiagnosticStatus = 'observed-unaccepted';
        sceneClosureDiagnosticCaptureComplete = true;
    } catch {
        receipt.sceneClosureDiagnosticStatus = 'refused';
        receipt.sceneClosureDiagnosticRefusalBoundary = boundary;
    }
    receipt.sceneClosureDiagnosticCaptureComplete = sceneClosureDiagnosticCaptureComplete;
    save();
}
function captureSceneAuthorityTimingDiagnostic() {
    if (!sceneProof || sceneAuthorityTimingDiagnosticAttempted) return;
    sceneAuthorityTimingDiagnosticAttempted = true;
    sceneAuthorityTimingDiagnosticCaptureComplete = false;
    receipt.sceneAuthorityTimingDiagnosticStatus = 'no-file';
    receipt.sceneAuthorityTimingDiagnosticCaptureComplete = false;
    let boundary = 'input-file';
    try {
        const files = sceneFiles();
        if (!files || !existsSync(files.authorityTiming)) return;
        boundary = 'launch-and-sources';
        assert(Number.isSafeInteger(receipt.ownedLaunchPID) && receipt.ownedLaunchPID > 0);
        const observerSource = regular(files.observer, 65536);
        const directory = lstatSync(dirname(observerSource));
        assert(directory.uid === process.getuid() && (directory.mode & 0o7777) === 0o700);
        assert((lstatSync(observerSource).mode & 0o7777) === 0o600);
        const observerBytes = readFileSync(observerSource);
        assert(observerBytes.length > 0 && observerBytes.length <= 65536);
        const observerSourceSHA256 = createHash('sha256').update(observerBytes).digest('hex');
        const observer = inspectSceneObservation(JSON.parse(observerBytes.toString('utf8')));
        assert(observer.process.pid === receipt.ownedLaunchPID && observer.process.epoch === files.epoch);
        assert(hash(regular(sceneFixtureFile, 65536)) === receipt.sceneFixtureResource.sha256);
        assert(hash(regular(protectedFixtureFile, 128 * 1024)) === receipt.fixtureResource.sha256);
        for (const [name, expected] of Object.entries(receipt.sourceHashes))
            assert(hash(regular(join(checkout, name))) === expected);
        boundary = 'private-file';
        const source = regular(files.authorityTiming, 16384);
        assert((lstatSync(source).mode & 0o7777) === 0o600);
        const diagnosticBytes = readFileSync(source);
        assert(diagnosticBytes.length > 0 && diagnosticBytes.length <= 16384);
        const sourceSHA256 = createHash('sha256').update(diagnosticBytes).digest('hex');
        boundary = 'shape-and-bindings';
        const pin = {
            runID,
            nonce,
            resourceSHA256: receipt.sceneFixtureResource.sha256,
            pid: receipt.ownedLaunchPID,
            epoch: observer.process.epoch,
        };
        const inspection = inspectSceneAuthorityTimingEvidence(JSON.parse(diagnosticBytes.toString('utf8')), pin);
        boundary = 'copy';
        const privateDirectory = lstatSync(scratch);
        assert(privateDirectory.uid === process.getuid() && (privateDirectory.mode & 0o7777) === 0o700);
        const path = join(scratch, 'scene-authority-timing-diagnostic.json');
        const observerPath = join(scratch, 'scene-authority-timing-observer.json');
        writeFileSync(path, diagnosticBytes, { mode: 0o600, flag: 'wx' });
        writeFileSync(observerPath, observerBytes, { mode: 0o600, flag: 'wx' });
        assert((lstatSync(path).mode & 0o7777) === 0o600 && (lstatSync(observerPath).mode & 0o7777) === 0o600);
        assert(hash(regular(source, 16384)) === sourceSHA256 && hash(regular(path, 16384)) === sourceSHA256);
        assert(hash(regular(observerSource, 65536)) === observerSourceSHA256);
        assert(hash(regular(observerPath, 65536)) === observerSourceSHA256);
        receipt.sceneAuthorityTimingDiagnostic = {
            path,
            sha256: sourceSHA256,
            sourceSHA256,
            // Keep the admitted resource nonce only in its private exact-byte
            // artifact. The parent carries detached bounded timing facts.
            inspection: inspection.timing,
            binding: {
                runID,
                resourceSHA256: receipt.sceneFixtureResource.sha256,
                protectedResourceSHA256: receipt.fixtureResource.sha256,
                pid: observer.process.pid,
                epoch: observer.process.epoch,
                observerReceipt: {
                    path: observerPath,
                    sha256: observerSourceSHA256,
                    sourceSHA256: observerSourceSHA256,
                },
            },
            acceptanceEvidence: false,
            wholeRunAccepted: false,
        };
        receipt.sceneAuthorityTimingDiagnosticStatus = 'observed-unaccepted';
        sceneAuthorityTimingDiagnosticCaptureComplete =
            inspection.timing.status === 'recording' &&
            inspection.timing.entries.length > 0 &&
            inspection.timing.evidenceCategory === 'simulator-native-observations';
    } catch {
        receipt.sceneAuthorityTimingDiagnosticStatus = 'refused';
        receipt.sceneAuthorityTimingDiagnosticRefusalBoundary = boundary;
    }
    receipt.sceneAuthorityTimingDiagnosticCaptureComplete = sceneAuthorityTimingDiagnosticCaptureComplete;
    save();
}
function sceneSourceBindings() {
    const names = {
        driver: 'bridge-native/fullAppProtectedUiProof.mjs',
        builder: 'bridge-native/build.mjs',
        projectGenerator: 'bridge-native/generate_project.rb',
        contract: 'bridge-native/researchSceneLifecycleContract.mjs',
        observer: 'bridge-native/ResearchSceneLifecycleEvidence.swift',
        coordinator: 'bridge-native/ResearchFullAppSceneUiFixture.swift',
        application: 'bridge-native/ResearchApp.swift',
        plugin: 'bridge-native/ScuttlebuttResearchAuthPlugin.swift',
        sceneAuthority: 'bridge-native/ResearchSceneAuthority.swift',
        protectedFixture: 'bridge-native/ResearchFullAppProtectedUiFixture.swift',
        protectedScript: 'full-app-pilot/nativeProtectedUiFixture.js',
    };
    return Object.fromEntries(Object.entries(names).map(([key, name]) => [key, hash(join(here, '..', name))]));
}
function sceneStage(stage) {
    if (stage === 'foreground-closed') captureSceneClosureDiagnostic();
    const observer = sceneObservation();
    assert(observer && scenePins && sceneBaseline);
    const files = sceneFiles();
    const closure =
        stage === 'foreground-closed' ? JSON.parse(readFileSync(regular(files.closure, 16384), 'utf8')) : null;
    const observation = requireResearchSceneProtectedDriverStage(
        {
            stage,
            observerEvidence: observer,
            observerResourceBytes: readFileSync(sceneFixtureFile, 'utf8'),
            protectedResourceBytes: readFileSync(protectedFixtureFile, 'utf8'),
            protectedTemplate,
            protectedReport: sceneBaseline,
            protectedUiClosure: closure,
            sourceBindings: sceneSourceBindings(),
        },
        scenePins,
    );
    const destination = join(scratch, 'scene-' + stage + '.json');
    assert(!existsSync(destination));
    writeFileSync(destination, JSON.stringify({ observer, closure }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    receipt.sceneStages ??= [];
    receipt.sceneStages.push({ stage, observation, receipt: { path: destination, sha256: hash(destination) } });
    save();
}
async function waitScene(predicate) {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
        const observed = sceneObservation();
        if (observed && predicate(observed)) return observed;
        await delay(100);
    }
    throw new Error('Owned scene observation incomplete');
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
    if (args.at(-1) === '--os-scene-proof') {
        sceneProof = true;
        args.pop();
        receipt.scenario = RESEARCH_SCENE_LIFECYCLE_SCENARIO;
        receipt.sceneUiFixture = true;
    }
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
        'bridge-native/ownedLaunchDiagnostic.mjs',
        'bridge-native/build.mjs',
        'bridge-native/generate_project.rb',
        'bridge-native/machOEntitlementEvidence.mjs',
        'bridge-native/ResearchApp.swift',
        'bridge-native/ScuttlebuttResearchAuthPlugin.swift',
        'bridge-native/ResearchSceneAuthority.swift',
        'bridge-native/ResearchAuthHost.swift',
        'bridge-native/ResearchLocalUiFixture.swift',
        'bridge-native/ResearchFullAppProtectedUiFixture.swift',
        'bridge-native/ResearchFullAppProtectedHttpFence.swift',
        'bridge-native/ResearchProtectedUiFixture.swift',
        'bridge-native/ResearchProtectedUiRelay.swift',
        'full-app-pilot/nativeProtectedUiFixture.js',
    ];
    if (sceneProof)
        names.push(
            'bridge-native/researchSceneLifecycleContract.mjs',
            'bridge-native/ResearchSceneLifecycleEvidence.swift',
            'bridge-native/ResearchFullAppSceneUiFixture.swift',
            'bridge-native/ResearchFirstInboxStageEvidence.swift',
            'bridge-native/firstInboxStageContract.mjs',
            'bridge-native/ResearchSceneFinishStageEvidence.swift',
            'bridge-native/sceneFinishStageContract.mjs',
            'bridge-native/ResearchSceneProgressStageEvidence.swift',
            'bridge-native/sceneProgressStageContract.mjs',
            'bridge-native/sceneClosureCorrelationDiagnostic.mjs',
            'bridge-native/ResearchSceneAuthorityTimingEvidence.swift',
            'bridge-native/sceneAuthorityTimingContract.mjs',
            'full-app-pilot/windowProofContract.mjs',
        );
    receipt.sourceHashes = Object.fromEntries(
        names.map((n) => ['experiments/scuttlebutt-e2ee/' + n, hash(join(here, '..', n))]),
    );
    const template = readFileSync(join(here, '../full-app-pilot/nativeProtectedUiFixture.js'), 'utf8');
    protectedTemplate = template;
    const resource = (sceneProof ? createResearchSceneProtectedUiResource : createFullAppProtectedNativeResource)(
        template,
        runID,
        nonce,
    );
    if (!sceneProof) inspectFullAppProtectedNativeResource(resource, template);
    const fixture = join(scratch, 'fixture-resource.json');
    writeFileSync(fixture, JSON.stringify(resource), { mode: 0o600, flag: 'wx' });
    receipt.fixtureResource = { path: fixture, sha256: hash(fixture) };
    protectedFixtureFile = fixture;
    if (sceneProof) {
        sceneFixtureFile = join(scratch, 'scene-resource.json');
        writeFileSync(sceneFixtureFile, JSON.stringify(createResearchSceneLifecycleResource(runID, nonce)), {
            mode: 0o600,
            flag: 'wx',
        });
        receipt.sceneFixtureResource = { path: sceneFixtureFile, sha256: hash(sceneFixtureFile) };
    }
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
            ...(sceneProof ? ['--scene-lifecycle-resource', sceneFixtureFile] : []),
        ],
        450000,
    );
    assert(receipt.buildReceipt);
    const build = JSON.parse(readFileSync(receipt.buildReceipt.path, 'utf8'));
    if (sceneProof)
        assert(
            build.fullAppSceneUiFixture === true &&
                build.sceneFixtureResourceSha256 === hash(sceneFixtureFile) &&
                build.sceneFixtureContractSha256 === hash(join(here, 'researchSceneLifecycleContract.mjs')),
        );
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
    ownedDocuments = join(container, 'Documents');
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
            const checked = (sceneProof ? inspectFullAppSceneProtectedEnvelope : inspectFullAppProtectedNativeEnvelope)(
                parsed,
                runID,
                nonce,
            );
            status = checked.status;
            if (sceneProof && checked.phase === 'native-proof-captured') break;
            if (status !== 'running') break;
        }
        await delay(250);
    }
    receipt.nativeStatusDeadlineReached = Date.now() >= deadline && (status === null || status === 'running');
    receipt.nativeLaunchPhase = readPhase();
    const native = copyNativeEnvelope();
    save();
    receipt.lastOperation = 'native-final-validate';
    save();
    if (sceneProof) {
        sceneBaseline = inspectFullAppSceneProtectedPrefix(native, runID, nonce);
        const baseline = await waitScene((observed) => observed.events.at(-1).event === 'protected-ready');
        scenePins = {
            runID,
            nonce,
            resourceSHA256: hash(sceneFixtureFile),
            protectedResourceSHA256: hash(protectedFixtureFile),
            protectedProofSHA256: researchSceneProtectedProofHash(sceneBaseline, runID, nonce),
            pid: receipt.ownedLaunchPID,
            epoch: baseline.process.epoch,
            sourceBindings: sceneSourceBindings(),
        };
        receipt.lastOperation = 'scene-baseline-validate';
        save();
        sceneStage('protected-ready');
        receipt.initialOwnedLaunchPID = scenePins.pid;
        quiet(
            '/usr/bin/xcrun',
            ['simctl', 'launch', simulator, FULL_APP_CONTROL_BUNDLE],
            FULL_APP_CONTROL_LAUNCH_BOUND_MS,
            4096,
        );
        receipt.lastOperation = 'owned-background-observation';
        save();
        await waitScene((observed) => observed.events.some((event) => event.event === 'did-enter-background'));
        // Validate the immediate callback before returning to foreground. A
        // later expired lease cannot replace this unsafe or missing sample.
        receipt.lastOperation = 'scene-background-validate';
        save();
        sceneStage('background-fenced');
        quiet('/usr/bin/xcrun', ['simctl', 'launch', simulator, bundle]);
        assert(receipt.ownedLaunchPID === scenePins.pid);
        receipt.lastOperation = 'owned-foreground-observation';
        save();
        await waitScene((observed) => observed.events.at(-1).event === 'foreground-ui-closed');
        receipt.lastOperation = 'scene-foreground-validate';
        save();
        sceneStage('foreground-closed');
        receipt.realOsLifecycleObservedCleanupPending = true;
    } else inspectFullAppProtectedNativeReceipt(native, runID, nonce);
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
    if (sceneProof) {
        try {
            const observed = sceneObservation(true);
            receipt.sceneDiagnosticStatus = observed ? 'observed-unaccepted' : 'no-file';
            if (observed) {
                const path = join(scratch, 'failed-scene-observer.json');
                writeFileSync(path, JSON.stringify(observed, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
                receipt.sceneDiagnostic = {
                    path,
                    sha256: hash(path),
                    lastEvent: observed.events.at(-1).event,
                    independentlyMeasuredLaunchPIDAvailable: Number.isSafeInteger(
                        receipt.initialOwnedLaunchPID ?? receipt.ownedLaunchPID,
                    ),
                    wholeRunAccepted: false,
                };
            }
        } catch {
            receipt.sceneDiagnosticStatus = 'refused';
        }
    }
    process.exitCode = 1;
    console.error('Protected full-root fixture incomplete; bounded owned receipt retained.');
} finally {
    receipt.lastOperationBeforeCleanup = receipt.lastOperation ?? null;
    receipt.expectedNativeFilePresent = statusFile ? existsSync(statusFile) : null;
    receipt.expectedPhaseFilePresent = phaseFile ? existsSync(phaseFile) : null;
    captureLatestSceneNativeDiagnostic();
    captureFirstInboxStageDiagnostic();
    captureSceneFinishStageDiagnostic();
    captureSceneProgressStageDiagnostic();
    captureSceneClosureDiagnostic();
    captureSceneAuthorityTimingDiagnostic();
    if (sceneProof && nativeObservationPassed && !firstInboxDiagnosticCaptureComplete) {
        receipt.status = 'failed';
        receipt.failedOrQueuedPhase = receipt.phase;
        receipt.failedOperation = 'first-inbox-diagnostic-validate';
        receipt.failedOperationExitStatus = null;
        receipt.failedOperationTimedOut = false;
        process.exitCode = 1;
        console.error('Protected scene fixture incomplete; bounded inbox diagnostic refused or unfinished.');
    }
    if (
        sceneProof &&
        nativeObservationPassed &&
        firstInboxDiagnosticCaptureComplete &&
        !sceneFinishDiagnosticCaptureComplete
    ) {
        receipt.status = 'failed';
        receipt.failedOrQueuedPhase = receipt.phase;
        receipt.failedOperation = 'scene-finish-diagnostic-validate';
        receipt.failedOperationExitStatus = null;
        receipt.failedOperationTimedOut = false;
        process.exitCode = 1;
        console.error('Protected scene fixture incomplete; bounded finish diagnostic refused or absent.');
    }
    if (
        sceneProof &&
        nativeObservationPassed &&
        firstInboxDiagnosticCaptureComplete &&
        sceneFinishDiagnosticCaptureComplete &&
        !sceneProgressDiagnosticCaptureComplete
    ) {
        receipt.status = 'failed';
        receipt.failedOrQueuedPhase = receipt.phase;
        receipt.failedOperation = 'scene-progress-diagnostic-validate';
        receipt.failedOperationExitStatus = null;
        receipt.failedOperationTimedOut = false;
        process.exitCode = 1;
        console.error('Protected scene fixture incomplete; bounded progress diagnostic refused or absent.');
    }
    if (
        sceneProof &&
        nativeObservationPassed &&
        firstInboxDiagnosticCaptureComplete &&
        sceneFinishDiagnosticCaptureComplete &&
        sceneProgressDiagnosticCaptureComplete &&
        !sceneClosureDiagnosticCaptureComplete
    ) {
        receipt.status = 'failed';
        receipt.failedOrQueuedPhase = receipt.phase;
        receipt.failedOperation = 'scene-closure-diagnostic-validate';
        receipt.failedOperationExitStatus = null;
        receipt.failedOperationTimedOut = false;
        process.exitCode = 1;
        console.error('Protected scene fixture incomplete; bounded closure diagnostic refused or absent.');
    }
    if (
        sceneProof &&
        nativeObservationPassed &&
        firstInboxDiagnosticCaptureComplete &&
        sceneFinishDiagnosticCaptureComplete &&
        sceneProgressDiagnosticCaptureComplete &&
        sceneClosureDiagnosticCaptureComplete &&
        !sceneAuthorityTimingDiagnosticCaptureComplete
    ) {
        receipt.status = 'failed';
        receipt.failedOrQueuedPhase = receipt.phase;
        receipt.failedOperation = 'scene-authority-timing-diagnostic-validate';
        receipt.failedOperationExitStatus = null;
        receipt.failedOperationTimedOut = false;
        process.exitCode = 1;
        console.error('Protected scene fixture incomplete; bounded authority timing diagnostic refused or absent.');
    }
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
    if (
        nativeObservationPassed &&
        (!sceneProof || firstInboxDiagnosticCaptureComplete) &&
        (!sceneProof || sceneFinishDiagnosticCaptureComplete) &&
        (!sceneProof || sceneProgressDiagnosticCaptureComplete) &&
        (!sceneProof || sceneClosureDiagnosticCaptureComplete) &&
        (!sceneProof || sceneAuthorityTimingDiagnosticCaptureComplete) &&
        receipt.ownedSimulatorRemoved === true
    ) {
        receipt.status = 'passed';
        receipt.phase = 'complete';
        receipt.nativeProtectedExchangeAccepted = true;
        if (sceneProof) receipt.realOsLifecycleProved = true;
    }
    receipt.sharedSlotWaitMs = waited;
    receipt.completedAtUTC = new Date().toISOString();
    save();
}
if (receipt.status === 'passed')
    console.info(
        sceneProof
            ? 'PASS scoped owned same-process UIKit scene roundtrip over synthetic Auth/relay; no physical or release acceptance.'
            : 'PASS scoped native-provider full-root exchange over synthetic Auth/relay; no physical, OS-lifecycle or release acceptance.',
    );
