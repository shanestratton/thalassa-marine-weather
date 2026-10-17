import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { bundleFixture } from './update10Fixture.mjs';
import { stageUpdate10 } from './stage-update10.mjs';
import {
    assertWatchIdle,
    CODE,
    UPDATE10_NUMBER,
    verifyBundle,
    update10NativeBuild,
    update10RollbackBackup,
    verifyArchiveInventory,
    validateUpdate10SourceFiles,
    stopWithVerifiedCabin,
} from './update10.mjs';

test('synthetic Pi10 install and rollback plans verify separate cabin bytes and never apply', () => {
    const f = bundleFixture();
    try {
        assert.equal(verifyBundle(f.output).update, 10);
        const before = fs.readdirSync(f.output).sort();
        const plan = JSON.parse(
            execFileSync(process.execPath, [path.join(f.output, 'install.mjs')], {
                encoding: 'utf8',
                timeout: 10000,
                maxBuffer: 65536,
            }),
        );
        assert.match(plan.mode, /PLAN ONLY/);
        assert.equal(plan.manifest.appBuild, 142);
        assert.equal(plan.manifest.cabinAssets.length, 2);
        assert.match(
            execFileSync(process.execPath, [path.join(f.output, 'rollback.mjs')], {
                encoding: 'utf8',
                timeout: 10000,
                maxBuffer: 65536,
            }),
            /PLAN ONLY/,
        );
        if (process.platform !== 'win32')
            for (const name of ['install', 'rollback'])
                assert.match(
                    execFileSync('sh', [path.join(f.output, `${name}.sh`)], { encoding: 'utf8' }),
                    /PLAN ONLY/,
                );
        assert.deepEqual(fs.readdirSync(f.output).sort(), before);
        assert.ok(CODE.includes('cabin-dist'));
        for (const privatePath of ['.env', 'cache', 'identity', 'enc-charts', 'reference'])
            assert.ok(!CODE.includes(privatePath));
    } finally {
        f.close();
    }
});
test('Pi10 refuses wrong release, runtime, source and retained data claims with recalculated checksums', () => {
    for (const edit of [
        (m) => {
            m.update = 9;
        },
        (m) => {
            m.appBuild = 141;
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
            m.release.buildBranch = 'b141';
        },
        (m) => {
            m.release.origin = 'https://lookalike.invalid';
        },
        (m) => {
            m.release.master = 'b'.repeat(40);
        },
        (m) => {
            m.release.buildCommit = 'b'.repeat(40);
        },
        (m) => {
            delete m.release.observedAt;
        },
        (m) => {
            m.cabinAssets[0].bytes = 0;
        },
        ...[
            '.env',
            '.env.local',
            'cache/state.json',
            'identity/token',
            'enc-charts/private.oesu',
            'chart.kap',
            'chart.bsb',
            'chart.tif',
            'chart.tiff',
            'chart.mbtiles',
            'cabin-dist/index.html',
            'dist/server.js',
            'reference/private.json',
        ].map((name) => (m) => {
            m.sourceFiles.push(`pi-cache/${name}`);
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
test('tampered cabin, source and helper members fail the inventory before any installer plan', () => {
    for (const member of ['source.tar.gz', 'cabin.tar.gz', 'update10.mjs', 'cabin-package.mjs', 'install.sh']) {
        const f = bundleFixture();
        try {
            fs.appendFileSync(path.join(f.output, member), 'Changed');
            assert.throws(() => verifyBundle(f.output), /Checksum mismatch/);
        } finally {
            f.close();
        }
    }
});
test('Pi10 native gate admits exactly four build142 values', () => {
    const project = (values) => values.map((value) => `CURRENT_PROJECT_VERSION = ${value};`).join('\n');
    assert.equal(update10NativeBuild(project([142, 142, 142, 142])), 142);
    for (const values of [
        [141, 141, 141, 141],
        [143, 143, 143, 143],
        [142, 142, 142],
        [142, 142, 142, 141],
    ])
        assert.throws(() => update10NativeBuild(project(values)));
});
test('Pi10 rollback binds its own record and a complete prior-code location', () => {
    const f = bundleFixture();
    try {
        const backupRoot = path.join(f.root, 'backups'),
            backup = path.join(backupRoot, 'previous');
        fs.mkdirSync(path.join(backup, 'dist'), { recursive: true });
        fs.writeFileSync(path.join(backup, 'dist/server.js'), '// Prior server\n');
        const good = { schema: 1, update: UPDATE10_NUMBER, backup };
        assert.equal(update10RollbackBackup(good, backupRoot), backup);
        for (const bad of [
            null,
            {},
            { ...good, schema: 2 },
            { ...good, update: 8 },
            { ...good, update: 9 },
            { ...good, update: 11 },
            { ...good, backup: f.root },
            { ...good, backup: path.join(backupRoot, 'missing') },
        ])
            assert.throws(() => update10RollbackBackup(bad, backupRoot));
    } finally {
        f.close();
    }
});
test('Pi10 watch guard holds active, unknown, stale and persisted anchor leases', () => {
    const now = 1800000000000;
    const idle = { version: 1, maintenance: false, anchorRunning: false, sessionExpiresAt: null, observedAt: now };
    assert.doesNotThrow(() => assertWatchIdle(idle, null, now));
    for (const patch of [
        { anchorRunning: true },
        { anchorRunning: null },
        { observedAt: now - 5001 },
        { observedAt: now + 5001 },
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
test('Pi10 archive links, missing, duplicate, absolute and traversing source files are refused', () => {
    const files = ['pi-cache/src/server.ts'],
        entries = ['update10-source/pi-cache/src/server.ts'];
    assert.doesNotThrow(() => verifyArchiveInventory(entries, ['- regular'], files));
    for (const invalid of [[], [...entries, ...entries], ['../outside'], ['/outside']])
        assert.throws(() =>
            verifyArchiveInventory(
                invalid,
                invalid.map(() => '- regular'),
                files,
            ),
        );
    assert.throws(() => verifyArchiveInventory(entries, ['l link'], files));
    assert.doesNotThrow(() => validateUpdate10SourceFiles(['pi-cache/.env.example', ...files]));
    for (const paths of [
        [],
        [...files, ...files],
        ['pi-cache/../secret'],
        ['pi-cache/' + 'x'.repeat(241)],
        ['pi-cache/.env.local'],
        ['pi-cache/cache/state.json'],
        ['pi-cache/reference/data.json'],
        ['pi-cache/enc-charts/private.oesu'],
    ])
        assert.throws(() => validateUpdate10SourceFiles(paths));
});
test('post-build or awaited-guard cabin changes refuse the real pre-stop seam without stopping a service', () => {
    const f = bundleFixture();
    let stops = 0;
    try {
        const directory = path.join(f.root, 'cabin-dist');
        assert.equal(
            stopWithVerifiedCabin(directory, f.manifest.cabinAssets, () => ++stops),
            1,
        );
        const file = path.join(directory, 'assets/display.js'),
            changed = fs.readFileSync(file);
        changed[0] ^= 1;
        fs.writeFileSync(file, changed);
        assert.throws(() => stopWithVerifiedCabin(directory, f.manifest.cabinAssets, () => ++stops));
        assert.equal(stops, 1, 'Changed bytes cannot reach the actual stop callback');
    } finally {
        f.close();
    }
});
test('unreleased Pi10 candidate is refused before output and any release-network read', () => {
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
        fs.writeFileSync(path.join(repository, 'candidate.txt'), 'Unreleased fixture\n');
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
            'Unreleased',
        ]);
        const commit = git(['rev-parse', 'HEAD']);
        const output = path.join(f.root, 'refused');
        assert.throws(() => stageUpdate10({ repository, commit, output }));
        assert.equal(fs.existsSync(output), false);
        assert.deepEqual(fs.readdirSync(repository).sort(), ['.git', 'candidate.txt']);
    } finally {
        f.close();
    }
});
