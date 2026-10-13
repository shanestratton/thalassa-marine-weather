/**
 * Turning a delivered, encrypted .oesu into a cell, in the vault's RAM only
 * (127-C-d decisions 1 and 7). This module, and the senc engine it imports,
 * run in the thalassa-chart-vault process and nowhere else
 * (watchIsolation.test.mts keeps both out of the watch's process).
 *
 *   decrypt: oexserverd over its FIFOs (a FIFO is a kernel pipe: nothing it
 *            carries is stored), with the dongle
 *   decode:  parseSenc → emitCell → JSON.stringify({cells:[cell]}) → a Buffer
 *            and its SHA-256, exactly as decryptBatch's cellStoreRecord did, so
 *            the same .oesu and the same parser give the same contentSha256 the
 *            phone already holds.
 *
 * Logs carry cell ids, counts and milliseconds only, never content.
 */
import { createHash } from 'node:crypto';
import { OexserverdClient } from '../sencEngine/oexserverd.js';
import { parseSenc } from '../sencEngine/featureParser.js';
import { emitCell } from '../sencEngine/geojsonEmitter.js';
import { setS57ReferenceDir } from '../sencEngine/s57Classes.js';
import { VaultRefusal } from './chartVault.js';
import { VAULT_LIMITS } from './limits.js';

/** Read the two S-57 catalogue CSVs from here (the install's copy, /opt/thalassa-pi-cache/reference). */
export function setVaultS57Reference(dir: string): void {
    setS57ReferenceDir(dir);
}

export interface DecodeTarget {
    cellId: string;
    sourceHO: string;
    sourceCellId?: string;
}

/** The catalogue fields the index keeps of a decoded cell (decision 6): no feature, depth or name. */
export interface DecodedCatalogue {
    cellId: string;
    sourceCellId?: string;
    sourceHO: string;
    edition: number;
    updateNumber?: number;
    issued: string;
    bbox: [number, number, number, number];
    featureCount: number;
    sizeBytes: number;
    extractorSchema: number;
}

export interface DecodedCell {
    bytes: Buffer;
    sha256: string;
    catalogue: DecodedCatalogue;
}

export class DecoderDownError extends VaultRefusal {
    constructor(message = 'The chart decoder is not answering. Check the o-charts dongle is plugged into the Pi.') {
        super('vault-decoder-down', 503, message, 30);
        this.name = 'DecoderDownError';
    }
}

export class CellUnreadableError extends VaultRefusal {
    constructor(cellId: string) {
        super('vault-cell-unreadable', 502, `${cellId} could not be read from its delivered set.`);
        this.name = 'CellUnreadableError';
    }
}

/** Decrypted SENC bytes → the served cell and its catalogue. Throws CellUnreadableError. */
export function decodeSenc(senc: Buffer, target: DecodeTarget): DecodedCell {
    let cell;
    try {
        const { header, features } = parseSenc(senc);
        const extent = header.cellExtent;
        if (
            !header.sencVersion ||
            !Number.isSafeInteger(header.cellEdition) ||
            !extent ||
            !Object.values(extent).every(Number.isFinite) ||
            extent.wLon >= extent.eLon ||
            extent.sLat >= extent.nLat
        ) {
            throw new Error('no valid version, edition or extent');
        }
        cell = emitCell(header, features, {
            cellId: target.cellId,
            sourceHO: target.sourceHO,
            ...(target.sourceCellId ? { sourceCellId: target.sourceCellId } : {}),
        });
    } catch {
        throw new CellUnreadableError(target.cellId);
    }
    const bytes = Buffer.from(JSON.stringify({ cells: [cell] }), 'utf8');
    return {
        bytes,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        catalogue: {
            cellId: cell.cellId,
            ...(cell.sourceCellId ? { sourceCellId: cell.sourceCellId } : {}),
            sourceHO: cell.sourceHO,
            edition: cell.edition,
            ...(cell.updateNumber !== undefined ? { updateNumber: cell.updateNumber } : {}),
            issued: cell.issued,
            bbox: cell.bbox,
            featureCount: cell.stats?.emittedFeatures ?? 0,
            sizeBytes: bytes.length,
            extractorSchema: cell.extractorSchema ?? 1,
        },
    };
}

export interface OexDecoderOptions {
    binaryPath?: string;
    commandPipe?: string;
    readTimeoutMs?: number;
    startupTimeoutMs?: number;
    backoffMs?: number;
    backoffMaxMs?: number;
    now?: () => number;
    log?: Pick<Console, 'log' | 'warn'>;
}

/**
 * oexserverd, kept running and restarted with backoff. One decryption at a
 * time (the vault's queue guarantees it). An empty answer is what the daemon
 * gives with the dongle out: that, a timeout or a dead daemon each mark the
 * decoder down, stop the daemon, and refuse at once until the backoff ends;
 * the next decryption after it starts a fresh daemon (one that sees a dongle
 * plugged back in).
 */
export class OexDecoder {
    private client: OexserverdClient | null = null;
    private failures = 0;
    private retryAt = 0;
    private current: 'idle' | 'up' | 'down' = 'idle';
    private readonly now: () => number;
    private readonly log: Pick<Console, 'log' | 'warn'>;

    constructor(private readonly opts: OexDecoderOptions = {}) {
        this.now = opts.now ?? Date.now;
        this.log = opts.log ?? console;
    }

    state(): 'idle' | 'up' | 'down' {
        return this.current;
    }

    async decrypt(filePath: string, installKey: string): Promise<Buffer> {
        if (this.current === 'down' && this.now() < this.retryAt) throw new DecoderDownError();
        try {
            if (!this.client || this.client.daemonAlive() === false) {
                await this.reset();
                const client = new OexserverdClient({
                    binaryPath: this.opts.binaryPath,
                    commandPipe: this.opts.commandPipe,
                    readTimeoutMs: this.opts.readTimeoutMs ?? VAULT_LIMITS.readTimeoutMs,
                    startupTimeoutMs: this.opts.startupTimeoutMs ?? VAULT_LIMITS.daemonStartMs,
                });
                this.client = client;
                await client.start();
            }
            const senc = await this.client.decryptChart(filePath, installKey);
            if (senc.length === 0) throw new Error('empty answer');
            if (this.current !== 'up')
                this.log.log(`[vault] decoder up${this.failures ? ` after ${this.failures} failure(s)` : ''}`);
            this.current = 'up';
            this.failures = 0;
            return senc;
        } catch (error) {
            this.failures++;
            const wait = Math.min(
                (this.opts.backoffMs ?? VAULT_LIMITS.restartBackoffMs) * 2 ** (this.failures - 1),
                this.opts.backoffMaxMs ?? VAULT_LIMITS.restartBackoffMaxMs,
            );
            this.retryAt = this.now() + wait;
            this.current = 'down';
            // The reason is ours (empty answer, timeout, exit, ENOENT), never a key or a path.
            const reason = error instanceof Error ? error.message.replace(/\/\S+/g, '<path>') : 'error';
            this.log.warn(`[vault] decoder down (${reason}); next try in ${Math.round(wait / 1000)} s`);
            await this.reset();
            throw new DecoderDownError();
        }
    }

    /** Stop the daemon (CMD_EXIT, then SIGTERM) and drop the return FIFO. */
    async stop(): Promise<void> {
        await this.reset();
        if (this.current === 'up') this.current = 'idle';
    }

    private async reset(): Promise<void> {
        const client = this.client;
        this.client = null;
        if (client) await client.stop().catch(() => undefined);
    }
}
