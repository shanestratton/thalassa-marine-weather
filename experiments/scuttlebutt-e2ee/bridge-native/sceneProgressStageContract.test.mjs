// Synthetic value contracts only. No native permission, JavaScript
// consumption, cryptography, app or operating-system acceptance is established.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import {
    SCENE_PROGRESS_MAXIMUM_ENTRIES,
    SCENE_PROGRESS_JAVASCRIPT_PHASE_NAMES,
    inspectSceneProgressStageEvidence as inspect,
} from './sceneProgressStageContract.mjs';
import { SCENE_FINISH_JAVASCRIPT_FAILURE_PHASE_NAMES } from './sceneFinishStageContract.mjs';

// Independent literals catch a dropped/added phase or a broadened bound.
const phases = [
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
const domFields = [
    'sendPresent',
    'sendEnabled',
    'composePresent',
    'composeEmpty',
    'composeDisabled',
    'composeReadOnly',
];
const entryFields = ['sequence', 'phase', ...domFields];
const fields = ['version', 'kind', 'entries', 'acceptanceEvidence'];
const row = (sequence = 1, phase = 'cold-ready', dom = {}) => ({
    sequence,
    phase,
    sendPresent: null,
    sendEnabled: null,
    composePresent: null,
    composeEmpty: null,
    composeDisabled: null,
    composeReadOnly: null,
    ...dom,
});
const input = (entries = []) => ({
    version: 1,
    kind: 'scene-progress-stage-diagnostic',
    entries,
    acceptanceEvidence: false,
});
const selectedInput = () => input([row()]);
const at = (data, path) => path.reduce((value, key) => value[key], data);
const replace = (data, path, value) => {
    if (path.length === 0) return value;
    at(data, path.slice(0, -1))[path.at(-1)] = value;
    return data;
};
const scopes = [
    { path: [], keys: fields },
    { path: ['entries', 0], keys: entryFields },
];
const assertPassive = (result) => {
    assert.equal(result.acceptanceEvidence, false);
    assert.deepEqual(Reflect.ownKeys(result).sort(), [...fields].sort());
    for (const value of [result, ...result.entries]) {
        for (const forbidden of ['status', 'passed', 'completed', 'failed', 'nativePermissionGranted'])
            assert.equal(Object.hasOwn(value, forbidden), false);
    }
};

test('synthetic progress vocabulary is exact and separate from the failure array', () => {
    assert.equal(SCENE_PROGRESS_MAXIMUM_ENTRIES, 64);
    assert.deepEqual(SCENE_PROGRESS_JAVASCRIPT_PHASE_NAMES, phases);
    assert.equal(SCENE_PROGRESS_JAVASCRIPT_PHASE_NAMES.length, 23);
    assert.equal(new Set(phases).size, 23);
    assert.ok(Object.isFrozen(SCENE_PROGRESS_JAVASCRIPT_PHASE_NAMES));
    assert.deepEqual(SCENE_PROGRESS_JAVASCRIPT_PHASE_NAMES, SCENE_FINISH_JAVASCRIPT_FAILURE_PHASE_NAMES);
    assert.notEqual(SCENE_PROGRESS_JAVASCRIPT_PHASE_NAMES, SCENE_FINISH_JAVASCRIPT_FAILURE_PHASE_NAMES);
});

test('synthetic empty progress contains no invented stage or acceptance', () => {
    const result = inspect(input());
    assert.deepEqual(result, input());
    assert.ok(Object.isFrozen(result));
    assert.ok(Object.isFrozen(result.entries));
    assertPassive(result);
});

for (const phase of phases)
    test(`synthetic phase ${phase} names only the current stage`, () => {
        const data = input([row(1, phase)]);
        const result = inspect(data);
        assert.deepEqual(result, data);
        assert.deepEqual(Reflect.ownKeys(result.entries[0]).sort(), [...entryFields].sort());
        assertPassive(result);
    });

test('synthetic progress preserves all 64 ordered snapshots including repeated phases', () => {
    const entries = Array.from({ length: 64 }, (_, index) =>
        row(index + 1, 'send-enabled', {
            sendPresent: true,
            sendEnabled: index % 2 === 0,
            composePresent: true,
            composeEmpty: index % 3 === 0,
            composeDisabled: index % 2 === 1,
            composeReadOnly: index % 4 === 0,
        }),
    );
    const result = inspect(input(entries));
    assert.deepEqual(result.entries, entries);
    assert.equal(result.entries.length, 64);
    assertPassive(result);
});

test('synthetic maximum valid JSON fits the private 16384-byte diagnostic bound', () => {
    const longestPhase = phases.reduce((longest, phase) => (phase.length > longest.length ? phase : longest));
    const data = input(
        Array.from({ length: 64 }, (_, index) =>
            row(index + 1, longestPhase, {
                sendPresent: true,
                sendEnabled: false,
                composePresent: true,
                composeEmpty: false,
                composeDisabled: false,
                composeReadOnly: false,
            }),
        ),
    );
    const result = inspect(data);
    const bytes = Buffer.byteLength(JSON.stringify(result));
    assert.ok(bytes > 0 && bytes <= 16384, `bounded maximum JSON bytes: ${bytes}`);
    assertPassive(result);
});

test('synthetic parsed tree is an exact frozen detached copy', () => {
    const data = input([
        row(1, 'thread-open', {
            sendPresent: true,
            sendEnabled: false,
            composePresent: true,
            composeEmpty: true,
            composeDisabled: false,
            composeReadOnly: true,
        }),
    ]);
    const result = inspect(data);
    for (const value of [result, result.entries, ...result.entries]) assert.ok(Object.isFrozen(value));
    assert.notEqual(result, data);
    assert.notEqual(result.entries, data.entries);
    assert.notEqual(result.entries[0], data.entries[0]);
    data.entries[0].phase = 'send-enabled';
    data.entries[0].sendEnabled = true;
    data.entries.push(row(2));
    assert.equal(result.entries.length, 1);
    assert.equal(result.entries[0].phase, 'thread-open');
    assert.equal(result.entries[0].sendEnabled, false);
    assert.throws(() => {
        result.entries[0].phase = 'send-enabled';
    }, TypeError);
    assert.throws(() => {
        result.entries.push(row(2));
    }, TypeError);
    assertPassive(result);
});

test('synthetic frozen input is untouched and repeated inspection adds no evidence', () => {
    const data = selectedInput();
    const before = JSON.stringify(data);
    Object.freeze(data.entries[0]);
    Object.freeze(data.entries);
    Object.freeze(data);
    const first = inspect(data);
    const second = inspect(data);
    assert.equal(JSON.stringify(data), before);
    assert.deepEqual(first, second);
    assert.notEqual(first, second);
    assert.notEqual(first.entries[0], second.entries[0]);
    assertPassive(first);
    assertPassive(second);
});

test('synthetic null-prototype object rows become ordinary frozen value copies', () => {
    const data = Object.assign(Object.create(null), selectedInput());
    data.entries[0] = Object.assign(Object.create(null), data.entries[0]);
    const result = inspect(data);
    assert.equal(Object.getPrototypeOf(result), Object.prototype);
    assert.equal(Object.getPrototypeOf(result.entries[0]), Object.prototype);
    assert.ok(Object.isFrozen(result.entries[0]));
});

test('synthetic nullable booleans retain unknown, absent and present facts without coercion', () => {
    for (const sendPresent of [null, false, true]) {
        for (const composePresent of [null, false, true]) {
            const result = inspect(input([row(1, 'thread-open', { sendPresent, composePresent })]));
            assert.equal(result.entries[0].sendPresent, sendPresent);
            assert.equal(result.entries[0].composePresent, composePresent);
        }
    }
    for (const fact of domFields) {
        for (const value of [null, false, true]) {
            const dom = { sendPresent: true, composePresent: true, [fact]: value };
            if (fact === 'sendPresent') dom.sendEnabled = null;
            const result = inspect(input([row(1, 'thread-open', dom)]));
            assert.equal(result.entries[0][fact], value);
        }
    }
});

for (const fact of domFields)
    test(`synthetic DOM fact ${fact} refuses every nonnullable-boolean representation`, () => {
        for (const invalid of [undefined, 0, 1, -1, 'true', 'false', '', [], {}, new Boolean(true), NaN, Infinity]) {
            const data = input([row(1, 'thread-open', { sendPresent: true, composePresent: true, [fact]: invalid })]);
            const before = structuredClone(data);
            assert.throws(() => inspect(data));
            assert.deepEqual(data, before);
        }
    });

test('synthetic absent or unknown elements cannot supply child DOM facts', () => {
    for (const sendPresent of [null, false]) {
        for (const sendEnabled of [true, false])
            assert.throws(() => inspect(input([row(1, 'send-enabled', { sendPresent, sendEnabled })])));
    }
    for (const composePresent of [null, false]) {
        for (const fact of ['composeEmpty', 'composeDisabled', 'composeReadOnly']) {
            for (const value of [true, false])
                assert.throws(() => inspect(input([row(1, 'thread-open', { composePresent, [fact]: value })])));
        }
    }
});

test('synthetic contiguous sequence requires integer one through 64 with no gaps or duplicates', () => {
    for (const invalid of [0, -1, 2, 65, 0.5, null, undefined, true, false, '1', NaN, Infinity, -Infinity, {}]) {
        const data = selectedInput();
        data.entries[0].sequence = invalid; // Preserve explicit undefined; factory defaults must not mask it.
        assert.throws(() => inspect(data));
    }
    for (const sequences of [
        [1, 1],
        [1, 3],
        [2, 1],
        [1, 2, 2],
        [1, 2, 4],
    ]) {
        const data = input(sequences.map((sequence) => row(sequence)));
        const before = structuredClone(data);
        assert.throws(() => inspect(data));
        assert.deepEqual(data, before);
    }
    assert.throws(() => inspect(input(Array.from({ length: 65 }, (_, index) => row(index + 1)))));
});

test('synthetic phases refuse arbitrary names and value objects with no coercion or leak', () => {
    let coercions = 0;
    const canary = 'scene-progress-private-canary';
    const object = {
        toString() {
            coercions++;
            return 'cold-ready';
        },
    };
    for (const invalid of [
        canary,
        '',
        'none',
        'fixture-complete',
        'COLD-READY',
        'cold-ready\n',
        'x'.repeat(49),
        null,
        undefined,
        1,
        true,
        new String('cold-ready'),
        object,
    ]) {
        const data = selectedInput();
        data.entries[0].phase = invalid;
        assert.throws(
            () => inspect(data),
            (error) => !error.message.includes(canary),
        );
    }
    assert.equal(coercions, 0);
});

for (const { path, keys } of scopes) {
    const label = path.length === 0 ? 'diagnostic' : 'entry';
    test(`synthetic ${label} refuses nonobjects and custom prototypes`, () => {
        for (const invalid of [null, undefined, [], 0, 'data', true])
            assert.throws(() => inspect(replace(selectedInput(), path, invalid)));
        for (const prototype of [{}, Array.prototype, Date.prototype]) {
            const data = selectedInput();
            Object.setPrototypeOf(at(data, path), prototype);
            assert.throws(() => inspect(data));
        }
    });
    test(`synthetic ${label} refuses extra fields, symbols and hidden data`, () => {
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
            Object.defineProperty(at(data, path), extra, { enumerable: true, value: 'private-canary' });
            assert.throws(() => inspect(data));
        }
        const data = selectedInput();
        Object.defineProperty(at(data, path), 'hidden', { value: false });
        assert.throws(() => inspect(data));
    });
    for (const key of keys) {
        test(`synthetic ${label} refuses missing, hidden or accessor field ${key} without reading`, () => {
            const missing = selectedInput();
            delete at(missing, path)[key];
            assert.throws(() => inspect(missing));
            const hidden = selectedInput();
            Object.defineProperty(at(hidden, path), key, { enumerable: false });
            assert.throws(() => inspect(hidden));
            let reads = 0;
            const getter = selectedInput();
            Object.defineProperty(at(getter, path), key, {
                enumerable: true,
                get() {
                    reads++;
                    throw Error('must not read accessor');
                },
            });
            assert.throws(() => inspect(getter));
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
        });
    }
    test(`synthetic ${label} refuses inherited replacement fields without reading`, () => {
        let reads = 0;
        const data = selectedInput();
        const prototype = Object.create(Object.prototype, {
            [keys[0]]: {
                enumerable: true,
                get() {
                    reads++;
                    return 1;
                },
            },
        });
        delete at(data, path)[keys[0]];
        Object.setPrototypeOf(at(data, path), prototype);
        assert.throws(() => inspect(data));
        assert.equal(reads, 0);
    });
}

test('synthetic entries require a bounded dense plain array without fields or accessors', () => {
    for (const invalid of [null, undefined, {}, 0, 'data', true, Object.create(Array.prototype)]) {
        const data = selectedInput();
        data.entries = invalid;
        assert.throws(() => inspect(data));
    }
    for (const prototype of [null, {}, Object.create(Array.prototype)]) {
        const entries = [row()];
        Object.setPrototypeOf(entries, prototype);
        assert.throws(() => inspect(input(entries)));
    }
    for (const extra of ['account', 'error', '__proto__', Symbol('extra')]) {
        const entries = [row()];
        Object.defineProperty(entries, extra, { enumerable: true, value: 'private-canary' });
        assert.throws(() => inspect(input(entries)));
    }
    const hidden = [row()];
    Object.defineProperty(hidden, 'hidden', { value: false });
    assert.throws(() => inspect(input(hidden)));
    assert.throws(() => inspect(input(new Array(1))));
    const sparse = [row(), row(2)];
    delete sparse[0];
    assert.throws(() => inspect(input(sparse)));
    let reads = 0;
    const getter = [row()];
    Object.defineProperty(getter, '0', {
        enumerable: true,
        get() {
            reads++;
            return row();
        },
    });
    assert.throws(() => inspect(input(getter)));
    assert.equal(reads, 0);
    const hiddenEntry = [row()];
    Object.defineProperty(hiddenEntry, '0', { enumerable: false });
    assert.throws(() => inspect(input(hiddenEntry)));
});

for (const [field, invalidValues] of [
    ['version', [0, 2, '1', true, null, undefined]],
    ['kind', ['', 'scene-finish-stage-diagnostic', 'scene-progress-stage-diagnostic\n', 1, null, undefined]],
    ['acceptanceEvidence', [true, 0, 1, 'false', null, undefined]],
])
    test(`synthetic fixed classification ${field} cannot grant acceptance or default`, () => {
        for (const invalid of invalidValues) {
            const data = selectedInput();
            data[field] = invalid;
            assert.throws(() => inspect(data));
        }
    });
