import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const NATIVE_BASE140 = '3ec8cae33754dd7bdf12ca2eb58695870bdb5686';
export const NATIVE_PROJECT141 = 'ios/App/App.xcodeproj/project.pbxproj';
export const NATIVE_STORAGE141 = 'ios/App/App/EncryptedLargeStoragePlugin.swift';
export const NATIVE_PROJECT140_SHA256 = 'a600f428fd294e3c9ece7025e05740d19439bd1f85a40bf9b0dca892073716e1';
export const NATIVE_STORAGE140_SHA256 = '7854905560ea11a0b44e06701a948c44abdbe9d2cc4da27e6b3207ca085e4c32';
export const NATIVE_PROJECT141_SHA256 = 'c28791d3dffa4eca9ae0cfd58975c539e6aaf26085956f1fe7334de2f9598807';
export const NATIVE_STORAGE141_SHA256 = '4ea0cc0256b05685ce467145dd6cabb8b1def7047ffd5a176b9279be3e7d9466';
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Derive from the immutable140 baseline; never normalize the candidate. */
export function expectedNativeProject141(baseline) {
    assert.equal(digest(baseline), NATIVE_PROJECT140_SHA256, 'Unreviewed140 native project baseline');
    const text = baseline.toString('utf8');
    const builds = [...text.matchAll(/CURRENT_PROJECT_VERSION = (\d+);/g)];
    assert.equal(builds.length, 4, 'Expected exactly four140 configurations');
    assert.ok(
        builds.every((match) => match[1] === '140'),
        'Unexpected140 build identity',
    );
    const expected = Buffer.from(text.replaceAll('CURRENT_PROJECT_VERSION = 140;', 'CURRENT_PROJECT_VERSION = 141;'));
    assert.equal(digest(expected), NATIVE_PROJECT141_SHA256);
    return expected;
}

/** The one reviewed addition is an account-scoped encrypted pending queue key. */
export function expectedNativeStorage141(baseline) {
    assert.equal(digest(baseline), NATIVE_STORAGE140_SHA256, 'Unreviewed140 native storage baseline');
    const text = baseline.toString('utf8');
    const anchor = '    private let scopedBaseKeys: Set<String> = [\n';
    const insertion = '        "thalassa_private_comfort_pending_v1",\n';
    assert.equal(text.split(anchor).length - 1, 1, 'Expected one scoped native key set');
    assert.equal(text.includes('thalassa_private_comfort_pending_v1'), false, 'Unexpected pre-existing comfort key');
    const expected = Buffer.from(text.replace(anchor, anchor + insertion));
    assert.equal(digest(expected), NATIVE_STORAGE141_SHA256);
    return expected;
}

export function assertNative141(read = readFileSync, git = execFileSync) {
    const names = git('git', ['diff', '--name-only', '--no-renames', NATIVE_BASE140, 'HEAD', '--', 'ios/'], {
        encoding: 'utf8',
    })
        .trim()
        .split('\n')
        .filter(Boolean);
    assert.deepEqual(names, [NATIVE_PROJECT141, NATIVE_STORAGE141], 'Native141 exceeds the exact two-file policy');
    const project = expectedNativeProject141(git('git', ['show', `${NATIVE_BASE140}:${NATIVE_PROJECT141}`]));
    const storage = expectedNativeStorage141(git('git', ['show', `${NATIVE_BASE140}:${NATIVE_STORAGE141}`]));
    assert.ok(read(NATIVE_PROJECT141).equals(project), 'Native project differs from exact four140-to141 changes');
    assert.ok(
        read(NATIVE_STORAGE141).equals(storage),
        'Native storage differs from the single reviewed scoped key insertion',
    );
    git('git', ['diff', '--exit-code', 'HEAD', '--', 'ios/'], { stdio: 'pipe' });
    const untracked = git('git', ['ls-files', '--others', '--exclude-standard', '--', 'ios/'], { encoding: 'utf8' });
    assert.equal(untracked.trim(), '', 'Untracked native source is not reviewed');
    return {
        base: NATIVE_BASE140,
        baselineProjectSha256: NATIVE_PROJECT140_SHA256,
        baselineStorageSha256: NATIVE_STORAGE140_SHA256,
        changedFiles: names,
        buildChanges: 4,
        scopedStorageKeyInsertions: 1,
        projectSha256: digest(project),
        storageSha256: digest(storage),
        appBuild: 141,
        allOtherTrackedIosBytesUnchanged: true,
    };
}

export function verifyNative141(repository, expectedSource, execute = execFileSync) {
    assert.ok(
        repository && /^[0-9a-f]{40}$/.test(expectedSource ?? ''),
        'Pass repository and reviewed full source SHA',
    );
    const git = (command, args, options = {}) =>
        execute(command, ['-C', repository, ...args], { ...options, maxBuffer: 4 * 1024 * 1024 });
    const source = git('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    assert.equal(source, expectedSource, 'Checkout does not match frozen unsigned workflow source');
    return { source, ...assertNative141((file) => readFileSync(path.join(repository, file)), git) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const [repository, expectedSource, ...extra] = process.argv.slice(2);
    assert.equal(extra.length, 0, 'Unexpected native guard arguments');
    console.log(JSON.stringify(verifyNative141(repository, expectedSource)));
}
