// Synthetic extracted-helper/source checks only. No Swift, app, native crypto,
// simulator, OS callback, account operation or acceptance run is executed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { inspectSceneAuthorityTimingEvidence } from './sceneAuthorityTimingContract.mjs';
import { inspectResearchSceneLifecycleEvidence } from './researchSceneLifecycleContract.mjs';

const read = (name) => readFileSync(new URL(name, import.meta.url), 'utf8');
const repository = fileURLToPath(new URL('../../..', import.meta.url));
const frozenBase = '496accdcfedb6ea2502cb6d6b0cbf87f465b73d8';
const original = (name) =>
    execFileSync('/usr/bin/git', ['show', frozenBase + ':experiments/scuttlebutt-e2ee/' + name], {
        cwd: repository,
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
    });
const driver = read('fullAppProtectedUiProof.mjs');
const oldDriver = original('bridge-native/fullAppProtectedUiProof.mjs');
const scene = read('ResearchFullAppSceneUiFixture.swift');
const protectedFixture = read('ResearchFullAppProtectedUiFixture.swift');
const hostValue = (value) => JSON.parse(JSON.stringify(value));
const digest = (value) => createHash('sha256').update(value).digest('hex');

// The existing wiring-suite lexer preserves literals and ignores comments;
// source equality here does not substitute for compilation/native execution.
function lex(source) {
    return [
        ...source.matchAll(
            /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\/[^\n]*|\/\*[\s\S]*?\*\/|[A-Za-z_$][\w$]*|\d+|===|!==|==|!=|&&|\|\||\?\?|\.\.\.|->|=>|[^\s]/g,
        ),
    ]
        .filter((match) => !match[0].startsWith('//') && !match[0].startsWith('/*'))
        .map((match) => ({ text: match[0], index: match.index, end: match.index + match[0].length }));
}
const tokens = (source) => lex(source).map((token) => token.text);
function enclosed(source, pattern, opening = '{', closing = '}') {
    const match = pattern.exec(source);
    assert.ok(match, 'required declaration absent: ' + pattern);
    const list = lex(source).filter((token) => token.index >= match.index + match[0].length);
    const start = list.findIndex((token) => token.text === opening);
    assert.ok(start >= 0, 'required body absent');
    let depth = 0;
    for (let index = start; index < list.length; index++) {
        if (list[index].text === opening) depth++;
        if (list[index].text === closing && --depth === 0)
            return { body: source.slice(list[start].end, list[index].index), start: match.index, end: list[index].end };
    }
    assert.fail('unterminated source body');
}
const jsBody = (source, name) => enclosed(source, new RegExp('(?:async\\s+)?\\bfunction\\s+' + name + '\\s*\\(')).body;
const swiftBody = (source, name) => enclosed(source, new RegExp('\\bfunc\\s+' + name + '\\s*\\(')).body;
const functionBytes = (source, name) => {
    const region = enclosed(source, new RegExp('(?:async\\s+)?\\bfunction\\s+' + name + '\\s*\\('));
    return source.slice(region.start, region.end);
};
function position(list, source, after = -1) {
    const wanted = tokens(source);
    for (let index = after + 1; index <= list.length - wanted.length; index++)
        if (wanted.every((value, offset) => list[index + offset] === value)) return index;
    assert.fail('required operation absent or out of order: ' + source);
}

function syntheticTiming() {
    return {
        version: 1,
        kind: 'research-scene-authority-timing-observations',
        runID: '12345678-1234-4234-8234-123456789abc',
        nonce: 'a'.repeat(64),
        resourceSHA256: 'b'.repeat(64),
        process: { pid: 42, epoch: '22345678-1234-4234-8234-123456789abc' },
        timing: {
            version: 1,
            kind: 'scene-authority-timing-diagnostic',
            evidenceCategory: 'simulator-native-observations',
            status: 'recording',
            entries: [
                {
                    sequence: 1,
                    phase: 'authority-unavailable',
                    sinceFirstVerify: 'unobserved',
                    sinceOriginalCapture: 'unobserved',
                    fenceAttempts: null,
                    verifyCompletions: null,
                    facadeObserved: false,
                    originalObserved: false,
                    accountPresent: null,
                    originalCurrent: null,
                },
            ],
            acceptanceEvidence: false,
            authorityMutated: false,
        },
        acceptanceEvidence: false,
        authorityMutated: false,
    };
}

// Current extracted helpers operate on invented immutable byte buffers and
// mocked file ownership. This cannot establish native process/artifact identity.
function captureFixture(edit = () => {}) {
    const diagnostic = syntheticTiming();
    const files = {
        epoch: diagnostic.process.epoch,
        observer: '/synthetic-owned/scene/scene-observer.json',
        authorityTiming: '/synthetic-owned/scene/scene-authority-timing.json',
    };
    const observer = {
        version: 1,
        kind: 'research-scene-lifecycle-observations',
        runID: diagnostic.runID,
        nonce: diagnostic.nonce,
        resourceSHA256: diagnostic.resourceSHA256,
        process: { ...diagnostic.process },
        evidenceCategory: 'simulator-native-observations',
        status: 'recording',
        eventCount: 1,
        events: [
            {
                index: 0,
                sequence: 1,
                event: 'process-started',
                activationState: 'unattached',
                cover: Object.fromEntries(
                    [
                        'present',
                        'opaque',
                        'attachedToOwnedWindow',
                        'coversOwnedWindowBounds',
                        'accessibilityModal',
                        'contentAccessibilityHidden',
                    ].map((key) => [key, false]),
                ),
                authority: {
                    observationStatus: 'unavailable',
                    facadeObserved: false,
                    originalSnapshotObserved: false,
                    accountPresent: null,
                    originalSnapshotCurrent: null,
                    verifyFenceCompletions: null,
                },
            },
        ],
        osLifecycleProved: false,
        authorityMutated: false,
    };
    const contents = new Map([
        [files.observer, Buffer.from(JSON.stringify(observer, null, 2) + '\r\n')],
        [files.authorityTiming, Buffer.from(' \n' + JSON.stringify(diagnostic, null, 1) + '\n')],
        ['/synthetic-private/scene-resource.json', Buffer.from('{}')],
        ['/synthetic-private/fixture-resource.json', Buffer.from('{}')],
    ]);
    const hashes = new Map([
        ['/synthetic-private/scene-resource.json', diagnostic.resourceSHA256],
        ['/synthetic-private/fixture-resource.json', 'c'.repeat(64)],
        ['/synthetic-checkout/driver.mjs', 'd'.repeat(64)],
    ]);
    const writes = [],
        saves = [],
        events = [];
    const state = {
        assert,
        Buffer,
        createHash,
        dirname,
        join,
        JSON,
        runID: diagnostic.runID,
        nonce: diagnostic.nonce,
        sceneProof: true,
        scenePins: undefined,
        sceneFixtureFile: '/synthetic-private/scene-resource.json',
        protectedFixtureFile: '/synthetic-private/fixture-resource.json',
        checkout: '/synthetic-checkout',
        scratch: '/synthetic-private',
        sceneAuthorityTimingDiagnosticCaptureComplete: false,
        sceneAuthorityTimingDiagnosticAttempted: false,
        receipt: {
            status: 'failed',
            ownedLaunchPID: diagnostic.process.pid,
            nativeProtectedExchangeAccepted: false,
            realOsLifecycleProved: false,
            sourceHashes: { 'driver.mjs': 'd'.repeat(64) },
            sceneFixtureResource: { sha256: diagnostic.resourceSHA256 },
            fixtureResource: { sha256: 'c'.repeat(64) },
        },
        process: { getuid: () => 501 },
        sceneFiles: () => files,
        existsSync: (path) => contents.has(path),
        lstatSync: (path) => ({
            uid: 501,
            mode: path === dirname(files.observer) || path === '/synthetic-private' ? 0o40700 : 0o100600,
        }),
        regular: (path, limit = 16 * 1024 * 1024) => {
            assert.ok(contents.has(path) || hashes.has(path));
            assert.equal(state.lstatSync(path).uid, state.process.getuid());
            if (contents.has(path)) assert.ok(contents.get(path).length > 0 && contents.get(path).length <= limit);
            return path;
        },
        readFileSync: (path, encoding) =>
            encoding ? contents.get(path).toString(encoding) : Buffer.from(contents.get(path)),
        hash: (path) => hashes.get(path) ?? digest(contents.get(path)),
        writeFileSync: (path, bytes, options) => {
            assert.ok(!contents.has(path), 'exclusive copy must not overwrite');
            assert.deepEqual(hostValue(options), { mode: 0o600, flag: 'wx' });
            assert.ok(Buffer.isBuffer(bytes));
            contents.set(path, Buffer.from(bytes));
            writes.push(path);
            events.push('copy');
        },
        inspectResearchSceneLifecycleEvidence,
        inspectSceneAuthorityTimingEvidence: (input, pin) => {
            events.push('admission');
            return inspectSceneAuthorityTimingEvidence(hostValue(input), hostValue(pin));
        },
        save: () => saves.push(hostValue(state.receipt)),
    };
    edit({ state, contents, hashes, files, diagnostic, observer, writes, saves, events });
    runInNewContext(
        functionBytes(driver, 'inspectSceneObservation') +
            '\n' +
            functionBytes(driver, 'captureSceneAuthorityTimingDiagnostic'),
        state,
        { timeout: 1000 },
    );
    return {
        state,
        contents,
        hashes,
        files,
        diagnostic,
        observer,
        writes,
        saves,
        events,
        invoke: () => state.captureSceneAuthorityTimingDiagnostic(),
    };
}

test('timing leaves all original driver helpers and scene validators unchanged', () => {
    for (const name of [...oldDriver.matchAll(/^(?:async )?function (\w+)\(/gm)].map((match) => match[1]))
        assert.equal(
            functionBytes(driver, name).replace(
                "        authorityTiming: join(directory, 'scene-authority-timing.json'),\n",
                '',
            ),
            functionBytes(oldDriver, name),
            name + ' original bytes changed',
        );
    for (const name of [
        'bridge-native/researchSceneLifecycleContract.mjs',
        'bridge-native/ScuttlebuttResearchAuthPlugin.swift',
        'full-app-pilot/nativeProtectedUiFixture.js',
    ])
        assert.equal(read('../' + name), original(name), name + ' changed');
});

test('timing source pins and the 30-input scene inventory add exactly one recorder without changing ordinary 24', () => {
    const ordinary = enclosed(driver, /\bconst\s+names\s*=\s*(?=\[)/, '[', ']').body;
    const additions = enclosed(driver, /if\s*\(sceneProof\)\s*names\.push/, '(', ')').body;
    assert.doesNotMatch(ordinary, /SceneAuthorityTiming|sceneAuthorityTimingContract/);
    for (const name of ['ResearchSceneAuthorityTimingEvidence.swift', 'sceneAuthorityTimingContract.mjs'])
        assert.equal(
            (additions.match(new RegExp("'bridge-native/" + name.replaceAll('.', '\\.') + "'", 'g')) ?? []).length,
            1,
        );
    assert.doesNotMatch(jsBody(driver, 'sceneSourceBindings'), /SceneAuthorityTiming|sceneAuthorityTimingContract/);
    const builder = read('build.mjs'),
        generator = read('generate_project.rb');
    assert.deepEqual(
        tokens(builder.replace(/join\(HERE, 'ResearchSceneAuthorityTimingEvidence\.swift'\),\s*/, '')),
        tokens(original('bridge-native/build.mjs')),
    );
    assert.deepEqual(
        tokens(generator.replace(/\bResearchSceneAuthorityTimingEvidence\.swift\b/, '')),
        tokens(original('bridge-native/generate_project.rb')),
    );
    const filenames = (source) =>
        tokens(source)
            .filter((token) => /^'[A-Za-z0-9_-]+\.swift'$/.test(token))
            .map((token) => token.slice(1, -1));
    const base = filenames(enclosed(builder, /\bconst\s+sourcePaths\s*=/, '[', ']').body);
    const protectedFiles = filenames(
        enclosed(builder, /if\s*\(fullAppProtectedUi\)\s*sourcePaths\.push/, '(', ')').body,
    );
    const sceneFiles = filenames(enclosed(builder, /if\s*\(sceneResource\)\s*sourcePaths\.push/, '(', ')').body);
    const ordinaryFiles = [...base, 'ResearchLocalUiFixture.swift', ...protectedFiles];
    assert.equal(ordinaryFiles.length, 24);
    assert.equal(ordinaryFiles.length + sceneFiles.length, 30);
    assert.equal(sceneFiles.filter((name) => name === 'ResearchSceneAuthorityTimingEvidence.swift').length, 1);
    const inventory = /scene_sources\s*=\s*%w\[([^\]]+)\]\.sort/.exec(generator)?.[1].trim().split(/\s+/).sort();
    assert.deepEqual([...ordinaryFiles, ...sceneFiles].sort(), inventory);
});

test('native timing persistence uses validated owned observer bindings and scalar snapshots without authority queries', () => {
    const body = swiftBody(scene, 'writeAuthorityTimingDiagnostic'),
        list = tokens(body);
    let after = position(list, 'try observer.persist(inNativeDocumentsRoot: documents).path == observerFile.path');
    after = position(list, '"process": ["pid": observer.processID, "epoch": observer.processEpoch]', after);
    after = position(
        list,
        '"timing": ResearchFullAppProtectedUiFixture.sceneAuthorityTimingEvidence.snapshot()',
        after,
    );
    after = position(list, 'guard (1...16384).contains(bytes.count)', after);
    after = position(list, 'try requireFirstInboxDiagnostic(file, maximumBytes: 16384)', after);
    after = position(list, 'try bytes.write(to: file, options: [.atomic, .completeFileProtection])', after);
    after = position(list, 'try bytes.write(to: file, options: [.withoutOverwriting, .completeFileProtection])', after);
    position(list, 'try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)', after);
    assert.doesNotMatch(
        tokens(body).join(' '),
        /\b(?:currentAccount|currentMessageContext|messageSnapshot|credentialBinding|authenticate|fenceSession|Task|Timer|evaluateJavaScript)\b/,
    );
    assert.match(
        scene,
        /static func persistAuthorityTimingDiagnostic\(\)\s*\{\s*try\? shared\.writeAuthorityTimingDiagnostic\(\)/,
    );
    const recording = tokens(swiftBody(protectedFixture, 'noteSceneTiming')).join(' ');
    assert.doesNotMatch(
        recording,
        /\b(?:currentAccount|currentMessageContext|messageSnapshot|credentialBinding|authenticate|fenceSession|Task|Timer)\s*\(/,
    );
    assert.match(recording, /accountPresent : accountPresent , originalCurrent : originalCurrent/);
});

test('all original native schema, resource, authority and proof predicates keep their exact function bytes', () => {
    const baseline = original('bridge-native/ResearchFullAppProtectedUiFixture.swift');
    for (const name of [
        'fullAppBoolean',
        'fullAppRow',
        'fullAppCounts',
        'fullAppNullableBoolean',
        'fullAppWindow',
        'parse',
        'common',
        'fenced',
        'sanitizedExchange',
        'sceneResourceBinding',
        'sceneWindowEvidence',
        'sceneClosureEvidence',
    ])
        assert.equal(swiftBody(protectedFixture, name), swiftBody(baseline, name), name + ' predicate bytes changed');
});

test('both original authority-fact refusals record unavailable facts without adding an authority query', () => {
    const body = swiftBody(protectedFixture, 'sceneAuthorityFacts');
    const missing = enclosed(body, /guard\s+let\s+facade\s+else/).body;
    const changed = enclosed(
        body,
        /guard\s+shared\.facade\s*===\s*facade,[\s\S]*?shared\.sceneVerifyFenceCompletions\s*==\s*completions\s*else/,
    ).body;
    for (const branch of [missing, changed]) {
        const list = tokens(branch);
        const recorded = position(list, 'noteSceneAuthorityUnavailable()');
        position(list, 'return .unavailable', recorded);
        assert.match(branch, /#if targetEnvironment\(simulator\)\s+noteSceneAuthorityUnavailable\(\)\s+#endif/);
    }
    const unavailable = swiftBody(protectedFixture, 'noteSceneAuthorityUnavailable');
    const list = tokens(unavailable);
    position(list, 'sceneAuthorityTimingEvidence.record(.authorityUnavailable,');
    position(list, 'facadeObserved: false, originalObserved: false');
    assert.doesNotMatch(
        tokens(unavailable).join(' '),
        /\b(?:currentAccount|currentMessageContext|messageSnapshot|credentialBinding|authenticate|fenceSession|Task|Timer|accountPresent|originalCurrent)\s*\(/,
    );
    assert.doesNotMatch(unavailable, /accountPresent\s*:|originalCurrent\s*:/);
    const recorder = read('ResearchSceneAuthorityTimingEvidence.swift');
    assert.match(recorder, /accountPresent:\s*Bool\?\s*=\s*nil,\s*originalCurrent:\s*Bool\?\s*=\s*nil/);
    let removed = 0;
    const preserved = body.replace(/#if targetEnvironment\(simulator\)([\s\S]*?)#endif/g, (_block, content) => {
        const allowed = [
            'noteSceneAuthorityUnavailable()',
            'noteSceneTiming(.authorityObserved, accountPresent: accountPresent, originalCurrent: current)',
        ];
        assert.ok(allowed.some((call) => JSON.stringify(tokens(content)) === JSON.stringify(tokens(call))));
        removed++;
        return '';
    });
    assert.equal(removed, 3);
    assert.deepEqual(
        tokens(preserved),
        tokens(swiftBody(original('bridge-native/ResearchFullAppProtectedUiFixture.swift'), 'sceneAuthorityFacts')),
        'the two original refusal predicates, getter results and return values remain',
    );
});

test('capture strictly binds independent launch/resource/source/private bytes before copying and grants no acceptance', () => {
    const body = jsBody(driver, 'captureSceneAuthorityTimingDiagnostic'),
        list = tokens(body);
    let after = position(list, 'if (!sceneProof || sceneAuthorityTimingDiagnosticAttempted) return');
    for (const source of [
        'sceneAuthorityTimingDiagnosticAttempted = true',
        'assert(Number.isSafeInteger(receipt.ownedLaunchPID) && receipt.ownedLaunchPID > 0)',
        "const observer = inspectSceneObservation(JSON.parse(observerBytes.toString('utf8')))",
        'Object.entries(receipt.sourceHashes)',
        'const inspection = inspectSceneAuthorityTimingEvidence(',
        "writeFileSync(path, diagnosticBytes, { mode: 0o600, flag: 'wx' })",
        "writeFileSync(observerPath, observerBytes, { mode: 0o600, flag: 'wx' })",
        'inspection: inspection.timing',
        'acceptanceEvidence: false',
        'wholeRunAccepted: false',
    ])
        after = position(list, source, after);
    assert.doesNotMatch(
        body,
        /requireResearchSceneProtectedDriverStage|receipt\.status\s*=|nativeObservationPassed|nativeProtectedExchangeAccepted\s*=|realOsLifecycleProved\s*=|\.message\b|\.stack\b/,
    );
});

test('synthetic admitted recording privately preserves exact byte hashes even without prefix pins', () => {
    const fixture = captureFixture();
    fixture.invoke();
    const { state, files, contents, writes, saves } = fixture;
    const retained = state.receipt.sceneAuthorityTimingDiagnostic;
    assert.equal(state.receipt.sceneAuthorityTimingDiagnosticStatus, 'observed-unaccepted');
    assert.equal(state.receipt.sceneAuthorityTimingDiagnosticCaptureComplete, true);
    assert.equal(state.scenePins, undefined);
    assert.equal(writes.length, 2);
    assert.equal(saves.length, 1);
    assert.deepEqual(fixture.events, ['admission', 'copy', 'copy']);
    assert.deepEqual(contents.get(retained.path), contents.get(files.authorityTiming));
    assert.deepEqual(contents.get(retained.binding.observerReceipt.path), contents.get(files.observer));
    assert.equal(retained.sha256, digest(contents.get(files.authorityTiming)));
    assert.equal(retained.sourceSHA256, retained.sha256);
    assert.equal(retained.binding.observerReceipt.sha256, digest(contents.get(files.observer)));
    assert.equal(retained.binding.observerReceipt.sourceSHA256, retained.binding.observerReceipt.sha256);
    assert.equal(retained.binding.pid, 42);
    assert.equal(retained.binding.epoch, files.epoch);
    assert.deepEqual(hostValue(retained.inspection), fixture.diagnostic.timing);
    assert.equal(Object.isFrozen(retained.inspection), true);
    assert.equal(Object.isFrozen(retained.inspection.entries[0]), true);
    const inspected = JSON.stringify(retained.inspection);
    assert.doesNotMatch(inspected, /"(?:nonce|runID|resourceSHA256|process)"/);
    for (const binding of [
        fixture.diagnostic.nonce,
        fixture.diagnostic.runID,
        fixture.diagnostic.resourceSHA256,
        fixture.files.epoch,
    ])
        assert.equal(inspected.includes(binding), false);
    assert.equal(JSON.stringify(state.receipt).includes(fixture.diagnostic.nonce), false);
    assert.equal(retained.acceptanceEvidence, false);
    assert.equal(retained.wholeRunAccepted, false);
    assert.equal(state.receipt.status, 'failed');
    assert.equal(state.receipt.nativeProtectedExchangeAccepted, false);
    assert.equal(state.receipt.realOsLifecycleProved, false);
});

const metadata =
    (path, value) =>
    ({ state }) => {
        const prior = state.lstatSync;
        state.lstatSync = (name) => (name === path ? value : prior(name));
    };
for (const [label, edit] of [
    [
        'missing independent launch PID',
        ({ state }) => {
            delete state.receipt.ownedLaunchPID;
        },
    ],
    [
        'launch PID mismatch',
        ({ state }) => {
            state.receipt.ownedLaunchPID++;
        },
    ],
    [
        'observer directory epoch mismatch',
        ({ files }) => {
            files.epoch = '32345678-1234-4234-8234-123456789abc';
        },
    ],
    ['changed scene resource', ({ hashes }) => hashes.set('/synthetic-private/scene-resource.json', 'e'.repeat(64))],
    [
        'changed protected resource',
        ({ hashes }) => hashes.set('/synthetic-private/fixture-resource.json', 'e'.repeat(64)),
    ],
    ['changed source hash', ({ hashes }) => hashes.set('/synthetic-checkout/driver.mjs', 'e'.repeat(64))],
    ['nonprivate observer directory', metadata('/synthetic-owned/scene', { uid: 501, mode: 0o40750 })],
    ['nonprivate observer file', metadata('/synthetic-owned/scene/scene-observer.json', { uid: 501, mode: 0o100640 })],
    [
        'nonprivate timing file',
        metadata('/synthetic-owned/scene/scene-authority-timing.json', { uid: 501, mode: 0o100640 }),
    ],
    ['foreign scratch owner', metadata('/synthetic-private', { uid: 502, mode: 0o40700 })],
    ['nonprivate scratch directory', metadata('/synthetic-private', { uid: 501, mode: 0o40750 })],
    [
        'unparsed JSON',
        ({ contents, files }) => contents.set(files.authorityTiming, Buffer.from('{"secret":"private-timing-canary"')),
    ],
    [
        'arbitrary extra field',
        ({ contents, files, diagnostic }) =>
            contents.set(
                files.authorityTiming,
                Buffer.from(JSON.stringify({ ...diagnostic, error: 'private-timing-canary' })),
            ),
    ],
    [
        'wrapper binding mismatch',
        ({ contents, files, diagnostic }) =>
            contents.set(files.authorityTiming, Buffer.from(JSON.stringify({ ...diagnostic, nonce: 'f'.repeat(64) }))),
    ],
])
    test('synthetic timing capture refuses ' + label + ' before retaining arbitrary JSON', () => {
        const fixture = captureFixture(edit);
        fixture.invoke();
        assert.equal(fixture.state.receipt.sceneAuthorityTimingDiagnosticStatus, 'refused');
        assert.equal(fixture.state.receipt.sceneAuthorityTimingDiagnosticCaptureComplete, false);
        assert.equal(fixture.state.receipt.sceneAuthorityTimingDiagnostic, undefined);
        assert.equal(fixture.writes.length, 0);
        assert.doesNotMatch(JSON.stringify(fixture.state.receipt), /private-timing-canary|"error"|"stack"/);
    });

test('empty/oversized files refuse and admitted empty/refused/synthetic traces never complete capture', () => {
    for (const [name, length] of [
        ['authorityTiming', 0],
        ['authorityTiming', 16385],
        ['observer', 0],
        ['observer', 65537],
    ]) {
        const fixture = captureFixture(({ contents, files }) => contents.set(files[name], Buffer.alloc(length, 32)));
        fixture.invoke();
        assert.equal(fixture.state.receipt.sceneAuthorityTimingDiagnosticStatus, 'refused');
        assert.equal(fixture.writes.length, 0);
    }
    for (const mutate of [
        (timing) => {
            timing.entries = [];
        },
        (timing) => {
            timing.status = 'clock-refused';
        },
        (timing) => {
            timing.status = 'input-refused';
        },
        (timing) => {
            timing.evidenceCategory = 'synthetic-direct-calls';
        },
    ]) {
        const fixture = captureFixture(({ diagnostic, contents, files }) => {
            mutate(diagnostic.timing);
            contents.set(files.authorityTiming, Buffer.from(JSON.stringify(diagnostic)));
        });
        fixture.invoke();
        assert.equal(fixture.state.receipt.sceneAuthorityTimingDiagnosticStatus, 'observed-unaccepted');
        assert.equal(fixture.state.receipt.sceneAuthorityTimingDiagnosticCaptureComplete, false);
        assert.equal(fixture.writes.length, 2);
        assert.equal(fixture.state.receipt.status, 'failed');
    }
});

test('one attempt is final even after successful, absent or refused capture inputs change', () => {
    for (const kind of ['success', 'missing', 'refused']) {
        let valid;
        const fixture = captureFixture(({ contents, files }) => {
            valid = contents.get(files.authorityTiming);
            if (kind === 'missing') contents.delete(files.authorityTiming);
            if (kind === 'refused') contents.set(files.authorityTiming, Buffer.from('invalid JSON'));
        });
        fixture.invoke();
        const before = hostValue(fixture.state.receipt),
            writes = fixture.writes.length,
            saves = fixture.saves.length;
        fixture.contents.set(fixture.files.authorityTiming, valid);
        fixture.state.sceneFiles = () => assert.fail('finally must not rediscover after the first attempt');
        fixture.invoke();
        assert.deepEqual(hostValue(fixture.state.receipt), before);
        assert.equal(fixture.state.sceneAuthorityTimingDiagnosticAttempted, true);
        assert.equal(fixture.writes.length, writes);
        assert.equal(fixture.saves.length, saves);
    }
});

test('exclusive copies and stable source/copy bytes are necessary for capture completion', () => {
    for (const name of ['scene-authority-timing-diagnostic.json', 'scene-authority-timing-observer.json']) {
        const fixture = captureFixture(({ contents }) =>
            contents.set('/synthetic-private/' + name, Buffer.from('existing')),
        );
        fixture.invoke();
        assert.equal(fixture.state.receipt.sceneAuthorityTimingDiagnosticStatus, 'refused');
        assert.equal(fixture.state.receipt.sceneAuthorityTimingDiagnosticCaptureComplete, false);
        assert.equal(fixture.contents.get('/synthetic-private/' + name).toString(), 'existing');
    }
    for (const kind of ['authorityTiming', 'observer', 'copy']) {
        const fixture = captureFixture(({ state, contents, files, writes }) => {
            const write = state.writeFileSync;
            state.writeFileSync = (...args) => {
                write(...args);
                if (writes.length !== 2) return;
                const path = kind === 'copy' ? writes[0] : files[kind];
                contents.set(path, Buffer.concat([contents.get(path), Buffer.from(' ')]));
            };
        });
        fixture.invoke();
        assert.equal(fixture.state.receipt.sceneAuthorityTimingDiagnosticStatus, 'refused');
        assert.equal(fixture.state.receipt.sceneAuthorityTimingDiagnosticCaptureComplete, false);
        assert.equal(fixture.state.receipt.sceneAuthorityTimingDiagnostic, undefined);
    }
});

test('ordinary capture performs no scene discovery, copy, attempt or save', () => {
    const fixture = captureFixture(({ state }) => {
        state.sceneProof = false;
        state.sceneFiles = () => assert.fail('ordinary mode must not discover timing files');
    });
    fixture.invoke();
    assert.equal(fixture.state.sceneAuthorityTimingDiagnosticAttempted, false);
    assert.equal(fixture.state.receipt.sceneAuthorityTimingDiagnosticStatus, undefined);
    assert.equal(fixture.writes.length, 0);
    assert.equal(fixture.saves.length, 0);
});

test('finally adds timing after all captures without removing any original refusal, cleanup or acceptance operation', () => {
    const body = enclosed(driver, /\}\s*finally\b/).body,
        list = tokens(body);
    let after = position(list, 'captureSceneClosureDiagnostic();');
    after = position(list, 'captureSceneAuthorityTimingDiagnostic();', after);
    after = position(list, "receipt.failedOperation = 'scene-authority-timing-diagnostic-validate'", after);
    after = position(list, 'if (simulator)', after);
    position(list, "quiet('/usr/bin/xcrun', ['simctl', 'delete', simulator])", after);
    const guard = enclosed(
        body,
        /\bif\s*(?=\(\s*sceneProof\s*&&\s*nativeObservationPassed\s*&&\s*firstInboxDiagnosticCaptureComplete\s*&&\s*sceneFinishDiagnosticCaptureComplete\s*&&\s*sceneProgressDiagnosticCaptureComplete\s*&&\s*sceneClosureDiagnosticCaptureComplete\s*&&\s*!sceneAuthorityTimingDiagnosticCaptureComplete)/,
    );
    const preserved = tokens(body.slice(0, guard.start) + body.slice(guard.end));
    for (const source of [
        'captureSceneAuthorityTimingDiagnostic();',
        '&& (!sceneProof || sceneAuthorityTimingDiagnosticCaptureComplete)',
    ]) {
        const index = position(preserved, source);
        preserved.splice(index, tokens(source).length);
    }
    assert.deepEqual(preserved, tokens(enclosed(oldDriver, /\}\s*finally\b/).body));
    const predicate = enclosed(body, /\bif\s*(?=\(\s*nativeObservationPassed\s*&&)/, '(', ')').body;
    const base = {
        sceneProof: true,
        nativeObservationPassed: true,
        firstInboxDiagnosticCaptureComplete: true,
        sceneFinishDiagnosticCaptureComplete: true,
        sceneProgressDiagnosticCaptureComplete: true,
        sceneClosureDiagnosticCaptureComplete: true,
        sceneAuthorityTimingDiagnosticCaptureComplete: true,
        receipt: { ownedSimulatorRemoved: true },
    };
    const accepts = (facts) => runInNewContext('Boolean(' + predicate + ')', facts, { timeout: 1000 });
    assert.equal(accepts(base), true);
    for (const flag of [
        'nativeObservationPassed',
        'firstInboxDiagnosticCaptureComplete',
        'sceneFinishDiagnosticCaptureComplete',
        'sceneProgressDiagnosticCaptureComplete',
        'sceneClosureDiagnosticCaptureComplete',
        'sceneAuthorityTimingDiagnosticCaptureComplete',
    ])
        assert.equal(accepts({ ...base, [flag]: false }), false, flag + ' remains necessary');
    assert.equal(accepts({ ...base, receipt: { ownedSimulatorRemoved: false } }), false);
    assert.equal(accepts({ ...base, sceneProof: false, sceneAuthorityTimingDiagnosticCaptureComplete: false }), true);
});
