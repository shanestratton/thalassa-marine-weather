/**
 * The chart vault as one service (127-C-d decisions 6, 7 and 11): the index,
 * the RAM cache and the watch rule together, behind the socket protocol
 * (protocol.ts). main.ts wires it to oexserverd and a unix socket; the tests
 * wire it to a stub decrypt.
 *
 * The watch rule: no index work (an index pass, a rescan, a parser-schema
 * re-index, prewarm) runs while the anchor watch or an armed night watch is
 * on. The vault has no network (PrivateNetwork), so thalassa-cache tells it
 * (/v1/hint {watching}); until it has said anything, a watch counts as on.
 * A phone's own cell request is always served: one decode at Nice 10 inside
 * the CPU quota.
 */
import { EXTRACTOR_SCHEMA } from '../sencEngine/s57Classes.js';
import { ChartVault, VaultRefusal } from './chartVault.js';
import {
    CellUnreadableError,
    DecoderDownError,
    decodeSenc,
    setVaultS57Reference,
    type DecodedCell,
} from './decoder.js';
import { VAULT_LIMITS } from './limits.js';
import { prewarmOrder } from './prewarm.js';
import { VaultLookahead } from './lookahead.js';
import type { VaultLookaheadRequest, VaultLookaheadResponse } from './protocol.js';
import type { VaultCellMeta, VaultRescanWire, VaultState, VaultStatusWire } from './protocol.js';
import { VaultIndex, entryFromDecoded, type PendingFile, type ScanResult, type VaultFileEntry } from './vaultIndex.js';

export interface VaultServiceOptions {
    stateDir: string;
    /** Where delivered sets are found: ENC_WATCH_DIR (~/Charts) and enc-charts/sources. */
    roots: string[];
    /** oexserverd in production; a stub in tests. */
    decrypt: (filePath: string, installKey: string) => Promise<Buffer>;
    onStop?: () => Promise<void>;
    /** The S-57 catalogue CSVs (the install's /opt/thalassa-pi-cache/reference). */
    referenceDir?: string;
    lruBytes: number;
    queueMax?: number;
    retryAfterSeconds?: number;
    /** The parser schema entries are held to (a test seam; production: the mirror's EXTRACTOR_SCHEMA). */
    schema?: number;
    /** What is known about the watch at start: null = not told yet, which counts as on. */
    initialWatching?: boolean | null;
    prewarmShare?: number;
    prewarmRadiusNm?: number;
    /** After the decoder goes down mid-pass, try the pass again this long after, doubling to passRetryMaxMs. */
    passRetryMs?: number;
    passRetryMaxMs?: number;
    /** How a delivered file is hashed (a test seam; production: SHA-256 of its bytes, streamed). */
    hashFile?: (filePath: string) => Promise<string>;
    log?: Pick<Console, 'log' | 'warn'>;
}

const CHECKPOINT_EVERY = 50;

export class VaultService {
    private readonly ahead = new VaultLookahead();
    private readonly catalogue: VaultIndex;
    private readonly vault: ChartVault<VaultFileEntry>;
    private readonly log: Pick<Console, 'log' | 'warn'>;
    private readonly schema: number;
    private watching: boolean | null;
    private watchWaiters: (() => void)[] = [];
    private readyWaiters: (() => void)[] = [];
    private chain: Promise<void> = Promise.resolve();
    private passRunning = false;
    private rescanPending = false;
    private decoderDown = false;
    private opened = 0;
    private toOpen = 0;
    private stopped = false;
    private retryTimer: NodeJS.Timeout | null = null;
    private position: { lat: number; lon: number } | null = null;
    private prewarming = false;
    private passesDone = 0;
    /** Pass retries since the decoder went down (the backoff's exponent). */
    private retries = 0;
    /**
     * Where a pass stopped when the decoder went down: its plan and what it had
     * opened. The retry goes on from there while the delivered files are as
     * they were, instead of re-hashing every set (about 1.6 GB) each time.
     */
    private resume: { scan: ScanResult; entries: VaultFileEntry[]; fresh: VaultFileEntry[]; next: number } | null =
        null;

    constructor(private readonly opts: VaultServiceOptions) {
        if (opts.referenceDir) setVaultS57Reference(opts.referenceDir);
        this.log = opts.log ?? console;
        this.schema = opts.schema ?? EXTRACTOR_SCHEMA;
        this.watching = opts.initialWatching ?? null;
        this.catalogue = new VaultIndex({
            stateDir: opts.stateDir,
            roots: opts.roots,
            schema: this.schema,
            log: this.log,
            ...(opts.hashFile ? { hashFile: opts.hashFile } : {}),
        });
        this.vault = new ChartVault<VaultFileEntry>({
            lruBytes: opts.lruBytes,
            queueMax: opts.queueMax ?? VAULT_LIMITS.queueMax,
            retryAfterSeconds: opts.retryAfterSeconds ?? VAULT_LIMITS.retryAfterSeconds,
            lookup: (cellId) => this.catalogue.winner(cellId),
            decode: (entry) => this.decodeEntry(entry),
            reindex: async (entry, decoded) => {
                const { catalogue } = decoded as DecodedCell;
                const next: VaultFileEntry = {
                    ...entry,
                    sourceHO: catalogue.sourceHO,
                    edition: catalogue.edition,
                    updateNumber: catalogue.updateNumber ?? 0,
                    issued: catalogue.issued,
                    bbox: catalogue.bbox,
                    featureCount: catalogue.featureCount,
                    sizeBytes: catalogue.sizeBytes,
                    contentSha256: decoded.sha256,
                    extractorSchema: this.schema,
                };
                await this.catalogue.replace(next);
                this.log.warn(`[vault] ${entry.cellId}: decoded hash differs from the index; re-indexed`);
                return next;
            },
        });
    }

    /** Load the index, read the key XMLs, and start the first pass (in the background). */
    async start(): Promise<void> {
        const t0 = Date.now();
        await this.catalogue.load();
        // Keys and arrival times only (no hashing, no decoding), so cells
        // already indexed can be served at once, even during a watch.
        await this.catalogue.scan({ plan: false });
        this.log.log(
            `[vault] started: ${this.catalogue.servedEntries().length} cells indexed, ${this.catalogue.skippedSets.length} set(s) skipped (${Date.now() - t0} ms)`,
        );
        this.queuePass();
    }

    /** Resolves once an index pass of this run has completed. */
    whenReady(): Promise<void> {
        if (this.passesDone > 0 && !this.decoderDown) return Promise.resolve();
        return new Promise((resolve) => this.readyWaiters.push(resolve));
    }

    /** Resolves when no pass is running or due (a queued rescan waits only on a watch). */
    async whenIdle(): Promise<void> {
        let seen: Promise<void> | null = null;
        while (seen !== this.chain) {
            seen = this.chain;
            await seen;
        }
    }

    status(): VaultStatusWire {
        return {
            v: 1,
            state: this.state(),
            cells: this.catalogue.complete ? this.catalogue.servedEntries().length : 0,
            opened: this.opened,
            toOpen: this.toOpen,
            lruBytes: this.vault.lruBytes,
            lruCells: this.vault.lruCells,
            waiting: this.vault.waiting,
            watching: this.watching,
            rescanPending: this.rescanPending,
            decoder: this.decoderDown ? 'down' : this.vault.decodes > 0 || this.opened > 0 ? 'up' : 'idle',
            skippedSets: this.catalogue.skippedSets.map((s) => ({ set: s.set, reason: s.reason })),
        };
    }

    /** The served cells, for /api/enc/installed. */
    index(): VaultCellMeta[] {
        this.assertServable();
        return this.catalogue.served();
    }

    /** One cell's bytes, from memory or decoded now. */
    async lookahead(request: VaultLookaheadRequest): Promise<VaultLookaheadResponse> {
        this.assertServable();
        const cells = this.catalogue.served();
        const signature = (items: VaultCellMeta[]) => JSON.stringify(items.map((c) => [c.cellId, c.contentSha256]));
        const before = signature(cells);
        const answer = await this.ahead.query(request, cells, (id) => this.cell(id));
        return signature(this.catalogue.served()) === before ? answer : { coverage: 'unavailable', danger: false };
    }

    async cell(cellId: string): Promise<{ bytes: Buffer; sha256: string }> {
        this.assertServable();
        const got = await this.vault.get(cellId);
        return { bytes: got.bytes, sha256: got.sha256 };
    }

    /** Look at the delivered sets again (a new o-charts install). Waits for a watch to end. */
    async rescan(cellIds?: string[]): Promise<VaultRescanWire> {
        if (this.watching !== false) {
            this.rescanPending = true;
            this.log.log('[vault] rescan asked for during a watch: new charts open in memory after it');
            return { queued: true, reason: 'watch' };
        }
        const before = this.snapshot();
        await this.queuePass();
        const after = this.snapshot();
        const ids = cellIds ?? [...new Set([...before.keys(), ...after.keys()])];
        const summary = { new: 0, updated: 0, unchanged: 0, total: ids.length };
        for (const id of ids) {
            const was = before.get(id);
            const now = after.get(id);
            if (!now) continue;
            if (!was) summary.new++;
            else if (was !== now) summary.updated++;
            else summary.unchanged++;
        }
        return { queued: false, summary };
    }

    async remove(cellId: string): Promise<boolean> {
        this.assertServable();
        const removed = await this.catalogue.remove(cellId);
        this.vault.evict(cellId);
        if (removed) this.log.log(`[vault] ${cellId} removed (its delivered file is kept)`);
        return removed;
    }

    /** thalassa-cache's fix and watch state. Positions are never logged. */
    hint(h: { lat?: unknown; lon?: unknown; watching?: unknown }): void {
        let turnedOffNow = false;
        if (typeof h.watching === 'boolean' && h.watching !== this.watching) {
            turnedOffNow = !h.watching;
            this.watching = h.watching;
            this.log.log(`[vault] watch ${h.watching ? 'on: index work waits' : 'off'}`);
            if (!h.watching) {
                for (const wake of this.watchWaiters.splice(0)) wake();
                if (this.rescanPending) {
                    this.rescanPending = false;
                    void this.queuePass();
                }
            }
        }
        const lat = Number(h.lat);
        const lon = Number(h.lon);
        const fixed = Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
        if (fixed) this.position = { lat, lon };
        // thalassa-cache says the watch state every 30 s: only a new fix, or a
        // watch just ended, is a reason to look at prewarm again.
        if (fixed || turnedOffNow) void this.prewarm();
    }

    async stop(): Promise<void> {
        this.stopped = true;
        if (this.retryTimer) clearTimeout(this.retryTimer);
        for (const wake of this.watchWaiters.splice(0)) wake();
        await this.chain.catch(() => undefined);
        await this.opts.onStop?.();
    }

    // ── internals ────────────────────────────────────────────────────────

    private state(): VaultState {
        // The decoder first: with the dongle out, a first index pass would
        // otherwise read as "starting" for good.
        if (this.decoderDown) return 'decoder-down';
        if (!this.catalogue.complete) return 'starting';
        return this.passRunning ? 'indexing' : 'ready';
    }

    private assertServable(): void {
        if (!this.catalogue.complete) {
            throw new VaultRefusal(
                'vault-starting',
                503,
                'The Pi is opening its charts in memory.',
                VAULT_LIMITS.retryAfterSeconds,
            );
        }
    }

    /** cellId → its served revision (hash), for a rescan's summary. */
    private snapshot(): Map<string, string> {
        return new Map(this.catalogue.servedEntries().map((e) => [e.cellId, e.contentSha256]));
    }

    private untilNotWatching(): Promise<void> {
        if (this.watching === false || this.stopped) return Promise.resolve();
        return new Promise((resolve) => this.watchWaiters.push(resolve));
    }

    private queuePass(): Promise<void> {
        const next = this.chain.then(() => this.runPass());
        this.chain = next.catch(() => undefined);
        return this.chain;
    }

    private async runPass(): Promise<void> {
        await this.untilNotWatching();
        if (this.stopped) return;
        const t0 = Date.now();
        this.passRunning = true;
        try {
            let scan: ScanResult;
            let entries: VaultFileEntry[];
            let fresh: VaultFileEntry[];
            let start = 0;
            const resume = this.resume;
            this.resume = null;
            // After the decoder went down: go on where the pass stopped, if the
            // delivered files are as they were (keys and arrival times only, no hashing).
            if (resume && (await this.catalogue.scan({ plan: false })).fingerprint === resume.scan.fingerprint) {
                ({ scan, entries, fresh } = resume);
                start = resume.next;
            } else {
                scan = await this.catalogue.scan({ plan: true });
                entries = [...scan.reused];
                fresh = [];
                this.opened = 0;
            }
            this.toOpen = scan.toOpen.length;
            let unreadable = 0;
            for (let i = start; i < scan.toOpen.length; i++) {
                const pending = scan.toOpen[i];
                await this.untilNotWatching();
                if (this.stopped) return;
                try {
                    const entry = await this.vault.runIndex(() => this.openFile(pending));
                    entries.push(entry);
                    fresh.push(entry);
                } catch (error) {
                    if (error instanceof DecoderDownError) {
                        this.decoderDown = true;
                        if (fresh.length > 0) await this.catalogue.checkpoint(fresh);
                        this.resume = { scan, entries, fresh, next: i };
                        this.scheduleRetry();
                        return;
                    }
                    if (!(error instanceof CellUnreadableError)) throw error;
                    unreadable++;
                    this.log.warn(`[vault] ${pending.cellId}: unreadable, left out of the index`);
                }
                this.opened++;
                if (this.opened % CHECKPOINT_EVERY === 0) {
                    await this.catalogue.checkpoint(fresh);
                    this.log.log(`[vault] opening charts in memory: ${this.opened} of ${this.toOpen}`);
                }
            }
            await this.catalogue.commit(entries, scan);
            this.passesDone++;
            this.retries = 0;
            this.log.log(
                `[vault] index ready: ${this.catalogue.servedEntries().length} cells (${scan.toOpen.length} opened, ${scan.reused.length} reused, ${unreadable} unreadable, ${scan.skippedSets.length} set(s) skipped) in ${Date.now() - t0} ms`,
            );
        } finally {
            this.passRunning = false;
            this.toOpen = this.decoderDown ? this.toOpen : 0;
            if (this.catalogue.complete && !this.decoderDown) for (const wake of this.readyWaiters.splice(0)) wake();
        }
        void this.prewarm();
    }

    /** The next pass after a decoder failure: 30 s, then doubling to 5 minutes. */
    private scheduleRetry(): void {
        if (this.stopped || this.retryTimer) return;
        const base = this.opts.passRetryMs ?? VAULT_LIMITS.passRetryMs;
        const max = this.opts.passRetryMaxMs ?? VAULT_LIMITS.restartBackoffMaxMs;
        const delay = Math.min(base * 2 ** this.retries, max);
        this.retries++;
        this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            void this.queuePass();
        }, delay);
        this.retryTimer.unref();
    }

    /** The decoder answered again (a phone's own cell): the waiting pass need not wait out its backoff. */
    private retryNow(): void {
        if (!this.retryTimer || this.stopped) return;
        clearTimeout(this.retryTimer);
        this.retryTimer = null;
        this.retries = 0;
        void this.queuePass();
    }

    private async openFile(pending: PendingFile): Promise<VaultFileEntry> {
        const decoded = await this.decrypted(pending.filePath, pending.installKey, pending);
        // Catalogue fields and the hash are kept; the cell itself is dropped here.
        return entryFromDecoded(pending, decoded.catalogue, decoded.sha256, this.schema);
    }

    private async decodeEntry(entry: VaultFileEntry): Promise<DecodedCell> {
        const key = this.catalogue.installKey(entry);
        if (!key) throw new CellUnreadableError(entry.cellId);
        return this.decrypted(`${entry.setDir}/${entry.fileName}`, key, {
            cellId: entry.cellId,
            sourceHO: entry.sourceHO,
            ...(entry.sourceCellId ? { sourceCellId: entry.sourceCellId } : {}),
        });
    }

    private async decrypted(
        filePath: string,
        installKey: string,
        target: { cellId: string; sourceHO: string; sourceCellId?: string },
    ): Promise<DecodedCell> {
        let senc: Buffer;
        try {
            senc = await this.opts.decrypt(filePath, installKey);
            if (senc.length === 0) throw new DecoderDownError();
        } catch (error) {
            if (error instanceof DecoderDownError) this.decoderDown = true;
            throw error instanceof VaultRefusal ? error : new DecoderDownError();
        }
        if (this.decoderDown) {
            this.decoderDown = false;
            this.log.log('[vault] decoder back');
            this.retryNow();
        }
        return decodeSenc(senc, target);
    }

    private async prewarm(): Promise<void> {
        if (this.prewarming || !this.position || this.watching !== false || !this.catalogue.complete) return;
        if (this.passRunning || this.decoderDown) return;
        this.prewarming = true;
        try {
            const budget = (this.opts.prewarmShare ?? VAULT_LIMITS.prewarmShare) * this.vault.capacity;
            const order = prewarmOrder(
                this.catalogue.servedEntries(),
                this.position,
                this.opts.prewarmRadiusNm ?? VAULT_LIMITS.prewarmRadiusNm,
            );
            let warmed = 0;
            for (const cellId of order) {
                if (this.vault.lruBytes >= budget || this.watching !== false || this.stopped) break;
                if (this.vault.cached(cellId)) continue;
                if (await this.vault.prewarm(cellId)) warmed++;
            }
            if (warmed > 0) this.log.log(`[vault] prewarmed ${warmed} cell(s) near the boat`);
        } finally {
            this.prewarming = false;
        }
    }
}
