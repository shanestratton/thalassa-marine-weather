import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const NATIVE_BASE139 = '5142118666fa1653fef882c2d90c8f690cfb4ff5';
export const NATIVE_PROJECT140 = 'ios/App/App.xcodeproj/project.pbxproj';
export const NATIVE_PROJECT139_SHA256 = 'b009890f567b7ce56c4db012a9f9ed42549f19d3dfc07a1ce853073c581b1918';
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Transform only the immutable, reviewed139 baseline, never the candidate. */
export function expectedNativeProject140(baseline) {
    assert.equal(digest(baseline), NATIVE_PROJECT139_SHA256, 'Unreviewed139 native baseline');
    const text = baseline.toString('utf8');
    const builds = [...text.matchAll(/CURRENT_PROJECT_VERSION = (\d+);/g)];
    assert.equal(builds.length, 4, 'Expected exactly four139 configurations');
    assert.ok(
        builds.every((match) => match[1] === '139'),
        'Unexpected139 build identity',
    );
    return Buffer.from(text.replaceAll('CURRENT_PROJECT_VERSION = 139;', 'CURRENT_PROJECT_VERSION = 140;'));
}

/** No Watch, signing, target, file-order or other iOS source exception. */
export function assertNative140(read = readFileSync, git = execFileSync) {
    const names = git('git', ['diff', '--name-only', '--no-renames', NATIVE_BASE139, 'HEAD', '--', 'ios/'], {
        encoding: 'utf8',
    })
        .trim()
        .split('\n')
        .filter(Boolean);
    assert.deepEqual(names, [NATIVE_PROJECT140], 'Only the four-field native project version change is permitted');
    const baseline = git('git', ['show', `${NATIVE_BASE139}:${NATIVE_PROJECT140}`]);
    const expected = expectedNativeProject140(baseline);
    assert.ok(read(NATIVE_PROJECT140).equals(expected), 'Native project differs from exact four139-to140 changes');
    // The committed diff above protects every tracked iOS byte against the139
    // snapshot. Also refuse staged/working-tree and untracked native additions.
    git('git', ['diff', '--exit-code', 'HEAD', '--', 'ios/'], { stdio: 'pipe' });
    const untracked = git('git', ['ls-files', '--others', '--exclude-standard', '--', 'ios/'], { encoding: 'utf8' });
    assert.equal(untracked.trim(), '', 'Untracked native source is not reviewed');
    return {
        base: NATIVE_BASE139,
        baselineProjectSha256: NATIVE_PROJECT139_SHA256,
        changedFiles: names,
        buildChanges: 4,
        projectSha256: digest(expected),
        appBuild: 140,
        allOtherTrackedIosBytesUnchanged: true,
    };
}

export function verifyNative140(repository, expectedSource, execute = execFileSync) {
    assert.ok(
        repository && /^[0-9a-f]{40}$/.test(expectedSource ?? ''),
        'Pass repository and reviewed full source SHA',
    );
    const git = (command, args, options = {}) =>
        execute(command, ['-C', repository, ...args], { ...options, maxBuffer: 4 * 1024 * 1024 });
    const source = git('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    assert.equal(source, expectedSource, 'Checkout does not match frozen unsigned workflow source');
    return { source, ...assertNative140((file) => readFileSync(path.join(repository, file)), git) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const [repository, expectedSource, ...extra] = process.argv.slice(2);
    assert.equal(extra.length, 0, 'Unexpected native guard arguments');
    console.log(JSON.stringify(verifyNative140(repository, expectedSource)));
}
