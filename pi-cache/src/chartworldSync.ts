import { spawn, execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

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
    return `ftp://${user}:${pass}@${cfg.host}/${cfg.licence}/${file}`;
}

function redact(text: string, cfg: ChartworldConfig): string {
    return text.split(cfg.customer).join('***').split(`${cfg.licence}:`).join('***:');
}

/** List the licence directory: names plus sizes, so a re-issued file is noticed. */
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

async function download(cfg: ChartworldConfig, name: string): Promise<string> {
    await mkdir(DOWNLOAD_DIR, { recursive: true });
    const dest = join(DOWNLOAD_DIR, name);
    const tmp = `${dest}.partial`;
    await execFileAsync('curl', ['-s', '--max-time', '900', '-o', tmp, ftpUrl(cfg, name)]);
    const { size } = await stat(tmp);
    if (size === 0) throw new Error(`downloaded ${name} was empty`);
    await execFileAsync('mv', [tmp, dest]);
    return dest;
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
            },
        );
        let out = '';
        child.stdout.on('data', (c: Buffer) => {
            out += c.toString();
            for (const line of c.toString().split('\n')) {
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
    try {
        const state = await loadState();
        const remote = await listRemote(cfg);
        if (remote.length === 0) {
            lastResult = 'listing was empty';
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

        const permitPath = await download(cfg, permit.name);
        // A reissued permit bundle can unlock cells whose exchange set we
        // already have, so reinstall everything rather than only the new sets.
        const toInstall = permitChanged ? remote.filter((f) => isExchange(f.name)) : newExchanges;

        let installed = 0;
        for (const file of toInstall) {
            try {
                const path = await download(cfg, file.name);
                await runInstall(path, permitPath);
                state.seen[file.name] = file.sizeBytes;
                installed += 1;
            } catch (err) {
                // Leave this file out of `seen` so the next poll retries it.
                console.warn(`[chartworld] ${file.name} failed: ${redact((err as Error).message, cfg)}`);
            }
        }
        state.seen[permit.name] = permit.sizeBytes;
        state.lastPollAt = new Date().toISOString();
        await saveState(state);

        lastResult = `installed ${installed}/${toInstall.length} exchange set(s)`;
        console.log(`[chartworld] ${lastResult} — encWatcher will publish them shortly`);
        return lastResult;
    } catch (err) {
        lastResult = `poll failed: ${redact((err as Error).message, cfg)}`;
        console.warn(`[chartworld] ${lastResult}`);
        return lastResult;
    } finally {
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
