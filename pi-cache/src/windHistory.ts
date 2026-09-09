/** The boat remembers observed true-wind peaks even when no phone is watching. */
import { constants } from 'node:fs';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fetchSelfDocument, type BroadcastDeps } from './anchorBroadcaster.js';
import { knots } from './trackSignalk.js';

export const WIND_HISTORY_MS = 3_600_000;
export const WIND_GUST_WINDOW_MS = 600_000;
export const WIND_SAMPLE_INTERVAL_MS = 5_000;
export const WIND_SOURCE_MAX_AGE_MS = 20_000;
export const WIND_HISTORY_SAMPLE_CAP = 2_000;
export const WIND_HISTORY_PERSIST_INTERVAL_MS = 30_000;
const MAX_FILE_BYTES = 160_000;
const REQUEST_TIMEOUT_MS = 8_000;

export interface WindHistorySample {
    at: number;
    kts: number;
}
export interface WindSourceSample extends WindHistorySample {
    source: string;
}
type Json = Record<string, unknown>;
const record = (v: unknown): Json | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const sourceName = (v: unknown): v is string =>
    typeof v === 'string' && v.trim().length > 0 && v.length <= 120 && !/\p{Cc}/u.test(v);
const validSample = (v: unknown, now: number, maxAge = WIND_HISTORY_MS, inclusive = false): v is WindHistorySample => {
    const sample = record(v);
    return (
        !!sample &&
        finite(sample.at) &&
        sample.at > 0 &&
        sample.at <= now &&
        (inclusive ? now - sample.at <= maxAge : now - sample.at < maxAge) &&
        finite(sample.kts) &&
        sample.kts >= 0 &&
        sample.kts <= 150
    );
};

/** No parent GPS clock, HTTP receipt time, forecast, or cached value masquerading as a new observation. */
export function readWindHistorySample(doc: unknown, now = Date.now()): WindSourceSample | null {
    const wind = record(record(record(doc)?.environment)?.wind);
    const leaf = record(wind?.speedTrue);
    if (!leaf || typeof leaf.timestamp !== 'string' || !sourceName(leaf.$source) || !finite(leaf.value)) return null;
    const sample = { at: Date.parse(leaf.timestamp), kts: knots(leaf.value), source: leaf.$source.trim() };
    return validSample(sample, now, WIND_SOURCE_MAX_AGE_MS, true) ? (sample as WindSourceSample) : null;
}

/** Bounded, source-specific observed peaks. The ten-minute peak is not a meteorological three-second gust. */
export class RollingWindHistory {
    private source: string | null = null;
    private samples: WindHistorySample[] = [];

    ingest(sample: WindSourceSample, now = Date.now()): boolean {
        this.prune(now);
        if (!sourceName(sample.source) || !validSample(sample, now, WIND_SOURCE_MAX_AGE_MS, true)) return false;
        const last = this.samples.at(-1);
        // Delayed envelopes from a different sensor cannot roll the current
        // source back, any more than a repeated envelope can add a sample.
        if (last && sample.at <= last.at) return false;
        if (sample.source !== this.source) {
            this.source = sample.source;
            this.samples = [];
        }
        this.samples.push({ at: sample.at, kts: sample.kts });
        this.prune(now);
        return true;
    }

    private prune(now: number): void {
        this.samples = this.samples.filter((sample) => validSample(sample, now)).slice(-WIND_HISTORY_SAMPLE_CAP);
        if (!this.samples.length) this.source = null;
    }

    extra(now = Date.now()): Record<string, number | string> {
        this.prune(now);
        if (!this.samples.length || !this.source) return {};
        let peak = this.samples[0];
        let gust: WindHistorySample | null = null;
        for (const sample of this.samples) {
            if (sample.kts >= peak.kts) peak = sample;
            if (now - sample.at < WIND_GUST_WINDOW_MS && (!gust || sample.kts >= gust.kts)) gust = sample;
        }
        return {
            wind_history_v: 1,
            wind_history_at_ms: now,
            wind_history_since_ms: this.samples[0].at,
            wind_history_latest_ms: this.samples.at(-1)!.at,
            wind_history_samples_1h: this.samples.length,
            wind_history_source: this.source,
            wind_max_1h_kts: peak.kts,
            wind_max_1h_at_ms: peak.at,
            ...(gust ? { wind_gust_10m_kts: gust.kts, wind_gust_10m_at_ms: gust.at } : {}),
        };
    }

    serialize(now = Date.now(), identity?: string): string {
        this.prune(now);
        return JSON.stringify({ version: 1, identity, source: this.source, samples: this.samples });
    }

    restore(raw: string, now = Date.now(), identity?: string): void {
        if (Buffer.byteLength(raw, 'utf8') > MAX_FILE_BYTES) return;
        try {
            const value = record(JSON.parse(raw));
            if (
                value?.version !== 1 ||
                (identity !== undefined && value.identity !== identity) ||
                !sourceName(value.source) ||
                !Array.isArray(value.samples) ||
                value.samples.length > WIND_HISTORY_SAMPLE_CAP
            )
                return;
            const samples: WindHistorySample[] = [];
            for (const sample of value.samples) {
                if (!validSample(sample, now)) continue;
                if (samples.length && sample.at <= samples.at(-1)!.at) continue;
                samples.push({ at: sample.at, kts: sample.kts });
            }
            this.source = value.source;
            this.samples = samples;
            this.prune(now);
        } catch {
            // Missing/corrupt history starts empty, never invents a preceding hour.
        }
    }
}

export interface WindHistoryDeps extends BroadcastDeps {
    cacheDir: string;
    /** Stable pairing identity, not a hostname reused by another boat. */
    vesselIdentity?: string;
}

/** Local Signal K only. Collection has no account, pairing, screen, or internet-policy dependency. */
export class WindHistory {
    private readonly history = new RollingWindHistory();
    private readonly file: string;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private running = false;
    private generation = 0;
    private request: AbortController | null = null;
    private inFlight: Promise<void> | null = null;
    private lastPersistedAt: number | null = null;
    private dirty = false;

    constructor(private readonly deps: WindHistoryDeps) {
        this.file = join(deps.cacheDir, 'wind-history.json');
    }

    async start(): Promise<void> {
        if (this.running) return;
        this.running = true;
        const generation = ++this.generation;
        await this.load(generation);
        if (!this.current(generation)) return;
        await this.sampleOnce();
        if (this.current(generation)) this.schedule();
    }

    stop(): void {
        this.running = false;
        ++this.generation;
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        this.request?.abort();
    }

    extra(): Record<string, number | string> {
        const extra = this.history.extra(this.now());
        if (extra.wind_history_v && sourceName(this.deps.vesselIdentity))
            extra.wind_history_identity = this.deps.vesselIdentity;
        return extra;
    }

    /** Shared by the timer and deterministic tests. Never overlaps a preceding read/write. */
    sampleOnce(): Promise<void> {
        if (!this.running) return Promise.resolve();
        if (this.inFlight) return this.inFlight;
        const generation = this.generation;
        this.inFlight = this.sample(generation).finally(() => {
            this.inFlight = null;
        });
        return this.inFlight;
    }

    private now(): number {
        return (this.deps.now ?? Date.now)();
    }
    private current(generation: number): boolean {
        return this.running && this.generation === generation;
    }

    private schedule(generation = this.generation): void {
        if (!this.current(generation)) return;
        this.timer = setTimeout(() => {
            this.timer = null;
            void this.sampleOnce().finally(() => this.schedule(generation));
        }, WIND_SAMPLE_INTERVAL_MS);
        this.timer.unref?.();
    }

    private async sample(generation: number): Promise<void> {
        const controller = new AbortController();
        this.request = controller;
        let forcePersist = false;
        try {
            const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
            const origin = new URL(this.deps.signalkOrigin).origin;
            const doc = await fetchSelfDocument({
                ...this.deps,
                fetchImpl: (url, init) => {
                    if (new URL(String(url)).origin !== origin)
                        throw new Error('Signal K discovery left its local origin');
                    return this.deps.fetchImpl(url, { ...init, signal, redirect: 'error' });
                },
            });
            if (!this.current(generation)) return;
            const sample = readWindHistorySample(doc, this.now());
            const previousSource = this.history.extra(this.now()).wind_history_source;
            if (sample && this.history.ingest(sample, this.now())) {
                this.dirty = true;
                forcePersist = previousSource !== sample.source;
            }
        } catch {
            // A quiet/disconnected instrument leaves a truthful gap; existing peaks still age out.
        } finally {
            // Quiet/failing sources must not leave an already-observed peak
            // dirty forever merely because no new sample triggers the flush.
            await this.flushIfDue(generation, forcePersist);
            if (this.request === controller) this.request = null;
        }
    }

    private async flushIfDue(generation: number, force = false): Promise<void> {
        if (!this.dirty || !this.current(generation)) return;
        const now = this.now();
        // First observations and physical source changes flush immediately;
        // ordinary observations batch to protect the Pi's SD card.
        if (
            force ||
            this.lastPersistedAt === null ||
            now < this.lastPersistedAt ||
            now - this.lastPersistedAt >= WIND_HISTORY_PERSIST_INTERVAL_MS
        ) {
            if (await this.persist(generation)) {
                this.lastPersistedAt = now;
                this.dirty = false;
            }
        }
    }

    private async load(generation: number): Promise<void> {
        let handle;
        try {
            handle = await open(this.file, constants.O_RDONLY | constants.O_NOFOLLOW);
            const stat = await handle.stat();
            if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return;
            // Bound the read itself, not only stat(), because a concurrently written file can grow.
            const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
            if (bytesRead > MAX_FILE_BYTES || !this.current(generation)) return;
            this.history.restore(buffer.toString('utf8', 0, bytesRead), this.now(), this.deps.vesselIdentity);
        } catch {
            // First deployment, corrupt file, or inaccessible disk: start with observed samples only.
        } finally {
            await handle?.close().catch(() => {});
        }
    }

    private async persist(generation: number): Promise<boolean> {
        const temporary = `${this.file}.${randomUUID()}.tmp`;
        let handle;
        try {
            const data = this.history.serialize(this.now(), this.deps.vesselIdentity);
            if (Buffer.byteLength(data, 'utf8') > MAX_FILE_BYTES || !this.current(generation)) return false;
            await mkdir(this.deps.cacheDir, { recursive: true });
            if (!this.current(generation)) return false;
            handle = await open(temporary, 'wx', 0o600);
            if (!this.current(generation)) return false;
            await handle.writeFile(data, 'utf8');
            await handle.sync();
            await handle.close();
            handle = undefined;
            if (!this.current(generation)) return false;
            await rename(temporary, this.file);
            return true;
        } catch {
            // A disk error does not interrupt live collection or replace the last valid record.
            return false;
        } finally {
            await handle?.close().catch(() => {});
            await unlink(temporary).catch(() => {});
        }
    }
}
