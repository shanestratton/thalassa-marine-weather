/**
 * boatCellVault — licensed chart cells, held in this phone's memory only
 * (127-C-c decision 2).
 *
 * o-charts (Roberto, 2026-10-10): "Storing unencrypted data on any medium,
 * and especially in the cloud, is strictly prohibited by the terms of the
 * licenses signed with the chart providers." So a protected cell's text lives
 * here and nowhere else on the phone: an LRU of gzip-compressed text, bounded
 * by bytes, gone at relaunch. The boat's Pi refills it over the boat's Wi-Fi
 * (piCellSync). The parse cache (EncCellStore L1) stays in front of it.
 *
 * 40 MiB of gzip is a few hundred MB of cell text: a whole merge window
 * (≤ 32 MB), a route corridor and the launch prewarm, so L1 can evict freely
 * (16 MB while plotting) without a Pi round trip. Without CompressionStream
 * the text is held plain under a 96 MiB budget. At least 16 cells always stay.
 */
import { createLogger } from '../../utils/createLogger';
import { encCellStorageIdentity } from './types';

const log = createLogger('boatCellVault');

/** The Roberto switch: false makes the registry and the vault refuse protected cells. */
export const BOAT_CELLS_ON_PHONE = true;

const MiB = 1024 * 1024;
export const VAULT_MAX_STORED_BYTES = 40 * MiB;
const VAULT_TEXT_ONLY_BYTES = 96 * MiB;
export const VAULT_MIN_KEEP = 16;
/** What a cell is charged while its gzip is still running: cell JSON shrinks well past 6×. */
const GZIP_ESTIMATE = 6;

interface Entry {
    /** The text, until its compression lands (or for good without CompressionStream). */
    text: string | null;
    gz: ArrayBuffer | null;
    stored: number;
    textBytes: number;
}

const entries = new Map<string, Entry>();
const pending = new Set<Promise<void>>();
let stored = 0;
let puts = 0;
let probed = false;

const canGzip = (): boolean => typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';

export const budgetBytes = (): number => (canGzip() ? VAULT_MAX_STORED_BYTES : VAULT_TEXT_ONLY_BYTES);

const pipe = (body: BodyInit, stream: CompressionStream | DecompressionStream) =>
    new Response(new Response(body).body!.pipeThrough(stream));

function evict(budget: number, minKeep: number): void {
    for (const [key] of entries) {
        if (stored <= budget || entries.size <= minKeep) break;
        drop(key);
    }
}

/** Hold a protected cell's text. Replaces any earlier copy. */
export function put(cellId: string, text: string): void {
    if (!BOAT_CELLS_ON_PHONE) throw new Error('Licensed charts stay on the boat’s Pi in this build.');
    const key = encCellStorageIdentity(cellId);
    drop(key);
    const gzip = canGzip();
    // Charged an estimate until its gzip lands, so one multi-MB put does not
    // evict several MB of cells already compressed (the 127-C-c review).
    const entry: Entry = {
        text,
        gz: null,
        stored: gzip ? Math.ceil(text.length / GZIP_ESTIMATE) : text.length,
        textBytes: text.length,
    };
    entries.set(key, entry);
    stored += entry.stored;
    if (gzip) {
        const settle = (next: Partial<Entry> & { stored: number }): void => {
            if (entries.get(key) !== entry) return;
            stored += next.stored - entry.stored;
            Object.assign(entry, next);
            evict(budgetBytes(), VAULT_MIN_KEEP);
        };
        const job = pipe(text, new CompressionStream('gzip'))
            .arrayBuffer()
            .then(
                (gz) => settle({ gz, text: null, stored: gz.byteLength }),
                // No gzip after all: the text stays, at its full length.
                () => settle({ stored: text.length }),
            )
            .finally(() => pending.delete(job));
        pending.add(job);
    }
    evict(budgetBytes(), VAULT_MIN_KEEP);
    if (!probed) {
        probed = true;
        void import('../memoryCensus')
            .then(({ registerCensusProbe }) => registerCensusProbe('encVaultMB', () => Math.round(stored / MiB)))
            .catch(() => undefined);
    }
    if (++puts % 50 === 0) logStats();
}

/** The cell's text, or null when the vault does not hold it. A read keeps it longest. */
export async function getText(cellId: string): Promise<string | null> {
    const key = encCellStorageIdentity(cellId);
    const entry = entries.get(key);
    if (!entry) return null;
    entries.delete(key);
    entries.set(key, entry);
    if (entry.text !== null) return entry.text;
    try {
        return await pipe(entry.gz!, new DecompressionStream('gzip')).text();
    } catch {
        drop(key);
        return null;
    }
}

export const has = (cellId: string): boolean => entries.has(encCellStorageIdentity(cellId));

export function drop(cellId: string): void {
    const key = encCellStorageIdentity(cellId);
    const entry = entries.get(key);
    if (!entry) return;
    stored -= entry.stored;
    entries.delete(key);
}

export function clear(): void {
    entries.clear();
    stored = 0;
}

/** Give memory back (an iOS memory warning): keep at most `fraction` of what is stored, oldest out first. */
export function trim(fraction: number): void {
    evict(stored * fraction, 0);
}

export function stats(): { cells: number; storedBytes: number; textBytes: number } {
    let textBytes = 0;
    for (const entry of entries.values()) textBytes += entry.textBytes;
    return { cells: entries.size, storedBytes: stored, textBytes };
}

/** warn, not info (info is silent in production): the device smoke reads it. */
export function logStats(): void {
    const s = stats();
    log.warn(
        `vault: ${s.cells} cells, ${(s.storedBytes / MiB).toFixed(1)} MB stored, ${(s.textBytes / MiB).toFixed(1)} MB text`,
    );
}

/** Resolves once every compression started so far has landed (tests, census). */
export async function whenCompressed(): Promise<void> {
    while (pending.size) await Promise.all([...pending]);
}
