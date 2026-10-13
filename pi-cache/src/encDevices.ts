/**
 * Who may get the boat's charts (127-C-d decisions 4 and 5).
 *
 * THE FRONT DOOR. Every /api/enc route passes one router-level middleware with
 * three checks, in order:
 *   1. `Cache-Control: no-store` and `Pragma: no-cache` on every response,
 *      errors included;
 *   2. the boat's own Wi-Fi only: the socket's peer must be IPv4, inside the
 *      subnet of a non-tailscale, non-loopback interface, and not that
 *      network's gateway (the RUTX50 advertises 192.168.1.0/24 to the tailnet,
 *      so a tailnet device routed through it arrives AS the router), not
 *      100.64.0.0/10, not loopback (a future `tailscale serve`), not this Pi.
 *      X-Forwarded-For is never read. Refused: 403 charts-boat-wifi-only;
 *   3. a device token, `X-Thalassa-Chart-Device: <43-char base64url>`, of an
 *      enrolled device, compared by SHA-256 with timingSafeEqual. Without one:
 *      401 chart-device-not-enrolled; a removed device: chart-device-removed.
 * Only POST /devices/enrol (it takes a code) and GET /devices/status (no data)
 * skip the token. Nothing skips the first two.
 *
 * ENROLMENT. A code is 10 Crockford base32 characters (50 bits), lasts 15
 * minutes (the install's first code 30), and works once; at most 3 are
 * pending (a fourth retires the oldest). Five devices at most: a sixth gets
 * 409 chart-device-limit. Five wrong codes in 10 minutes from one address, or
 * 20 in an hour overall, answer 429 chart-code-tries. The Pi keeps only the
 * SHA-256 of each code and token, in CACHE_DIR/enc-devices.json (0600).
 * dist/vault/enrolCode.js mints a code (or removes a device) from a shell.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { seenFromAddress } from './requestPath.js';

export const CHART_DEVICE_HEADER = 'x-thalassa-chart-device';
export const MAX_CHART_DEVICES = 5;
export const CODE_TTL_MS = 15 * 60 * 1000;
export const INSTALL_CODE_TTL_MS = 30 * 60 * 1000;
export const MAX_PENDING_CODES = 3;
const WRONG_PER_PEER = { limit: 5, windowMs: 10 * 60 * 1000 };
const WRONG_OVERALL = { limit: 20, windowMs: 60 * 60 * 1000 };
/** lastSeenAt is written at most this often per device. */
const SEEN_WRITE_EVERY_MS = 5 * 60 * 1000;
const KEPT_REMOVALS = 20;
/** enc-devices.json.lock older than this is a writer that died mid-change. */
const LOCK_STALE_MS = 10 * 1000;
/** A change waits this long for another process's change to finish. */
const LOCK_WAIT_MS = 5 * 1000;

/** Every refusal code this module and the vault routes send (each has words in the app). */
export const PI_CHART_ACCESS_CODES = [
    'charts-boat-wifi-only',
    'chart-device-not-enrolled',
    'chart-device-removed',
    'chart-device-limit',
    'chart-code-invalid',
    'chart-code-tries',
    'vault-starting',
    'vault-busy',
    'vault-decoder-down',
] as const;

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** As the app reads a code (services/enc/piChartDevice.ts): no spaces or dashes, O as 0, I or L as 1. */
export function normaliseChartCode(input: unknown): string | null {
    if (typeof input !== 'string') return null;
    const code = input.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
    return /^[0-9A-HJKMNP-TV-Z]{10}$/.test(code) ? code : null;
}

function newCode(): string {
    // 50 bits: ten 5-bit symbols from 7 random bytes.
    const bytes = randomBytes(7);
    let bits = 0n;
    for (const b of bytes) bits = (bits << 8n) | BigInt(b);
    let out = '';
    for (let i = 0; i < 10; i++) out += CROCKFORD[Number((bits >> BigInt(i * 5)) & 31n)];
    return out;
}

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest();
const hex = (buf: Buffer) => buf.toString('hex');

export class ChartDeviceError extends Error {
    constructor(
        public readonly status: number,
        public readonly code: string,
        message: string,
        public readonly retryAfterSeconds?: number,
    ) {
        super(message);
        this.name = 'ChartDeviceError';
    }
}

interface StoredDevice {
    id: string;
    label: string;
    tokenSha256: string;
    enrolledAt: string;
    lastSeenAt: string;
}

interface StoredFile {
    version: 1;
    devices: StoredDevice[];
    removed: { id: string; tokenSha256: string; removedAt: string }[];
    codes: { codeSha256: string; expiresAt: string }[];
}

export interface ChartDevicePublic {
    id: string;
    label: string;
    enrolledAt: string;
    lastSeenAt: string;
}

export type ChartDeviceVerdict =
    | { state: 'enrolled'; device: ChartDevicePublic }
    | { state: 'removed' }
    | { state: 'unknown' };

const empty = (): StoredFile => ({ version: 1, devices: [], removed: [], codes: [] });

function label(input: unknown): string {
    // Printable characters only: a label is shown in a list, never interpreted.
    const text =
        typeof input === 'string'
            ? [...input]
                  .filter((ch) => ch.charCodeAt(0) >= 32 && ch.charCodeAt(0) !== 127)
                  .join('')
                  .trim()
            : '';
    return text.slice(0, 40) || 'Device';
}

export class EncDeviceStore {
    private readonly now: () => number;
    private cached: { mtimeMs: number; size: number; file: StoredFile } | null = null;
    private mutation: Promise<unknown> = Promise.resolve();
    private readonly wrong = new Map<string, number[]>();
    private wrongAll: number[] = [];
    private readonly seenWritten = new Map<string, number>();
    private readonly served = new Set<string>();
    private readonly beforeWrite?: () => Promise<void>;

    constructor(
        private readonly file: string,
        options: {
            now?: () => number;
            /** A test seam: runs inside a change, between its read and its write. */
            beforeWrite?: () => Promise<void>;
        } = {},
    ) {
        this.now = options.now ?? Date.now;
        this.beforeWrite = options.beforeWrite;
    }

    /** Mint a one-time code. Shown once, to the caller; only its hash is kept. */
    async mintCode(options: { ttlMs?: number } = {}): Promise<{ code: string; expiresAt: string }> {
        const code = newCode();
        const expiresAt = new Date(this.now() + (options.ttlMs ?? CODE_TTL_MS)).toISOString();
        await this.mutate((file) => {
            file.codes = this.liveCodes(file);
            file.codes.push({ codeSha256: hex(sha256(code)), expiresAt });
            while (file.codes.length > MAX_PENDING_CODES) file.codes.shift();
        });
        return { code, expiresAt };
    }

    /** Enrol a device with a code typed on it. Throws ChartDeviceError. */
    async enrol(input: unknown, deviceLabel: unknown, peer: string): Promise<{ deviceId: string; token: string }> {
        const now = this.now();
        this.prune(now);
        const peerTries = this.wrong.get(peer) ?? [];
        const blockedUntil = Math.min(
            peerTries.length >= WRONG_PER_PEER.limit ? peerTries[0] + WRONG_PER_PEER.windowMs : Infinity,
            this.wrongAll.length >= WRONG_OVERALL.limit ? this.wrongAll[0] + WRONG_OVERALL.windowMs : Infinity,
        );
        if (blockedUntil !== Infinity) {
            throw new ChartDeviceError(
                429,
                'chart-code-tries',
                'Too many wrong codes. Wait 10 minutes, then try again.',
                Math.max(1, Math.ceil((blockedUntil - now) / 1000)),
            );
        }
        const code = normaliseChartCode(input);
        return this.mutate((file) => {
            file.codes = this.liveCodes(file);
            const given = code ? sha256(code) : null;
            const match = given
                ? file.codes.findIndex((c) => timingSafeEqual(Buffer.from(c.codeSha256, 'hex'), given))
                : -1;
            if (match < 0) {
                this.wrong.set(peer, [...(this.wrong.get(peer) ?? []), now]);
                this.wrongAll.push(now);
                throw new ChartDeviceError(403, 'chart-code-invalid', "That code didn't work.");
            }
            if (file.devices.length >= MAX_CHART_DEVICES) {
                throw new ChartDeviceError(
                    409,
                    'chart-device-limit',
                    `${MAX_CHART_DEVICES} phones and tablets already get this boat's charts. Remove one to add this one.`,
                );
            }
            file.codes.splice(match, 1);
            const token = randomBytes(32).toString('base64url');
            const id = randomUUID();
            const at = new Date(now).toISOString();
            // Enrolment is a sighting: no lastSeenAt write for the next few minutes.
            this.seenWritten.set(id, now);
            file.devices.push({
                id,
                label: label(deviceLabel),
                tokenSha256: hex(sha256(token)),
                enrolledAt: at,
                lastSeenAt: at,
            });
            return { deviceId: id, token };
        });
    }

    /** Whose token is this? Compared by hash, in constant time per device. */
    async verify(token: unknown): Promise<ChartDeviceVerdict> {
        if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return { state: 'unknown' };
        const file = await this.read();
        const given = sha256(token);
        const same = (stored: string) => timingSafeEqual(Buffer.from(stored, 'hex'), given);
        let found: StoredDevice | undefined;
        for (const d of file.devices) if (same(d.tokenSha256)) found = d;
        if (found) {
            void this.touch(found.id);
            return { state: 'enrolled', device: this.public(found) };
        }
        let removed = false;
        for (const r of file.removed) if (same(r.tokenSha256)) removed = true;
        return { state: removed ? 'removed' : 'unknown' };
    }

    async list(): Promise<ChartDevicePublic[]> {
        return (await this.read()).devices.map((d) => this.public(d));
    }

    async remove(id: string): Promise<boolean> {
        return this.mutate((file) => {
            const at = file.devices.findIndex((d) => d.id === id);
            if (at < 0) return false;
            const [gone] = file.devices.splice(at, 1);
            file.removed.push({
                id: gone.id,
                tokenSha256: gone.tokenSha256,
                removedAt: new Date(this.now()).toISOString(),
            });
            while (file.removed.length > KEPT_REMOVALS) file.removed.shift();
            this.served.delete(id);
            return true;
        });
    }

    /** A device received a whole cell from the vault (purge.sh's phone smoke reads the count). */
    markServed(deviceId: string): void {
        this.served.add(deviceId);
    }

    servedToDevices(): number {
        return this.served.size;
    }

    private public(d: StoredDevice): ChartDevicePublic {
        return { id: d.id, label: d.label, enrolledAt: d.enrolledAt, lastSeenAt: d.lastSeenAt };
    }

    private async touch(id: string): Promise<void> {
        const now = this.now();
        if (now - (this.seenWritten.get(id) ?? 0) < SEEN_WRITE_EVERY_MS) return;
        this.seenWritten.set(id, now);
        await this.mutate((file) => {
            const d = file.devices.find((x) => x.id === id);
            if (d) d.lastSeenAt = new Date(now).toISOString();
        }).catch(() => undefined);
    }

    private liveCodes(file: StoredFile) {
        const now = this.now();
        return file.codes.filter((c) => Date.parse(c.expiresAt) > now);
    }

    private prune(now: number): void {
        for (const [peer, times] of this.wrong) {
            const kept = times.filter((t) => now - t < WRONG_PER_PEER.windowMs);
            if (kept.length) this.wrong.set(peer, kept);
            else this.wrong.delete(peer);
        }
        this.wrongAll = this.wrongAll.filter((t) => now - t < WRONG_OVERALL.windowMs);
    }

    /** The file as it is on disk now (another process may have minted a code). */
    private async read(): Promise<StoredFile> {
        let stat;
        try {
            stat = await fs.stat(this.file);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return empty();
            throw error;
        }
        if (this.cached && this.cached.mtimeMs === stat.mtimeMs && this.cached.size === stat.size)
            return this.cached.file;
        let file: StoredFile;
        try {
            const parsed = JSON.parse(await fs.readFile(this.file, 'utf8')) as Partial<StoredFile>;
            file = {
                version: 1,
                devices: Array.isArray(parsed.devices) ? parsed.devices : [],
                removed: Array.isArray(parsed.removed) ? parsed.removed : [],
                codes: Array.isArray(parsed.codes) ? parsed.codes : [],
            };
        } catch {
            // Fail closed: an unreadable file enrols nobody, and is never overwritten silently.
            throw new ChartDeviceError(500, 'chart-devices-unreadable', 'The Pi could not read its chart device list.');
        }
        this.cached = { mtimeMs: stat.mtimeMs, size: stat.size, file };
        return file;
    }

    /**
     * One change at a time, read fresh from disk and written back atomically
     * (0600). Within this process the promise chain orders them; across
     * processes (enrolCode.js --remove over ssh while the service writes a
     * lastSeenAt) a lock file beside the list does, so neither writes back a
     * list it read before the other's change.
     */
    private mutate<T>(change: (file: StoredFile) => T): Promise<T> {
        const run = this.mutation.then(async () => {
            await fs.mkdir(path.dirname(this.file), { recursive: true });
            return this.locked(async () => {
                this.cached = null;
                const file = structuredClone(await this.read());
                const result = change(file);
                await this.beforeWrite?.();
                const temporary = path.join(
                    path.dirname(this.file),
                    `.${path.basename(this.file)}.${randomUUID()}.tmp`,
                );
                try {
                    await fs.writeFile(temporary, `${JSON.stringify(file, null, 1)}\n`, { mode: 0o600 });
                    await fs.rename(temporary, this.file);
                } catch (error) {
                    await fs.unlink(temporary).catch(() => {});
                    throw error;
                }
                this.cached = null;
                return result;
            });
        });
        this.mutation = run.catch(() => undefined);
        return run;
    }

    /** Hold enc-devices.json.lock (O_EXCL) around `work`; a lock left by a dead writer goes after 10 s. */
    private async locked<T>(work: () => Promise<T>): Promise<T> {
        const lock = `${this.file}.lock`;
        const deadline = Date.now() + LOCK_WAIT_MS;
        for (;;) {
            try {
                const handle = await fs.open(lock, 'wx', 0o600);
                await handle.writeFile(`${process.pid}\n`).finally(() => handle.close());
                break;
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
                const held = await fs.stat(lock).catch(() => null);
                if (held && Date.now() - held.mtimeMs > LOCK_STALE_MS) {
                    await fs.unlink(lock).catch(() => {});
                    continue;
                }
                if (Date.now() > deadline)
                    throw new ChartDeviceError(503, 'vault-busy', 'The Pi is busy. Try again in a moment.', 2);
                await new Promise((resolve) => setTimeout(resolve, 25));
            }
        }
        try {
            return await work();
        } finally {
            await fs.unlink(lock).catch(() => {});
        }
    }
}

// ── The boat's own Wi-Fi ─────────────────────────────────────────────────────

export interface BoatLanView {
    interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>;
    /** Default gateways (dotted IPv4). */
    gateways: string[];
}

/** Default gateways from /proc/net/route (destination 00000000; addresses are little-endian hex). */
export function parseProcNetRoute(text: string): string[] {
    const out: string[] = [];
    for (const line of text.split('\n').slice(1)) {
        const cols = line.trim().split(/\s+/);
        if (cols.length < 3 || cols[1] !== '00000000' || !/^[0-9A-Fa-f]{8}$/.test(cols[2])) continue;
        const n = parseInt(cols[2], 16);
        const ip = [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255].join('.');
        if (ip !== '0.0.0.0' && !out.includes(ip)) out.push(ip);
    }
    return out;
}

/** This Pi's interfaces and default gateways, now. */
export function readBoatLanView(): BoatLanView {
    let gateways: string[] = [];
    try {
        gateways = parseProcNetRoute(readFileSync('/proc/net/route', 'utf8'));
    } catch {
        /* not Linux: no gateway list */
    }
    return { interfaces: os.networkInterfaces(), gateways };
}

const ipv4 = (address: string): number | null => {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address);
    if (!m) return null;
    const parts = m.slice(1).map(Number);
    if (parts.some((p) => p > 255)) return null;
    return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
};

const inNet = (ip: number, base: number, mask: number) => (ip & mask) >>> 0 === (base & mask) >>> 0;
const TAILNET = ipv4('100.64.0.0')!;
const TAILNET_MASK = ipv4('255.192.0.0')!;

export type PeerSeenAs = 'boat-wifi' | 'router' | 'tailnet' | 'loopback' | 'ipv6' | 'this-pi' | 'other';

/** Is this peer a device on the boat's own Wi-Fi? */
export function classifyPeer(remote: string | undefined, view: BoatLanView): { boatLan: boolean; seenAs: PeerSeenAs } {
    const no = (seenAs: PeerSeenAs) => ({ boatLan: false, seenAs });
    const v4 = seenFromAddress(remote ?? null);
    if (!v4) return no(typeof remote === 'string' && remote.includes(':') ? 'ipv6' : 'other');
    const ip = ipv4(v4)!;
    if (v4.startsWith('127.')) return no('loopback');
    if (inNet(ip, TAILNET, TAILNET_MASK)) return no('tailnet');
    if (view.gateways.includes(v4)) return no('router');
    for (const [name, infos] of Object.entries(view.interfaces)) {
        if (!infos || /^(tailscale|ts\d|utun|wg|zt)/i.test(name)) continue;
        for (const info of infos) {
            if (info.family !== 'IPv4' || info.internal) continue;
            const base = ipv4(info.address);
            const mask = ipv4(info.netmask);
            if (base === null || mask === null || inNet(base, TAILNET, TAILNET_MASK)) continue;
            if (ip === base) return no('this-pi');
            if (inNet(ip, base, mask)) return { boatLan: true, seenAs: 'boat-wifi' };
        }
    }
    return no('other');
}

// ── The middleware ───────────────────────────────────────────────────────────

/** Paths (under /api/enc) that need no token: they take a code, or say nothing but "set up or not". */
export const UNTOKENED_ENC_ROUTES = new Set(['POST /devices/enrol', 'GET /devices/status']);

export interface FrontDoorOptions {
    devices: EncDeviceStore;
    lanView?: () => BoatLanView;
    /** The peer address. Production: the socket's (never a header). Tests may supply their own. */
    peerOf?: (req: Request) => string | undefined;
}

export type ChartDeviceRequest = Request & {
    chartDevice?: ChartDevicePublic;
    chartPeer?: { address: string; seenAs: PeerSeenAs };
    chartToken?: ChartDeviceVerdict['state'];
};

/** The no-store headers alone: mounted at the app level too, ahead of the body parser's errors. */
export const encNoStore: RequestHandler = (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    next();
};

export function createEncFrontDoor(options: FrontDoorOptions): RequestHandler {
    const lanView = options.lanView ?? readBoatLanView;
    const peerOf = options.peerOf ?? ((req: Request) => req.socket.remoteAddress);
    return async (req: Request, res: Response, next: NextFunction) => {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Pragma', 'no-cache');
        try {
            const address = peerOf(req) ?? '';
            const peer = classifyPeer(address, lanView());
            const r = req as ChartDeviceRequest;
            r.chartPeer = { address, seenAs: peer.seenAs };
            if (!peer.boatLan) {
                return res.status(403).json({
                    code: 'charts-boat-wifi-only',
                    error: 'Charts come over the boat’s own Wi-Fi.',
                    seenAs: peer.seenAs,
                });
            }
            const header = req.headers[CHART_DEVICE_HEADER];
            const verdict = await options.devices.verify(Array.isArray(header) ? header[0] : header);
            r.chartToken = verdict.state;
            if (verdict.state === 'enrolled') r.chartDevice = verdict.device;
            if (verdict.state !== 'enrolled' && !UNTOKENED_ENC_ROUTES.has(`${req.method} ${req.path}`)) {
                return verdict.state === 'removed'
                    ? res.status(401).json({
                          code: 'chart-device-removed',
                          error: 'This device was removed from the boat’s charts.',
                      })
                    : res.status(401).json({
                          code: 'chart-device-not-enrolled',
                          error: 'This device is not set up for the boat’s charts.',
                      });
            }
            return next();
        } catch (error) {
            const status = error instanceof ChartDeviceError ? error.status : 500;
            return res.status(status).json({
                code: error instanceof ChartDeviceError ? error.code : 'chart-front-door-error',
                error: 'The Pi could not check this device.',
            });
        }
    };
}
