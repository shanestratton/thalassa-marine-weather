import { spawn, execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, readdir, rename, rm, stat, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import {
    CHARTWORLD_ARCHIVE_POLICY,
    CHARTWORLD_DOWNLOAD_POLICY,
    assertDownloadDestinationCapacity,
    assertDownloadedFileWithinPolicy,
    extractZipArchive,
    resolveDownloadByteBudget,
} from './resourceBoundary.js';
import { PiWorkloadBusyError, piWorkloadGovernor, type PiWorkloadLease } from './workloadGovernor.js';

const execFileAsync = promisify(execFile);

/**
 * ChartWorld auto-fetch — new chart purchases install themselves.
 *
 * ChartWorld exposes each licence over FTP with credentials shown on the
 * account page (username = licence id, password = customer id). Everything the
 * boat is entitled to sits in one directory: the S-63 exchange sets and the
 * current permit bundle. So the Pi can simply watch it.
 *
 *   buy a cell on chartworld.com  (from anywhere, on any device)
 *     → this poller sees a new .S63.ZIP in the licence directory
 *     → downloads it + the latest .prm.zip
 *     → installS63 writes the .os63 and builds the eSENC
 *     → encWatcher extracts and publishes it
 *     → the app syncs it
 *
 * No files to move, no terminal. The skipper buys a chart and it turns up.
 *
 * Deliberate constraints:
 *   - Credentials live in a 0600 config file, never in argv (the process table
 *     is world-readable) and never in a log line.
 *   - A state file records name+size per remote file, so a poll that finds
 *     nothing new costs one FTP listing and no downloads.
 *   - Permit bundles are re-fetched whenever they change: buying a second cell
 *     reissues PERMIT.TXT covering both, and installing against a stale bundle
 *     would fail on the new cell.
 *   - Off unless configured. No credentials, no polling, no outbound traffic.
 *
 * Config (`ENC_CHARTWORLD_CONFIG`, default ~/.config/thalassa/chartworld.json):
 *   {
 *     "host": "www.chartworld.com",
 *     "licence": "DC40966",     // FTP username, also the directory name
 *     "customer": "RE167",      // FTP password
 *     "pollMinutes": 60
 *   }
 */

const HOME = homedir();
const CONFIG_PATH = process.env.ENC_CHARTWORLD_CONFIG || join(HOME, '.config/thalassa/chartworld.json');
const DOWNLOAD_DIR = process.env.ENC_CHARTWORLD_DIR || join(HOME, 'Charts', 'chartworld');
const STATE_PATH = join(DOWNLOAD_DIR, '.sync-state.json');
const EXTRACTOR_DIR = process.env.ENC_EXTRACTOR_DIR || join(HOME, 'thalassa-marine-weather', 'tools', 'senc-extractor');
const ENABLED = process.env.ENC_CHARTWORLD_ENABLED !== 'false';

/** Poll floor — ChartWorld is a shop, not a feed; nothing changes minute to minute. */
const MIN_POLL_MINUTES = 15;
const DEFAULT_POLL_MINUTES = 60;
const INSTALL_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_INSTALL_OUTPUT_BYTES = 1024 * 1024;

interface ChartworldConfig {
    host: string;
    licence: string;
    customer: string;
    pollMinutes?: number;
}

interface RemoteFile {
    name: string;
    sizeBytes: number;
}

interface SyncState {
    version: 1;
    /** Remote filename → size we last successfully installed from. */
    seen: Record<string, number>;
    lastPollAt?: string;
}

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;
let ftpUnreachableReported = false;
let lastResult = 'never run';

async function loadConfig(): Promise<ChartworldConfig | null> {
    if (!existsSync(CONFIG_PATH)) return null;
    try {
        const cfg = JSON.parse(await readFile(CONFIG_PATH, 'utf8')) as ChartworldConfig;
        if (!cfg.host || !cfg.licence || !cfg.customer) {
            console.warn('[chartworld] config is missing host/licence/customer — not polling');
            return null;
        }
        return cfg;
    } catch (err) {
        console.warn(`[chartworld] config unreadable: ${(err as Error).message}`);
        return null;
    }
}

async function loadState(): Promise<SyncState> {
    try {
        const parsed = JSON.parse(await readFile(STATE_PATH, 'utf8')) as SyncState;
        if (parsed.version === 1 && parsed.seen) return parsed;
    } catch {
        /* first run, or corrupt — start clean */
    }
    return { version: 1, seen: {} };
}

async function saveState(state: SyncState): Promise<void> {
    await mkdir(DOWNLOAD_DIR, { recursive: true });
    await writeFile(STATE_PATH, JSON.stringify(state, null, 2));
}

/**
 * The FTP URL, credentials included.
 *
 * curl has no way to take FTP credentials off argv, so this string must never
 * be logged or put in an error message — callers log `redact()`ed forms only.
 */
function ftpUrl(cfg: ChartworldConfig, file = ''): string {
    const user = encodeURIComponent(cfg.licence);
    const pass = encodeURIComponent(cfg.customer);
    const encodedFile = file ? encodeURIComponent(file) : '';
    return `ftp://${user}:${pass}@${cfg.host}/${cfg.licence}/${encodedFile}`;
}

function redact(text: string, cfg: ChartworldConfig): string {
    return text.split(cfg.customer).join('***').split(`${cfg.licence}:`).join('***:');
}

function hasControlCharacter(value: string): boolean {
    for (let index = 0; index < value.length; index++) {
        const code = value.charCodeAt(index);
        if (code < 32 || code === 127) return true;
    }
    return false;
}

/** List the licence directory: names plus sizes, so a re-issued file is noticed. */
/** Files already sitting in the download directory, whatever put them there. */
export async function listLocal(): Promise<RemoteFile[]> {
    const files: RemoteFile[] = [];
    let names: string[];
    try {
        names = await readdir(DOWNLOAD_DIR);
    } catch {
        return files; // nothing dropped yet, or the directory does not exist
    }
    for (const name of names) {
        if (!/\.S63\.ZIP$/i.test(name) && !/\.prm\.zip$/i.test(name)) continue;
        if (name !== basename(name) || hasControlCharacter(name)) continue;
        try {
            const info = await stat(join(DOWNLOAD_DIR, name));
            if (info.isFile()) files.push({ name, sizeBytes: info.size });
        } catch {
            // vanished between readdir and stat; it will be seen next poll
        }
    }
    return files;
}

/**
 * Everything available to install, by either arrival route.
 *
 * ChartWorld's licence FTP went away with the Teledyne migration:
 * www.chartworld.com now resolves to Cloudflare, which carries no FTP at all,
 * and the surviving service host rejects the licence credentials. Permits and
 * exchange sets are downloaded from the ePORTAL by hand instead.
 *
 * So the download directory is now the primary source — anything dropped into
 * it is installed exactly as an FTP-fetched file would be, through the same
 * permit pairing, extraction and install path. FTP is still attempted whenever
 * a host is configured, so this resumes working untouched if the service ever
 * returns, but its absence is no longer an error. It is the expected state, and
 * an hourly failure line would only train the eye to skip the log.
 */
async function listAvailable(cfg: ChartworldConfig): Promise<{ files: RemoteFile[]; ftp: 'ok' | 'unreachable' }> {
    const local = await listLocal();
    try {
        const remote = await listRemote(cfg);
        // Remote sizes win: a set reissued under the same name must still count
        // as changed even if a stale copy of the old one is sitting on disk.
        const byName = new Map(local.map((f) => [f.name, f]));
        for (const f of remote) byName.set(f.name, f);
        return { files: [...byName.values()], ftp: 'ok' };
    } catch {
        return { files: local, ftp: 'unreachable' };
    }
}

async function listRemote(cfg: ChartworldConfig): Promise<RemoteFile[]> {
    // A bare listing gives names only; `-l` output carries the size we need to
    // spot a file that was reissued under the same name.
    const { stdout } = await execFileAsync('curl', ['-s', '--max-time', '60', ftpUrl(cfg)], {
        maxBuffer: 4 * 1024 * 1024,
    });
    const files: RemoteFile[] = [];
    for (const line of stdout.split('\n')) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 9) continue;
        const name = parts.slice(8).join(' ');
        const sizeBytes = Number(parts[4]);
        if (!name || name === '.' || name === '..' || !Number.isFinite(sizeBytes)) continue;
        files.push({ name, sizeBytes });
    }
    return files;
}

async function download(cfg: ChartworldConfig, remote: RemoteFile): Promise<string> {
    const name = remote.name;
    if (
        name !== basename(name) ||
        name === '.' ||
        name === '..' ||
        name.includes('/') ||
        name.includes('\\') ||
        hasControlCharacter(name)
    ) {
        throw new Error('remote filename is unsafe');
    }
    await mkdir(DOWNLOAD_DIR, { recursive: true });
    const dest = join(DOWNLOAD_DIR, name);
    // Already here at the expected size — a previous poll fetched it, or it was
    // downloaded from the ePORTAL by hand and dropped in. Nothing to fetch, and
    // no FTP host needs to exist for the install to proceed.
    try {
        const present = await stat(dest);
        if (present.isFile() && present.size === remote.sizeBytes) return dest;
    } catch {
        // not present; fall through and fetch it
    }
    await assertDownloadDestinationCapacity(dest, remote.sizeBytes, CHARTWORLD_DOWNLOAD_POLICY);
    // curl streams with native backpressure. Bound it by both the global byte
    // policy and the bytes currently available above the disk reserve, so a
    // lying FTP listing still cannot fill the filesystem.
    const byteBudget = await resolveDownloadByteBudget(dest, CHARTWORLD_DOWNLOAD_POLICY);
    const tmp = `${dest}.${process.pid}.${randomUUID()}.partial`;
    try {
        await execFileAsync('curl', [
            '--fail',
            '--silent',
            '--show-error',
            '--max-time',
            '900',
            '--max-filesize',
            String(byteBudget),
            '-o',
            tmp,
            ftpUrl(cfg, name),
        ]);
        await assertDownloadedFileWithinPolicy(tmp, CHARTWORLD_DOWNLOAD_POLICY);
        await rename(tmp, dest);
        return dest;
    } catch (error) {
        await unlink(tmp).catch(() => {});
        throw error;
    }
}

/**
 * Safely materialise a downloaded exchange set before handing it to the S-63
 * installer. Passing a directory makes installS63 skip its generic `unzip`
 * path, so the metadata-first limits and streamed extraction here remain the
 * only archive boundary.
 */
async function materialiseDownloadedArchive(filePath: string): Promise<string> {
    const extractionDir = `${filePath}.${process.pid}.${randomUUID()}.unpacked`;
    try {
        const extracted = await extractZipArchive(filePath, extractionDir, CHARTWORLD_ARCHIVE_POLICY);
        if (extracted.files.length === 0) throw new Error('Downloaded archive contained no files');
        return extractionDir;
    } catch (error) {
        await rm(extractionDir, { recursive: true, force: true }).catch(() => {});
        await unlink(filePath).catch(() => {});
        throw error;
    }
}

/** Run installS63 for one exchange set against the current permit bundle. */
function runInstall(exchangePath: string, permitPath: string): Promise<string> {
    return new Promise((resolvePromise, reject) => {
        const child = spawn(
            'npx',
            ['tsx', join(EXTRACTOR_DIR, 'src', 'installS63.ts'), '--exchange', exchangePath, '--permit', permitPath],
            {
                cwd: EXTRACTOR_DIR,
                env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=4096' },
                stdio: ['ignore', 'pipe', 'pipe'],
                timeout: INSTALL_TIMEOUT_MS,
            },
        );
        let out = '';
        child.stdout.on('data', (c: Buffer) => {
            const text = c.toString();
            out = `${out}${text}`.slice(-MAX_INSTALL_OUTPUT_BYTES);
            for (const line of text.split('\n')) {
                if (/installed|skipped|Installed \d/.test(line)) console.log(`[chartworld:install] ${line.trim()}`);
            }
        });
        child.stderr.on('data', (c: Buffer) => console.warn(`[chartworld:install] stderr: ${c.toString().trim()}`));
        child.on('exit', (code) => (code === 0 ? resolvePromise(out) : reject(new Error(`installS63 exited ${code}`))));
        child.on('error', reject);
    });
}

/**
 * One poll. Safe to call concurrently — overlapping runs are skipped rather
 * than queued, since the next tick will pick anything up anyway.
 */
export async function pollChartworldOnce(): Promise<string> {
    if (running) return 'already running';
    const cfg = await loadConfig();
    if (!cfg) return 'not configured';

    running = true;
    let workloadLease: PiWorkloadLease | null = null;
    let permitDir: string | null = null;
    try {
        const state = await loadState();
        const { files: remote, ftp } = await listAvailable(cfg);
        if (ftp === 'unreachable' && !ftpUnreachableReported) {
            ftpUnreachableReported = true;
            console.log(
                `[chartworld] licence FTP at ${cfg.host} is unreachable — installing from ` +
                    `${DOWNLOAD_DIR} instead. Download permits and exchange sets from the ` +
                    'ePORTAL and drop them there; they install the same way.',
            );
        }
        if (remote.length === 0) {
            lastResult = `nothing to install — drop ePORTAL downloads into ${DOWNLOAD_DIR}`;
            return lastResult;
        }

        const isExchange = (n: string): boolean => /\.S63\.ZIP$/i.test(n);
        const isPermit = (n: string): boolean => /\.prm\.zip$/i.test(n);
        const changed = (f: RemoteFile): boolean => state.seen[f.name] !== f.sizeBytes;

        // Always work against the newest permit bundle: a second purchase
        // reissues PERMIT.TXT to cover both cells, and installing a new cell
        // against the old bundle would fail for want of its permit line.
        const permits = remote.filter((f) => isPermit(f.name)).sort((a, b) => a.name.localeCompare(b.name));
        const permit = permits[permits.length - 1];
        if (!permit) {
            lastResult = 'no permit bundle in the licence directory';
            console.warn(`[chartworld] ${lastResult}`);
            return lastResult;
        }

        const newExchanges = remote.filter((f) => isExchange(f.name) && changed(f));
        const permitChanged = changed(permit);
        if (newExchanges.length === 0 && !permitChanged) {
            state.lastPollAt = new Date().toISOString();
            await saveState(state);
            lastResult = `up to date (${remote.filter((f) => isExchange(f.name)).length} exchange set(s))`;
            return lastResult;
        }

        console.log(
            `[chartworld] ${newExchanges.length} new/changed exchange set(s)` +
                (permitChanged ? ', permit bundle updated' : ''),
        );

        // The listing is lightweight and should not make a conversion wait.
        // Reserve the lane immediately before the first download/extraction
        // and keep it through all installs in this poll.
        workloadLease = await piWorkloadGovernor.admit('conversion').lease;
        const permitPath = await download(cfg, permit);
        permitDir = await materialiseDownloadedArchive(permitPath);
        // A reissued permit bundle can unlock cells whose exchange set we
        // already have, so reinstall everything rather than only the new sets.
        const toInstall = permitChanged ? remote.filter((f) => isExchange(f.name)) : newExchanges;

        let installed = 0;
        for (const file of toInstall) {
            let exchangeDir: string | null = null;
            try {
                const exchangePath = await download(cfg, file);
                exchangeDir = await materialiseDownloadedArchive(exchangePath);
                await runInstall(exchangeDir, permitDir);
                state.seen[file.name] = file.sizeBytes;
                installed += 1;
            } catch (err) {
                // Leave this file out of `seen` so the next poll retries it.
                console.warn(`[chartworld] ${file.name} failed: ${redact((err as Error).message, cfg)}`);
            } finally {
                if (exchangeDir) await rm(exchangeDir, { recursive: true, force: true }).catch(() => {});
            }
        }
        state.seen[permit.name] = permit.sizeBytes;
        state.lastPollAt = new Date().toISOString();
        await saveState(state);

        lastResult = `installed ${installed}/${toInstall.length} exchange set(s)`;
        console.log(`[chartworld] ${lastResult} — encWatcher will publish them shortly`);
        return lastResult;
    } catch (err) {
        lastResult =
            err instanceof PiWorkloadBusyError
                ? `poll deferred: ${err.message}`
                : `poll failed: ${redact((err as Error).message, cfg)}`;
        console.warn(`[chartworld] ${lastResult}`);
        return lastResult;
    } finally {
        if (permitDir) await rm(permitDir, { recursive: true, force: true }).catch(() => {});
        workloadLease?.release();
        running = false;
    }
}

export async function startChartworldSync(): Promise<void> {
    if (!ENABLED) {
        console.log('[chartworld] disabled via ENC_CHARTWORLD_ENABLED=false');
        return;
    }
    const cfg = await loadConfig();
    if (!cfg) {
        console.log(`[chartworld] no config at ${CONFIG_PATH} — auto-fetch off`);
        return;
    }
    const minutes = Math.max(MIN_POLL_MINUTES, cfg.pollMinutes ?? DEFAULT_POLL_MINUTES);
    console.log(`[chartworld] watching licence ${cfg.licence} at ${cfg.host} every ${minutes} min`);

    // First poll deferred — let the server finish coming up.
    setTimeout(() => void pollChartworldOnce(), 60_000);
    if (!timer) timer = setInterval(() => void pollChartworldOnce(), minutes * 60_000);
}

export function stopChartworldSync(): void {
    if (timer) {
        clearInterval(timer);
        timer = null;
    }
}

export function getChartworldStatus(): {
    configured: boolean;
    enabled: boolean;
    polling: boolean;
    configPath: string;
    downloadDir: string;
    lastResult: string;
} {
    return {
        configured: existsSync(CONFIG_PATH),
        enabled: ENABLED,
        polling: timer !== null,
        configPath: CONFIG_PATH,
        downloadDir: resolve(DOWNLOAD_DIR),
        lastResult,
    };
}
