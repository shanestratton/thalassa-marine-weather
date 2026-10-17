import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { Buffer } from 'node:buffer';
import {
    NATIVE_BASE140,
    NATIVE_PROJECT141,
    NATIVE_STORAGE141,
    expectedNativeProject141,
    expectedNativeStorage141,
    assertNative141,
    verifyNative141,
} from '../scripts/native-identity141.mjs';

const PINNED_NATIVE_SNAPSHOT141 = '04c9b8f39287b057ea8549d329c2bb5d2fa065e2';
const show = (source, file) => execFileSync('git', ['show', `${source}:${file}`]);
const baselineProject = show(NATIVE_BASE140, NATIVE_PROJECT141);
const baselineStorage = show(NATIVE_BASE140, NATIVE_STORAGE141);
const capturedProject = show(PINNED_NATIVE_SNAPSHOT141, NATIVE_PROJECT141);
const capturedStorage = show(PINNED_NATIVE_SNAPSHOT141, NATIVE_STORAGE141);
const fixture =
    (changes = {}) =>
    () =>
        assertNative141(
            (file) =>
                file === NATIVE_PROJECT141
                    ? (changes.project ?? capturedProject)
                    : (changes.storage ?? capturedStorage),
            (_command, args) => {
                if (args[0] === 'show')
                    return args[1].endsWith(NATIVE_PROJECT141)
                        ? (changes.baselineProject ?? baselineProject)
                        : (changes.baselineStorage ?? baselineStorage);
                if (args.includes('--name-only'))
                    return (changes.names ?? [NATIVE_PROJECT141, NATIVE_STORAGE141]).join('\n') + '\n';
                if (args[0] === 'ls-files') return changes.untracked ?? '';
                if (changes.dirty) throw Error('Tracked native mutation');
                return Buffer.alloc(0);
            },
        );

test('captured141 has exactly four build fields and the one reviewed encrypted scoped key', () => {
    assert.ok(capturedProject.equals(expectedNativeProject141(baselineProject)));
    assert.ok(capturedStorage.equals(expectedNativeStorage141(baselineStorage)));
    const proof = fixture()();
    assert.equal(proof.appBuild, 141);
    assert.equal(proof.buildChanges, 4);
    assert.equal(proof.scopedStorageKeyInsertions, 1);
    assert.equal(proof.allOtherTrackedIosBytesUnchanged, true);
    assert.deepEqual(proof.changedFiles, [NATIVE_PROJECT141, NATIVE_STORAGE141]);
});

test('old, partial, marketing, project-path, whitespace and line-ending changes are refused', () => {
    for (const project of [
        baselineProject,
        Buffer.from(
            capturedProject.toString().replace('CURRENT_PROJECT_VERSION = 141;', 'CURRENT_PROJECT_VERSION = 140;'),
        ),
        Buffer.from(capturedProject.toString().replace('MARKETING_VERSION = 1.2.0;', 'MARKETING_VERSION = 1.2.1;')),
        Buffer.from(capturedProject.toString().replace('NfcTagPlugin.m', 'OtherPlugin.m')),
        Buffer.concat([capturedProject, Buffer.from('\n')]),
        Buffer.from(capturedProject.toString().replaceAll('\n', '\r\n')),
    ]) {
        assert.ok(!project.equals(capturedProject));
        assert.throws(fixture({ project }));
    }
});

test('missing, duplicate, changed or moved comfort key and broader storage limits are refused', () => {
    const insertion = '        "thalassa_private_comfort_pending_v1",\n';
    for (const storage of [
        baselineStorage,
        Buffer.from(capturedStorage.toString().replace(insertion, insertion + insertion)),
        Buffer.from(
            capturedStorage
                .toString()
                .replace('thalassa_private_comfort_pending_v1', 'thalassa_private_comfort_pending_v2'),
        ),
        Buffer.from(
            capturedStorage
                .toString()
                .replace(insertion, '')
                .replace(
                    'private let exactKeys: Set<String> = [\n',
                    'private let exactKeys: Set<String> = [\n' + insertion,
                ),
        ),
        Buffer.from(
            capturedStorage
                .toString()
                .replace('maximumValueBytes = 5 * 1024 * 1024', 'maximumValueBytes = 6 * 1024 * 1024'),
        ),
        Buffer.concat([capturedStorage, Buffer.from('\n')]),
    ]) {
        assert.ok(!storage.equals(capturedStorage));
        assert.throws(fixture({ storage }));
    }
});

test('the exact scoped insertion leaves every existing storage method and bound byte-identical', () => {
    const insertion = '        "thalassa_private_comfort_pending_v1",\n';
    const text = capturedStorage.toString();
    assert.equal(text.split(insertion).length - 1, 1);
    assert.ok(Buffer.from(text.replace(insertion, '')).equals(baselineStorage));
    const scoped = text.split('private let scopedBaseKeys: Set<String> = [')[1].split(']')[0];
    const exact = text.split('private let exactKeys: Set<String> = [')[1].split(']')[0];
    assert.ok(scoped.includes('thalassa_private_comfort_pending_v1'));
    assert.ok(!exact.includes('thalassa_private_comfort_pending_v1'));
});

test('altered project or storage baseline is refused instead of normalized', () => {
    assert.throws(() => expectedNativeProject141(Buffer.concat([baselineProject, Buffer.from('\n')])));
    assert.throws(() => expectedNativeStorage141(Buffer.concat([baselineStorage, Buffer.from('\n')])));
    assert.throws(fixture({ baselineStorage: capturedStorage }));
});

test('missing permitted files and all Watch, signing, other native or untracked additions are refused', () => {
    for (const names of [
        [],
        [NATIVE_PROJECT141],
        [NATIVE_STORAGE141],
        [NATIVE_PROJECT141, NATIVE_STORAGE141, 'ios/App/ThalassaWatch Watch App/Models/AnchorSnapshot.swift'],
        [NATIVE_PROJECT141, NATIVE_STORAGE141, 'ios/WatchApp/Views/AnchorWatchView.swift'],
        [NATIVE_PROJECT141, NATIVE_STORAGE141, 'ios/App/App/App.entitlements'],
        [NATIVE_PROJECT141, NATIVE_STORAGE141, 'ios/App/Podfile.lock'],
    ])
        assert.throws(fixture({ names }));
    assert.throws(fixture({ dirty: true }));
    assert.throws(fixture({ untracked: 'ios/App/Unreviewed.swift\n' }));
});

test('CLI requires a frozen full source SHA and rejects a mismatched checkout before native reads', () => {
    for (const source of [undefined, '', 'HEAD', '04c9b8f', 'a'.repeat(39), 'A'.repeat(40), 'a'.repeat(41)])
        assert.throws(() => verifyNative141('.', source));
    let calls = 0;
    assert.throws(
        () =>
            verifyNative141('.', 'a'.repeat(40), (_command, args) => {
                calls++;
                assert.deepEqual(args, ['-C', '.', 'rev-parse', 'HEAD']);
                return 'b'.repeat(40) + '\n';
            }),
        /Checkout does not match frozen unsigned workflow source/,
    );
    assert.equal(calls, 1);
});
