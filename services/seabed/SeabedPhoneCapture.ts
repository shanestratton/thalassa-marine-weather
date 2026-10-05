/**
 * Seabed mapping on the phone, for a boat with no Pi.
 *
 * Loaded lazily, and only when this account switched it on. It logs only on
 * the ONE phone the owner chose, never with a Pi paired (the Pi is the boat's
 * logger), never in the web build, and only from the boat's own instruments:
 * a direct gateway socket and a position from the bus's own RMC/GGA. No bus
 * position, no row (counted). The phone's own GPS is never used.
 *
 * NmeaStore aggregates over 5 s, too coarse for ~1 Hz soundings, so this taps
 * the raw sentence stream through seabedSink (one null check per sentence
 * when off). It reads only RMC, GGA, HDT, DBT and DPT, and the depth it keeps
 * is the RAW reading below the transducer (DBT, or DPT's first field without
 * its offset). Time is the sentence's receipt time on the device clock.
 *
 * THE BRIDGE. iOS runs every plugin call on one serial queue (memory: the
 * 7.2 s cache read), so nothing here touches Capacitor per sounding: the open
 * batch lives in memory and is appended to a file every 5 minutes or 300
 * rows; a closed batch is one write an hour.
 *
 * ONE BOAT. A capture is armed FOR a boat (the owner's active boat, which the
 * gate checks) and every batch it closes carries that boat, even if the
 * setting moves to another boat or account before the file is written.
 *
 * THE END OF A TRIP. An hour closed mid-trip is held on the phone (h-*.json,
 * plain CSV) and queued only when the trip ends, trimmed of every row within
 * 500 m of where she stopped. After an app kill, recover() ends the trip at
 * the last row it kept.
 */
import { Capacitor } from '@capacitor/core';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { createLogger } from '../../utils/createLogger';
import { getAuthIdentityScope, isAuthIdentityScopeCurrent, subscribeAuthIdentityScope } from '../authIdentityScope';
import { NmeaListenerService } from '../NmeaListenerService';
import { parseNmeaDepth, parseNmeaNumber } from '../nmea/nmeaSentence';
import { getPairing } from '../PiPairingService';
import {
    SEABED_CONSENT_VERSION,
    SEABED_CORE_VERSION,
    SEABED_CSV_HEADER,
    SEABED_RAW_SCHEMA,
    SeabedCapture,
    cleanCaptureMeta,
    cleanCounters,
    decodeSeabedCsv,
    encodeSeabedRow,
    recoverTrip,
    trimTripEnd,
    type SeabedClosedBatch,
    type SeabedCounters,
    type SeabedFix,
    type SeabedRow,
    type SeabedStep,
    type SeabedZone,
} from './seabedCore';
import { readSeabedLocal, seabedDeviceId, subscribeSeabed, type SeabedLocal } from './SeabedSettingsService';
import { seabedDir, seabedLocallyEnabled, setSeabedPurgeHook, setSeabedSink } from './seabedSink';

const log = createLogger('Seabed');

export const PHONE_QUEUE_CAP_BYTES = 64 * 1024 * 1024;
const SEGMENT_ROWS = 300;
const SEGMENT_MS = 5 * 60_000;
const TICK_MS = 10_000;
/** A bus position older than this is no position for a sounding. */
const FIX_MAX_AGE_MS = 10_000;
/** How often the running capture re-reads the owner's fleet (which boat is active, and still theirs). */
const FLEET_REFRESH_MS = 10 * 60_000;

/** The open batch of one boat: rows a kill would otherwise lose. */
const openFile = (boatId: string) => `open-${boatId.replace(/[^A-Za-z0-9-]/g, '')}.csv`;
const isOpenFile = (name: string) => /^open-[A-Za-z0-9-]+\.csv$/.test(name);

// ── Who may log ───────────────────────────────────────────────────────────

export interface SeabedGateInput {
    local: SeabedLocal | null;
    deviceId: string;
    /** The owner's active boat from their fleet: null = no boat of theirs; undefined = not known yet. */
    activeBoatId: string | null | undefined;
    piPaired: boolean;
    native: boolean;
    signedIn: boolean;
    full: boolean;
}

export type SeabedGateReason =
    | 'off'
    | 'consent'
    | 'pi'
    | 'other-device'
    | 'web'
    | 'signed-out'
    | 'full'
    | 'not-owner'
    | 'other-boat'
    | 'boat-unknown';

export function seabedPhoneGate(i: SeabedGateInput): { armed: boolean; reason: SeabedGateReason | null } {
    const no = (reason: SeabedGateReason) => ({ armed: false, reason });
    if (!i.local || !i.local.enabled) return no('off');
    if (i.local.consentVersion !== SEABED_CONSENT_VERSION) return no('consent');
    if (!i.signedIn) return no('signed-out');
    if (i.piPaired || i.local.captureDeviceId === null) return no('pi');
    if (i.local.captureDeviceId !== i.deviceId) return no('other-device');
    if (!i.native) return no('web');
    // The setting's boat must be the owner's ACTIVE boat, and still theirs.
    if (i.activeBoatId === undefined) return no('boat-unknown');
    if (i.activeBoatId === null) return no('not-owner');
    if (i.local.boatId !== i.activeBoatId) return no('other-boat');
    if (i.full) return no('full');
    return { armed: true, reason: null };
}

// ── Files ─────────────────────────────────────────────────────────────────

export interface SeabedFiles {
    append(name: string, text: string): Promise<void>;
    write(name: string, text: string): Promise<void>;
    read(name: string): Promise<string | null>;
    remove(name: string): Promise<void>;
    list(): Promise<{ name: string; size: number; mtime: number }[]>;
}

/** Directory.Data/seabed/<account>/: per account, so a queue never uploads under someone else's login. */
export function capacitorSeabedFiles(userId: string): SeabedFiles {
    const dir = seabedDir(userId);
    const at = (name: string) => ({ path: `${dir}/${name}`, directory: Directory.Data });
    return {
        append: async (name, data) => {
            await Filesystem.appendFile({ ...at(name), data, encoding: Encoding.UTF8 });
        },
        write: async (name, data) => {
            await Filesystem.writeFile({ ...at(name), data, encoding: Encoding.UTF8, recursive: true });
        },
        read: async (name) => {
            try {
                const res = await Filesystem.readFile({ ...at(name), encoding: Encoding.UTF8 });
                return typeof res.data === 'string' ? res.data : null;
            } catch {
                return null;
            }
        },
        remove: async (name) => {
            await Filesystem.deleteFile(at(name)).catch(() => undefined);
        },
        list: async () => {
            try {
                const res = await Filesystem.readdir({ path: dir, directory: Directory.Data });
                return res.files.map((f) => ({ name: f.name, size: f.size, mtime: f.mtime }));
            } catch {
                return [];
            }
        },
    };
}

export async function gzipText(text: string): Promise<{ bytes: Uint8Array; encoding: 'gzip' | 'identity' }> {
    const raw = new TextEncoder().encode(text);
    try {
        if (typeof CompressionStream === 'undefined') throw new Error('no CompressionStream');
        const stream = new Blob([raw]).stream().pipeThrough(new CompressionStream('gzip'));
        return { bytes: new Uint8Array(await new Response(stream).arrayBuffer()), encoding: 'gzip' };
    } catch {
        // The ingest function accepts the plain CSV too, and gzips it itself.
        return { bytes: raw, encoding: 'identity' };
    }
}

function base64(bytes: Uint8Array): string {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** DDMM.MMMM + hemisphere to decimal degrees; null for anything malformed. */
function nmeaDegrees(value: string | undefined, hemisphere: string | undefined, maxAbs: number): number | null {
    const negative = maxAbs === 90 ? 'S' : 'W';
    const positive = maxAbs === 90 ? 'N' : 'E';
    if (hemisphere !== negative && hemisphere !== positive) return null;
    const v = parseNmeaNumber(value);
    if (v === null) return null;
    const deg = Math.floor(v / 100);
    const min = v - deg * 100;
    if (min < 0 || min >= 60) return null;
    const out = (hemisphere === negative ? -1 : 1) * (deg + min / 60);
    return Math.abs(out) <= maxAbs ? out : null;
}

/**
 * q-<t_start ms>-<sha8>-<rows>-<track m>.json, ready to send; h-... the same
 * shape for an hour held until its trip ends. Either way the queue can be
 * summed from a directory listing alone.
 */
export function queueFileName(startMs: number, sha256: string, rows: number, trackM: number, prefix = 'q'): string {
    return `${prefix}-${startMs}-${sha256.slice(0, 8)}-${rows}-${Math.round(trackM)}.json`;
}

export function parseQueueFileName(name: string): { rows: number; trackM: number } | null {
    const m = /^[qh]-\d+-[0-9a-f]{8}-(\d+)-(\d+)\.json$/.exec(name);
    return m ? { rows: Number(m[1]), trackM: Number(m[2]) } : null;
}

/** Everything that counts against the cap: queued and held hours, and the open rows. */
const holdsSoundings = (name: string) => name.startsWith('q-') || name.startsWith('h-') || isOpenFile(name);

interface HeldHour {
    boatId: string;
    rows: SeabedRow[];
    counters: SeabedCounters;
}

function readHeldHour(text: string | null): HeldHour | null {
    try {
        const body = JSON.parse(text ?? '') as { boat_id?: unknown; csv?: unknown; counters?: unknown };
        if (typeof body.boat_id !== 'string' || typeof body.csv !== 'string') return null;
        const decoded = decodeSeabedCsv(body.csv, Infinity);
        return decoded.ok ? { boatId: body.boat_id, rows: decoded.rows, counters: cleanCounters(body.counters) } : null;
    } catch {
        return null;
    }
}

// ── The capture ───────────────────────────────────────────────────────────

export interface PhoneCaptureDeps {
    files: SeabedFiles;
    now: () => number;
    /** The direct gateway socket, not the LAN or cloud lanes. */
    connected: () => boolean;
    gzip: (text: string) => Promise<{ bytes: Uint8Array; encoding: 'gzip' | 'identity' }>;
    /** Vessel and sounder metadata for each batch. */
    meta: () => Record<string, unknown>;
}

export class SeabedPhoneCapture {
    private capture = new SeabedCapture();
    private armed = false;
    /** The boat this capture logs for, from arm() on. */
    private boatId: string | null = null;
    private fix: SeabedFix | null = null;
    private fixAt = 0;
    private sogKn: number | null = null;
    private cogDeg: number | null = null;
    private hdgDeg: number | null = null;
    private fixQ: number | null = null;
    private hdop: number | null = null;
    private sats: number | null = null;
    private offsets: { toKeel?: number; toSurface?: number } = {};
    private pending: SeabedRow[] = [];
    private lastSegmentAt = 0;
    private chain: Promise<void> = Promise.resolve();
    private appended = 0;
    private lastDepth: number | null = null;
    full = false;

    constructor(private readonly deps: PhoneCaptureDeps) {}

    setZones(zones: readonly SeabedZone[]): void {
        this.capture.setZones(zones);
    }

    /** Log for this boat. Armed for another one, the trip so far ends first, as that boat's. */
    arm(boatId: string): void {
        if (this.armed && this.boatId !== null && this.boatId !== boatId) void this.finish();
        this.boatId = boatId;
        this.armed = true;
    }

    get armedFor(): string | null {
        return this.armed ? this.boatId : null;
    }

    stats() {
        return {
            armed: this.armed,
            underway: this.capture.underway,
            counters: { ...this.capture.counters },
            appended: this.appended,
            lastDepth: this.lastDepth,
            full: this.full,
        };
    }

    /** Wait for queued file work (tests, and before an upload). */
    idle(): Promise<void> {
        return this.chain;
    }

    private enqueue(work: () => Promise<void>): void {
        this.chain = this.chain.then(work).catch((err) => {
            log.warn(`seabed file write failed: ${err instanceof Error ? err.message : String(err)}`);
        });
    }

    /** The sink. Called for every instrument sentence while installed: cheap unless it is one of five types. */
    onSentence(type: string, parts: string[], at: number): void {
        if (!this.armed || !this.deps.connected()) return;
        switch (type) {
            case 'RMC': {
                const ok = parts[2] === 'A';
                const lat = ok ? nmeaDegrees(parts[3], parts[4], 90) : null;
                const lon = ok ? nmeaDegrees(parts[5], parts[6], 180) : null;
                if (lat !== null && lon !== null) {
                    this.fix = { lat, lon };
                    this.fixAt = at;
                    // Raw from the bus: the shared core empties anything the CSV could not carry.
                    this.sogKn = parseNmeaNumber(parts[7]);
                    this.cogDeg = parseNmeaNumber(parts[8]);
                }
                this.handle(this.capture.observe(at, ok ? this.sogKn : null, lat !== null ? this.fix : null));
                return;
            }
            case 'GGA': {
                const q = parseNmeaNumber(parts[6]);
                if (q === null || !Number.isInteger(q) || q < 0 || q > 8) return;
                this.fixQ = q;
                this.sats = parseNmeaNumber(parts[7]);
                this.hdop = parseNmeaNumber(parts[8]);
                const lat = q > 0 ? nmeaDegrees(parts[2], parts[3], 90) : null;
                const lon = q > 0 ? nmeaDegrees(parts[4], parts[5], 180) : null;
                if (lat !== null && lon !== null) {
                    this.fix = { lat, lon };
                    this.fixAt = at;
                }
                return;
            }
            case 'HDT':
                this.hdgDeg = parseNmeaNumber(parts[1]);
                return;
            case 'DBT':
            case 'DPT':
                this.onDepth(type, parts, at);
                return;
        }
    }

    private onDepth(type: 'DBT' | 'DPT', parts: string[], at: number): void {
        const reading = parseNmeaDepth(parts.join(','), type);
        if (!reading) return;
        if (reading.offsetM !== null && reading.offsetM < 0) this.offsets.toKeel = -reading.offsetM;
        if (reading.offsetM !== null && reading.offsetM > 0) this.offsets.toSurface = reading.offsetM;
        this.lastDepth = reading.rawDepthM;
        if (!this.capture.underway || this.full) return;
        if (!this.fix || at - this.fixAt > FIX_MAX_AGE_MS) {
            this.capture.counters.no_bus_fix += 1;
            return;
        }
        this.handle(
            this.capture.offer({
                lon: this.fix.lon,
                lat: this.fix.lat,
                depth: reading.rawDepthM,
                timeMs: at,
                sogKn: this.sogKn,
                cogDeg: this.cogDeg,
                hdgDeg: this.hdgDeg,
                heelDeg: null,
                fixQ: this.fixQ,
                hdop: this.hdop,
                sats: this.sats,
                posAgeMs: at - this.fixAt,
                depthRef: 'T',
                flags: 0,
            }),
        );
    }

    /** Every 10 s: a quiet bus still ends the trip (30 s without a fix), and the segment flushes on time. */
    tick(): void {
        if (!this.armed) return;
        const now = this.deps.now();
        if (now - this.fixAt > FIX_MAX_AGE_MS) this.handle(this.capture.observe(now, null, null));
        if (this.pending.length && now - this.lastSegmentAt >= SEGMENT_MS) this.flushSegment();
    }

    /** Switched off, Pi paired, another device chosen: the trip ends here. */
    finish(): Promise<void> {
        this.handle(this.capture.finish());
        this.armed = false;
        return this.chain;
    }

    disarm(): void {
        this.armed = false;
    }

    private handle(step: SeabedStep): void {
        if (step.appended.length) {
            this.appended += step.appended.length;
            this.pending.push(...step.appended);
        }
        const boatId = this.boatId;
        if (!boatId) return;
        if (step.closed.length || step.tripEnd) {
            const closed = step.closed;
            const end = step.tripEnd;
            const open = this.capture.openRows();
            this.pending = [];
            this.lastSegmentAt = this.deps.now();
            this.enqueue(async () => {
                for (const batch of closed) {
                    if (batch.parked) await this.holdHour(batch, boatId);
                    else await this.queueBatch(batch, false, boatId);
                }
                if (end) await this.releaseHeld(end.at);
                await this.deps.files.remove(openFile(boatId));
                if (open.length)
                    await this.deps.files.append(openFile(boatId), open.map(encodeSeabedRow).join('\n') + '\n');
            });
            return;
        }
        if (this.pending.length >= SEGMENT_ROWS) this.flushSegment();
    }

    private flushSegment(): void {
        const rows = this.pending;
        const boatId = this.boatId;
        this.pending = [];
        this.lastSegmentAt = this.deps.now();
        if (!rows.length || !boatId) return;
        const text = rows.map(encodeSeabedRow).join('\n') + '\n';
        this.enqueue(() => this.deps.files.append(openFile(boatId), text));
    }

    /** An hour closed mid-trip waits here, as plain CSV, for the trip's end. */
    private async holdHour(batch: SeabedClosedBatch, boatId: string): Promise<void> {
        const sha = await sha256Hex(new TextEncoder().encode(batch.csv));
        const name = queueFileName(batch.rows[0].timeMs, sha, batch.rows.length, batch.summary.track_m, 'h');
        await this.deps.files.write(
            name,
            JSON.stringify({ v: 1, boat_id: boatId, csv: batch.csv, counters: batch.counters }),
        );
        await this.recheckFull();
    }

    /** The trip ended at `end`: every held hour is trimmed by it and queued, oldest first. */
    private async releaseHeld(end: SeabedFix | null): Promise<void> {
        const held = (await this.deps.files.list()).filter((f) => f.name.startsWith('h-')).map((f) => f.name);
        for (const name of held.sort()) {
            const hour = readHeldHour(await this.deps.files.read(name));
            const batch = hour ? trimTripEnd(hour.rows, hour.counters, end) : null;
            if (hour && batch) await this.queueBatch(batch, false, hour.boatId);
            await this.deps.files.remove(name);
        }
    }

    private meta(recovered: boolean): Record<string, unknown> {
        return cleanCaptureMeta({
            ...this.deps.meta(),
            schema: SEABED_RAW_SCHEMA,
            device: 'phone',
            logger: 'Thalassa iOS',
            logger_version: `seabed-core ${SEABED_CORE_VERSION}`,
            time_source: 'device-clock',
            position_source: 'nmea-gateway',
            depth_source: 'nmea0183:DBT/DPT raw',
            transducer_to_keel_m: this.offsets.toKeel,
            surface_to_transducer_m: this.offsets.toSurface,
            sampling: '1Hz-max',
            core_version: SEABED_CORE_VERSION,
            recovered,
        });
    }

    private async queueBatch(batch: SeabedClosedBatch, recovered: boolean, boatId: string): Promise<void> {
        const packed = await this.deps.gzip(batch.csv);
        const sha256 = await sha256Hex(packed.bytes);
        const body = {
            v: 1,
            boat_id: boatId,
            device: 'phone',
            encoding: packed.encoding,
            csv_b64: base64(packed.bytes),
            sha256,
            meta: this.meta(recovered),
            counters: batch.counters,
        };
        const name = queueFileName(batch.rows[0].timeMs, sha256, batch.rows.length, batch.summary.track_m);
        await this.deps.files.write(name, JSON.stringify(body));
        await this.recheckFull();
    }

    /** The queue against its 64 MiB cap. Full: no new soundings; nothing held is dropped. */
    async recheckFull(): Promise<void> {
        const files = await this.deps.files.list();
        const bytes = files.filter((f) => holdsSoundings(f.name)).reduce((n, f) => n + f.size, 0);
        this.full = bytes >= PHONE_QUEUE_CAP_BYTES;
    }

    /**
     * After an app kill: the trip that was running ended where its last kept
     * row was. Its held hours and open rows, per boat, are trimmed by that and
     * queued, marked recovered.
     */
    async recover(): Promise<void> {
        const files = (await this.deps.files.list()).map((f) => f.name).sort();
        const trips = new Map<string, { parked: HeldHour[]; open: SeabedRow[] }>();
        const trip = (boatId: string) => {
            let t = trips.get(boatId);
            if (!t) trips.set(boatId, (t = { parked: [], open: [] }));
            return t;
        };
        for (const name of files.filter((n) => n.startsWith('h-'))) {
            const hour = readHeldHour(await this.deps.files.read(name));
            if (hour) trip(hour.boatId).parked.push(hour);
        }
        for (const name of files.filter(isOpenFile)) {
            const text = await this.deps.files.read(name);
            const decoded = text?.trim() ? decodeSeabedCsv(`${SEABED_CSV_HEADER}\n${text.trim()}\n`, Infinity) : null;
            if (decoded?.ok) trip(name.slice(5, -4)).open.push(...decoded.rows);
        }
        for (const [boatId, t] of trips) {
            for (const batch of recoverTrip(t.parked, t.open)) await this.queueBatch(batch, true, boatId);
        }
        for (const name of files.filter((n) => n.startsWith('h-') || isOpenFile(n))) await this.deps.files.remove(name);
        await this.recheckFull();
    }
}

// ── Boot ──────────────────────────────────────────────────────────────────

let running: {
    userId: string;
    capture: SeabedPhoneCapture;
    timer: ReturnType<typeof setInterval>;
    unsubscribe: () => void;
} | null = null;
let authWatch: (() => void) | null = null;

/** The owner's active boat, as last read from their fleet (cache first, then the cloud). */
let activeBoat: string | null | undefined;
let fleetReadAt = 0;

export function seabedActiveBoatId(): string | null | undefined {
    return activeBoat;
}

/** Which boat is the owner's active one, and still theirs: the cached fleet (offline at sea), then the cloud. Never throws. */
async function refreshActiveBoat(source: 'cache' | 'cloud'): Promise<void> {
    const scope = getAuthIdentityScope();
    try {
        const fleets = await import('../VesselFleetService');
        if (source === 'cache') {
            const cached = await fleets.loadCachedOwnedVesselFleet(scope);
            if (cached && isAuthIdentityScopeCurrent(scope)) activeBoat = cached.fleet.activeBoatId;
            return;
        }
        fleetReadAt = Date.now();
        const fleet = await fleets.loadOwnedVesselFleet(scope);
        if (isAuthIdentityScopeCurrent(scope)) activeBoat = fleet.activeBoatId;
    } catch {
        /* offline: keep what the cache said */
    }
}

function gateNow(capture: SeabedPhoneCapture) {
    return seabedPhoneGate({
        local: readSeabedLocal(),
        deviceId: seabedDeviceId(),
        activeBoatId: activeBoat,
        piPaired: getPairing() !== null,
        native: Capacitor.isNativePlatform(),
        signedIn: !!getAuthIdentityScope().userId,
        full: capture.full,
    });
}

/**
 * Called at boot (and by the setting) when this account has seabed mapping on.
 * Starts the uploader whatever this device's role, so a queue left from when
 * it was the logger still goes; installs the sink only on the chosen phone.
 */
export async function startSeabedPhoneCapture(): Promise<void> {
    const userId = getAuthIdentityScope().userId;
    if (running || !userId) return;
    const files = capacitorSeabedFiles(userId);
    const capture = new SeabedPhoneCapture({
        files,
        now: Date.now,
        connected: () => NmeaListenerService.getStatus() === 'connected',
        gzip: gzipText,
        meta: () => ({ sounder_note: readSeabedLocal()?.sounderNote ?? undefined }),
    });
    const evaluate = () => {
        const local = readSeabedLocal();
        capture.setZones(local?.zones ?? []);
        const gate = gateNow(capture);
        if (gate.armed && local && capture.armedFor !== local.boatId) {
            capture.arm(local.boatId);
            setSeabedSink((type, parts, at) => capture.onSentence(type, parts, at));
        } else if (!gate.armed && capture.stats().armed) {
            setSeabedSink(null);
            // A full queue only pauses; anything else ends the trip now.
            if (gate.reason === 'full') capture.disarm();
            else void capture.finish();
        }
    };
    const timer = setInterval(() => {
        capture.tick();
        evaluate();
        if (Date.now() - fleetReadAt >= FLEET_REFRESH_MS) void refreshActiveBoat('cloud').then(evaluate);
    }, TICK_MS);
    running = { userId, capture, timer, unsubscribe: subscribeSeabed(evaluate) };
    // Another account signing in on this device: this one's queue and trip stop here.
    authWatch ??= subscribeAuthIdentityScope(() => {
        activeBoat = undefined;
        fleetReadAt = 0;
        void stopSeabedPhoneCapture(false).then(() => (seabedLocallyEnabled() ? startSeabedPhoneCapture() : undefined));
    });
    await capture.recover().catch(() => undefined);
    if (activeBoat === undefined) await refreshActiveBoat('cache');
    evaluate();
    void refreshActiveBoat('cloud').then(evaluate);
    const { startSeabedUploader } = await import('./SeabedUploader');
    startSeabedUploader(files, () => capture.recheckFull(), seabedActiveBoatId);
}

/** The last stop, so an account deletion waits for its final write before removing the folder. */
let stopping: Promise<void> = Promise.resolve();

/** Switched off on this device: end the trip, remove the sink, purge what was not uploaded. */
export function stopSeabedPhoneCapture(purge: boolean): Promise<void> {
    const userId = getAuthIdentityScope().userId;
    const done = stopping.then(() => stopNow(purge, userId));
    stopping = done.catch(() => undefined);
    return done;
}

async function stopNow(purge: boolean, userId: string | null): Promise<void> {
    setSeabedSink(null);
    if (running) {
        clearInterval(running.timer);
        running.unsubscribe();
        await running.capture.finish();
        running = null;
    }
    const { stopSeabedUploader } = await import('./SeabedUploader');
    stopSeabedUploader();
    if (purge && userId) {
        const files = capacitorSeabedFiles(userId);
        for (const f of await files.list()) await files.remove(f.name);
    }
}

/**
 * Account deletion: this account's queue folder goes, held hours and open rows
 * with it, with no last batch written on the way out.
 */
export async function purgeSeabedForUser(userId: string): Promise<void> {
    await stopping;
    if (running?.userId === userId) {
        setSeabedSink(null);
        clearInterval(running.timer);
        running.unsubscribe();
        running.capture.disarm();
        await running.capture.idle();
        running = null;
        const { stopSeabedUploader } = await import('./SeabedUploader');
        stopSeabedUploader();
    }
    await Filesystem.rmdir({ path: seabedDir(userId), directory: Directory.Data, recursive: true }).catch(
        () => undefined,
    );
}
setSeabedPurgeHook(purgeSeabedForUser);

/** Rows and track waiting on this phone, for the contribution line: one directory listing, no reads. */
export async function phoneSeabedQueue(): Promise<{ soundings: number; trackM: number; full: boolean }> {
    const userId = getAuthIdentityScope().userId;
    const out = { soundings: 0, trackM: 0, full: false };
    if (!userId) return out;
    let bytes = 0;
    for (const f of await capacitorSeabedFiles(userId).list()) {
        if (!holdsSoundings(f.name)) continue;
        bytes += f.size;
        const parsed = parseQueueFileName(f.name);
        if (!parsed) continue;
        out.soundings += parsed.rows;
        out.trackM += parsed.trackM;
    }
    out.full = bytes >= PHONE_QUEUE_CAP_BYTES;
    return out;
}
