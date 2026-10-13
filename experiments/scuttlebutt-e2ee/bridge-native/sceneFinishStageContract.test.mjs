// Unwired synthetic object contracts only. No native, JavaScript-consumption,
// authorization, cryptographic or operating-system acceptance is established.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    SCENE_FINISH_CALLSITE_NAMES,
    SCENE_FINISH_NATIVE_BOUNDARY_NAMES,
    SCENE_FINISH_ADMITTED_REPORT_PHASE_NAMES,
    SCENE_FINISH_JAVASCRIPT_FAILURE_PHASE_NAMES,
    inspectSceneFinishStageEvidence as inspect,
} from './sceneFinishStageContract.mjs';

// Independent literals keep a dropped, added or conflated contract name visible.
const callsiteNames = ['js-failed', 'js-passed', 'native-receive-refused'];
const nativeBoundaryNames = ['progress-order', 'http', 'common', 'control', 'write', 'protected-ready', 'final'];
const admittedReportPhaseNames = [
    'none',
    'script-installed',
    'dom-ready',
    'http-refusals',
    'cold-ready',
    'signed-in',
    'unknown-admission',
    'prepared',
    'admission-ready',
    'pm-opened',
    'pm-sent',
    'peer-replied',
    'pm-received',
    'pm-deduped',
    'native-proof-captured',
    'terminal-closed',
    'root-remounted',
    'protected-setup',
    'protected-peer-reply',
    'capture-proof',
    'fixture-complete',
    'fixture-failed',
];
const javascriptFailurePhaseNames = [
    'cold-ready',
    'cold-chat-closed',
    'authenticated',
    'unknown-admission',
    'prepared',
    'native-admission',
    'inbox-entry',
    'thread-open',
    'send-enabled',
    'send-accepted',
    'reply-refresh-enabled',
    'peer-reply',
    'receive-refresh-enabled',
    'receive-refresh-completion',
    'incoming-received',
    'dedup-refresh-enabled',
    'dedup-refresh-completion',
    'proof-captured',
    'url-check',
    'await-foreground',
    'await-closed-window',
    'closure-post',
    'await-closure-ack',
];
const boundaryMarkerNames = [...nativeBoundaryNames, 'none'];
const javascriptMarkerNames = [...javascriptFailurePhaseNames, 'none'];
const markers = (names, selected) => Object.fromEntries(names.map((name) => [name, name === selected ? 1 : 0]));
const input = ({
    nativeSelected = 0,
    nativeCallsite = 'js-failed',
    nativeBoundary = 'none',
    admittedReportPhase = 'none',
    javascriptSelected = 0,
    javascriptFailurePhase = 'none',
} = {}) => ({
    version: 1,
    kind: 'scene-finish-stage-diagnostic',
    native: {
        selectedFinishes: nativeSelected,
        callsites: markers(callsiteNames, nativeSelected === 1 ? nativeCallsite : null),
        lastValidationBoundaries: markers(boundaryMarkerNames, nativeSelected === 1 ? nativeBoundary : null),
        admittedReportPhases: markers(admittedReportPhaseNames, nativeSelected === 1 ? admittedReportPhase : null),
    },
    javascript: {
        selectedFailures: javascriptSelected,
        failurePhases: markers(javascriptMarkerNames, javascriptSelected === 1 ? javascriptFailurePhase : null),
    },
    acceptanceEvidence: false,
});
const at = (data, path) => path.reduce((value, key) => value[key], data);
const replace = (data, path, value) => {
    if (path.length === 0) return value;
    at(data, path.slice(0, -1))[path.at(-1)] = value;
    return data;
};
const dictionaries = [
    { path: ['native', 'callsites'], names: callsiteNames, channel: 'native', selector: 'selectedFinishes' },
    {
        path: ['native', 'lastValidationBoundaries'],
        names: boundaryMarkerNames,
        channel: 'native',
        selector: 'selectedFinishes',
    },
    {
        path: ['native', 'admittedReportPhases'],
        names: admittedReportPhaseNames,
        channel: 'native',
        selector: 'selectedFinishes',
    },
    {
        path: ['javascript', 'failurePhases'],
        names: javascriptMarkerNames,
        channel: 'javascript',
        selector: 'selectedFailures',
    },
];
const scopes = [
    { path: [], keys: ['version', 'kind', 'native', 'javascript', 'acceptanceEvidence'] },
    { path: ['native'], keys: ['selectedFinishes', 'callsites', 'lastValidationBoundaries', 'admittedReportPhases'] },
    { path: ['javascript'], keys: ['selectedFailures', 'failurePhases'] },
    ...dictionaries.map(({ path, names }) => ({ path, keys: names })),
];
const outputKeys = [
    'version',
    'kind',
    'native',
    'javascript',
    'acceptanceEvidence',
    'javascriptConsumptionProved',
    'nativeExecutionProvedByParser',
    'nativePermissionGranted',
    'osLifecycleProvedByParser',
];
const assertNoProof = (result) => {
    for (const key of outputKeys.slice(4)) assert.equal(result[key], false, key);
    for (const value of [result, result.native, result.javascript]) {
        assert.equal(Object.hasOwn(value, 'status'), false);
        assert.equal(Object.hasOwn(value, 'passed'), false);
    }
};
const selectedInput = () => input({ nativeSelected: 1, javascriptSelected: 1 });

test('synthetic fixed vocabulary exports are exact frozen arrays', () => {
    for (const [actual, expected] of [
        [SCENE_FINISH_CALLSITE_NAMES, callsiteNames],
        [SCENE_FINISH_NATIVE_BOUNDARY_NAMES, nativeBoundaryNames],
        [SCENE_FINISH_ADMITTED_REPORT_PHASE_NAMES, admittedReportPhaseNames],
        [SCENE_FINISH_JAVASCRIPT_FAILURE_PHASE_NAMES, javascriptFailurePhaseNames],
    ]) {
        assert.ok(Array.isArray(actual));
        assert.deepEqual(actual, expected);
        assert.ok(Object.isFrozen(actual));
        assert.equal(new Set(actual).size, actual.length);
    }
    assert.equal(SCENE_FINISH_CALLSITE_NAMES.length, 3);
    assert.equal(SCENE_FINISH_NATIVE_BOUNDARY_NAMES.length, 7);
    assert.equal(SCENE_FINISH_ADMITTED_REPORT_PHASE_NAMES.length, 22);
    assert.equal(SCENE_FINISH_JAVASCRIPT_FAILURE_PHASE_NAMES.length, 23);
    assert.equal(SCENE_FINISH_NATIVE_BOUNDARY_NAMES.includes('none'), false);
    assert.equal(SCENE_FINISH_JAVASCRIPT_FAILURE_PHASE_NAMES.includes('none'), false);
});

test('synthetic unselected channels contain no invented finish or failure', () => {
    const data = input();
    const result = inspect(data);
    assert.deepEqual(Reflect.ownKeys(result).sort(), [...outputKeys].sort());
    assert.equal(result.version, 1);
    assert.equal(result.kind, 'scene-finish-stage-diagnostic');
    assert.equal(result.native.selectedFinishes, 0);
    assert.equal(result.native.callsite, null);
    assert.equal(result.native.lastValidationBoundary, null);
    assert.equal(result.native.admittedReportPhase, null);
    assert.equal(result.javascript.selectedFailures, 0);
    assert.equal(result.javascript.failurePhase, null);
    for (const { path } of dictionaries) {
        assert.deepEqual(at(result, path), at(data, path));
        assert.ok(Object.values(at(result, path)).every((value) => value === 0));
    }
    assertNoProof(result);
});

for (const name of callsiteNames)
    test(`synthetic native callsite ${name} does not select the JavaScript channel`, () => {
        const result = inspect(input({ nativeSelected: 1, nativeCallsite: name }));
        assert.equal(result.native.callsite, name);
        assert.equal(result.native.callsites[name], 1);
        assert.equal(result.native.lastValidationBoundary, null);
        assert.equal(result.native.lastValidationBoundaries.none, 1);
        assert.equal(result.native.admittedReportPhase, null);
        assert.equal(result.native.admittedReportPhases.none, 1);
        assert.equal(result.javascript.selectedFailures, 0);
        assert.equal(result.javascript.failurePhase, null);
        assert.equal(result.javascript.failurePhases.none, 0);
        assertNoProof(result);
    });

for (const name of boundaryMarkerNames)
    test(`synthetic native checkpoint ${name} denotes only the last boundary entered`, () => {
        const result = inspect(input({ nativeSelected: 1, nativeBoundary: name }));
        assert.equal(result.native.lastValidationBoundary, name === 'none' ? null : name);
        assert.equal(result.native.lastValidationBoundaries[name], 1);
        assert.equal(
            Object.values(result.native.lastValidationBoundaries).reduce((sum, value) => sum + value, 0),
            1,
        );
        assertNoProof(result);
    });

for (const name of admittedReportPhaseNames)
    test(`synthetic admitted report phase ${name} cannot grant acceptance`, () => {
        const result = inspect(input({ nativeSelected: 1, admittedReportPhase: name }));
        assert.equal(result.native.admittedReportPhase, name === 'none' ? null : name);
        assert.equal(result.native.admittedReportPhases[name], 1);
        assertNoProof(result);
    });

for (const name of javascriptMarkerNames)
    test(`synthetic JavaScript failure ${name} cannot invent a native finish`, () => {
        const result = inspect(input({ javascriptSelected: 1, javascriptFailurePhase: name }));
        assert.equal(result.javascript.selectedFailures, 1);
        assert.equal(result.javascript.failurePhase, name === 'none' ? null : name);
        assert.equal(result.javascript.failurePhases[name], 1);
        assert.equal(result.native.selectedFinishes, 0);
        assert.equal(result.native.callsite, null);
        assert.equal(result.native.lastValidationBoundary, null);
        assert.equal(result.native.admittedReportPhase, null);
        assert.ok(Object.values(result.native.callsites).every((value) => value === 0));
        assertNoProof(result);
    });

test('synthetic native and JavaScript channels preserve independent facts', () => {
    const result = inspect(
        input({
            nativeSelected: 1,
            nativeCallsite: 'native-receive-refused',
            nativeBoundary: 'common',
            admittedReportPhase: 'pm-received',
            javascriptSelected: 1,
            javascriptFailurePhase: 'await-foreground',
        }),
    );
    assert.equal(result.native.callsite, 'native-receive-refused');
    assert.equal(result.native.lastValidationBoundary, 'common');
    assert.equal(result.native.admittedReportPhase, 'pm-received');
    assert.equal(result.javascript.failurePhase, 'await-foreground');
    assertNoProof(result);
});

test('synthetic selected absence differs from an unselected channel in its fixed markers', () => {
    const unselected = inspect(input());
    const selected = inspect(selectedInput());
    assert.equal(unselected.native.lastValidationBoundary, selected.native.lastValidationBoundary);
    assert.equal(unselected.native.admittedReportPhase, selected.native.admittedReportPhase);
    assert.equal(unselected.javascript.failurePhase, selected.javascript.failurePhase);
    assert.equal(unselected.native.lastValidationBoundaries.none, 0);
    assert.equal(selected.native.lastValidationBoundaries.none, 1);
    assert.equal(unselected.native.admittedReportPhases.none, 0);
    assert.equal(selected.native.admittedReportPhases.none, 1);
    assert.equal(unselected.javascript.failurePhases.none, 0);
    assert.equal(selected.javascript.failurePhases.none, 1);
    assertNoProof(selected);
});

test('synthetic duplicate passed-callsite diagnostics cannot promote proof flags', () => {
    const data = input({
        nativeSelected: 1,
        nativeCallsite: 'js-passed',
        nativeBoundary: 'final',
        admittedReportPhase: 'fixture-complete',
        javascriptSelected: 1,
    });
    const first = inspect(data);
    const second = inspect(data);
    assert.deepEqual(second, first);
    assert.notEqual(second, first);
    assertNoProof(first);
    assertNoProof(second);
});

test('synthetic parsed output is an exact frozen tree of detached plain value copies', () => {
    const data = input({
        nativeSelected: 1,
        nativeCallsite: 'js-failed',
        nativeBoundary: 'write',
        admittedReportPhase: 'fixture-failed',
        javascriptSelected: 1,
        javascriptFailurePhase: 'proof-captured',
    });
    const result = inspect(data);
    assert.deepEqual(
        Reflect.ownKeys(result.native).sort(),
        [
            'selectedFinishes',
            'callsites',
            'lastValidationBoundaries',
            'admittedReportPhases',
            'callsite',
            'lastValidationBoundary',
            'admittedReportPhase',
        ].sort(),
    );
    assert.deepEqual(
        Reflect.ownKeys(result.javascript).sort(),
        ['selectedFailures', 'failurePhases', 'failurePhase'].sort(),
    );
    for (const { path } of scopes) {
        const value = at(result, path);
        assert.notEqual(value, at(data, path));
        assert.equal(Object.getPrototypeOf(value), Object.prototype);
        assert.ok(Object.isFrozen(value));
    }
    for (const { path } of dictionaries) assert.deepEqual(at(result, path), at(data, path));
    data.native.callsites['js-failed'] = 0;
    data.native.callsites['js-passed'] = 1;
    data.native.lastValidationBoundaries.write = 0;
    data.native.lastValidationBoundaries.final = 1;
    data.native.admittedReportPhases['fixture-failed'] = 0;
    data.native.admittedReportPhases['fixture-complete'] = 1;
    data.javascript.failurePhases['proof-captured'] = 0;
    data.javascript.failurePhases['await-closure-ack'] = 1;
    assert.equal(result.native.callsite, 'js-failed');
    assert.equal(result.native.callsites['js-failed'], 1);
    assert.equal(result.native.lastValidationBoundary, 'write');
    assert.equal(result.native.lastValidationBoundaries.write, 1);
    assert.equal(result.native.admittedReportPhase, 'fixture-failed');
    assert.equal(result.native.admittedReportPhases['fixture-failed'], 1);
    assert.equal(result.javascript.failurePhase, 'proof-captured');
    assert.equal(result.javascript.failurePhases['proof-captured'], 1);
    const updated = inspect(data);
    assert.equal(updated.native.callsite, 'js-passed');
    assert.equal(updated.native.lastValidationBoundary, 'final');
    assert.equal(updated.native.admittedReportPhase, 'fixture-complete');
    assert.equal(updated.javascript.failurePhase, 'await-closure-ack');
    assert.throws(() => {
        result.native.callsites['js-failed'] = 0;
    }, TypeError);
    assert.throws(() => {
        result.javascript.failurePhases['proof-captured'] = 0;
    }, TypeError);
    assert.throws(() => {
        result.native.callsite = 'js-passed';
    }, TypeError);
    assertNoProof(result);
    assertNoProof(updated);
});

test('synthetic null-prototype inputs are copied into frozen plain output objects', () => {
    let data = selectedInput();
    for (const { path } of [...scopes].reverse()) {
        data = replace(data, path, Object.assign(Object.create(null), at(data, path)));
    }
    const result = inspect(data);
    for (const { path } of scopes) {
        assert.equal(Object.getPrototypeOf(at(data, path)), null);
        assert.equal(Object.getPrototypeOf(at(result, path)), Object.prototype);
        assert.ok(Object.isFrozen(at(result, path)));
    }
    assertNoProof(result);
});

test('synthetic parser does not mutate an entirely frozen input tree', () => {
    const data = selectedInput();
    const before = JSON.stringify(data);
    for (const { path } of [...scopes].reverse()) Object.freeze(at(data, path));
    const result = inspect(data);
    assert.equal(JSON.stringify(data), before);
    for (const { path } of scopes) {
        assert.ok(Object.isFrozen(at(data, path)));
        assert.notEqual(at(result, path), at(data, path));
    }
    assertNoProof(result);
});

for (const { path, keys } of scopes) {
    const label = path.length === 0 ? 'diagnostic' : path.join('.');
    test(`synthetic ${label} refuses nonobjects, arrays and custom prototypes`, () => {
        for (const invalid of [null, undefined, [], 0, 1, 'data', true]) {
            assert.throws(() => inspect(replace(selectedInput(), path, invalid)));
        }
        for (const prototype of [{}, Array.prototype, Date.prototype]) {
            const data = selectedInput();
            Object.setPrototypeOf(at(data, path), prototype);
            assert.throws(() => inspect(data));
        }
    });
    test(`synthetic ${label} refuses extra string, symbol and nonenumerable properties`, () => {
        for (const extra of [
            'unknown',
            'account',
            'credential',
            'message',
            'error',
            'path',
            '__proto__',
            Symbol('extra'),
        ]) {
            const data = selectedInput();
            Object.defineProperty(at(data, path), extra, { enumerable: true, value: 'synthetic' });
            assert.throws(() => inspect(data));
        }
        const data = selectedInput();
        Object.defineProperty(at(data, path), 'hiddenExtra', { enumerable: false, value: 0 });
        assert.throws(() => inspect(data));
    });
    test(`synthetic ${label} refuses prototype getters without evaluating them`, () => {
        let reads = 0;
        const data = selectedInput();
        const prototype = Object.create(Object.prototype, {
            diagnosticSecret: {
                get() {
                    reads++;
                    throw new Error('must not read inherited getter');
                },
            },
        });
        Object.setPrototypeOf(at(data, path), prototype);
        assert.throws(() => inspect(data));
        assert.equal(reads, 0);
    });
    for (const key of keys) {
        test(`synthetic ${label} refuses missing or undefined own field ${key}`, () => {
            const missing = selectedInput();
            delete at(missing, path)[key];
            assert.throws(() => inspect(missing));
            const undefinedValue = selectedInput();
            at(undefinedValue, path)[key] = undefined;
            assert.throws(() => inspect(undefinedValue));
        });
        test(`synthetic ${label} refuses accessor or hidden field ${key} without evaluating it`, () => {
            let reads = 0;
            const accessor = selectedInput();
            Object.defineProperty(at(accessor, path), key, {
                enumerable: true,
                get() {
                    reads++;
                    throw new Error('must not read accessor');
                },
            });
            assert.throws(() => inspect(accessor));
            assert.equal(reads, 0);
            let writes = 0;
            const setter = selectedInput();
            Object.defineProperty(at(setter, path), key, {
                enumerable: true,
                set() {
                    writes++;
                },
            });
            assert.throws(() => inspect(setter));
            assert.equal(writes, 0);
            const hidden = selectedInput();
            Object.defineProperty(at(hidden, path), key, { enumerable: false });
            assert.throws(() => inspect(hidden));
        });
    }
}

test('synthetic inherited replacement fields cannot complete a thin shape', () => {
    let reads = 0;
    const data = selectedInput();
    const prototype = Object.create(Object.prototype, {
        selectedFinishes: {
            enumerable: true,
            get() {
                reads++;
                return 1;
            },
        },
    });
    delete data.native.selectedFinishes;
    Object.setPrototypeOf(data.native, prototype);
    assert.throws(() => inspect(data));
    assert.equal(reads, 0);
});

for (const [field, invalidValues] of [
    ['version', [0, 2, '1', true, null]],
    ['kind', ['', 'first-inbox-stage-diagnostic', 1, null]],
    ['acceptanceEvidence', [true, 0, 1, 'false', null]],
])
    test(`synthetic refuses corrupted fixed field ${field}`, () => {
        for (const invalid of invalidValues) {
            const data = selectedInput();
            data[field] = invalid;
            assert.throws(() => inspect(data));
        }
    });

for (const [channel, selector] of [
    ['native', 'selectedFinishes'],
    ['javascript', 'selectedFailures'],
])
    test(`synthetic ${channel} selection counter is exactly numeric zero or one`, () => {
        for (const invalid of [-1, 2, 0.5, true, false, null, undefined, '1', NaN, Infinity, -Infinity, {}]) {
            const data = selectedInput();
            data[channel][selector] = invalid;
            assert.throws(() => inspect(data));
        }
    });

for (const { path, names, channel, selector } of dictionaries) {
    const label = path.join('.');
    test(`synthetic ${label} marker values are exactly numeric zero or one`, () => {
        for (const invalid of [-1, 2, 0.5, true, false, null, undefined, '1', NaN, Infinity, -Infinity, {}]) {
            const data = selectedInput();
            at(data, path)[names[0]] = invalid;
            assert.throws(() => inspect(data));
        }
    });
    test(`synthetic ${label} refuses missing selection, duplicates and unselected facts`, () => {
        const missing = selectedInput();
        for (const name of names) at(missing, path)[name] = 0;
        assert.throws(() => inspect(missing));
        const duplicate = selectedInput();
        at(duplicate, path)[names.find((name) => at(duplicate, path)[name] === 0)] = 1;
        assert.throws(() => inspect(duplicate));
        const unselected = input();
        at(unselected, path)[names[0]] = 1;
        assert.equal(unselected[channel][selector], 0);
        assert.throws(() => inspect(unselected));
    });
}

test('synthetic unselected channels refuse populated dictionaries even when the other channel is selected', () => {
    for (const { path, names, channel } of dictionaries) {
        const data = input({
            nativeSelected: channel === 'native' ? 0 : 1,
            javascriptSelected: channel === 'javascript' ? 0 : 1,
        });
        at(data, path)[names[0]] = 1;
        assert.throws(() => inspect(data));
    }
});

test('synthetic channel vocabularies cannot be substituted across boundaries', () => {
    for (const [path, badName] of [
        [['native', 'callsites'], 'none'],
        [['native', 'lastValidationBoundaries'], 'await-foreground'],
        [['native', 'admittedReportPhases'], 'authenticated'],
        [['javascript', 'failurePhases'], 'fixture-failed'],
    ]) {
        const data = selectedInput();
        at(data, path)[badName] = 1;
        assert.throws(() => inspect(data));
    }
});

test('synthetic thin empty objects are unavailable and cannot supply a default pass', () => {
    for (const { path } of scopes) assert.throws(() => inspect(replace(selectedInput(), path, {})));
});
