// Update 7 snapshot of the reviewed update-5 protocol; shared guard compatibility is intentional.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { sha256, update7NativeBuild, verifyBundle } from './update7.mjs';

/** Git archive includes only a frozen tracked tree: no Pi runtime data or local secrets. */
export function stageUpdate7({ repository, commit, output }) {
    if (!/^[0-9a-f]{40}$/.test(commit) || !path.isAbsolute(output))
        throw new Error('A full commit ID and absolute output directory are required');
    const git = (args) =>
        execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim();
    if (git(['rev-parse', `${commit}^{commit}`]) !== commit) throw new Error('Frozen source commit not found');
    const sourceMasterCommit = git(['rev-parse', 'refs/remotes/origin/master^{commit}']);
    git(['merge-base', '--is-ancestor', commit, sourceMasterCommit]);
    const appBuild = update7NativeBuild(git(['show', `${commit}:ios/App/App.xcodeproj/project.pbxproj`]));
    const entries = git(['ls-tree', '-r', commit, '--', 'pi-cache'])
        .split('\n')
        .filter(Boolean)
        .map((line) => {
            const match = /^(100644|100755) blob [0-9a-f]{40}\t(pi-cache\/[A-Za-z0-9_./-]+)$/.exec(line);
            if (!match) throw new Error('Unsupported source path or symlink');
            return match[2];
        });
    const required = [
        'pi-cache/src/server.ts',
        'pi-cache/src/polarLearner.ts',
        'pi-cache/src/underwayWatch.ts',
        'pi-cache/src/updateMaintenance.ts',
        'pi-cache/src/barometer.ts',
        'pi-cache/src/vault/vaultService.ts',
        'pi-cache/src/trackStore.ts',
        'pi-cache/src/trackSignalk.ts',
        'pi-cache/src/signalKClient.ts',
        'pi-cache/src/signalKReadStream.ts',
        'pi-cache/src/signalkProtocol.ts',
        'pi-cache/src/signalkProtocolSyncedFrom.ts',
        'pi-cache/src/signalKReadSession.ts',
        'pi-cache/src/lanTelemetry.ts',
        'pi-cache/src/routes/signalKRead.ts',
        'pi-cache/src/systemsTelemetry.ts',
        'pi-cache/src/courseWriter.ts',
        'pi-cache/src/courseOwnership.ts',
        'pi-cache/src/routes/course.ts',
        'pi-cache/src/routes/track.ts',
        'pi-cache/src/wakeKeeper/contract.ts',
        'pi-cache/src/wakeKeeper/store.ts',
        'pi-cache/src/wakeKeeper/catalogue.ts',
        'pi-cache/src/wakeKeeper/runner.ts',
        'pi-cache/src/wakeKeeper/relayProtocol.ts',
        'pi-cache/src/wakeKeeper/episodes.ts',
        'pi-cache/src/wakeKeeper/relay.ts',
        'pi-cache/src/wakeRule/wakeRule.ts',
        'pi-cache/src/wakeRule/wakeRuleInputs.ts',
        'pi-cache/src/wakeRule/barometerTendency.ts',
        'pi-cache/src/wakeRule/wakePiContract.ts',
        'pi-cache/src/wakeRule/syncedFrom.ts',
        'pi-cache/src/routes/wakeRules.ts',
        'pi-cache/src/radar/radarTarget.ts',
        'pi-cache/src/radar/radarFeed.ts',
        'pi-cache/src/radar/radarCollision.ts',
        'pi-cache/src/collisionRule/collisionRule.ts',
        'pi-cache/src/collisionRule/syncedFrom.ts',
        'pi-cache/src/radar/syncedFrom.ts',
        'pi-cache/src/radar/rawReader.ts',
        'pi-cache/src/radar/contextSession.ts',
        'pi-cache/src/routes/radar.ts',
        'pi-cache/scripts/sync-wake-rule.mjs',
        'pi-cache/scripts/sync-signalk-protocol.mjs',
        'pi-cache/scripts/sync-radar-target.mjs',
        'pi-cache/package.json',
        'pi-cache/package-lock.json',
    ];
    if (required.some((file) => !entries.includes(file))) throw new Error('Update 7 source is incomplete');
    fs.mkdirSync(output, { recursive: false });
    const payload = path.join(output, 'source.tar.gz');
    git(['archive', '--format=tar.gz', '--prefix=update7-source/', `--output=${payload}`, commit, 'pi-cache']);
    for (const [source, destination] of [
        ['install-update7.mjs', 'install.mjs'],
        ['rollback-update7.mjs', 'rollback.mjs'],
        ['update7.mjs', 'update7.mjs'],
    ]) {
        const bytes = execFileSync('git', ['-C', repository, 'show', `${commit}:pi-cache/scripts/${source}`], {
            maxBuffer: 1024 * 1024,
        });
        fs.writeFileSync(path.join(output, destination), bytes, { mode: 0o644 });
    }
    const manifest = {
        schema: 1,
        update: 7,
        appBuild,
        sourceCommit: commit,
        sourceBranch: 'master',
        sourceMasterCommit,
        guardVersion: 1,
        nodeMajor: 22,
        payloadSha256: sha256(fs.readFileSync(payload)),
        sourceFiles: entries,
        parts: [
            'track-record',
            'engine-source-clocks',
            'signalk-read-stream',
            'systems',
            'interlocked-course-writer',
            'preset-wake-keeper',
            'capability-gated-wake-relay',
            'read-only-radar-targets',
        ],
        sourceIsolation: 'Tracked pi-cache source only; no runtime data, credentials or decrypted chart assets',
        hardwareAcceptance:
            'Pending real pi5 rollback dry run, resource measurement and instrument/alarm checks; staging performs no installation',
    };
    fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    for (const name of ['install', 'rollback'])
        fs.writeFileSync(
            path.join(output, `${name}.sh`),
            `#!/bin/sh\nset -eu\nbundle_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)\nexec node "$bundle_dir/${name}.mjs" "$@"\n`,
            { mode: 0o755 },
        );
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
    verifyBundle(output);
    return {
        directory: output,
        commit,
        checksumInventorySha256: sha256(fs.readFileSync(path.join(output, 'SHA256SUMS'))),
        mode: 'Staged only; no Pi connection or installation',
    };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const args = process.argv.slice(2),
        value = (key) => args[args.indexOf(key) + 1];
    const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    process.stdout.write(
        JSON.stringify(stageUpdate7({ repository, commit: value('--commit'), output: value('--out') }), null, 2) + '\n',
    );
}
