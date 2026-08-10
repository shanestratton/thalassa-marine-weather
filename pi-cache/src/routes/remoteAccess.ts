import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { Router, type Request, type Response } from 'express';

/**
 * Remote access via the punter's own Tailscale account.
 *
 * The Pi ships with tailscaled installed-but-idle (install.sh); these
 * endpoints let the PAIRED app drive it without the punter ever touching a
 * terminal:
 *
 *   GET  /api/remote-access          state machine + auth URL + tailnet ips
 *   POST /api/remote-access/enable   start `tailscale up`, hand back the
 *                                    login URL for the app to open
 *   POST /api/remote-access/disable  `tailscale down` (body {logout:true}
 *                                    fully detaches the account)
 *
 * Security posture: the transport to these endpoints is the pinned-TLS
 * pairing channel, and the mount adds the same admin gate /api/configure
 * uses. Tailscale is started with --accept-dns=false and
 * --accept-routes=false so joining a tailnet can never rewrite the Pi's
 * resolver or routing table — the appliance stays a plain LAN server that
 * happens to also answer on a 100.x address. Identity off-boat is exactly
 * the identity on-boat: the pinned key + challenge-response, which does not
 * care what network the bytes crossed.
 */

type RemoteAccessState = 'not-installed' | 'stopped' | 'needs-auth' | 'starting' | 'connected' | 'error';

interface RemoteAccessStatus {
    state: RemoteAccessState;
    /** Present while state==='needs-auth' — open in a browser, sign in. */
    authUrl?: string;
    /** Tailnet addresses (100.x IPv4 first) once connected. */
    tailscaleIps?: string[];
    /** MagicDNS name, e.g. "calypso.tail1234.ts.net." */
    dnsName?: string;
    message?: string;
}

const EXEC_TIMEOUT_MS = 10_000;
/** How long /enable waits for `tailscale up` to either finish (already
 *  authorised) or print its login URL before answering with whatever the
 *  status endpoint can see. */
const ENABLE_WAIT_MS = 8_000;
const LOGIN_URL_RE = /https:\/\/login\.tailscale\.com\/\S+/;

function run(args: string[]): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
        execFile('tailscale', args, { timeout: EXEC_TIMEOUT_MS }, (err, stdout, stderr) => {
            if (err && !stdout) reject(Object.assign(err, { stderr: String(stderr ?? '') }));
            else resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
        });
    });
}

/** The blocking `tailscale up` we keep alive while the punter signs in.
 *  Module scope: a second /enable must reuse it, not stack another. */
let loginChild: ChildProcess | null = null;
let lastSeenAuthUrl: string | null = null;

async function readStatus(): Promise<RemoteAccessStatus> {
    let raw: string;
    try {
        raw = (await run(['status', '--json'])).stdout;
    } catch (err) {
        const e = err as NodeJS.ErrnoException & { stderr?: string };
        if (e.code === 'ENOENT') return { state: 'not-installed' };
        // tailscaled not running yet also lands here.
        return { state: 'stopped', message: (e.stderr || e.message || '').slice(0, 200) };
    }
    try {
        const parsed = JSON.parse(raw) as {
            BackendState?: string;
            AuthURL?: string;
            Self?: { DNSName?: string; TailscaleIPs?: string[] };
        };
        const backend = parsed.BackendState ?? '';
        if (backend === 'Running') {
            const ips = (parsed.Self?.TailscaleIPs ?? []).slice().sort(
                // IPv4 (100.x) first — always routable on the tailnet, no
                // bracket handling needed in URLs.
                (a, b) => Number(b.includes('.')) - Number(a.includes('.')),
            );
            return { state: 'connected', tailscaleIps: ips, dnsName: parsed.Self?.DNSName };
        }
        if (backend === 'NeedsLogin' || backend === 'NeedsMachineAuth') {
            const authUrl = parsed.AuthURL || lastSeenAuthUrl || undefined;
            return { state: 'needs-auth', authUrl };
        }
        if (backend === 'Starting') return { state: 'starting' };
        return { state: 'stopped', message: backend || undefined };
    } catch {
        return { state: 'error', message: 'unparseable tailscale status' };
    }
}

/** Kick `tailscale up` and resolve as soon as we have something to show:
 *  a login URL on stderr, process exit (already authorised), or timeout. */
function startLogin(): Promise<void> {
    if (loginChild && loginChild.exitCode === null) return Promise.resolve();
    lastSeenAuthUrl = null;
    const child = spawn('tailscale', ['up', '--accept-dns=false', '--accept-routes=false'], {
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    loginChild = child;
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, ENABLE_WAIT_MS);
        const sniff = (chunk: Buffer): void => {
            const m = LOGIN_URL_RE.exec(chunk.toString());
            if (m) {
                lastSeenAuthUrl = m[0];
                clearTimeout(timer);
                resolve();
            }
        };
        child.stdout?.on('data', sniff);
        child.stderr?.on('data', sniff);
        child.on('exit', () => {
            if (loginChild === child) loginChild = null;
            clearTimeout(timer);
            resolve();
        });
        child.on('error', () => {
            if (loginChild === child) loginChild = null;
            clearTimeout(timer);
            resolve();
        });
    });
}

export function createRemoteAccessRoutes(): Router {
    const router = Router();

    router.get('/', async (_req: Request, res: Response) => {
        res.json(await readStatus());
    });

    router.post('/enable', async (_req: Request, res: Response) => {
        const before = await readStatus();
        if (before.state === 'not-installed') {
            return res.status(409).json(before);
        }
        if (before.state === 'connected') return res.json(before);
        await startLogin();
        return res.json(await readStatus());
    });

    router.post('/disable', async (req: Request, res: Response) => {
        try {
            if (loginChild && loginChild.exitCode === null) {
                loginChild.kill();
                loginChild = null;
            }
            await run(['down']);
            if ((req.body as { logout?: boolean } | undefined)?.logout) {
                await run(['logout']);
            }
        } catch {
            /* fall through to status — down on a stopped node is a no-op */
        }
        return res.json(await readStatus());
    });

    return router;
}
