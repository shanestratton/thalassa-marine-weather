import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const NATIVE_BASE138 = '8e6edf36a0c0514c252c347b68e7bb86cc7e0da9';
export const UNSIGNED_SOURCE139 = '4a957d6939fccbfbc0e41a76903928c628aa419e';
export const NATIVE_PROJECT139 = 'ios/App/App.xcodeproj/project.pbxproj';
export const WATCH_FILES139 = Object.freeze({
    'ios/App/ThalassaWatch Watch App/Models/AnchorSnapshot.swift':
        'a528ca73ce74e7a614caf5eb282af6e733077e4780393b6bfe670cce3786587a',
    'ios/App/ThalassaWatch Watch App/Views/AnchorWatchView.swift':
        '356b06d7ebe9ea91b1f045409661e0af23f69bafde7fee1930bfa363a95d69fa',
});
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Reproduce only the six existing entry relocations measured after CocoaPods sync.
 * This transforms the immutable138 baseline; the candidate itself is never
 * normalized and must match every resulting byte exactly. */
export function expectedNativeProject139(oldText) {
    let text = oldText.replaceAll('CURRENT_PROJECT_VERSION = 138;', 'CURRENT_PROJECT_VERSION = 139;');
    for (const [section, suffix] of [
        ['PBXBuildFile', '1'],
        ['PBXFileReference', '2'],
    ]) {
        const begin = `/* Begin ${section} section */`,
            end = `/* End ${section} section */`;
        const start = text.indexOf(begin),
            finish = text.indexOf(end);
        assert.ok(start >= 0 && finish > start && text.indexOf(begin, start + 1) < 0);
        const body = text.slice(start, finish),
            lines = body.split('\n');
        const ids = [
            `AA0011B1AAAA11B10000000${suffix}`,
            `AA0011B2AAAA11B20000000${suffix}`,
            `B3A10001202608040000000${suffix}`,
        ];
        const moved = ids.map((id) => {
            const matching = lines.filter((line) => line.startsWith(`\t\t${id} /*`));
            assert.equal(matching.length, 1, 'Expected one original NFC/privacy entry');
            return matching[0];
        });
        const first = lines.indexOf(moved[0]);
        assert.deepEqual(lines.slice(first, first + 3), moved, 'Unexpected138 NFC/privacy ordering');
        const remaining = lines.filter((line) => !moved.includes(line));
        const anchors = remaining
            .map((line, index) => (line.startsWith(`\t\tAA000039AAAA00390000000${suffix} /*`) ? index : -1))
            .filter((index) => index >= 0);
        assert.equal(anchors.length, 1, 'Expected original NmeaUdpRebindGate entry');
        remaining.splice(anchors[0] + 1, 0, ...moved);
        text = text.slice(0, start) + remaining.join('\n') + text.slice(finish);
    }
    return Buffer.from(text);
}

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
    const expected = expectedNativeProject139(oldText);
    assert.ok(
        read(NATIVE_PROJECT139).equals(expected),
        'Native project exceeds four build declarations and six reviewed entry relocations',
    );
    for (const [file, hash] of Object.entries(WATCH_FILES139))
        assert.equal(digest(read(file)), hash, `Unreviewed Watch source: ${file}`);
    git('git', ['diff', '--exit-code', 'HEAD', '--', 'ios/'], { stdio: 'pipe' });
    return {
        base: NATIVE_BASE138,
        changedFiles: names,
        buildChanges: 4,
        reviewedEntryRelocations: 6,
        projectSha256: digest(expected),
        appBuild: 139,
        watchFiles: WATCH_FILES139,
    };
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
