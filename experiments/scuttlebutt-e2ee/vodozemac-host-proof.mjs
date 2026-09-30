/**
 * Offline, isolated real-library experiment. No app integration or security claim.
 * First fetch the locked crate dependencies into a separate research CARGO_HOME.
 * Run: node vodozemac-host-proof.mjs /absolute/path/to/cargo /absolute/research/cargo-home
 * For rustup proxies, supply the matching isolated RUSTUP_HOME in the environment.
 * Never add this Rust crate to the app or use its synthetic fixtures for real keys.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statfsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const base = dirname(fileURLToPath(import.meta.url));
const root = join(base, 'vodozemac-probe');
const pin = JSON.parse(readFileSync(join(base, 'vodozemac-pin.json'), 'utf8'));
const [cargoArgument, cacheArgument, ...extra] = process.argv.slice(2);
assert(cargoArgument && cacheArgument && !extra.length, 'Provide cargo and isolated CARGO_HOME absolute paths');
assert(isAbsolute(cargoArgument) && isAbsolute(cacheArgument), 'Absolute paths required');
assert(process.platform === 'darwin' && process.arch === 'arm64', 'This host proof targets Apple Silicon macOS only');
const cargo = resolve(cargoArgument); // Preserve argv[0] for rustup's cargo proxy.
realpathSync(cargo);
const cache = realpathSync(cacheArgument);
const disk = statfsSync(tmpdir());
assert(disk.bavail * disk.bsize >= 1024 ** 3, 'Keep at least 1 GiB free before starting this small build');
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
assert.equal(sha256(join(root, 'Cargo.toml')), pin.manifestSha256, 'Research manifest changed; review and repin');
assert.equal(
    sha256(join(root, 'Cargo.lock')),
    pin.lockfileSha256,
    'Research dependency lock changed; review and repin',
);
assert.equal(pin.shippingApproved, false, 'Research runner cannot approve shipping');

// Never create build products or downloaded dependencies in the application tree.
const target = mkdtempSync(join(tmpdir(), 'thalassa-vodozemac-host-'));
const env = {
    ...process.env,
    CARGO_HOME: cache,
    CARGO_TARGET_DIR: target,
    CARGO_BUILD_JOBS: '1',
    CARGO_INCREMENTAL: '0',
    CARGO_NET_OFFLINE: 'true',
    RUST_BACKTRACE: '0',
    THALASSA_VODO_PROBE_NODE: process.execPath,
    PATH: `${dirname(cargo)}:${process.env.PATH ?? '/usr/bin:/bin'}`,
};
function run(args, { capture = false, timeout = 180_000 } = {}) {
    const result = spawnSync(cargo, args, {
        cwd: root,
        env,
        encoding: 'utf8',
        timeout,
        maxBuffer: 16 * 1024 * 1024,
        stdio: capture ? 'pipe' : 'inherit',
    });
    if (result.error || result.status !== 0) {
        // Metadata may include local paths. Do not dump provider/key material.
        throw new Error(`Isolated Cargo command failed (${args[0]}); no app changes made`);
    }
    return result.stdout;
}

const metadata = JSON.parse(
    run(['metadata', '--locked', '--offline', '--format-version', '1', '--filter-platform', 'aarch64-apple-darwin'], {
        capture: true,
    }),
);
const candidates = metadata.packages.filter((pkg) => pkg.name === 'vodozemac');
assert.equal(candidates.length, 1, 'Exactly one provider version required');
const provider = candidates[0];
assert.equal(provider.version, pin.version);
assert.equal(provider.license, pin.license);
assert.equal(
    provider.source,
    'registry+https://github.com/rust-lang/crates.io-index',
    'No local/provider source substitution',
);
const node = metadata.resolve.nodes.find((entry) => entry.id === provider.id);
assert(node, 'Provider must be in the resolved dependency tree');
assert.deepEqual([...node.features].sort(), pin.providerFeatures, 'No experimental or compatibility features');
const source = dirname(provider.manifest_path);
const registry = dirname(source).split('/').pop();
const archive = join(cache, 'registry', 'cache', registry, `vodozemac-${pin.version}.crate`);
assert.equal(sha256(archive), pin.crateSha256, 'Published crate archive checksum');
const vcs = JSON.parse(readFileSync(join(source, '.cargo_vcs_info.json'), 'utf8'));
assert.equal(vcs.git.sha1, pin.sourceCommit);
// Registry caches (unlike vendored trees) need not contain .cargo-checksum.json.
// Compare cached files with a fresh extraction of the hash-verified public archive.
const extracted = spawnSync('/usr/bin/tar', ['-xzf', archive, '-C', target], { timeout: 30_000, stdio: 'pipe' });
assert(!extracted.error && extracted.status === 0, 'Extract verified provider source');
function filesIn(directory, prefix = '') {
    return readdirSync(join(directory, prefix))
        .flatMap((name) => {
            const relative = join(prefix, name);
            const stat = lstatSync(join(directory, relative));
            assert(stat.isFile() || stat.isDirectory(), 'No source symlinks or special files');
            return stat.isDirectory() ? filesIn(directory, relative) : [relative];
        })
        .sort();
}
const original = join(target, `vodozemac-${pin.version}`);
const originalFiles = filesIn(original);
assert.deepEqual(
    filesIn(source).filter((file) => file !== '.cargo-ok'),
    originalFiles,
    'No added or missing cached provider source',
);
for (const file of originalFiles) {
    assert.equal(
        sha256(join(source, file)),
        sha256(join(original, file)),
        'Cached provider source differs from published archive',
    );
}
console.log(`Research only: vodozemac ${pin.version}, unchanged Olm v1, pinned lock; no post-quantum claim.`);
console.log(`Temporary build directory: ${target}`);
run(['test', '--locked', '--offline', '--jobs', '1', '--test', 'probe', '--', '--test-threads=1']);
assert.equal(sha256(join(root, 'Cargo.lock')), pin.lockfileSha256, 'Test run must not rewrite the lockfile');
console.log('Host experiment passed. No phone, secure-store, relay, app, or independent-audit claim.');
