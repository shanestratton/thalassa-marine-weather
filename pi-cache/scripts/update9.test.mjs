import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { Buffer } from 'node:buffer';
import { bundleFixture } from './update9Fixture.mjs';
import { stageUpdate9 } from './stage-update9.mjs';
import {
    assertWatchIdle,
    CODE,
    UPDATE9_NUMBER,
    verifyBundle,
    sha256,
    update9NativeBuild,
    update9RollbackBackup,
    verifyArchiveInventory,
    validateUpdate9SourceFiles,
} from './update9.mjs';
test('Pi9 plan verifies bounded synthetic source and never installs, activates or includes Pi10 assets', () => {
    const f = bundleFixture();
    try {
        assert.equal(verifyBundle(f.output).update, 9);
        const before = fs.readdirSync(f.output).sort();
        const plan = JSON.parse(
            execFileSync(process.execPath, [path.join(f.output, 'install.mjs')], {
                encoding: 'utf8',
                timeout: 10000,
                maxBuffer: 65536,
            }),
        );
        assert.match(plan.mode, /PLAN ONLY/);
        assert.equal(plan.manifest.appBuild, 141);
        assert.equal(plan.manifest.release.buildBranch, 'b141');
        assert.match(
            execFileSync(process.execPath, [path.join(f.output, 'rollback.mjs')], { encoding: 'utf8' }),
            /PLAN ONLY/,
        );
        if (process.platform !== 'win32')
            for (const name of ['install', 'rollback'])
                assert.match(
                    execFileSync('sh', [path.join(f.output, name + '.sh')], { encoding: 'utf8' }),
                    /PLAN ONLY/,
                );
        assert.deepEqual(fs.readdirSync(f.output).sort(), before);
        for (const name of ['.env', 'cache', 'identity', 'enc-charts', 'reference', 'cabin-dist'])
            assert.ok(!CODE.includes(name));
    } finally {
        f.close();
    }
});
test('Pi9 rejects altered release, runtime, branch, source and private paths even with new checksums', () => {
    for (const edit of [
        (m) => {
            m.update = 8;
        },
        (m) => {
            m.appBuild = 142;
        },
        (m) => {
            m.nodeMajor = 24;
        },
        (m) => {
            m.sourceBranch = 'candidate';
        },
        (m) => {
            m.sourceMasterCommit = 'b'.repeat(40);
        },
        (m) => {
            m.release.buildBranch = 'b142';
        },
        (m) => {
            m.release.buildCommit = 'b'.repeat(40);
        },
        (m) => {
            m.release.origin = 'https://lookalike.invalid';
        },
        (m) => {
            delete m.release.observedAt;
        },
        ...[
            '.env',
            '.env.local',
            'cache/state.json',
            'identity/token',
            'enc-charts/private.oesu',
            'chart.kap',
            'chart.mbtiles',
            'dist/server.js',
            'reference/data.json',
        ].map((name) => (m) => {
            m.sourceFiles.push('pi-cache/' + name);
        }),
    ]) {
        const f = bundleFixture();
        try {
            f.rewrite(edit);
            assert.throws(() => verifyBundle(f.output));
        } finally {
            f.close();
        }
    }
});
test('Pi9 source and helper tampering cannot reach an installer plan', () => {
    for (const member of ['source.tar.gz', 'update9.mjs', 'install.sh', 'rollback.sh']) {
        const f = bundleFixture();
        try {
            fs.appendFileSync(path.join(f.output, member), 'Changed');
            assert.throws(() => verifyBundle(f.output), /Checksum mismatch/);
        } finally {
            f.close();
        }
    }
});
test('Pi9 native identity admits only four matching build141 configurations', () => {
    const project = (a) => a.map((n) => `CURRENT_PROJECT_VERSION = ${n};`).join('\n');
    assert.equal(update9NativeBuild(project([141, 141, 141, 141])), 141);
    for (const a of [
        [140, 140, 140, 140],
        [142, 142, 142, 142],
        [141, 141, 141],
        [141, 141, 141, 140],
    ])
        assert.throws(() => update9NativeBuild(project(a)));
});
test('Pi9 backup record, rollback location and result share update9 identity', () => {
    const f = bundleFixture();
    try {
        const backupRoot = path.join(f.root, 'backups'),
            backup = path.join(backupRoot, 'previous');
        fs.mkdirSync(path.join(backup, 'dist'), { recursive: true });
        fs.writeFileSync(path.join(backup, 'dist/server.js'), '// Prior server\n');
        const good = { schema: 1, update: UPDATE9_NUMBER, backup };
        assert.equal(update9RollbackBackup(good, backupRoot), backup);
        for (const bad of [
            null,
            {},
            { ...good, update: 8 },
            { ...good, update: 10 },
            { ...good, schema: 2 },
            { ...good, backup: f.root },
            { ...good, backup: path.join(backupRoot, 'missing') },
        ])
            assert.throws(() => update9RollbackBackup(bad, backupRoot));
    } finally {
        f.close();
    }
});
test('Pi9 refuses active, unknown, stale and persisted anchor leases', () => {
    const now = 1800000000000,
        idle = { version: 1, maintenance: false, anchorRunning: false, sessionExpiresAt: null, observedAt: now };
    assert.doesNotThrow(() => assertWatchIdle(idle, null, now));
    for (const patch of [
        { anchorRunning: true },
        { anchorRunning: null },
        { observedAt: now - 5001 },
        { sessionExpiresAt: now + 1 },
        { maintenance: null },
    ])
        assert.throws(() => assertWatchIdle({ ...idle, ...patch }, null, now));
    for (const saved of [
        {},
        { sessionExpiresAt: now + 1, expiresAt: now },
        { sessionExpiresAt: now - 1, expiresAt: now },
    ])
        assert.throws(() => assertWatchIdle(idle, saved, now));
});
test('Pi9 source admission precedes copy and refuses links, traversal, duplicate and private contents', () => {
    const files = ['pi-cache/src/server.ts'],
        entries = ['update9-source/pi-cache/src/server.ts'];
    assert.doesNotThrow(() => verifyArchiveInventory(entries, ['- regular'], files));
    for (const invalid of [[], [...entries, ...entries], ['../outside'], ['/outside']])
        assert.throws(() =>
            verifyArchiveInventory(
                invalid,
                invalid.map(() => '- file'),
                files,
            ),
        );
    assert.throws(() => verifyArchiveInventory(entries, ['l link'], files));
    assert.doesNotThrow(() => validateUpdate9SourceFiles(['pi-cache/.env.example', ...files]));
    for (const invalid of [
        [],
        [...files, ...files],
        ['pi-cache/.env.local'],
        ['pi-cache/../outside'],
        ['pi-cache/cache/state.json'],
        ['pi-cache/chart.tif'],
    ])
        assert.throws(() => validateUpdate9SourceFiles(invalid));
});
test('Pi9 rejects a recalculated oversized gzip expansion before any extraction', () => {
    const f = bundleFixture();
    try {
        fs.writeFileSync(path.join(f.output, 'source.tar.gz'), gzipSync(Buffer.alloc(64 * 1024 ** 2 + 512)));
        f.rewrite((m) => {
            m.payloadSha256 = sha256(fs.readFileSync(path.join(f.output, 'source.tar.gz')));
        });
        assert.throws(() => verifyBundle(f.output));
    } finally {
        f.close();
    }
});
test('Pi9 unreleased checkout refuses before output and release network access', () => {
    const f = bundleFixture();
    try {
        const repository = path.join(f.root, 'candidate');
        fs.mkdirSync(repository);
        const git = (args) =>
            execFileSync('git', ['-C', repository, ...args], {
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'pipe'],
            }).trim();
        git(['init', '--quiet']);
        fs.writeFileSync(path.join(repository, 'candidate.txt'), 'Unreleased\n');
        git(['add', '.']);
        git([
            '-c',
            'user.name=Fixture',
            '-c',
            'user.email=fixture@example.invalid',
            '-c',
            'core.hooksPath=NUL',
            'commit',
            '--quiet',
            '-m',
            'Candidate',
        ]);
        const commit = git(['rev-parse', 'HEAD']),
            output = path.join(f.root, 'refused');
        assert.throws(() => stageUpdate9({ repository, commit, output }));
        assert.equal(fs.existsSync(output), false);
        assert.deepEqual(fs.readdirSync(repository).sort(), ['.git', 'candidate.txt']);
    } finally {
        f.close();
    }
});
