import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import test from 'node:test';
import {
    inspectSceneAuthorityTimingEvidence,
    SCENE_AUTHORITY_TIMING_MAXIMUM_BYTES,
    SCENE_AUTHORITY_TIMING_MAXIMUM_ENTRIES,
} from './sceneAuthorityTimingContract.mjs';

const refusal = 'Scene authority timing evidence refused.';
const pin = Object.freeze({
    runID: '11111111-1111-4111-8111-111111111111',
    nonce: '2'.repeat(64),
    resourceSHA256: 'a'.repeat(64),
    pid: 12345,
    epoch: '33333333-3333-4333-8333-333333333333',
});
const buckets = ['lt-1s', '1s-to-lt-10s', '10s-to-lt-30s', '30s-to-lt-60s', '60s-to-lt-120s', 'ge-120s'];
const phases = [
    'verify-completed',
    'original-captured',
    'original-rechecked',
    'protected-setup',
    'peer-reply',
    'proof-captured',
    'protected-report',
    'authority-observed',
    'authority-unavailable',
    'original-cleared',
];

function entry(sequence, phase, overrides = {}) {
    return {
        sequence,
        phase,
        sinceFirstVerify: 'unobserved',
        sinceOriginalCapture: 'unobserved',
        fenceAttempts: null,
        verifyCompletions: null,
        facadeObserved: false,
        originalObserved: false,
        accountPresent: null,
        originalCurrent: null,
        ...overrides,
    };
}

function evidence(entries = []) {
    return {
        version: 1,
        kind: 'research-scene-authority-timing-observations',
        runID: pin.runID,
        nonce: pin.nonce,
        resourceSHA256: pin.resourceSHA256,
        process: { pid: pin.pid, epoch: pin.epoch },
        timing: {
            version: 1,
            kind: 'scene-authority-timing-diagnostic',
            evidenceCategory: 'synthetic-direct-calls',
            status: 'recording',
            entries,
            acceptanceEvidence: false,
            authorityMutated: false,
        },
        acceptanceEvidence: false,
        authorityMutated: false,
    };
}

function observedEntries() {
    return [
        entry(1, 'verify-completed', {
            sinceFirstVerify: 'lt-1s',
            fenceAttempts: 1,
            verifyCompletions: 1,
            facadeObserved: true,
        }),
        entry(2, 'original-captured', {
            sinceFirstVerify: '1s-to-lt-10s',
            sinceOriginalCapture: 'lt-1s',
            facadeObserved: true,
            originalObserved: true,
        }),
        entry(3, 'authority-observed', {
            sinceFirstVerify: '10s-to-lt-30s',
            sinceOriginalCapture: '1s-to-lt-10s',
            fenceAttempts: 1,
            verifyCompletions: 1,
            facadeObserved: true,
            originalObserved: true,
            accountPresent: false,
            originalCurrent: false,
        }),
    ];
}

function expectRefused(raw, ...bindings) {
    const expected = bindings.length === 0 ? pin : bindings[0];
    assert.throws(
        () => inspectSceneAuthorityTimingEvidence(raw, expected),
        (error) => {
            assert.equal(error.constructor, Error);
            assert.equal(error.message, refusal);
            assert.equal(error.cause, undefined);
            assert.deepEqual(Object.keys(error), []);
            return true;
        },
    );
}

test('admits only detached passive observations, with exact private bindings retained', () => {
    const raw = evidence(observedEntries());
    const result = inspectSceneAuthorityTimingEvidence(raw, pin);
    assert.deepEqual(result, raw);
    assert.notEqual(result, raw);
    assert.notEqual(result.process, raw.process);
    assert.notEqual(result.timing, raw.timing);
    assert.notEqual(result.timing.entries, raw.timing.entries);
    assert.notEqual(result.timing.entries[0], raw.timing.entries[0]);
    assert.deepEqual(Object.keys(result), [
        'version',
        'kind',
        'runID',
        'nonce',
        'resourceSHA256',
        'process',
        'timing',
        'acceptanceEvidence',
        'authorityMutated',
    ]);
    assert.deepEqual(Object.keys(result.process), ['pid', 'epoch']);
    assert.deepEqual(Object.keys(result.timing), [
        'version',
        'kind',
        'evidenceCategory',
        'status',
        'entries',
        'acceptanceEvidence',
        'authorityMutated',
    ]);
    assert.equal(result.acceptanceEvidence, false);
    assert.equal(result.authorityMutated, false);
    assert.equal(result.timing.acceptanceEvidence, false);
    assert.equal(result.timing.authorityMutated, false);
    for (const name of ['accepted', 'passed', 'permission', 'expired', 'osProof', 'recovered'])
        assert.equal(Object.hasOwn(result, name), false);
});

test('deep freezes every result object without freezing or retaining input objects', () => {
    const raw = evidence(observedEntries());
    const result = inspectSceneAuthorityTimingEvidence(raw, pin);
    for (const value of [result, result.process, result.timing, result.timing.entries, ...result.timing.entries])
        assert.equal(Object.isFrozen(value), true);
    assert.equal(Object.isFrozen(raw), false);
    assert.equal(Object.isFrozen(raw.timing.entries[0]), false);
    raw.process.pid = 7;
    raw.timing.entries[0].fenceAttempts = 999;
    raw.timing.entries.push(entry(4, 'authority-unavailable'));
    assert.equal(result.process.pid, pin.pid);
    assert.equal(result.timing.entries[0].fenceAttempts, 1);
    assert.equal(result.timing.entries.length, 3);
    assert.throws(() => {
        result.process.pid = 7;
    }, TypeError);
    assert.throws(() => {
        result.timing.entries[0].accountPresent = true;
    }, TypeError);
    assert.throws(() => {
        result.timing.entries.push(entry(4, 'authority-unavailable'));
    }, TypeError);
});

test('retains native and synthetic categories distinctly and never upgrades either into acceptance', () => {
    for (const evidenceCategory of ['simulator-native-observations', 'synthetic-direct-calls']) {
        for (const status of ['recording', 'capacity-refused', 'clock-refused', 'input-refused']) {
            const raw = evidence();
            raw.timing.evidenceCategory = evidenceCategory;
            raw.timing.status = status;
            const result = inspectSceneAuthorityTimingEvidence(raw, pin);
            assert.equal(result.timing.evidenceCategory, evidenceCategory);
            assert.equal(result.timing.status, status);
            assert.equal(result.acceptanceEvidence, false);
            assert.equal(result.timing.acceptanceEvidence, false);
            assert.equal(result.authorityMutated, false);
        }
    }
});

test('refuses wrong classification, unknown enum values and non-false evidence flags', () => {
    for (const select of [(raw) => raw, (raw) => raw.timing]) {
        for (const name of ['version', 'kind', 'acceptanceEvidence', 'authorityMutated']) {
            for (const value of [undefined, null, true, 'false', 0, 2]) {
                const raw = evidence();
                select(raw)[name] = value;
                expectRefused(raw);
            }
        }
    }
    for (const name of ['evidenceCategory', 'status']) {
        for (const value of [undefined, null, false, 1, {}, 'native', 'passed', 'recording\n']) {
            const raw = evidence();
            raw.timing[name] = value;
            expectRefused(raw);
        }
    }
});

test('refuses unknown, missing, non-enumerable, accessor and symbol fields at every object boundary', () => {
    const selects = [(raw) => raw, (raw) => raw.process, (raw) => raw.timing, (raw) => raw.timing.entries[0]];
    for (const select of selects) {
        let getterCalls = 0;
        for (const change of [
            (object) => {
                object.unknown = 'private-canary';
            },
            (object) => {
                object[Symbol('private-canary')] = true;
            },
            (object) => {
                delete object[Object.keys(object)[0]];
            },
            (object) => {
                Object.defineProperty(object, Object.keys(object)[0], { enumerable: false });
            },
            (object) => {
                Object.defineProperty(object, Object.keys(object)[0], {
                    enumerable: true,
                    get() {
                        getterCalls++;
                        throw Error('private-canary');
                    },
                });
            },
        ]) {
            const raw = evidence([entry(1, 'authority-unavailable')]);
            change(select(raw));
            expectRefused(raw);
        }
        assert.equal(getterCalls, 0);
    }
});

test('allows null-prototype data records but refuses inherited/custom object shapes', () => {
    const raw = evidence([entry(1, 'authority-unavailable')]);
    for (const object of [raw, raw.process, raw.timing, raw.timing.entries[0]]) Object.setPrototypeOf(object, null);
    const expected = Object.assign(Object.create(null), pin);
    assert.equal(inspectSceneAuthorityTimingEvidence(raw, expected).process.pid, pin.pid);
    for (const select of [
        (value) => value,
        (value) => value.process,
        (value) => value.timing,
        (value) => value.timing.entries[0],
    ]) {
        const bad = evidence([entry(1, 'authority-unavailable')]);
        Object.setPrototypeOf(select(bad), { privateCanary: true });
        expectRefused(bad);
    }
    for (const value of [undefined, null, false, 1, 'private-canary', [], new Date()]) expectRefused(value);
});

test('refuses non-record process, timing and entry values without coercion', () => {
    for (const value of [undefined, null, false, 1, 'private-canary', [], new Date()]) {
        for (const name of ['process', 'timing']) {
            const raw = evidence();
            raw[name] = value;
            expectRefused(raw);
        }
        expectRefused(evidence([value]));
    }
});

test('requires exact canonical pins and rejects replay from any other run, resource or process', () => {
    const replacements = {
        runID: '44444444-4444-4444-8444-444444444444',
        nonce: '5'.repeat(64),
        resourceSHA256: 'b'.repeat(64),
        pid: 54321,
        epoch: '66666666-6666-4666-8666-666666666666',
    };
    for (const [name, value] of Object.entries(replacements)) {
        expectRefused(evidence(), { ...pin, [name]: value });
        const raw = evidence();
        (name === 'pid' || name === 'epoch' ? raw.process : raw)[name] = value;
        expectRefused(raw);
    }
    for (const name of ['runID', 'epoch']) {
        for (const value of [
            undefined,
            null,
            1,
            {},
            'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
            `${pin[name]}\n`,
            pin[name].slice(1),
            'not-a-uuid',
        ]) {
            expectRefused(evidence(), { ...pin, [name]: value });
            const raw = evidence();
            (name === 'epoch' ? raw.process : raw)[name] = value;
            expectRefused(raw);
        }
    }
    for (const name of ['nonce', 'resourceSHA256']) {
        for (const value of [
            undefined,
            null,
            1,
            {},
            'A'.repeat(64),
            `${pin[name]}\n`,
            'a'.repeat(63),
            'g'.repeat(64),
        ]) {
            expectRefused(evidence(), { ...pin, [name]: value });
            const raw = evidence();
            raw[name] = value;
            expectRefused(raw);
        }
    }
    for (const value of [undefined, null, false, '12345', 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        expectRefused(evidence(), { ...pin, pid: value });
        const raw = evidence();
        raw.process.pid = value;
        expectRefused(raw);
    }
    const largest = evidence();
    largest.process.pid = Number.MAX_SAFE_INTEGER;
    assert.equal(
        inspectSceneAuthorityTimingEvidence(largest, { ...pin, pid: Number.MAX_SAFE_INTEGER }).process.pid,
        Number.MAX_SAFE_INTEGER,
    );
});

test('pin descriptors also refuse getters, symbols, missing/unknown fields and custom prototypes', () => {
    let getterCalls = 0;
    for (const change of [
        (expected) => {
            expected.unknown = true;
        },
        (expected) => {
            expected[Symbol('private-canary')] = true;
        },
        (expected) => {
            delete expected.nonce;
        },
        (expected) => {
            Object.defineProperty(expected, 'nonce', { enumerable: false });
        },
        (expected) => {
            Object.defineProperty(expected, 'nonce', {
                enumerable: true,
                get() {
                    getterCalls++;
                    throw Error('private-canary');
                },
            });
        },
        (expected) => {
            Object.setPrototypeOf(expected, {});
        },
    ]) {
        const expected = { ...pin };
        change(expected);
        expectRefused(evidence(), expected);
    }
    assert.equal(getterCalls, 0);
    for (const expected of [undefined, null, false, [], 'private-canary']) expectRefused(evidence(), expected);
});

test('requires dense plain arrays with contiguous one-based sequences, at most 32 entries', () => {
    assert.equal(SCENE_AUTHORITY_TIMING_MAXIMUM_ENTRIES, 32);
    const full = evidence(Array.from({ length: 32 }, (_, index) => entry(index + 1, 'authority-unavailable')));
    assert.equal(inspectSceneAuthorityTimingEvidence(full, pin).timing.entries.length, 32);
    expectRefused(evidence(Array.from({ length: 33 }, (_, index) => entry(index + 1, 'authority-unavailable'))));
    let getterCalls = 0;
    for (const change of [
        (entries) => {
            delete entries[0];
        },
        (entries) => {
            entries.extra = true;
        },
        (entries) => {
            entries[Symbol('private-canary')] = true;
        },
        (entries) => {
            Object.setPrototypeOf(entries, null);
        },
        (entries) => {
            Object.defineProperty(entries, '0', { enumerable: false });
        },
        (entries) => {
            Object.defineProperty(entries, '0', {
                enumerable: true,
                get() {
                    getterCalls++;
                    throw Error('private-canary');
                },
            });
        },
    ]) {
        const raw = evidence([entry(1, 'authority-unavailable')]);
        change(raw.timing.entries);
        expectRefused(raw);
    }
    assert.equal(getterCalls, 0);
    for (const entries of [undefined, null, {}, 'private-canary', new Set()]) {
        const raw = evidence();
        raw.timing.entries = entries;
        expectRefused(raw);
    }
    for (const value of [undefined, null, false, '1', 0, -1, 2, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
        expectRefused(evidence([entry(value, 'authority-unavailable')]));
    expectRefused(evidence([entry(1, 'authority-unavailable'), entry(1, 'authority-unavailable')]));
    expectRefused(evidence([entry(1, 'authority-unavailable'), entry(3, 'authority-unavailable')]));
});

test('admits only fixed phases and correctly typed bounded counters and observation facts', () => {
    for (const phase of phases) {
        const overrides = {};
        if (phase === 'verify-completed')
            Object.assign(overrides, {
                sinceFirstVerify: 'lt-1s',
                facadeObserved: true,
                verifyCompletions: 1,
            });
        if (phase === 'original-captured')
            Object.assign(overrides, {
                sinceOriginalCapture: 'lt-1s',
                facadeObserved: true,
                originalObserved: true,
            });
        if (phase === 'authority-observed') Object.assign(overrides, { facadeObserved: true, accountPresent: false });
        assert.equal(
            inspectSceneAuthorityTimingEvidence(evidence([entry(1, phase, overrides)]), pin).timing.entries[0].phase,
            phase,
        );
    }
    for (const phase of [undefined, null, false, 1, {}, 'expired', 'scene-accepted', 'authority-observed\n'])
        expectRefused(evidence([entry(1, phase)]));
    for (const name of ['fenceAttempts', 'verifyCompletions']) {
        for (const value of [null, 0, 10_000]) {
            const raw = evidence([entry(1, 'authority-unavailable', { [name]: value })]);
            assert.equal(inspectSceneAuthorityTimingEvidence(raw, pin).timing.entries[0][name], value);
        }
        for (const value of [undefined, true, '1', -1, 10_001, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
            expectRefused(evidence([entry(1, 'authority-unavailable', { [name]: value })]));
    }
    for (const name of ['facadeObserved', 'originalObserved']) {
        for (const value of [undefined, null, 'false', 0, 1, {}])
            expectRefused(evidence([entry(1, 'authority-unavailable', { [name]: value })]));
    }
    for (const name of ['accountPresent', 'originalCurrent']) {
        for (const value of [undefined, 'false', 0, 1, {}])
            expectRefused(evidence([entry(1, 'authority-unavailable', { [name]: value })]));
    }
});

test('requires original observation for current facts and complete authority-observed BOOL facts', () => {
    for (const originalCurrent of [true, false]) {
        expectRefused(evidence([entry(1, 'protected-report', { originalCurrent })]));
        expectRefused(evidence([entry(1, 'authority-observed', { accountPresent: true, originalCurrent })]));
    }
    for (const accountPresent of [true, false]) {
        assert.equal(
            inspectSceneAuthorityTimingEvidence(
                evidence([entry(1, 'authority-observed', { facadeObserved: true, accountPresent })]),
                pin,
            ).timing.entries[0].originalCurrent,
            null,
        );
        for (const originalCurrent of [true, false]) {
            const raw = evidence([
                entry(1, 'authority-observed', {
                    facadeObserved: true,
                    accountPresent,
                    originalObserved: true,
                    originalCurrent,
                }),
            ]);
            assert.equal(
                inspectSceneAuthorityTimingEvidence(raw, pin).timing.entries[0].originalCurrent,
                originalCurrent,
            );
        }
    }
    expectRefused(evidence([entry(1, 'authority-observed')]));
    expectRefused(evidence([entry(1, 'authority-observed', { accountPresent: false, originalObserved: true })]));
    assert.equal(
        inspectSceneAuthorityTimingEvidence(
            evidence([
                entry(1, 'original-rechecked', {
                    facadeObserved: true,
                    originalObserved: true,
                    originalCurrent: null,
                }),
            ]),
            pin,
        ).timing.entries[0].originalCurrent,
        null,
    );
});

test('matches Swift phase admission and presence rules without deriving authority from counts', () => {
    const invalidModes = [
        ['verify-completed', { facadeObserved: true, verifyCompletions: null }],
        ['verify-completed', { facadeObserved: true, verifyCompletions: 0 }],
        ['verify-completed', { facadeObserved: false, verifyCompletions: 1 }],
        ['original-captured', { facadeObserved: true, originalObserved: false }],
        ['original-captured', { facadeObserved: false, originalObserved: true }],
        ['authority-observed', { facadeObserved: false, accountPresent: false }],
        ['authority-observed', { facadeObserved: true, accountPresent: null }],
        ['authority-observed', { facadeObserved: true, originalObserved: true, accountPresent: true }],
        ['authority-observed', { facadeObserved: true, accountPresent: false, originalCurrent: false }],
        ['authority-unavailable', { facadeObserved: true }],
        ['authority-unavailable', { facadeObserved: true, originalObserved: true }],
        ['authority-unavailable', { accountPresent: false }],
        ['original-cleared', { facadeObserved: true, originalObserved: true }],
        ['protected-setup', { facadeObserved: false, originalObserved: true }],
        ['peer-reply', { facadeObserved: true, originalCurrent: true }],
        ['proof-captured', { facadeObserved: false, accountPresent: true }],
    ];
    for (const [phase, overrides] of invalidModes) {
        expectRefused(
            evidence([
                entry(1, phase, {
                    sinceFirstVerify: phase === 'verify-completed' ? 'lt-1s' : 'unobserved',
                    sinceOriginalCapture: phase === 'original-captured' ? 'lt-1s' : 'unobserved',
                    ...overrides,
                }),
            ]),
        );
    }
    for (const verifyCompletions of [1, 10_000]) {
        const raw = evidence([
            entry(1, 'verify-completed', {
                sinceFirstVerify: 'lt-1s',
                facadeObserved: true,
                verifyCompletions,
                fenceAttempts: 0,
            }),
        ]);
        assert.equal(
            inspectSceneAuthorityTimingEvidence(raw, pin).timing.entries[0].verifyCompletions,
            verifyCompletions,
        );
    }
    const clearedWithFacade = evidence([entry(1, 'original-cleared', { facadeObserved: true, accountPresent: true })]);
    assert.equal(inspectSceneAuthorityTimingEvidence(clearedWithFacade, pin).timing.entries[0].accountPresent, true);
    const nullableCaptureCounts = evidence([
        entry(1, 'original-captured', {
            sinceOriginalCapture: 'lt-1s',
            facadeObserved: true,
            originalObserved: true,
        }),
    ]);
    assert.equal(
        inspectSceneAuthorityTimingEvidence(nullableCaptureCounts, pin).timing.entries[0].verifyCompletions,
        null,
    );
    // Presence before an anchor is not prohibited by the native recorder. Only
    // the original-captured phase starts its timer; counts grant no presence.
    const preCapturePresence = evidence([
        entry(1, 'protected-setup', {
            facadeObserved: true,
            originalObserved: true,
            accountPresent: false,
            originalCurrent: false,
        }),
    ]);
    assert.equal(
        inspectSceneAuthorityTimingEvidence(preCapturePresence, pin).timing.entries[0].sinceOriginalCapture,
        'unobserved',
    );
});

test('clearing permanently prevents observed originals, but preserves unrelated later observations', () => {
    for (const phase of [
        'original-captured',
        'original-rechecked',
        'protected-setup',
        'peer-reply',
        'proof-captured',
        'protected-report',
        'authority-observed',
    ]) {
        const raw = evidence([
            entry(1, 'original-cleared'),
            entry(2, phase, {
                sinceOriginalCapture: phase === 'original-captured' ? 'lt-1s' : 'unobserved',
                facadeObserved: true,
                originalObserved: true,
                accountPresent: phase === 'authority-observed' ? false : null,
                originalCurrent: phase === 'authority-observed' ? false : null,
            }),
        ]);
        expectRefused(raw);
    }
    const retained = evidence([
        entry(1, 'original-captured', { sinceOriginalCapture: 'lt-1s', facadeObserved: true, originalObserved: true }),
        entry(2, 'original-cleared', { sinceOriginalCapture: '1s-to-lt-10s' }),
        entry(3, 'authority-observed', {
            sinceOriginalCapture: '10s-to-lt-30s',
            facadeObserved: true,
            accountPresent: false,
        }),
        entry(4, 'verify-completed', {
            sinceFirstVerify: 'lt-1s',
            sinceOriginalCapture: '30s-to-lt-60s',
            facadeObserved: true,
            verifyCompletions: 1,
        }),
        entry(5, 'authority-unavailable', { sinceFirstVerify: 'lt-1s', sinceOriginalCapture: '30s-to-lt-60s' }),
    ]);
    const result = inspectSceneAuthorityTimingEvidence(retained, pin);
    assert.equal(result.timing.entries.length, 5);
    assert.equal(result.timing.entries[4].sinceOriginalCapture, '30s-to-lt-60s');
    assert.equal(result.timing.entries[3].verifyCompletions, 1);
});

test('timers are unobserved before their own first event, known on it, and never reset on later events', () => {
    for (const name of ['sinceFirstVerify', 'sinceOriginalCapture']) {
        for (const value of [...buckets, undefined, null, false, 1, 'expired', 'lt-1s\n'])
            expectRefused(evidence([entry(1, 'protected-setup', { [name]: value })]));
    }
    expectRefused(evidence([entry(1, 'verify-completed', { facadeObserved: true, verifyCompletions: 1 })]));
    expectRefused(evidence([entry(1, 'original-captured', { facadeObserved: true, originalObserved: true })]));
    for (const name of ['sinceFirstVerify', 'sinceOriginalCapture']) {
        const raw = evidence(observedEntries());
        raw.timing.entries[2][name] = 'unobserved';
        expectRefused(raw);
    }
    const repeatedVerify = evidence([
        entry(1, 'verify-completed', { sinceFirstVerify: '10s-to-lt-30s', facadeObserved: true, verifyCompletions: 1 }),
        entry(2, 'verify-completed', { sinceFirstVerify: 'lt-1s', facadeObserved: true, verifyCompletions: 2 }),
    ]);
    expectRefused(repeatedVerify);
    repeatedVerify.timing.entries[1].sinceFirstVerify = '30s-to-lt-60s';
    assert.equal(inspectSceneAuthorityTimingEvidence(repeatedVerify, pin).timing.entries.length, 2);
    const cleared = evidence([
        entry(1, 'original-captured', { sinceOriginalCapture: 'lt-1s', facadeObserved: true, originalObserved: true }),
        entry(2, 'original-cleared', { sinceOriginalCapture: '1s-to-lt-10s' }),
        entry(3, 'authority-unavailable', { sinceOriginalCapture: '10s-to-lt-30s' }),
    ]);
    assert.equal(
        inspectSceneAuthorityTimingEvidence(cleared, pin).timing.entries[2].sinceOriginalCapture,
        '10s-to-lt-30s',
    );
    cleared.timing.entries[2].sinceOriginalCapture = 'unobserved';
    expectRefused(cleared);
    expectRefused(
        evidence([
            entry(1, 'original-captured', {
                sinceOriginalCapture: 'lt-1s',
                facadeObserved: true,
                originalObserved: true,
            }),
            entry(2, 'original-cleared', { sinceOriginalCapture: 'lt-1s' }),
            entry(3, 'original-captured', {
                sinceOriginalCapture: '1s-to-lt-10s',
                facadeObserved: true,
                originalObserved: true,
            }),
        ]),
    );
});

test('both known timers admit the complete ordered bucket set and independently refuse decreases', () => {
    const rows = [
        entry(1, 'verify-completed', { sinceFirstVerify: 'lt-1s', facadeObserved: true, verifyCompletions: 1 }),
        entry(2, 'original-captured', {
            sinceFirstVerify: 'lt-1s',
            sinceOriginalCapture: 'lt-1s',
            facadeObserved: true,
            originalObserved: true,
        }),
        ...buckets.map((bucket, index) =>
            entry(index + 3, 'protected-report', {
                sinceFirstVerify: bucket,
                sinceOriginalCapture: bucket,
            }),
        ),
    ];
    assert.equal(inspectSceneAuthorityTimingEvidence(evidence(rows), pin).timing.entries.length, 8);
    for (const name of ['sinceFirstVerify', 'sinceOriginalCapture']) {
        for (let index = 1; index < buckets.length; index++) {
            const raw = evidence(observedEntries());
            raw.timing.entries[2][name] = buckets[index];
            raw.timing.entries.push(
                entry(4, 'protected-report', {
                    sinceFirstVerify: raw.timing.entries[2].sinceFirstVerify,
                    sinceOriginalCapture: raw.timing.entries[2].sinceOriginalCapture,
                    [name]: buckets[index - 1],
                }),
            );
            expectRefused(raw);
        }
    }
});

test('bounded admitted serialization is private and arbitrary rejected input is never serialized', () => {
    assert.equal(SCENE_AUTHORITY_TIMING_MAXIMUM_BYTES, 16_384);
    const rows = Array.from({ length: 32 }, (_, index) =>
        entry(
            index + 1,
            index === 0 ? 'verify-completed' : index === 1 ? 'original-captured' : 'authority-unavailable',
            {
                sinceFirstVerify: 'ge-120s',
                sinceOriginalCapture: index === 0 ? 'unobserved' : 'ge-120s',
                fenceAttempts: 10_000,
                verifyCompletions: 10_000,
                facadeObserved: index < 2,
                originalObserved: index === 1,
                accountPresent: index === 1 ? false : null,
                originalCurrent: index === 1 ? false : null,
            },
        ),
    );
    const result = inspectSceneAuthorityTimingEvidence(evidence(rows), pin);
    assert.ok(Buffer.byteLength(JSON.stringify(result), 'utf8') <= 16_384);
    let calls = 0;
    const secret = {
        toJSON() {
            calls++;
            throw Error('private-canary');
        },
    };
    const raw = evidence();
    raw.privateCanary = secret;
    expectRefused(raw);
    const bad = evidence([entry(1, 'authority-unavailable', { fenceAttempts: secret })]);
    expectRefused(bad);
    const accessor = evidence();
    Object.defineProperty(accessor, 'toJSON', {
        enumerable: true,
        get() {
            calls++;
            throw Error('private-canary');
        },
    });
    expectRefused(accessor);
    expectRefused('private-canary'.repeat(16_384));
    expectRefused(
        new Proxy(evidence(), {
            ownKeys() {
                throw Error('private-canary');
            },
        }),
    );
    assert.equal(calls, 0);
});

test('byte accounting cannot invoke inherited object or array serialization hooks', () => {
    const objectDescriptor = Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON');
    const arrayDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, 'toJSON');
    let calls = 0;
    try {
        for (const prototype of [Object.prototype, Array.prototype]) {
            Object.defineProperty(prototype, 'toJSON', {
                configurable: true,
                value() {
                    calls++;
                    throw Error('private-canary');
                },
            });
        }
        const result = inspectSceneAuthorityTimingEvidence(evidence(observedEntries()), pin);
        assert.equal(result.timing.entries.length, 3);
        assert.equal(calls, 0);
    } finally {
        if (objectDescriptor) Object.defineProperty(Object.prototype, 'toJSON', objectDescriptor);
        else delete Object.prototype.toJSON;
        if (arrayDescriptor) Object.defineProperty(Array.prototype, 'toJSON', arrayDescriptor);
        else delete Array.prototype.toJSON;
    }
});
