import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import {
    NATIVE_BASE139,
    NATIVE_PROJECT140,
    NATIVE_PROJECT139_SHA256,
    expectedNativeProject140,
    assertNative140,
    verifyNative140,
} from '../scripts/native-identity140.mjs';

const baseline = execFileSync('git', ['show', `${NATIVE_BASE139}:${NATIVE_PROJECT140}`]);
// Historical proof must remain valid when the current checkout advances to141.
// The actual checkout is separately admitted by the strict frozen-source CLI.
const PINNED_NATIVE_SNAPSHOT140 = 'a09a5cff088fbd90101fa42ccbb850455a56a87f';
const captured140 = execFileSync('git', ['show', `${PINNED_NATIVE_SNAPSHOT140}:${NATIVE_PROJECT140}`]);
const expected = expectedNativeProject140(baseline);
const fixture =
    (changes = {}) =>
    () =>
        assertNative140(
            () => changes.project ?? expected,
            (_command, args) => {
                if (args[0] === 'show') return changes.baseline ?? baseline;
                if (args.includes('--name-only')) return (changes.names ?? [NATIVE_PROJECT140]).join('\n') + '\n';
                if (args[0] === 'ls-files') return changes.untracked ?? '';
                if (changes.dirty) throw Error('Tracked native mutation');
                return Buffer.alloc(0);
            },
        );

test('captured140 project is exactly four version fields beyond the reviewed139 native baseline', () => {
    assert.equal(createHash('sha256').update(baseline).digest('hex'), NATIVE_PROJECT139_SHA256);
    assert.ok(captured140.equals(expected));
    const proof = fixture()();
    assert.equal(proof.appBuild, 140);
    assert.equal(proof.buildChanges, 4);
    assert.equal(proof.allOtherTrackedIosBytesUnchanged, true);
    assert.deepEqual(proof.changedFiles, [NATIVE_PROJECT140]);
    assert.equal([...expected.toString().matchAll(/CURRENT_PROJECT_VERSION = 140;/g)].length, 4);
    assert.ok(
        Buffer.from(
            expected.toString().replaceAll('CURRENT_PROJECT_VERSION = 140;', 'CURRENT_PROJECT_VERSION = 139;'),
        ).equals(baseline),
    );
});

test('old, partial, extra, whitespace and line-ending native project edits are refused', () => {
    for (const project of [
        baseline,
        Buffer.from(expected.toString().replace('CURRENT_PROJECT_VERSION = 140;', 'CURRENT_PROJECT_VERSION = 139;')),
        Buffer.from(expected.toString().replace('MARKETING_VERSION = 1.2.0;', 'MARKETING_VERSION = 1.2.1;')),
        Buffer.concat([expected, Buffer.from('\n')]),
        Buffer.from(expected.toString().replaceAll('\n', '\r\n')),
        Buffer.from(expected.toString().replace('NfcTagPlugin.m', 'OtherPlugin.m')),
    ]) {
        assert.ok(!project.equals(expected), 'Negative fixture must change actual bytes');
        assert.throws(fixture({ project }));
    }
});

test('no Watch, signing, other native change, missing project or untracked addition is permitted', () => {
    for (const names of [
        [],
        [NATIVE_PROJECT140, 'ios/App/ThalassaWatch Watch App/Models/AnchorSnapshot.swift'],
        [NATIVE_PROJECT140, 'ios/WatchApp/Views/AnchorWatchView.swift'],
        [NATIVE_PROJECT140, 'ios/App/App/App.entitlements'],
        [NATIVE_PROJECT140, 'ios/App/Podfile.lock'],
    ])
        assert.throws(fixture({ names }));
    assert.throws(fixture({ dirty: true }));
    assert.throws(fixture({ untracked: 'ios/App/Unreviewed.swift\n' }));
});

test('an altered baseline is refused even if its version fields appear valid', () => {
    assert.throws(() => expectedNativeProject140(Buffer.concat([baseline, Buffer.from('\n')])));
    assert.throws(fixture({ baseline: Buffer.from(baseline.toString().replace('NfcTagPlugin.m', 'Other.m')) }));
});

test('CLI requires the frozen full source SHA and refuses another checkout before native reads', () => {
    for (const source of [undefined, '', 'HEAD', '5142118', 'a'.repeat(39), 'A'.repeat(40), 'a'.repeat(41)])
        assert.throws(() => verifyNative140('.', source));
    let calls = 0;
    assert.throws(
        () =>
            verifyNative140('.', 'a'.repeat(40), (_command, args) => {
                calls++;
                assert.deepEqual(args, ['-C', '.', 'rev-parse', 'HEAD']);
                return 'b'.repeat(40) + '\n';
            }),
        /Checkout does not match frozen unsigned workflow source/,
    );
    assert.equal(calls, 1);
});
