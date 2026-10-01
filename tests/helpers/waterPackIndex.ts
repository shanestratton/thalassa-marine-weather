/**
 * The water pack's index as it is on disk (2026-10-02): what a test reads
 * instead of a store method only tests would call. Flushes the store first.
 */
import type { MemoryFilesystem } from './memoryFilesystem';
import { WATER_PACK_DIR, type WaterPackStore } from '../../services/waterPack/WaterPackStore';

export interface SavedTileEntry {
    fetchedAt: number;
    savedAt: number;
    lastUsedAt: number;
    source: string;
    verified: boolean;
    /** 0 = an empty tile, held in the index only. */
    bytes: number;
}

/** The index file's tiles, decoded; empty when there is no index yet. */
export function packIndexOnDisk(fs: MemoryFilesystem): Map<string, SavedTileEntry> {
    const out = new Map<string, SavedTileEntry>();
    const file = fs.files.get(`DATA/${WATER_PACK_DIR}/index.json`);
    if (!file) return out;
    const parsed = JSON.parse(file.data) as {
        tiles?: Record<string, { f: number; s: number; u: number; o: string; v: 0 | 1; b?: number }>;
    };
    for (const [key, e] of Object.entries(parsed.tiles ?? {}))
        out.set(key, {
            fetchedAt: e.f,
            savedAt: e.s,
            lastUsedAt: e.u,
            source: e.o,
            verified: e.v === 1,
            bytes: e.b ?? 0,
        });
    return out;
}

/** Every queued write done, then the index as saved. */
export async function savedIndex(store: WaterPackStore, fs: MemoryFilesystem): Promise<Map<string, SavedTileEntry>> {
    await store.whenIdle();
    return packIndexOnDisk(fs);
}
