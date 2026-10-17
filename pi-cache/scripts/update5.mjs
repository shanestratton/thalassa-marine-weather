/** Staged update controls. This module never changes a Pi merely by being imported. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const INSTALL = '/opt/thalassa-pi-cache';
export const CONTROL = '/opt/thalassa-update5';
export const CODE = Object.freeze([
    'src',
    'scripts',
    'systemd',
    'docs',
    'dist',
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
const PACKED = ['manifest.json', 'source.tar.gz', 'install.mjs', 'rollback.mjs', 'update5.mjs'];
// Update 5 is retained for the reviewed app releases; future builds require an explicit compatibility review.
export const UPDATE5_APP_BUILDS = Object.freeze([133, 134, 135]);
export function update5NativeBuild(project) {
    const builds = [...project.matchAll(/CURRENT_PROJECT_VERSION = (\d+);/g)];
    const build = Number(builds[0]?.[1]);
    if (
        builds.length !== 4 ||
        !UPDATE5_APP_BUILDS.includes(build) ||
        builds.some((value) => value[1] !== String(build))
    )
        throw new Error('Exactly four matching native build-133, build-134 or build-135 configurations are required');
    return build;
}
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
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
export function verifyBundle(directory) {
    const root = fs.realpathSync(directory);
    const lines = fs.readFileSync(path.join(root, 'SHA256SUMS'), 'utf8').trim().split('\n');
    if (lines.length !== PACKED.length) throw new Error('Incomplete checksum inventory');
    const names = new Set();
    for (const line of lines) {
        const match = /^([0-9a-f]{64}) {2}([a-zA-Z0-9.-]+)$/.exec(line);
        if (!match || !PACKED.includes(match[2]) || names.has(match[2])) throw new Error('Unexpected checksum member');
        names.add(match[2]);
        const filename = inside(root, path.join(root, match[2]));
        plain(filename);
        if (sha256(fs.readFileSync(filename)) !== match[1]) throw new Error(`Checksum mismatch: ${match[2]}`);
    }
    const m = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
    if (
        m.schema !== 1 ||
        m.update !== 5 ||
        !UPDATE5_APP_BUILDS.includes(m.appBuild) ||
        !/^[0-9a-f]{40}$/.test(m.sourceCommit) ||
        m.payloadSha256 !== sha256(fs.readFileSync(path.join(root, 'source.tar.gz'))) ||
        m.guardVersion !== 1 ||
        !Array.isArray(m.sourceFiles) ||
        !m.sourceFiles.length ||
        m.sourceFiles.length > 10000 ||
        new Set(m.sourceFiles).size !== m.sourceFiles.length ||
        m.sourceFiles.some(
            (file) =>
                !/^pi-cache\/[A-Za-z0-9_./-]+$/.test(file) ||
                file.split('/').includes('..') ||
                /\/(?:cache|identity|enc-charts|node_modules|dist)\//.test(file) ||
                /\.(?:oesu|oesenc|kap|000|p12|p8|pem|key)$/i.test(file) ||
                /\/(?:\.env|github-token)$/.test(file),
        )
    )
        throw new Error('Invalid update-5 manifest or source boundary');
    return m;
}
export function verifyArchiveInventory(entries, detailedEntries, sourceFiles) {
    const allowed = new Set(sourceFiles.map((file) => `update5-source/${file}`));
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
    const source = inside(stage, path.join(stage, 'update5-source/pi-cache'));
    run('chown', ['-R', user, stage]);
    for (const args of [
        ['ci', '--no-audit', '--no-fund'],
        ['run', 'build'],
        ['test'],
        ['prune', '--omit=dev', '--no-audit'],
    ])
        run('runuser', ['-u', user, '--', 'npm', ...args], { cwd: source, maxBuffer: 16 * 1024 * 1024 });
    return guarded(cacheDir, port, async () => {
        const backup = path.join(CONTROL, 'backups', `update5-${Date.now()}-${manifest.sourceCommit.slice(0, 12)}`);
        fs.mkdirSync(backup, { mode: 0o700 });
        // Finish a complete prior-code backup before touching any live path.
        copyCode(INSTALL, backup);
        if (!fs.existsSync(path.join(backup, 'dist/server.js'))) throw new Error('Prior server code is missing');
        const vault = active('thalassa-chart-vault');
        const record = { schema: 1, update: 5, sourceCommit: manifest.sourceCommit, backup, vault };
        fs.writeFileSync(path.join(CONTROL, 'last-backup.json'), JSON.stringify(record), { mode: 0o600 });
        run('systemctl', ['stop', 'thalassa-cache']);
        if (vault) run('systemctl', ['stop', 'thalassa-chart-vault']);
        try {
            removeCode(INSTALL);
            copyCode(source, INSTALL);
            if (vault) run('systemctl', ['start', 'thalassa-chart-vault']);
            run('systemctl', ['start', 'thalassa-cache']);
            await waitHealthy(port);
            fs.writeFileSync(path.join(CONTROL, 'installed.json'), JSON.stringify(manifest), { mode: 0o600 });
            return {
                installed: 5,
                commit: manifest.sourceCommit,
                rollback: `sudo node ${path.join(bundle, 'rollback.mjs')} --apply`,
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
    const backup = inside(path.join(CONTROL, 'backups'), record.backup);
    if (record.schema !== 1 || record.update !== 5 || !fs.existsSync(path.join(backup, 'dist/server.js')))
        throw new Error('Complete prior code was not proven');
    return guarded(cacheDir, port, async () => {
        run('systemctl', ['stop', 'thalassa-cache']);
        if (record.vault) run('systemctl', ['stop', 'thalassa-chart-vault']);
        const displaced = fs.mkdtempSync(path.join(CONTROL, 'rolled-back-update5-'));
        copyCode(INSTALL, displaced);
        removeCode(INSTALL);
        copyCode(backup, INSTALL);
        if (record.vault) run('systemctl', ['start', 'thalassa-chart-vault']);
        run('systemctl', ['start', 'thalassa-cache']);
        await waitHealthy(port);
        return { rolledBack: 5, displaced };
    });
}
