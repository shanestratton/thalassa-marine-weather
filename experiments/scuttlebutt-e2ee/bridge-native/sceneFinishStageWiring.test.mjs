// Synthetic source/JavaScript regressions only. These do not execute Swift,
// native crypto, an app, an OS transition or a native acceptance gate.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { FULL_APP_PROTECTED_REPORT_KEYS } from './fullAppProtectedUiContract.mjs';
import {
    SCENE_FINISH_JAVASCRIPT_FAILURE_PHASE_NAMES,
    inspectSceneFinishStageEvidence,
} from './sceneFinishStageContract.mjs';

const read = (name) => readFileSync(new URL(name, import.meta.url), 'utf8');
const repository = fileURLToPath(new URL('../../..', import.meta.url));
const frozenBase = 'a820d34912af8250c31bee432c5fc16cbd7ebd62';
const original = (name) =>
    execFileSync('/usr/bin/git', ['show', frozenBase + ':experiments/scuttlebutt-e2ee/' + name], {
        cwd: repository,
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
    });
const javascript = read('../full-app-pilot/nativeProtectedUiFixture.js');
const protectedFixture = read('ResearchFullAppProtectedUiFixture.swift');
const scene = read('ResearchFullAppSceneUiFixture.swift');
const recorder = read('ResearchSceneFinishStageEvidence.swift');
const driver = read('fullAppProtectedUiProof.mjs');
const oldJavascript = original('full-app-pilot/nativeProtectedUiFixture.js');
const oldProtectedFixture = original('bridge-native/ResearchFullAppProtectedUiFixture.swift');
const oldDriver = original('bridge-native/fullAppProtectedUiProof.mjs');

// Preserve literals while ignoring comments/formatting. This is deliberately a
// small source-contract lexer, not a JavaScript or Swift compiler.
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
    assert.fail('unterminated declaration');
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
    const body = enclosed(source, pattern, '[', ']');
    const list = tokens(body);
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
    assert.ok(match, 'required dictionary absent');
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
        } else if (stack.length === 1 && text.startsWith('"') && list[index + 1]?.text === ':')
            keys.push(JSON.parse(text));
    }
    assert.fail('unterminated dictionary');
}
function compilerCondition(expression, sceneEnabled, simulator) {
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
        return value === 'SIMULATOR'
            ? simulator
            : value === 'E2EE_FULL_APP_SCENE_UI_FIXTURE'
              ? sceneEnabled
              : value === 'E2EE_FULL_APP_PROTECTED_UI_FIXTURE';
    }
    function and() {
        let result = atom();
        while (list[index] === '&&') {
            index++;
            const right = atom();
            result = result && right;
        }
        return result;
    }
    function or() {
        let result = and();
        while (list[index] === '||') {
            index++;
            const right = and();
            result = result || right;
        }
        return result;
    }
    const result = or();
    assert.equal(index, list.length);
    return result;
}
function swiftLane(source, sceneEnabled, simulator) {
    const stack = [],
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
                selected = compilerCondition(expression, sceneEnabled, simulator);
            stack.push({ parent, taken: selected, active: parent && selected });
        } else {
            assert.ok(stack.length, 'unmatched compiler directive');
            const frame = stack.at(-1);
            if (kind === 'endif') stack.pop();
            else if (kind === 'else') {
                frame.active = frame.parent && !frame.taken;
                frame.taken = true;
            } else {
                const selected = compilerCondition(expression, sceneEnabled, simulator);
                frame.active = frame.parent && !frame.taken && selected;
                frame.taken ||= selected;
            }
        }
    }
    assert.equal(stack.length, 0);
    return kept.join('\n');
}
// These exact compiler blocks in receive/finish contain only newly added
// diagnostic values. Keeping all other tokens checks the original behavior.
function stripDiagnosticBlocks(source) {
    const stack = [],
        kept = [];
    for (const line of source.split('\n')) {
        const directive = /^\s*#(if|elseif|else|endif)\b(.*)$/.exec(line);
        if (directive) {
            const [, kind, expression] = directive;
            if (kind === 'if')
                stack.push(
                    stack.includes(true) ||
                        expression.trim() === 'E2EE_FULL_APP_SCENE_UI_FIXTURE && targetEnvironment(simulator)' ||
                        expression.trim() === 'targetEnvironment(simulator)',
                );
            else if (kind === 'endif') {
                const removed = stack.pop();
                if (!removed) kept.push(line);
                continue;
            }
            if (!stack.includes(true)) kept.push(line);
        } else if (!stack.includes(true)) kept.push(line);
    }
    assert.equal(stack.length, 0);
    return kept.join('\n');
}
const hostValue = (value) => JSON.parse(JSON.stringify(value));
const phaseNames = stringArray(javascript, /\bconst\s+failurePhases\s*=/);

test('fixed JS diagnostic phases are exactly the 23 exported parser names', () => {
    assert.equal(phaseNames.length, 23);
    assert.equal(new Set(phaseNames).size, 23);
    assert.deepEqual(phaseNames, SCENE_FINISH_JAVASCRIPT_FAILURE_PHASE_NAMES);
    assert.match(javascript, /const failurePhases\s*=\s*Object\.freeze\(/);
});

test('wait body preserves the original 20 second bound, 25 ms polling and refusal checks', () => {
    const body = jsBody(javascript, 'wait')
        .replace(/\benterFailurePhase\(failurePhase\);/, '')
        .replace(/\bobserveProgressStage\(\);/, '');
    assert.deepEqual(tokens(body), tokens(jsBody(oldJavascript, 'wait')));
    assert.match(javascript, /const until\s*=\s*Date\.now\(\)\s*\+\s*180000\s*;/);
    assert.match(body, /Math\.min\(until,\s*Date\.now\(\)\s*\+\s*20000\)/);
    assert.match(body, /setTimeout\(resolve,\s*25\)/);
});

test('refresh diagnostics enter before the enabled guard and preserve refresh work', () => {
    const body = jsBody(javascript, 'refreshMessages'),
        list = tokens(body);
    const entered = position(list, 'enterFailurePhase(enabledPhase);');
    position(list, 'require(enabled(refresh));', entered);
    const stripped = body.replace(/\benterFailurePhase\(enabledPhase\);/, '').replace(/,\s*completionPhase\s*\)/, ')');
    assert.deepEqual(tokens(stripped), tokens(jsBody(oldJavascript, 'refreshMessages')));
    assert.match(javascript, /refreshMessages\('receive-refresh-enabled',\s*'receive-refresh-completion'\)/);
    assert.match(javascript, /refreshMessages\('dedup-refresh-enabled',\s*'dedup-refresh-completion'\)/);
});

test('synthetic refresh refusal records its fixed phase before any observer or click', async () => {
    const events = [];
    const promise = runInNewContext(
        '(async function refreshMessages(enabledPhase, completionPhase) {' +
            jsBody(javascript, 'refreshMessages') +
            "})('receive-refresh-enabled', 'receive-refresh-completion')",
        {
            enterFailurePhase: (phase) => events.push(['phase', phase]),
            button: () => ({}),
            enabled: () => false,
            require: (value) => {
                if (!value) throw Error('synthetic refusal');
            },
            MutationObserver: class {
                constructor() {
                    events.push(['observer']);
                }
            },
        },
    );
    await assert.rejects(promise, /synthetic refusal/);
    assert.deepEqual(events, [['phase', 'receive-refresh-enabled']]);
});

test('scene phase entry retains only an allowlisted value and ordinary entry is disabled', () => {
    for (const sceneEnabled of [false, true]) {
        const context = {
            sceneLifecycleProof: sceneEnabled,
            failurePhases: phaseNames,
            lastFailurePhase: null,
            observeProgressStage: () => {},
        };
        runInNewContext(
            'function enterFailurePhase(phase) {' +
                jsBody(javascript, 'enterFailurePhase') +
                "} enterFailurePhase('peer-reply'); enterFailurePhase('unknown-phase');",
            context,
        );
        assert.equal(context.lastFailurePhase, sceneEnabled ? 'peer-reply' : null);
    }
});

test('synthetic JS failure payload has exactly five keys and optional publication cannot throw', () => {
    const published = [],
        context = {
            sceneLifecycleProof: true,
            runID: 'synthetic-run',
            nonce: 'synthetic-binding',
            lastFailurePhase: 'peer-reply',
            window: {
                webkit: {
                    messageHandlers: {
                        researchFullAppSceneUiFixture: { postMessage: (value) => published.push(hostValue(value)) },
                    },
                },
            },
        };
    const invocation = '(function postFailureDiagnostic() {' + jsBody(javascript, 'postFailureDiagnostic') + '})()';
    runInNewContext(invocation, context);
    assert.deepEqual(Object.keys(published[0]), ['version', 'kind', 'runID', 'nonce', 'phase']);
    assert.deepEqual(published[0], {
        version: 1,
        kind: 'scene-finish-javascript-diagnostic',
        runID: 'synthetic-run',
        nonce: 'synthetic-binding',
        phase: 'peer-reply',
    });
    context.window.webkit.messageHandlers.researchFullAppSceneUiFixture.postMessage = () => {
        throw Error('synthetic publication refusal');
    };
    assert.doesNotThrow(() => runInNewContext(invocation, context));
    context.sceneLifecycleProof = false;
    context.window = null;
    assert.doesNotThrow(() => runInNewContext(invocation, context));
});

test('optional diagnostic precedes the existing failed report and preserves scene/ordinary fence behavior', () => {
    const catchPattern = /\}\)\(\)\.catch\(\(\)\s*=>/;
    const current = enclosed(javascript, catchPattern),
        baseline = enclosed(oldJavascript, catchPattern);
    assert.deepEqual(tokens(current.replace(/\bpostFailureDiagnostic\(\);/, '')), tokens(baseline));
    position(
        tokens(current),
        "post('failed', 'fixture-failed');",
        position(tokens(current), 'postFailureDiagnostic();'),
    );
    for (const sceneEnabled of [false, true]) {
        const events = [];
        runInNewContext('(function() {' + current + '})()', {
            sceneLifecycleProof: sceneEnabled,
            window: {
                PageTransitionEvent: class {
                    constructor(name) {
                        this.type = name;
                    }
                },
                dispatchEvent: (event) => events.push(event.type),
            },
            postFailureDiagnostic: () => events.push('diagnostic'),
            post: (status, phase) => events.push(status + ':' + phase),
        });
        assert.deepEqual(
            events,
            sceneEnabled
                ? ['diagnostic', 'failed:fixture-failed']
                : ['pagehide', 'diagnostic', 'failed:fixture-failed'],
        );
    }
    assert.match(
        javascript,
        /\}\s*catch\s*\{\s*postFailureDiagnostic\(\);\s*post\('failed',\s*'fixture-failed'\);\s*\}\s*\}\)\(\);\s*$/,
    );
});

test('early native diagnostic routing precedes every closure readiness guard', () => {
    const list = tokens(swiftBody(scene, 'userContentController'));
    const diagnostic = position(list, 'receiveFinishDiagnostic(controller, message: message); return');
    position(
        list,
        'guard !failed, ready, backgroundObserved, foregroundObserved, presentationClosed, !closureReported',
        diagnostic,
    );
});

test('early diagnostic checks frame, view, origin and owned binding without entering authority paths', () => {
    const body = swiftBody(scene, 'receiveFinishDiagnostic'),
        list = tokens(body);
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
    ])
        position(list, source);
    assert.deepEqual(stringArray(body, /Self\.exact\(message\.body,/), ['version', 'kind', 'runID', 'nonce', 'phase']);
    assert.match(body, /selectJavaScriptFailurePhase\(name:\s*phase\)\s*else\s*\{\s*return\s*\}/);
    const identifiers = new Set(list.filter((value) => /^[A-Za-z_]\w*$/.test(value)));
    for (const name of [
        'authenticate',
        'fenceSession',
        'currentAccount',
        'messageSnapshot',
        'protectedReady',
        'sceneAuthorityFacts',
        'sceneClosureEvidence',
        'evaluateJavaScript',
        'executeMessageOperation',
        'call',
        'facade',
        'ready',
        'backgroundObserved',
        'foregroundObserved',
        'presentationClosed',
        'failed',
    ])
        assert.equal(identifiers.has(name), false, 'diagnostic entered forbidden authority/closure path: ' + name);
    assert.match(body, /catch\s*\{\s*return\s*\}/);
});

test('unknown JS phase decoding happens before selection and duplicates cannot overwrite capture', () => {
    const decoder = enclosed(recorder, /func\s+selectJavaScriptFailurePhase\(name:\s*String\?\)/),
        selected = enclosed(recorder, /func\s+selectJavaScriptFailurePhase\(_\s+phase:/);
    position(
        tokens(decoder),
        'return selectJavaScriptFailurePhase(phase)',
        position(tokens(decoder), 'JavaScriptFailurePhase(rawValue: name) else { return false }'),
    );
    position(
        tokens(selected),
        'javascript = JavaScriptCapture(phase: phase)',
        position(tokens(selected), 'guard javascript == nil else { return false }'),
    );
    assert.match(decoder, /name\.utf8\.count\s*<=\s*48/);
    assert.doesNotMatch(selected, /\b(?:Report|DmNativeMessageSnapshot|VodozemacSessionFacade|Error|Task|Timer)\b/);
});

test('native selection follows the original finish guard and stores only fixed enum tuple inputs', () => {
    const body = swiftBody(protectedFixture, 'finish'),
        list = tokens(body);
    const guard = position(list, 'guard !completed, !finalizing else { return }');
    const selection = position(list, 'Self.sceneFinishStageEvidence.selectNativeFinish(', guard);
    position(list, 'lock.lock(); finalizing = true; terminal = true; lock.unlock()', selection);
    assert.match(
        protectedFixture,
        /private var sceneFinishInput:\s*\(ResearchSceneFinishStageEvidence\.Callsite,\s*ResearchSceneFinishStageEvidence\.NativeValidationBoundary\?\)\?/,
    );
    const capture = enclosed(recorder, /private\s+struct\s+NativeCapture\b/);
    assert.deepEqual(
        tokens(capture),
        tokens('let callsite: Callsite let boundary: NativeValidationBoundary? let reportPhase: AdmittedReportPhase'),
    );
    assert.doesNotMatch(capture, /\b(?:Report|DmNativeMessageSnapshot|VodozemacSessionFacade|Error|Task|Timer|Any)\b/);
    const diagnostic = /#if E2EE_FULL_APP_SCENE_UI_FIXTURE && targetEnvironment\(simulator\)([\s\S]*?)#endif/.exec(
        body,
    );
    assert.ok(diagnostic);
    assert.doesNotMatch(
        tokens(diagnostic[1]).join(' '),
        /\b(?:authenticate|fenceSession|fenced|currentAccount|messageSnapshot|executeMessageOperation|persistSceneFinishDiagnostic|Task|Timer)\b/,
    );
});

for (const name of ['userContentController', 'finish'])
    test('removing only diagnostic compiler blocks preserves native ' + name + ' behavior', () => {
        const current = swiftLane(stripDiagnosticBlocks(swiftBody(protectedFixture, name)), true, true),
            baseline = swiftLane(stripDiagnosticBlocks(swiftBody(oldProtectedFixture, name)), true, true);
        assert.deepEqual(tokens(current, true), tokens(baseline, true));
    });

test('ordinary protected source lane excludes diagnostics and keeps all prior code tokens', () => {
    for (const simulator of [false, true]) {
        const current = swiftLane(protectedFixture, false, simulator),
            baseline = swiftLane(oldProtectedFixture, false, simulator);
        assert.deepEqual(tokens(current, true), tokens(baseline, true));
        assert.doesNotMatch(current, /\b(?:sceneFinishInput|sceneFinishStageEvidence|persistSceneFinishDiagnostic)\b/);
    }
    assert.deepEqual(tokens(swiftLane(scene, false, true)), []);
});

test('native report retains the exact 20 keys and the original write behavior', () => {
    const body = swiftBody(protectedFixture, 'write');
    assert.equal(FULL_APP_PROTECTED_REPORT_KEYS.length, 20);
    assert.deepEqual(dictionaryKeys(body, /let\s+body:\s*\[String:\s*Any\]\s*=/), FULL_APP_PROTECTED_REPORT_KEYS);
    const current = swiftLane(body, true, true)
            .replace(/ResearchFullAppSceneUiFixture\.persistSceneFinishDiagnostic\(\)/, '')
            .replace(/ResearchFullAppSceneUiFixture\.persistAuthorityTimingDiagnostic\(\)/, ''),
        baseline = swiftLane(swiftBody(oldProtectedFixture, 'write'), true, true);
    assert.deepEqual(tokens(current, true), tokens(baseline, true));
    assert.deepEqual(tokens(jsBody(javascript, 'post')), tokens(jsBody(oldJavascript, 'post')));
});

test('finish persistence is optional, private, bounded and cannot adopt an existing file', () => {
    assert.match(
        scene,
        /static func persistSceneFinishDiagnostic\(\)\s*\{\s*try\? shared\.writeSceneFinishDiagnostic\(\)\s*\}/,
    );
    const body = swiftBody(scene, 'writeSceneFinishDiagnostic');
    assert.match(body, /\(1\.\.\.4096\)\.contains\(bytes\.count\)/);
    assert.match(body, /withoutOverwriting,\s*\.completeFileProtection/);
    assert.match(body, /atomic,\s*\.completeFileProtection/);
    assert.match(body, /posixPermissions:\s*0o600/);
    const list = tokens(body);
    position(
        list,
        'try bytes.write(to: file, options: [.atomic, .completeFileProtection])',
        position(list, 'try requireFirstInboxDiagnostic(file)'),
    );
});

test('driver captures inspected exact bytes with launch/resource/source binding before copying', () => {
    const body = jsBody(driver, 'captureSceneFinishStageDiagnostic'),
        list = tokens(body);
    const inspected = position(list, "inspectSceneFinishStageEvidence(JSON.parse(diagnosticBytes.toString('utf8')))");
    const copied = position(list, "writeFileSync(path, diagnosticBytes, { mode: 0o600, flag: 'wx' })", inspected);
    position(list, 'sceneFinishDiagnosticCaptureComplete = true', copied);
    for (const source of [
        'observer.process.pid === receipt.ownedLaunchPID',
        'observer.process.epoch === files.epoch',
        'hash(regular(sceneFixtureFile, 65536)) === receipt.sceneFixtureResource.sha256',
        'hash(regular(protectedFixtureFile, 128 * 1024)) === receipt.fixtureResource.sha256',
        'Object.entries(receipt.sourceHashes)',
        'hash(regular(path, 4096)) === sourceSHA256',
        'hash(regular(observerPath, 65536)) === observerSourceSHA256',
        'acceptanceEvidence: false',
        'wholeRunAccepted: false',
    ])
        position(list, source);
    assert.doesNotMatch(
        body,
        /receipt\.nativeReceipt\s*=|receipt\.status\s*=\s*['"]passed['"]|\b(?:authenticate|fenceSession|currentAccount|nativePromise|executeMessageOperation)\s*\(/,
    );
});

test('valid unselected diagnostic has no native or OS acceptance implication', () => {
    const markers = (names) => Object.fromEntries(names.map((name) => [name, 0]));
    const nativeNames = stringArray(
            read('sceneFinishStageContract.mjs'),
            /export\s+const\s+SCENE_FINISH_CALLSITE_NAMES\s*=/,
        ),
        boundaryNames = stringArray(
            read('sceneFinishStageContract.mjs'),
            /export\s+const\s+SCENE_FINISH_NATIVE_BOUNDARY_NAMES\s*=/,
        ),
        admittedNames = stringArray(
            read('sceneFinishStageContract.mjs'),
            /export\s+const\s+SCENE_FINISH_ADMITTED_REPORT_PHASE_NAMES\s*=/,
        );
    const raw = JSON.parse(
        JSON.stringify({
            version: 1,
            kind: 'scene-finish-stage-diagnostic',
            native: {
                selectedFinishes: 0,
                callsites: markers(nativeNames),
                lastValidationBoundaries: markers([...boundaryNames, 'none']),
                admittedReportPhases: markers(admittedNames),
            },
            javascript: { selectedFailures: 0, failurePhases: markers([...phaseNames, 'none']) },
            acceptanceEvidence: false,
        }),
    );
    const inspected = inspectSceneFinishStageEvidence(raw);
    assert.equal(inspected.native.callsite, null);
    assert.equal(inspected.javascript.failurePhase, null);
    for (const key of [
        'acceptanceEvidence',
        'javascriptConsumptionProved',
        'nativeExecutionProvedByParser',
        'nativePermissionGranted',
        'osLifecycleProvedByParser',
    ])
        assert.equal(inspected[key], false);
});

test('driver diagnostic capture and refusal gates precede owned cleanup and cannot promote a failed run', () => {
    const body = enclosed(driver, /\}\s*finally\b/),
        list = tokens(body);
    const latest = position(list, 'captureLatestSceneNativeDiagnostic();'),
        inbox = position(list, 'captureFirstInboxStageDiagnostic();', latest),
        finish = position(list, 'captureSceneFinishStageDiagnostic();', inbox),
        gate = position(
            list,
            'sceneProof && nativeObservationPassed && firstInboxDiagnosticCaptureComplete && !sceneFinishDiagnosticCaptureComplete',
            finish,
        );
    position(list, "receipt.failedOperation = 'scene-finish-diagnostic-validate'", gate);
    const cleanup = position(list, 'if (simulator)', gate);
    position(
        list,
        'nativeObservationPassed && (!sceneProof || firstInboxDiagnosticCaptureComplete) && (!sceneProof || sceneFinishDiagnosticCaptureComplete) && (!sceneProof || sceneProgressDiagnosticCaptureComplete) && (!sceneProof || sceneClosureDiagnosticCaptureComplete) && (!sceneProof || sceneAuthorityTimingDiagnosticCaptureComplete) && receipt.ownedSimulatorRemoved === true',
        cleanup,
    );
    const latestBody = jsBody(driver, 'captureLatestSceneNativeDiagnostic');
    assert.deepEqual(tokens(latestBody), tokens(jsBody(oldDriver, 'captureLatestSceneNativeDiagnostic')));
    assert.deepEqual(tokens(jsBody(driver, 'copyNativeEnvelope')), tokens(jsBody(oldDriver, 'copyNativeEnvelope')));
    assert.match(latestBody, /writeFileSync\(path,\s*bytes,\s*\{\s*mode:\s*0o600,\s*flag:\s*'wx'\s*\}\)/);
    assert.doesNotMatch(latestBody, /receipt\.nativeReceipt\s*=|receipt\.status\s*=\s*['"]passed['"]/);
    assert.match(driver, /Object\.keys\(prior\.sourceHashes\)\.length\s*===\s*61/);
});
