/** Actual WKWebView/Capacitor/SDK path, synthetic no-network Auth only.
 * Creates/removes ONE newly owned simulator; no human/production/hosted actor.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
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
const here = dirname(fileURLToPath(import.meta.url)),
    root = resolve(here, '../../..');
const [cache, frameworkReceipt, prior, scenario = 'cold-startup', ...extra] = process.argv.slice(2);
assert(!extra.length && [cache, frameworkReceipt, prior].every((p) => p && isAbsolute(p)));
assert(['cold-startup', 'protected-exchange'].includes(scenario));
const protectedUi = scenario === 'protected-exchange';
assert(root.includes('/.codex/worktrees/scuttlebutt-e2ee/'));
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'thalassa-local-wk-ui-')));
chmodSync(scratch, 0o700);
const hash = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const runID = randomUUID(),
    receiptPath = join(scratch, 'ui-run.json'),
    bundle = 'app.thalassa.research.scuttlebutt-auth';
const frameworks = JSON.parse(readFileSync(frameworkReceipt, 'utf8'));
assert(frameworks.status === 'passed');
const receipt = {
    version: 1,
    runID,
    scenario,
    status: 'preparing',
    scratch,
    phase: 'web-build',
    sourceHashes: Object.fromEntries(
        [
            'app-pilot/localUiFixture.js',
            ...(protectedUi
                ? [
                      'app-pilot/protectedUiFixture.js',
                      'bridge-native/ResearchProtectedUiRelay.swift',
                      'bridge-native/ResearchProtectedUiFixture.swift',
                  ]
                : []),
            'bridge-native/ResearchLocalUiFixture.swift',
            'bridge-native/localUiProof.mjs',
            'bridge-native/build.mjs',
            'bridge-native/generate_project.rb',
            'bridge-native/machOEntitlementEvidence.mjs',
            'bridge-native/ResearchApp.swift',
            'bridge-native/ResearchAuthHost.swift',
            'bridge-native/ScuttlebuttResearchAuthPlugin.swift',
        ].map((p) => [p, hash(join(here, '..', p))]),
    ),
    realWkWebViewCapacitorSdk: false,
    syntheticSdkAndNativeAuth: true,
    actualEncryptionProved: false,
    liveAuthProved: false,
    physicalDeviceExecution: false,
    productionTouched: false,
    humanDevicesChanged: false,
    hostedActorsChanged: false,
};
const save = () => writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
save();
console.info('Nonsecret local WK UI receipt: ' + receiptPath);
let simulator, ownedName;
function stable() {
    for (const [p, h] of Object.entries(receipt.sourceHashes))
        assert(hash(join(here, '..', p)) === h, 'Local UI source drift');
}
function treeHashes(root) {
    const files = {};
    function visit(dir) {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
            const path = join(dir, e.name);
            assert(!e.isSymbolicLink());
            if (e.isDirectory()) visit(path);
            else {
                assert(e.isFile());
                files[relative(root, path)] = hash(path);
            }
        }
    }
    visit(root);
    return files;
}
async function slot() {
    process.title = 'thalassa local WK UI awaiting shared-Mac slot';
    const deadline = Date.now() + 600000;
    for (;;) {
        const p = spawnSync('/usr/bin/pgrep', ['-fl', 'vite build|tsc|vitest'], { encoding: 'utf8', timeout: 10000 });
        assert(!p.error && [0, 1].includes(p.status));
        const others = p.stdout
            .trim()
            .split('\n')
            .filter(
                (s) =>
                    s &&
                    !s.startsWith(process.pid + ' ') &&
                    !/^\d+\s+(?:\/\S*\/)?(?:sh|bash|zsh|fish|env|xargs)\s/.test(s),
            );
        if (!others.length) break;
        assert(Date.now() < deadline);
        await delay(5000);
    }
    process.title = 'vite build slot: owned WK UI fixture';
}
function quiet(bin, args, timeout = 30000) {
    const r = spawnSync(bin, args, { encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024 });
    if (r.error || r.status !== 0) {
        if (receipt.phase === 'web-build' || receipt.phase === 'native-build')
            writeFileSync(join(scratch, 'build-failure.log'), r.stdout + '\n' + r.stderr, { mode: 0o600 });
    }
    if (receipt.phase === 'native-build') {
        const path = r.stdout.match(/Nonsecret research messaging build receipt: (\/[^\n]+)/)?.[1];
        if (path && existsSync(path)) {
            receipt.buildReceipt = path;
            receipt.buildReceiptSha256 = hash(path);
            save();
        }
    }
    assert(!r.error && r.status === 0, 'Owned UI step refused');
    return r.stdout.trim();
}
function own() {
    const devices = JSON.parse(quiet('/usr/bin/xcrun', ['simctl', 'list', 'devices', '--json'])).devices;
    const matches = Object.values(devices)
        .flat()
        .filter((d) => d.udid === simulator);
    assert(matches.length === 1 && matches[0].name === ownedName);
    return matches[0];
}
try {
    await slot();
    stable();
    const web = join(scratch, 'web');
    quiet(
        process.execPath,
        [
            join(root, 'node_modules/vite/bin/vite.js'),
            'build',
            '--config',
            join(here, '../app-pilot/vite.config.mjs'),
            '--configLoader',
            'runner',
            '--outDir',
            web,
        ],
        180000,
    );
    const html = join(web, 'index.html'),
        original = readFileSync(html, 'utf8');
    assert(original.split('connect-src https://kmtupdvwdgbhtssqqova.supabase.co').length === 2);
    writeFileSync(
        html,
        original.replace(
            'connect-src https://kmtupdvwdgbhtssqqova.supabase.co',
            "connect-src 'none'; frame-src 'none'",
        ),
        { mode: 0o600 },
    );
    const script = readFileSync(
        join(here, protectedUi ? '../app-pilot/protectedUiFixture.js' : '../app-pilot/localUiFixture.js'),
        'utf8',
    );
    assert(script.split('__RESEARCH_LOCAL_UI_RUN_ID__').length === 2);
    const fixture = join(scratch, 'local-ui-fixture.json');
    writeFileSync(
        fixture,
        JSON.stringify({
            version: protectedUi ? 2 : 1,
            runID,
            ...(protectedUi ? { scenario } : {}),
            script: script.replace('__RESEARCH_LOCAL_UI_RUN_ID__', runID),
        }),
        { mode: 0o600, flag: 'wx' },
    );
    receipt.phase = 'native-build';
    save();
    // The child owns its heavy slot; release our process-title reservation so
    // it does not wait for this parent. No other build runs here in parallel.
    process.title = 'thalassa WK UI awaiting child native compile';
    const output = quiet(
        process.execPath,
        [
            join(here, 'build.mjs'),
            cache,
            frameworks.products,
            web,
            '--platform',
            'iphonesimulator',
            '--local-ui-fixture-file',
            fixture,
            '--prior-native-exchange-receipt',
            prior,
            '--local-ui-frameworks-receipt',
            frameworkReceipt,
        ],
        400000,
    );
    const buildPath = output.match(/Nonsecret research messaging build receipt: (\/[^\n]+)/)?.[1];
    assert(buildPath);
    receipt.buildReceipt = buildPath;
    save();
    const build = JSON.parse(readFileSync(buildPath, 'utf8'));
    assert(
        build.status === 'passed' &&
            build.platform === 'iphonesimulator' &&
            build.localUiFixture === true &&
            build.unsignedApplication === true,
    );
    await slot();
    stable();
    const app = join(scratch, 'signed-fixture', 'ScuttlebuttResearchAuth.app');
    assert.deepEqual(treeHashes(build.artifact), build.artifactHashes);
    cpSync(build.artifact, app, { recursive: true, errorOnExist: true, force: false });
    assert.deepEqual(treeHashes(app), build.artifactHashes);
    receipt.signedArtifact = app;
    receipt.phase = 'ad-hoc-sign-owned-fixture';
    save();
    for (const name of ['Capacitor', 'Cordova'])
        quiet('/usr/bin/codesign', ['--force', '--sign', '-', join(app, 'Frameworks', name + '.framework')]);
    quiet('/usr/bin/codesign', ['--force', '--sign', '-', app]);
    receipt.signedOnlyFreshSimulatorArtifact = true;
    assert(
        build.simulatorLinkEntitlements?.embeddedInMachO === true &&
            build.simulatorLinkEntitlements.hostCodesignGrant === false,
    );
    receipt.hostCodesignEntitlementsSupplied = false;
    receipt.signedArtifactHashes = treeHashes(app);
    assert.deepEqual(treeHashes(build.artifact), build.artifactHashes);
    receipt.unsignedBuildArtifactPreserved = true;
    const runtimes = JSON.parse(quiet('/usr/bin/xcrun', ['simctl', 'list', 'runtimes', '--json'])).runtimes;
    const runtime = runtimes.find(
        (r) => r.isAvailable && r.identifier === 'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
    );
    assert(runtime, 'Existing simulator runtime required; no download');
    const types = runtime.supportedDeviceTypes.filter((t) => t.productFamily === 'iPhone');
    const device = (
        types.find((t) => t.identifier === 'com.apple.CoreSimulator.SimDeviceType.iPhone-SE-3rd-generation') ?? types[0]
    ).identifier;
    ownedName = 'Thalassa local WK UI ' + runID;
    simulator = quiet('/usr/bin/xcrun', ['simctl', 'create', ownedName, device, runtime.identifier]);
    assert(/^[0-9A-F-]{36}$/.test(simulator));
    receipt.simulator = simulator;
    receipt.simulatorName = ownedName;
    receipt.phase = 'owned-simulator-boot';
    save();
    own();
    quiet('/usr/bin/xcrun', ['simctl', 'boot', simulator]);
    quiet('/usr/bin/xcrun', ['simctl', 'bootstatus', simulator, '-b'], 180000);
    own();
    quiet('/usr/bin/xcrun', ['simctl', 'install', simulator, app], 180000);
    const container = quiet('/usr/bin/xcrun', ['simctl', 'get_app_container', simulator, bundle, 'data']);
    assert(isAbsolute(container));
    const status = join(container, 'Documents', 'research-local-ui-status-' + runID + '.json');
    assert(!existsSync(status));
    receipt.phase = 'actual-wk-plugin-sdk-dom';
    save();
    quiet('/usr/bin/xcrun', ['simctl', 'launch', '--terminate-running-process', simulator, bundle], 30000);
    const deadline = Date.now() + 90000;
    let native;
    while (Date.now() < deadline) {
        if (existsSync(status)) {
            const meta = lstatSync(status);
            assert(meta.isFile() && !meta.isSymbolicLink() && meta.size <= 16384);
            native = JSON.parse(readFileSync(status, 'utf8'));
            if (native.status !== 'running') break;
        }
        await delay(250);
    }
    const phaseFile = join(container, 'Documents', 'research-local-ui-phase.json');
    if (existsSync(phaseFile)) {
        const stage = JSON.parse(readFileSync(phaseFile, 'utf8'));
        assert(
            stage.version === 1 &&
                Object.keys(stage).length === 2 &&
                [
                    'application-launched',
                    'scene-connected',
                    'bridge-created',
                    'fixture-installed',
                    'fixture-install-failed',
                    'script-installed',
                    'dom-ready',
                    'cold-ready',
                    'signed-in',
                    'admission-returned',
                    'protected-setup',
                    'prepared',
                    'protected-peer-reply',
                    'peer-replied',
                    'pm-opened',
                    'pm-sent',
                'pm-received',
                'pm-refresh-started',
                    'protected-control-failed',
                ].includes(stage.phase),
        );
        receipt.nativeLaunchPhase = stage.phase;
        save();
    }
    if (native) {
        const nativeCopy = join(scratch, 'native-ui-receipt.json');
        writeFileSync(nativeCopy, JSON.stringify(native, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
        receipt.nativeReceipt = { path: nativeCopy, sha256: hash(nativeCopy) };
        save();
    }
    assert(
        native?.version === 1 && native.runID === runID && native.status === 'passed',
        'Local UI fixture failed; preserve fixed diagnostic receipt',
    );
    receipt.status = 'passed';
    receipt.realWkWebViewCapacitorSdk = true;
    receipt.actualEncryptionProved = protectedUi;
    receipt.phase = 'complete';
    receipt.domAssertions = native.assertions;
    receipt.nativeAssertionGroups = native.nativeAssertions;
    stable();
} catch {
    receipt.status = 'failed';
    console.error('FAIL local WK UI fixture; only fixed private receipt/build diagnostics retained.');
    process.exitCode = 1;
} finally {
    if (simulator) {
        try {
            const device = own();
            if (device.state !== 'Shutdown') quiet('/usr/bin/xcrun', ['simctl', 'shutdown', simulator]);
            quiet('/usr/bin/xcrun', ['simctl', 'delete', simulator]);
            receipt.ownedSimulatorRemoved = true;
        } catch {
            receipt.ownedSimulatorRemoved = false;
            receipt.status = 'cleanup-incomplete';
            process.exitCode = 1;
        }
    }
    receipt.completedAtUTC = new Date().toISOString();
    save();
}
if (receipt.status === 'passed')
    console.info(
        protectedUi
            ? 'PASS actual isolated UI/native encrypted exchange with synthetic Auth/relay; not live, physical or release acceptance.'
            : 'PASS actual local WKWebView, Capacitor and SDK with synthetic Auth; not live login or encrypted delivery.',
    );
