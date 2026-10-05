/**
 * Seabed mapping: the Pi's capture loop.
 *
 * Shares a process with the anchor watch and the instruments, so it is built
 * never to get in their way:
 *   - a setTimeout chain that skips a tick still in flight, never an interval;
 *   - one loopback read of Signal K a second while under way (discovery is
 *     cached by the reader), one every 10 s while stopped;
 *   - one prepared SQLite insert per sounding, gzip off the event loop;
 *   - nothing throws: every failure becomes an outcome on the status route.
 *
 * Under way, trimming, zones and batches are the shared core's
 * (seabedCore.ts), the same code the phone and the ingest function run.
 *
 * An hour closed mid-trip is HELD (seabed_parked) and queued only when the
 * trip ends, trimmed of every row within 500 m of where she stopped. After a
 * restart, recover() ends the trip at the last row it kept.
 *
 * Every batch carries the account the Pi was paired to when its rows were
 * taken. discard() (the Pi changed hands) drops the trip in memory and
 * makes any save already under way land nowhere.
 */
import { createHash } from 'node:crypto';
import {
    cleanCaptureMeta,
    recoverTrip,
    SEABED_CORE_VERSION,
    SEABED_FLAG,
    SEABED_RAW_SCHEMA,
    SeabedCapture,
    trimTripEnd,
    type SeabedClosedBatch,
    type SeabedCounters,
    type SeabedRow,
    type SeabedStep,
} from './seabedCore.js';
import { readSounding, sounderProduct, type Sounding } from './seabedReader.js';
import type { NewBatch, PiSeabedConfig, SaveOptions, SeabedStore } from './seabedStore.js';

export const UNDERWAY_TICK_MS = 1_000;
export const IDLE_TICK_MS = 10_000;
const CHECKPOINT_EVERY_MS = 5 * 60_000;

export type SeabedRunOutcome =
    | 'off'
    | 'no-signalk'
    | 'not-under-way'
    | 'logging'
    | 'storage-full'
    | 'no-gps-time'
    | 'no-fix'
    | 'failed';

export interface SeabedRunnerDeps {
    /** The boat's self document, or null when Signal K cannot be asked. */
    read: () => Promise<unknown | null>;
    /** Signal K's sources tree, for the sounder's make and model (optional). */
    readSources?: () => Promise<unknown | null>;
    store: SeabedStore;
    gzip: (text: string) => Promise<Buffer>;
    now?: () => number;
    log?: (line: string) => void;
}

export interface SeabedRunnerStatus {
    running: boolean;
    underway: boolean;
    capturing: boolean;
    full: boolean;
    lastOutcome: SeabedRunOutcome | null;
    heldRows: number;
    counters: SeabedCounters;
    soundingsThisSession: number;
}

export class SeabedRunner {
    private capture = new SeabedCapture();
    private timer: ReturnType<typeof setTimeout> | null = null;
    private running = false;
    private inFlight = false;
    private lastDepthAt: number | null = null;
    private lastOutcome: SeabedRunOutcome | null = null;
    private lastCheckpoint = 0;
    private full = false;
    private written = 0;
    private latest: Sounding | null = null;
    private product: string | null = null;
    /** Bumped by discard(): work begun before it lands nowhere. */
    private generation = 0;

    constructor(private readonly deps: SeabedRunnerDeps) {}

    private now(): number {
        return (this.deps.now ?? Date.now)();
    }

    private log(line: string): void {
        (this.deps.log ?? console.log)(`[seabed] ${line}`);
    }

    describe(): SeabedRunnerStatus {
        return {
            running: this.running,
            underway: this.capture.underway,
            capturing: this.running && this.capture.underway && !this.full,
            full: this.full,
            lastOutcome: this.lastOutcome,
            heldRows: this.capture.heldRows,
            counters: { ...this.capture.counters },
            soundingsThisSession: this.written,
        };
    }

    /** Start (or keep) the loop, after closing any batch a restart left open. */
    start(): void {
        if (this.running) return;
        this.running = true;
        this.capture.setZones(this.deps.store.getConfig().zones);
        void this.recover()
            .catch(() => undefined)
            .finally(() => this.schedule(0));
    }

    /** Switched off: the trip ends here (held rows dropped, open batch closed). */
    async stop(): Promise<void> {
        this.running = false;
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        try {
            await this.persist(this.capture.finish());
        } catch (err) {
            this.log(`could not close the open batch: ${err instanceof Error ? err.message : String(err)}`);
        }
        this.lastOutcome = 'off';
    }

    /** Process exit: timers only. The open rows are already on disk and come back as a batch. */
    halt(): void {
        this.running = false;
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
    }

    /**
     * The Pi changed hands (or was unpaired): stop, and forget the trip in
     * memory, closing nothing. The caller empties the store; a save already
     * under way sees the new generation and writes nothing.
     */
    discard(): void {
        this.halt();
        this.generation += 1;
        this.capture = new SeabedCapture();
        this.lastDepthAt = null;
        this.latest = null;
        this.product = null;
        this.full = false;
        this.lastOutcome = 'off';
    }

    applyConfig(config: PiSeabedConfig): void {
        this.capture.setZones(config.zones);
        if (config.enabled) this.start();
        else if (this.running) void this.stop();
    }

    /**
     * A restart ended the trip that was running, at the last row it kept: its
     * held hours and open rows are trimmed by that and queued, marked recovered.
     */
    async recover(): Promise<void> {
        const parked = this.deps.store.parkedBatches();
        const open = this.deps.store.openRows();
        if (!parked.length && !open.length) return;
        const batches = recoverTrip(parked, open);
        await this.save(batches, [], { clearParked: true }, true);
        this.log(`closed ${parked.length} held hour(s) and ${open.length} open row(s) left by a restart`);
    }

    private schedule(delayMs: number): void {
        if (!this.running) return;
        this.timer = setTimeout(() => {
            void this.tick().finally(() => this.schedule(this.capture.underway ? UNDERWAY_TICK_MS : IDLE_TICK_MS));
        }, delayMs);
        this.timer.unref?.();
    }

    /** One read of the bus. Never throws. Public for the tests. */
    async tick(): Promise<void> {
        if (this.inFlight) return;
        this.inFlight = true;
        const generation = this.generation;
        try {
            const config = this.deps.store.getConfig();
            if (!config.enabled) {
                this.setOutcome('off');
                return;
            }
            this.capture.setZones(config.zones);
            const doc = await this.deps.read();
            if (generation !== this.generation) return;
            const now = this.now();
            if (doc === null) {
                await this.persist(this.capture.observe(now, null, null));
                this.setOutcome('no-signalk');
                return;
            }
            const s = readSounding(doc, now);
            this.latest = s;
            const step = this.capture.observe(now, s.sogKn, s.fix);
            if (step.event === 'start') void this.lookUpSounder(s);
            this.offerSounding(s, step);
            await this.persist(step);
            if (now - this.lastCheckpoint >= CHECKPOINT_EVERY_MS) {
                this.deps.store.checkpoint();
                this.lastCheckpoint = now;
            }
        } catch (err) {
            this.setOutcome('failed', err instanceof Error ? err.message : String(err));
        } finally {
            this.inFlight = false;
        }
    }

    private offerSounding(s: Sounding, step: SeabedStep): void {
        if (!this.capture.underway) {
            this.setOutcome('not-under-way');
            return;
        }
        if (!s.depth) return;
        if (s.depth.atMs === this.lastDepthAt) {
            this.capture.counters.rereads_skipped += 1;
            return;
        }
        this.lastDepthAt = s.depth.atMs;
        this.full = this.deps.store.isFull();
        if (this.full) return this.setOutcome('storage-full');
        if (s.gpsOffsetMs === null) {
            this.capture.counters.no_gps_time += 1;
            return this.setOutcome('no-gps-time');
        }
        if (!s.fix || s.posAtMs === null) {
            this.capture.counters.no_bus_fix += 1;
            return this.setOutcome('no-fix');
        }
        const row: SeabedRow = {
            lon: s.fix.lon,
            lat: s.fix.lat,
            depth: s.depth.value,
            timeMs: s.depth.atMs + s.gpsOffsetMs,
            sogKn: s.sogKn,
            cogDeg: s.cogDeg,
            hdgDeg: s.hdgDeg,
            heelDeg: s.heelDeg,
            fixQ: s.fixQ,
            hdop: s.hdop,
            sats: s.sats,
            posAgeMs: s.depth.atMs - s.posAtMs,
            depthRef: s.depth.ref,
            flags: s.depth.derived ? SEABED_FLAG.DEPTH_DERIVED : 0,
        };
        const offered = this.capture.offer(row);
        step.appended.push(...offered.appended);
        step.closed.push(...offered.closed);
        this.setOutcome('logging');
    }

    private async lookUpSounder(s: Sounding): Promise<void> {
        if (!this.deps.readSources) return;
        try {
            this.product = sounderProduct(await this.deps.readSources(), s.depthSourceLabel);
        } catch {
            this.product = null;
        }
    }

    private meta(recovered: boolean): Record<string, unknown> {
        const config = this.deps.store.getConfig();
        const s = this.latest;
        return cleanCaptureMeta({
            schema: SEABED_RAW_SCHEMA,
            device: 'pi',
            logger: 'Thalassa Pi',
            logger_version: `seabed-core ${SEABED_CORE_VERSION}`,
            time_source: 'gnss',
            position_source: s?.positionSource ?? undefined,
            depth_source: s?.depth?.source ?? undefined,
            transducer_to_keel_m: s?.transducerToKeelM ?? undefined,
            surface_to_transducer_m: s?.surfaceToTransducerM ?? undefined,
            vessel_draft_m: config.vesselDraftM ?? undefined,
            draft_confirmed: config.draftConfirmed ?? undefined,
            sounder_note: config.sounderNote ?? undefined,
            sounder_product: this.product ?? undefined,
            sampling: '1Hz-max',
            core_version: SEABED_CORE_VERSION,
            recovered,
        });
    }

    /**
     * Queue closed batches (gzip off the event loop), hold parked hours and
     * replace the open rows, in one store transaction. The account is read
     * BEFORE the gzip awaits: if the Pi changed hands meanwhile, nothing lands.
     */
    private async save(
        batches: SeabedClosedBatch[],
        open: SeabedRow[],
        options: SaveOptions = {},
        recovered = false,
    ): Promise<void> {
        const generation = this.generation;
        const ownerId = this.deps.store.getConfig().ownerId;
        const meta = this.meta(recovered);
        const ready: NewBatch[] = [];
        for (const b of batches) {
            const gz = await this.deps.gzip(b.csv);
            ready.push({
                tStartMs: b.rows[0].timeMs,
                tEndMs: b.rows[b.rows.length - 1].timeMs,
                rows: b.rows.length,
                trackM: b.summary.track_m,
                gz,
                sha256: createHash('sha256').update(gz).digest('hex'),
                meta,
                counters: { ...b.counters },
                ownerId,
            });
        }
        if (generation !== this.generation || this.deps.store.getConfig().ownerId !== ownerId) return;
        this.deps.store.saveBatches(ready, open, { ...options, ownerId });
        if (ready.length) this.log(`closed ${ready.length} batch(es), ${ready.reduce((n, b) => n + b.rows, 0)} rows`);
    }

    private async persist(step: SeabedStep): Promise<void> {
        this.written += step.appended.length;
        const finals = step.closed.filter((b) => !b.parked);
        const parked = step.closed.filter((b) => b.parked);
        if (!finals.length && !parked.length && !step.tripEnd) {
            this.deps.store.appendOpenRows(step.appended);
            return;
        }
        if (!step.tripEnd) {
            const hold = parked.map((b) => ({ csv: b.csv, rows: b.rows.length, counters: b.counters }));
            await this.save(finals, this.capture.openRows(), { parked: hold });
            return;
        }
        // The trip ended: every hour held for it is trimmed by where she stopped, then queued.
        const end = step.tripEnd.at;
        const held = [...this.deps.store.parkedBatches(), ...parked];
        const trimmed = held
            .map((h) => trimTripEnd(h.rows, h.counters, end))
            .filter((b): b is SeabedClosedBatch => b !== null);
        await this.save([...trimmed, ...finals], this.capture.openRows(), { clearParked: true });
    }

    private setOutcome(outcome: SeabedRunOutcome, detail?: string): void {
        if (outcome !== this.lastOutcome) this.log(detail ? `${outcome}: ${detail}` : outcome);
        this.lastOutcome = outcome;
    }
}
