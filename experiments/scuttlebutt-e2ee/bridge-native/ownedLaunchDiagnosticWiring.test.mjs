// Extracted driver/synthetic process results only; no app or simulator executes.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import { summarizeOwnedLaunchDiagnostic } from './ownedLaunchDiagnostic.mjs';

const source = readFileSync(new URL('./fullAppProtectedUiProof.mjs', import.meta.url), 'utf8');
const start = source.indexOf('function quiet(');
const end = source.indexOf('\nfunction own()', start);
assert(start > 0 && end > start);
const quiet = source.slice(start, end);
const base = 'aa968bb2080649c330c4d006df433f95361e0036';
const previous = execFileSync(
    '/usr/bin/git',
    ['show', base + ':experiments/scuttlebutt-e2ee/bridge-native/fullAppProtectedUiProof.mjs'],
    { encoding: 'utf8', maxBuffer: 1024 * 1024 },
);
const fixedPID = 'app.thalassa.research.scuttlebutt-auth: 12345\n';
function execute(result, { receipt = {}, times = [100, 30101], summarize = summarizeOwnedLaunchDiagnostic } = {}) {
    const writes = [],
        calls = [];
    const row = { phase: 'actual-full-root-protected', ...receipt };
    let cursor = 0,
        thrown = null,
        output;
    const context = {
        receipt: row,
        save: () => writes.push(JSON.parse(JSON.stringify(row))),
        operationName: () => 'owned-app-launch',
        performance: { now: () => times[cursor++] },
        spawnSync: (bin, args, options) => {
            calls.push({ bin, args, options });
            return result;
        },
        // The extracted quiet() literal is made in the VM realm. Transfer its
        // own value fields into the real parser's realm without weakening the
        // parser's separate foreign-prototype/accessor refusal tests.
        summarizeOwnedLaunchDiagnostic: (input) =>
            summarize(
                Object.fromEntries(
                    Object.getOwnPropertyNames(input).map((key) => [
                        key,
                        Object.getOwnPropertyDescriptor(input, key).value,
                    ]),
                ),
            ),
        assert,
        process: { execPath: '/synthetic/node' },
    };
    try {
        output = runInNewContext(
            quiet +
                "\nquiet('/synthetic/xcrun', ['simctl', 'launch', '--terminate-running-process', 'owned-id', 'app.thalassa.research.scuttlebutt-auth']);",
            context,
            { timeout: 1000 },
        );
    } catch (error) {
        thrown = error;
    }
    return { row, calls, writes, thrown, output, clockReads: cursor };
}
const ok = () => ({ status: 0, signal: null, error: undefined, stdout: fixedPID, stderr: '' });

test('owned launch keeps the unchanged30s/no-console subprocess invocation and exact original PID', () => {
    const value = execute(ok(), { times: [100, 101.2] });
    assert.equal(value.thrown, null);
    assert.equal(value.output, fixedPID.trim());
    assert.equal(value.calls.length, 1);
    assert.equal(value.calls[0].options.timeout, 30000);
    assert.equal(value.calls[0].options.maxBuffer, 8 * 1024 * 1024);
    assert.deepEqual(
        [...value.calls[0].args],
        ['simctl', 'launch', '--terminate-running-process', 'owned-id', 'app.thalassa.research.scuttlebutt-auth'],
    );
    assert.equal(value.row.ownedLaunchPID, 12345);
    const diagnostic = value.row.ownedLaunchDiagnostics[0];
    assert.equal(diagnostic.durationMs, 2);
    assert.equal(diagnostic.observedPID, 12345);
    assert.equal(diagnostic.acceptanceEvidence, false);
    assert(Object.isFrozen(diagnostic));
});

for (const [name, result, expected] of [
    [
        'timeout',
        {
            status: null,
            signal: 'SIGTERM',
            error: { code: 'ETIMEDOUT', message: 'private-error-canary' },
            stdout: '',
            stderr: 'private-stderr-canary',
        },
        { timedOut: true, pid: null, error: 'ETIMEDOUT' },
    ],
    [
        'buffer refusal',
        { status: null, signal: 'SIGTERM', error: { code: 'ENOBUFS' }, stdout: 'partial', stderr: 'private-output' },
        { timedOut: false, pid: null, error: 'ENOBUFS' },
    ],
    [
        'permissions refusal',
        { status: null, signal: null, error: { code: 'EACCES' }, stdout: '', stderr: '' },
        { timedOut: false, pid: null, error: 'EACCES' },
    ],
    [
        'nonzero exit',
        { status: 1, signal: null, stdout: '', stderr: 'unknown failure' },
        { timedOut: false, pid: null, error: null },
    ],
    [
        'timeout with exact app PID',
        { status: null, signal: 'SIGTERM', error: { code: 'ETIMEDOUT' }, stdout: fixedPID, stderr: '' },
        { timedOut: true, pid: 12345, error: 'ETIMEDOUT' },
    ],
]) {
    test(name + ' remains the original failed operation; observations cannot make it pass', () => {
        const value = execute(result);
        assert(value.thrown);
        assert.equal(value.row.lastOperation, 'owned-app-launch');
        assert.equal(value.row.lastOperationExitStatus, result.status);
        assert.equal(value.row.lastOperationTimedOut, expected.timedOut);
        assert.equal(value.row.ownedLaunchPID, expected.pid);
        assert.equal(value.row.ownedLaunchDiagnostics[0].spawnError, expected.error);
        assert.equal(value.row.ownedLaunchDiagnostics[0].durationMs, 30001);
        assert.equal(value.row.ownedLaunchDiagnostics[0].exceededBound, true);
        assert.equal(value.row.ownedLaunchDiagnostics[0].acceptanceEvidence, false);
        assert(!JSON.stringify(value.row).includes('private-'));
        assert.equal(value.calls.length, 1);
        assert.equal(value.clockReads, 2);
        assert.equal(value.writes.at(-1).lastOperation, 'owned-app-launch');
    });
}

test('diagnostic refusal cannot replace or hide an original launch failure', () => {
    const value = execute(
        { status: null, error: { code: 'ETIMEDOUT' }, stdout: '', stderr: '' },
        {
            summarize: () => {
                throw Error('private-parser-error');
            },
        },
    );
    assert(value.thrown);
    assert.equal(value.row.lastOperationTimedOut, true);
    assert.equal(value.row.lastOperationExitStatus, null);
    assert.equal(value.row.ownedLaunchPID, null);
    assert.equal(value.row.ownedLaunchDiagnosticStatus, 'refused');
    assert.equal(value.row.ownedLaunchDiagnostics, undefined);
    assert(!JSON.stringify(value.row).includes('private-parser-error'));
});

test('diagnostic refusal never changes successful subprocess behavior', () => {
    const value = execute(ok(), {
        summarize: () => {
            throw Error('private-parser-error');
        },
    });
    assert.equal(value.thrown, null);
    assert.equal(value.row.ownedLaunchPID, 12345);
    assert.equal(value.output, fixedPID.trim());
    assert.equal(value.row.ownedLaunchDiagnosticStatus, 'refused');
});

test('only initial+foreground observations fit; overflow preserves earlier immutable values', () => {
    const first = summarizeOwnedLaunchDiagnostic({
        status: 0,
        signal: null,
        errorCode: null,
        stdout: fixedPID,
        stderr: '',
        durationMs: 1,
        boundMs: 30000,
    });
    const old = Object.freeze([first, first]);
    const value = execute(ok(), { receipt: { ownedLaunchDiagnostics: old } });
    assert.equal(value.thrown, null);
    assert.equal(value.row.ownedLaunchDiagnostics, old);
    assert.equal(value.row.ownedLaunchDiagnosticStatus, 'refused');
    assert.equal(value.row.ownedLaunchPID, 12345);
});

test('negative/nonfinite timing refuses the diagnostic rather than forging elapsed time', () => {
    for (const times of [
        [100, 90],
        [100, NaN],
        [100, Infinity],
    ]) {
        const value = execute(ok(), { times });
        assert.equal(value.thrown, null);
        assert.equal(value.row.ownedLaunchDiagnosticStatus, 'refused');
        assert.equal(value.row.ownedLaunchDiagnostics, undefined);
    }
});

test('original launch-to-poll acceptance bytes and all failure capture/cleanup bytes are unchanged', () => {
    const block = (text) =>
        text.slice(
            text.indexOf("receipt.phase = 'actual-full-root-protected';"),
            text.indexOf(
                "receipt.lastOperation = 'native-status-poll';",
                text.indexOf("receipt.phase = 'actual-full-root-protected';"),
            ),
        );
    assert.equal(block(source), block(previous));
    const tail = (text) => text.slice(text.indexOf('} catch {\n    if (receipt.status'));
    assert.equal(tail(source), tail(previous));
    assert(source.includes("'bridge-native/ownedLaunchDiagnostic.mjs'"));
    assert(!quiet.includes('ownedLaunchPID = diagnostic'));
    assert(!quiet.includes('ownedLaunchPID = receipt.ownedLaunchDiagnostics'));
    assert(!quiet.includes('setTimeout'));
    assert(!quiet.includes("simctl', 'launchctl"));
});
