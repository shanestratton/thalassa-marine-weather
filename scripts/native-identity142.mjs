import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const NATIVE_BASE141 = 'fcec205f016867bc6ba03aa8ef8d485191ec25ba';
export const NATIVE_PROJECT142 = 'ios/App/App.xcodeproj/project.pbxproj';
export const NATIVE_GRIB142 = 'ios/App/App/GribDocumentPlugin.swift';
export const NATIVE_INFO142 = 'ios/App/App/Info.plist';
export const NATIVE_STORAGE142 = 'ios/App/App/EncryptedLargeStoragePlugin.swift';
export const NATIVE_PROJECT141_SHA256 = 'c28791d3dffa4eca9ae0cfd58975c539e6aaf26085956f1fe7334de2f9598807';
export const NATIVE_PROJECT142_SHA256 = 'c87b07a4acf6197167f1f447cc50133a3ba29ef9d2aff4e541ff5ce87ccfe4d2';
export const NATIVE_GRIB142_SHA256 = '25e07fed34fba9f91bf8bbd88f5d013c32650ca7aec7e9e05c5024d1e8b4f625';
export const NATIVE_INFO142_SHA256 = '362aaf4c1dd15e2cd573b069364c2201fdc0897aaecd9ffc175169d5b44ce5d1';
export const NATIVE_STORAGE141_SHA256 = '4ea0cc0256b05685ce467145dd6cabb8b1def7047ffd5a176b9279be3e7d9466';
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Derive only the four build fields from the immutable reviewed141 project. */
export function expectedNativeProject142(baseline) {
    assert.equal(digest(baseline), NATIVE_PROJECT141_SHA256, 'Unreviewed141 native project baseline');
    const text = baseline.toString('utf8');
    const builds = [...text.matchAll(/CURRENT_PROJECT_VERSION = (\d+);/g)];
    assert.equal(builds.length, 4, 'Expected exactly four141 configurations');
    assert.ok(
        builds.every((match) => match[1] === '141'),
        'Unexpected141 build identity',
    );
    const expected = Buffer.from(text.replaceAll('CURRENT_PROJECT_VERSION = 141;', 'CURRENT_PROJECT_VERSION = 142;'));
    assert.equal(digest(expected), NATIVE_PROJECT142_SHA256);
    return expected;
}

/** The chart picker/copy and UTI additions are exact reviewed bytes, not a broad native exception. */
export function assertNative142(read = readFileSync, git = execFileSync) {
    const names = git('git', ['diff', '--name-only', '--no-renames', NATIVE_BASE141, 'HEAD', '--', 'ios/'], {
        encoding: 'utf8',
    })
        .trim()
        .split('\n')
        .filter(Boolean);
    assert.deepEqual(
        names,
        [NATIVE_PROJECT142, NATIVE_GRIB142, NATIVE_INFO142],
        'Native142 exceeds the exact three-file policy',
    );
    const project = expectedNativeProject142(git('git', ['show', `${NATIVE_BASE141}:${NATIVE_PROJECT142}`]));
    assert.ok(read(NATIVE_PROJECT142).equals(project), 'Native project differs from exact four141-to142 changes');
    assert.equal(
        digest(read(NATIVE_GRIB142)),
        NATIVE_GRIB142_SHA256,
        'Chart/GRIB native source differs from the reviewed picker/copy implementation',
    );
    assert.equal(
        digest(read(NATIVE_INFO142)),
        NATIVE_INFO142_SHA256,
        'Native UTI declarations differ from the reviewed local chart formats',
    );
    const storage = git('git', ['show', `${NATIVE_BASE141}:${NATIVE_STORAGE142}`]);
    assert.equal(digest(storage), NATIVE_STORAGE141_SHA256, 'Unreviewed141 encrypted storage baseline');
    assert.ok(read(NATIVE_STORAGE142).equals(storage), 'Encrypted storage must remain byte-identical to141');
    git('git', ['diff', '--exit-code', 'HEAD', '--', 'ios/'], { stdio: 'pipe' });
    const untracked = git('git', ['ls-files', '--others', '--exclude-standard', '--', 'ios/'], { encoding: 'utf8' });
    assert.equal(untracked.trim(), '', 'Untracked native source is not reviewed');
    return {
        base: NATIVE_BASE141,
        baselineProjectSha256: NATIVE_PROJECT141_SHA256,
        changedFiles: names,
        buildChanges: 4,
        projectSha256: digest(project),
        gribPluginSha256: NATIVE_GRIB142_SHA256,
        infoSha256: NATIVE_INFO142_SHA256,
        storageSha256: digest(storage),
        appBuild: 142,
        allOtherTrackedIosBytesUnchanged: true,
        compiled: false,
    };
}

export function verifyNative142(repository, expectedSource, execute = execFileSync) {
    assert.ok(
        repository && /^[0-9a-f]{40}$/.test(expectedSource ?? ''),
        'Pass repository and reviewed full source SHA',
    );
    const git = (command, args, options = {}) =>
        execute(command, ['-C', repository, ...args], { ...options, maxBuffer: 4 * 1024 * 1024 });
    const source = git('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    assert.equal(source, expectedSource, 'Checkout does not match frozen unsigned workflow source');
    return { source, ...assertNative142((file) => readFileSync(path.join(repository, file)), git) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const [repository, expectedSource, ...extra] = process.argv.slice(2);
    assert.equal(extra.length, 0, 'Unexpected native guard arguments');
    console.log(JSON.stringify(verifyNative142(repository, expectedSource)));
}
