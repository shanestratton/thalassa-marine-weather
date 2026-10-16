import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { stageUpdate7 } from './stage-update7.mjs';
import {
    assertWatchIdle,
    inside,
    sha256,
    update7NativeBuild,
    verifyArchiveInventory,
    verifyBundle,
} from './update7.mjs';

const helpers = ['stage-update7.mjs', 'install-update7.mjs', 'rollback-update7.mjs', 'update7.mjs'];
const required = [
    'server',
    'polarLearner',
    'underwayWatch',
    'updateMaintenance',
    'barometer',
    'vault/vaultService',
    'trackStore',
    'trackSignalk',
    'signalKClient',
    'signalKReadStream',
    'signalkProtocol',
    'signalkProtocolSyncedFrom',
    'signalKReadSession',
    'lanTelemetry',
    'routes/signalKRead',
    'systemsTelemetry',
    'telemetryPublisher',
    'weatherPosition',
    'weatherPositionWire',
    'routes/weatherPosition',
    'courseWriter',
    'courseOwnership',
    'routes/course',
    'routes/track',
    'wakeKeeper/contract',
    'wakeKeeper/store',
    'wakeKeeper/catalogue',
    'wakeKeeper/runner',
    'wakeKeeper/relayProtocol',
    'wakeKeeper/episodes',
    'wakeKeeper/relay',
    'wakeRule/wakeRule',
    'wakeRule/wakeRuleInputs',
    'wakeRule/barometerTendency',
    'wakeRule/wakePiContract',
    'wakeRule/syncedFrom',
    'routes/wakeRules',
    'radar/radarTarget',
    'radar/radarFeed',
    'radar/radarCollision',
    'radar/radarEncounters',
    'radar/collisionEncounter',
    'radar/radarRelayContract',
    'radar/radarWatchContract',
    'radar/watch',
    'radar/relay',
    'radar/serverContext',
    'routes/radarWatch',
    'collisionRule/collisionRule',
    'collisionRule/syncedFrom',
    'radar/syncedFrom',
    'radar/rawReader',
    'radar/contextSession',
    'routes/radar',
];
function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'thalassa-update7-'));
    const repository = path.join(root, 'source');
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
            stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();
    git(['init', '--quiet']);
    write('ios/App/App.xcodeproj/project.pbxproj', Array(4).fill('CURRENT_PROJECT_VERSION = 137;').join('\n'));
    for (const name of required) write(`pi-cache/src/${name}.ts`, '// Synthetic tracked source only.\n');
    for (const name of ['package.json', 'package-lock.json']) write(`pi-cache/${name}`, '{}\n');
    for (const name of ['sync-wake-rule', 'sync-signalk-protocol', 'sync-radar-target', 'sync-weather-position'])
        write(`pi-cache/scripts/${name}.mjs`, '// Synthetic checked mirror helper.\n');
    for (const name of helpers) write(`pi-cache/scripts/${name}`, fs.readFileSync(new URL(name, import.meta.url)));
    git(['add', '--', 'ios', 'pi-cache']);
    const tree = git(['write-tree']);
    const commitTree = (message, parents = []) =>
        git(
            [
                '-c',
                'user.name=Fixture',
                '-c',
                'user.email=fixture@example.invalid',
                'commit-tree',
                tree,
                ...parents.flatMap((parent) => ['-p', parent]),
            ],
            message + '\n',
        );
    const commit = commitTree('Synthetic reviewed master source');
    git(['update-ref', 'refs/remotes/origin/master', commit]);
    const output = path.join(root, 'bundle');
    return {
        root,
        repository,
        output,
        write,
        git,
        commit,
        commitTree,
        close() {
            inside(os.tmpdir(), root);
            fs.rmSync(root, { recursive: true, force: true });
        },
    };
}
function rewriteManifest(output, edit) {
    const manifest = JSON.parse(fs.readFileSync(path.join(output, 'manifest.json'), 'utf8'));
    edit(manifest);
    fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify(manifest));
    const members = [
        'manifest.json',
        'source.tar.gz',
        'install.mjs',
        'rollback.mjs',
        'update7.mjs',
        'install.sh',
        'rollback.sh',
    ];
    fs.writeFileSync(
        path.join(output, 'SHA256SUMS'),
        members.map((name) => `${sha256(fs.readFileSync(path.join(output, name)))}  ${name}`).join('\n') + '\n',
    );
}

test('update7 stages only frozen master ancestry and its plan never installs or changes runtime data', () => {
    const f = fixture();
    try {
        f.write('ios/App/App.xcodeproj/project.pbxproj', Array(4).fill('CURRENT_PROJECT_VERSION = 999;').join('\n'));
        f.write('pi-cache/cache/private.json', 'Synthetic untracked runtime bytes');
        stageUpdate7(f);
        const manifest = verifyBundle(f.output);
        assert.equal(manifest.appBuild, 137);
        assert.equal(manifest.sourceCommit, f.commit);
        assert.equal(manifest.sourceMasterCommit, f.commit);
        assert.equal(manifest.sourceBranch, 'master');
        assert.equal(manifest.nodeMajor, 22);
        assert.ok(manifest.sourceFiles.includes('pi-cache/src/courseWriter.ts'));
        assert.ok(manifest.sourceFiles.includes('pi-cache/src/wakeKeeper/relay.ts'));
        assert.ok(manifest.sourceFiles.includes('pi-cache/src/radar/rawReader.ts'));
        assert.ok(!manifest.sourceFiles.some((name) => name.includes('/cache/')));
        const before = fs.readdirSync(f.output).sort();
        const plan = JSON.parse(
            execFileSync(process.execPath, [path.join(f.output, 'install.mjs')], { encoding: 'utf8' }),
        );
        assert.match(plan.mode, /PLAN ONLY/);
        assert.equal(plan.manifest.update, 7);
        assert.deepEqual(fs.readdirSync(f.output).sort(), before);
        assert.match(
            execFileSync(process.execPath, [path.join(f.output, 'rollback.mjs')], { encoding: 'utf8' }),
            /PLAN ONLY/,
        );
        if (process.platform !== 'win32') {
            assert.match(execFileSync('sh', [path.join(f.output, 'install.sh')], { encoding: 'utf8' }), /PLAN ONLY/);
            assert.match(execFileSync('sh', [path.join(f.output, 'rollback.sh')], { encoding: 'utf8' }), /PLAN ONLY/);
        }
    } finally {
        f.close();
    }
});
test('a candidate beyond master is refused before creating a bundle', () => {
    const f = fixture();
    try {
        const commit = f.commitTree('Unreleased candidate', [f.commit]);
        assert.throws(() => stageUpdate7({ ...f, commit }));
        assert.equal(fs.existsSync(f.output), false);
    } finally {
        f.close();
    }
});
test('missing wake/radar or checked-mirror source is rejected before any bundle directory is created', () => {
    for (const missing of [
        'src/wakeKeeper/relay.ts',
        'src/radar/rawReader.ts',
        'src/radar/relay.ts',
        'src/weatherPositionWire.ts',
        'scripts/sync-weather-position.mjs',
        'src/collisionRule/collisionRule.ts',
        'scripts/sync-radar-target.mjs',
    ]) {
        const f = fixture();
        try {
            f.git(['update-index', '--force-remove', `pi-cache/${missing}`]);
            const tree = f.git(['write-tree']);
            const commit = f.git(
                ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit-tree', tree],
                'Synthetic incomplete master\n',
            );
            f.git(['update-ref', 'refs/remotes/origin/master', commit]);
            assert.throws(() => stageUpdate7({ ...f, commit }), /Update 7 source is incomplete/);
            assert.equal(fs.existsSync(f.output), false);
        } finally {
            f.close();
        }
    }
});

test('update7 requires exactly four native137 configurations', () => {
    const project = (values) => values.map((build) => `CURRENT_PROJECT_VERSION = ${build};`).join('\n');
    assert.equal(update7NativeBuild(project(Array(4).fill(137))), 137);
    for (const values of [Array(4).fill(136), Array(4).fill(138), Array(3).fill(137), [137, 137, 137, 136]])
        assert.throws(() => update7NativeBuild(project(values)));
});
test('runtime, source branch and archive identity changes are rejected even with recalculated checksums', () => {
    for (const edit of [
        (m) => {
            m.appBuild = 135;
        },
        (m) => {
            m.nodeMajor = 24;
        },
        (m) => {
            m.sourceBranch = 'candidate';
        },
        (m) => {
            m.sourceMasterCommit = 'invalid';
        },
        (m) => {
            m.sourceFiles.push('pi-cache/.env');
        },
        (m) => {
            m.sourceFiles.push('pi-cache/enc-charts/private.oesu');
        },
    ]) {
        const f = fixture();
        try {
            stageUpdate7(f);
            rewriteManifest(f.output, edit);
            assert.throws(() => verifyBundle(f.output));
        } finally {
            f.close();
        }
    }
});
test('a tampered helper or shell entry fails before an installer plan can run', () => {
    for (const member of ['update7.mjs', 'install.sh', 'rollback.sh']) {
        const f = fixture();
        try {
            stageUpdate7(f);
            fs.appendFileSync(path.join(f.output, member), '\n# Changed after review\n');
            assert.throws(() => verifyBundle(f.output), /Checksum mismatch/);
        } finally {
            f.close();
        }
    }
});
test('the shared guard still refuses active, unknown, stale and persisted anchor leases', () => {
    const now = 1_800_000_000_000;
    const status = { version: 1, maintenance: false, anchorRunning: false, sessionExpiresAt: null, observedAt: now };
    assert.doesNotThrow(() => assertWatchIdle(status, null, now));
    for (const patch of [
        { anchorRunning: true },
        { anchorRunning: null },
        { observedAt: now - 5001 },
        { sessionExpiresAt: now + 1 },
    ])
        assert.throws(() => assertWatchIdle({ ...status, ...patch }, null, now));
    assert.throws(() => assertWatchIdle(status, { sessionExpiresAt: now + 1000, expiresAt: now + 500 }, now));
    assert.throws(() => assertWatchIdle(status, {}, now));
});
test('archive links, traversal, missing and duplicate members are refused', () => {
    const files = ['pi-cache/src/server.ts'];
    const good = ['update7-source/pi-cache/src/server.ts'];
    assert.doesNotThrow(() => verifyArchiveInventory(good, ['- regular'], files));
    for (const entries of [[], [...good, ...good], ['../outside'], ['/outside']])
        assert.throws(() =>
            verifyArchiveInventory(
                entries,
                entries.map(() => '- regular'),
                files,
            ),
        );
    assert.throws(() => verifyArchiveInventory(good, ['l symlink'], files));
});
