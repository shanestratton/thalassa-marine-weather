// Synthetic object contracts, not native app, operating-system or crypto proof.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    FIRST_INBOX_STAGE_NAMES as names,
    inspectFirstInboxStageEvidence as inspect,
} from './firstInboxStageContract.mjs';

const input = (prefix = 0, failed = 0, selected = 1) => ({
    version: 1,
    kind: 'first-inbox-stage-diagnostic',
    selectedAttempts: selected,
    markers: Object.fromEntries(
        names.map((name, index) => [name, name === 'failed' ? failed : index < prefix ? 1 : 0]),
    ),
    integrityRefused: false,
    acceptanceEvidence: false,
});
test('synthetic unselected has no invented attempt or failing boundary', () => {
    const result = inspect(input(0, 0, 0));
    assert.equal(result.status, 'unselected');
    assert.equal(result.lastStartedStage, null);
    assert.equal(result.failingBoundary, null);
});
for (let length = 0; length <= 4; length++)
    test(`synthetic pending prefix ${length} grants no execution/acceptance`, () => {
        const result = inspect(input(length));
        assert.equal(result.status, 'pending');
        assert.equal(result.lastStartedStage, length === 0 ? null : names[length - 1]);
        assert.equal(result.acceptanceEvidence, false);
        assert.equal(result.nativeExecutionProvedByParser, false);
    });
for (let length = 1; length <= 4; length++)
    test(`synthetic failure prefix ${length} identifies only its boundary`, () => {
        const result = inspect(input(length, 1));
        assert.equal(result.status, 'failed');
        assert.equal(result.failingBoundary, names[length - 1]);
        assert.equal(result.acceptanceEvidence, false);
    });
test('synthetic completed does not prove JS consumption or an exchange', () => {
    const result = inspect(input(5));
    assert.equal(result.status, 'completed');
    assert.equal(result.javascriptConsumptionProved, false);
    assert.equal(result.nativeExecutionProvedByParser, false);
    assert.ok(Object.isFrozen(result));
    assert.ok(Object.isFrozen(result.markers));
});
for (const key of ['epoch', 'accountId', 'message', 'credential', 'error', 'resource', 'path'])
    test(`synthetic privacy refuses extra ${key}`, () => {
        const data = input(2, 1);
        data[key] = 'synthetic';
        assert.throws(() => inspect(data));
    });
for (const field of ['version', 'kind', 'selectedAttempts', 'markers', 'integrityRefused', 'acceptanceEvidence'])
    test(`synthetic refuses missing ${field}`, () => {
        const data = input(2, 1);
        delete data[field];
        assert.throws(() => inspect(data));
    });
for (const count of [-1, 2, 1.5, true, null, '1'])
    test(`synthetic refuses bounded counter type ${JSON.stringify(count)}`, () => {
        const data = input(2, 1);
        data.markers['adapter-operation'] = count;
        assert.throws(() => inspect(data));
    });
for (const name of names)
    test(`synthetic refuses missing marker ${name}`, () => {
        const data = input(2, 1);
        delete data.markers[name];
        assert.throws(() => inspect(data));
    });
test('synthetic refuses unknown, symbol and non-prefix markers', () => {
    for (const edit of [
        (data) => (data.markers.unexpected = 0),
        (data) => (data.markers[Symbol('extra')] = 0),
        (data) => (data.markers['publication-original-ticket'] = 1),
    ]) {
        const data = input(1);
        edit(data);
        assert.throws(() => inspect(data));
    }
});
test('synthetic refuses impossible terminals and unselected progress', () => {
    for (const data of [input(0, 1), input(5, 1), input(1, 0, 0), input(2, 1, 0)]) assert.throws(() => inspect(data));
});
test('synthetic diagnostic integrity refusal cannot be parsed as success', () => {
    const data = input(5);
    data.integrityRefused = true;
    assert.throws(() => inspect(data));
});
test('synthetic acceptance claim is always refused', () => {
    const data = input(5);
    data.acceptanceEvidence = true;
    assert.throws(() => inspect(data));
});
test('synthetic accessor is refused without executing it', () => {
    let calls = 0;
    const data = input(2, 1);
    Object.defineProperty(data, 'markers', {
        enumerable: true,
        get() {
            calls++;
            return {};
        },
    });
    assert.throws(() => inspect(data));
    assert.equal(calls, 0);
});
test('synthetic missing/nonobject diagnostic is unavailable, never a default pass', () => {
    for (const data of [null, undefined, [], 0, 'data']) assert.throws(() => inspect(data));
});
