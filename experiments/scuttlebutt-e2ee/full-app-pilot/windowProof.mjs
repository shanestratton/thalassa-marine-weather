/** Fresh unsupported Chrome Window only. No build/download/install/native/hosted actions.
 * Usage: Node24 windowProof.mjs ABS_PASSED_BUILD_RECEIPT EXPECTED_RECEIPT_SHA256
 * The validation coordinator freezes sources and owns the shared heavy-job slot.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import {
    chmodSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import {
    WINDOW_EVIDENCE_GLOBAL,
    WINDOW_REMOUNT_GLOBAL,
    WINDOW_RUN_QUERY,
    WINDOW_NONCE_QUERY,
    WINDOW_CSP_CONTROL_PATH,
    WINDOW_PROOF_CSP,
    classifyWindowRequest,
    inspectWindowBuildReceipt,
    inspectWindowCspControl,
    inspectWindowEvidence,
    isWindowProofHash,
    requireUnsupportedWindowEvidence,
} from './windowProofContract.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const checkout = resolve(here, '../../..');
const chrome =
    '/Users/shanestratton/.cache/puppeteer/chrome/mac_arm-151.0.7922.47/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const chromeVersion = '151.0.7922.47';
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'thalassa-full-app-window-')));
chmodSync(scratch, 0o700);
const profile = join(scratch, 'owned-profile');
const receiptPath = join(scratch, 'window-receipt.json');
const runId = randomUUID(),
    nonce = randomBytes(32).toString('hex');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fileHash = (path) => sha(readFileSync(path));
const counters = {
    documents: 0,
    assets: 0,
    faviconControls: 0,
    cspControls: 0,
    refusedRequests: 0,
    serverDocuments: 0,
    serverAssets: 0,
    serverFaviconControls: 0,
    serverCspEscapes: 0,
    serverRefusals: 0,
    requestGateFailures: 0,
    pageErrors: 0,
    consoleErrors: 0,
    expectedCspViolations: null,
    unexpectedCspViolations: null,
};
const increment = (name) => {
    counters[name] = Math.min(10000, counters[name] + 1);
};
const receipt = {
    schemaVersion: 1,
    runId,
    scenario: 'fresh-unsupported-full-app-window',
    status: 'preparing',
    phase: 'input',
    scratch,
    profile,
    counters,
    observations: {},
    sourceHashes: {},
    actualWindowEntryExecution: false,
    realSdkLogin: false,
    nativeExecution: false,
    encryptedExchange: false,
    physicalDeviceExecution: false,
    independentAudit: false,
    syntheticPagehide: true,
    realOsLifecycleOrBfCacheProved: false,
    productionTouched: false,
    humanBrowserOrDevicesChanged: false,
    packagesInstalled: false,
    browserProcessNetworkingMeasured: false,
    requestMeasurementScope: 'owned page/CDP, exact loopback server and entry fence only',
    startedAtUTC: new Date().toISOString(),
};
const save = () => writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
save();
console.info('Nonsecret full App Window receipt: ' + receiptPath);
let browser, server, child, build, originalReceiptBytes, assets, origin;
let launchAttempted = false;
let allSources, toolInputs;
const deadline = Date.now() + 150000;
const remaining = () => {
    assert(Date.now() < deadline, 'Owned Window deadline');
    return Math.max(1, Math.min(20000, deadline - Date.now()));
};
function regular(path, limit = 128 * 1024 * 1024) {
    const value = lstatSync(path);
    assert(value.isFile() && !value.isSymbolicLink() && value.size > 0 && value.size <= limit);
    return realpathSync(path);
}
function tree(root) {
    const result = [];
    const visit = (directory) => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            const path = join(directory, entry.name);
            assert(!entry.isSymbolicLink());
            if (entry.isDirectory()) visit(path);
            else {
                assert(entry.isFile());
                result.push(path);
            }
            assert(result.length <= 2000);
        }
    };
    visit(root);
    return result.sort();
}
function frozen() {
    assert(fileHash(receipt.buildReceipt.path) === receipt.buildReceipt.sha256);
    for (const input of allSources) assert(fileHash(input.path) === input.sha256, 'Owned Window source drift');
    for (const input of toolInputs) assert(fileHash(input.path) === input.sha256, 'Owned Window tool drift');
    for (const input of build.artifacts) assert(fileHash(input.path) === input.sha256, 'Owned Window artifact drift');
    assert.deepEqual(tree(build.dist), build.artifacts.map((row) => row.path).sort());
}
async function readEvidence() {
    const raw = await browserPage.evaluate((name) => {
        const property = Object.getOwnPropertyDescriptor(window, name);
        if (!property) return null;
        if (property.configurable || property.set || typeof property.get !== 'function') return { invalid: true };
        return window[name];
    }, WINDOW_EVIDENCE_GLOBAL);
    return raw === null ? null : inspectWindowEvidence(raw, runId);
}
let browserPage;
async function waitEvidence(mounts, remounts, stopped = false) {
    const until = Math.min(deadline, Date.now() + 20000);
    while (Date.now() < until) {
        assert(counters.refusedRequests === 0 && counters.serverRefusals === 0 && counters.requestGateFailures === 0);
        assert(counters.pageErrors === 0, 'Owned Window script failed');
        const evidence = await readEvidence();
        if (evidence?.phase === 'failed' || evidence?.fence?.status === 'failed') {
            receipt.observations.last = evidence;
            throw new Error('Owned Window isolation refused');
        }
        if (
            evidence?.phase === 'ready' &&
            evidence.auth.status === (stopped ? 'inactive' : 'unsupported') &&
            evidence.root.mounts === mounts &&
            evidence.root.remounts === remounts &&
            evidence.lifecycle.stopped === stopped
        ) {
            receipt.observations.last = evidence;
            requireUnsupportedWindowEvidence(evidence, mounts, remounts, stopped);
            return evidence;
        }
        await delay(50);
    }
    throw new Error('Owned Window observation deadline');
}
async function domFacts() {
    return browserPage.evaluate(() => {
        const button = (label) =>
            [...document.querySelectorAll('button')].find((node) => node.textContent.trim() === label);
        const metaPolicies = [...document.querySelectorAll('meta[http-equiv]')].filter(
            (node) => node.getAttribute('http-equiv').toLowerCase() === 'content-security-policy',
        );
        const metaFrameDenied =
            metaPolicies.length === 1 &&
            metaPolicies.every((node) => {
                const directives = node
                    .getAttribute('content')
                    .split(';')
                    .map((value) => value.trim());
                const frames = directives.filter((value) => /^frame-src(?:\s|$)/.test(value));
                return frames.length === 1
                    ? frames[0] === "frame-src 'none'"
                    : frames.length === 0 && directives.filter((value) => value === "default-src 'none'").length === 1;
            });
        return {
            metaCspPolicyCount: metaPolicies.length,
            metaFrameDenied,
            actualAppNavigation: !!document.querySelector('nav[aria-label="Main"]'),
            unsupportedAccount: document.body.textContent.includes('Account: unsupported'),
            unavailablePrivateView: document.body.textContent.includes(
                'The native private message test is unavailable',
            ),
            stoppedNotice: document.body.textContent.includes('Research window stopped.'),
            signInDisabled: button('Sign in and verify')?.disabled === true,
            privateOpenDisabled: button('Check native setup and open messages')?.disabled === true,
            messageLogAbsent: !document.querySelector('[role="log"]'),
            expectedCspViolations:
                document.documentElement.dataset.fullAppExpectedCsp === undefined
                    ? null
                    : Number(document.documentElement.dataset.fullAppExpectedCsp),
            unexpectedCspViolations:
                document.documentElement.dataset.fullAppUnexpectedCsp === undefined
                    ? null
                    : Number(document.documentElement.dataset.fullAppUnexpectedCsp),
        };
    });
}
async function waitDom(predicate) {
    const until = Math.min(deadline, Date.now() + 20000);
    while (Date.now() < until) {
        const facts = await domFacts();
        counters.expectedCspViolations = facts.expectedCspViolations;
        counters.unexpectedCspViolations = facts.unexpectedCspViolations;
        receipt.observations.dom = facts;
        assert(Number.isInteger(facts.expectedCspViolations) && Number.isInteger(facts.unexpectedCspViolations));
        assert(facts.unexpectedCspViolations === 0, 'Unexpected Window CSP refusal');
        if (predicate(facts)) return facts;
        await delay(50);
    }
    throw new Error('Owned Window DOM deadline');
}
function mediaType(path) {
    const extension = path.split('.').pop();
    return (
        {
            html: 'text/html; charset=utf-8',
            js: 'text/javascript; charset=utf-8',
            css: 'text/css; charset=utf-8',
            svg: 'image/svg+xml',
            png: 'image/png',
            webp: 'image/webp',
            jpg: 'image/jpeg',
            woff: 'font/woff',
            woff2: 'font/woff2',
        }[extension] ?? 'application/octet-stream'
    );
}
try {
    assert(checkout === '/Users/shanestratton/.codex/worktrees/scuttlebutt-e2ee/thalassa-marine-weather');
    assert(process.platform === 'darwin' && process.arch === 'arm64' && /^v24\./.test(process.version));
    const [buildPath, expectedHash, ...extra] = process.argv.slice(2);
    assert(extra.length === 0 && buildPath?.startsWith('/') && isWindowProofHash(expectedHash));
    const canonicalReceipt = regular(buildPath, 16 * 1024 * 1024);
    originalReceiptBytes = readFileSync(canonicalReceipt);
    assert(sha(originalReceiptBytes) === expectedHash);
    receipt.buildReceipt = { path: canonicalReceipt, sha256: expectedHash };
    build = inspectWindowBuildReceipt(JSON.parse(originalReceiptBytes.toString('utf8')), checkout);
    const temp = realpathSync(tmpdir()) + sep;
    assert(build.dist.startsWith(temp) && !build.dist.startsWith(checkout + sep));
    assert(lstatSync(build.dist).isDirectory() && !lstatSync(build.dist).isSymbolicLink());
    assert(realpathSync(build.dist) === build.dist);
    const dependencyRoot = realpathSync(join(checkout, 'node_modules')) + sep;
    for (const input of build.sourceInputs) {
        assert(
            input.path.startsWith(checkout + sep) ||
                input.path.startsWith(dependencyRoot) ||
                input.path.startsWith(temp + 'thalassa-owned-route-dependency-'),
        );
        assert(regular(input.path) === input.path);
    }
    const ownedSourceNames = ['windowProof.mjs', 'windowProofContract.mjs'];
    const driverSources = ownedSourceNames.map((name) => ({
        path: join(here, name),
        sha256: fileHash(join(here, name)),
    }));
    allSources = [...build.sourceInputs, ...build.proofSources, ...driverSources];
    receipt.sourceHashes = Object.fromEntries(
        [...build.proofSources, ...driverSources].map((row) => [relative(checkout, row.path), row.sha256]),
    );
    receipt.buildSourceCount = build.sourceInputs.length;
    receipt.buildOutputCount = build.artifacts.length;
    const packagePath = realpathSync(join(checkout, 'node_modules/puppeteer-core/package.json'));
    const packageBytes = readFileSync(packagePath),
        pkg = JSON.parse(packageBytes.toString('utf8'));
    assert(pkg.name === 'puppeteer-core' && pkg.version === '25.4.0');
    const entry = realpathSync(join(dirname(packagePath), 'lib/puppeteer/puppeteer-core.js'));
    const revisionPath = realpathSync(join(dirname(packagePath), 'lib/puppeteer/revisions.js'));
    assert(readFileSync(revisionPath, 'utf8').includes("chrome: '" + chromeVersion + "'"));
    const executable = regular(chrome),
        nodeExecutable = regular(realpathSync(process.execPath));
    assert(executable === chrome);
    toolInputs = [nodeExecutable, executable, packagePath, entry, revisionPath].map((path) => ({
        path,
        sha256: fileHash(path),
    }));
    receipt.tools = {
        nodeVersion: process.version,
        puppeteerCoreVersion: pkg.version,
        pinnedChromeVersion: chromeVersion,
        inputs: toolInputs,
        noConfigDiscovery: true,
        noDownloads: true,
    };
    assets = new Map(build.artifacts.map((row) => ['/' + relative(build.dist, row.path).split(sep).join('/'), row]));
    const assetPaths = new Set(assets.keys());
    frozen();
    receipt.phase = 'owned-loopback-server';
    server = createServer((request, response) => {
        try {
            assert(request.headers.host === new URL(origin).host);
            assert(request.headers.authorization === undefined && request.headers.cookie === undefined);
            const category = classifyWindowRequest({
                url: origin + request.url,
                method: request.method,
                origin,
                runId,
                nonce,
                assetPaths,
            });
            response.setHeader('Content-Security-Policy', WINDOW_PROOF_CSP);
            response.setHeader('Cache-Control', 'no-store');
            response.setHeader('X-Content-Type-Options', 'nosniff');
            if (category === 'favicon-control') {
                increment('serverFaviconControls');
                response.writeHead(204);
                response.end();
                return;
            }
            if (category === 'csp-control') increment('serverCspEscapes');
            if (category !== 'document' && category !== 'asset') {
                increment('serverRefusals');
                response.writeHead(403);
                response.end();
                return;
            }
            const row = assets.get(new URL(origin + request.url).pathname);
            const bytes = readFileSync(row.path);
            assert(sha(bytes) === row.sha256);
            increment(category === 'document' ? 'serverDocuments' : 'serverAssets');
            response.setHeader('Content-Type', mediaType(row.path));
            response.writeHead(200);
            response.end(bytes);
        } catch {
            increment('serverRefusals');
            response.writeHead(403);
            response.end();
        }
    });
    await new Promise((resolveListen, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolveListen);
    });
    const address = server.address();
    assert(address && typeof address === 'object' && address.address === '127.0.0.1');
    origin = 'http://127.0.0.1:' + address.port;
    mkdirSync(profile, { mode: 0o700 });
    const { default: puppeteer } = await import(pathToFileURL(entry).href);
    receipt.phase = 'owned-browser-launch';
    save();
    launchAttempted = true;
    browser = await puppeteer.launch({
        executablePath: executable,
        userDataDir: profile,
        headless: true,
        timeout: remaining(),
        protocolTimeout: 20000,
        dumpio: false,
        env: { PATH: '/usr/bin:/bin', TMPDIR: scratch, LANG: 'en_US.UTF-8' },
        args: [
            '--disable-background-networking',
            '--disable-component-update',
            '--disable-domain-reliability',
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-sync',
            '--disable-breakpad',
            '--disable-crash-reporter',
            '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
        ],
    });
    child = browser.process();
    assert(child && Number.isInteger(child.pid) && child.pid > 0);
    receipt.ownedBrowserPid = child.pid;
    receipt.tools.observedChromeVersion = await browser.version();
    assert(receipt.tools.observedChromeVersion.endsWith('/' + chromeVersion));
    browserPage = await browser.newPage();
    await browserPage.setRequestInterception(true);
    browserPage.on('request', (request) => {
        try {
            const category = request.redirectChain().length
                ? 'refused'
                : classifyWindowRequest({
                      url: request.url(),
                      method: request.method(),
                      origin,
                      runId,
                      nonce,
                      assetPaths,
                  });
            const names = {
                document: 'documents',
                asset: 'assets',
                'favicon-control': 'faviconControls',
                'csp-control': 'cspControls',
                refused: 'refusedRequests',
            };
            increment(names[category]);
            const operation =
                category === 'refused' || category === 'csp-control'
                    ? request.abort('blockedbyclient')
                    : request.continue();
            void operation.catch(() => increment('requestGateFailures'));
        } catch {
            increment('requestGateFailures');
        }
    });
    browserPage.on('pageerror', () => increment('pageErrors'));
    browserPage.on('console', (message) => {
        if (message.type() === 'error') increment('consoleErrors');
    });
    await browserPage.evaluateOnNewDocument((controlPath) => {
        let expected = 0,
            unexpected = 0;
        const publish = () => {
            if (document.documentElement) {
                document.documentElement.dataset.fullAppExpectedCsp = String(expected);
                document.documentElement.dataset.fullAppUnexpectedCsp = String(unexpected);
            }
        };
        document.addEventListener('securitypolicyviolation', (event) => {
            if (event.effectiveDirective === 'frame-src' && event.blockedURI === location.origin + controlPath)
                expected = Math.min(10000, expected + 1);
            else unexpected = Math.min(10000, unexpected + 1);
            publish();
        });
        document.addEventListener('DOMContentLoaded', publish, { once: true });
    }, WINDOW_CSP_CONTROL_PATH);
    // No security-policy bypass, permission grant, browser API replacement or original transport capture.
    receipt.phase = 'actual-entry-root';
    save();
    const target = new URL('/index.html', origin);
    target.searchParams.set(WINDOW_RUN_QUERY, runId);
    target.searchParams.set(WINDOW_NONCE_QUERY, nonce);
    const response = await browserPage.goto(target.href, { waitUntil: 'domcontentloaded', timeout: remaining() });
    assert(response?.status() === 200 && response.headers()['content-security-policy'] === WINDOW_PROOF_CSP);
    receipt.observations.cold = await waitEvidence(1, 0);
    await waitDom(
        (facts) =>
            facts.actualAppNavigation && facts.unsupportedAccount && facts.signInDisabled && facts.privateOpenDisabled,
    );
    await browserPage.evaluate(() =>
        window.dispatchEvent(new CustomEvent('thalassa:navigate', { detail: { tab: 'chat' } })),
    );
    receipt.observations.chat = await waitDom((facts) => facts.unavailablePrivateView && facts.messageLogAbsent);
    const invalidRemount = await browserPage.evaluate(
        (name, id, secret) => {
            const descriptor = Object.getOwnPropertyDescriptor(window, name);
            if (!descriptor || descriptor.configurable || descriptor.writable || typeof descriptor.value !== 'function')
                return null;
            return descriptor.value({ runId: id, nonce: secret });
        },
        WINDOW_REMOUNT_GLOBAL,
        runId,
        nonce === '0'.repeat(64) ? 'f'.repeat(64) : '0'.repeat(64),
    );
    assert(invalidRemount === false);
    receipt.phase = 'synthetic-pagehide';
    save();
    await browserPage.evaluate(() =>
        window.dispatchEvent(new window.PageTransitionEvent('pagehide', { persisted: false })),
    );
    receipt.observations.closed = await waitEvidence(1, 0, true);
    await waitDom((facts) => facts.stoppedNotice && facts.unavailablePrivateView && facts.messageLogAbsent);
    receipt.phase = 'whole-root-remount';
    save();
    assert(
        (await browserPage.evaluate(
            (name, id, secret) => window[name]({ runId: id, nonce: secret }),
            WINDOW_REMOUNT_GLOBAL,
            runId,
            nonce,
        )) === true,
    );
    receipt.observations.remounted = await waitEvidence(2, 1);
    await waitDom(
        (facts) =>
            facts.actualAppNavigation &&
            facts.unsupportedAccount &&
            facts.unavailablePrivateView &&
            facts.signInDisabled &&
            facts.privateOpenDisabled &&
            facts.messageLogAbsent &&
            !facts.stoppedNotice,
    );
    assert(
        (await browserPage.evaluate(
            (name, id, secret) => window[name]({ runId: id, nonce: secret }),
            WINDOW_REMOUNT_GLOBAL,
            runId,
            nonce,
        )) === false,
    );
    receipt.phase = 'expected-csp-resource-control';
    save();
    const policyFacts = await domFacts();
    assert(policyFacts.metaCspPolicyCount === 1 && policyFacts.metaFrameDenied === true);
    receipt.observations.cspPolicies = {
        responseHeaderVerified: true,
        metaPolicyCount: policyFacts.metaCspPolicyCount,
        metaFrameDenied: policyFacts.metaFrameDenied,
        enforcingPolicyCount: 1 + policyFacts.metaCspPolicyCount,
    };
    await browserPage.evaluate((path) => {
        const frame = document.createElement('iframe');
        frame.title = 'Owned CSP control';
        frame.hidden = true;
        frame.src = location.origin + path;
        document.body.appendChild(frame);
    }, WINDOW_CSP_CONTROL_PATH);
    await waitDom((facts) => facts.expectedCspViolations >= 1);
    await delay(250);
    receipt.observations.final = await waitEvidence(2, 1);
    const cspFacts = await waitDom((facts) => facts.expectedCspViolations >= 1);
    receipt.observations.cspControl = inspectWindowCspControl({
        expectedEventCount: cspFacts.expectedCspViolations,
        unexpectedEventCount: cspFacts.unexpectedCspViolations,
        enforcingPolicyCount: receipt.observations.cspPolicies.enforcingPolicyCount,
    });
    assert(
        counters.refusedRequests === 0 &&
            counters.serverRefusals === 0 &&
            counters.serverCspEscapes === 0 &&
            counters.requestGateFailures === 0 &&
            counters.pageErrors === 0 &&
            counters.documents === 1 &&
            counters.serverDocuments === 1,
    );
    // Explicit synthetic terminal closure settles this fixture before the owned browser is closed.
    await browserPage.evaluate(() =>
        window.dispatchEvent(new window.PageTransitionEvent('pagehide', { persisted: false })),
    );
    receipt.observations.terminal = await waitEvidence(2, 1, true);
    const terminalFacts = await waitDom((facts) => facts.stoppedNotice);
    receipt.observations.cspControl = inspectWindowCspControl({
        expectedEventCount: terminalFacts.expectedCspViolations,
        unexpectedEventCount: terminalFacts.unexpectedCspViolations,
        enforcingPolicyCount: receipt.observations.cspPolicies.enforcingPolicyCount,
    });
    frozen();
    receipt.status = 'passed';
    receipt.phase = 'complete';
    receipt.actualWindowEntryExecution = true;
} catch {
    receipt.status = 'failed';
    receipt.failure = receipt.phase;
    // Preserve valid observations and measured counters; absent evidence stays absent.
    if (browserPage) {
        try {
            const evidence = await readEvidence();
            if (evidence) receipt.observations.last = evidence;
        } catch {
            /* fixed refusal */
        }
        try {
            await domFacts().then((facts) => {
                receipt.observations.dom = facts;
                counters.expectedCspViolations = facts.expectedCspViolations;
                counters.unexpectedCspViolations = facts.unexpectedCspViolations;
            });
        } catch {
            /* no invented zero snapshot */
        }
    }
    process.exitCode = 1;
    console.error('FAIL owned full App Window proof; fixed receipt retains measured counters and valid snapshots.');
} finally {
    receipt.cleanup = {
        browserClosed: browser ? false : !launchAttempted,
        serverClosed: !server,
        ownedProfileRemoved: false,
    };
    if (browser) {
        try {
            await Promise.race([
                browser.close(),
                delay(5000).then(() => {
                    throw new Error('Owned browser close deadline');
                }),
            ]);
            receipt.cleanup.browserClosed = true;
        } catch {
            if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
            for (
                let attempt = 0;
                child && child.exitCode === null && child.signalCode === null && attempt < 20;
                attempt++
            )
                await delay(100);
            receipt.cleanup.browserClosed = !!child && (child.exitCode !== null || child.signalCode !== null);
        }
    }
    if (server) {
        try {
            server.closeAllConnections();
            await new Promise((done, reject) => server.close((error) => (error ? reject(error) : done())));
            receipt.cleanup.serverClosed = true;
        } catch {
            /* retain cleanup failure */
        }
    }
    try {
        if (receipt.cleanup.browserClosed) {
            const metadata = lstatSync(profile, { throwIfNoEntry: false });
            if (metadata) {
                assert(
                    metadata.isDirectory() &&
                        !metadata.isSymbolicLink() &&
                        realpathSync(profile) === profile &&
                        dirname(profile) === scratch,
                );
                rmSync(profile, { recursive: true, force: false });
            }
            receipt.cleanup.ownedProfileRemoved = true;
        }
    } catch {
        /* preserve exact owned profile for recovery */
    }
    if (
        receipt.status === 'passed' &&
        (counters.refusedRequests ||
            counters.serverRefusals ||
            counters.serverCspEscapes ||
            counters.requestGateFailures ||
            counters.pageErrors ||
            counters.unexpectedCspViolations)
    ) {
        receipt.status = 'failed';
        receipt.failure = 'final-observations';
        process.exitCode = 1;
    }
    if (!Object.values(receipt.cleanup).every(Boolean)) {
        receipt.status = 'cleanup-incomplete';
        process.exitCode = 1;
    }
    receipt.completedAtUTC = new Date().toISOString();
    save();
}
if (receipt.status === 'passed')
    console.info(
        'PASS isolated unsupported actual Window/root entry; no SDK login, native/BFCache or release acceptance.',
    );
