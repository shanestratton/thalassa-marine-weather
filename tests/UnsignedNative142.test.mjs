import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { Buffer } from 'node:buffer';
import {
    NATIVE_BASE141,
    NATIVE_PROJECT142,
    NATIVE_GRIB142,
    NATIVE_INFO142,
    NATIVE_STORAGE142,
    expectedNativeProject142,
    assertNative142,
    verifyNative142,
} from '../scripts/native-identity142.mjs';

// Immutable capture precedes this guard/test; later native releases cannot rewrite its fixtures.
const PINNED_NATIVE_SNAPSHOT142 = 'b0221d6a3cf0e1825b9ea6aa5cc9b93528dc103a';
const show = (source, file) => execFileSync('git', ['show', `${source}:${file}`]);
const files = [NATIVE_PROJECT142, NATIVE_GRIB142, NATIVE_INFO142, NATIVE_STORAGE142];
const baseline = Object.fromEntries(files.map((file) => [file, show(NATIVE_BASE141, file)]));
const captured = Object.fromEntries(files.map((file) => [file, show(PINNED_NATIVE_SNAPSHOT142, file)]));
const names = [NATIVE_PROJECT142, NATIVE_GRIB142, NATIVE_INFO142];
const fixture =
    (changes = {}) =>
    () =>
        assertNative142(
            (file) => changes.files?.[file] ?? captured[file],
            (_command, args) => {
                if (args[0] === 'show') {
                    const file = args[1].slice(NATIVE_BASE141.length + 1);
                    assert.ok(files.includes(file));
                    return changes.baseline?.[file] ?? baseline[file];
                }
                if (args.includes('--name-only')) return (changes.names ?? names).join('\n') + '\n';
                if (args[0] === 'ls-files') return changes.untracked ?? '';
                if (changes.dirty) throw Error('Tracked native mutation');
                return Buffer.alloc(0);
            },
        );
const refuseFile = (file, bytes) => assert.throws(fixture({ files: { [file]: bytes } }));

test('immutable142 capture admits only four build fields and the exact reviewed chart picker and UTIs', () => {
    assert.ok(captured[NATIVE_PROJECT142].equals(expectedNativeProject142(baseline[NATIVE_PROJECT142])));
    const proof = fixture()();
    assert.equal(proof.appBuild, 142);
    assert.equal(proof.buildChanges, 4);
    assert.equal(proof.compiled, false);
    assert.equal(proof.allOtherTrackedIosBytesUnchanged, true);
    assert.deepEqual(proof.changedFiles, names);
    assert.ok(captured[NATIVE_STORAGE142].equals(baseline[NATIVE_STORAGE142]));
});

test('old, partial, marketing, target, whitespace and line-ending project changes are refused', () => {
    const project = captured[NATIVE_PROJECT142];
    for (const bytes of [
        baseline[NATIVE_PROJECT142],
        Buffer.from(project.toString().replace('CURRENT_PROJECT_VERSION = 142;', 'CURRENT_PROJECT_VERSION = 141;')),
        Buffer.from(project.toString().replace('MARKETING_VERSION = 1.2.0;', 'MARKETING_VERSION = 1.2.1;')),
        Buffer.from(project.toString().replace('NfcTagPlugin.m', 'OtherPlugin.m')),
        Buffer.concat([project, Buffer.from('\n')]),
        Buffer.from(project.toString().replaceAll('\n', '\r\n')),
    ]) {
        assert.ok(!bytes.equals(project));
        refuseFile(NATIVE_PROJECT142, bytes);
    }
});

test('old copy behavior, broader file quotas, missing balanced scope and hidden-file omissions are refused', () => {
    const original = captured[NATIVE_GRIB142];
    for (const bytes of [
        baseline[NATIVE_GRIB142],
        Buffer.from(original.toString().replace('maximum = 32 * 1024 * 1024', 'maximum = 64 * 1024 * 1024')),
        Buffer.from(original.toString().replace('source.stopAccessingSecurityScopedResource()', 'source.isFileURL')),
        Buffer.from(
            original.toString().replace('options: chart ? [] : [.skipsHiddenFiles]', 'options: [.skipsHiddenFiles]'),
        ),
        Buffer.concat([original, Buffer.from('\n')]),
    ]) {
        assert.ok(!bytes.equals(original));
        refuseFile(NATIVE_GRIB142, bytes);
    }
});

test('old UTIs, expanded catalogue/remote formats and unrelated plist changes are refused', () => {
    const original = captured[NATIVE_INFO142];
    for (const bytes of [
        baseline[NATIVE_INFO142],
        Buffer.from(original.toString().replace('<string>kap</string>', '<string>bsb</string>')),
        Buffer.from(original.toString().replace('<string>public.tiff</string>', '<string>public.url</string>')),
        Buffer.concat([original, Buffer.from('\n')]),
    ]) {
        assert.ok(!bytes.equals(original));
        refuseFile(NATIVE_INFO142, bytes);
    }
});

test('encrypted storage and either immutable baseline cannot be changed under the chart allowlist', () => {
    refuseFile(NATIVE_STORAGE142, Buffer.concat([captured[NATIVE_STORAGE142], Buffer.from('\n')]));
    assert.throws(() => expectedNativeProject142(Buffer.concat([baseline[NATIVE_PROJECT142], Buffer.from('\n')])));
    assert.throws(
        fixture({ baseline: { [NATIVE_STORAGE142]: Buffer.concat([baseline[NATIVE_STORAGE142], Buffer.from('\n')]) } }),
    );
});

test('missing, duplicate, reordered, Watch, signing, entitlement and dependency native files are refused', () => {
    for (const changed of [
        [],
        names.slice(1),
        names.slice(0, 2),
        [...names, NATIVE_INFO142],
        [...names].reverse(),
        [...names, NATIVE_STORAGE142],
        [...names, 'ios/App/ThalassaWatch Watch App/Models/AnchorSnapshot.swift'],
        [...names, 'ios/App/App/App.entitlements'],
        [...names, 'ios/App/Podfile.lock'],
    ])
        assert.throws(fixture({ names: changed }));
    assert.throws(fixture({ dirty: true }));
    assert.throws(fixture({ untracked: 'ios/App/Unreviewed.swift\n' }));
});

test('CLI rejects unpinned source or wrong checkout before reading native candidate files', () => {
    for (const source of [undefined, '', 'HEAD', 'b0221d6', 'a'.repeat(39), 'A'.repeat(40), 'a'.repeat(41)])
        assert.throws(() => verifyNative142('.', source));
    let calls = 0;
    assert.throws(
        () =>
            verifyNative142('.', 'a'.repeat(40), (_command, args) => {
                calls++;
                assert.deepEqual(args, ['-C', '.', 'rev-parse', 'HEAD']);
                return 'b'.repeat(40) + '\n';
            }),
        /Checkout does not match frozen unsigned workflow source/,
    );
    assert.equal(calls, 1);
});
