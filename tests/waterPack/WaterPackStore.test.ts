/**
 * The offline water pack's store (Phase 2b, 2026-10-01), on an in-memory
 * Filesystem. The rules that keep a good pack good:
 *
 *   R1  an all-empty overlay never replaces a tile that has features — an
 *       empty reply is what a failure used to look like;
 *   R2  an unverified source (a pre-2b Pi, the Pi's stale copy, an old disk
 *       copy) only fills tiles the pack does not have;
 *   R3  a verified source (the Pi fresh or cached, the cloud) replaces — and
 *       when the content is unchanged only the dates move, with no file write.
 *
 * Synthetic squares only; no real chart or OSM data.
 */
import type { Feature } from 'geojson';
import { beforeEach, describe, expect, it } from 'vitest';
import { createMemoryFilesystem, type MemoryFilesystem } from '../helpers/memoryFilesystem';
import { packIndexOnDisk, savedIndex } from '../helpers/waterPackIndex';
import {
    WATER_PACK_DIR,
    WATER_PACK_LIMITS,
    WaterPackStore,
    type WaterPackFillOptions,
} from '../../services/waterPack/WaterPackStore';
import { emptyPackOverlay, tileBounds, type Bbox, type PackOverlay } from '../../services/waterPack/waterPackTiles';

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 8, 28, 2);

const square = (w: number, s: number, e: number, n: number, props: Record<string, unknown> = {}): Feature => ({
    type: 'Feature',
    properties: props,
    geometry: {
        type: 'Polygon',
        coordinates: [
            [
                [w, s],
                [e, s],
                [e, n],
                [w, n],
                [w, s],
            ],
        ],
    },
});
/** A small water square in the middle of a tile. */
const waterIn = (tileKey: string, props: Record<string, unknown> = {}): Feature => {
    const [w, s] = tileBounds(tileKey);
    return square(w + 0.02, s + 0.02, w + 0.03, s + 0.03, { natural: 'water', ...props });
};
const overlay = (water: Feature[] = [], reef: Feature[] = []): PackOverlay => {
    const o = emptyPackOverlay();
    o.water.features = water;
    o.reef.features = reef;
    return o;
};
/** The 2×2 tiles round the Newport canal, fetched with the 0.01° margin. */
const NEWPORT_FETCH: Bbox = [153.04, -27.26, 153.16, -27.14];
const A = '3061_-545';
const B = '3062_-545';

let fs: MemoryFilesystem;
let clock: number;
const newStore = (limits: Partial<typeof WATER_PACK_LIMITS> = {}) =>
    new WaterPackStore({ fs, now: () => clock, tick: async () => undefined, flushDelayMs: 0, limits });
const verified = (over: Partial<WaterPackFillOptions> = {}): WaterPackFillOptions => ({
    source: 'cloud',
    verified: true,
    fetchedAt: clock,
    ...over,
});
const tileWrites = () => fs.count('writeFile', `${WATER_PACK_DIR}/t/`);
const fileOf = (key: string) => fs.files.get(`DATA/${WATER_PACK_DIR}/t/${key}.json`)?.data;

beforeEach(() => {
    clock = T0;
    fs = createMemoryFilesystem(() => clock);
});

describe('fills', () => {
    it('saves whole tiles from a complete overlay, the empty ones in the index only', async () => {
        const store = newStore();
        await store.fillFromOverlay(overlay([waterIn(A)]), NEWPORT_FETCH, verified());
        await store.whenIdle();
        const entries = await savedIndex(store, fs);
        expect([...entries.keys()].sort()).toEqual(['3061_-544', '3061_-545', '3062_-544', '3062_-545']);
        expect(entries.get(A)).toMatchObject({ fetchedAt: T0, savedAt: T0, source: 'cloud', verified: true });
        expect(entries.get(A)!.bytes).toBeGreaterThan(0);
        expect(entries.get(B)!.bytes).toBe(0);
        expect(tileWrites()).toBe(1);
        const file = JSON.parse(fileOf(A)!);
        expect(file).toMatchObject({ schema: 1, recipe: 'osm-v6', key: A, fetchedAt: T0, source: 'cloud' });
        expect(file.overlay.water.features).toHaveLength(1);
        const read = await store.readTiles([A, B, '3063_-545']);
        expect([...read.tiles.keys()].sort()).toEqual([A, B]);
        expect(read.tiles.get(A)!.water.features).toHaveLength(1);
    });

    it('R1: an all-empty overlay never replaces a tile that has features', async () => {
        const store = newStore();
        await store.fillFromOverlay(overlay([waterIn(A)]), NEWPORT_FETCH, verified());
        await store.whenIdle();
        const before = fileOf(A);
        clock += DAY;
        await store.fillFromOverlay(overlay(), NEWPORT_FETCH, verified());
        await store.whenIdle();
        expect(fileOf(A)).toBe(before);
        expect((await store.readTiles([A])).tiles.get(A)!.water.features).toHaveLength(1);
        expect((await savedIndex(store, fs)).get(A)!.fetchedAt).toBe(T0);
    });

    it('R2: an unverified fill only adds tiles the pack does not have', async () => {
        const store = newStore();
        await store.fillFromOverlay(overlay([waterIn(A)]), [153.04, -27.26, 153.11, -27.19], verified());
        await store.whenIdle();
        expect((await savedIndex(store, fs)).has(B)).toBe(false);
        const before = fileOf(A);
        clock += DAY;
        await store.fillFromOverlay(
            overlay([waterIn(A, { name: 'changed' }), waterIn(B)]),
            NEWPORT_FETCH,
            verified({ source: 'pi-stale', verified: false }),
        );
        await store.whenIdle();
        expect(fileOf(A)).toBe(before);
        const entries = await savedIndex(store, fs);
        expect(entries.get(A)!.source).toBe('cloud');
        expect(entries.get(B)).toMatchObject({ source: 'pi-stale', verified: false });
        expect((await store.readTiles([B])).tiles.get(B)!.water.features).toHaveLength(1);
    });

    it('R3: a verified fill replaces; the same content again only moves the dates, with no file write', async () => {
        const store = newStore();
        await store.fillFromOverlay(overlay([waterIn(A)]), NEWPORT_FETCH, verified());
        await store.whenIdle();
        clock += DAY;
        await store.fillFromOverlay(overlay([waterIn(A, { name: 'Hawk Canal' })]), NEWPORT_FETCH, verified());
        await store.whenIdle();
        expect(JSON.parse(fileOf(A)!).overlay.water.features[0].properties.name).toBe('Hawk Canal');
        const writes = tileWrites();
        clock += DAY;
        await store.fillFromOverlay(
            overlay([waterIn(A, { name: 'Hawk Canal' })]),
            NEWPORT_FETCH,
            verified({ source: 'pi' }),
        );
        await store.whenIdle();
        expect(tileWrites()).toBe(writes);
        expect((await savedIndex(store, fs)).get(A)).toMatchObject({ fetchedAt: T0 + 2 * DAY, source: 'pi' });
    });

    it('a verified fill older than the saved tile does not replace it', async () => {
        const store = newStore();
        await store.fillFromOverlay(overlay([waterIn(A, { v: 2 })]), NEWPORT_FETCH, verified());
        await store.whenIdle();
        const before = fileOf(A);
        await store.fillFromOverlay(
            overlay([waterIn(A, { v: 1 })]),
            NEWPORT_FETCH,
            verified({ source: 'pi', fetchedAt: T0 - 5 * DAY }),
        );
        await store.whenIdle();
        expect(fileOf(A)).toBe(before);
    });

    it('skips a tile over the per-tile cap', async () => {
        const store = newStore({ maxTileBytes: 200 });
        await store.fillFromOverlay(overlay([waterIn(A)]), NEWPORT_FETCH, verified());
        await store.whenIdle();
        expect((await savedIndex(store, fs)).has(A)).toBe(false);
        expect((await savedIndex(store, fs)).get(B)!.bytes).toBe(0);
    });

    it('writes at most 150 tile files per fill, nearest the focus first', async () => {
        expect(WATER_PACK_LIMITS.maxWritesPerFill).toBe(150);
        const store = newStore();
        // 20 × 10 tiles, each with its own water square.
        const features: Feature[] = [];
        for (let x = 0; x < 20; x++) for (let y = 0; y < 10; y++) features.push(waterIn(`${3000 + x}_${-560 + y}`));
        const fetched: Bbox = [3000 / 20 - 0.01, -560 / 20 - 0.01, 3020 / 20 + 0.01, -550 / 20 + 0.01];
        const focus = { lat: -560 / 20 + 0.025, lon: 3000 / 20 + 0.025 };
        await store.fillFromOverlay(overlay(features), fetched, verified({ focus: [focus] }));
        await store.whenIdle();
        expect(tileWrites()).toBe(150);
        const entries = await savedIndex(store, fs);
        expect(entries.has('3000_-560')).toBe(true);
        expect(entries.has('3019_-551')).toBe(false);
    });
});

describe('reads', () => {
    it('a corrupt or missing tile file counts as absent and leaves the index', async () => {
        const store = newStore();
        await store.fillFromOverlay(overlay([waterIn(A), waterIn(B)]), NEWPORT_FETCH, verified());
        await store.whenIdle();
        fs.files.set(`DATA/${WATER_PACK_DIR}/t/${A}.json`, { data: '{"schema":1,"overl', mtime: clock });
        fs.files.delete(`DATA/${WATER_PACK_DIR}/t/${B}.json`);
        const read = await store.readTiles([A, B]);
        expect(read.tiles.has(A)).toBe(false);
        expect(read.tiles.has(B)).toBe(false);
        const entries = await savedIndex(store, fs);
        expect(entries.has(A)).toBe(false);
        expect(entries.has(B)).toBe(false);
    });

    it('bumps lastUsedAt at most daily', async () => {
        const store = newStore();
        await store.fillFromOverlay(overlay([waterIn(A)]), NEWPORT_FETCH, verified());
        await store.whenIdle();
        clock += 3_600_000;
        await store.readTiles([A]);
        expect((await savedIndex(store, fs)).get(A)!.lastUsedAt).toBe(T0);
        clock += 2 * DAY;
        await store.readTiles([A]);
        expect((await savedIndex(store, fs)).get(A)!.lastUsedAt).toBe(clock);
    });

    it('the index survives a reload', async () => {
        const first = newStore();
        await first.fillFromOverlay(overlay([waterIn(A)]), NEWPORT_FETCH, verified());
        await first.whenIdle();
        const second = newStore();
        const read = await second.readTiles(['3061_-544', A, '3062_-544', B]);
        expect(read.entries.size).toBe(4);
        expect(read.tiles.get(A)!.water.features).toHaveLength(1);
        expect(read.entries.get(A)).toMatchObject({ fetchedAt: T0, verified: true });
        expect(read.entries.get(B)!.bytes).toBe(0);
    });

    it('an unreadable index is an empty pack, not a crash', async () => {
        fs.files.set(`DATA/${WATER_PACK_DIR}/index.json`, { data: 'not json', mtime: clock });
        const store = newStore();
        expect((await store.readTiles([A])).tiles.size).toBe(0);
        expect((await savedIndex(store, fs)).size).toBe(0);
    });
});

describe('eviction', () => {
    it('evicts least-recently-used tiles to under the cap, never the current fill', async () => {
        const store = newStore({ maxBytes: 2_500, evictToBytes: 1_800 });
        const keys = ['3061_-545', '3062_-545', '3063_-545', '3064_-545', '3065_-545', '3066_-545'];
        for (const [i, k] of keys.entries()) {
            clock = T0 + i * DAY;
            const [w, s, e, n] = tileBounds(k);
            await store.fillFromOverlay(overlay([waterIn(k)]), [w - 0.01, s - 0.01, e + 0.01, n + 0.01], verified());
            await store.whenIdle();
        }
        const entries = await savedIndex(store, fs);
        expect([...entries.values()].reduce((sum, e) => sum + e.bytes, 0)).toBeLessThanOrEqual(2_500);
        // The newest fill always stays; the oldest went first.
        expect(entries.has('3066_-545')).toBe(true);
        expect(entries.has('3061_-545')).toBe(false);
        expect(fileOf('3061_-545')).toBeUndefined();

        // A single fill bigger than the cap keeps all of itself.
        const big = newStore({ maxBytes: 300, evictToBytes: 200 });
        fs.reset();
        await big.fillFromOverlay(overlay([waterIn(A), waterIn(B)]), NEWPORT_FETCH, verified());
        await big.whenIdle();
        const all = await savedIndex(big, fs);
        expect(all.get(A)!.bytes).toBeGreaterThan(0);
        expect(all.get(B)!.bytes).toBeGreaterThan(0);
    });
});

// Before 2b the phone kept one osm-overlay/<rounded bbox>.json per route bbox
// and read it back offline — only for that exact bbox. 2b reads the pack
// instead, so those copies are imported once (non-empty only: an empty one
// may be the old Pi's failure written over a good copy), dated by the file's
// mtime, unverified — they only fill tiles the pack lacks. Since 2026-10-02
// the files are deleted once the index holding their water is on disk.
describe('the one-time import of the old disk copies', () => {
    const LEGACY = 'DATA/osm-overlay';
    const legacy = (name: string, body: unknown, mtime: number) =>
        fs.files.set(`${LEGACY}/${name}`, { data: typeof body === 'string' ? body : JSON.stringify(body), mtime });

    it('imports non-empty copies once, unverified, dated by their mtime', async () => {
        const OLD = T0 - 60 * DAY;
        // Key [153.00, -27.30, 153.20, -27.10]: shrunk 0.01° for the old
        // rounding, then the fill's own margin, it holds the four Newport tiles.
        legacy('153.00_-27.30_153.20_-27.10.json', overlay([waterIn(A), waterIn(B)]), OLD);
        legacy('153.30_-27.30_153.50_-27.10.json', overlay(), OLD);
        legacy('notes.txt', 'hello', OLD);
        const store = newStore();
        const read = await store.readTiles([A, B]);
        expect(read.tiles.get(A)!.water.features).toHaveLength(1);
        expect(read.entries.get(A)).toMatchObject({ source: 'legacy-disk', verified: false, fetchedAt: OLD });
        expect([...(await savedIndex(store, fs)).keys()].some((k) => k.startsWith('3066_'))).toBe(false);

        // Once: a reload does not read the old directory again.
        const reads = fs.count('readdir');
        await newStore().readTiles([A]);
        expect(fs.count('readdir')).toBe(reads);
    });

    it('never replaces a tile the pack already has', async () => {
        const store = newStore();
        await store.fillFromOverlay(overlay([waterIn(A, { v: 'pack' })]), NEWPORT_FETCH, verified());
        await store.whenIdle();
        // The import ran (and found nothing) on that first load; a fresh
        // pack directory with an old copy shows the rule on its own.
        fs.reset();
        legacy('153.00_-27.30_153.20_-27.10.json', overlay([waterIn(A, { v: 'old' })]), T0 - DAY);
        const pack = newStore();
        await pack.fillFromOverlay(overlay([waterIn(A, { v: 'pack' })]), NEWPORT_FETCH, verified());
        await pack.whenIdle();
        const tile = (await pack.readTiles([A])).tiles.get(A)!;
        expect(tile.water.features[0].properties?.v).toBe('pack');
    });
});

// ── Fix-up, 2026-10-02 ───────────────────────────────────────────────

describe('what an unverified or empty answer may save', () => {
    it('an unverified fill saves only tiles with features — never an empty tile it cannot vouch for', async () => {
        // A pre-2b Pi caches Overpass replies cut short (a remark, partial
        // elements) for a week: a tile whose features fell after the cut
        // would read "nothing here", and water from a whole neighbour would
        // then pass the enabling rule into it.
        const store = newStore();
        await store.fillFromOverlay(
            overlay([waterIn(A)]),
            NEWPORT_FETCH,
            verified({ source: 'pi-legacy', verified: false }),
        );
        const entries = await savedIndex(store, fs);
        expect([...entries.keys()]).toEqual([A]);
        expect(entries.get(A)).toMatchObject({ source: 'pi-legacy', verified: false });
    });

    it('an all-empty overlay saves nothing, verified or not', async () => {
        const store = newStore();
        await store.fillFromOverlay(overlay(), NEWPORT_FETCH, verified());
        await store.fillFromOverlay(overlay(), NEWPORT_FETCH, verified({ source: 'pi-stale', verified: false }));
        expect((await savedIndex(store, fs)).size).toBe(0);
        expect(tileWrites()).toBe(0);
    });

    it('a verified answer with features still saves its empty tiles (index only)', async () => {
        const store = newStore();
        await store.fillFromOverlay(overlay([waterIn(A)]), NEWPORT_FETCH, verified());
        const entries = await savedIndex(store, fs);
        expect(entries.size).toBe(4);
        expect(entries.get(B)).toMatchObject({ bytes: 0, verified: true });
    });
});

describe('the index is written whole or not at all', () => {
    const INDEX = `DATA/${WATER_PACK_DIR}/index.json`;
    const TMP = `${INDEX}.tmp`;

    it('is written to a temporary file and renamed over the old one', async () => {
        const store = newStore();
        await store.fillFromOverlay(overlay([waterIn(A)]), NEWPORT_FETCH, verified());
        await store.whenIdle();
        expect(fs.count('rename')).toBeGreaterThan(0);
        expect(fs.files.has(TMP)).toBe(false);
        expect(packIndexOnDisk(fs).size).toBe(4);
    });

    it('a kill between the write and the rename: the next load reads the temporary copy', async () => {
        const store = newStore();
        await store.fillFromOverlay(overlay([waterIn(A)]), NEWPORT_FETCH, verified());
        await store.whenIdle();
        // index.json lost mid-swap; its complete replacement still waiting.
        fs.files.set(TMP, fs.files.get(INDEX)!);
        fs.files.delete(INDEX);
        const again = newStore();
        expect((await again.readTiles([A])).tiles.get(A)!.water.features).toHaveLength(1);
    });

    it('an index that cannot be read: tile files it named are swept, not orphaned', async () => {
        const store = newStore();
        await store.fillFromOverlay(overlay([waterIn(A), waterIn(B)]), NEWPORT_FETCH, verified());
        await store.whenIdle();
        expect(fileOf(A)).toBeDefined();
        fs.files.set(INDEX, { data: '{"schema":1,"tiles":{"3061_-5', mtime: clock });
        const again = newStore();
        expect((await again.readTiles([A, B])).tiles.size).toBe(0);
        await again.whenIdle();
        expect(fileOf(A)).toBeUndefined();
        expect(fileOf(B)).toBeUndefined();
        // …and the pack fills again from scratch.
        await again.fillFromOverlay(overlay([waterIn(A)]), NEWPORT_FETCH, verified());
        expect((await again.readTiles([A])).tiles.get(A)!.water.features).toHaveLength(1);
    });
});

describe('the old disk copies, 2026-10-02', () => {
    const LEGACY = 'DATA/osm-overlay';
    const legacy = (name: string, body: unknown, mtime: number) =>
        fs.files.set(`${LEGACY}/${name}`, { data: typeof body === 'string' ? body : JSON.stringify(body), mtime });

    it('a copy without every class is not imported: "no berths key" is not "no berths here"', async () => {
        // Copies written 2026-07-03 to 07-05 predate berths.
        const noBerths: Record<string, unknown> = { ...overlay([waterIn(A)]) };
        delete noBerths.berths;
        legacy('153.00_-27.30_153.20_-27.10.json', noBerths, T0 - 90 * DAY);
        const store = newStore();
        expect((await store.readTiles([A])).tiles.size).toBe(0);
    });

    it('each copy is deleted once the index holding its water is on disk; nothing else in the folder is', async () => {
        legacy('153.00_-27.30_153.20_-27.10.json', overlay([waterIn(A)]), T0 - DAY);
        legacy('153.30_-27.30_153.50_-27.10.json', overlay(), T0 - DAY);
        legacy('notes.txt', 'hello', T0 - DAY);
        const store = newStore();
        expect((await store.readTiles([A])).tiles.get(A)!.water.features).toHaveLength(1);
        await store.whenIdle();
        expect(fs.files.has(`${LEGACY}/153.00_-27.30_153.20_-27.10.json`)).toBe(false);
        expect(fs.files.has(`${LEGACY}/153.30_-27.30_153.50_-27.10.json`)).toBe(false);
        expect(fs.files.has(`${LEGACY}/notes.txt`)).toBe(true);
        expect(packIndexOnDisk(fs).get(A)).toMatchObject({ source: 'legacy-disk' });
    });
});
