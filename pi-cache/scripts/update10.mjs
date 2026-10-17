// Update 10 preserves the reviewed update-7 installer/rollback and anchor-lease guards.
/** Staged update controls. This module never changes a Pi merely by being imported. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
    CABIN_PACKAGE,
    cabinAssetManifest,
    verifyCabinFiles,
    verifyCabinArchiveInventory,
    verifyGzipEnvelope,
} from './cabin-package.mjs';

export const INSTALL = '/opt/thalassa-pi-cache';
export const CONTROL = '/opt/thalassa-update10';
export const UPDATE10_NUMBER = 10;
export const CODE = Object.freeze([
    'src',
    'scripts',
    'systemd',
    'docs',
    'dist',
    'cabin-dist',
    'node_modules',
    'package.json',
    'package-lock.json',
    'tsconfig.json',
    'README.md',
    'install.sh',
    'redeploy.sh',
    'setup-opencpn.sh',
    'upgrade-opencpn.sh',
    '.env.example',
]);
const PACKED = [
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
// Update 10 is retained for the reviewed app releases; future builds require an explicit compatibility review.
export const UPDATE10_APP_BUILDS = Object.freeze([142]);
export function update10NativeBuild(project) {
    const builds = [...project.matchAll(/CURRENT_PROJECT_VERSION = (\d+);/g)];
    const build = Number(builds[0]?.[1]);
    if (
        builds.length !== 4 ||
        !UPDATE10_APP_BUILDS.includes(build) ||
        builds.some((value) => value[1] !== String(build))
    )
        throw new Error('Exactly four matching native build-142 configurations are required');
    return build;
}
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const shellArgument = (value) => `'${value.replaceAll("'", "'\"'\"'")}'`;
export function inside(root, target) {
    const relative = path.relative(path.resolve(root), path.resolve(target));
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
        throw new Error('Path escapes its intended directory');
    return path.resolve(target);
}
function plain(filename) {
    const s = fs.lstatSync(filename);
    if (!s.isFile() || s.isSymbolicLink()) throw new Error('A bundle member is not a regular file');
    return s;
}
/** Admission is shared by the stager before it copies any source bytes and by package verification. */
export function validateUpdate10SourceFiles(files) {
    if (
        !Array.isArray(files) ||
        !files.length ||
        files.length > 10000 ||
        new Set(files).size !== files.length ||
        files.some(
            (file) =>
                typeof file !== 'string' ||
                file.length > 240 ||
                !/^pi-cache\/[A-Za-z0-9_./-]+$/.test(file) ||
                file.split('/').includes('..') ||
                /\/(?:cache|identity|enc-charts|node_modules|dist|cabin-dist|reference)\//.test(file) ||
                /\.(?:oesu|oesenc|kap|bsb|mbtiles|tif|tiff|000|p12|p8|pem|key)$/i.test(file) ||
                (/\/(?:\.env(?:\..+)?|github-token)$/.test(file) && file !== 'pi-cache/.env.example'),
        )
    )
        throw new Error('Invalid update-10 source boundary');
    return files;
}
export function verifyBundle(directory) {
    const root = fs.realpathSync(directory);
    if (plain(path.join(root, 'SHA256SUMS')).size > 4096) throw new Error('Checksum inventory exceeds its bound');
    const lines = fs.readFileSync(path.join(root, 'SHA256SUMS'), 'utf8').trim().split('\n');
    if (lines.length !== PACKED.length) throw new Error('Incomplete checksum inventory');
    const names = new Set();
    for (const line of lines) {
        const match = /^([0-9a-f]{64}) {2}([a-zA-Z0-9.-]+)$/.exec(line);
        if (!match || !PACKED.includes(match[2]) || names.has(match[2])) throw new Error('Unexpected checksum member');
        names.add(match[2]);
        const filename = inside(root, path.join(root, match[2]));
        const info = plain(filename);
        const cap =
            match[2] === 'source.tar.gz'
                ? 16 * 1024 ** 2
                : match[2] === 'cabin.tar.gz'
                  ? CABIN_PACKAGE.archiveBytes
                  : 1024 ** 2;
        if (info.size > cap) throw new Error('Bundle member exceeds its byte bound');
        if (sha256(fs.readFileSync(filename)) !== match[1]) throw new Error(`Checksum mismatch: ${match[2]}`);
    }
    const m = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
    if (
        m.schema !== 1 ||
        m.nodeMajor !== 22 ||
        m.sourceBranch !== 'master' ||
        !/^[0-9a-f]{40}$/.test(m.sourceMasterCommit) ||
        m.sourceMasterCommit !== m.sourceCommit ||
        m.update !== UPDATE10_NUMBER ||
        !UPDATE10_APP_BUILDS.includes(m.appBuild) ||
        !/^[0-9a-f]{40}$/.test(m.sourceCommit) ||
        m.payloadSha256 !== sha256(fs.readFileSync(path.join(root, 'source.tar.gz'))) ||
        m.cabinSha256 !== sha256(fs.readFileSync(path.join(root, 'cabin.tar.gz'))) ||
        m.release?.origin !== 'https://github.com/shanestratton/thalassa-marine-weather.git' ||
        m.release?.master !== m.sourceCommit ||
        m.release?.buildBranch !== 'b142' ||
        m.release?.buildCommit !== m.sourceCommit ||
        !Number.isSafeInteger(m.release?.observedAt) ||
        m.release.observedAt < 1 ||
        m.guardVersion !== 1
    )
        throw new Error('Invalid update-10 manifest or source boundary');
    validateUpdate10SourceFiles(m.sourceFiles);
    cabinAssetManifest(m.cabinAssets);
    verifyGzipEnvelope(path.join(root, 'source.tar.gz'), 16 * 1024 ** 2, 64 * 1024 ** 2);
    verifyGzipEnvelope(path.join(root, 'cabin.tar.gz'), CABIN_PACKAGE.archiveBytes, CABIN_PACKAGE.totalBytes + 65536);
    return m;
}
export function verifyArchiveInventory(entries, detailedEntries, sourceFiles) {
    const allowed = new Set(sourceFiles.map((file) => `update10-source/${file}`));
    const files = entries.filter((entry) => !entry.endsWith('/'));
    if (
        entries.some(
            (entry) =>
                entry.split('/').includes('..') ||
                entry.startsWith('/') ||
                (!entry.endsWith('/') && !allowed.has(entry)),
        ) ||
        files.length !== allowed.size ||
        new Set(files).size !== allowed.size ||
        detailedEntries.some((line) => !['-', 'd'].includes(line[0]))
    )
        throw new Error('Archive inventory or entry type differs from the reviewed source');
}
export function assertWatchIdle(status, savedLease, now = Date.now()) {
    if (
        !status ||
        status.version !== 1 ||
        typeof status.maintenance !== 'boolean' ||
        status.anchorRunning !== false ||
        !Number.isFinite(status.observedAt) ||
        Math.abs(now - status.observedAt) > 5000
    )
        throw new Error('A fresh guard-capable idle Pi was not proven');
    if (
        status.sessionExpiresAt !== null &&
        (!Number.isFinite(status.sessionExpiresAt) || status.sessionExpiresAt > now)
    )
        throw new Error('An anchor session lease is still active');
    if (
        savedLease !== null &&
        (!Number.isFinite(savedLease.sessionExpiresAt) ||
            savedLease.sessionExpiresAt > now ||
            !Number.isFinite(savedLease.expiresAt) ||
            savedLease.expiresAt > savedLease.sessionExpiresAt)
    )
        throw new Error('A persisted anchor lease is active or unreadable');
}
/** Re-admit the actual post-build cabin bytes after the awaited guard, immediately before stop. */
export function stopWithVerifiedCabin(directory, assets, stop) {
    verifyCabinFiles(directory, assets);
    return stop();
}
function savedLease(cacheDir) {
    const filename = path.join(cacheDir, 'anchor-watch.json');
    try {
        const s = plain(filename);
        if (s.size > 8192) throw new Error('Oversized anchor lease');
        return JSON.parse(fs.readFileSync(filename, 'utf8'));
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
    }
}
function run(command, args, options = {}) {
    return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options }).trim();
}
function active(unit) {
    try {
        run('systemctl', ['is-active', '--quiet', unit]);
        return true;
    } catch {
        return false;
    }
}
async function status(port) {
    const response = await fetch(`http://127.0.0.1:${port}/api/update5/status`, {
        redirect: 'error',
        signal: globalThis.AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error('The running Pi does not support the guarded update protocol');
    const body = await response.text();
    if (body.length > 4096) throw new Error('Oversized update status');
    return JSON.parse(body);
}
function rootDirectory(dir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { mode: 0o755 });
    const s = fs.lstatSync(dir);
    if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== 0 || s.mode & 0o022)
        throw new Error('Update control directory must be root-owned and not writable by others');
}
function rootOnly() {
    if (process.platform !== 'linux' || process.getuid?.() !== 0 || Number(process.versions.node.split('.')[0]) !== 22)
        throw new Error('Apply/rollback requires root on Linux with the tested Node 22 runtime');
    if (fs.realpathSync(INSTALL) !== INSTALL) throw new Error('The install target is a symlink or unexpected path');
    rootDirectory(CONTROL);
    rootDirectory(path.join(CONTROL, 'backups'));
}
function copyCode(from, to) {
    for (const name of CODE) {
        const source = inside(from, path.join(from, name));
        if (!fs.existsSync(source)) continue;
        if (fs.lstatSync(source).isSymbolicLink()) throw new Error(`Refusing linked code: ${name}`);
        fs.cpSync(source, inside(to, path.join(to, name)), {
            recursive: true,
            dereference: false,
            verbatimSymlinks: true,
        });
    }
}
function removeCode(dir) {
    for (const name of CODE) {
        const filename = inside(dir, path.join(dir, name));
        if (fs.existsSync(filename)) fs.rmSync(filename, { recursive: true, force: true });
    }
}
async function guarded(cacheDir, port, operation) {
    const before = await status(port);
    assertWatchIdle(before, savedLease(cacheDir));
    if (before.maintenance) throw new Error('Another update or stale maintenance guard already exists');
    const sentinel = path.join(cacheDir, 'update5-maintenance.json');
    const nonce = randomUUID();
    fs.writeFileSync(sentinel, JSON.stringify({ schema: 1, nonce, at: Date.now() }), { flag: 'wx', mode: 0o600 });
    try {
        const locked = await status(port);
        assertWatchIdle(locked, savedLease(cacheDir));
        if (!locked.maintenance) throw new Error('The service did not observe the maintenance guard');
        return await operation();
    } finally {
        try {
            const healthy = await status(port);
            assertWatchIdle(healthy, savedLease(cacheDir));
            const own = JSON.parse(fs.readFileSync(sentinel, 'utf8'));
            if (healthy.maintenance && own.nonce === nonce) fs.unlinkSync(sentinel);
        } catch {
            /* An unhealthy/uncertain service leaves its maintenance guard fail closed. */
        }
    }
}
async function waitHealthy(port) {
    const end = Date.now() + 30000;
    while (Date.now() < end) {
        try {
            const s = await status(port);
            if (s.version === 1 && s.maintenance === true && s.anchorRunning === false) return;
        } catch {
            /* The service may still be starting. */
        }
        await new Promise((done) => setTimeout(done, 1000));
    }
    throw new Error('Updated service did not become healthy with its guard held');
}
export async function applyBundle(bundle, { cacheDir = `${INSTALL}/cache`, port = 3001 } = {}) {
    const manifest = verifyBundle(bundle);
    rootOnly();
    for (const member of [...PACKED, 'SHA256SUMS']) {
        const info = plain(path.join(bundle, member));
        if (info.uid !== 0 || info.mode & 0o022)
            throw new Error('The reviewed bundle must be root-owned and not writable by others');
    }
    if (
        !Number.isInteger(port) ||
        port < 1024 ||
        port > 65535 ||
        path.resolve(cacheDir) !== cacheDir ||
        fs.realpathSync(cacheDir) !== cacheDir
    )
        throw new Error('Invalid cache directory or loopback port');
    const user = run('systemctl', ['show', 'thalassa-cache', '--property=User', '--value']);
    if (!/^[a-z_][a-z0-9_-]*[$]?$/.test(user) || user === 'root')
        throw new Error('A non-root service user is required');
    const stage = fs.mkdtempSync(path.join(CONTROL, 'stage-'));
    const entries = run('tar', ['-tzf', path.join(bundle, 'source.tar.gz')])
        .split('\n')
        .filter(Boolean);
    const detailedEntries = run('tar', ['-tvzf', path.join(bundle, 'source.tar.gz')])
        .split('\n')
        .filter(Boolean);
    verifyArchiveInventory(entries, detailedEntries, manifest.sourceFiles);
    run('tar', [
        '-xzf',
        path.join(bundle, 'source.tar.gz'),
        '--directory',
        stage,
        '--no-same-owner',
        '--no-same-permissions',
    ]);
    const source = inside(stage, path.join(stage, 'update10-source/pi-cache'));
    const cabinEntries = run('tar', ['-tzf', path.join(bundle, 'cabin.tar.gz')])
        .split('\n')
        .filter(Boolean);
    const cabinDetails = run('tar', ['-tvzf', path.join(bundle, 'cabin.tar.gz')])
        .split('\n')
        .filter(Boolean);
    verifyCabinArchiveInventory(cabinEntries, cabinDetails, manifest.cabinAssets);
    run('tar', [
        '-xzf',
        path.join(bundle, 'cabin.tar.gz'),
        '--directory',
        source,
        '--no-same-owner',
        '--no-same-permissions',
    ]);
    verifyCabinFiles(path.join(source, 'cabin-dist'), manifest.cabinAssets);
    run('chown', ['-R', user, stage]);
    for (const args of [
        ['ci', '--no-audit', '--no-fund'],
        ['run', 'build'],
        ['test'],
        ['prune', '--omit=dev', '--no-audit'],
    ])
        run('runuser', ['-u', user, '--', 'npm', ...args], { cwd: source, maxBuffer: 16 * 1024 * 1024 });
    return guarded(cacheDir, port, async () => {
        const backup = path.join(CONTROL, 'backups', `update10-${Date.now()}-${manifest.sourceCommit.slice(0, 12)}`);
        fs.mkdirSync(backup, { mode: 0o700 });
        // Finish a complete prior-code backup before touching any live path.
        copyCode(INSTALL, backup);
        if (!fs.existsSync(path.join(backup, 'dist/server.js'))) throw new Error('Prior server code is missing');
        const vault = active('thalassa-chart-vault');
        const record = { schema: 1, update: UPDATE10_NUMBER, sourceCommit: manifest.sourceCommit, backup, vault };
        fs.writeFileSync(path.join(CONTROL, 'last-backup.json'), JSON.stringify(record), { mode: 0o600 });
        stopWithVerifiedCabin(path.join(source, 'cabin-dist'), manifest.cabinAssets, () =>
            run('systemctl', ['stop', 'thalassa-cache']),
        );
        if (vault) run('systemctl', ['stop', 'thalassa-chart-vault']);
        try {
            removeCode(INSTALL);
            copyCode(source, INSTALL);
            if (vault) run('systemctl', ['start', 'thalassa-chart-vault']);
            run('systemctl', ['start', 'thalassa-cache']);
            await waitHealthy(port);
            fs.writeFileSync(path.join(CONTROL, 'installed.json'), JSON.stringify(manifest), { mode: 0o600 });
            return {
                installed: UPDATE10_NUMBER,
                commit: manifest.sourceCommit,
                rollback: `sudo ${shellArgument(path.join(bundle, 'rollback.sh'))} --apply --cache-dir ${shellArgument(cacheDir)} --port ${port}`,
                backup,
            };
        } catch (error) {
            run('systemctl', ['stop', 'thalassa-cache']);
            if (vault) run('systemctl', ['stop', 'thalassa-chart-vault']);
            removeCode(INSTALL);
            copyCode(backup, INSTALL);
            if (vault) run('systemctl', ['start', 'thalassa-chart-vault']);
            run('systemctl', ['start', 'thalassa-cache']);
            await waitHealthy(port);
            throw new Error(`Update failed and previous code was restored: ${error.message}`);
        }
    });
}
/** Shared by rollback and its filesystem-only admission controls; this never installs code. */
export function update10RollbackBackup(record, backupRoot = path.join(CONTROL, 'backups')) {
    if (!record || typeof record !== 'object' || typeof record.backup !== 'string')
        throw new Error('Complete prior code was not proven');
    const backup = inside(backupRoot, record.backup);
    if (record.schema !== 1 || record.update !== UPDATE10_NUMBER || !fs.existsSync(path.join(backup, 'dist/server.js')))
        throw new Error('Complete prior code was not proven');
    return backup;
}
export async function rollback({ cacheDir = `${INSTALL}/cache`, port = 3001 } = {}) {
    rootOnly();
    if (
        !Number.isInteger(port) ||
        port < 1024 ||
        port > 65535 ||
        path.resolve(cacheDir) !== cacheDir ||
        fs.realpathSync(cacheDir) !== cacheDir
    )
        throw new Error('Invalid cache directory or loopback port');
    const filename = path.join(CONTROL, 'last-backup.json');
    const info = plain(filename);
    if (info.uid !== 0 || info.mode & 0o022) throw new Error('Rollback record is not protected');
    const record = JSON.parse(fs.readFileSync(filename, 'utf8'));
    const backup = update10RollbackBackup(record);
    return guarded(cacheDir, port, async () => {
        run('systemctl', ['stop', 'thalassa-cache']);
        if (record.vault) run('systemctl', ['stop', 'thalassa-chart-vault']);
        const displaced = fs.mkdtempSync(path.join(CONTROL, 'rolled-back-update10-'));
        copyCode(INSTALL, displaced);
        removeCode(INSTALL);
        copyCode(backup, INSTALL);
        if (record.vault) run('systemctl', ['start', 'thalassa-chart-vault']);
        run('systemctl', ['start', 'thalassa-cache']);
        await waitHealthy(port);
        return { rolledBack: UPDATE10_NUMBER, displaced };
    });
}
