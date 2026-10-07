/** Dedicated live native/hosted fixture orchestrator. No primary app, human
 * account, production or master operation. Warm compile/new-simulator boot
 * precedes irreversible actor creation and the short fixture allowlist window.
 * Tokens/passwords never appear in args/logs. An incomplete native run retains
 * its owned simulator/stores rather than replacing one-lifetime hosted keys.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
    chmodSync,
    closeSync,
    existsSync,
    fsyncSync,
    lstatSync,
    mkdtempSync,
    openSync,
    readFileSync,
    renameSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareNativeFixture } from './nativePmFixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url)),
    ROOT = join(HERE, '../../..');
const [cache, archive, prior, ...extra] = process.argv.slice(2);
assert(!extra.length && [cache, archive, prior].every((p) => typeof p === 'string' && isAbsolute(p)));
assert(ROOT.includes('/.codex/worktrees/scuttlebutt-e2ee/'));
const hash = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const scratch = mkdtempSync(join(tmpdir(), 'thalassa-native-hosted-pm-'));
chmodSync(scratch, 0o700);
const receiptPath = join(scratch, 'orchestrator-receipt.json');
const inputs = [
    'hosted/nativePmProof.mjs',
    'hosted/nativePmFixture.mjs',
    'relay/nativeExchangeProof.mjs',
    'VodozemacHostedPmProbe.swift',
    'VodozemacExchangeProbe.swift',
];
const sourceHashes = Object.fromEntries(inputs.map((p) => [p, hash(join(HERE, '..', p))]));
let stage = 'warm native harness',
    fixture,
    nativeReceiptPath,
    child,
    exitPromise,
    lastSummary,
    readySeen = false,
    failure;
let childExited = false,
    invalidChildOutput = false;
const receipt = {
    version: 1,
    runID: randomUUID(),
    status: 'preparing',
    project: 'kmtupdvwdgbhtssqqova',
    sourceHashes,
    ordinaryProductionIntegrationEnabled: false,
    humanAccountsOrDevicesChanged: false,
    productionTouched: false,
    independentSecurityAuditPerformed: false,
    hostedFixturePrepared: false,
    restorationRequired: false,
};
function save() {
    const temporary = join(scratch, 'receipt-' + randomUUID() + '.json');
    const fd = openSync(temporary, 'wx', 0o600);
    try {
        writeFileSync(fd, JSON.stringify(receipt, null, 2) + '\n');
        fsyncSync(fd);
    } finally {
        closeSync(fd);
    }
    renameSync(temporary, receiptPath);
    const directory = openSync(scratch, 'r');
    try {
        fsyncSync(directory);
    } finally {
        closeSync(directory);
    }
}
function stable() {
    for (const [p, h] of Object.entries(sourceHashes))
        assert.equal(hash(join(HERE, '..', p)), h, 'Candidate source changed');
}
function privateArtifact(path, limit = 256 * 1024) {
    assert(typeof path === 'string' && isAbsolute(path) && !path.startsWith(ROOT + '/'));
    const stat = lstatSync(path);
    assert(stat.isFile() && !stat.isSymbolicLink() && stat.uid === process.getuid() && stat.size <= limit);
    return JSON.parse(readFileSync(path, 'utf8'));
}
save();
console.info('Nonsecret native hosted orchestration receipt: ' + receiptPath);
let readyResolve, readyReject;
const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
});
try {
    stable();
    child = spawn(
        process.execPath,
        [
            '--experimental-strip-types',
            join(HERE, '../relay/nativeExchangeProof.mjs'),
            cache,
            archive,
            '--native-exchange-receipt',
            prior,
            '--hosted-native-pm',
        ],
        { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let buffer = '';
    child.stdout.on('data', (data) => {
        buffer += data.toString('utf8');
        if (buffer.length >= 1024 * 1024) {
            invalidChildOutput = true;
            buffer = '';
            readyReject(new Error('Native output contract refused'));
            return;
        }
        for (;;) {
            const index = buffer.indexOf('\n');
            if (index < 0) break;
            const line = buffer.slice(0, index);
            buffer = buffer.slice(index + 1);
            const artifact = line.match(/^Nonsecret native exchange receipt: (\/[^\r\n]+)$/)?.[1];
            if (artifact) nativeReceiptPath = artifact;
            const input = line.match(/^READY native hosted fixture input: (\/[^\r\n]+)$/)?.[1];
            if (input && !readySeen) {
                readySeen = true;
                readyResolve(input);
            }
            // Only the audited fixed label/path output contract is forwarded.
            if (
                /^(READY native hosted fixture input: |Nonsecret native exchange receipt: |Research artifacts retained: )/.test(
                    line,
                )
            )
                console.info(line);
        }
    });
    // Drain, but never retain native process diagnostics containing credentials.
    child.stderr.on('data', () => {});
    exitPromise = new Promise((resolve) => {
        child.once('error', () => {
            readyReject(new Error('Native harness unavailable'));
            resolve({ code: null, signal: null });
        });
        child.once('exit', (code, signal) => {
            childExited = true;
            if (!readySeen) readyReject(new Error('Native preflight incomplete'));
            resolve({ code, signal });
        });
    });
    const readyTimeout = setTimeout(() => readyReject(new Error('Native harness preparation deadline')), 1200000);
    let inputPath;
    try {
        inputPath = await ready;
    } finally {
        clearTimeout(readyTimeout);
    }
    assert(nativeReceiptPath);
    assert(!invalidChildOutput);
    const prepared = privateArtifact(nativeReceiptPath);
    assert(
        prepared.nativeHostedReady === true &&
            prepared.hostedInputPath === inputPath &&
            prepared.hostedNativePm === true,
    );
    assert(
        typeof prepared.runID === 'string' &&
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(prepared.runID),
    );
    assert(
        typeof prepared.simulator === 'string' &&
            typeof prepared.simulatorName === 'string' &&
            typeof prepared.container === 'string',
    );
    const expected = join(
        prepared.container,
        'Documents',
        'native-hosted-input-' + prepared.runID.toLowerCase() + '.json',
    );
    assert(inputPath === expected && !existsSync(inputPath));
    const parent = lstatSync(dirname(inputPath));
    assert(parent.isDirectory() && !parent.isSymbolicLink() && parent.uid === process.getuid());
    function readyForExternalWork() {
        assert(!childExited && child?.pid && !invalidChildOutput);
        process.kill(child.pid, 0); // Read-only liveness check of our own child.
        const current = privateArtifact(nativeReceiptPath);
        assert(current.status === 'running' && current.phase === 'native-hosted-awaiting-input');
        assert(current.runID === prepared.runID && current.simulator === prepared.simulator);
        assert(current.container === prepared.container && current.hostedInputPath === inputPath);
        assert(Number.isSafeInteger(current.hostedInputDeadlineUnixMs));
        assert(current.hostedInputDeadlineUnixMs === prepared.hostedInputDeadlineUnixMs);
        assert(Date.now() + 30000 < current.hostedInputDeadlineUnixMs);
        assert(current.hostedInputDeadlineUnixMs <= Date.now() + 300000);
        assert(!existsSync(inputPath));
        const metadata = lstatSync(dirname(inputPath));
        assert(metadata.isDirectory() && !metadata.isSymbolicLink() && metadata.uid === process.getuid());
        assert((metadata.mode & 0o777) === 0o700);
    }
    receipt.nativeReceipt = nativeReceiptPath;
    receipt.nativeRunID = prepared.runID;
    receipt.simulator = prepared.simulator;
    receipt.simulatorName = prepared.simulatorName;
    receipt.nativeWarmPreparationComplete = true;
    save();
    stable();
    readyForExternalWork();
    stage = 'dedicated native actor preparation';
    fixture = await prepareNativeFixture({
        runID: prepared.runID.toLowerCase(),
        scratch,
        readyDeadlineUnixMs: prepared.hostedInputDeadlineUnixMs,
    });
    receipt.hostedFixturePrepared = true;
    save();
    stage = 'temporary native allowlist';
    readyForExternalWork();
    receipt.restorationRequired = true;
    save();
    await fixture.beginAllowlist();
    stage = 'private native input handoff';
    readyForExternalWork();
    await fixture.writeNativeInput(inputPath);
    receipt.nativeInputWritten = true;
    save();
    stable();
    stage = 'actual native hosted phase';
    const result = await exitPromise;
    assert(!invalidChildOutput);
    const native = privateArtifact(nativeReceiptPath);
    receipt.nativeStatus = native.status;
    receipt.nativeObservation = native.observation;
    receipt.nativeIncompleteRecovery = native.hostedRecoveryRequired === true;
    save();
    assert(result.code === 0 && native.status === 'passed', 'Native hosted fixture incomplete; preserve owned state');
    assert(native.disposableSimulatorRemoved === true);
    const summaryPath = native.hostedSummaryRetainedPath;
    // Successful cleanup removes the simulator. The child must copy the public
    // fixed-field summary into its private scratch receipt before deletion.
    assert(summaryPath && isAbsolute(summaryPath));
    lastSummary = privateArtifact(summaryPath, 64 * 1024);
    assert(lastSummary.runID === prepared.runID.toLowerCase() && lastSummary.status === 'passed');
    stage = 'hosted native row and old-state verification';
    await fixture.verifyNativeResult(lastSummary);
    receipt.nativeAssertions = lastSummary.assertions;
    receipt.nativeSummaryRef = { path: summaryPath, sha256: hash(summaryPath) };
    receipt.nativeSucceeded = true;
    stable();
    stage = 'verified completion';
    receipt.status = 'passed';
} catch {
    failure = true;
    receipt.status = 'failed';
    receipt.failedStage = stage;
    console.error('FAIL native hosted orchestration stage ' + stage + '; private diagnostics suppressed');
    // Do not kill a possibly enrolled native app or delete its one-lifetime
    // simulator/stores. The child records its owned retained-state gate.
    receipt.recovery =
        'Inspect native/fixture receipts before resuming. Never replace registered keys or reset hosted rows.';
} finally {
    if (fixture) {
        try {
            await fixture.restore();
            receipt.restorationRequired = false;
            receipt.fixture = fixture.publicReceipt();
        } catch {
            failure = true;
            receipt.status = 'incomplete';
            receipt.failedStage = 'original human allowlist restoration';
            receipt.restorationRequired = true;
            console.error('FAIL original human allowlist restoration; recovery obligation retained');
        }
    }
    // Wait for our child's bounded input/phase deadline on failure. It alone
    // decides whether no input arrived (safe cleanup) or enrollment may have
    // committed (retained owned keys). A handoff can commit before its helper
    // reports success; never assume an unsuccessful return means no native work.
    if (failure && exitPromise && !childExited) {
        receipt.waitingForNativeFailureCleanup = true;
        save();
        await exitPromise;
        if (nativeReceiptPath && existsSync(nativeReceiptPath)) {
            const native = privateArtifact(nativeReceiptPath);
            receipt.nativeStatus = native.status;
            receipt.nativeIncompleteRecovery = native.hostedRecoveryRequired === true;
            receipt.disposableSimulatorRemoved = native.disposableSimulatorRemoved === true;
        }
    }
    receipt.completedAtUTC = new Date().toISOString();
    save();
}
if (failure) {
    process.exitCode = 1;
} else console.info('PASS native-to-hosted PM orchestration; sanitized receipt ' + receiptPath);
