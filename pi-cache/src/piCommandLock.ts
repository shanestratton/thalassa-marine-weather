/**
 * Only her own devices can command the Pi (129-12).
 *
 * ONE TABLE. PI_ROUTES names every route the Pi serves, with its class:
 *   read     open to anyone on her network, in every mode: whatever only
 *            reads. The watch state is a read, so a phone that is not set up
 *            always sees it.
 *   raise    open to anyone, in every mode: whatever only makes her safer or
 *            louder. Arming the night watch for this caller, acknowledging an
 *            alarm, starting an anchor watch while none runs, or renewing the
 *            one running, unchanged, and saying the internet policy again as
 *            the Pi last took it (it shuts at every restart). From a device
 *            not set up while the Pi enforces, a raise only adds: an arm never
 *            weakens the watch or names our own boat, and an acknowledgement
 *            stays on that phone (only her own devices silence everyone's).
 *   command  anything that lowers protection or changes what others see:
 *            standing a watch down (for anyone, or everyone), stopping, moving
 *            or re-centring an anchor watch, configure, remote access, purge,
 *            installs, diary posts (published as the skipper), settings.
 * Two kinds of row have a door of their own, stricter than this one in every
 * mode: every /api/enc route (the chart front door, encDevices.ts: the boat's
 * own Wi-Fi, and an enrolled device on all but enrol and status), and the
 * switch itself (POST /api/pi-lock: her own Wi-Fi and an enrolled device, both
 * ways). A route missing from the table is a command; piCommandLock.test.mts
 * lists every route server.ts and its routers register and fails on one with
 * no row. A scope column (owner, crew, guest: tiers T-07/T-11) is one more
 * field on a row; in 129 an enrolled device can do everything.
 *
 * TWO MODES, kept in CACHE_DIR/pi-lock.json (0600) and read fresh, so the
 * recovery from a shell applies at once:
 *   observe  (the default after install) answers everyone, as before, and
 *            counts each command from a device not set up, by route, for the
 *            status read (GET /api/pi-lock). Logged by route and time only.
 *   enforce  refuses those: 403, with a code and plain words naming the boat,
 *            so an older app shows a sentence. With no device enrolled at all
 *            it answers everyone (nobody could command her otherwise) but a
 *            device she removed, and the switch will not turn on then.
 * Turning it off needs an enrolled device too. The recovery is on the Pi:
 *   node dist/vault/enrolCode.js --recover   (observe, and a fresh 30-minute code)
 *
 * THE TOKEN is the chart device's (X-Thalassa-Chart-Device, the app's one
 * header, on every Pi call since 129-12), checked by EncDeviceStore.verify
 * (SHA-256, timingSafeEqual). It is never logged, never in a URL, never in a
 * read. A removed device is refused at once: the store reads its file fresh.
 *
 * MATCHING is on a normalised path: decoded once, lower-cased (Express routes
 * without regard to case), doubled and trailing slashes dropped. A broken
 * escape, a backslash, a control character or a dot segment matches nothing,
 * so it is a command. HEAD is GET; OPTIONS is answered by cors before any
 * route. No method-override header is honoured anywhere on the Pi.
 *
 * A REFUSED COMMAND CHANGES NOTHING. The lock answers before the route runs,
 * so every watch keeps running exactly as it was, and still alarms.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import {
    CHART_DEVICE_HEADER,
    INSTALL_CODE_TTL_MS,
    classifyPeer,
    readBoatLanView,
    type BoatLanView,
    type ChartDeviceVerdict,
    type EncDeviceStore,
} from './encDevices.js';

/** What GET /api/pi-lock says it is, so the app shows its row only on a Pi that has it. */
export const PI_LOCK_CAPABILITY = 'pi-command-lock';
/** A log line per route at most this often (each call is still counted). */
const LOG_EVERY_MS = 60_000;
/** The ledger's one row for a call that matched no route. */
const UNMATCHED = 'a route not in the table';

export type PiRouteClass = 'read' | 'raise' | 'command';
export type PiLockMode = 'observe' | 'enforce';

export interface AnchorWatchFact {
    sessionCode: string;
    anchorLat: number;
    anchorLon: number;
    swingRadius: number;
}

/** What a class decided by the request needs to know about the Pi now. */
export interface PiRouteFacts {
    /** The anchor watch this Pi keeps now, or null. */
    anchorWatch: () => AnchorWatchFact | null;
    /** The internet policy the Pi last took as a command (PiInternetMemory), or null: none yet. */
    internetPolicy?: () => boolean | null;
}

export interface PiRouteRule {
    method: 'GET' | 'POST' | 'DELETE';
    /** As Express writes it: `:name` is one segment. `/*` is the hosted web app: any path outside /api and /cache. */
    path: string;
    class: PiRouteClass | ((body: unknown, facts: PiRouteFacts) => PiRouteClass);
    /** Who checks it instead of the lock, stricter in every mode: the chart front door, or the switch's own handler. */
    door?: 'chart' | 'lock';
}

/** A request body as an object; the native bridge has been known to send JSON as a string. */
function bodyObject(value: unknown): Record<string, unknown> | null {
    if (typeof value === 'string') {
        try {
            value = JSON.parse(value);
        } catch {
            return null;
        }
    }
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** POST /api/ais-watch: arming for this caller is a raise; any stand-down is a command. */
const aisWatchClass = (body: unknown): PiRouteClass => (bodyObject(body)?.armed === true ? 'raise' : 'command');

/** POST /api/anchor/watch: a raise while none runs, or for the one running, unchanged (the app's hourly renewal). */
function anchorWatchClass(body: unknown, facts: PiRouteFacts): PiRouteClass {
    const running = facts.anchorWatch();
    if (!running) return 'raise';
    const b = bodyObject(body) ?? {};
    const unchanged =
        typeof b.sessionCode === 'string' &&
        b.sessionCode.trim() === running.sessionCode &&
        Number(b.anchorLat) === running.anchorLat &&
        Number(b.anchorLon) === running.anchorLon &&
        Number(b.swingRadius) === running.swingRadius;
    return unchanged ? 'raise' : 'command';
}

/**
 * POST /api/configure is a command, with one exception, a raise: the app's
 * internet policy alone (the push every phone makes when it reaches her),
 * saying again exactly what the Pi last took as a command. The Pi shuts that
 * gate on every restart until a phone says it again; without this, after a
 * restart only her own devices could open it, and until one came aboard the
 * night watch could not wake the skipper ashore. Any other value or field,
 * or nothing kept yet, is a command.
 */
function configureClass(body: unknown, facts: PiRouteFacts): PiRouteClass {
    const b = bodyObject(body);
    const kept = facts.internetPolicy?.() ?? null;
    if (!b || kept === null || b.diaryRelayAllowInternet !== kept) return 'command';
    const onlyThePolicy = Object.entries(b).every(
        ([key, value]) =>
            key === 'diaryRelayAllowInternet' || ((key === 'supabaseUrl' || key === 'supabaseAnonKey') && value === ''),
    );
    return onlyThePolicy ? 'raise' : 'command';
}

type Row = [`${PiRouteRule['method']} ${string}`, PiRouteRule['class'], PiRouteRule['door']?];

/* Every route the Pi serves. Keep the order of server.ts (and of each router). */
const ROWS: Row[] = [
    ['GET /health', 'read'],
    ['GET /status', 'read'],
    ['GET /api/update5/status', 'read'],
    ['GET /api/offline-weather/capabilities', 'read'],
    ['GET /api/offline-weather/satellite', 'read'],
    ['GET /api/offline-weather/analysis/:id', 'read'],
    ['GET /api/offline-weather/bulletins', 'read'],
    ['GET /api/admin/status', 'read'],
    ['POST /api/configure', configureClass],
    ['POST /cache/purge', 'command'],
    ['GET /api/passthrough', 'read'],
    ['GET /api/passthrough-tile', 'read'],
    ['GET /api/barometer', 'read'],
    ['GET /api/underway-watch', 'read'],
    ['POST /api/underway-watch', 'command'],
    ['POST /api/underway-watch/ack', 'command'],
    ['GET /api/polars/snapshot', 'read', 'chart'],
    ['POST /api/polars/config', 'command', 'chart'],
    ['GET /api/anchor/capability', 'read'],
    ['GET /api/gps', 'read'],
    ['GET /api/telemetry', 'read'],
    // The night watch (routes/aisWatch.ts).
    ['GET /api/ais-watch', 'read'],
    ['POST /api/ais-watch', aisWatchClass],
    ['POST /api/ais-watch/ack', 'raise'],
    // A test push to the skipper's phone: a diagnostic, and a stranger's would be alarm fatigue.
    ['POST /api/ais-watch/test', 'command'],
    ['POST /api/anchor/watch', anchorWatchClass],
    ['DELETE /api/anchor/watch', 'command'],
    ['GET /api/weather/current', 'read'],
    ['GET /api/weather/forecast', 'read'],
    ['GET /api/weather/marine', 'read'],
    ['GET /api/weather/combined', 'read'],
    ['GET /api/weather/unified', 'read'],
    ['GET /api/weather/stormglass', 'read'],
    ['GET /api/tiles/gibs/:layer/:z/:x/:y', 'read'],
    ['GET /api/tiles/realearth/:product/:z/:x/:y', 'read'],
    ['GET /api/tiles/nowcoast/:layer/:z/:x/:y', 'read'],
    ['GET /api/tiles/openseamap/:z/:x/:y', 'read'],
    ['GET /api/tiles/gebco/:z/:x/:y', 'read'],
    ['GET /api/tiles/rainviewer/:z/:x/:y', 'read'],
    ['GET /api/grib/wind', 'read'],
    ['GET /api/grib/pressure', 'read'],
    ['GET /api/grib/waves', 'read'],
    ['GET /api/grib/precip', 'read'],
    ['GET /api/grib/composite', 'read'],
    // A wind grid for the map: a POST for its body, and the Pi keeps nothing but a cache of it.
    ['POST /api/grib/wind-grid', 'read'],
    ['GET /api/grib/noaa', 'read'],
    ['GET /api/tides/predictions', 'read'],
    ['GET /api/misc/cyclone-feed', 'read'],
    ['GET /api/misc/cyclones/:id', 'read'],
    ['GET /api/misc/seamarks', 'read'],
    ['GET /api/misc/geocode', 'read'],
    ['GET /api/misc/precipitation', 'read'],
    // Behind the unsafe-admin opt-in as well (server.ts).
    ['GET /api/misc/proxy/:functionName', 'read'],
    ['GET /api/remote-access', 'read'],
    ['POST /api/remote-access/enable', 'command'],
    ['POST /api/remote-access/disable', 'command'],
    // The switch: its own door (createPiLockRoutes), an enrolled device on her own Wi-Fi, both ways.
    ['GET /api/pi-lock', 'read'],
    ['POST /api/pi-lock', 'command', 'lock'],
    // The chart front door holds every /api/enc route (encDevices.ts), in every mode.
    ['GET /api/enc/devices/status', 'read', 'chart'],
    ['POST /api/enc/devices/enrol', 'command', 'chart'],
    ['GET /api/enc/devices', 'read', 'chart'],
    ['POST /api/enc/devices/code', 'command', 'chart'],
    ['DELETE /api/enc/devices/:id', 'command', 'chart'],
    ['POST /api/enc/convert', 'command', 'chart'],
    ['GET /api/enc/jobs', 'read', 'chart'],
    ['GET /api/enc/jobs/:id', 'read', 'chart'],
    ['GET /api/enc/result/:id', 'read', 'chart'],
    ['DELETE /api/enc/jobs/:id', 'command', 'chart'],
    ['POST /api/enc/install-from-url', 'command', 'chart'],
    ['GET /api/enc/ocharts/setup', 'read', 'chart'],
    ['GET /api/enc/installed', 'read', 'chart'],
    ['GET /api/enc/installed/:cellId/data', 'read', 'chart'],
    ['DELETE /api/enc/installed/:cellId', 'command', 'chart'],
    ['POST /api/enc/route', 'read', 'chart'],
    ['POST /api/enc/route-prepped', 'read', 'chart'],
    ['POST /api/enc/install-public', 'command', 'chart'],
    ['GET /api/enc/health', 'read', 'chart'],
    ['GET /api/osm/overlay', 'read'],
    ['GET /api/pair/info', 'read'],
    // Signs a nonce, changes nothing: the app's identity check.
    ['POST /api/pair/challenge', 'read'],
    // Published as the skipper: a command.
    ['POST /api/diary/entries', 'command'],
    ['POST /api/diary/cancel', 'command'],
    ['POST /api/diary/video/begin', 'command'],
    ['POST /api/diary/video/chunk/:id/:index', 'command'],
    ['POST /api/diary/video/finish/:id', 'command'],
    ['GET /api/diary/video/status/:operationId', 'read'],
    ['GET /api/diary/status/:operationId', 'read'],
    ['GET /api/track/status', 'read'],
    ['POST /api/track/enable', 'command'],
    ['GET /api/track/points', 'read'],
    ['GET /api/seabed/status', 'read'],
    ['POST /api/seabed/config', 'command'],
    // Raster chart sets: the unsafe-admin opt-in only.
    ['POST /api/charts/download', 'command'],
    ['GET /api/charts/jobs/:id', 'read'],
    ['GET /api/charts/jobs', 'read'],
    ['GET /api/charts/local', 'read'],
    ['DELETE /api/charts/local/:name', 'command'],
    // The built web app and its files (the unsafe-admin opt-in): anything outside /api and /cache.
    ['GET /*', 'read'],
];

export const PI_ROUTES: readonly PiRouteRule[] = ROWS.map(([key, cls, door]) => {
    const [method, route] = key.split(' ') as [PiRouteRule['method'], string];
    return { method, path: route, class: cls, ...(door ? { door } : {}) };
});

const segmentsOf = (route: string) => route.split('/').filter((segment) => segment !== '');
const COMPILED = PI_ROUTES.map((rule) => ({
    rule,
    segments: rule.path === '/*' ? null : segmentsOf(rule.path.toLowerCase()),
}));

/** The path as the lock matches it, or null when it cannot be read safely (then it is a command). */
export function canonicalPiPath(raw: string): string | null {
    let decoded: string;
    try {
        decoded = decodeURIComponent(raw.split(/[?#]/, 1)[0]);
    } catch {
        return null;
    }
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f\\]/.test(decoded)) return null;
    const segments = segmentsOf(decoded.toLowerCase());
    if (segments.some((segment) => segment === '.' || segment === '..')) return null;
    return `/${segments.join('/')}`;
}

/** The table's row for this request, or null: no row is a command. */
export function findPiRoute(method: string, rawPath: string): PiRouteRule | null {
    const verb = method.toUpperCase() === 'HEAD' ? 'GET' : method.toUpperCase();
    const canonical = canonicalPiPath(rawPath);
    if (canonical === null) return null;
    const segments = segmentsOf(canonical);
    let site: PiRouteRule | null = null;
    for (const { rule, segments: want } of COMPILED) {
        if (rule.method !== verb) continue;
        if (want === null) {
            if (segments[0] !== 'api' && segments[0] !== 'cache') site = rule;
        } else if (want.length === segments.length && want.every((w, i) => w.startsWith(':') || w === segments[i])) {
            return rule;
        }
    }
    return site;
}

/** The body of a refusal: a machine code, and words an older app can show as they are. */
export function piCommandRefusal(state: ChartDeviceVerdict['state'], boatName: string) {
    const boat = boatName.trim() || 'the boat';
    return state === 'removed'
        ? {
              status: 'error',
              code: 'pi-device-removed',
              error: `This phone was removed from ${boat}'s Pi. Type a new code from her Pi.`,
          }
        : {
              status: 'error',
              code: 'pi-device-not-set-up',
              error: `This phone isn't set up for ${boat}'s Pi. Type the code from her Pi.`,
          };
}

// ── The switch, on disk ──────────────────────────────────────────────────────

export class PiLockStore {
    private cached: { ino: number; mtimeMs: number; size: number; mode: PiLockMode } | null = null;

    constructor(
        private readonly file: string,
        private readonly now: () => number = Date.now,
    ) {}

    /** observe when there is no file (the default after install); enforce when it cannot be read (it existed). */
    mode(): PiLockMode {
        let stat: fs.Stats;
        try {
            stat = fs.statSync(this.file);
        } catch (error) {
            return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'observe' : 'enforce';
        }
        const c = this.cached;
        if (c && c.ino === stat.ino && c.mtimeMs === stat.mtimeMs && c.size === stat.size) return c.mode;
        let mode: PiLockMode = 'enforce';
        try {
            const saved = bodyObject(fs.readFileSync(this.file, 'utf8'));
            if (saved?.mode === 'observe' || saved?.mode === 'enforce') mode = saved.mode;
        } catch {
            /* fail closed: the skipper may have turned it on */
        }
        this.cached = { ino: stat.ino, mtimeMs: stat.mtimeMs, size: stat.size, mode };
        return mode;
    }

    set(mode: PiLockMode): void {
        writeWhole(this.file, { version: 1, mode, changedAt: new Date(this.now()).toISOString() });
        this.cached = null;
    }
}

/** Written whole (0600) beside the file and renamed over it, so a reader never sees half of it. */
function writeWhole(file: string, value: unknown): void {
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
    const temporary = path.join(dir, `.${path.basename(file)}.${randomUUID()}.tmp`);
    try {
        fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
        fs.renameSync(temporary, file);
    } catch (error) {
        fs.rmSync(temporary, { force: true });
        throw error;
    }
}

/**
 * The internet policy (diaryRelayAllowInternet) the Pi last took as a command,
 * kept in CACHE_DIR/pi-internet.json (0600) across restarts. The gate itself
 * still shuts on every restart (diaryRelayOutbox.ts); this only lets any phone
 * aboard say that same policy again (configureClass), as every phone could
 * before the lock. Null: none kept yet, or unreadable.
 */
export class PiInternetMemory {
    constructor(private readonly file: string) {}

    read(): boolean | null {
        try {
            const kept = bodyObject(fs.readFileSync(this.file, 'utf8'))?.allowInternet;
            return typeof kept === 'boolean' ? kept : null;
        } catch {
            return null;
        }
    }

    remember(allowInternet: boolean): void {
        if (this.read() === allowInternet) return;
        writeWhole(this.file, { version: 1, allowInternet, changedAt: new Date().toISOString() });
    }
}

/** Calls from devices not set up, by route, since the Pi started: counts and the last time only. */
export class PiLockLedger {
    readonly since: number;
    private readonly seen = new Map<string, { calls: number; lastAt: number; loggedAt: number | null }>();

    constructor(now: () => number = Date.now) {
        this.since = now();
    }

    /** Count one; true when it is worth a log line (the first on its route, then once a minute). */
    note(route: string, at: number): boolean {
        const row = this.seen.get(route) ?? { calls: 0, lastAt: at, loggedAt: null };
        row.calls += 1;
        row.lastAt = at;
        const log = row.loggedAt === null || at - row.loggedAt >= LOG_EVERY_MS;
        if (log) row.loggedAt = at;
        this.seen.set(route, row);
        return log;
    }

    calls(route: string): number {
        return this.seen.get(route)?.calls ?? 0;
    }

    /** Most calls first. */
    list(): { route: string; calls: number; lastAt: string }[] {
        return [...this.seen]
            .sort((a, b) => b[1].calls - a[1].calls)
            .map(([route, row]) => ({ route, calls: row.calls, lastAt: new Date(row.lastAt).toISOString() }));
    }
}

// ── The middleware ───────────────────────────────────────────────────────────

export interface PiCommandVerdict {
    mode: PiLockMode;
    class: PiRouteClass;
    /**
     * False only for a raise from a device not set up while the Pi enforces:
     * the route then may only add to a watch (AisNightWatch.raiseArm, an
     * anchor renewal kept as it runs, an acknowledgement kept to that phone),
     * never take from one.
     */
    commanded: boolean;
}

export type PiCommandRequest = Request & { piCommand?: PiCommandVerdict };

const tokenOf = (req: Request) => {
    const header = req.headers[CHART_DEVICE_HEADER];
    return Array.isArray(header) ? header[0] : header;
};

export interface PiLockOptions {
    devices: EncDeviceStore;
    store: PiLockStore;
    ledger: PiLockLedger;
    boatName: () => string;
    facts: PiRouteFacts;
    now?: () => number;
    log?: (line: string) => void;
}

/** In front of every route (server.ts mounts it after the body parser, before the first route). */
export function createPiCommandLock(options: PiLockOptions): RequestHandler {
    const now = options.now ?? Date.now;
    const log = options.log ?? ((line: string) => console.log(line));
    return async (req: Request, res: Response, next: NextFunction) => {
        const r = req as PiCommandRequest;
        if (req.method.toUpperCase() === 'OPTIONS') return next();
        const rule = findPiRoute(req.method, req.originalUrl || req.url);
        if (rule?.door) return next();
        const cls = !rule
            ? 'command'
            : typeof rule.class === 'function'
              ? rule.class(req.body, options.facts)
              : rule.class;
        if (cls === 'read') return next();
        let mode: PiLockMode;
        try {
            mode = options.store.mode();
        } catch {
            mode = 'enforce';
        }
        if (mode === 'observe' && cls === 'raise') {
            r.piCommand = { mode, class: cls, commanded: true };
            return next();
        }
        let verdict: ChartDeviceVerdict['state'] | 'unchecked';
        try {
            verdict = (await options.devices.verify(tokenOf(req))).state;
        } catch {
            verdict = 'unchecked';
        }
        if (verdict === 'enrolled') {
            r.piCommand = { mode, class: cls, commanded: true };
            return next();
        }
        // A device not set up for her Pi. With nobody set up, nobody could
        // command her: she answers everyone until someone is. Never a device
        // she removed, though, nor one she could not check: only a fresh code
        // from her Pi lets a removed phone back in.
        let enforcing = mode === 'enforce';
        if (enforcing && verdict === 'unknown') {
            try {
                enforcing = (await options.devices.list()).length > 0;
            } catch {
                enforcing = true;
            }
        }
        if (cls === 'raise') {
            r.piCommand = { mode, class: cls, commanded: !enforcing };
            return next();
        }
        const route = rule ? `${rule.method} ${rule.path}` : UNMATCHED;
        const worthALine = options.ledger.note(route, now());
        const calls = options.ledger.calls(route);
        if (!enforcing) {
            if (worthALine) log(`[pi-lock] observe: ${route} from a device not set up (${calls} since start)`);
            r.piCommand = { mode, class: cls, commanded: true };
            return next();
        }
        if (worthALine) log(`[pi-lock] refused ${route} from a device not set up (${calls} since start)`);
        res.setHeader('Cache-Control', 'no-store');
        if (verdict === 'unchecked') {
            return res.status(503).json({
                status: 'error',
                code: 'pi-device-check-failed',
                error: `${options.boatName().trim() || 'The boat'}'s Pi couldn't check this phone. Try again in a minute.`,
            });
        }
        return res.status(403).json(piCommandRefusal(verdict, options.boatName()));
    };
}

// ── The status read and the switch (GET / POST /api/pi-lock) ─────────────────

export interface PiLockRouteOptions {
    devices: EncDeviceStore;
    store: PiLockStore;
    ledger: PiLockLedger;
    boatName: () => string;
    lanView?: () => BoatLanView;
    /** The peer address. Production: the socket's (never a header). Tests may supply their own. */
    peerOf?: (req: Request) => string | undefined;
    log?: (line: string) => void;
}

export function createPiLockRoutes(options: PiLockRouteOptions): Router {
    const router = Router();
    const lanView = options.lanView ?? readBoatLanView;
    const peerOf = options.peerOf ?? ((req: Request) => req.socket.remoteAddress);
    const log = options.log ?? ((line: string) => console.log(line));
    const boat = () => options.boatName().trim() || 'the boat';

    router.use((_req: Request, res: Response, next: NextFunction) => {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Pragma', 'no-cache');
        next();
    });

    /** Never a token, an address or a device list: counts, the mode, and whether this device is set up. */
    const status = async (req: Request) => {
        const [devices, verdict] = await Promise.all([options.devices.list(), options.devices.verify(tokenOf(req))]);
        const mode = options.store.mode();
        return {
            v: 1,
            capability: PI_LOCK_CAPABILITY,
            mode,
            enforcing: mode === 'enforce' && devices.length > 0,
            devices: devices.length,
            thisDevice:
                verdict.state === 'enrolled' ? 'set-up' : verdict.state === 'removed' ? 'removed' : 'not-set-up',
            unenrolled: options.ledger.list(),
            since: new Date(options.ledger.since).toISOString(),
        };
    };

    router.get('/', async (req: Request, res: Response) => {
        try {
            return res.json(await status(req));
        } catch {
            return res
                .status(500)
                .json({ status: 'error', code: 'pi-lock-unreadable', error: 'The Pi could not read who is set up.' });
        }
    });

    router.post('/', async (req: Request, res: Response) => {
        try {
            if (!classifyPeer(peerOf(req) ?? '', lanView()).boatLan) {
                return res.status(403).json({
                    status: 'error',
                    code: 'pi-lock-boat-wifi-only',
                    error: `Change this on ${boat()}'s own Wi-Fi.`,
                });
            }
            const mode = bodyObject(req.body)?.mode;
            if (mode !== 'observe' && mode !== 'enforce') {
                return res
                    .status(400)
                    .json({ status: 'error', code: 'pi-lock-mode', error: 'mode must be observe or enforce' });
            }
            if (mode === 'enforce' && (await options.devices.list()).length === 0) {
                return res.status(409).json({
                    status: 'error',
                    code: 'pi-lock-no-devices',
                    error: `Set up a phone or tablet for ${boat()}'s Pi first. With none set up, nobody could change her Pi.`,
                });
            }
            const verdict = await options.devices.verify(tokenOf(req));
            if (verdict.state !== 'enrolled')
                return res.status(403).json(piCommandRefusal(verdict.state, options.boatName()));
            options.store.set(mode);
            log(
                mode === 'enforce'
                    ? `[pi-lock] ON: only her own devices can command the Pi (turned on from ${verdict.device.label})`
                    : `[pi-lock] off: the Pi answers every device again (turned off from ${verdict.device.label})`,
            );
            return res.json(await status(req));
        } catch {
            return res
                .status(500)
                .json({ status: 'error', code: 'pi-lock-write-failed', error: `${boat()}'s Pi couldn't change that.` });
        }
    });

    return router;
}

/**
 * server.ts's anchor POST, for a device not set up while the Pi enforces: the
 * lock let it through only to start a watch or renew the running one
 * unchanged, and a renewal leaves the watch running as it is (drag count and
 * all) rather than starting it again.
 */
export function uncommandedRenewal(req: Request, running: boolean): boolean {
    return running && (req as PiCommandRequest).piCommand?.commanded === false;
}

/**
 * enrolCode.js run as anyone but the owner of CACHE_DIR (plain `sudo` is root)
 * would leave files the service cannot read: the lock would then fail closed
 * and the chart door break, while the shell said all was well. The words to
 * say instead, or null: the right user, or no CACHE_DIR to own yet.
 */
export function wrongShellUser(cacheDir: string, uid: number | undefined): string | null {
    if (uid === undefined) return null;
    let owner: number;
    try {
        owner = fs.statSync(cacheDir).uid;
    } catch {
        return null;
    }
    if (owner === uid) return null;
    return (
        `Nothing changed. Run this as the Pi service's own user, who owns ${cacheDir} (uid ${owner}), ` +
        `not ${uid === 0 ? 'root' : `uid ${uid}`}: sudo -u "$(stat -c %U ${cacheDir})" node dist/vault/enrolCode.js …`
    );
}

/** The recovery from a shell (enrolCode.js --recover): observe again, and a fresh 30-minute code. */
export async function recoverPiLock(options: {
    store: PiLockStore;
    devices: EncDeviceStore;
}): Promise<{ code: string; expiresAt: string }> {
    options.store.set('observe');
    return options.devices.mintCode({ ttlMs: INSTALL_CODE_TTL_MS });
}
