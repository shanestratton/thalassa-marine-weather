import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const NATIVE_BASE138 = 'e4722dfc5eea78e2a2af8ffd83134da06ce301e0';
export const UNSIGNED_SOURCE139 = '57a5d8eb02b4aa4c7a8f2117c0dcaa1cf5d5932e';
export const NATIVE_PROJECT139 = 'ios/App/App.xcodeproj/project.pbxproj';
export const WATCH_FILES139 = Object.freeze({
    'ios/App/ThalassaWatch Watch App/Models/AnchorSnapshot.swift':
        'a528ca73ce74e7a614caf5eb282af6e733077e4780393b6bfe670cce3786587a',
    'ios/App/ThalassaWatch Watch App/Views/AnchorWatchView.swift':
        '356b06d7ebe9ea91b1f045409661e0af23f69bafde7fee1930bfa363a95d69fa',
});
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Exact native policy, also reusable by the separately unarmed release draft.
 * The two reviewed files belong to the synchronized compiled Watch target.
 * The historical ios/WatchApp tree has no exception. */
export function assertNative139(read = readFileSync, git = execFileSync) {
    const names = git('git', ['diff', '--name-only', '--no-renames', NATIVE_BASE138, 'HEAD', '--', 'ios/'], {
        encoding: 'utf8',
    })
        .trim()
        .split('\n')
        .filter(Boolean);
    assert.deepEqual(names, [NATIVE_PROJECT139, ...Object.keys(WATCH_FILES139)]);
    const oldText = git('git', ['show', `${NATIVE_BASE138}:${NATIVE_PROJECT139}`]).toString('utf8');
    const oldBuilds = [...oldText.matchAll(/CURRENT_PROJECT_VERSION = (\d+);/g)];
    assert.equal(oldBuilds.length, 4, 'Expected exactly four138 configurations');
    assert.ok(
        oldBuilds.every((m) => m[1] === '138'),
        'Unexpected138 identity',
    );
    const expected = Buffer.from(
        oldText.replaceAll('CURRENT_PROJECT_VERSION = 138;', 'CURRENT_PROJECT_VERSION = 139;'),
    );
    assert.ok(read(NATIVE_PROJECT139).equals(expected), 'Native project exceeds four138→139 declarations');
    for (const [file, hash] of Object.entries(WATCH_FILES139))
        assert.equal(digest(read(file)), hash, `Unreviewed Watch source: ${file}`);
    git('git', ['diff', '--exit-code', 'HEAD', '--', 'ios/'], { stdio: 'pipe' });
    return { base: NATIVE_BASE138, changedFiles: names, buildChanges: 4, appBuild: 139, watchFiles: WATCH_FILES139 };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const [repository, ...extra] = process.argv.slice(2);
    assert.ok(repository && !extra.length, 'Pass the exact checked-out source repository');
    const git = (command, args, options = {}) =>
        execFileSync(command, ['-C', repository, ...args], { ...options, maxBuffer: 4 * 1024 * 1024 });
    assert.equal(git('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), UNSIGNED_SOURCE139);
    console.log(
        JSON.stringify({
            source: UNSIGNED_SOURCE139,
            ...assertNative139((file) => readFileSync(path.join(repository, file)), git),
        }),
    );
}
