import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import test from 'node:test';
import { summarizeOwnedLaunchDiagnostic } from './ownedLaunchDiagnostic.mjs';

const refusal = 'Owned simulator launch diagnostic refused.';
const maximumOutputBytes = 8 * 1024 * 1024;
const fields = [
    'version',
    'kind',
    'diagnosticOnly',
    'acceptanceEvidence',
    'exitStatus',
    'timedOut',
    'signal',
    'spawnError',
    'durationMs',
    'boundMs',
    'exceededBound',
    'stdoutBytes',
    'stderrBytes',
    'observedPID',
    'stdoutShape',
];

function input(overrides = {}) {
    return {
        status: 0,
        signal: null,
        errorCode: null,
        stdout: 'app.thalassa.research.scuttlebutt-auth: 12345\n',
        stderr: '',
        durationMs: 1_234,
        boundMs: 30_000,
        ...overrides,
    };
}

function expectRefused(raw) {
    assert.throws(
        () => summarizeOwnedLaunchDiagnostic(raw),
        (error) => {
            assert.equal(error.constructor, Error);
            assert.equal(error.message, refusal);
            assert.equal(error.cause, undefined);
            assert.deepEqual(Object.keys(error), []);
            return true;
        },
    );
}

test('returns only the exact detached, deeply frozen scalar schema', () => {
    const raw = input();
    const result = summarizeOwnedLaunchDiagnostic(raw);
    assert.deepEqual(Object.keys(result), fields);
    assert.deepEqual(result, {
        version: 1,
        kind: 'owned-simulator-app-launch-diagnostic',
        diagnosticOnly: true,
        acceptanceEvidence: false,
        exitStatus: 0,
        timedOut: false,
        signal: null,
        spawnError: null,
        durationMs: 1_234,
        boundMs: 30_000,
        exceededBound: false,
        stdoutBytes: Buffer.byteLength(raw.stdout, 'utf8'),
        stderrBytes: 0,
        observedPID: 12345,
        stdoutShape: 'exact-pid',
    });
    assert.ok(Object.isFrozen(result));
    assert.ok(
        Object.values(result).every(
            (value) => value === null || ['string', 'number', 'boolean'].includes(typeof value),
        ),
    );
    raw.status = 5;
    raw.stdout = 'changed';
    assert.equal(result.exitStatus, 0);
    assert.equal(result.observedPID, 12345);
    assert.throws(() => {
        result.acceptanceEvidence = true;
    }, TypeError);
});

test('retains timeout, exit, signal and exact PID contradictions without normalizing to success', () => {
    const result = summarizeOwnedLaunchDiagnostic(
        input({
            status: 0,
            signal: 'SIGTERM',
            errorCode: 'ETIMEDOUT',
            durationMs: 32_345,
        }),
    );
    assert.equal(result.exitStatus, 0);
    assert.equal(result.timedOut, true);
    assert.equal(result.signal, 'SIGTERM');
    assert.equal(result.spawnError, 'ETIMEDOUT');
    assert.equal(result.observedPID, 12345);
    assert.equal(result.stdoutShape, 'exact-pid');
    assert.equal(result.durationMs, 32_345);
    assert.equal(result.exceededBound, true);
    assert.equal(result.acceptanceEvidence, false);
});

test('preserves nullable exit and failed exit alongside observed output', () => {
    for (const status of [null, 1, 255]) {
        const result = summarizeOwnedLaunchDiagnostic(input({ status }));
        assert.equal(result.exitStatus, status);
        assert.equal(result.observedPID, 12345);
        assert.equal(result.acceptanceEvidence, false);
    }
});

test('preserves exact duration, including maximum safe overshoot, and the fixed 30-second bound', () => {
    for (const durationMs of [0, 29_999, 30_000, 30_001, Number.MAX_SAFE_INTEGER]) {
        const result = summarizeOwnedLaunchDiagnostic(input({ durationMs }));
        assert.equal(result.durationMs, durationMs);
        assert.equal(result.boundMs, 30_000);
        assert.equal(result.exceededBound, durationMs > 30_000);
    }
});

test('allows only the original exact positive 1-to-9-digit PID output pattern', () => {
    for (const [stdout, expected] of [
        ['app.thalassa.research.scuttlebutt-auth: 1', 1],
        ['app.thalassa.research.scuttlebutt-auth: 999999999\n', 999999999],
        ['app.thalassa.research.scuttlebutt-auth: 42 \t\r\n', 42],
    ]) {
        const result = summarizeOwnedLaunchDiagnostic(input({ stdout }));
        assert.equal(result.observedPID, expected);
        assert.equal(result.stdoutShape, 'exact-pid');
    }
});

test('rejects misleading PID shapes as other, never as observed native launch', () => {
    for (const stdout of [
        'app.thalassa.research.scuttlebutt-auth: 0',
        'app.thalassa.research.scuttlebutt-auth: 01',
        'app.thalassa.research.scuttlebutt-auth: -1',
        'app.thalassa.research.scuttlebutt-auth: 1000000000',
        'app.thalassa.research.scuttlebutt-auth: 1.5',
        'app.thalassa.research.scuttlebutt-auth: １',
        'app.thalassa.research.scuttlebutt-auth: 1 trailing',
        'prefix app.thalassa.research.scuttlebutt-auth: 123',
        '\napp.thalassa.research.scuttlebutt-auth: 123',
        'appXthalassaXresearchXscuttlebutt-auth: 123',
        'app.thalassa.research.scuttlebutt-auth: 123\napp.thalassa.research.scuttlebutt-auth: 123',
        'app.thalassa.research.scuttlebutt-auth: 123\0',
        'app.thalassa.research.other: 123',
        '   ',
    ]) {
        const result = summarizeOwnedLaunchDiagnostic(input({ stdout }));
        assert.equal(result.observedPID, null);
        assert.equal(result.stdoutShape, 'other');
    }
});

test('distinguishes empty stdout only, without classifying stderr content', () => {
    const stderr = 'ETIMEDOUT SIGKILL app.thalassa.research.scuttlebutt-auth: 999\n';
    const result = summarizeOwnedLaunchDiagnostic(input({ stdout: '', stderr }));
    assert.equal(result.stdoutShape, 'empty');
    assert.equal(result.observedPID, null);
    assert.equal(result.timedOut, false);
    assert.equal(result.spawnError, null);
    assert.equal(result.signal, null);
    assert.equal(result.stderrBytes, Buffer.byteLength(stderr, 'utf8'));
    assert.deepEqual(Object.keys(result), fields);
});

test('maps only fixed signal and spawn-error categories, without retaining unknown strings', () => {
    for (const signal of [
        'SIGHUP',
        'SIGINT',
        'SIGQUIT',
        'SIGILL',
        'SIGTRAP',
        'SIGABRT',
        'SIGBUS',
        'SIGFPE',
        'SIGKILL',
        'SIGSEGV',
        'SIGPIPE',
        'SIGALRM',
        'SIGTERM',
        'SIGXCPU',
        'SIGXFSZ',
        'SIGSYS',
    ]) {
        assert.equal(summarizeOwnedLaunchDiagnostic(input({ signal })).signal, signal);
    }
    for (const errorCode of [
        'ETIMEDOUT',
        'ENOENT',
        'EACCES',
        'EPERM',
        'E2BIG',
        'ENOMEM',
        'ENOBUFS',
        'EIO',
        'ENOEXEC',
        'EMFILE',
        'ENFILE',
        'EAGAIN',
    ]) {
        const result = summarizeOwnedLaunchDiagnostic(input({ errorCode }));
        assert.equal(result.spawnError, errorCode);
        assert.equal(result.timedOut, errorCode === 'ETIMEDOUT');
    }
    const result = summarizeOwnedLaunchDiagnostic(
        input({ signal: 'private-signal-canary', errorCode: 'private-error-canary' }),
    );
    assert.equal(result.signal, 'other');
    assert.equal(result.spawnError, 'other');
    assert.equal(result.timedOut, false);
    assert.doesNotMatch(JSON.stringify(result), /private-(?:signal|error)-canary/);
});

test('counts UTF-8 output bytes, including surrogate replacement, without retaining the text', () => {
    for (const [stdout, stderr] of [
        ['é水🛥️', '🔒λ'],
        ['\ud800', '\udfff'],
        ['a\0b', '\r\n'],
    ]) {
        const result = summarizeOwnedLaunchDiagnostic(input({ stdout, stderr }));
        assert.equal(result.stdoutBytes, Buffer.byteLength(stdout, 'utf8'));
        assert.equal(result.stderrBytes, Buffer.byteLength(stderr, 'utf8'));
        assert.equal(result.stdoutShape, 'other');
        assert.equal(result.observedPID, null);
    }
});

test('admits each parent-bounded 8 MiB output and refuses one-byte excess independently', () => {
    const bounded = 'x'.repeat(maximumOutputBytes);
    const result = summarizeOwnedLaunchDiagnostic(input({ stdout: bounded, stderr: bounded }));
    assert.equal(result.stdoutBytes, maximumOutputBytes);
    assert.equal(result.stderrBytes, maximumOutputBytes);
    expectRefused(input({ stdout: `${bounded}x` }));
    expectRefused(input({ stderr: `${bounded}x` }));
    const multibyte = 'é'.repeat(maximumOutputBytes / 2);
    assert.equal(summarizeOwnedLaunchDiagnostic(input({ stdout: multibyte })).stdoutBytes, maximumOutputBytes);
    expectRefused(input({ stdout: `${multibyte}é` }));
    expectRefused(input({ stderr: `${multibyte}é` }));
});

test('never retains authentication, resource, message, output or custom error text canaries', () => {
    const canaries = [
        'Authorization: Bearer private-auth-canary',
        'resource-nonce-private-canary',
        'plaintext-message-private-canary',
        '/private/tmp/owned-resource-path-private-canary',
    ];
    const result = summarizeOwnedLaunchDiagnostic(
        input({
            stdout: canaries.join('\n'),
            stderr: canaries.join('\n'),
            signal: canaries[0],
            errorCode: canaries[1],
        }),
    );
    const saved = JSON.stringify(result);
    for (const canary of canaries) assert.ok(!saved.includes(canary));
    assert.equal(result.stdoutShape, 'other');
    assert.equal(result.observedPID, null);
    assert.equal(result.signal, 'other');
    assert.equal(result.spawnError, 'other');
});

test('refuses invalid status, duration and bounds without coercion', () => {
    for (const status of [
        undefined,
        -1,
        -0,
        256,
        1.5,
        NaN,
        Infinity,
        Number.MAX_SAFE_INTEGER + 1,
        '0',
        false,
        0n,
        {},
        [],
    ]) {
        expectRefused(input({ status }));
    }
    for (const durationMs of [
        undefined,
        null,
        -1,
        -0,
        1.5,
        NaN,
        Infinity,
        Number.MAX_SAFE_INTEGER + 1,
        '30000',
        false,
        0n,
        {},
        [],
    ]) {
        expectRefused(input({ durationMs }));
    }
    for (const boundMs of [undefined, null, 0, -1, 29_999, 30_001, NaN, Infinity, '30000', 30_000n, {}, []]) {
        expectRefused(input({ boundMs }));
    }
});

test('refuses nonprimitive output and category fields without invoking coercion hooks', () => {
    let invoked = 0;
    const hostile = {
        toString() {
            invoked++;
            throw Error('private-coercion-canary');
        },
    };
    for (const name of ['stdout', 'stderr', 'signal', 'errorCode']) {
        for (const value of [
            undefined,
            1,
            true,
            1n,
            Symbol('private-symbol'),
            hostile,
            [],
            new String('text'),
            Buffer.from('text'),
        ]) {
            expectRefused(input({ [name]: value }));
        }
        if (name === 'stdout' || name === 'stderr') expectRefused(input({ [name]: null }));
    }
    assert.equal(invoked, 0);
});

test('requires exactly own enumerable data fields and does not invoke accessor or toJSON hooks', () => {
    let invoked = 0;
    for (const name of Object.keys(input())) {
        const missing = input();
        delete missing[name];
        expectRefused(missing);
        const accessor = input();
        Object.defineProperty(accessor, name, {
            enumerable: true,
            get() {
                invoked++;
                throw Error('private-accessor-canary');
            },
        });
        expectRefused(accessor);
        const hidden = input();
        Object.defineProperty(hidden, name, { enumerable: false, value: hidden[name] });
        expectRefused(hidden);
    }
    expectRefused({ ...input(), extra: 'private-extra-canary' });
    expectRefused({ ...input(), [Symbol('private-key-canary')]: 'value' });
    expectRefused({
        ...input(),
        toJSON() {
            invoked++;
            return 'private-json-canary';
        },
    });
    expectRefused(
        Object.assign(
            Object.create({
                toJSON() {
                    invoked++;
                    return 'private-inherited-canary';
                },
            }),
            input(),
        ),
    );
    assert.equal(invoked, 0);
});

test('refuses exotic objects and proxies with one fixed refusal, without invoking their traps', () => {
    let invoked = 0;
    const trap = () => {
        invoked++;
        throw Error('private-proxy-canary');
    };
    for (const raw of [
        undefined,
        null,
        false,
        0,
        'raw',
        [],
        () => {},
        new Date(),
        new Map(),
        new Set(),
        new (class Launch {})(),
        new Proxy(input(), {}),
        new Proxy(input(), { getPrototypeOf: trap, ownKeys: trap, getOwnPropertyDescriptor: trap, get: trap }),
    ]) {
        expectRefused(raw);
    }
    const revocable = Proxy.revocable(input(), {});
    revocable.revoke();
    expectRefused(revocable.proxy);
    assert.equal(invoked, 0);
});

test('accepts null-prototype own data records without consulting inherited methods', () => {
    const raw = Object.assign(Object.create(null), input({ status: null, stdout: '', errorCode: 'ETIMEDOUT' }));
    const result = summarizeOwnedLaunchDiagnostic(raw);
    assert.equal(result.exitStatus, null);
    assert.equal(result.timedOut, true);
    assert.equal(result.stdoutShape, 'empty');
    assert.equal(result.observedPID, null);
});
