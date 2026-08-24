/**
 * THE WORLD FLOOR — the wind tier the punter cannot pan off
 * (Shane 2026-08-24: "when a punter wants to move the world around, it is
 * ready to go... I don't want the punter having to wait to download something
 * that could have been downloaded in the background").
 *
 * The fine and synoptic warms anchor on the PUNTER, so a pan to the far side
 * of the world fell off both; the disjoint-view safety rightly refused to
 * paint Brisbane's wind over Indonesia, and the punter stared at a blank
 * field while a viewport fetch ran — the "blocky, nineties" feel. A grid
 * whose bounds are the whole world cannot be panned off: bestCoveringGrid
 * finds it for ANY viewport by construction, publishes instantly, and the
 * viewport fetch refines behind it exactly as fine-over-synoptic already did.
 *
 * The fix is not fetching faster. It is never having nothing.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { __windCacheForTest as cache, isFastLink } from '../services/weather/WindDataController';

const src = readFileSync('services/weather/WindDataController.ts', 'utf8');

/** The cache logic never inspects grid internals — a stub is honest here. */
const stubGrid = { width: 61, height: 29, totalHours: 24 } as never;

const WORLD = { north: 85, south: -85, west: -180, east: 180 };
const entry = (over: Record<string, unknown>) =>
    ({ grid: stubGrid, bounds: WORLD, res: 6, model: 'icon', fetchedAt: Date.now(), ...over }) as never;

beforeEach(() => cache.clear());
afterEach(() => {
    cache.clear();
    vi.unstubAllGlobals();
});

describe('coverage: nowhere on earth is off the floor', () => {
    it('covers an ordinary viewport on the far side of the world', () => {
        cache.seed(entry({}), true);
        // Newport punter pans to the North Atlantic for the 12-foot tinny's
        // crossing. The floor answers.
        const atlantic = { north: 55, south: 40, west: -45, east: -15 };
        expect(cache.bestCovering('icon' as never, atlantic)).not.toBeNull();
    });

    it('covers a Date-Line viewport — the wrap case boundsCover could not express', () => {
        // Fiji: west 175, east -175. The shift arithmetic normalises the
        // viewport 360° out of the world grid's continuous axis, so before
        // the wrap special-case this tested as NOT covered — a blank exactly
        // where a Pacific passage lives.
        cache.seed(entry({}), true);
        const fiji = { north: -12, south: -22, west: 175, east: -175 };
        expect(cache.bestCovering('icon' as never, fiji)).not.toBeNull();
    });

    it('refuses a stale floor — old wind shown as fresh is a hazard, not a feature', () => {
        cache.seed(entry({ fetchedAt: Date.now() - 4 * 60 * 60 * 1000 }), true);
        expect(cache.bestCovering('icon' as never, { north: 10, south: 0, west: 0, east: 10 })).toBeNull();
    });

    it('never serves one model’s floor to another', () => {
        cache.seed(entry({ model: 'icon' }), true);
        expect(cache.bestCovering('ecmwf' as never, { north: 10, south: 0, west: 0, east: 10 })).toBeNull();
    });
});

describe('precedence: the floor is a floor, not a ceiling', () => {
    it('loses to any finer covering grid', () => {
        cache.seed(entry({}), true);
        cache.seed(entry({ res: 0.25, bounds: { north: 5, south: -5, west: 0, east: 10 } }));
        const local = cache.bestCovering('icon' as never, { north: 2, south: -2, west: 2, east: 8 });
        expect((local as { res: number } | null)?.res).toBe(0.25);
    });

    it('loses a same-resolution tie to the fresher fetch', () => {
        // The GFS floor and a low-zoom viewport grid can both sit at 1.0° —
        // without the tie-break, which one painted depended on map iteration
        // order, which is no contract at all.
        const old = Date.now() - 60_000;
        cache.seed(entry({ res: 1.0, fetchedAt: old }), true);
        cache.seed(entry({ res: 1.0, bounds: { north: 40, south: -40, west: 100, east: 180 }, fetchedAt: Date.now() }));
        const got = cache.bestCovering('icon' as never, { north: 10, south: 0, west: 110, east: 120 });
        expect((got as { fetchedAt: number } | null)?.fetchedAt).toBeGreaterThan(old);
    });
});

describe('bounds: exempt from LRU, capped on its own terms', () => {
    it('survives cache pressure that evicts punter-tier grids', () => {
        cache.seed(entry({}), true);
        for (let i = 0; i < 8; i++) {
            cache.seed(
                entry({
                    res: 0.25 + i,
                    bounds: { north: i + 1, south: i, west: i, east: i + 1 },
                    fetchedAt: Date.now() + i,
                }),
            );
        }
        expect(cache.keys().some((k) => k.startsWith('world:'))).toBe(true);
        // ...and the LRU still did its job on the rest.
        expect(cache.keys().filter((k) => !k.startsWith('world:')).length).toBeLessThanOrEqual(4);
    });

    it('holds at most two floors — the exemption must not become unbounded', () => {
        cache.seed(entry({ model: 'icon', fetchedAt: 1000 }), true);
        cache.seed(entry({ model: 'ecmwf', fetchedAt: 2000 }), true);
        cache.seed(entry({ model: 'gfs', fetchedAt: 3000 }), true);
        const floors = cache.keys().filter((k) => k.startsWith('world:'));
        expect(floors).toHaveLength(2);
        expect(floors).not.toContain('world:icon'); // oldest went
    });

    it('is never serialized to disk', () => {
        // The GFS floor is ~19 MB of Float32. Serializing it just to have the
        // 512 KB persist cap discard the result would burn the main thread
        // inside the write-behind debounce — so floors are filtered out
        // BEFORE serializeEntry ever sees them.
        const persist = src.slice(src.indexOf('function schedulePersist'), src.indexOf('function storeCachedGrid'));
        expect(persist).toContain('!isWorldKey(key)');
    });
});

describe('link gating: speculation is for links that can afford it', () => {
    it('assumes fast when the API is absent — WKWebView, same call MapHub makes', () => {
        vi.stubGlobal('navigator', {});
        expect(isFastLink()).toBe(true);
    });

    it('refuses cellular and slow effective types', () => {
        vi.stubGlobal('navigator', { connection: { type: 'cellular', effectiveType: '4g' } });
        expect(isFastLink()).toBe(false);
        vi.stubGlobal('navigator', { connection: { type: 'wifi', effectiveType: '3g' } });
        expect(isFastLink()).toBe(false);
        vi.stubGlobal('navigator', { connection: { type: 'wifi', effectiveType: '4g' } });
        expect(isFastLink()).toBe(true);
    });

    it('gates the floor warm, and only the floor warm', () => {
        // The punter tiers are what the boat NEEDS — they warm on any link.
        // The floor is speculation about the rest of the planet.
        const floorFn = src.slice(src.indexOf('async function prefetchWorldFloor'), src.indexOf('* Monotonic fence'));
        expect(floorFn).toContain('if (!isFastLink()) return;');
        const fineFn = src.slice(
            src.indexOf('async function prefetchLocalFineGrid'),
            src.indexOf('async function prefetchSynopticGrid'),
        );
        expect(fineFn).not.toContain('isFastLink');
    });
});

describe('wiring: the floor actually gets built and used', () => {
    it('stores the GFS full-earth GRIB as the floor instead of throwing it away', () => {
        // Global mode already downloads the planet; the floor is the SAME
        // object under a world key — zero extra bytes, and a model switch no
        // longer discards it.
        expect(src).toContain('storeWorldFloor({');
        const gfsStore = src.slice(src.indexOf('A full-earth GRIB is the world floor'));
        expect(gfsStore.slice(0, 700)).toContain('res: 1.0');
    });

    it('consults the cache for EVERY model, not just the point-batch ones', () => {
        // The GFS path never checked the cache at all, so the covering-publish
        // that makes a world pan instant was unreachable in GFS passage mode.
        expect(src).toContain('const covering = bestCoveringGrid(model, currentBounds);');
        expect(src).not.toContain('useOpenMeteoGridded ? bestCoveringGrid');
    });

    it('warms the floor ONLY from the settled-camera path', () => {
        // One trigger on purpose. An activate-time warm raced the first
        // fetch for the network — violating this file's own rule that a
        // background download never competes with a field the punter is
        // waiting on. moveend suffices: MapHub's framing flight on every
        // wind toggle eases the camera, which fires moveend, which warms.
        const warmSites = [...src.matchAll(/void prefetchWorldFloor\(model\);/g)];
        expect(warmSites.length).toBe(1);
        const before = src.slice(0, src.indexOf('void prefetchWorldFloor(model);'));
        expect(before.lastIndexOf('registerMoveListener')).toBeGreaterThan(before.lastIndexOf('async activate'));
    });

    it('keys floors outside the resolution namespace', () => {
        // The viewport ladder bottoms out at 1.0° — the GFS floor's exact
        // resolution. One namespace and a low-zoom viewport grid silently
        // clobbers the floor it exists to refine.
        cache.seed(entry({ res: 1.0 }), true);
        cache.seed(entry({ res: 1.0, bounds: { north: 40, south: 30, west: 0, east: 10 } }));
        expect(cache.keys().filter((k) => k === 'world:icon' || k === '1.00')).toHaveLength(2);
    });
});
