// Synthetic archive/plan fixture only; its JSON is not genuine release authority.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { inside, sha256 } from './update9.mjs';
export const fixtureMembers = [
    'manifest.json',
    'source.tar.gz',
    'install.mjs',
    'rollback.mjs',
    'update9.mjs',
    'install.sh',
    'rollback.sh',
];
export function bundleFixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'thalassa-update9-')),
        output = path.join(root, 'bundle');
    fs.mkdirSync(output);
    fs.mkdirSync(path.join(root, 'update9-source/pi-cache/src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'update9-source/pi-cache/src/server.ts'), '// Synthetic frozen source only.\n');
    execFileSync('tar', ['-czf', path.join(output, 'source.tar.gz'), '-C', root, 'update9-source'], {
        timeout: 10000,
        maxBuffer: 65536,
    });
    for (const [from, to] of [
        ['install-update9.mjs', 'install.mjs'],
        ['rollback-update9.mjs', 'rollback.mjs'],
        ['update9.mjs', 'update9.mjs'],
    ])
        fs.copyFileSync(new URL(from, import.meta.url), path.join(output, to));
    for (const name of ['install', 'rollback'])
        fs.writeFileSync(
            path.join(output, name + '.sh'),
            `#!/bin/sh\nset -eu\nbundle_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)\nexec node "$bundle_dir/${name}.mjs" "$@"\n`,
        );
    const commit = 'a'.repeat(40),
        manifest = {
            schema: 1,
            update: 9,
            appBuild: 141,
            sourceCommit: commit,
            sourceBranch: 'master',
            sourceMasterCommit: commit,
            guardVersion: 1,
            nodeMajor: 22,
            payloadSha256: sha256(fs.readFileSync(path.join(output, 'source.tar.gz'))),
            release: {
                origin: 'https://github.com/shanestratton/thalassa-marine-weather.git',
                master: commit,
                buildBranch: 'b141',
                buildCommit: commit,
                observedAt: 1800000000000,
            },
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
