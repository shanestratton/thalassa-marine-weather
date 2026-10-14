// Synthetic source-regression evidence only. No Swift execution, app launch,
// operating-system callback, native encryption or acceptance is exercised here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { dirname, join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { FULL_APP_PROTECTED_REPORT_KEYS } from './fullAppProtectedUiContract.mjs';
import { FIRST_INBOX_STAGE_NAMES, inspectFirstInboxStageEvidence } from './firstInboxStageContract.mjs';
import { inspectResearchSceneLifecycleEvidence } from './researchSceneLifecycleContract.mjs';

const read = (name) => readFileSync(new URL(name, import.meta.url), 'utf8');
const sceneFlag = 'E2EE_FULL_APP_SCENE_UI_FIXTURE';
const plugin = read('ScuttlebuttResearchAuthPlugin.swift');
const recorder = read('ResearchFirstInboxStageEvidence.swift');
const scene = read('ResearchFullAppSceneUiFixture.swift');
const fixture = read('ResearchFullAppProtectedUiFixture.swift');
const builder = read('build.mjs');
const ruby = read('generate_project.rb');
const driver = read('fullAppProtectedUiProof.mjs');

// Keep literals intact and discard comments/spacing. These checks are source
// contracts, not a Swift or JavaScript semantic parser.
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
    assert.ok(match, 'required source declaration absent: ' + pattern);
    const list = lex(source).filter((token) => token.index >= match.index + match[0].length);
    const start = list.findIndex((token) => token.text === opening);
    assert.ok(start >= 0, 'required source body absent');
    let depth = 0;
    for (let index = start; index < list.length; index++) {
        if (list[index].text === opening) depth++;
        if (list[index].text === closing && --depth === 0) return source.slice(list[start].end, list[index].index);
    }
    assert.fail('unterminated source body');
}
const swiftBody = (source, name) => enclosed(source, new RegExp('\\bfunc\\s+' + name + '\\s*\\('));
const jsBody = (source, name) => enclosed(source, new RegExp('\\bfunction\\s+' + name + '\\s*\\('));
function position(list, source, after = -1) {
    const wanted = tokens(source);
    for (let index = after + 1; index <= list.length - wanted.length; index++)
        if (wanted.every((value, offset) => list[index + offset] === value)) return index;
    assert.fail('required source operation absent or out of order: ' + source);
}
function condition(expression, flags, simulator) {
    const list = tokens(expression.replaceAll('targetEnvironment(simulator)', 'SIMULATOR'));
    let index = 0;
    function atom() {
        const token = list[index++];
        if (token === '!') return !atom();
        if (token === '(') {
            const value = or();
            assert.equal(list[index++], ')');
            return value;
        }
        assert.match(token, /^[A-Za-z_]\w*$/);
        return token === 'SIMULATOR' ? simulator : flags.has(token);
    }
    function and() {
        let value = atom();
        while (list[index] === '&&') {
            index++;
            const right = atom();
            value = value && right;
        }
        return value;
    }
    function or() {
        let value = and();
        while (list[index] === '||') {
            index++;
            const right = and();
            value = value || right;
        }
        return value;
    }
    const result = or();
    assert.equal(index, list.length);
    return result;
}
function swiftLane(source, names = [], simulator = false) {
    const flags = new Set(names),
        stack = [],
        kept = [];
    const active = () => stack.at(-1)?.active ?? true;
    for (const line of source.split('\n')) {
        const directive = /^\s*#(if|elseif|else|endif)\b(.*)$/.exec(line);
        if (!directive) {
            if (active()) kept.push(line);
            continue;
        }
        const [, kind, expression] = directive;
        if (kind === 'if') {
            const parent = active(),
                selected = condition(expression, flags, simulator);
            stack.push({ parent, taken: selected, active: parent && selected });
        } else {
            assert.ok(stack.length, 'unmatched compiler directive');
            const frame = stack.at(-1);
            if (kind === 'endif') stack.pop();
            else if (kind === 'else') {
                frame.active = frame.parent && !frame.taken;
                frame.taken = true;
            } else {
                const selected = condition(expression, flags, simulator);
                frame.active = frame.parent && !frame.taken && selected;
                frame.taken ||= selected;
            }
        }
    }
    assert.equal(stack.length, 0);
    return kept.join('\n');
}
function dictionaryKeys(source, declaration) {
    const match = declaration.exec(source);
    assert.ok(match, 'fixed dictionary declaration absent');
    const list = lex(source).filter((token) => token.index >= match.index + match[0].length);
    const start = list.findIndex((token) => token.text === '['),
        stack = [],
        keys = [];
    assert.ok(start >= 0);
    for (let index = start; index < list.length; index++) {
        const text = list[index].text;
        if (['[', '{', '('].includes(text)) stack.push(text);
        else if ([']', '}', ')'].includes(text)) {
            stack.pop();
            if (stack.length === 0) return keys;
        } else if (stack.length === 1 && /^"/.test(text) && list[index + 1]?.text === ':') keys.push(JSON.parse(text));
    }
    assert.fail('unterminated fixed dictionary');
}

const originalAsyncBody = `
    guard exactOptions(call, names.union(["lifecycleVersion"])),
          let version = call.getString("lifecycleVersion"), version.utf8.count == 36,
          let admitted = try? sceneAuthority.begin({ try privateMessageAdapter() }) else { call.resolve(Self.unavailable); return }
    Task {
        do {
            try self.sceneAuthority.withCurrent(admitted.0) { () }
            let result = try await operation(admitted.1, version)
            try self.sceneAuthority.withCurrent(admitted.0) {
                let published = try result.publish()
#if E2EE_FULL_APP_PROTECTED_UI_FIXTURE
                ResearchFullAppProtectedUiFixture.notePmResult(method: call.methodName, status: published["status"] as? String ?? "unavailable")
#elseif E2EE_PROTECTED_UI_FIXTURE
                ResearchLocalUiFixture.notePmResult(method: call.methodName, status: published["status"] as? String ?? "unavailable")
#endif
                call.resolve(published)
            }
        } catch {
#if E2EE_FULL_APP_PROTECTED_UI_FIXTURE
            ResearchFullAppProtectedUiFixture.notePmResult(method: call.methodName, status: "unavailable")
#elseif E2EE_PROTECTED_UI_FIXTURE
            ResearchLocalUiFixture.notePmResult(method: call.methodName, status: "unavailable")
#endif
            call.resolve(Self.unavailable)
        }
    }
`;
function inspectAsyncWiring(source) {
    const body = swiftBody(source, 'privateMessageAsync'),
        list = tokens(body);
    assert.equal(tokens(source).filter((token) => token === 'beginFirstInbox').length, 1);
    assert.equal(body.match(/\bfirstInboxSelected\b/g)?.length, 7);
    const hooks = [
        ...body.matchAll(/if\s+firstInboxSelected\s*\{\s*Self\.firstInboxStageEvidence\.note\(\.(\w+)\)\s*\}/g),
    ].map((match) => match[1]);
    assert.deepEqual(hooks, [
        'taskOriginalTicket',
        'adapterOperation',
        'publicationOriginalTicket',
        'resultPublication',
        'completed',
        'failed',
    ]);
    const required = [
        'let admitted = try? sceneAuthority.begin({ try privateMessageAdapter() }) else { call.resolve(Self.unavailable); return }',
        'let firstInboxSelected = call.methodName == "privateMessageInbox" && Self.firstInboxStageEvidence.beginFirstInbox()',
        'Task {',
        'do {',
        'if firstInboxSelected { Self.firstInboxStageEvidence.note(.taskOriginalTicket) }',
        'try self.sceneAuthority.withCurrent(admitted.0) { () }',
        'if firstInboxSelected { Self.firstInboxStageEvidence.note(.adapterOperation) }',
        'let result = try await operation(admitted.1, version)',
        'if firstInboxSelected { Self.firstInboxStageEvidence.note(.publicationOriginalTicket) }',
        'try self.sceneAuthority.withCurrent(admitted.0) {',
        'if firstInboxSelected { Self.firstInboxStageEvidence.note(.resultPublication) }',
        'let published = try result.publish()',
        'call.resolve(published)',
        'if firstInboxSelected { Self.firstInboxStageEvidence.note(.completed) }',
        '} catch {',
        'if firstInboxSelected { Self.firstInboxStageEvidence.note(.failed) }',
    ];
    let after = -1;
    for (const step of required) after = position(list, step, after);
    const catchStart = /}\s*catch\s*\{/.exec(body);
    assert.ok(catchStart);
    const failure = body.slice(catchStart.index);
    const failureTokens = tokens(swiftLane(failure, [sceneFlag, 'E2EE_FULL_APP_PROTECTED_UI_FIXTURE'], true));
    const failureHook = tokens('if firstInboxSelected { Self.firstInboxStageEvidence.note(.failed) }');
    assert.deepEqual(failureTokens.slice(3, 3 + failureHook.length), failureHook);
    assert.doesNotMatch(body, /firstInboxStageEvidence\.(?:snapshot|reset|clear)\s*\(/);
    return body;
}

test('synthetic source selects only the first admitted inbox and marks original-ticket/publication boundaries', () => {
    inspectAsyncWiring(plugin);
});
function selectionBeforeGuard(text) {
    const body = swiftBody(text, 'privateMessageAsync');
    const selection =
        /let\s+firstInboxSelected\s*=\s*call\.methodName\s*==\s*"privateMessageInbox"\s*&&\s*Self\.firstInboxStageEvidence\.beginFirstInbox\(\)/.exec(
            body,
        );
    assert.ok(selection);
    return text.replace(
        body,
        body.replace(selection[0], '').replace(/\bguard\s+exactOptions/, selection[0] + '\nguard exactOptions'),
    );
}
for (const [label, mutate] of [
    ['selection before the admission guard', selectionBeforeGuard],
    [
        'permission method selection',
        (text) =>
            text.replace(
                'call.methodName == "privateMessageInbox" && Self.firstInboxStageEvidence.beginFirstInbox()',
                'call.methodName == "privateMessagePermissions" && Self.firstInboxStageEvidence.beginFirstInbox()',
            ),
    ],
    [
        'unconditional stage note',
        (text) =>
            text.replace(
                'if firstInboxSelected { Self.firstInboxStageEvidence.note(.adapterOperation) }',
                'Self.firstInboxStageEvidence.note(.adapterOperation)',
            ),
    ],
    ['wrong marker order', (text) => text.replace('note(.adapterOperation)', 'note(.taskOriginalTicket)')],
    [
        'completion before resolve',
        (text) =>
            text.replace(
                /call\.resolve\(published\)(\s*#if E2EE_FULL_APP_SCENE_UI_FIXTURE && targetEnvironment\(simulator\)\s*)(if firstInboxSelected \{ Self\.firstInboxStageEvidence\.note\(\.completed\) \})/,
                '$2$1call.resolve(published)',
            ),
    ],
])
    test('synthetic source mutation refuses ' + label, () => {
        const changed = mutate(plugin);
        assert.notEqual(changed, plugin, 'mutation must reach its intended source');
        assert.throws(() => inspectAsyncWiring(changed));
    });

test('synthetic source keeps recorder/hooks absent from ordinary, protected-only and physical scene lanes', () => {
    for (const [flags, simulator] of [
        [[], false],
        [['E2EE_FULL_APP_PROTECTED_UI_FIXTURE'], true],
        [[sceneFlag], false],
    ]) {
        assert.doesNotMatch(swiftLane(plugin, flags, simulator), /firstInboxStageEvidence|firstInboxSelected/);
        assert.doesNotMatch(swiftLane(recorder, flags, simulator), /class ResearchFirstInboxStageEvidence/);
        assert.doesNotMatch(swiftLane(fixture, flags, simulator), /persistFirstInboxDiagnostic/);
        assert.doesNotMatch(swiftLane(scene, flags, simulator), /persistFirstInboxDiagnostic/);
    }
    const enabled = swiftLane(plugin, [sceneFlag], true);
    assert.match(enabled, /static\s+let\s+firstInboxStageEvidence\s*=\s*ResearchFirstInboxStageEvidence\(\)/);
    assert.equal(enabled.match(/ResearchFirstInboxStageEvidence\s*\(/g)?.length, 1);
    assert.doesNotMatch(recorder, /@MainActor/);
    assert.doesNotMatch(
        enabled,
        /@MainActor\s+(?:static\s+let\s+firstInboxStageEvidence|public\s+final\s+class\s+ScuttlebuttResearchAuthPlugin)/,
    );
});

test('synthetic source preserves exact original admission, operations, PM status counters and replies', () => {
    const body = swiftBody(plugin, 'privateMessageAsync');
    for (const flags of [[], ['E2EE_PROTECTED_UI_FIXTURE'], ['E2EE_FULL_APP_PROTECTED_UI_FIXTURE']])
        assert.deepEqual(tokens(swiftLane(body, flags, true)), tokens(swiftLane(originalAsyncBody, flags, true)));
    assert.deepEqual(
        tokens(swiftBody(plugin, 'privateMessageInbox')),
        tokens('privateMessageAsync(call, names: []) { try await $0.inbox(lifecycleVersion: $1) }'),
    );
});

test('synthetic source persists only the fixed six-key snapshot; no ID, message, error, status or authority is added', () => {
    assert.deepEqual(dictionaryKeys(recorder, /\bvar\s+json\s*:\s*\[String\s*:\s*Any\]\s*\{/), [
        'version',
        'kind',
        'selectedAttempts',
        'markers',
        'integrityRefused',
        'acceptanceEvidence',
    ]);
    const writer = swiftBody(scene, 'writeFirstInboxDiagnostic');
    assert.match(
        writer,
        /withJSONObject:\s*ScuttlebuttResearchAuthPlugin\.firstInboxStageEvidence\.snapshot\(\)\.json/,
    );
    assert.doesNotMatch(
        tokens(writer).join(' '),
        /\b(?:runID|nonce|resourceSHA256|processID|processEpoch|error|message|credential|status|ticket|accountId)\b/,
    );
    assert.doesNotMatch(
        tokens(recorder).join(' '),
        /FileManager|JSONSerialization|DispatchQueue|\bTask\b|Timer|\bURL\b|\.\s*authenticate\s*\(|\.\s*fenceSession\s*\(/,
    );
});

test('synthetic source makes diagnostic I/O optional at existing capture/report writes, never in the PM Task', () => {
    assert.deepEqual(
        tokens(swiftBody(scene, 'persistFirstInboxDiagnostic')),
        tokens('try? shared.writeFirstInboxDiagnostic()'),
    );
    assert.match(scene, /static\s+func\s+persistFirstInboxDiagnostic\(\)\s*\{/);
    const capture = tokens(swiftBody(scene, 'capture'));
    const observerWrite = position(capture, 'observerFile = try observer.persist(inNativeDocumentsRoot: documents)');
    position(capture, 'Self.persistFirstInboxDiagnostic()', observerWrite);
    const reportWrite = swiftBody(fixture, 'write');
    assert.match(reportWrite, /ResearchFullAppSceneUiFixture\.persistFirstInboxDiagnostic\(\)/);
    assert.equal(fixture.match(/persistFirstInboxDiagnostic\s*\(/g)?.length, 1);
    assert.equal(scene.match(/Self\.persistFirstInboxDiagnostic\s*\(/g)?.length, 1);
    assert.doesNotMatch(plugin, /persistFirstInboxDiagnostic|writeFirstInboxDiagnostic|scene-first-inbox-stage\.json/);
    assert.doesNotMatch(
        swiftBody(scene, 'writeFirstInboxDiagnostic'),
        /\.record\s*\(|\.capture\s*\(|\.fenceSession\s*\(|\.authenticate\s*\(/,
    );
});

test('synthetic source binds the fixed private file to the validated observer parent and bounds each write', () => {
    const writer = tokens(swiftBody(scene, 'writeFirstInboxDiagnostic'));
    let after = position(writer, 'try observer.persist(inNativeDocumentsRoot: documents).path == observerFile.path');
    after = position(writer, 'let slash = observerFile.path.lastIndex(of: "/")', after);
    after = position(writer, 'let directory = String(observerFile.path[..<slash])', after);
    after = position(writer, 'let file = URL(fileURLWithPath: directory + "/scene-first-inbox-stage.json")', after);
    after = position(writer, 'guard (1...4096).contains(bytes.count)', after);
    position(writer, 'try requireFirstInboxDiagnostic(file)', after);
    position(writer, 'try bytes.write(to: file, options: [.atomic, .completeFileProtection])', after);
    position(writer, 'try bytes.write(to: file, options: [.withoutOverwriting, .completeFileProtection])', after);
    position(
        writer,
        'try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)',
        after,
    );
    const validation = tokens(swiftBody(scene, 'requireFirstInboxDiagnostic'));
    assert.match(scene, /private func requireFirstInboxDiagnostic\(_ file: URL, maximumBytes: Int = 4096\)/);
    for (const check of [
        'realpath($0, nil)',
        'lstat($0, &metadata)',
        'UInt32(S_IFREG)',
        'metadata.st_uid == getuid()',
        '(UInt32(metadata.st_mode) & 0o7777) == 0o600',
        '(1...maximumBytes).contains(Int(metadata.st_size))',
    ])
        position(validation, check);
});

test('synthetic source retains the exact twenty-key protected report and separate scene source inventories', () => {
    const keys = dictionaryKeys(swiftBody(fixture, 'write'), /\blet\s+body\s*:\s*\[String\s*:\s*Any\]\s*=/);
    assert.equal(keys.length, 20);
    assert.deepEqual(keys, FULL_APP_PROTECTED_REPORT_KEYS);
    const inventory = ruby
        .match(/scene_sources\s*=\s*%w\[([\s\S]*?)\]\.sort/)?.[1]
        .trim()
        .split(/\s+/)
        .sort();
    assert.equal(inventory?.length, 30);
    assert.equal(new Set(inventory).size, 30);
    assert.equal(inventory.filter((name) => name !== 'ResearchSceneAuthorityTimingEvidence.swift').length, 29);
    assert.equal(inventory.filter((name) => name === 'ResearchSceneAuthorityTimingEvidence.swift').length, 1);
    assert.ok(inventory.includes('ResearchFirstInboxStageEvidence.swift'));
    assert.match(
        ruby,
        /manifest\['sceneUiFixture'\]\s*\?\s*sources\.sort\s*==\s*scene_sources\s*:\s*sources\.length\.between\?\(3,\s*24\)/,
    );
    const filenames = (text) =>
        tokens(text)
            .filter((token) => /^'[A-Za-z0-9_-]+\.swift'$/.test(token))
            .map((token) => token.slice(1, -1));
    const base = filenames(enclosed(builder, /\bconst\s+sourcePaths\s*=/, '[', ']'));
    const protectedFiles = filenames(enclosed(builder, /if\s*\(fullAppProtectedUi\)\s*sourcePaths\.push/, '(', ')'));
    const sceneFiles = filenames(enclosed(builder, /if\s*\(sceneResource\)\s*sourcePaths\.push/, '(', ')'));
    const ordinary = [...base, 'ResearchLocalUiFixture.swift', ...protectedFiles];
    assert.equal(ordinary.length, 24);
    assert.equal(new Set(ordinary).size, 24);
    assert.ok(!ordinary.includes('ResearchFirstInboxStageEvidence.swift'));
    assert.deepEqual([...ordinary, ...sceneFiles].sort(), inventory);
    assert.match(builder, /receipt\.sourceHashes\[source\]\s*=\s*hash\(source\)/);
    assert.match(builder, /assert\(hash\(output\)\s*===\s*receipt\.sourceHashes\[source\]\)/);
});

test('synthetic source pins the recorder/parser plus driver itself without widening the original scene bindings', () => {
    const ordinary = enclosed(driver, /\bconst\s+names\s*=\s*(?=\[)/, '[', ']');
    const added = enclosed(driver, /if\s*\(sceneProof\)\s*names\.push/, '(', ')');
    assert.match(ordinary, /'bridge-native\/fullAppProtectedUiProof\.mjs'/);
    assert.doesNotMatch(ordinary, /ResearchFirstInboxStageEvidence|firstInboxStageContract/);
    assert.match(added, /'bridge-native\/ResearchFirstInboxStageEvidence\.swift'/);
    assert.match(added, /'bridge-native\/firstInboxStageContract\.mjs'/);
    assert.match(
        driver,
        /receipt\.sourceHashes\s*=\s*Object\.fromEntries\(\s*names\.map\(\(n\)\s*=>\s*\['experiments\/scuttlebutt-e2ee\/'\s*\+\s*n,\s*hash\(join\(here,\s*'\.\.',\s*n\)\)\]\)/,
    );
    assert.doesNotMatch(
        jsBody(driver, 'sceneSourceBindings'),
        /ResearchFirstInboxStageEvidence|firstInboxStageContract/,
    );
    const files = jsBody(driver, 'sceneFiles');
    assert.match(files, /firstInboxDiagnostic:\s*join\(directory,\s*'scene-first-inbox-stage\.json'\)/);
});

test('synthetic source captures admitted diagnostic/hash/binding on both failed and successful runs before owned cleanup', () => {
    const capture = tokens(jsBody(driver, 'captureFirstInboxStageDiagnostic'));
    let after = position(capture, 'if (!sceneProof) return');
    after = position(capture, 'firstInboxDiagnosticCaptureComplete = false', after);
    after = position(capture, "receipt.firstInboxStageDiagnosticStatus = 'no-file'", after);
    after = position(
        capture,
        'assert(Number.isSafeInteger(receipt.ownedLaunchPID) && receipt.ownedLaunchPID > 0)',
        after,
    );
    after = position(
        capture,
        "const observer = inspectSceneObservation(JSON.parse(observerBytes.toString('utf8')))",
        after,
    );
    after = position(capture, 'assert(observer.process.pid === receipt.ownedLaunchPID)', after);
    after = position(capture, 'assert(observer.process.epoch === files.epoch)', after);
    after = position(capture, 'assert(hash(sceneFixtureFile) === receipt.sceneFixtureResource.sha256)', after);
    after = position(capture, 'assert(hash(protectedFixtureFile) === receipt.fixtureResource.sha256)', after);
    after = position(capture, 'assert(hash(regular(join(checkout, name))) === expected)', after);
    after = position(capture, 'const source = regular(files.firstInboxDiagnostic, 4096)', after);
    after = position(capture, 'const inspection = inspectFirstInboxStageEvidence(diagnostic)', after);
    after = position(capture, "writeFileSync(path, diagnosticBytes, { mode: 0o600, flag: 'wx' })", after);
    after = position(capture, "writeFileSync(observerPath, observerBytes, { mode: 0o600, flag: 'wx' })", after);
    after = position(capture, 'sha256: hash(path)', after);
    after = position(capture, 'acceptanceEvidence: false', after);
    after = position(capture, 'wholeRunAccepted: false', after);
    position(
        capture,
        "firstInboxDiagnosticCaptureComplete = inspection.status === 'completed' && inspection.selectedAttempts === 1",
        after,
    );
    assert.doesNotMatch(
        jsBody(driver, 'captureFirstInboxStageDiagnostic'),
        /nativeObservationPassed|nativeProtectedExchangeAccepted\s*=|realOsLifecycleProved\s*=|\.message\b|\.stack\b/,
    );
    const final = tokens(enclosed(driver, /\bfinally\s*/));
    const extraction = position(final, 'captureFirstInboxStageDiagnostic()');
    position(final, 'if (simulator)', extraction);
    position(final, "quiet('/usr/bin/xcrun', ['simctl', 'delete', simulator])", extraction);
    position(
        final,
        'nativeObservationPassed && (!sceneProof || firstInboxDiagnosticCaptureComplete) && (!sceneProof || sceneFinishDiagnosticCaptureComplete) && (!sceneProof || sceneProgressDiagnosticCaptureComplete) && (!sceneProof || sceneClosureDiagnosticCaptureComplete) && (!sceneProof || sceneAuthorityTimingDiagnosticCaptureComplete) && receipt.ownedSimulatorRemoved === true',
        extraction,
    );
    position(final, 'save()', extraction);
});

// Execute only the extracted driver helper over an in-memory filesystem. The
// actual parsers are used, but launch, PID measurement, ownership and I/O here
// are synthetic. This establishes helper behavior, never native provenance.
function syntheticDiagnostic(prefix = 5, failed = 0, selected = 1) {
    return {
        version: 1,
        kind: 'first-inbox-stage-diagnostic',
        selectedAttempts: selected,
        markers: Object.fromEntries(
            FIRST_INBOX_STAGE_NAMES.map((name, index) => [name, name === 'failed' ? failed : index < prefix ? 1 : 0]),
        ),
        integrityRefused: false,
        acceptanceEvidence: false,
    };
}
function captureFixture(diagnostic = syntheticDiagnostic(), edit = () => {}) {
    const runID = '12345678-1234-4234-8234-123456789abc',
        nonce = 'a'.repeat(64),
        epoch = '22345678-1234-4234-8234-123456789abc';
    const files = {
        observer: '/synthetic-owned/scene/scene-observer.json',
        firstInboxDiagnostic: '/synthetic-owned/scene/scene-first-inbox-stage.json',
        epoch,
    };
    const hashes = new Map([
        ['/synthetic-private/scene-resource.json', 'b'.repeat(64)],
        ['/synthetic-private/fixture-resource.json', 'c'.repeat(64)],
        ['/synthetic-checkout/driver.mjs', 'd'.repeat(64)],
    ]);
    const absent = Object.fromEntries(
        [
            'present',
            'opaque',
            'attachedToOwnedWindow',
            'coversOwnedWindowBounds',
            'accessibilityModal',
            'contentAccessibilityHidden',
        ].map((key) => [key, false]),
    );
    const observer = {
        version: 1,
        kind: 'research-scene-lifecycle-observations',
        runID,
        nonce,
        resourceSHA256: 'b'.repeat(64),
        process: { pid: 42, epoch },
        evidenceCategory: 'simulator-native-observations',
        status: 'recording',
        eventCount: 1,
        events: [
            {
                index: 0,
                sequence: 1,
                event: 'process-started',
                activationState: 'unattached',
                cover: absent,
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
        [files.observer, JSON.stringify(observer)],
        [files.firstInboxDiagnostic, JSON.stringify(diagnostic)],
    ]);
    const writes = [],
        saves = [];
    const state = {
        assert,
        createHash,
        dirname,
        join,
        runID,
        nonce,
        sceneProof: true,
        scenePins: undefined,
        checkout: '/synthetic-checkout',
        scratch: '/synthetic-private',
        sceneFixtureFile: '/synthetic-private/scene-resource.json',
        protectedFixtureFile: '/synthetic-private/fixture-resource.json',
        firstInboxDiagnosticCaptureComplete: false,
        receipt: {
            status: 'failed',
            ownedLaunchPID: 42,
            nativeProtectedExchangeAccepted: false,
            sourceHashes: { 'driver.mjs': 'd'.repeat(64) },
            sceneFixtureResource: { sha256: 'b'.repeat(64) },
            fixtureResource: { sha256: 'c'.repeat(64) },
        },
        process: { getuid: () => 501 },
        sceneFiles: () => files,
        existsSync: (path) => contents.has(path),
        regular: (path) => {
            assert.ok(contents.has(path) || hashes.has(path));
            return path;
        },
        lstatSync: (path) => ({ uid: 501, mode: path === dirname(files.observer) ? 0o40700 : 0o100600 }),
        readFileSync: (path, encoding) => {
            assert.ok(contents.has(path));
            return encoding ? contents.get(path) : Buffer.from(contents.get(path));
        },
        hash: (path) => hashes.get(path) ?? createHash('sha256').update(contents.get(path)).digest('hex'),
        writeFileSync: (path, bytes, options) => {
            assert.ok(!contents.has(path));
            assert.deepEqual({ ...options }, { mode: 0o600, flag: 'wx' });
            contents.set(path, Buffer.isBuffer(bytes) ? bytes.toString('utf8') : bytes);
            writes.push(path);
        },
        inspectFirstInboxStageEvidence,
        inspectResearchSceneLifecycleEvidence,
        save: () => saves.push(true),
    };
    edit({ state, contents, files, hashes });
    runInNewContext(
        `function inspectSceneObservation(raw, diagnostic = false) { ${jsBody(driver, 'inspectSceneObservation')} }\n(function capture() { ${jsBody(driver, 'captureFirstInboxStageDiagnostic')} })();`,
        state,
        { timeout: 1000 },
    );
    return { state, contents, writes, saves };
}

test('synthetic extracted driver preserves failure/pending/unselected/completed diagnostics without accepting the failed run', () => {
    for (const [input, expected, completed] of [
        [syntheticDiagnostic(5), 'completed', true],
        ...[1, 2, 3, 4].map((prefix) => [syntheticDiagnostic(prefix, 1), 'failed', false]),
        [syntheticDiagnostic(2), 'pending', false],
        [syntheticDiagnostic(0, 0, 0), 'unselected', false],
    ]) {
        const { state, writes, saves, contents } = captureFixture(input);
        assert.equal(state.receipt.firstInboxStageDiagnosticStatus, 'observed-unaccepted');
        assert.equal(state.receipt.firstInboxDiagnosticCaptureComplete, completed);
        assert.equal(state.receipt.firstInboxStageDiagnostic.inspection.status, expected);
        assert.equal(state.receipt.firstInboxStageDiagnostic.binding.pid, 42);
        assert.equal(state.receipt.firstInboxStageDiagnostic.acceptanceEvidence, false);
        assert.equal(state.receipt.firstInboxStageDiagnostic.wholeRunAccepted, false);
        assert.equal(state.receipt.status, 'failed');
        assert.equal(state.receipt.nativeProtectedExchangeAccepted, false);
        assert.equal(writes.length, 2);
        assert.equal(saves.length, 1);
        assert.deepEqual(JSON.parse(contents.get(writes[0])), input);
        assert.equal(contents.get(writes[0]), JSON.stringify(input));
        assert.equal(
            state.receipt.firstInboxStageDiagnostic.sha256,
            state.receipt.firstInboxStageDiagnostic.sourceSHA256,
        );
        assert.equal(
            state.receipt.firstInboxStageDiagnostic.binding.observerReceipt.sha256,
            state.receipt.firstInboxStageDiagnostic.binding.observerReceipt.sourceSHA256,
        );
    }
});

for (const [label, edit, expected] of [
    ['missing file', ({ contents, files }) => contents.delete(files.firstInboxDiagnostic), 'no-file'],
    [
        'secret extra field',
        ({ contents, files }) =>
            contents.set(
                files.firstInboxDiagnostic,
                JSON.stringify({ ...syntheticDiagnostic(), message: 'synthetic-private-canary' }),
            ),
        'refused',
    ],
    ['unmeasured launch PID', ({ state }) => delete state.receipt.ownedLaunchPID, 'refused'],
    ['observer PID mismatch', ({ state }) => (state.receipt.ownedLaunchPID = 43), 'refused'],
    [
        'changed resource',
        ({ hashes }) => hashes.set('/synthetic-private/scene-resource.json', 'e'.repeat(64)),
        'refused',
    ],
    ['changed source', ({ hashes }) => hashes.set('/synthetic-checkout/driver.mjs', 'e'.repeat(64)), 'refused'],
    ['nonprivate file mode', ({ state }) => (state.lstatSync = () => ({ uid: 501, mode: 0o100644 })), 'refused'],
])
    test('synthetic extracted driver refuses ' + label + ' before any diagnostic copy', () => {
        const { state, writes } = captureFixture(syntheticDiagnostic(), edit);
        assert.equal(state.receipt.firstInboxStageDiagnosticStatus, expected);
        assert.equal(state.receipt.firstInboxDiagnosticCaptureComplete, false);
        assert.equal(state.receipt.firstInboxStageDiagnostic, undefined);
        assert.equal(state.receipt.nativeProtectedExchangeAccepted, false);
        assert.equal(writes.length, 0);
    });

test('synthetic extracted driver ordinary mode never reads or writes the scene diagnostic', () => {
    const { state, writes, saves } = captureFixture(syntheticDiagnostic(), ({ state }) => {
        state.sceneProof = false;
        state.sceneFiles = () => assert.fail('ordinary mode must not read scene files');
    });
    assert.equal(state.receipt.firstInboxStageDiagnosticStatus, undefined);
    assert.equal(writes.length, 0);
    assert.equal(saves.length, 0);
});

test('synthetic source retains latest failed scene report separately before cleanup without changing prefix or acceptance', () => {
    const capture = jsBody(driver, 'captureLatestSceneNativeDiagnostic');
    let after = position(tokens(capture), 'if (!sceneProof) return');
    after = position(tokens(capture), 'const source = regular(statusFile, 65536)', after);
    after = position(
        tokens(capture),
        "inspectFullAppSceneProtectedEnvelope(JSON.parse(bytes.toString('utf8')), runID, nonce)",
        after,
    );
    after = position(tokens(capture), "writeFileSync(path, bytes, { mode: 0o600, flag: 'wx' })", after);
    position(tokens(capture), 'assert(hash(source) === sourceSHA256 && hash(path) === sourceSHA256)', after);
    assert.doesNotMatch(
        capture,
        /nativeObservationPassed|nativeProtectedExchangeAccepted|scenePins\s*=|nativeReceipt\s*=/,
    );
    assert.match(capture, /acceptanceEvidence:\s*false,\s*wholeRunAccepted:\s*false/);
    const final = tokens(enclosed(driver, /\bfinally\s*/));
    const extraction = position(final, 'captureLatestSceneNativeDiagnostic()');
    position(final, 'captureFirstInboxStageDiagnostic()', extraction);
    position(final, "quiet('/usr/bin/xcrun', ['simctl', 'delete', simulator])", extraction);
});
