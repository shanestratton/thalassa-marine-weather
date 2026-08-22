/**
 * Wind cannot be made fast by restructuring the request. Measured against
 * Open-Meteo directly on 2026-08-22: ~1.26 s for ONE point, 1.89 s for 32,
 * 1.61 s for the same 32 split 4-way in parallel, and our Supabase hop adds
 * only ~0.13 s. There is a ~1.2 s floor we do not own.
 *
 * So the memory grid cache — which already makes the second look at a patch of
 * water instant — survives a relaunch, and the first wind of a session paints
 * from disk while the refresh runs behind it.
 *
 * The safety-critical property is that persistence must not become a second,
 * looser opinion about freshness: a marine app showing three-hour-old wind as
 * current is a hazard, not a slow render.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
    clearWindGrids,
    deserializeEntry,
    loadWindGrids,
    saveWindGrids,
    serializeEntry,
    type PersistableEntry,
} from '../services/weather/windGridPersist';
import type { WindGrid } from '../services/weather/windGridEncoding';

const HOUR = 60 * 60 * 1000;

function grid(width = 4, height = 3, hours = 5, seed = 1): WindGrid {
    const cells = width * height;
    const make = (mul: number) =>
        Array.from({ length: hours }, (_, h) =>
            Float32Array.from({ length: cells }, (_v, i) => (i + h * 0.5 + seed) * mul),
        );
    return {
        u: make(1),
        v: make(-1),
        speed: make(2),
        width,
        height,
        lats: Array.from({ length: height }, (_v, i) => -27 + i * 0.25),
        lons: Array.from({ length: width }, (_v, i) => 153 + i * 0.25),
        north: -27,
        south: -27.5,
        east: 154,
        west: 153,
        totalHours: hours,
        refTime: '2026-08-22T00:00:00Z',
    };
}

function entry(over: Partial<PersistableEntry> = {}): PersistableEntry {
    return {
        grid: grid(),
        bounds: { north: -27, south: -27.5, east: 154, west: 153 },
        res: 0.25,
        model: 'ecmwf',
        fetchedAt: Date.now(),
        ...over,
    };
}

afterEach(() => clearWindGrids());

describe('wind grid persistence', () => {
    it('round-trips a grid without losing a single float', () => {
        const original = entry();
        const json = serializeEntry(original);
        expect(json).not.toBeNull();
        const back = deserializeEntry(json!);
        expect(back).not.toBeNull();
        expect(back!.grid.width).toBe(original.grid.width);
        expect(back!.grid.totalHours).toBe(original.grid.totalHours);
        expect(back!.res).toBe(0.25);
        expect(back!.grid.refTime).toBe('2026-08-22T00:00:00Z');
        // Exact float equality: base64 of the raw bytes, not a decimal
        // round-trip. A wind field quantised on the way to disk would drift
        // direction, which is worse than being slow.
        for (let h = 0; h < original.grid.totalHours; h += 1) {
            expect(Array.from(back!.grid.u[h])).toEqual(Array.from(original.grid.u[h]));
            expect(Array.from(back!.grid.v[h])).toEqual(Array.from(original.grid.v[h]));
            expect(Array.from(back!.grid.speed[h])).toEqual(Array.from(original.grid.speed[h]));
        }
    });

    it('applies the caller’s staleness window and never its own', () => {
        saveWindGrids([entry({ fetchedAt: Date.now() - 2 * HOUR })]);
        // Inside a 3 h window (what the memory cache uses) → usable.
        expect(loadWindGrids(3 * HOUR)).toHaveLength(1);
        // Outside a 1 h window → gone. Nothing may paint from disk that would
        // not already have painted from memory.
        expect(loadWindGrids(1 * HOUR)).toHaveLength(0);
    });

    it('refuses a sparse grid rather than writing zeros into the wind', () => {
        // WindGrid is shared with the CMEMS frame-on-demand path, whose frame
        // arrays are deliberately holey. Flattening one would store zeros for
        // undecoded frames — and zero wind reads as a dead calm, not as
        // missing data.
        const sparse = grid();
        (sparse.u as unknown as (Float32Array | undefined)[])[2] = undefined;
        expect(serializeEntry(entry({ grid: sparse }))).toBeNull();
    });

    it('rejects a truncated or corrupted payload instead of half-reading it', () => {
        expect(deserializeEntry('not json')).toBeNull();
        expect(deserializeEntry('{"w":4}')).toBeNull();
        const good = serializeEntry(entry())!;
        expect(deserializeEntry(good.slice(0, good.length - 40))).toBeNull();
    });

    it('always keeps the coarsest tier, even though it is always the oldest', () => {
        // THE BUG this replaces: a plain newest-first cut threw the synoptic
        // grid away every single time. It is warmed ONCE, early, so every
        // viewport fetch afterwards is newer — sorting by fetchedAt kept the
        // two most recent VIEWPORT grids and dropped the wide one, which is
        // precisely the tier that prevents a zoom-out blank. The in-memory
        // cache already exempts it; the disk cache was silently undoing that.
        const now = Date.now();
        saveWindGrids([
            entry({ res: 2.08, fetchedAt: now - 600_000 }), // synoptic: oldest by design
            entry({ res: 0.25, fetchedAt: now - 2000 }),
            entry({ res: 0.5, fetchedAt: now - 1000 }),
        ]);
        const loaded = loadWindGrids(3 * HOUR);
        expect(loaded.length).toBeLessThanOrEqual(2);
        const kept = loaded.map((e) => e.res).sort((a, b) => a - b);
        // Coarsest survives, plus the freshest fine tier for the local view.
        expect(kept).toEqual([0.5, 2.08]);
    });

    it('still bounds the write when every tier is the same resolution', () => {
        const now = Date.now();
        saveWindGrids([
            entry({ res: 0.25, fetchedAt: now - 3000 }),
            entry({ res: 0.25, fetchedAt: now - 2000 }),
            entry({ res: 0.25, fetchedAt: now - 1000 }),
        ]);
        expect(loadWindGrids(3 * HOUR).length).toBeLessThanOrEqual(2);
    });

    it('survives a storage failure without breaking wind', () => {
        const original = Storage.prototype.setItem;
        Storage.prototype.setItem = () => {
            throw new Error('QuotaExceededError');
        };
        try {
            // A full quota costs a slower first paint next launch, nothing more.
            expect(() => saveWindGrids([entry()])).not.toThrow();
        } finally {
            Storage.prototype.setItem = original;
        }
    });
});
