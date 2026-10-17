// Update 10 preserves the reviewed update-7 installer/rollback and anchor-lease guards.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { sha256, update10NativeBuild, verifyBundle, inside, validateUpdate10SourceFiles } from './update10.mjs';
import { readReleasedSource } from './released-source.mjs';
import { verifyCabinFiles } from './cabin-package.mjs';

/** Git archive includes only a frozen tracked tree: no Pi runtime data or local secrets. */
export function stageUpdate10({ repository, commit, output }) {
    if (!/^[0-9a-f]{40}$/.test(commit) || !path.isAbsolute(output))
        throw new Error('A full commit ID and absolute output directory are required');
    const git = (args) =>
        execFileSync('git', ['-C', repository, ...args], {
            encoding: 'utf8',
            maxBuffer: 16 * 1024 * 1024,
            timeout: 20000,
            stdio: ['ignore', 'pipe', 'pipe'],
        }).trim();
    if (git(['rev-parse', `${commit}^{commit}`]) !== commit) throw new Error('Frozen source commit not found');
    const sourceMasterCommit = git(['rev-parse', 'refs/remotes/origin/master^{commit}']);
    if (commit !== sourceMasterCommit) throw new Error('Update 10 must use the exact frozen released master');
    git(['merge-base', '--is-ancestor', commit, sourceMasterCommit]);
    const appBuild = update10NativeBuild(git(['show', `${commit}:ios/App/App.xcodeproj/project.pbxproj`]));
    let sourceBytes = 0;
    const entries = git(['ls-tree', '-rl', commit, '--', 'pi-cache'])
        .split('\n')
        .filter(Boolean)
        .map((line) => {
            const match = /^(100644|100755) blob [0-9a-f]{40} +(\d+)\t(pi-cache\/[A-Za-z0-9_./-]+)$/.exec(line);
            if (!match) throw new Error('Unsupported source path or symlink');
            const bytes = Number(match[2]);
            sourceBytes += bytes;
            if (!Number.isSafeInteger(bytes) || bytes > 8 * 1024 ** 2 || sourceBytes > 32 * 1024 ** 2)
                throw new Error('Tracked source exceeds its pre-copy byte bound');
            return match[3];
        });
    validateUpdate10SourceFiles(entries);
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
        'pi-cache/src/telemetryPublisher.ts',
        'pi-cache/src/weatherPosition.ts',
        'pi-cache/src/weatherPositionWire.ts',
        'pi-cache/src/routes/weatherPosition.ts',
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
        'pi-cache/src/radar/radarEncounters.ts',
        'pi-cache/src/radar/collisionEncounter.ts',
        'pi-cache/src/radar/radarRelayContract.ts',
        'pi-cache/src/radar/radarWatchContract.ts',
        'pi-cache/src/radar/watch.ts',
        'pi-cache/src/radar/relay.ts',
        'pi-cache/src/radar/serverContext.ts',
        'pi-cache/src/collisionRule/collisionRule.ts',
        'pi-cache/src/collisionRule/syncedFrom.ts',
        'pi-cache/src/radar/syncedFrom.ts',
        'pi-cache/src/radar/rawReader.ts',
        'pi-cache/src/radar/contextSession.ts',
        'pi-cache/src/routes/radar.ts',
        'pi-cache/src/routes/radarWatch.ts',
        'pi-cache/scripts/sync-wake-rule.mjs',
        'pi-cache/scripts/sync-signalk-protocol.mjs',
        'pi-cache/scripts/sync-radar-target.mjs',
        'pi-cache/scripts/sync-weather-position.mjs',
        'pi-cache/src/anchorAreaAdmission.ts',
        'pi-cache/src/anchorZoneContract.ts',
        'pi-cache/src/anchorSafeZone.ts',
        'pi-cache/src/anchorWatchStore.ts',
        'pi-cache/src/anchorBroadcaster.ts',
        'pi-cache/src/routerEngine/services/engine/trackPriors.ts',
        'pi-cache/src/routerEngine/services/routing/trackRouteDraft.ts',
        'pi-cache/src/noaaEditionChecker.ts',
        'pi-cache/src/noaaEdition/noaaEditionPolicy.ts',
        'pi-cache/src/noaaEdition/noaaCatalogueContract.ts',
        'pi-cache/src/noaaEdition/noaaAgreementIdentity.ts',
        'pi-cache/src/noaaEdition/sourceDigest.ts',
        'pi-cache/src/fleetFeed/contract.ts',
        'pi-cache/src/fleetFeed/store.ts',
        'pi-cache/src/fleetFeed/forwarder.ts',
        'pi-cache/src/fleetFeed/source.ts',
        'pi-cache/src/routes/fleetFeed.ts',
        'pi-cache/scripts/sync-anchor-zone.mjs',
        'pi-cache/scripts/sync-router-engine.mjs',
        'pi-cache/package.json',
        'pi-cache/package-lock.json',
        'pi-cache/src/ownBoatSkill/keeper.ts',
        'pi-cache/src/ownBoatSkill/owner.ts',
        'pi-cache/src/ownBoatSkill/source.ts',
        'pi-cache/src/ownBoatSkill/store.ts',
        'pi-cache/src/ownBoatSkill/published.ts',
        'pi-cache/src/cabin/access.ts',
        'pi-cache/src/cabin/codeFile.ts',
        'pi-cache/src/cabin/operatorBinding.ts',
        'pi-cache/src/cabin/accessCode.ts',
        'pi-cache/src/cabin/runtime.ts',
        'pi-cache/src/cabin/server.ts',
        'pi-cache/src/cabin/snapshot.ts',
        'pi-cache/src/cabin/wire.ts',
        'pi-cache/src/internetAis/publisher.ts',
        'pi-cache/src/internetAis/transport.ts',
        'pi-cache/src/internetAis/radio.ts',
        'pi-cache/src/internetAis/runtime.ts',
        'pi-cache/src/internetAisWire.ts',
        'pi-cache/src/seabed/attach.ts',
        'pi-cache/src/seabed/seabedReader.ts',
        'pi-cache/src/seabed/seabedRunner.ts',
        'pi-cache/src/seabed/seabedStore.ts',
        'pi-cache/src/seabed/seabedUploader.ts',
        'pi-cache/scripts/sync-internet-ais.mjs',
        'pi-cache/scripts/build-cabin.mjs',
        'pi-cache/scripts/cabin-package.mjs',
        'pi-cache/scripts/released-source.mjs',
        'pi-cache/scripts/update10.mjs',
        'pi-cache/scripts/install-update10.mjs',
        'pi-cache/scripts/rollback-update10.mjs',
        'pi-cache/tsconfig.json',
        'pi-cache/cabin/index.html',
        'pi-cache/cabin/main.tsx',
        'pi-cache/cabin/browserRead.ts',
        'pi-cache/cabin/style.css',
    ];
    if (required.some((file) => !entries.includes(file))) throw new Error('Update 10 source is incomplete');
    if (fs.existsSync(output)) throw new Error('Use a fresh staging directory');
    for (const directory of ['dist', 'public']) {
        const relative = path.relative(path.join(repository, directory), output);
        if (!relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)))
            throw new Error('Pi bundles cannot enter the phone artifact');
    }
    const release = readReleasedSource(repository, commit, appBuild);
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pi10-cabin-'));
    let cabin;
    try {
        const built = execFileSync(
            process.execPath,
            [
                path.join(repository, 'pi-cache/scripts/build-cabin.mjs'),
                path.resolve(repository),
                path.join(scratch, 'cabin-dist'),
            ],
            { encoding: 'utf8', timeout: 60000, maxBuffer: 65536, stdio: ['ignore', 'pipe', 'pipe'] },
        );
        cabin = JSON.parse(built);
        if (cabin.schema !== 1 || cabin.phoneBundle !== false) throw new Error('Separate cabin build was not proven');
        verifyCabinFiles(path.join(scratch, 'cabin-dist'), cabin.assets);
        if (git(['rev-parse', 'HEAD^{commit}']) !== commit || git(['status', '--porcelain']))
            throw new Error('Frozen source changed during cabin build');
        fs.mkdirSync(output, { recursive: false });
        execFileSync('tar', ['-czf', path.join(output, 'cabin.tar.gz'), '-C', scratch, 'cabin-dist'], {
            timeout: 20000,
            maxBuffer: 65536,
        });
    } finally {
        inside(os.tmpdir(), scratch);
        fs.rmSync(scratch, { recursive: true, force: true });
    }
    const payload = path.join(output, 'source.tar.gz');
    git(['archive', '--format=tar.gz', '--prefix=update10-source/', `--output=${payload}`, commit, 'pi-cache']);
    for (const [name, cap] of [
        ['source.tar.gz', 16 * 1024 ** 2],
        ['cabin.tar.gz', 5 * 1024 ** 2],
    ]) {
        const info = fs.lstatSync(path.join(output, name));
        if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > cap)
            throw new Error('Staged archive exceeds its byte bound');
    }
    for (const [source, destination] of [
        ['install-update10.mjs', 'install.mjs'],
        ['rollback-update10.mjs', 'rollback.mjs'],
        ['update10.mjs', 'update10.mjs'],
        ['cabin-package.mjs', 'cabin-package.mjs'],
    ]) {
        const bytes = execFileSync('git', ['-C', repository, 'show', `${commit}:pi-cache/scripts/${source}`], {
            maxBuffer: 1024 * 1024,
        });
        fs.writeFileSync(path.join(output, destination), bytes, { mode: 0o644 });
    }
    const manifest = {
        schema: 1,
        update: 10,
        appBuild,
        sourceCommit: commit,
        sourceBranch: 'master',
        sourceMasterCommit,
        release,
        guardVersion: 1,
        nodeMajor: 22,
        payloadSha256: sha256(fs.readFileSync(payload)),
        cabinSha256: sha256(fs.readFileSync(path.join(output, 'cabin.tar.gz'))),
        cabinAssets: cabin.assets,
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
            'context-bound-radar-watch',
            'owner-bound-weather-position',
            'current-owner-track-routing-priors',
            'canonical-anchor-safe-area',
            'licensed-noaa-edition-notices',
            'explicit-consent-fleet-forwarder',
            'own-boat-skill-reader',
            'paired-read-only-cabin-display',
            'explicit-tagged-internet-ais-json',
            'original-source-seabed-capture',
        ],
        sourceIsolation:
            'Tracked pi-cache source and separately built bounded cabin display; no runtime data, credentials or decrypted chart assets',
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
        'cabin.tar.gz',
        'install.mjs',
        'rollback.mjs',
        'update10.mjs',
        'cabin-package.mjs',
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
        JSON.stringify(stageUpdate10({ repository, commit: value('--commit'), output: value('--out') }), null, 2) +
            '\n',
    );
}
