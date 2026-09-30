/** Network-free, synthetic macOS SQLite persistence proof. No app or provider build.
 * node experiments/scuttlebutt-e2ee/native-store-probe.mjs
 * One compiler worker, private temporary module cache, no simulator or user keys.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

function run(command, args) {
    const result = spawnSync(command, args, {
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
        timeout: 180_000,
    });
    if (result.error || result.status !== 0) {
        if (result.stderr) process.stderr.write(result.stderr);
        throw new Error('Isolated persistence proof failed; no production storage claim is approved');
    }
    return result.stdout.trim();
}

try {
    if (process.platform !== 'darwin' || process.argv.length !== 2) {
        throw new Error('Usage on macOS: node experiments/scuttlebutt-e2ee/native-store-probe.mjs');
    }
    const scratch = mkdtempSync(join(tmpdir(), 'thalassa-atomic-outbox-'));
    chmodSync(scratch, 0o700);
    mkdirSync(join(scratch, 'modules'), { mode: 0o700 });
    const sdk = run('xcrun', ['--sdk', 'macosx', '--show-sdk-path']);
    const binary = join(scratch, 'AtomicOutboxStoreProbe');
    console.log('Compiling isolated macOS SQLite proof with one worker');
    run('xcrun', [
        '--sdk',
        'macosx',
        'swiftc',
        '-swift-version',
        '5',
        '-j',
        '1',
        '-num-threads',
        '1',
        '-sdk',
        sdk,
        '-module-cache-path',
        join(scratch, 'modules'),
        '-parse-as-library',
        '-lsqlite3',
        '-o',
        binary,
        join(here, 'AtomicOutboxStore.swift'),
        join(here, 'AtomicOutboxStoreProbe.swift'),
    ]);
    console.log(run(binary, [scratch]));
    console.log(`Synthetic artifacts retained in private scratch directory: ${scratch}`);
} catch (error) {
    console.error(error.message);
    process.exitCode = 1;
}
