// Synthetic source/JavaScript regressions only. No Swift, native crypto, app,
// OS lifecycle transition, permission change or native acceptance is executed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { FULL_APP_PROTECTED_REPORT_KEYS } from './fullAppProtectedUiContract.mjs';
import { inspectResearchSceneLifecycleEvidence } from './researchSceneLifecycleContract.mjs';
import {
    SCENE_PROGRESS_MAXIMUM_ENTRIES,
    SCENE_PROGRESS_JAVASCRIPT_PHASE_NAMES,
    inspectSceneProgressStageEvidence,
} from './sceneProgressStageContract.mjs';

const read = (name) => readFileSync(new URL(name, import.meta.url), 'utf8');
const repository = fileURLToPath(new URL('../../..', import.meta.url));
const frozenBase = 'eff913833b454c58edaf155d356d2105f8aac94e';
const original = (name) =>
    execFileSync('/usr/bin/git', ['show', frozenBase + ':experiments/scuttlebutt-e2ee/' + name], {
        cwd: repository,
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
    });
const javascript = read('../full-app-pilot/nativeProtectedUiFixture.js');
const scene = read('ResearchFullAppSceneUiFixture.swift');
const protectedFixture = read('ResearchFullAppProtectedUiFixture.swift');
const recorder = read('ResearchSceneProgressStageEvidence.swift');
const driver = read('fullAppProtectedUiProof.mjs');
const builder = read('build.mjs');
const ruby = read('generate_project.rb');
const oldJavascript = original('full-app-pilot/nativeProtectedUiFixture.js');
const oldScene = original('bridge-native/ResearchFullAppSceneUiFixture.swift');
const oldDriver = original('bridge-native/fullAppProtectedUiProof.mjs');
const sceneFlag = 'E2EE_FULL_APP_SCENE_UI_FIXTURE';
const eventKeys = [
    'version',
    'kind',
    'runID',
    'nonce',
    'sequence',
    'phase',
    'sendPresent',
    'sendEnabled',
    'composePresent',
    'composeEmpty',
    'composeDisabled',
    'composeReadOnly',
];
const domKeys = eventKeys.slice(6);
const hostValue = (value) => JSON.parse(JSON.stringify(value));

// This lexer preserves literals and ignores comments/spacing. Source contracts
// below are not a Swift or JavaScript compiler or proof of native execution.
function lex(source) {
    return [
        ...source.matchAll(
            /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\/[^\n]*|\/\*[\s\S]*?\*\/|[A-Za-z_$][\w$]*|\d+|===|!==|==|!=|&&|\|\||\?\?|\.\.\.|->|=>|[^\s]/g,
        ),
    ]
        .filter((match) => !match[0].startsWith('//') && !match[0].startsWith('/*'))
        .map((match) => ({ text: match[0], index: match.index, end: match.index + match[0].length }));
}
const tokens = (source, swift = false) =>
    lex(source)
        .map((token) => token.text)
        .filter((token) => !swift || token !== ';');
function enclosed(source, pattern, opening = '{', closing = '}') {
    const match = pattern.exec(source);
    assert.ok(match, 'required declaration absent: ' + pattern);
    const list = lex(source).filter((token) => token.index >= match.index + match[0].length);
    const start = list.findIndex((token) => token.text === opening);
    assert.ok(start >= 0, 'required body absent');
    let depth = 0;
    for (let index = start; index < list.length; index++) {
        if (list[index].text === opening) depth++;
        if (list[index].text === closing && --depth === 0) return source.slice(list[start].end, list[index].index);
    }
    assert.fail('unterminated source body');
}
const jsBody = (source, name) => enclosed(source, new RegExp('\\bfunction\\s+' + name + '\\s*\\('));
const swiftBody = (source, name) => enclosed(source, new RegExp('\\bfunc\\s+' + name + '\\s*\\('));
function position(list, source, after = -1) {
    const wanted = tokens(source);
    for (let index = after + 1; index <= list.length - wanted.length; index++)
        if (wanted.every((value, offset) => list[index + offset] === value)) return index;
    assert.fail('required operation absent or out of order: ' + source);
}
function stringArray(source, pattern) {
    const list = tokens(enclosed(source, pattern, '[', ']'));
    assert.ok(list.every((value) => value === ',' || value.startsWith('"') || value.startsWith("'")));
    return JSON.parse(
        '[' +
            list
                .map((value) => (value.startsWith("'") ? JSON.stringify(value.slice(1, -1)) : value))
                .join('')
                .replace(/,$/, '') +
            ']',
    );
}
function dictionaryKeys(source, pattern) {
    const match = pattern.exec(source);
    assert.ok(match);
    const list = lex(source).filter((token) => token.index >= match.index + match[0].length);
    const start = list.findIndex((token) => token.text === '['),
        stack = [],
        keys = [];
    assert.ok(start >= 0);
    for (let index = start; index < list.length; index++) {
        const value = list[index].text;
        if (['[', '{', '('].includes(value)) stack.push(value);
        else if ([']', '}', ')'].includes(value)) {
            stack.pop();
            if (!stack.length) return keys;
        } else if (stack.length === 1 && value.startsWith('"') && list[index + 1]?.text === ':')
            keys.push(JSON.parse(value));
    }
    assert.fail('unterminated dictionary');
}
function compilerCondition(expression, flags, simulator) {
    const list = tokens(expression.replaceAll('targetEnvironment(simulator)', 'SIMULATOR'));
    let index = 0;
    function atom() {
        const value = list[index++];
        if (value === '!') return !atom();
        if (value === '(') {
            const nested = or();
            assert.equal(list[index++], ')');
            return nested;
        }
        assert.match(value, /^[A-Za-z_]\w*$/);
        return value === 'SIMULATOR' ? simulator : flags.has(value);
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
    const value = or();
    assert.equal(index, list.length);
    return value;
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
                selected = compilerCondition(expression, flags, simulator);
            stack.push({ parent, taken: selected, active: parent && selected });
        } else {
            assert.ok(stack.length);
            const frame = stack.at(-1);
            if (kind === 'endif') stack.pop();
            else if (kind === 'else') {
                frame.active = frame.parent && !frame.taken;
                frame.taken = true;
            } else {
                const selected = compilerCondition(expression, flags, simulator);
                frame.active = frame.parent && !frame.taken && selected;
                frame.taken ||= selected;
            }
        }
    }
    assert.equal(stack.length, 0);
    return kept.join('\n');
}

test('progress uses the same exact fixed 23 JavaScript phase names and a 64 entry bound', () => {
    const phases = stringArray(javascript, /\bconst\s+failurePhases\s*=/);
    assert.equal(phases.length, 23);
    assert.equal(new Set(phases).size, 23);
    assert.deepEqual(phases, SCENE_PROGRESS_JAVASCRIPT_PHASE_NAMES);
    assert.equal(SCENE_PROGRESS_MAXIMUM_ENTRIES, 64);
    assert.match(javascript, /const failurePhases\s*=\s*Object\.freeze\(/);
    assert.match(recorder, /static let maximumEntries\s*=\s*64/);
});

function observationFixture(edit = () => {}) {
    const published = [],
        reads = [],
        send = { disabled: false };
    const compose = { value: 'synthetic-private-canary', disabled: false, readOnly: false };
    const state = {
        sceneLifecycleProof: true,
        failurePhases: SCENE_PROGRESS_JAVASCRIPT_PHASE_NAMES,
        lastFailurePhase: 'send-enabled',
        progressSequence: 0,
        lastProgressFacts: null,
        runID: 'synthetic-run',
        nonce: 'synthetic-nonce',
        enabled: (element) => !element.disabled,
        document: {
            querySelector: (selector) => {
                reads.push(selector);
                return selector.startsWith('button') ? send : compose;
            },
        },
        window: {
            webkit: {
                messageHandlers: {
                    researchFullAppSceneUiFixture: {
                        postMessage: (value) => published.push(hostValue(value)),
                    },
                },
            },
        },
    };
    edit({ state, send, compose, reads, published });
    const invoke = () =>
        runInNewContext(
            '(function observeProgressStage() {' + jsBody(javascript, 'observeProgressStage') + '})()',
            state,
            { timeout: 1000 },
        );
    return { state, send, compose, reads, published, invoke };
}

test('synthetic publication has exactly 12 bound keys and only nullable Boolean DOM facts', () => {
    const fixture = observationFixture();
    fixture.invoke();
    assert.deepEqual(Object.keys(fixture.published[0]), eventKeys);
    assert.deepEqual(fixture.published[0], {
        version: 1,
        kind: 'scene-progress-javascript-diagnostic',
        runID: 'synthetic-run',
        nonce: 'synthetic-nonce',
        sequence: 1,
        phase: 'send-enabled',
        sendPresent: true,
        sendEnabled: true,
        composePresent: true,
        composeEmpty: false,
        composeDisabled: false,
        composeReadOnly: false,
    });
    assert.equal(fixture.state.progressSequence, 1);
    for (const name of domKeys) assert.equal(typeof fixture.published[0][name], 'boolean');
    const absent = observationFixture(({ state }) => {
        state.document.querySelector = () => null;
    });
    absent.invoke();
    assert.deepEqual(
        domKeys.map((key) => absent.published[0][key]),
        [false, null, false, null, null, null],
    );
});

test('dedup signatures keep only fixed phase and DOM facts and never input text or its length', () => {
    const fixture = observationFixture();
    fixture.invoke();
    fixture.invoke();
    fixture.compose.value = 'a different private value with a different length';
    fixture.invoke();
    assert.equal(fixture.published.length, 1);
    assert.deepEqual(Object.keys(JSON.parse(fixture.state.lastProgressFacts)), ['phase', ...domKeys]);
    assert.doesNotMatch(fixture.state.lastProgressFacts, /synthetic-private-canary|different private|length|value/);
    fixture.compose.value = '';
    fixture.invoke();
    assert.equal(fixture.published.length, 2);
    assert.equal(fixture.published[1].composeEmpty, true);
    fixture.state.lastFailurePhase = 'send-accepted';
    fixture.invoke();
    assert.equal(fixture.published.length, 3);
    assert.equal(fixture.published[2].phase, 'send-accepted');
    assert.deepEqual(
        fixture.published.map((entry) => entry.sequence),
        [1, 2, 3],
    );
    const body = jsBody(javascript, 'observeProgressStage');
    assert.match(body, /compose\.value\s*===\s*''/);
    assert.doesNotMatch(
        tokens(body).join(' '),
        /\b(?:length|textContent|innerText|innerHTML|outerHTML|data|messageFacts|outgoing|incoming|password|bearer|email)\b/,
    );
});

for (const [label, edit] of [
    [
        'ordinary protected mode',
        ({ state }) => {
            state.sceneLifecycleProof = false;
        },
    ],
    [
        'unknown phase',
        ({ state }) => {
            state.lastFailurePhase = 'unknown-secret-phase';
        },
    ],
    [
        'missing phase',
        ({ state }) => {
            state.lastFailurePhase = null;
        },
    ],
    [
        'exhausted bound',
        ({ state }) => {
            state.progressSequence = 64;
        },
    ],
])
    test('synthetic ' + label + ' returns before DOM reads or handler lookup', () => {
        const fixture = observationFixture((values) => {
            edit(values);
            Object.defineProperty(values.state, 'document', { get: () => assert.fail('unexpected DOM access') });
            Object.defineProperty(values.state, 'window', { get: () => assert.fail('unexpected handler lookup') });
        });
        assert.doesNotThrow(fixture.invoke);
        assert.equal(fixture.published.length, 0);
        assert.equal(fixture.state.lastProgressFacts, null);
    });

test('synthetic changed Boolean facts stop at exactly 64 posts before further DOM work', () => {
    const fixture = observationFixture();
    for (let index = 0; index < 65; index++) {
        fixture.send.disabled = index % 2 === 1;
        fixture.invoke();
    }
    assert.equal(fixture.published.length, 64);
    assert.equal(fixture.reads.length, 128);
    assert.deepEqual(
        fixture.published.map((entry) => entry.sequence),
        Array.from({ length: 64 }, (_, i) => i + 1),
    );
});

for (const [label, edit] of [
    [
        'missing handler',
        ({ state }) => {
            state.window = {};
        },
    ],
    [
        'throwing DOM getter',
        ({ state }) => {
            state.document.querySelector = () => {
                throw Error('DOM unavailable');
            };
        },
    ],
    [
        'throwing optional post',
        ({ state }) => {
            state.window.webkit.messageHandlers.researchFullAppSceneUiFixture.postMessage = () => {
                throw Error('post unavailable');
            };
        },
    ],
])
    test('synthetic ' + label + ' cannot throw or consume a sequence/signature', () => {
        const fixture = observationFixture(edit);
        assert.doesNotThrow(fixture.invoke);
        assert.equal(fixture.state.progressSequence, 0);
        assert.equal(fixture.state.lastProgressFacts, null);
        assert.equal(fixture.published.length, 0);
    });

test('removing only the exact progress calls preserves prior wait, refusal and phase-entry tokens', () => {
    const wait = jsBody(javascript, 'wait');
    assert.equal(wait.match(/\bobserveProgressStage\(\);/g)?.length, 1);
    assert.deepEqual(tokens(wait.replace(/\bobserveProgressStage\(\);/, '')), tokens(jsBody(oldJavascript, 'wait')));
    assert.match(wait, /Math\.min\(until,\s*Date\.now\(\)\s*\+\s*20000\)/);
    assert.match(wait, /setTimeout\(resolve,\s*25\)/);
    assert.match(javascript, /const until\s*=\s*Date\.now\(\)\s*\+\s*180000\s*;/);
    const entry = jsBody(javascript, 'enterFailurePhase');
    assert.deepEqual(
        tokens(entry.replace(/\bobserveProgressStage\(\);/, '').replace(/[{}]/g, '')),
        tokens(jsBody(oldJavascript, 'enterFailurePhase')),
    );
    assert.equal(javascript.match(/\bobserveProgressStage\(\);/g)?.length, 2);
    assert.deepEqual(tokens(jsBody(javascript, 'post')), tokens(jsBody(oldJavascript, 'post')));
    for (const name of ['refreshMessages', 'postFailureDiagnostic'])
        assert.deepEqual(tokens(jsBody(javascript, name)), tokens(jsBody(oldJavascript, name)));
});

test('progress instrumentation creates no timer, observer, DOM mutation or authority operation', () => {
    const body = jsBody(javascript, 'observeProgressStage');
    const identifiers = new Set(tokens(body).filter((value) => /^[A-Za-z_]\w*$/.test(value)));
    for (const name of [
        'setTimeout',
        'setInterval',
        'requestAnimationFrame',
        'MutationObserver',
        'addEventListener',
        'dispatchEvent',
        'click',
        'focus',
        'setAttribute',
        'removeAttribute',
        'appendChild',
        'remove',
        'authenticate',
        'fenceSession',
        'currentAccount',
        'messageSnapshot',
        'executeMessageOperation',
        'Capacitor',
        'fetch',
        'Task',
        'Timer',
        'refuse',
        'require',
        'post',
        'safeEvidence',
        'domFacts',
    ])
        assert.equal(identifiers.has(name), false, 'unexpected progress operation: ' + name);
    assert.match(body, /catch\s*\{/);
    const recordBody = swiftBody(recorder, 'record');
    assert.doesNotMatch(
        recordBody,
        /\b(?:Task|Timer|FileManager|URL|Data|Error|Report|VodozemacSessionFacade|fenceSession|authenticate)\b/,
    );
    const stored = enclosed(recorder, /struct\s+Entry\b/);
    for (const declaration of ['let sequence: Int', 'let phase: JavaScriptPhase', 'let dom: DOMFacts'])
        position(tokens(stored), declaration);
    assert.doesNotMatch(stored, /\b(?:runID|nonce|account|token|credential|report|closure|error|String\?)\b/);
});

test('native progress routing precedes closure readiness and uses the exact 12-key gate', () => {
    const routed = tokens(swiftBody(scene, 'userContentController'));
    const progress = position(routed, 'receiveProgressDiagnostic(controller, message: message); return');
    const finish = position(routed, 'receiveFinishDiagnostic(controller, message: message); return', progress);
    position(
        routed,
        'guard !failed, ready, backgroundObserved, foregroundObserved, presentationClosed, !closureReported',
        finish,
    );
    const body = swiftBody(scene, 'receiveProgressDiagnostic'),
        list = tokens(body);
    assert.deepEqual(stringArray(body, /Self\.exact\(message\.body,/), eventKeys);
    for (const source of [
        'message.name == Self.handlerName',
        'controller === view.configuration.userContentController',
        'message.webView === view',
        'message.frameInfo.isMainFrame',
        'url.scheme == "capacitor"',
        'url.host == "localhost"',
        'url.user == nil',
        'url.password == nil',
        'url.port == nil',
        'url.fragment == nil || url.fragment == ""',
        'row["runID"] as? String == runID',
        'row["nonce"] as? String == nonce',
        'Self.integer(row["sequence"], 1...64)',
        'ResearchSceneProgressStageEvidence.JavaScriptPhase(rawValue: name)',
        'if row[key] is NSNull { return nil }',
        'Self.boolean(row[key])',
        'progressStageEvidence.record(sequence: sequence, phase: phase, dom: facts) else { return }',
        'try? writeSceneProgressDiagnostic()',
    ])
        position(list, source);
    assert.match(body, /catch\s*\{\s*return\s*\}/);
    assert.doesNotMatch(
        body,
        /\b(?:ready|failed|backgroundObserved|foregroundObserved|presentationClosed|protectedReady|sceneAuthorityFacts|sceneClosureEvidence|evaluateJavaScript|authenticate|fenceSession|currentAccount|call|facade|Task|Timer)\b/,
    );
    assert.match(swiftBody(scene, 'exact'), /Set\(row\.keys\)\s*==\s*Set\(keys\)/);
    assert.match(swiftBody(scene, 'boolean'), /CFGetTypeID\(number\)\s*==\s*CFBooleanGetTypeID\(\)/);
    assert.match(swiftBody(scene, 'integer'), /CFGetTypeID\(number\)\s*!=\s*CFBooleanGetTypeID\(\)/);
});

test('native append preserves ordered facts, refuses gaps/replay/overflow and never resets captured entries', () => {
    const list = tokens(swiftBody(recorder, 'record'));
    const consistent = position(list, 'guard dom.isConsistent else { return false }');
    const locked = position(list, 'lock.lock(); defer { lock.unlock() }', consistent);
    const ordered = position(list, 'sequence == entries.count + 1 else { return false }', locked);
    position(list, 'entries.append(Entry(sequence: sequence, phase: phase, dom: dom))', ordered);
    position(list, 'entries.count < Self.maximumEntries', locked);
    position(list, '(1...Self.maximumEntries).contains(sequence)', locked);
    assert.doesNotMatch(recorder, /\b(?:reset|clear|removeAll|removeFirst|removeLast|Timer|Task|FileManager)\b/);
    assert.match(recorder, /"acceptanceEvidence": false/);
});

test('native persistence is optional, private, bounded at 16384 and exclusive before atomic updates', () => {
    const body = swiftBody(scene, 'writeSceneProgressDiagnostic'),
        list = tokens(body);
    const owned = position(list, 'try observer.persist(inNativeDocumentsRoot: documents).path == observerFile.path');
    const serialized = position(list, 'progressStageEvidence.snapshot().json', owned);
    const bound = position(list, 'guard (1...16384).contains(bytes.count)', serialized);
    const existing = position(
        list,
        'guard existing.path == file.path else { throw ResearchFullAppSceneUiError.unavailable }',
        bound,
    );
    const checked = position(list, 'try requireFirstInboxDiagnostic(file, maximumBytes: 16384)', existing);
    const atomic = position(list, 'try bytes.write(to: file, options: [.atomic, .completeFileProtection])', checked);
    const exclusive = position(
        list,
        'try bytes.write(to: file, options: [.withoutOverwriting, .completeFileProtection])',
        atomic,
    );
    const mode = position(
        list,
        'try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)',
        exclusive,
    );
    position(list, 'try requireFirstInboxDiagnostic(file, maximumBytes: 16384)', mode);
    assert.match(body, /\/scene-progress-stage\.json/);
    const validation = tokens(swiftBody(scene, 'requireFirstInboxDiagnostic'));
    for (const source of [
        'String(cString: canonical) == file.path',
        'lstat($0, &metadata)',
        '(UInt32(metadata.st_mode) & UInt32(S_IFMT)) == UInt32(S_IFREG)',
        'metadata.st_uid == getuid()',
        '(UInt32(metadata.st_mode) & 0o7777) == 0o600',
        '(1...maximumBytes).contains(Int(metadata.st_size))',
    ])
        position(validation, source);
    const capture = swiftBody(scene, 'capture');
    assert.deepEqual(
        tokens(
            capture
                .replace(/try\? writeSceneProgressDiagnostic\(\)/, '')
                .replace(/Self\.persistAuthorityTimingDiagnostic\(\)/, ''),
            true,
        ),
        tokens(swiftBody(oldScene, 'capture'), true),
    );
    const route = swiftBody(scene, 'userContentController');
    const stripped = route.replace(
        /if let body = message\.body as\? \[String: Any\], body\["kind"\] as\? String == "scene-progress-javascript-diagnostic"\s*\{\s*receiveProgressDiagnostic\(controller, message: message\); return\s*\}/,
        '',
    );
    assert.deepEqual(tokens(stripped, true), tokens(swiftBody(oldScene, 'userContentController'), true));
    assert.doesNotMatch(
        body,
        /\b(?:ready|failed|sceneAuthority|fenceSession|authenticate|report|closureReported|evaluateJavaScript)\b/,
    );
});

test('ordinary native lanes exclude the progress recorder and protected report stays at its original 20 keys', () => {
    for (const simulator of [false, true]) {
        assert.deepEqual(tokens(swiftLane(scene, ['E2EE_FULL_APP_PROTECTED_UI_FIXTURE'], simulator)), []);
        assert.deepEqual(tokens(swiftLane(recorder, ['E2EE_FULL_APP_PROTECTED_UI_FIXTURE'], simulator)), []);
    }
    assert.notEqual(swiftLane(recorder, [sceneFlag], true).length, 0);
    assert.deepEqual(tokens(swiftLane(recorder, [sceneFlag], false)), []);
    assert.equal(FULL_APP_PROTECTED_REPORT_KEYS.length, 20);
    assert.deepEqual(
        dictionaryKeys(swiftBody(protectedFixture, 'write'), /let\s+body:\s*\[String:\s*Any\]\s*=/),
        FULL_APP_PROTECTED_REPORT_KEYS,
    );
});

test('source pins include recorder/parser only for scene proof and generator/build inventory is scene-only', () => {
    const ordinary = enclosed(driver, /\bconst\s+names\s*=\s*(?=\[)/, '[', ']');
    const added = enclosed(driver, /if\s*\(sceneProof\)\s*names\.push/, '(', ')');
    assert.doesNotMatch(ordinary, /ResearchSceneProgressStageEvidence|sceneProgressStageContract/);
    assert.match(added, /'bridge-native\/ResearchSceneProgressStageEvidence\.swift'/);
    assert.match(added, /'bridge-native\/sceneProgressStageContract\.mjs'/);
    assert.doesNotMatch(
        jsBody(driver, 'sceneSourceBindings'),
        /ResearchSceneProgressStageEvidence|sceneProgressStageContract/,
    );
    assert.match(
        jsBody(driver, 'sceneFiles'),
        /progressDiagnostic:\s*join\(directory,\s*'scene-progress-stage\.json'\)/,
    );
    const filenames = (text) =>
        tokens(text)
            .filter((value) => /^'[A-Za-z0-9_-]+\.swift'$/.test(value))
            .map((value) => value.slice(1, -1));
    const base = filenames(enclosed(builder, /\bconst\s+sourcePaths\s*=/, '[', ']'));
    const protectedFiles = filenames(enclosed(builder, /if\s*\(fullAppProtectedUi\)\s*sourcePaths\.push/, '(', ')'));
    const sceneFiles = filenames(enclosed(builder, /if\s*\(sceneResource\)\s*sourcePaths\.push/, '(', ')'));
    const ordinaryFiles = [...base, 'ResearchLocalUiFixture.swift', ...protectedFiles];
    assert.equal(ordinaryFiles.length, 24);
    assert.equal(ordinaryFiles.includes('ResearchSceneProgressStageEvidence.swift'), false);
    assert.equal(sceneFiles.filter((name) => name === 'ResearchSceneProgressStageEvidence.swift').length, 1);
    const inventory = /scene_sources\s*=\s*%w\[([^\]]+)\]\.sort/.exec(ruby)?.[1].trim().split(/\s+/).sort();
    assert.deepEqual([...ordinaryFiles, ...sceneFiles].sort(), inventory);
    assert.match(
        ruby,
        /manifest\['sceneUiFixture'\]\s*\?\s*sources\.sort\s*==\s*scene_sources\s*:\s*sources\.length\.between\?\(3,\s*24\)/,
    );
    assert.match(builder, /receipt\.sourceHashes\[source\]\s*=\s*hash\(source\)/);
    assert.match(builder, /assert\(hash\(output\)\s*===\s*receipt\.sourceHashes\[source\]\)/);
});

test('driver checks external PID/epoch/resource/source bindings then copies exact private raw bytes', () => {
    const body = jsBody(driver, 'captureSceneProgressStageDiagnostic'),
        list = tokens(body);
    let after = position(list, 'if (!sceneProof) return');
    for (const source of [
        'assert(Number.isSafeInteger(receipt.ownedLaunchPID) && receipt.ownedLaunchPID > 0)',
        "const observer = inspectSceneObservation(JSON.parse(observerBytes.toString('utf8')))",
        'observer.process.pid === receipt.ownedLaunchPID && observer.process.epoch === files.epoch',
        'hash(regular(sceneFixtureFile, 65536)) === receipt.sceneFixtureResource.sha256',
        'hash(regular(protectedFixtureFile, 128 * 1024)) === receipt.fixtureResource.sha256',
        'Object.entries(receipt.sourceHashes)',
        'hash(regular(join(checkout, name))) === expected',
        'const source = regular(files.progressDiagnostic, 16384)',
        'diagnosticBytes.length > 0 && diagnosticBytes.length <= 16384',
        "const inspection = inspectSceneProgressStageEvidence(JSON.parse(diagnosticBytes.toString('utf8')))",
        'privateDirectory.uid === process.getuid() && (privateDirectory.mode & 0o7777) === 0o700',
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
        /nativeObservationPassed|nativeProtectedExchangeAccepted\s*=|realOsLifecycleProved\s*=|receipt\.status\s*=|receipt\.nativeReceipt\s*=|scenePins\s*=|\.message\b|\.stack\b/,
    );
});

function syntheticDiagnostic(entries = 1) {
    return {
        version: 1,
        kind: 'scene-progress-stage-diagnostic',
        entries: Array.from({ length: entries }, (_, index) => ({
            sequence: index + 1,
            phase: 'send-enabled',
            sendPresent: true,
            sendEnabled: index % 2 === 0,
            composePresent: true,
            composeEmpty: false,
            composeDisabled: false,
            composeReadOnly: false,
        })),
        acceptanceEvidence: false,
    };
}

// Only the extracted helpers run here over synthetic immutable source bytes and
// in-memory I/O. Identity and ownership inputs are mocked, never native proof.
function captureFixture(diagnostic = syntheticDiagnostic(), edit = () => {}) {
    const runID = '12345678-1234-4234-8234-123456789abc',
        nonce = 'a'.repeat(64);
    const epoch = '22345678-1234-4234-8234-123456789abc';
    const files = {
        observer: '/synthetic-owned/scene/scene-observer.json',
        progressDiagnostic: '/synthetic-owned/scene/scene-progress-stage.json',
        epoch,
    };
    const hashes = new Map([
        ['/synthetic-private/scene-resource.json', 'b'.repeat(64)],
        ['/synthetic-private/fixture-resource.json', 'c'.repeat(64)],
        ['/synthetic-checkout/driver.mjs', 'd'.repeat(64)],
    ]);
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
        [files.observer, JSON.stringify(observer, null, 2) + '\n'],
        [files.progressDiagnostic, JSON.stringify(diagnostic, null, 1) + '\n'],
    ]);
    const writes = [],
        saves = [];
    const state = {
        assert,
        createHash,
        dirname,
        join,
        JSON,
        runID,
        nonce,
        sceneProof: true,
        scenePins: undefined,
        checkout: '/synthetic-checkout',
        scratch: '/synthetic-private',
        sceneFixtureFile: '/synthetic-private/scene-resource.json',
        protectedFixtureFile: '/synthetic-private/fixture-resource.json',
        sceneProgressDiagnosticCaptureComplete: false,
        receipt: {
            status: 'failed',
            ownedLaunchPID: 42,
            nativeProtectedExchangeAccepted: false,
            realOsLifecycleProved: false,
            sourceHashes: { 'driver.mjs': 'd'.repeat(64) },
            sceneFixtureResource: { sha256: 'b'.repeat(64) },
            fixtureResource: { sha256: 'c'.repeat(64) },
        },
        process: { getuid: () => 501 },
        sceneFiles: () => files,
        existsSync: (path) => contents.has(path),
        regular: (path, limit = 16 * 1024 * 1024) => {
            assert.ok(contents.has(path) || hashes.has(path));
            if (contents.has(path))
                assert.ok(Buffer.byteLength(contents.get(path)) > 0 && Buffer.byteLength(contents.get(path)) <= limit);
            return path;
        },
        lstatSync: (path) => ({
            uid: 501,
            mode: path === dirname(files.observer) || path === '/synthetic-private' ? 0o40700 : 0o100600,
        }),
        readFileSync: (path) => Buffer.from(contents.get(path)),
        hash: (path) => hashes.get(path) ?? createHash('sha256').update(contents.get(path)).digest('hex'),
        writeFileSync: (path, bytes, options) => {
            assert.ok(!contents.has(path));
            assert.deepEqual(hostValue(options), { mode: 0o600, flag: 'wx' });
            assert.ok(Buffer.isBuffer(bytes));
            contents.set(path, bytes.toString('utf8'));
            writes.push(path);
        },
        inspectSceneProgressStageEvidence,
        inspectResearchSceneLifecycleEvidence,
        save: () => saves.push(true),
    };
    edit({ state, contents, files, hashes, observer });
    runInNewContext(
        'function inspectSceneObservation(raw, diagnostic = false) {' +
            jsBody(driver, 'inspectSceneObservation') +
            '}\n(function capture() {' +
            jsBody(driver, 'captureSceneProgressStageDiagnostic') +
            '})();',
        state,
        { timeout: 1000 },
    );
    return { state, contents, files, writes, saves };
}

test('synthetic extracted driver preserves raw bytes and detached Boolean diagnostics without accepting a failed run', () => {
    for (const count of [0, 1, 64]) {
        const input = syntheticDiagnostic(count),
            { state, contents, files, writes, saves } = captureFixture(input);
        assert.equal(state.receipt.sceneProgressStageDiagnosticStatus, 'observed-unaccepted');
        assert.equal(state.receipt.sceneProgressDiagnosticCaptureComplete, count > 0);
        assert.deepEqual(hostValue(state.receipt.sceneProgressStageDiagnostic.inspection), input);
        assert.equal(state.receipt.status, 'failed');
        assert.equal(state.receipt.nativeProtectedExchangeAccepted, false);
        assert.equal(state.receipt.realOsLifecycleProved, false);
        assert.equal(state.receipt.sceneProgressStageDiagnostic.acceptanceEvidence, false);
        assert.equal(state.receipt.sceneProgressStageDiagnostic.wholeRunAccepted, false);
        assert.equal(state.receipt.sceneProgressStageDiagnostic.binding.pid, 42);
        assert.equal(state.receipt.sceneProgressStageDiagnostic.binding.epoch, files.epoch);
        assert.equal(writes.length, 2);
        assert.equal(saves.length, 1);
        assert.equal(contents.get(writes[0]), contents.get(files.progressDiagnostic));
        assert.equal(contents.get(writes[1]), contents.get(files.observer));
        assert.equal(
            state.receipt.sceneProgressStageDiagnostic.sha256,
            state.receipt.sceneProgressStageDiagnostic.sourceSHA256,
        );
        assert.equal(
            state.receipt.sceneProgressStageDiagnostic.binding.observerReceipt.sha256,
            state.receipt.sceneProgressStageDiagnostic.binding.observerReceipt.sourceSHA256,
        );
    }
});

for (const [label, edit, expected] of [
    ['missing file', ({ contents, files }) => contents.delete(files.progressDiagnostic), 'no-file'],
    [
        'secret extra field',
        ({ contents, files }) =>
            contents.set(
                files.progressDiagnostic,
                JSON.stringify({ ...syntheticDiagnostic(), message: 'synthetic-private-canary' }),
            ),
        'refused',
    ],
    ['oversized bytes', ({ contents, files }) => contents.set(files.progressDiagnostic, ' '.repeat(16385)), 'refused'],
    [
        'unmeasured launch PID',
        ({ state }) => {
            delete state.receipt.ownedLaunchPID;
        },
        'refused',
    ],
    [
        'observer PID mismatch',
        ({ state }) => {
            state.receipt.ownedLaunchPID = 43;
        },
        'refused',
    ],
    [
        'observer epoch mismatch',
        ({ files }) => {
            files.epoch = '32345678-1234-4234-8234-123456789abc';
        },
        'refused',
    ],
    [
        'changed scene resource',
        ({ hashes }) => hashes.set('/synthetic-private/scene-resource.json', 'e'.repeat(64)),
        'refused',
    ],
    [
        'changed protected resource',
        ({ hashes }) => hashes.set('/synthetic-private/fixture-resource.json', 'e'.repeat(64)),
        'refused',
    ],
    ['changed source', ({ hashes }) => hashes.set('/synthetic-checkout/driver.mjs', 'e'.repeat(64)), 'refused'],
    [
        'nonprivate metadata',
        ({ state }) => {
            state.lstatSync = () => ({ uid: 501, mode: 0o100644 });
        },
        'refused',
    ],
    [
        'foreign scratch owner',
        ({ state }) => {
            const prior = state.lstatSync;
            state.lstatSync = (path) => (path === state.scratch ? { uid: 502, mode: 0o40700 } : prior(path));
        },
        'refused',
    ],
])
    test('synthetic extracted driver refuses ' + label + ' before any diagnostic copy', () => {
        const { state, writes } = captureFixture(syntheticDiagnostic(), edit);
        assert.equal(state.receipt.sceneProgressStageDiagnosticStatus, expected);
        assert.equal(state.receipt.sceneProgressDiagnosticCaptureComplete, false);
        assert.equal(state.receipt.sceneProgressStageDiagnostic, undefined);
        assert.equal(state.receipt.nativeProtectedExchangeAccepted, false);
        assert.equal(writes.length, 0);
    });

test('synthetic extracted driver ordinary mode performs no scene reads or writes', () => {
    const { state, writes, saves } = captureFixture(syntheticDiagnostic(), ({ state }) => {
        state.sceneProof = false;
        state.sceneFiles = () => assert.fail('ordinary mode must not read scene diagnostic');
    });
    assert.equal(state.receipt.sceneProgressStageDiagnosticStatus, undefined);
    assert.equal(writes.length, 0);
    assert.equal(saves.length, 0);
});

test('capture/refusal checks precede owned cleanup and diagnostics alone never authorize whole-run acceptance', () => {
    const body = enclosed(driver, /\}\s*finally\b/),
        list = tokens(body);
    let after = position(list, 'captureLatestSceneNativeDiagnostic();');
    after = position(list, 'captureFirstInboxStageDiagnostic();', after);
    after = position(list, 'captureSceneFinishStageDiagnostic();', after);
    after = position(list, 'captureSceneProgressStageDiagnostic();', after);
    after = position(
        list,
        'sceneProof && nativeObservationPassed && firstInboxDiagnosticCaptureComplete && sceneFinishDiagnosticCaptureComplete && !sceneProgressDiagnosticCaptureComplete',
        after,
    );
    after = position(list, "receipt.failedOperation = 'scene-progress-diagnostic-validate'", after);
    after = position(list, 'if (simulator)', after);
    after = position(list, "quiet('/usr/bin/xcrun', ['simctl', 'delete', simulator])", after);
    after = position(
        list,
        'nativeObservationPassed && (!sceneProof || firstInboxDiagnosticCaptureComplete) && (!sceneProof || sceneFinishDiagnosticCaptureComplete) && (!sceneProof || sceneProgressDiagnosticCaptureComplete) && (!sceneProof || sceneClosureDiagnosticCaptureComplete) && (!sceneProof || sceneAuthorityTimingDiagnosticCaptureComplete) && receipt.ownedSimulatorRemoved === true',
        after,
    );
    position(list, 'receipt.nativeProtectedExchangeAccepted = true', after);
    for (const name of ['copyNativeEnvelope', 'captureLatestSceneNativeDiagnostic'])
        assert.deepEqual(tokens(jsBody(driver, name)), tokens(jsBody(oldDriver, name)));
});
