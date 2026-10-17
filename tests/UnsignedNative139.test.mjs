import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { Buffer } from 'node:buffer';
import os from 'node:os';
import path from 'node:path';
import {
    assertNative139,
    NATIVE_BASE138,
    NATIVE_PROJECT139,
    UNSIGNED_SOURCE139,
    WATCH_FILES139,
    expectedNativeProject139,
} from '../scripts/native-identity139.mjs';
import { assertPublicCopy139 } from '../scripts/public-copy-proof139.mjs';

const yaml = createRequire(import.meta.url)('yaml');
const show = (ref, file) => execFileSync('git', ['show', `${ref}:${file}`]);
// The unchanged original workflow pins57a (before CocoaPods' captured relocation).
// Native policy now requires the reviewed post-sync139 bytes. Keep this historical
// fixture independent of the current checkout's later build number.
const PINNED_NATIVE_SNAPSHOT139 = '5142118666fa1653fef882c2d90c8f690cfb4ff5';
const fixture = (changes = {}) => {
    const names = changes.names ?? [NATIVE_PROJECT139, ...Object.keys(WATCH_FILES139)];
    return () =>
        assertNative139(
            (file) => changes.read?.(file) ?? show(PINNED_NATIVE_SNAPSHOT139, file),
            (_command, args) => {
                if (args[0] === 'show') return show(NATIVE_BASE138, NATIVE_PROJECT139);
                if (args.includes('--name-only')) return names.join('\n') + '\n';
                if (changes.dirty) throw Error('Tracked native mutation');
                return Buffer.alloc(0);
            },
        );
};

test('pinned139 has four build edits, six measured entry relocations and two reviewed Watch files', () => {
    assert.equal(fixture()().appBuild, 139);
    assert.equal(execFileSync('git', ['diff', NATIVE_BASE138, UNSIGNED_SOURCE139, '--', 'ios/WatchApp']).length, 0);
});

test('only the captured post-sync project order is accepted, with every byte and identifier retained', () => {
    const baseline = show(NATIVE_BASE138, NATIVE_PROJECT139).toString('utf8');
    const expected = expectedNativeProject139(baseline);
    assert.ok(expected.equals(show(PINNED_NATIVE_SNAPSHOT139, NATIVE_PROJECT139)));
    const original139 = Buffer.from(
        baseline.replaceAll('CURRENT_PROJECT_VERSION = 138;', 'CURRENT_PROJECT_VERSION = 139;'),
    );
    assert.throws(fixture({ read: (file) => (file === NATIVE_PROJECT139 ? original139 : undefined) }));
    const oldReferences = original139
        .toString()
        .split('/* Begin PBXFileReference section */')[1]
        .split('/* End PBXFileReference section */')[0];
    const partlyMoved = expected
        .toString()
        .replace(
            /(\/\* Begin PBXFileReference section \*\/)[\s\S]*?(\/\* End PBXFileReference section \*\/)/,
            `$1${oldReferences}$2`,
        );
    assert.throws(fixture({ read: (file) => (file === NATIVE_PROJECT139 ? Buffer.from(partlyMoved) : undefined) }));
    assert.throws(() =>
        expectedNativeProject139(baseline.replace('AA0011B1AAAA11B100000001', 'AA0011B1AAAA11B100000099')),
    );
    assert.throws(
        fixture({
            read: (file) =>
                file === NATIVE_PROJECT139
                    ? Buffer.from(expected.toString().replace('path = NfcTagPlugin.m;', 'path = Other.m;'))
                    : undefined,
        }),
    );
});
test('old WatchApp, signing, other native files and missing permitted files are refused', () => {
    for (const names of [
        [NATIVE_PROJECT139],
        [NATIVE_PROJECT139, ...Object.keys(WATCH_FILES139), 'ios/WatchApp/Views/AnchorWatchView.swift'],
        [NATIVE_PROJECT139, ...Object.keys(WATCH_FILES139), 'ios/App/App/App.entitlements'],
    ])
        assert.throws(fixture({ names }));
});
test('Swift, project whitespace/configuration changes and post-sync tracked mutation are refused', () => {
    const watch = Object.keys(WATCH_FILES139)[0];
    assert.throws(
        fixture({
            read: (file) =>
                file === watch ? Buffer.concat([show(PINNED_NATIVE_SNAPSHOT139, file), Buffer.from('\n')]) : undefined,
        }),
    );
    assert.throws(
        fixture({
            read: (file) =>
                file === NATIVE_PROJECT139
                    ? Buffer.concat([show(PINNED_NATIVE_SNAPSHOT139, file), Buffer.from('\n')])
                    : undefined,
        }),
    );
    assert.throws(
        fixture({
            read: (file) =>
                file === NATIVE_PROJECT139
                    ? Buffer.from(
                          show(PINNED_NATIVE_SNAPSHOT139, file)
                              .toString()
                              .replace('CURRENT_PROJECT_VERSION = 139;', 'CURRENT_PROJECT_VERSION = 138;'),
                      )
                    : undefined,
        }),
    );
    assert.throws(fixture({ dirty: true }));
});

test('workflow is owner-only bounded-trigger unsigned compile, fixed source and public vars only', () => {
    const text = readFileSync('.github/workflows/unsigned-native-139.yml', 'utf8');
    const workflow = yaml.parse(text),
        job = workflow.jobs.unsigned;
    assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch', 'push']);
    assert.deepEqual(workflow.on.push, {
        branches: ['codex/build-139-unsigned-native'],
        paths: ['.github/workflows/unsigned-native-139.yml'],
    });
    assert.deepEqual(workflow.permissions, { contents: 'read' });
    const actionLines = text.split('\n').filter((line) => /\buses:\s*actions\//.test(line));
    assert.equal(actionLines.length, 4);
    assert.ok(actionLines.every((line) => /@[a-f0-9]{40}\s+# v\d+\.\d+\.\d+$/.test(line)));
    assert.equal(job['runs-on'], 'macos-26');
    assert.equal(job.env.DEVELOPER_DIR, '/Applications/Xcode_26.6.app/Contents/Developer');
    assert.equal(job.env.VITE_APP_BUILD, '139');
    const toolchain = job.steps.find((step) => step.name === 'Prove exact native source and toolchain').run;
    assert.equal((toolchain.match(/xcodebuild -version/g) ?? []).length, 1);
    assert.doesNotMatch(toolchain, /(?:xcodebuild -version|node --version)[^\n]*\|/);
    assert.match(toolchain, /grep -q '\^Xcode 26\\\.6\$' "\$RUNNER_TEMP\/native139-evidence\/toolchain\.txt"/);
    assert.match(job.if, /github.actor == 'shanestratton'/);
    assert.match(job.if, /github.ref == 'refs\/heads\/codex\/build-139-unsigned-native'/);
    assert.doesNotMatch(
        text,
        /secrets\.|ASC_|IOS_DEV_CERT|allowProvisioningUpdates|authenticationKey|exportArchive|archivePath|sourcemaps:upload|altool|notarytool/,
    );
    assert.equal(job.steps.filter((step) => step.with?.ref === UNSIGNED_SOURCE139).length, 1);
    const copyStep = job.steps.find((step) => step.name === 'Build production web and sync Capacitor');
    assert.match(copyStep.run, /npm run ship:beta/);
    assert.match(copyStep.run, /native-identity139/);
    for (const name of ['Compile unsigned iOS Simulator', 'Compile unsigned actual Watch target']) {
        const run = job.steps.find((step) => step.name === name).run;
        assert.match(run, /CODE_SIGNING_ALLOWED=NO build/);
        assert.doesNotMatch(run, /(?:^|\s)archive(?:\s|$)/);
    }
    assert.match(
        job.steps.find((step) => step.name === 'Compile unsigned iOS Simulator').run,
        /generic\/platform=iOS Simulator/,
    );
    assert.match(
        job.steps.find((step) => step.name === 'Compile unsigned actual Watch target').run,
        /-target 'ThalassaWatch Watch App'/,
    );
    const artifact = job.steps.filter((step) => step.uses?.startsWith('actions/upload-artifact@'));
    assert.equal(artifact.length, 1);
    assert.deepEqual(artifact[0].with.path.trim().split('\n'), [
        '${{ runner.temp }}/native139-evidence/*.txt',
        '${{ runner.temp }}/native139-evidence/*.json',
    ]);
    assert.equal(artifact[0].if, 'always()');
    for (const value of Object.values(job.env).filter((value) => String(value).includes('${{')))
        assert.match(value, /^\$\{\{ vars\.VITE_[A-Z_]+ \}\}$/);
});

test('public copy proves exact HTML/assets and refuses missing, corrupt, map or native extras', async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'native139-copy-test-'));
    const source = path.join(temp, 'dist'),
        copy = path.join(temp, 'public');
    try {
        await fs.mkdir(path.join(source, 'assets'), { recursive: true });
        for (const [name, text] of [
            ['index.html', '<html>Index exact inert data</html>'],
            ['logs.html', '<html>Logs</html>'],
            ['assets/x.js', 'export const exact = 1;'],
        ])
            await fs.writeFile(path.join(source, name), text);
        await fs.cp(source, copy, { recursive: true });
        await fs.writeFile(path.join(copy, 'cordova.js'), '');
        const proof = await assertPublicCopy139(source, copy);
        assert.equal(proof.sourceFiles, 3);
        assert.equal(proof.added.length, 1);
        await fs.writeFile(path.join(copy, 'index.html'), 'stale');
        await assert.rejects(assertPublicCopy139(source, copy), /Public copy differs/);
        await fs.copyFile(path.join(source, 'index.html'), path.join(copy, 'index.html'));
        for (const name of ['assets/x.js.map', 'x.ipa', 'unexpected.txt']) {
            await fs.writeFile(path.join(copy, name), 'fixture');
            await assert.rejects(assertPublicCopy139(source, copy));
            await fs.unlink(path.join(copy, name));
        }
        await fs.unlink(path.join(copy, 'logs.html'));
        await assert.rejects(assertPublicCopy139(source, copy), /Public copy differs/);
    } finally {
        await fs.rm(temp, { recursive: true, force: true });
    }
});

test('native logger retains at most2MiB and propagates failure exit status', async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'native139-log-test-'));
    try {
        const log = path.join(temp, 'bounded.txt');
        const result = spawnSync(
            process.execPath,
            [
                'scripts/bounded-native-log139.mjs',
                log,
                process.execPath,
                '-e',
                "process.stdout.write('x'.repeat(3*1024*1024));process.stderr.write('END');process.exitCode=7",
            ],
            { maxBuffer: 128 * 1024 },
        );
        assert.equal(result.status, 7);
        const bytes = await fs.readFile(log);
        assert.equal(bytes.length, 2 * 1024 * 1024);
        assert.ok(bytes.includes(Buffer.from('END')));
        assert.ok(result.stdout.length < 128 * 1024);
    } finally {
        await fs.rm(temp, { recursive: true, force: true });
    }
});
