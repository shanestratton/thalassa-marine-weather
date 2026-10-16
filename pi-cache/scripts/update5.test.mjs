import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
    verifyBundle,
    verifyArchiveInventory,
    assertWatchIdle,
    sha256,
    inside,
    update5NativeBuild,
} from './update5.mjs';
import { stageUpdate5 } from './stage-update5.mjs';
const members = ['manifest.json', 'source.tar.gz', 'install.mjs', 'rollback.mjs', 'update5.mjs'];
function fixture() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thalassa-update5-test-'));
    const payload = Buffer.from('A fictional source archive; no live Pi data');
    const manifest = {
        schema: 1,
        update: 5,
        appBuild: 133,
        sourceCommit: 'a'.repeat(40),
        guardVersion: 1,
        payloadSha256: sha256(payload),
        sourceFiles: ['pi-cache/src/server.ts', 'pi-cache/package.json'],
    };
    fs.writeFileSync(path.join(dir, 'source.tar.gz'), payload);
    for (const [source, dest] of [
        ['install-update5.mjs', 'install.mjs'],
        ['rollback-update5.mjs', 'rollback.mjs'],
        ['update5.mjs', 'update5.mjs'],
    ])
        fs.copyFileSync(new URL(source, import.meta.url), path.join(dir, dest));
    const write = () => {
        fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
        fs.writeFileSync(
            path.join(dir, 'SHA256SUMS'),
            members.map((name) => `${sha256(fs.readFileSync(path.join(dir, name)))}  ${name}`).join('\n') + '\n',
        );
    };
    write();
    return {
        dir,
        manifest,
        write,
        close: () => {
            inside(os.tmpdir(), dir);
            fs.rmSync(dir, { recursive: true, force: true });
        },
    };
}
test('a complete frozen source bundle verifies and its installer defaults to a read-only plan', () => {
    const f = fixture();
    try {
        assert.equal(verifyBundle(f.dir).sourceCommit, 'a'.repeat(40));
        const before = fs.readdirSync(f.dir).sort();
        const result = JSON.parse(
            execFileSync(process.execPath, [path.join(f.dir, 'install.mjs')], { encoding: 'utf8' }),
        );
        assert.match(result.mode, /PLAN ONLY/);
        assert.deepEqual(fs.readdirSync(f.dir).sort(), before);
    } finally {
        f.close();
    }
});

test('update 5 requires four equal reviewed native builds and rejects unsupported manifest builds', () => {
    const project = (values) => values.map((build) => `CURRENT_PROJECT_VERSION = ${build};`).join('\n');
    for (const build of [133, 134]) assert.equal(update5NativeBuild(project(Array(4).fill(build))), build);
    for (const values of [
        [133, 133, 134, 134],
        [134, 134, 134],
        Array(5).fill(134),
        Array(4).fill(132),
        Array(4).fill(135),
    ])
        assert.throws(() => update5NativeBuild(project(values)), /four matching native/);
    const f = fixture();
    try {
        for (const build of [133, 134]) {
            f.manifest.appBuild = build;
            f.write();
            assert.equal(verifyBundle(f.dir).appBuild, build);
        }
        for (const build of [132, 135, '134', null]) {
            f.manifest.appBuild = build;
            f.write();
            assert.throws(() => verifyBundle(f.dir), /Invalid update-5 manifest/);
        }
    } finally {
        f.close();
    }
});

test('both reviewed frozen builds stage and the archived installer verifies the matching read-only plan', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'thalassa-update5-stage-'));
    try {
        for (const build of [133, 134]) {
            const repository = path.join(root, `source-${build}`),
                output = path.join(root, `bundle-${build}`);
            fs.mkdirSync(repository);
            const write = (file, content) => {
                const target = path.join(repository, file);
                fs.mkdirSync(path.dirname(target), { recursive: true });
                fs.writeFileSync(target, content);
            };
            const git = (args, input) =>
                execFileSync('git', ['-C', repository, '-c', 'core.autocrlf=false', ...args], {
                    encoding: 'utf8',
                    input,
                }).trim();
            git(['init', '--quiet']);
            write(
                'ios/App/App.xcodeproj/project.pbxproj',
                Array(4).fill(`CURRENT_PROJECT_VERSION = ${build};`).join('\n'),
            );
            for (const name of [
                'server',
                'polarLearner',
                'underwayWatch',
                'updateMaintenance',
                'barometer',
                'vault/vaultService',
            ])
                write(`pi-cache/src/${name}.ts`, '// Fictional frozen-source fixture only.\n');
            for (const name of ['package.json', 'package-lock.json']) write(`pi-cache/${name}`, '{}\n');
            for (const name of ['stage-update5.mjs', 'install-update5.mjs', 'rollback-update5.mjs', 'update5.mjs'])
                write(`pi-cache/scripts/${name}`, fs.readFileSync(new URL(name, import.meta.url)));
            git(['add', '--', 'ios', 'pi-cache']);
            const tree = git(['write-tree']);
            // A temporary fixture commit object only: no application branch, commit or remote is changed.
            const commit = git(
                ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit-tree', tree],
                'Synthetic frozen update-5 fixture\n',
            );
            // Staging must use the frozen native metadata and tracked payload, never these later working files.
            write('ios/App/App.xcodeproj/project.pbxproj', Array(4).fill('CURRENT_PROJECT_VERSION = 135;').join('\n'));
            write('pi-cache/cache/not-for-release.json', '{"fixture":"untracked runtime data"}\n');
            const staged = stageUpdate5({ repository, commit, output });
            assert.equal(staged.commit, commit);
            const manifest = verifyBundle(output);
            assert.equal(manifest.appBuild, build);
            assert.equal(manifest.sourceCommit, commit);
            assert.ok(manifest.sourceFiles.includes('pi-cache/src/polarLearner.ts'));
            assert.ok(!manifest.sourceFiles.some((file) => file.includes('/cache/')));
            const before = fs.readdirSync(output).sort();
            const plan = JSON.parse(
                execFileSync(process.execPath, [path.join(output, 'install.mjs')], { encoding: 'utf8' }),
            );
            assert.match(plan.mode, /PLAN ONLY/);
            assert.equal(plan.manifest.appBuild, build);
            assert.equal(plan.manifest.sourceCommit, commit);
            assert.deepEqual(fs.readdirSync(output).sort(), before);
        }
    } finally {
        inside(os.tmpdir(), root);
        fs.rmSync(root, { recursive: true, force: true });
    }
});
test('any changed payload or helper byte fails checksum verification', () => {
    for (const name of ['source.tar.gz', 'install.mjs', 'rollback.mjs', 'update5.mjs']) {
        const f = fixture();
        try {
            fs.appendFileSync(path.join(f.dir, name), 'changed');
            assert.throws(() => verifyBundle(f.dir), /Checksum mismatch/);
        } finally {
            f.close();
        }
    }
});
test('runtime secrets, chart assets and traversal paths cannot enter the source manifest', () => {
    for (const name of [
        'pi-cache/.env',
        'pi-cache/cache/private.json',
        'pi-cache/identity/key.pem',
        'pi-cache/enc-charts/cell.oesu',
        'pi-cache/../outside',
    ]) {
        const f = fixture();
        try {
            f.manifest.sourceFiles.push(name);
            f.write();
            assert.throws(() => verifyBundle(f.dir), /source boundary/);
        } finally {
            f.close();
        }
    }
});
test('checksum inventory cannot read outside the bundle or omit a helper', () => {
    const f = fixture();
    try {
        fs.writeFileSync(path.join(f.dir, 'SHA256SUMS'), `${'0'.repeat(64)}  ../outside\n`);
        assert.throws(() => verifyBundle(f.dir), /checksum inventory/);
        assert.throws(() => inside(f.dir, path.join(f.dir, '..', 'outside')), /escapes/);
        assert.throws(() => inside(f.dir, f.dir), /escapes/);
    } finally {
        f.close();
    }
});
test('active, stale, unknown or persisted anchor leases refuse before an update', () => {
    const now = 1800000000000;
    const status = { version: 1, maintenance: false, anchorRunning: false, sessionExpiresAt: null, observedAt: now };
    assert.doesNotThrow(() => assertWatchIdle(status, null, now));
    for (const patch of [
        { version: 0 },
        { anchorRunning: true },
        { anchorRunning: null },
        { observedAt: now - 5001 },
        { sessionExpiresAt: now + 1 },
    ])
        assert.throws(() => assertWatchIdle({ ...status, ...patch }, null, now));
    assert.throws(() => assertWatchIdle(status, { expiresAt: now - 1, sessionExpiresAt: now + 1000 }, now));
    assert.throws(() => assertWatchIdle(status, {}, now));
    assert.doesNotThrow(() => assertWatchIdle(status, { expiresAt: now - 2, sessionExpiresAt: now - 1 }, now));
});
test('archive links, traversal, missing files and duplicate members fail before extraction', () => {
    const files = ['pi-cache/src/server.ts'];
    const entries = [
        'update5-source/',
        'update5-source/pi-cache/',
        'update5-source/pi-cache/src/',
        'update5-source/pi-cache/src/server.ts',
    ];
    assert.doesNotThrow(() => verifyArchiveInventory(entries, ['drwxr-xr-x directory', '-rw-r--r-- file'], files));
    assert.throws(() => verifyArchiveInventory(entries, ['lrwxr-xr-x link'], files));
    assert.throws(() => verifyArchiveInventory([...entries, '../outside'], ['-rw-r--r-- file'], files));
    assert.throws(() => verifyArchiveInventory(entries.slice(0, -1), ['drwxr-xr-x directory'], files));
    assert.throws(() => verifyArchiveInventory([...entries, entries.at(-1)], ['-rw-r--r-- file'], files));
});
