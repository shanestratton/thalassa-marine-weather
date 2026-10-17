// Synthetic extracted-driver/source checks only. No app, Swift, provider,
// simulator, OS callback, protected operation or native acceptance is executed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { inspectSceneClosureCorrelationDiagnostic } from './sceneClosureCorrelationDiagnostic.mjs';
import { inspectResearchSceneLifecycleEvidence } from './researchSceneLifecycleContract.mjs';
import { withoutOwnedLaunchDiagnostic } from './ownedLaunchDiagnosticTestSupport.mjs';
import {
    FULL_APP_PROTECTED_NATIVE_CASES,
    FULL_APP_PROTECTED_DOM_KEYS,
    FULL_APP_PROTECTED_MESSAGE_KEYS,
    FULL_APP_PROTECTED_PM_RESULT_KEYS,
} from './fullAppProtectedUiContract.mjs';
import { FULL_APP_NATIVE_COUNTERS, FULL_APP_NATIVE_HTTP_COUNTERS } from './fullAppUiContract.mjs';
import {
    WINDOW_FENCE_COUNTERS,
    WINDOW_BOUNDARY_COUNTERS,
    WINDOW_MEMORY_COUNTERS,
} from '../full-app-pilot/windowProofContract.mjs';

const read = (name) => readFileSync(new URL(name, import.meta.url), 'utf8');
const repository = fileURLToPath(new URL('../../..', import.meta.url));
const frozenBase = 'c54d3fec2aa32de6e3460890445f025a439c1b92';
const original = (name) =>
    execFileSync('/usr/bin/git', ['show', frozenBase + ':experiments/scuttlebutt-e2ee/' + name], {
        cwd: repository,
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
    });
const driver = read('fullAppProtectedUiProof.mjs');
const oldDriver = original('bridge-native/fullAppProtectedUiProof.mjs');
const builder = read('build.mjs');
const generator = read('generate_project.rb');
const hostValue = (value) => JSON.parse(JSON.stringify(value));
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

// The existing wiring-suite lexer preserves literals and ignores comments.
// It is a source contract helper, not a JavaScript or Swift compiler.
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
            return { body: source.slice(list[start].end, list[index].index), end: list[index].end, start: match.index };
    }
    assert.fail('unterminated source body');
}
const functionRegion = (source, name) =>
    enclosed(source, new RegExp('(?:async\\s+)?\\bfunction\\s+' + name + '\\s*\\('));
const jsBody = (source, name) => functionRegion(source, name).body;
const functionBytes = (source, name) => {
    const region = functionRegion(source, name);
    return source.slice(region.start, region.end);
};
function position(list, source, after = -1) {
    const wanted = tokens(source);
    for (let index = after + 1; index <= list.length - wanted.length; index++)
        if (wanted.every((value, offset) => list[index + offset] === value)) return index;
    assert.fail('required operation absent or out of order: ' + source);
}

// Reuse only the sibling suite's pure invented fixture function, without
// importing/registering its tests or duplicating its large protected report.
const fixtureFunction = runInNewContext(
    '(' + functionBytes(read('sceneClosureCorrelationDiagnostic.test.mjs'), 'syntheticPair') + ')',
    {
        FULL_APP_PROTECTED_NATIVE_CASES,
        FULL_APP_PROTECTED_DOM_KEYS,
        FULL_APP_PROTECTED_MESSAGE_KEYS,
        FULL_APP_PROTECTED_PM_RESULT_KEYS,
        FULL_APP_NATIVE_COUNTERS,
        FULL_APP_NATIVE_HTTP_COUNTERS,
        WINDOW_FENCE_COUNTERS,
        WINDOW_BOUNDARY_COUNTERS,
        WINDOW_MEMORY_COUNTERS,
        zero: (names) => Object.fromEntries(names.map((name) => [name, 0])),
        clone: hostValue,
    },
);

// Only current extracted driver helpers run, using in-memory immutable bytes.
// All ownership/process metadata here is synthetic and grants no authority.
function captureFixture(edit = () => {}) {
    const pair = hostValue(fixtureFunction());
    const { pin } = pair;
    const files = {
        observer: '/synthetic-owned/scene/scene-observer.json',
        closure: '/synthetic-owned/scene/scene-ui-closure.json',
        epoch: pin.epoch,
    };
    const observer = {
        version: 1,
        kind: 'research-scene-lifecycle-observations',
        runID: pin.runID,
        nonce: pin.nonce,
        resourceSHA256: pin.resourceSHA256,
        process: { pid: pin.pid, epoch: pin.epoch },
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
        [files.observer, Buffer.from(JSON.stringify(observer, null, 2) + '\n')],
        [files.closure, Buffer.from(' \n' + JSON.stringify(pair.input.closure, null, 1) + '\r\n')],
        ['/synthetic-private/scene-resource.json', Buffer.from('{}')],
        ['/synthetic-private/fixture-resource.json', Buffer.from('{}')],
    ]);
    const hashes = new Map([
        ['/synthetic-private/scene-resource.json', pin.resourceSHA256],
        ['/synthetic-private/fixture-resource.json', pin.protectedResourceSHA256],
        ['/synthetic-checkout/driver.mjs', 'e'.repeat(64)],
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
        runID: pin.runID,
        nonce: pin.nonce,
        sceneProof: true,
        scenePins: { ...pin, sourceBindings: {} },
        sceneBaseline: pair.input.protectedReport,
        checkout: '/synthetic-checkout',
        scratch: '/synthetic-private',
        sceneFixtureFile: '/synthetic-private/scene-resource.json',
        protectedFixtureFile: '/synthetic-private/fixture-resource.json',
        protectedTemplate: 'synthetic-template',
        sceneClosureDiagnosticCaptureComplete: false,
        sceneClosureDiagnosticAttempted: false,
        receipt: {
            status: 'failed',
            ownedLaunchPID: pin.pid,
            nativeProtectedExchangeAccepted: false,
            realOsLifecycleProved: false,
            sourceHashes: { 'driver.mjs': 'e'.repeat(64) },
            sceneFixtureResource: { sha256: pin.resourceSHA256 },
            fixtureResource: { sha256: pin.protectedResourceSHA256 },
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
            assert.ok(!contents.has(path), 'exclusive copy must never overwrite');
            assert.deepEqual(hostValue(options), { mode: 0o600, flag: 'wx' });
            assert.ok(Buffer.isBuffer(bytes));
            contents.set(path, Buffer.from(bytes));
            writes.push({ path, bytes: Buffer.from(bytes), options: hostValue(options) });
            events.push('copy');
        },
        inspectSceneClosureCorrelationDiagnostic: (input, expected) => {
            events.push('admission');
            // JSON-derived driver inputs cross the VM boundary as host objects;
            // this preserves the real parser's ordinary-prototype requirement.
            return inspectSceneClosureCorrelationDiagnostic(hostValue(input), hostValue(expected));
        },
        inspectResearchSceneLifecycleEvidence,
        sceneObservation: () => observer,
        sceneSourceBindings: () => ({}),
        requireResearchSceneProtectedDriverStage: () => {
            events.push('full-stage');
            throw new Error('synthetic full stage refused');
        },
        save: () => saves.push(hostValue(state.receipt)),
    };
    edit({ state, contents, files, hashes, observer, pair, writes, saves, events });
    runInNewContext(
        functionBytes(driver, 'inspectSceneObservation') +
            '\n' +
            functionBytes(driver, 'captureSceneClosureDiagnostic') +
            '\n' +
            functionBytes(driver, 'sceneStage'),
        state,
        { timeout: 1000 },
    );
    return {
        state,
        contents,
        files,
        hashes,
        observer,
        pair,
        writes,
        saves,
        events,
        invoke: () => state.captureSceneClosureDiagnostic(),
        stage: (stage) => state.sceneStage(stage),
    };
}

test('all existing driver helper bytes remain unchanged except one exact foreground capture call', () => {
    assert.equal(
        read('researchSceneLifecycleContract.mjs'),
        original('bridge-native/researchSceneLifecycleContract.mjs'),
    );
    const names = [...oldDriver.matchAll(/^(?:async )?function (\w+)\(/gm)].map((match) => match[1]);
    for (const name of names) {
        const current =
            name === 'quiet' ? withoutOwnedLaunchDiagnostic(functionBytes(driver, name)) : functionBytes(driver, name);
        const preserved = (
            name === 'sceneStage'
                ? current.replace("    if (stage === 'foreground-closed') captureSceneClosureDiagnostic();\n", '')
                : current
        ).replace("        authorityTiming: join(directory, 'scene-authority-timing.json'),\n", '');
        assert.equal(preserved, functionBytes(oldDriver, name), name + ' bytes changed');
    }
    assert.equal((jsBody(driver, 'sceneStage').match(/captureSceneClosureDiagnostic\(\)/g) ?? []).length, 1);
});

test('capture admission precedes private exact-byte copies and never performs proof acceptance', () => {
    const body = jsBody(driver, 'captureSceneClosureDiagnostic'),
        list = tokens(body);
    let after = position(list, 'if (!sceneProof || sceneClosureDiagnosticAttempted) return');
    for (const source of [
        'sceneClosureDiagnosticAttempted = true',
        'assert(scenePins && sceneBaseline)',
        'assert(Number.isSafeInteger(receipt.ownedLaunchPID) && receipt.ownedLaunchPID > 0)',
        "const observer = inspectSceneObservation(JSON.parse(observerBytes.toString('utf8')))",
        'observer.process.pid === receipt.ownedLaunchPID && observer.process.epoch === files.epoch',
        'hash(regular(sceneFixtureFile, 65536)) === receipt.sceneFixtureResource.sha256',
        'hash(regular(protectedFixtureFile, 128 * 1024)) === receipt.fixtureResource.sha256',
        'Object.entries(receipt.sourceHashes)',
        'hash(regular(join(checkout, name))) === expected',
        'scenePins.pid === observer.process.pid && scenePins.epoch === observer.process.epoch',
        'const source = regular(files.closure, 16384)',
        'diagnosticBytes.length > 0 && diagnosticBytes.length <= 16384',
        'const inspection = inspectSceneClosureCorrelationDiagnostic(',
        "writeFileSync(path, diagnosticBytes, { mode: 0o600, flag: 'wx' })",
        "writeFileSync(observerPath, observerBytes, { mode: 0o600, flag: 'wx' })",
        'hash(regular(source, 16384)) === sourceSHA256 && hash(regular(path, 16384)) === sourceSHA256',
        'hash(regular(observerSource, 65536)) === observerSourceSHA256',
        'hash(regular(observerPath, 65536)) === observerSourceSHA256',
        'acceptanceEvidence: false',
        'wholeRunAccepted: false',
    ])
        after = position(list, source, after);
    assert.doesNotMatch(
        body,
        /requireResearchSceneProtectedDriverStage|nativeObservationPassed|receipt\.status\s*=|nativeProtectedExchangeAccepted\s*=|realOsLifecycleProved\s*=|\.message\b|\.stack\b/,
    );
});

test('closure parser adds no Swift input while timing adds exactly one to the unchanged 29/24 inventories', () => {
    assert.equal((builder.match(/'ResearchSceneAuthorityTimingEvidence\.swift'/g) ?? []).length, 1);
    assert.equal((generator.match(/\bResearchSceneAuthorityTimingEvidence\.swift\b/g) ?? []).length, 1);
    assert.deepEqual(
        tokens(builder.replace(/join\(HERE, 'ResearchSceneAuthorityTimingEvidence\.swift'\),\s*/, '')),
        tokens(original('bridge-native/build.mjs')),
    );
    assert.deepEqual(
        tokens(generator.replace(/\bResearchSceneAuthorityTimingEvidence\.swift\b/, '')),
        tokens(original('bridge-native/generate_project.rb')),
    );
    const ordinary = enclosed(driver, /\bconst\s+names\s*=\s*(?=\[)/, '[', ']').body;
    const added = enclosed(driver, /if\s*\(sceneProof\)\s*names\.push/, '(', ')').body;
    assert.doesNotMatch(ordinary, /sceneClosureCorrelationDiagnostic/);
    assert.equal((added.match(/'bridge-native\/sceneClosureCorrelationDiagnostic\.mjs'/g) ?? []).length, 1);
    assert.doesNotMatch(jsBody(driver, 'sceneSourceBindings'), /sceneClosureCorrelationDiagnostic/);
    const filenames = (source) =>
        tokens(source)
            .filter((value) => /^'[A-Za-z0-9_-]+\.swift'$/.test(value))
            .map((value) => value.slice(1, -1));
    const base = filenames(enclosed(builder, /\bconst\s+sourcePaths\s*=/, '[', ']').body);
    const protectedFiles = filenames(
        enclosed(builder, /if\s*\(fullAppProtectedUi\)\s*sourcePaths\.push/, '(', ')').body,
    );
    const sceneFiles = filenames(enclosed(builder, /if\s*\(sceneResource\)\s*sourcePaths\.push/, '(', ')').body);
    const ordinaryFiles = [...base, 'ResearchLocalUiFixture.swift', ...protectedFiles];
    assert.equal(ordinaryFiles.length, 24);
    assert.equal(ordinaryFiles.length + sceneFiles.length, 30);
    assert.equal(
        ordinaryFiles.length +
            sceneFiles.filter((name) => name !== 'ResearchSceneAuthorityTimingEvidence.swift').length,
        29,
    );
    const inventory = /scene_sources\s*=\s*%w\[([^\]]+)\]\.sort/.exec(generator)?.[1].trim().split(/\s+/).sort();
    assert.deepEqual([...ordinaryFiles, ...sceneFiles].sort(), inventory);
});

test('synthetic capture retains admitted raw byte hashes with only fixed Boolean inspection', () => {
    const fixture = captureFixture();
    fixture.invoke();
    const { state, files, contents, writes, saves, pair } = fixture;
    const retained = state.receipt.sceneClosureDiagnostic;
    assert.equal(state.receipt.sceneClosureDiagnosticStatus, 'observed-unaccepted');
    assert.equal(state.receipt.sceneClosureDiagnosticCaptureComplete, true);
    assert.equal(writes.length, 2);
    assert.equal(saves.length, 1);
    assert.deepEqual(contents.get(retained.path), contents.get(files.closure));
    assert.deepEqual(contents.get(retained.binding.observerReceipt.path), contents.get(files.observer));
    assert.equal(retained.sha256, digest(contents.get(files.closure)));
    assert.equal(retained.sourceSHA256, retained.sha256);
    assert.equal(retained.binding.observerReceipt.sha256, digest(contents.get(files.observer)));
    assert.equal(retained.binding.observerReceipt.sourceSHA256, retained.binding.observerReceipt.sha256);
    assert.deepEqual(Object.keys(retained.binding), [
        'runID',
        'resourceSHA256',
        'protectedResourceSHA256',
        'pid',
        'epoch',
        'observerReceipt',
    ]);
    assert.equal(retained.binding.pid, pair.pin.pid);
    assert.equal(retained.binding.epoch, files.epoch);
    const serialized = JSON.stringify(retained.inspection);
    assert.equal(serialized.includes(pair.pin.nonce), false);
    assert.doesNotMatch(
        serialized,
        /nonce|runID|resourceSHA256|protectedProof|"error":|"message":|"raw":|"closure":|protectedReport/,
    );
    assert.equal(JSON.stringify(retained).includes(pair.pin.nonce), false);
    for (const map of Object.values(retained.inspection.facts))
        assert.ok(Object.values(map).every((value) => typeof value === 'boolean'));
    assert.equal(retained.acceptanceEvidence, false);
    assert.equal(retained.wholeRunAccepted, false);
    assert.equal(state.receipt.status, 'failed');
    assert.equal(state.receipt.nativeProtectedExchangeAccepted, false);
    assert.equal(state.receipt.realOsLifecycleProved, false);
});

test('admitted failed or mismatched closure facts are captured before the full stage refuses', () => {
    for (const mutate of [
        (closure) => {
            closure.nativeCounters.currentAccount++;
        },
        (closure) => {
            closure.status = 'failed';
            closure.phase = 'lifecycle-failed';
            closure.domFacts = null;
        },
    ]) {
        const fixture = captureFixture(({ contents, files, pair }) => {
            mutate(pair.input.closure);
            contents.set(files.closure, Buffer.from(JSON.stringify(pair.input.closure) + '\n'));
        });
        assert.throws(() => fixture.stage('foreground-closed'), /synthetic full stage refused/);
        assert.deepEqual(fixture.events, ['admission', 'copy', 'copy', 'full-stage']);
        assert.equal(fixture.state.receipt.sceneClosureDiagnosticCaptureComplete, true);
        assert.ok(
            Object.values(fixture.state.receipt.sceneClosureDiagnostic.inspection.facts.groups).some(
                (value) => value === false,
            ),
        );
        assert.equal(fixture.state.receipt.sceneStages, undefined);
        assert.equal(fixture.state.receipt.status, 'failed');
    }
});

const alterMetadata =
    (path, metadata) =>
    ({ state }) => {
        const prior = state.lstatSync;
        state.lstatSync = (name) => (name === path ? metadata : prior(name));
    };
for (const [label, edit, boundary] of [
    [
        'missing independent launch PID',
        ({ state }) => {
            delete state.receipt.ownedLaunchPID;
        },
        'launch-and-sources',
    ],
    [
        'PID different from independent launch',
        ({ state }) => {
            state.receipt.ownedLaunchPID++;
        },
        'launch-and-sources',
    ],
    [
        'missing scene pins',
        ({ state }) => {
            state.scenePins = undefined;
        },
        'launch-and-sources',
    ],
    [
        'scene pin PID mismatch',
        ({ state }) => {
            state.scenePins.pid++;
        },
        'launch-and-sources',
    ],
    [
        'scene pin epoch mismatch',
        ({ state }) => {
            state.scenePins.epoch = '32345678-1234-4234-8234-123456789abc';
        },
        'launch-and-sources',
    ],
    [
        'observer directory epoch mismatch',
        ({ files }) => {
            files.epoch = '32345678-1234-4234-8234-123456789abc';
        },
        'launch-and-sources',
    ],
    [
        'missing protected baseline',
        ({ state }) => {
            state.sceneBaseline = undefined;
        },
        'launch-and-sources',
    ],
    [
        'changed scene resource',
        ({ hashes }) => hashes.set('/synthetic-private/scene-resource.json', 'f'.repeat(64)),
        'launch-and-sources',
    ],
    [
        'changed protected resource',
        ({ hashes }) => hashes.set('/synthetic-private/fixture-resource.json', 'f'.repeat(64)),
        'launch-and-sources',
    ],
    [
        'changed driver source',
        ({ hashes }) => hashes.set('/synthetic-checkout/driver.mjs', 'f'.repeat(64)),
        'launch-and-sources',
    ],
    [
        'nonprivate observer directory',
        alterMetadata('/synthetic-owned/scene', { uid: 501, mode: 0o40750 }),
        'launch-and-sources',
    ],
    [
        'nonprivate observer file',
        alterMetadata('/synthetic-owned/scene/scene-observer.json', { uid: 501, mode: 0o100640 }),
        'launch-and-sources',
    ],
    [
        'nonprivate closure file',
        alterMetadata('/synthetic-owned/scene/scene-ui-closure.json', { uid: 501, mode: 0o100640 }),
        'private-file',
    ],
    ['foreign scratch owner', alterMetadata('/synthetic-private', { uid: 502, mode: 0o40700 }), 'copy'],
    ['nonprivate scratch directory', alterMetadata('/synthetic-private', { uid: 501, mode: 0o40750 }), 'copy'],
    [
        'unparsed closure JSON',
        ({ contents, files }) => contents.set(files.closure, Buffer.from('{"secret":"synthetic-canary"')),
        'shape-and-bindings',
    ],
    [
        'arbitrary extra closure field',
        ({ contents, files, pair }) => {
            contents.set(
                files.closure,
                Buffer.from(JSON.stringify({ ...pair.input.closure, error: 'synthetic-canary' })),
            );
        },
        'shape-and-bindings',
    ],
])
    test('synthetic capture refuses ' + label + ' without retaining arbitrary JSON', () => {
        const fixture = captureFixture(edit);
        fixture.invoke();
        assert.equal(fixture.state.receipt.sceneClosureDiagnosticStatus, 'refused');
        assert.equal(fixture.state.receipt.sceneClosureDiagnosticRefusalBoundary, boundary);
        assert.equal(fixture.state.receipt.sceneClosureDiagnosticCaptureComplete, false);
        assert.equal(fixture.state.receipt.sceneClosureDiagnostic, undefined);
        assert.equal(fixture.writes.length, 0);
        assert.equal(fixture.state.receipt.nativeProtectedExchangeAccepted, false);
        assert.doesNotMatch(JSON.stringify(fixture.state.receipt), /synthetic-canary|secret|\.stack/);
    });

test('zero and oversized observer/closure bytes are refused before copies', () => {
    for (const [field, length] of [
        ['closure', 0],
        ['closure', 16385],
        ['observer', 0],
        ['observer', 65537],
    ]) {
        const fixture = captureFixture(({ contents, files }) => contents.set(files[field], Buffer.alloc(length, 32)));
        fixture.invoke();
        assert.equal(fixture.state.receipt.sceneClosureDiagnosticStatus, 'refused');
        assert.equal(fixture.state.receipt.sceneClosureDiagnosticCaptureComplete, false);
        assert.equal(fixture.writes.length, 0);
    }
});

test('capture attempts once even when a missing or refused input later becomes valid', () => {
    for (const absent of [true, false]) {
        let valid;
        const fixture = captureFixture(({ contents, files }) => {
            valid = contents.get(files.closure);
            if (absent) contents.delete(files.closure);
            else contents.set(files.closure, Buffer.from('invalid JSON'));
        });
        fixture.invoke();
        const initial = hostValue(fixture.state.receipt),
            saveCount = fixture.saves.length;
        fixture.contents.set(fixture.files.closure, valid);
        fixture.invoke();
        assert.equal(fixture.state.sceneClosureDiagnosticAttempted, true);
        assert.deepEqual(hostValue(fixture.state.receipt), initial);
        assert.equal(fixture.saves.length, saveCount);
        assert.equal(fixture.writes.length, 0);
    }
});

test('a repeated finally capture preserves the first admitted bytes and does no new I/O', () => {
    const fixture = captureFixture();
    fixture.invoke();
    const retained = hostValue(fixture.state.receipt.sceneClosureDiagnostic);
    fixture.state.sceneFiles = () => assert.fail('a second attempt must not discover files');
    fixture.invoke();
    assert.equal(fixture.writes.length, 2);
    assert.equal(fixture.saves.length, 1);
    assert.deepEqual(hostValue(fixture.state.receipt.sceneClosureDiagnostic), retained);
});

test('exclusive destination files cannot be overwritten and changed bytes cannot complete capture', () => {
    for (const destination of ['scene-closure-diagnostic.json', 'scene-closure-observer.json']) {
        const fixture = captureFixture(({ contents }) =>
            contents.set('/synthetic-private/' + destination, Buffer.from('existing')),
        );
        fixture.invoke();
        assert.equal(fixture.state.receipt.sceneClosureDiagnosticStatus, 'refused');
        assert.equal(fixture.state.receipt.sceneClosureDiagnosticCaptureComplete, false);
        assert.equal(fixture.contents.get('/synthetic-private/' + destination).toString(), 'existing');
        assert.equal(fixture.state.receipt.sceneClosureDiagnostic, undefined);
    }
    for (const field of ['closure', 'observer', 'copied-closure', 'copied-observer']) {
        const fixture = captureFixture(({ state, contents, files }) => {
            const write = state.writeFileSync;
            let copies = 0;
            state.writeFileSync = (...args) => {
                write(...args);
                if (++copies !== 2) return;
                const path = field.startsWith('copied-')
                    ? '/synthetic-private/scene-closure-' +
                      (field === 'copied-closure' ? 'diagnostic' : 'observer') +
                      '.json'
                    : files[field];
                contents.set(path, Buffer.concat([contents.get(path), Buffer.from(' ')]));
            };
        });
        fixture.invoke();
        assert.equal(fixture.state.receipt.sceneClosureDiagnosticStatus, 'refused');
        assert.equal(fixture.state.receipt.sceneClosureDiagnosticCaptureComplete, false);
        assert.equal(fixture.state.receipt.sceneClosureDiagnostic, undefined);
    }
});

test('ordinary mode performs no scene capture and nonforeground stage keeps its original gate', () => {
    const fixture = captureFixture(({ state }) => {
        state.sceneProof = false;
        state.sceneFiles = () => assert.fail('ordinary mode must not discover scene files');
    });
    fixture.invoke();
    assert.equal(fixture.state.sceneClosureDiagnosticAttempted, false);
    assert.equal(fixture.state.receipt.sceneClosureDiagnosticStatus, undefined);
    assert.equal(fixture.writes.length, 0);
    assert.equal(fixture.saves.length, 0);
    const sceneFixture = captureFixture();
    assert.throws(() => sceneFixture.stage('protected-ready'), /synthetic full stage refused/);
    assert.deepEqual(sceneFixture.events, ['full-stage']);
    assert.equal(sceneFixture.state.sceneClosureDiagnosticAttempted, false);
});

test('finally captures before cleanup and all old whole-run gates survive the added completeness gates', () => {
    const body = enclosed(driver, /\}\s*finally\b/).body,
        list = tokens(body);
    let after = position(list, 'captureSceneProgressStageDiagnostic();');
    after = position(list, 'captureSceneClosureDiagnostic();', after);
    after = position(list, "receipt.failedOperation = 'scene-closure-diagnostic-validate'", after);
    after = position(list, 'if (simulator)', after);
    after = position(list, "quiet('/usr/bin/xcrun', ['simctl', 'delete', simulator])", after);
    const pattern = /\bif\s*(?=\(\s*nativeObservationPassed\s*&&)/;
    const current = enclosed(body, pattern, '(', ')').body;
    const previous = enclosed(enclosed(oldDriver, /\}\s*finally\b/).body, pattern, '(', ')').body;
    const added = '&& (!sceneProof || sceneClosureDiagnosticCaptureComplete)';
    const timingAdded = '&& (!sceneProof || sceneAuthorityTimingDiagnosticCaptureComplete)';
    const currentTokens = tokens(current);
    for (const addition of [added, timingAdded]) {
        const start = position(currentTokens, addition);
        currentTokens.splice(start, tokens(addition).length);
    }
    assert.deepEqual(currentTokens, tokens(previous));
    const failure = enclosed(
        body,
        /\bif\s*(?=\(\s*sceneProof\s*&&\s*nativeObservationPassed\s*&&\s*firstInboxDiagnosticCaptureComplete\s*&&\s*sceneFinishDiagnosticCaptureComplete\s*&&\s*sceneProgressDiagnosticCaptureComplete\s*&&\s*!sceneClosureDiagnosticCaptureComplete)/,
    );
    const withoutClosureBlock = body.slice(0, failure.start) + body.slice(failure.end);
    const timingFailure = enclosed(
        withoutClosureBlock,
        /\bif\s*(?=\(\s*sceneProof\s*&&\s*nativeObservationPassed\s*&&\s*firstInboxDiagnosticCaptureComplete\s*&&\s*sceneFinishDiagnosticCaptureComplete\s*&&\s*sceneProgressDiagnosticCaptureComplete\s*&&\s*sceneClosureDiagnosticCaptureComplete\s*&&\s*!sceneAuthorityTimingDiagnosticCaptureComplete)/,
    );
    const withoutNewBlocks =
        withoutClosureBlock.slice(0, timingFailure.start) + withoutClosureBlock.slice(timingFailure.end);
    const preserved = tokens(withoutNewBlocks);
    for (const addition of [
        'captureSceneClosureDiagnostic();',
        'captureSceneAuthorityTimingDiagnostic();',
        added,
        timingAdded,
    ]) {
        const index = position(preserved, addition);
        preserved.splice(index, tokens(addition).length);
    }
    assert.deepEqual(
        preserved,
        tokens(enclosed(oldDriver, /\}\s*finally\b/).body),
        'all previous finally operations and refusal gates remain',
    );
    position(list, 'receipt.nativeProtectedExchangeAccepted = true', after);
    const accept = (facts) => runInNewContext('Boolean(' + current + ')', facts, { timeout: 1000 });
    const base = {
        nativeObservationPassed: true,
        sceneProof: true,
        firstInboxDiagnosticCaptureComplete: true,
        sceneFinishDiagnosticCaptureComplete: true,
        sceneProgressDiagnosticCaptureComplete: true,
        sceneClosureDiagnosticCaptureComplete: true,
        sceneAuthorityTimingDiagnosticCaptureComplete: true,
        receipt: { ownedSimulatorRemoved: true },
    };
    assert.equal(accept(base), true);
    for (const key of [
        'nativeObservationPassed',
        'firstInboxDiagnosticCaptureComplete',
        'sceneFinishDiagnosticCaptureComplete',
        'sceneProgressDiagnosticCaptureComplete',
        'sceneClosureDiagnosticCaptureComplete',
        'sceneAuthorityTimingDiagnosticCaptureComplete',
    ])
        assert.equal(accept({ ...base, [key]: false }), false, key + ' remains necessary');
    assert.equal(accept({ ...base, receipt: { ownedSimulatorRemoved: false } }), false);
    assert.equal(accept({ ...base, sceneProof: false, sceneClosureDiagnosticCaptureComplete: false }), true);
    assert.equal(accept({ ...base, nativeObservationPassed: false }), false, 'diagnostics alone cannot accept');
});
