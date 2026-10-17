import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { sha256, update5NativeBuild, verifyBundle } from './update5.mjs';

/** Git archive includes only a frozen tracked tree: no Pi runtime data or local secrets. */
export function stageUpdate5({ repository, commit, output }) {
    if (!/^[0-9a-f]{40}$/.test(commit) || !path.isAbsolute(output))
        throw new Error('A full commit ID and absolute output directory are required');
    const git = (args) =>
        execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim();
    if (git(['rev-parse', `${commit}^{commit}`]) !== commit) throw new Error('Frozen source commit not found');
    const appBuild = update5NativeBuild(git(['show', `${commit}:ios/App/App.xcodeproj/project.pbxproj`]));
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
        'pi-cache/package.json',
        'pi-cache/package-lock.json',
    ];
    if (required.some((file) => !entries.includes(file))) throw new Error('Update 5 source is incomplete');
    fs.mkdirSync(output, { recursive: false });
    const payload = path.join(output, 'source.tar.gz');
    git(['archive', '--format=tar.gz', '--prefix=update5-source/', `--output=${payload}`, commit, 'pi-cache']);
    for (const [source, destination] of [
        ['install-update5.mjs', 'install.mjs'],
        ['rollback-update5.mjs', 'rollback.mjs'],
        ['update5.mjs', 'update5.mjs'],
    ]) {
        const bytes = execFileSync('git', ['-C', repository, 'show', `${commit}:pi-cache/scripts/${source}`], {
            maxBuffer: 1024 * 1024,
        });
        fs.writeFileSync(path.join(output, destination), bytes, { mode: 0o644 });
    }
    const manifest = {
        schema: 1,
        update: 5,
        appBuild,
        sourceCommit: commit,
        guardVersion: 1,
        nodeMajor: 22,
        payloadSha256: sha256(fs.readFileSync(payload)),
        sourceFiles: entries,
        parts: ['underway-watch', 'polar-learner', 'barometer-10-day', 'chart-datum-and-navaids'],
        sourceIsolation: 'Tracked pi-cache source only; no runtime data, credentials or decrypted chart assets',
        hardwareAcceptance:
            'Pending real pi5 rollback dry run, resource measurement and instrument/alarm checks; staging performs no installation',
    };
    fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    const members = ['manifest.json', 'source.tar.gz', 'install.mjs', 'rollback.mjs', 'update5.mjs'];
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
        JSON.stringify(stageUpdate5({ repository, commit: value('--commit'), output: value('--out') }), null, 2) + '\n',
    );
}
