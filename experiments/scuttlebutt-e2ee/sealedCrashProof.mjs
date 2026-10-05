/**
 * Local-only, isolated simulator process-death proof for the native sealed store.
 * Usage: node sealedCrashProof.mjs EXISTING_ABSOLUTE_NATIVE_CACHE
 * Optional: --native-exchange-receipt ABSOLUTE_COMPLETED_RECEIPT
 * Reuses cached native bindings/provider; never downloads, invokes Auth/servers,
 * changes a physical device, or installs into a pre-existing simulator.
 * Every SIGKILL targets a launch PID correlated with this newly owned simulator,
 * executable, exact arguments, and a bounded nonsecret parked receipt.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
    chmodSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync,
    readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, statfsSync,
    unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const EXPERIMENT = dirname(fileURLToPath(import.meta.url));
const CHECKOUT = resolve(EXPERIMENT, '../..');
const MIB = 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OPERATIONS = ['prepare', 'receiveOpening', 'receiveSession', 'accepted', 'rejected', 'logout'];
const BOUNDARIES = ['beforeUpdate', 'afterUpdateBeforeCommit', 'afterCommit'];
const PHASES = ['seed', 'fault', 'verify', 'cleanup'];
const SOURCE_NAMES = [
    'VodozemacSealedStore.swift', 'VodozemacDmFrame.swift', 'VodozemacDmCoordinator.swift',
    'VodozemacMessageOperations.swift', 'VodozemacRelayCodec.swift', 'VodozemacRelayTransport.swift',
    'VodozemacRelayResult.swift', 'VodozemacRelayPolicy.swift', 'VodozemacSealedCrashProbe.swift',
];
const STATUS_KEYS = [
    'runID', 'caseID', 'phase', 'operation', 'boundary', 'nonce', 'simulator', 'bundle',
    'pid', 'status', 'stage', 'assertions',
].sort();
const STATUS_STAGES = {
    running: 'phase-started', parked: 'fault-parked', passed: 'phase-complete', failed: 'probe-failed',
};
const runID = randomUUID().toLowerCase();
const bundle = `app.thalassa.research.sealed-crash.${runID}`;
const executableName = 'SealedCrash';
const slot = join(tmpdir(), `thalassa-isolated-heavy-slot-${process.getuid()}`);
const cases = OPERATIONS.flatMap((operation) => BOUNDARIES.map((boundary) => ({
    caseID: randomUUID().toLowerCase(), operation, boundary, status: 'not-run', phases: [], assertions: 0,
})));

let stage = 'arguments', scratch, receipt, receiptPath, slotNonce, simulator, simulatorName;
let runtimeID, deviceType, installedExecutable, appContainer, dataContainer, bootChild;
let interrupted = false, failed = false, checksPassed = false, failedStage;
const frozen = [];
const validatedHashes = new Map();
const stop = () => { interrupted = true; };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
const active = () => assert(!interrupted, 'Runner interrupted');
const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

function regular(path, limit = 512 * MIB) {
    const value = lstatSync(path);
    assert(value.isFile() && !value.isSymbolicLink() && value.size <= limit);
    return value;
}

function directory(path) {
    assert(isAbsolute(path));
    const value = lstatSync(path);
    assert(value.isDirectory() && !value.isSymbolicLink());
    return realpathSync(path);
}

// A regular leaf alone does not exclude a redirect through an intermediate link.
function cacheFile(cache, name, limit = 512 * MIB) {
    const parts = name.split('/');
    assert(parts.every((part) => part && part !== '.' && part !== '..'));
    let path = cache;
    for (const part of parts.slice(0, -1)) {
        path = join(path, part);
        assert(directory(path) === path);
    }
    path = join(path, parts.at(-1));
    regular(path, limit);
    return path;
}

function tree(root, limit = 8) {
    const files = [];
    const visit = (path) => {
        assert(directory(path) === path);
        for (const entry of readdirSync(path, { withFileTypes: true })) {
            const next = join(path, entry.name);
            assert(!entry.isSymbolicLink() && (entry.isDirectory() || entry.isFile()));
            if (entry.isDirectory()) visit(next);
            else { regular(next, 8 * MIB); files.push(next); assert(files.length <= limit); }
        }
    };
    visit(root);
    return files.sort();
}

function snapshot(input, output) {
    regular(input);
    const expected = validatedHashes.get(input);
    assert(typeof expected === 'string' && hash(input) === expected, 'Validated input changed while waiting');
    mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
    copyFileSync(input, output, constants.COPYFILE_EXCL);
    chmodSync(output, 0o600);
    assert(hash(output) === expected && hash(input) === expected, 'Input changed while copying');
    frozen.push({ input, output, expected });
    return expected;
}

function verifyFrozen() {
    for (const value of frozen) {
        regular(value.input); regular(value.output);
        assert(hash(value.input) === value.expected && hash(value.output) === value.expected, 'Frozen input changed');
    }
}

function saveReceipt() {
    if (!receiptPath) return;
    receipt.stage = stage;
    const pending = receiptPath + '.next';
    if (existsSync(pending)) regular(pending, MIB);
    writeFileSync(pending, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
    renameSync(pending, receiptPath);
}

// All command output is consumed privately. Unknown errors/diagnostics can
// contain state, so only the fixed current stage reaches console/receipt.
function command(program, args, { timeout = 30_000, maxBuffer = MIB, diagnosticPath } = {}) {
    if (diagnosticPath) assert(program === '/usr/bin/xcrun' && args[2] === 'swiftc'
        && diagnosticPath === join(scratch, 'compile.log'), 'Only the isolated compiler may retain diagnostics');
    const value = spawnSync(program, args, {
        encoding: 'utf8', timeout, maxBuffer, env: { ...process.env, LC_ALL: 'C' },
    });
    if (diagnosticPath) {
        const diagnostics = Buffer.from((value.stdout ?? '') + '\n' + (value.stderr ?? ''), 'utf8');
        writeFileSync(diagnosticPath, diagnostics.subarray(0, MIB), { mode: 0o600, flag: 'wx' });
        receipt.compilerDiagnostics = {
            path: diagnosticPath, sha256: hash(diagnosticPath), truncated: diagnostics.byteLength > MIB,
            commandExitStatus: value.status,
        };
        saveReceipt();
    }
    assert(!value.error && value.status === 0, 'Owned local command failed');
    return value.stdout.trim();
}
const xcrun = (args, options) => command('/usr/bin/xcrun', args, options);

function slotOwner() {
    const value = lstatSync(slot);
    assert(value.isDirectory() && !value.isSymbolicLink() && value.uid === process.getuid()
        && (value.mode & 0o777) === 0o700);
    const ownerPath = join(slot, 'owner.json');
    if (!existsSync(ownerPath)) return undefined;
    const stat = regular(ownerPath, 256);
    assert(stat.uid === process.getuid() && (stat.mode & 0o777) === 0o600);
    const owner = JSON.parse(readFileSync(ownerPath, 'utf8'));
    assert(Object.keys(owner).sort().join(',') === 'nonce,pid');
    assert(Number.isSafeInteger(owner.pid) && owner.pid > 0 && UUID.test(owner.nonce));
    return owner;
}

function releaseSlot() {
    if (!slotNonce) return;
    const owner = slotOwner();
    assert(owner?.pid === process.pid && owner.nonce === slotNonce
        && readdirSync(slot).length === 1, 'Only release the exact owned slot');
    unlinkSync(join(slot, 'owner.json'));
    rmdirSync(slot);
    slotNonce = undefined;
}

async function reserveSlot() {
    process.title = 'sealed crash research waiting';
    let announced = false;
    for (;;) {
        active();
        try {
            mkdirSync(slot, { mode: 0o700 });
            slotNonce = randomUUID().toLowerCase();
            writeFileSync(join(slot, 'owner.json'), JSON.stringify({ pid: process.pid, nonce: slotNonce }),
                { mode: 0o600, flag: 'wx' });
        } catch (error) {
            if (error?.code !== 'EEXIST') throw error;
            let owner = slotOwner();
            // Another runner may still be writing its owner immediately after
            // mkdir. An abandoned ownerless slot is never guessed safe to erase.
            for (let attempt = 0; !owner && attempt < 20 && existsSync(slot); attempt += 1) {
                active(); await delay(100);
                if (existsSync(slot)) owner = slotOwner();
            }
            if (!existsSync(slot)) continue;
            if (!owner) { stage = 'incomplete-shared-build-slot'; assert(false, 'Shared slot has no positive owner'); }
            try { process.kill(owner.pid, 0); }
            catch (failure) {
                if (failure?.code === 'ESRCH' && readdirSync(slot).length === 1) {
                    const again = slotOwner();
                    assert(again?.pid === owner.pid && again.nonce === owner.nonce);
                    unlinkSync(join(slot, 'owner.json')); rmdirSync(slot);
                } else if (failure?.code !== 'EPERM') throw failure;
            }
            if (!announced) console.info('Waiting for the shared Mac build slot.');
            announced = true; await delay(5000); continue;
        }
        const check = spawnSync('/usr/bin/pgrep', ['-fl', 'vite build|tsc|vitest'], {
            encoding: 'utf8', timeout: 10_000, maxBuffer: MIB,
        });
        assert(!check.error && [0, 1].includes(check.status));
        const others = check.stdout.trim().split('\n').filter((line) =>
            /^\d+\s/.test(line) && !line.startsWith(`${process.pid} `)
            && !/^\d+\s+(?:\/\S*\/)?(?:sh|bash|zsh|fish|tail|grep|rg|pgrep)\s/.test(line));
        if (!others.length) {
            process.title = 'vite build slot: isolated sealed crash proof';
            return;
        }
        releaseSlot();
        if (!announced) console.info('Waiting for the shared Mac build slot.');
        announced = true; await delay(5000);
    }
}

function ownDevice() {
    assert(UUID.test(simulator?.toLowerCase() ?? '') && simulatorName === `Thalassa sealed crash disposable ${runID}`);
    const devices = JSON.parse(xcrun(['simctl', 'list', 'devices', '--json'])).devices;
    assert(devices && typeof devices === 'object');
    const matches = Object.entries(devices).flatMap(([runtime, values]) => {
        assert(Array.isArray(values));
        return values.filter((value) => value.udid === simulator).map((value) => ({ runtime, value }));
    });
    assert(matches.length === 1 && matches[0].runtime === runtimeID
        && matches[0].value.name === simulatorName
        && matches[0].value.deviceTypeIdentifier === deviceType, 'Require the newly created owned simulator');
    return matches[0].value;
}

async function bootOwnedDevice() {
    ownDevice();
    xcrun(['simctl', 'boot', simulator]);
    ownDevice();
    await new Promise((resolveBoot, rejectBoot) => {
        const child = spawn('/usr/bin/xcrun', ['simctl', 'bootstatus', simulator, '-b'], {
            stdio: ['ignore', 'ignore', 'ignore'],
        });
        bootChild = child;
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, 600_000);
        const progress = setInterval(() => {
            if (interrupted) child.kill('SIGTERM');
            else console.info('Waiting for the owned disposable simulator to finish booting.');
        }, 30_000);
        const clear = () => { clearTimeout(timer); clearInterval(progress); bootChild = undefined; };
        child.once('error', () => { clear(); rejectBoot(new Error('Owned simulator boot failed')); });
        child.once('exit', (code) => {
            clear();
            if (code === 0 && !timedOut && !interrupted) resolveBoot();
            else rejectBoot(new Error('Owned simulator boot unresolved'));
        });
    });
    active();
}

function ownedContainer(kind) {
    ownDevice();
    const output = xcrun(['simctl', 'get_app_container', simulator, bundle, kind]);
    const path = directory(output);
    const prefix = `/Devices/${simulator.toLowerCase()}/data/Containers/${kind === 'app' ? 'Bundle' : 'Data'}/Application/`;
    assert(path === output && path.toLowerCase().includes(prefix.toLowerCase()));
    const suffix = path.toLowerCase().split(prefix.toLowerCase());
    assert(suffix.length === 2 && /^[0-9a-f-]{36}(?:\/sealedcrash\.app)?$/.test(suffix[1]));
    if (kind === 'app') assert(path.endsWith('/SealedCrash.app'));
    else assert(UUID.test(suffix[1]));
    return path;
}

// No ps output is retained or printed. Exact argv contains only fixed controls
// and public UUIDs. lstart distinguishes reuse of an old launch PID.
function processRecord(pid) {
    assert(Number.isSafeInteger(pid) && pid > 0);
    const value = spawnSync('/bin/ps', ['-ww', '-p', String(pid), '-o', 'pid=', '-o', 'uid=', '-o', 'lstart=', '-o', 'command='], {
        encoding: 'utf8', timeout: 10_000, maxBuffer: 16 * 1024, env: { ...process.env, LC_ALL: 'C' },
    });
    assert(!value.error && [0, 1].includes(value.status), 'Process ownership enumeration failed');
    const output = value.stdout.trim();
    if (!output) return undefined;
    assert(value.status === 0 && !output.includes('\n'));
    const match = output.match(/^(\d+)\s+(\d+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/);
    assert(match && Number(match[1]) === pid);
    return { pid, uid: Number(match[2]), started: match[3].replace(/\s+/g, ' '), argv: match[4] };
}

function exactProcess(value, pid, args) {
    assert(value && value.pid === pid && value.uid === process.getuid()
        && value.argv === [installedExecutable, ...args].join(' '), 'Require exact owned app process');
    return value;
}

const sameProcess = (a, b) => !!a && !!b && a.pid === b.pid && a.uid === b.uid
    && a.started === b.started && a.argv === b.argv;

async function observeGone(identity, pid, args) {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
        active();
        const current = processRecord(pid);
        if (!current) return { ownedProcessDisappearanceObserved: true, pidReuseObserved: false };
        if (identity && !sameProcess(identity, current)) {
            return { ownedProcessDisappearanceObserved: true, pidReuseObserved: true };
        }
        exactProcess(current, pid, args);
        await delay(100);
    }
    assert(false, 'Owned process disappearance was not observed');
}

function readStatus(path, expected, pid) {
    if (!existsSync(path)) return undefined;
    regular(path, 4096);
    const value = JSON.parse(readFileSync(path, 'utf8'));
    assert(value && !Array.isArray(value) && typeof value === 'object'
        && Object.keys(value).sort().join(',') === STATUS_KEYS.join(','));
    for (const [key, wanted] of Object.entries(expected)) assert(value[key] === wanted, 'Receipt identity mismatch');
    assert(value.pid === pid && Number.isSafeInteger(value.pid) && value.pid > 0);
    assert(Object.hasOwn(STATUS_STAGES, value.status) && value.stage === STATUS_STAGES[value.status]);
    assert(Number.isSafeInteger(value.assertions) && value.assertions >= 0 && value.assertions <= 100_000);
    assert(value.status !== 'parked' || value.phase === 'fault');
    assert(value.status !== 'passed' || value.phase !== 'fault');
    return value;
}

async function launch(caseReceipt, phase) {
    assert(PHASES.includes(phase)); active(); ownDevice();
    stage = `native-${phase}`;
    const nonce = randomUUID().toLowerCase();
    const expected = {
        runID, caseID: caseReceipt.caseID, phase, operation: caseReceipt.operation,
        boundary: caseReceipt.boundary, nonce, simulator: simulator.toLowerCase(), bundle,
    };
    const args = ['--run', runID, '--phase', phase, '--operation', caseReceipt.operation,
        '--boundary', caseReceipt.boundary, '--case', caseReceipt.caseID, '--nonce', nonce,
        '--simulator', simulator.toLowerCase(), '--bundle', bundle];
    const phaseReceipt = { phase, nonce, status: 'launch-outcome-unknown', assertions: 0 };
    caseReceipt.phases.push(phaseReceipt); saveReceipt();
    // No terminate option: a preceding phase must be observed gone before the
    // next phase is launched, rather than an implicit termination hiding it.
    const output = xcrun(['simctl', 'launch', simulator, bundle, ...args], { timeout: 180_000 });
    const match = output.match(/^([^:\r\n]+): ([1-9][0-9]*)$/);
    assert(match && match[1] === bundle);
    const pid = Number(match[2]);
    assert(Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid);
    phaseReceipt.pid = pid; phaseReceipt.status = 'awaiting-app-receipt'; saveReceipt();
    let identity = processRecord(pid);
    if (identity) identity = exactProcess(identity, pid, args);
    assert(phase !== 'fault' || identity, 'Fault process must still be owned and alive');
    const statusPath = join(dataContainer, 'Documents', `sealed-crash-status-${runID}-${caseReceipt.caseID}-${nonce}.json`);
    const deadline = Date.now() + 90_000;
    let status;
    while (Date.now() < deadline) {
        active();
        status = readStatus(statusPath, expected, pid);
        if (status && status.status !== 'running') break;
        await delay(250);
    }
    assert(status && status.status !== 'running', 'Native phase receipt deadline');
    phaseReceipt.status = status.status; phaseReceipt.stage = status.stage; phaseReceipt.assertions = status.assertions;
    saveReceipt();
    assert(status.status === (phase === 'fault' ? 'parked' : 'passed'), 'Native phase did not pass');
    assert(status.assertions > 0, 'Native phase must perform assertions');
    if (phase === 'fault') {
        stage = 'targeted-sigkill-correlation';
        ownDevice();
        assert(ownedContainer('app') === appContainer && ownedContainer('data') === dataContainer);
        regular(installedExecutable);
        assert(hash(installedExecutable) === receipt.executableSha256, 'Installed owned executable changed');
        const parked = readStatus(statusPath, expected, pid);
        assert(parked?.status === 'parked' && parked.stage === 'fault-parked');
        // Persist intent before correlation. Between the final ps comparison
        // and kill there is no await, lookup, shell command, or file operation.
        phaseReceipt.signalIntent = 'SIGKILL-exact-correlated-parked-app'; saveReceipt();
        active();
        const finalIdentity = exactProcess(processRecord(pid), pid, args);
        assert(sameProcess(identity, finalIdentity), 'PID start identity changed before dispatch');
        process.kill(pid, 'SIGKILL');
        phaseReceipt.sigkillDispatched = true;
        phaseReceipt.processStartIdentityCorrelated = true;
        saveReceipt();
        stage = 'targeted-sigkill-observation';
        Object.assign(phaseReceipt, await observeGone(finalIdentity, pid, args));
        phaseReceipt.signalObservation = 'sent-sigkill-and-observed-correlated-process-gone-no-waitpid-status';
    } else Object.assign(phaseReceipt, await observeGone(identity, pid, args));
    caseReceipt.assertions += status.assertions;
    saveReceipt();
}

try {
    assert(process.platform === 'darwin' && process.arch === 'arm64');
    const [cacheArg, ...options] = process.argv.slice(2);
    assert(cacheArg && isAbsolute(cacheArg) && (options.length === 0 ||
        (options.length === 2 && options[0] === '--native-exchange-receipt' && isAbsolute(options[1]))),
        'One existing absolute cache and only an optional completed native-exchange receipt required');
    const cache = directory(cacheArg);
    stage = 'pinned-cached-inputs';
    const pinPath = join(EXPERIMENT, 'vodozemac-native-pin.json'); regular(pinPath, 4096);
    const pinBytes = readFileSync(pinPath);
    const pin = JSON.parse(pinBytes.toString('utf8'));
    const validatedPinSha256 = createHash('sha256').update(pinBytes).digest('hex');
    assert(pin.provider === 'vodozemac' && pin.protocol === 'olm-v1' && pin.shippingApproved === false && pin.iosMinimum === '17.0');
    const manifest = join(EXPERIMENT, 'vodozemac-native/Cargo.toml'), lockfile = join(EXPERIMENT, 'vodozemac-native/Cargo.lock');
    regular(manifest, MIB); regular(lockfile, MIB);
    assert(hash(manifest) === pin.manifestSha256 && hash(lockfile) === pin.lockfileSha256);
    const priorReceipt = readdirSync(cache).sort().filter((name) => /^run-[0-9a-f-]+\.json$/.test(name)).find((name) => {
        try {
            const path = cacheFile(cache, name, 64 * 1024);
            const value = JSON.parse(readFileSync(path, 'utf8'));
            return value.status === 'passed' && value.observation === 'cleanup-and-uninstall-complete'
                && Array.isArray(value.completedPhases) && value.completedPhases.some((phase) => phase.phase === 'relay-replay');
        } catch { return false; }
    });
    const bindingRoot = directory(join(cache, 'bindings'));
    assert(bindingRoot === join(cache, 'bindings'));
    const bindingFiles = tree(bindingRoot);
    const swiftBindings = bindingFiles.filter((path) => path.endsWith('.swift'));
    const moduleMaps = bindingFiles.filter((path) => path.endsWith('.modulemap'));
    assert(swiftBindings.length === 1 && moduleMaps.length === 1);
    const provider = cacheFile(cache, 'target/aarch64-apple-ios-sim/debug/libthalassa_vodozemac_native.a');
    let priorReceiptPath, priorReceiptKind, validatedReceiptSha256, validatedCacheHashes;
    if (options.length) {
        priorReceiptPath = join(directory(dirname(options[1])), options[1].split('/').at(-1));
        regular(priorReceiptPath, 256 * 1024);
        const priorBytes = readFileSync(priorReceiptPath);
        const prior = JSON.parse(priorBytes.toString('utf8'));
        validatedReceiptSha256 = createHash('sha256').update(priorBytes).digest('hex');
        const phases = ['tls-refuse', 'prepare', 'opening', 'retry', 'reply', 'successor', 'verify', 'recovery', 'cleanup'];
        assert(prior.status === 'passed' && prior.observation === 'native-encrypted-https-sql-proof-passed'
            && prior.disposableSimulatorRemoved === true && prior.physicalPhoneExecution === false
            && Array.isArray(prior.completedPhases) && prior.completedPhases.length === phases.length
            && prior.completedPhases.every((value, index) => value.phase === phases[index] && value.stage === 'complete')
            && prior.providerManifestSha256 === pin.manifestSha256 && prior.providerLockSha256 === pin.lockfileSha256);
        const expectedInputs = [provider, ...bindingFiles].sort();
        assert(prior.cacheHashes && typeof prior.cacheHashes === 'object' && !Array.isArray(prior.cacheHashes)
            && Object.keys(prior.cacheHashes).sort().join('\n') === expectedInputs.join('\n')
            && expectedInputs.every((path) => prior.cacheHashes[path] === hash(path)),
            'Completed native-exchange receipt must match every exact cached artifact');
        priorReceiptKind = 'hash-matched-completed-native-https-exchange';
        validatedCacheHashes = prior.cacheHashes;
    } else {
        assert(priorReceipt, 'Require a completed prior native relay research receipt');
        priorReceiptPath = join(cache, priorReceipt);
        priorReceiptKind = 'completed-original-native-relay-research';
        const priorBytes = readFileSync(priorReceiptPath);
        const prior = JSON.parse(priorBytes.toString('utf8'));
        assert(prior.status === 'passed' && prior.observation === 'cleanup-and-uninstall-complete'
            && prior.completedPhases?.some((phase) => phase.phase === 'relay-replay'));
        validatedReceiptSha256 = createHash('sha256').update(priorBytes).digest('hex');
    }
    const sources = SOURCE_NAMES.map((name) => join(EXPERIMENT, name));
    sources.forEach((path) => regular(path, MIB));
    for (const path of [...sources, ...bindingFiles, provider]) validatedHashes.set(path, hash(path));
    if (validatedCacheHashes) for (const path of [provider, ...bindingFiles])
        assert(validatedHashes.get(path) === validatedCacheHashes[path], 'Artifact changed after receipt validation');
    validatedHashes.set(pinPath, validatedPinSha256);
    validatedHashes.set(manifest, pin.manifestSha256);
    validatedHashes.set(lockfile, pin.lockfileSha256);
    validatedHashes.set(priorReceiptPath, validatedReceiptSha256);
    scratch = mkdtempSync(join(tmpdir(), 'thalassa-sealed-crash-')); chmodSync(scratch, 0o700);
    assert(!scratch.startsWith(CHECKOUT + sep) && statfsSync(scratch).bavail * statfsSync(scratch).bsize > 3 * 1024 ** 3);
    receiptPath = join(scratch, 'sealed-crash-run.json');
    receipt = {
        runID, bundle, status: 'running', stage, cases, expectedCaseCount: 18, completedCaseCount: 0,
        sourceHashes: {}, cachedBindingHashes: {}, providerManifestSha256: pin.manifestSha256,
        providerLockfileSha256: pin.lockfileSha256,
        priorNativeResearchReceiptSha256: validatedReceiptSha256, priorNativeResearchReceiptKind: priorReceiptKind,
        freshRustBuild: false, cachedArtifactProvenanceIndependentlyVerified: false,
        physicalDeviceExecution: false, hostedOperations: false, networkOperations: false,
        addedCertificate: false, processDeathOnly: true, powerLossOrBackupRollbackVerified: false,
        disposableSimulatorRemoved: false, buildSlotReleased: false,
    };
    saveReceipt(); console.info(`Nonsecret sealed crash receipt: ${receiptPath}`);
    stage = 'shared-build-slot'; saveReceipt(); await reserveSlot();
    stage = 'private-frozen-inputs';
    const copies = join(scratch, 'Inputs'); mkdirSync(copies, { mode: 0o700 });
    const copiedSources = sources.map((path) => {
        const output = join(copies, 'Sources', relative(EXPERIMENT, path));
        receipt.sourceHashes[relative(EXPERIMENT, path)] = snapshot(path, output);
        return output;
    });
    for (const path of bindingFiles) receipt.cachedBindingHashes[relative(bindingRoot, path)]
        = snapshot(path, join(copies, 'Bindings', relative(bindingRoot, path)));
    const copiedProvider = join(copies, 'Provider/libthalassa_vodozemac_native.a');
    receipt.providerSha256 = snapshot(provider, copiedProvider);
    receipt.nativePinSha256 = snapshot(pinPath, join(copies, 'Pin/vodozemac-native-pin.json'));
    snapshot(manifest, join(copies, 'Pin/Cargo.toml')); snapshot(lockfile, join(copies, 'Pin/Cargo.lock'));
    snapshot(priorReceiptPath, join(copies, 'Pin/prior-native-receipt.json'));
    saveReceipt(); verifyFrozen(); active();
    stage = 'isolated-simulator-compile'; saveReceipt();
    const app = join(scratch, 'SealedCrash.app'); mkdirSync(app, { mode: 0o700 });
    const entitlements = join(scratch, 'research.simulated.xcent'), derEntitlements = entitlements + '.der';
    writeFileSync(entitlements,
        `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>application-identifier</key><string>RESEARCH00.${bundle}</string><key>keychain-access-groups</key><array><string>RESEARCH00.${bundle}</string></array></dict></plist>`,
        { mode: 0o600, flag: 'wx' });
    xcrun(['derq', 'query', '-f', 'xml', '-i', entitlements, '-o', derEntitlements, '--raw']);
    const sdk = xcrun(['--sdk', 'iphonesimulator', '--show-sdk-path']);
    const executable = join(app, executableName), bindings = join(copies, 'Bindings');
    xcrun(['--sdk', 'iphonesimulator', 'swiftc', '-swift-version', '5', '-j', '1', '-num-threads', '1',
        '-D', 'THALASSA_SEALED_CRASH_PROBE', '-parse-as-library', '-target', 'arm64-apple-ios17.0-simulator',
        '-sdk', sdk, '-module-cache-path', join(scratch, 'Modules'), '-I', bindings,
        '-Xcc', `-fmodule-map-file=${join(bindings, relative(bindingRoot, moduleMaps[0]))}`,
        '-Xlinker', '-sectcreate', '-Xlinker', '__TEXT', '-Xlinker', '__entitlements', '-Xlinker', entitlements,
        '-Xlinker', '-sectcreate', '-Xlinker', '__TEXT', '-Xlinker', '__ents_der', '-Xlinker', derEntitlements,
        copiedProvider, '-lsqlite3', '-framework', 'Security', '-o', executable,
        join(bindings, relative(bindingRoot, swiftBindings[0])), ...copiedSources],
        { timeout: 300_000, diagnosticPath: join(scratch, 'compile.log') });
    assert(xcrun(['vtool', '-show-build', executable]).includes('platform IOSSIMULATOR\n'));
    assert(xcrun(['lipo', '-archs', executable]) === 'arm64');
    verifyFrozen(); active();
    writeFileSync(join(app, 'Info.plist'),
        `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${bundle}</string><key>CFBundleExecutable</key><string>${executableName}</string><key>CFBundleName</key><string>${executableName}</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>1</string><key>MinimumOSVersion</key><string>17.0</string><key>LSRequiresIPhoneOS</key><true/><key>UIDeviceFamily</key><array><integer>1</integer></array><key>UILaunchScreen</key><dict/><key>UIApplicationSceneManifest</key><dict><key>UIApplicationSupportsMultipleScenes</key><false/><key>UISceneConfigurations</key><dict><key>UIWindowSceneSessionRoleApplication</key><array><dict><key>UISceneConfigurationName</key><string>Research</string><key>UISceneDelegateClassName</key><string>ThalassaSealedCrashResearchScene</string></dict></array></dict></dict></dict></plist>`,
        { mode: 0o600, flag: 'wx' });
    command('/usr/bin/codesign', ['--force', '--sign', '-', app]);
    receipt.executableSha256 = hash(executable); saveReceipt();
    stage = 'owned-simulator-create'; saveReceipt();
    const runtimes = JSON.parse(xcrun(['simctl', 'list', 'runtimes', '--json'])).runtimes;
    assert(Array.isArray(runtimes));
    const runtime = runtimes.find((value) => value.isAvailable && value.platform === 'iOS'
        && value.identifier === 'com.apple.CoreSimulator.SimRuntime.iOS-26-5');
    assert(runtime && Array.isArray(runtime.supportedDeviceTypes), 'An already installed iOS 26.5 runtime is required');
    runtimeID = runtime.identifier;
    const phoneTypes = runtime.supportedDeviceTypes.filter((value) => value.productFamily === 'iPhone');
    deviceType = (phoneTypes.find((value) => value.identifier === 'com.apple.CoreSimulator.SimDeviceType.iPhone-SE-3rd-generation')
        ?? phoneTypes[0])?.identifier;
    assert(typeof deviceType === 'string' && deviceType.startsWith('com.apple.CoreSimulator.SimDeviceType.'));
    simulatorName = `Thalassa sealed crash disposable ${runID}`;
    const created = xcrun(['simctl', 'create', simulatorName, deviceType, runtimeID]);
    assert(UUID.test(created.toLowerCase()), 'Capture only the newly created exact simulator UUID');
    simulator = created;
    Object.assign(receipt, { simulator, simulatorName, simulatorRuntime: runtimeID, simulatorDeviceType: deviceType });
    saveReceipt(); ownDevice();
    stage = 'owned-simulator-boot'; saveReceipt(); await bootOwnedDevice();
    stage = 'owned-simulator-install'; saveReceipt(); active(); ownDevice();
    xcrun(['simctl', 'install', simulator, app], { timeout: 180_000 });
    appContainer = ownedContainer('app'); dataContainer = ownedContainer('data');
    installedExecutable = join(appContainer, executableName); regular(installedExecutable);
    assert(hash(installedExecutable) === receipt.executableSha256);
    receipt.installedExecutableVerified = true; saveReceipt();
    for (const caseReceipt of cases) {
        active(); caseReceipt.status = 'running'; saveReceipt();
        try {
            for (const phase of PHASES) await launch(caseReceipt, phase);
            caseReceipt.status = 'passed'; receipt.completedCaseCount += 1; saveReceipt();
            console.info(`PASS sealed crash case: ${caseReceipt.operation}/${caseReceipt.boundary}`);
        } catch {
            caseReceipt.status = 'failed'; caseReceipt.failedStage = interrupted ? 'interrupted' : stage;
            saveReceipt(); throw new Error('Sealed crash case failed');
        }
    }
    stage = 'final-frozen-input-verification'; verifyFrozen(); active();
    assert(receipt.completedCaseCount === 18 && cases.every((value) => value.status === 'passed'));
    receipt.assertions = cases.reduce((total, value) => total + value.assertions, 0);
    checksPassed = true; receipt.status = 'checks-passed'; saveReceipt();
} catch {
    failed = true;
    failedStage = interrupted ? 'interrupted' : stage;
    if (receipt) {
        receipt.status = 'failed'; receipt.failedStage = failedStage;
        try { saveReceipt(); } catch { /* No raw filesystem error output. */ }
    }
} finally {
    if (bootChild && bootChild.exitCode === null && bootChild.signalCode === null) bootChild.kill('SIGTERM');
    if (simulator) {
        stage = 'owned-simulator-cleanup';
        try {
            const target = ownDevice();
            if (target.state !== 'Shutdown') { ownDevice(); xcrun(['simctl', 'shutdown', simulator]); }
            ownDevice(); xcrun(['simctl', 'delete', simulator]);
            const devices = JSON.parse(xcrun(['simctl', 'list', 'devices', '--json'])).devices;
            assert(devices && Object.values(devices).every((values) => Array.isArray(values)
                && values.every((value) => value.udid !== simulator)));
            receipt.disposableSimulatorRemoved = true;
        } catch {
            failed = true;
            if (receipt) { receipt.status = 'incomplete'; receipt.cleanupFailure = 'owned-simulator-cleanup'; }
        }
    }
    stage = 'owned-build-slot-release';
    try { releaseSlot(); if (receipt) receipt.buildSlotReleased = true; }
    catch {
        failed = true;
        if (receipt) { receipt.status = 'incomplete'; receipt.slotReleaseFailure = 'exact-slot-owner-mismatch-or-release-failed'; }
    }
    if (receipt && checksPassed && !failed && receipt.disposableSimulatorRemoved && receipt.buildSlotReleased) receipt.status = 'passed';
    stage = 'complete';
    try { saveReceipt(); } catch { failed = true; }
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
}

if (failed || !checksPassed || receipt?.status !== 'passed') {
    console.error(`Sealed crash proof refused at fixed stage: ${failedStage ?? receipt?.cleanupFailure ?? receipt?.slotReleaseFailure ?? 'receipt-save'}.`);
    if (receiptPath) console.error(`Nonsecret receipt retained: ${receiptPath}`);
    process.exitCode = 1;
} else {
    console.info('PASS 18 local native sealed-store process-death cases; owned simulator removed and shared slot released.');
    console.info('SIGKILL dispatch and correlated process disappearance observed; no waitpid signal, power-loss, physical-device or audit claim.');
    console.info(`Nonsecret receipt and frozen source/build artifacts retained: ${scratch}`);
}
