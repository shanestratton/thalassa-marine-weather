// Synthetic archive fixture only. Its JSON release claim is never a genuine release receipt.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { sha256, inside } from './update10.mjs';
import { readCabinAssets } from './cabin-package.mjs';
export const fixtureMembers = [
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
export function bundleFixture({ cabinDirectory } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'thalassa-update10-'));
    const output = path.join(root, 'bundle');
    fs.mkdirSync(output);
    fs.mkdirSync(path.join(root, 'update10-source/pi-cache/src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'update10-source/pi-cache/src/server.ts'), '// Synthetic source only.\n');
    fs.mkdirSync(path.join(root, 'cabin-dist/assets'), { recursive: true });
    fs.writeFileSync(
        path.join(root, 'cabin-dist/index.html'),
        '<!doctype html><script src="/assets/display.js"></script>',
    );
    fs.writeFileSync(path.join(root, 'cabin-dist/assets/display.js'), '/* Synthetic bounded cabin bytes. */\n');
    if (cabinDirectory) {
        const actualAssets = readCabinAssets(cabinDirectory);
        fs.unlinkSync(path.join(root, 'cabin-dist/assets/display.js'));
        for (const row of actualAssets)
            fs.copyFileSync(path.join(cabinDirectory, row.file), path.join(root, 'cabin-dist', row.file));
    }
    for (const [name, dir] of [
        ['source', 'update10-source'],
        ['cabin', 'cabin-dist'],
    ])
        execFileSync('tar', ['-czf', path.join(output, `${name}.tar.gz`), '-C', root, dir], {
            timeout: 10000,
            maxBuffer: 65536,
        });
    for (const [name, target] of [
        ['install-update10.mjs', 'install.mjs'],
        ['rollback-update10.mjs', 'rollback.mjs'],
        ['update10.mjs', 'update10.mjs'],
        ['cabin-package.mjs', 'cabin-package.mjs'],
    ])
        fs.copyFileSync(new URL(name, import.meta.url), path.join(output, target));
    for (const name of ['install', 'rollback'])
        fs.writeFileSync(
            path.join(output, `${name}.sh`),
            `#!/bin/sh\nset -eu\nbundle_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)\nexec node "$bundle_dir/${name}.mjs" "$@"\n`,
        );
    const commit = 'a'.repeat(40);
    const manifest = {
        schema: 1,
        update: 10,
        appBuild: 142,
        sourceCommit: commit,
        sourceBranch: 'master',
        sourceMasterCommit: commit,
        nodeMajor: 22,
        guardVersion: 1,
        release: {
            origin: 'https://github.com/shanestratton/thalassa-marine-weather.git',
            master: commit,
            buildBranch: 'b142',
            buildCommit: commit,
            observedAt: 1800000000000,
        },
        payloadSha256: sha256(fs.readFileSync(path.join(output, 'source.tar.gz'))),
        cabinSha256: sha256(fs.readFileSync(path.join(output, 'cabin.tar.gz'))),
        cabinAssets: readCabinAssets(path.join(root, 'cabin-dist')),
        sourceFiles: ['pi-cache/src/server.ts'],
    };
    const rewrite = (edit = () => {}) => {
        edit(manifest);
        fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify(manifest));
        fs.writeFileSync(
            path.join(output, 'SHA256SUMS'),
            fixtureMembers.map((name) => `${sha256(fs.readFileSync(path.join(output, name)))}  ${name}`).join('\n') +
                '\n',
        );
    };
    rewrite();
    return {
        root,
        output,
        manifest,
        rewrite,
        close() {
            inside(os.tmpdir(), root);
            fs.rmSync(root, { recursive: true, force: true });
        },
    };
}
