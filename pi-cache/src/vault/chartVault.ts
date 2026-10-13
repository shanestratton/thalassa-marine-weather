/**
 * The chart vault's memory (127-C-d decision 7).
 *
 *  - Decoded cells are held as Buffers, never JS strings (a string that meets
 *    one non-Latin-1 character doubles in V8), in an LRU capped by bytes and
 *    keyed by `cellId@contentSha256`, so a new revision is a new entry.
 *  - One decode at a time: the oexserverd FIFO protocol is one cell at a time.
 *    Concurrent requests for the same cell share one decode (single-flight).
 *  - A phone's request goes first, then prewarm, then indexing; within a class,
 *    first come first served. More than `queueMax` waiting and a request is
 *    refused with 503 vault-busy and a Retry-After; prewarm is skipped instead.
 *  - Every decode's hash is checked against the index. A different hash means
 *    the cell changed under the index: it is re-indexed and the new revision
 *    served (the phone's expectedSha256 check then makes it re-sync).
 *
 * Nothing here touches a disk. The caller supplies `decode` (decrypt + parse +
 * emit, in RAM) and the index lookups.
 */
import type { VaultRefusalCode } from './protocol.js';

export interface VaultEntryLike {
    cellId: string;
    contentSha256: string;
}

export interface DecodedBytes {
    bytes: Buffer;
    sha256: string;
}

export class VaultRefusal extends Error {
    constructor(
        public readonly code: VaultRefusalCode,
        public readonly status: number,
        message: string = code,
        public readonly retryAfterSeconds?: number,
    ) {
        super(message);
        this.name = 'VaultRefusal';
    }
}

/** 0 runs first. */
const PRIORITY = { request: 0, prewarm: 1, index: 2 } as const;
type Priority = keyof typeof PRIORITY;

interface Task {
    priority: number;
    seq: number;
    run: () => Promise<void>;
}

export interface ChartVaultOptions<E extends VaultEntryLike> {
    lruBytes: number;
    queueMax?: number;
    retryAfterSeconds?: number;
    /** The index's current entry for a cell (the newest served revision), if any. */
    lookup: (cellId: string) => E | undefined;
    /** Decrypt, parse and emit one cell, in RAM. */
    decode: (entry: E) => Promise<DecodedBytes>;
    /** The decode's hash differs from the index's: update the index, return the new entry. */
    reindex?: (entry: E, decoded: DecodedBytes) => Promise<E>;
}

export class ChartVault<E extends VaultEntryLike = VaultEntryLike> {
    private readonly lru = new Map<string, Buffer>();
    private bytes = 0;
    private readonly flights = new Map<string, Promise<{ bytes: Buffer; sha256: string; entry: E }>>();
    private readonly queue: Task[] = [];
    private seq = 0;
    private running = false;
    private readonly queueMax: number;
    private readonly retryAfterSeconds: number;
    /** Decodes run so far (for the status line and tests). */
    decodes = 0;

    constructor(private readonly opts: ChartVaultOptions<E>) {
        this.queueMax = opts.queueMax ?? 64;
        this.retryAfterSeconds = opts.retryAfterSeconds ?? 5;
    }

    get lruBytes(): number {
        return this.bytes;
    }

    get lruCells(): number {
        return this.lru.size;
    }

    /** Tasks waiting (not the one running). */
    get waiting(): number {
        return this.queue.length;
    }

    get capacity(): number {
        return this.opts.lruBytes;
    }

    /** Is this cell's current revision in memory? */
    cached(cellId: string): boolean {
        const entry = this.opts.lookup(cellId);
        return entry !== undefined && this.lru.has(key(entry));
    }

    /** A phone's request: from memory, or decoded ahead of prewarm and indexing. */
    async get(cellId: string): Promise<{ bytes: Buffer; sha256: string; entry: E }> {
        return this.fetch(cellId, 'request');
    }

    /** Warm one cell if there is room in the queue; false when skipped. Never throws. */
    async prewarm(cellId: string): Promise<boolean> {
        const entry = this.opts.lookup(cellId);
        if (!entry) return false;
        if (this.lru.has(key(entry))) return true;
        if (!this.flights.has(key(entry)) && this.queue.length >= this.queueMax) return false;
        try {
            await this.fetch(cellId, 'prewarm');
            return true;
        } catch {
            return false;
        }
    }

    /** Index work, behind every request and prewarm: one decode slot, so never beside a phone's cell. */
    runIndex<T>(work: () => Promise<T>): Promise<T> {
        return this.schedule('index', work);
    }

    /** Drop a cell from memory, whatever its revision (removal, re-index). */
    evict(cellId: string): void {
        for (const [k, buf] of this.lru) {
            if (k.slice(0, k.lastIndexOf('@')) !== cellId) continue;
            this.lru.delete(k);
            this.bytes -= buf.length;
        }
    }

    /** Drop everything (the decoder went down; a restart of the index). */
    clear(): void {
        this.lru.clear();
        this.bytes = 0;
    }

    private async fetch(cellId: string, priority: Priority): Promise<{ bytes: Buffer; sha256: string; entry: E }> {
        const entry = this.opts.lookup(cellId);
        if (!entry) throw new VaultRefusal('cell-not-found', 404, 'Cell not installed');
        const k = key(entry);
        const hit = this.lru.get(k);
        if (hit) {
            this.lru.delete(k);
            this.lru.set(k, hit);
            return { bytes: hit, sha256: entry.contentSha256, entry };
        }
        const flying = this.flights.get(k);
        if (flying) return flying;
        if (priority === 'request' && this.queue.length >= this.queueMax) {
            throw new VaultRefusal(
                'vault-busy',
                503,
                'The chart vault is busy opening charts.',
                this.retryAfterSeconds,
            );
        }
        const flight = this.schedule(priority, async () => {
            const decoded = await this.opts.decode(entry);
            this.decodes++;
            let current = entry;
            if (decoded.sha256 !== entry.contentSha256) {
                current = this.opts.reindex ? await this.opts.reindex(entry, decoded) : entry;
                this.evict(cellId);
            }
            this.remember(key({ cellId, contentSha256: decoded.sha256 }), decoded.bytes);
            return { bytes: decoded.bytes, sha256: decoded.sha256, entry: current };
        }).finally(() => {
            this.flights.delete(k);
        });
        this.flights.set(k, flight);
        return flight;
    }

    private remember(k: string, buf: Buffer): void {
        if (buf.length > this.opts.lruBytes) return; // served, never cached
        const old = this.lru.get(k);
        if (old) {
            this.lru.delete(k);
            this.bytes -= old.length;
        }
        this.lru.set(k, buf);
        this.bytes += buf.length;
        for (const [oldest, oldBuf] of this.lru) {
            if (this.bytes <= this.opts.lruBytes) break;
            this.lru.delete(oldest);
            this.bytes -= oldBuf.length;
        }
    }

    private schedule<T>(priority: Priority, work: () => Promise<T>): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            this.queue.push({
                priority: PRIORITY[priority],
                seq: this.seq++,
                run: () => work().then(resolve, reject),
            });
            void this.drain();
        });
    }

    private async drain(): Promise<void> {
        if (this.running) return;
        this.running = true;
        try {
            while (this.queue.length > 0) {
                let best = 0;
                for (let i = 1; i < this.queue.length; i++) {
                    const a = this.queue[i];
                    const b = this.queue[best];
                    if (a.priority < b.priority || (a.priority === b.priority && a.seq < b.seq)) best = i;
                }
                const [task] = this.queue.splice(best, 1);
                await task.run();
            }
        } finally {
            this.running = false;
        }
    }
}

function key(entry: VaultEntryLike): string {
    return `${entry.cellId}@${entry.contentSha256}`;
}
