/**
 * The tile cache is the memory nothing in this app could see.
 *
 * Shane's plan page died 44 times on one install, always at Lady Musgrave,
 * always unattended. Every previous round chased the ENC merge pipeline; by
 * 2026-08-23 that pipeline was demonstrably quiet at the moment of death —
 * the flight trail's last crumb was a completed merge, the census read
 * heap 220 MB of a 4192 MB limit, and 40+ seconds of nothing followed.
 *
 * Then he named the trigger: "at zoom 9, no issues, but at zoom 14 it
 * crashes — that is when it goes to proper satellite imagery."
 *
 * maxTileCacheSize is retained tiles PER SOURCE, the style carries ~20 live
 * sources, and an @2x 512 imagery tile decodes to a 1024×1024 RGBA texture
 * (~4 MB). Phones were cut 60 → 20 for exactly this on 2026-08-21; web was
 * left at 60 on the assumption desktop has a looser ceiling. It does not.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { desktopTileCacheSize } from '../components/map/useMapInit';
import { countMapTiles, registerCensusMap } from '../services/memoryCensus';

const el = (w: number, h: number) => ({ clientWidth: w, clientHeight: h }) as HTMLElement;

describe('desktopTileCacheSize', () => {
    it('covers the visible grid plus a screen of pan-back margin', () => {
        // 1512×850 MacBook: ceil(1512/512)+1 = 4 across, ceil(850/512)+1 = 3
        // down → 12 visible, doubled for margin.
        expect(desktopTileCacheSize(el(1512, 850))).toBe(24);
    });

    it('never drops below the phone budget, however small the window', () => {
        // A narrow window must not starve the cache into constant refetching.
        expect(desktopTileCacheSize(el(320, 400))).toBe(20);
    });

    it('caps a large monitor rather than scaling with it', () => {
        // 2560×1440 derives 48; past ~28 the retention is speculation, and
        // speculation across ~20 sources is what pins the textures that kill
        // the renderer. Two @2x imagery sources at 28 tiles is ~224 MB — at
        // the old flat 60 it was ~480 MB.
        expect(desktopTileCacheSize(el(2560, 1440))).toBe(28);
        expect(desktopTileCacheSize(el(5120, 2880))).toBe(28);
    });

    it('falls back to a sane number with no container', () => {
        const n = desktopTileCacheSize(null);
        expect(n).toBeGreaterThanOrEqual(20);
        expect(n).toBeLessThanOrEqual(28);
    });

    it('is what the map is actually constructed with on web', () => {
        // The derivation is worthless if the option still reads a constant.
        const src = readFileSync('components/map/useMapInit.ts', 'utf8');
        expect(src).toContain(
            'maxTileCacheSize: Capacitor.isNativePlatform() ? 20 : desktopTileCacheSize(containerRef.current)',
        );
    });
});

describe('the census can actually see tiles', () => {
    // BEHAVIOURAL, not source-substring. The first version of this instrument
    // passed a green suite while being unconditionally blind in production —
    // it read window.__thalassaMap, which useMapInit only assigns under
    // `if (import.meta.env.DEV)` and Vite eliminates. Source assertions cannot
    // catch that class of failure; a fake map can.
    const tex = (w: number, h: number, useMipmap = true) => ({ texture: { size: [w, h], useMipmap } });

    /**
     * A mapbox-gl 3.19 style, modelled on Style#addSource: every source gets an
     * `other:<id>` SourceCache, and vector/geojson sources get a SECOND
     * `symbol:<id>` one. `_mergedSourceCaches` holds both; `_mergedOther…` and
     * `_mergedSymbol…` hold the SAME objects under bare ids.
     */
    const fakeMap = (merged: Record<string, unknown>, alsoSplit = true) => {
        const other: Record<string, unknown> = {};
        const symbol: Record<string, unknown> = {};
        for (const key of Object.keys(merged)) {
            const bare = key.replace(/^[a-z]+:/, '');
            (key.startsWith('symbol:') ? symbol : other)[bare] = merged[key];
        }
        return {
            style: alsoSplit
                ? {
                      _mergedSourceCaches: merged,
                      _mergedOtherSourceCaches: other,
                      _mergedSymbolSourceCaches: symbol,
                  }
                : { _mergedSourceCaches: merged },
        };
    };

    it('counts every cache exactly ONCE', () => {
        // THE BUG THIS REPLACES. The first cut walked all three merged maps,
        // but other+symbol are the same objects the merged map already holds —
        // so every cache was visited twice. Shane's 2026-08-23 report read
        // "208 live +1412 cached across 74 srcs ~232MB tex"; every number was
        // double. A gauge that is wrong in the direction you expect is more
        // dangerous than one that reads zero.
        const map = fakeMap({
            'other:satellite-base': { _tiles: { c: tex(512, 512, false) } },
            'other:enc-depare': { _tiles: { a: {}, b: {} } },
            'symbol:enc-depare': { _tiles: { d: {} } },
        });
        registerCensusMap(map);
        const out = countMapTiles();
        expect(out.sources).toBe(3);
        expect(out.live).toBe(4);
        expect(out.textureMB).toBe(1);
    });

    it('falls back to _sourceCaches only when the merged map is absent', () => {
        registerCensusMap({ style: { _sourceCaches: { 'other:x': { _tiles: { a: tex(256, 256, false) } } } } });
        expect(countMapTiles().sources).toBe(1);
    });

    it('counts the RETAINED cache, which is what maxTileCacheSize bounds', () => {
        // _removeTile moves a tile into _cache WITH ITS TEXTURE. A layer set
        // to visibility:'none' reports _tiles 0 and _cache full — the first
        // version skipped on `tiles === 0` and printed zeros over live
        // textures.
        const map = fakeMap({
            'other:hybrid-base': {
                _tiles: {},
                _cache: { data: { k1: [{ value: tex(1024, 1024) }], k2: [{ value: tex(1024, 1024) }] } },
            },
        });
        registerCensusMap(map);
        const out = countMapTiles();
        expect(out.live).toBe(0);
        expect(out.cached).toBe(2);
        expect(out.sources).toBe(1);
        // 1024×1024 RGBA = 4 MiB, ×4/3 for the mipmap chain, ×2 tiles ≈ 10.7.
        expect(out.textureMB).toBe(11);
    });

    it("uses the tile's real dimensions, not a per-tile guess", () => {
        // The 4 MB-per-retina-tile heuristic assumed mapbox.satellite @2x
        // decodes to 1024×1024. It serves 512×512, so the guess was ~3x high.
        const map = fakeMap({ 'other:s': { _tiles: { a: tex(512, 512, false), b: tex(512, 512, false) } } });
        registerCensusMap(map);
        // 512×512×4 = 1 MiB each, no mipmap → 2, not 8.
        expect(countMapTiles().textureMB).toBe(2);
    });

    it('names the heaviest source, split live vs cached', () => {
        const map = fakeMap({
            'other:satellite-base': {
                _tiles: { a: tex(512, 512), b: tex(512, 512) },
                _cache: { data: { k: [{ value: tex(512, 512) }] } },
            },
            'other:openseamap': { _tiles: { c: tex(256, 256) } },
        });
        registerCensusMap(map);
        expect(countMapTiles().top).toBe('satellite-base:2+1');
    });

    it('degrades to zero rather than throwing when the internals move', () => {
        // There is no public API for any of this. An instrument that throws
        // during the crash it is meant to report on is worse than none.
        registerCensusMap({ style: {} });
        expect(countMapTiles()).toEqual({ live: 0, cached: 0, sources: 0, textureMB: 0, top: null });
        registerCensusMap({});
        expect(countMapTiles().sources).toBe(0);
        registerCensusMap(null);
        expect(countMapTiles().sources).toBe(0);
    });

    it('holds the map WEAKLY so the instrument can never retain a dead one', () => {
        const src = readFileSync('services/memoryCensus.ts', 'utf8');
        expect(src).toContain('let censusMapRef: WeakRef<object> | null = null');
        expect(src).toContain('new WeakRef(map)');
    });

    it('is registered from a line that survives a production build', () => {
        // The whole failure, in one assertion: the registration must NOT sit
        // inside an import.meta.env.DEV branch.
        const init = readFileSync('components/map/useMapInit.ts', 'utf8');
        expect(init).toContain('registerCensusMap(map);');
        expect(init).toContain('registerCensusMap(null);');
        // Bound the slice to the DEV block itself — slicing to end-of-file
        // sweeps up the teardown's own registerCensusMap(null) and the
        // assertion passes or fails for the wrong reason.
        const devAt = init.indexOf('if (import.meta.env.DEV)');
        expect(devAt).toBeGreaterThan(-1);
        const devBranch = init.slice(devAt, init.indexOf('\n        }', devAt));
        expect(devBranch).toContain('__thalassaMap');
        expect(devBranch).not.toContain('registerCensusMap');
    });

    it('records which engine died', () => {
        // webContentKill counts WKWebView jetsams and Chrome renderer kills
        // into one total. The 2026-08-23 report was desktop Chrome, but the
        // memory model it was read against was built from iOS evidence.
        const src = readFileSync('services/memoryCensus.ts', 'utf8');
        expect(src).toContain('function censusPlatform()');
        expect(src).toContain('platform: censusPlatform()');
        expect(src).toContain("[${c.platform ?? '?'}]");
    });
});

describe('the WebGL probe is armed before anything can create a context', () => {
    it('is installed synchronously at boot, not from an async effect', () => {
        // Shane's install reported "WebGL 1 live / 1 created" on the morning
        // of 2026-08-23 and "0 live / 0 created" that afternoon, with a map
        // plainly rendering both times. startCensus() installs the probe, and
        // useAppBootstrap calls it from a useEffect behind three dynamic
        // imports — so it raced Mapbox and sometimes lost.
        const entry = readFileSync('index.tsx', 'utf8');
        expect(entry).toContain("import { installCanvasProbe } from './utils/canvasProbe'");
        // Before React is asked to render anything.
        const armAt = entry.indexOf('installCanvasProbe();');
        expect(armAt).toBeGreaterThan(-1);
        expect(armAt).toBeLessThan(entry.indexOf('ReactDOM.createRoot'));
        // …and at module scope, not inside a callback or effect.
        const line = entry.slice(entry.lastIndexOf('\n', armAt) + 1, armAt);
        expect(line.trim()).toBe('');
    });

    it('says when it was NOT watching, so zero is not read as none', () => {
        const src = readFileSync('services/memoryCensus.ts', 'utf8');
        expect(src).toContain('glProbeArmed: canvasProbeArmed()');
        expect(src).toContain('GL PROBE NOT ARMED');
    });

    it('cannot itself retain a canvas', () => {
        const probe = readFileSync('utils/canvasProbe.ts', 'utf8');
        expect(probe).toContain('WeakRef<HTMLCanvasElement>[]');
        // A frozen prototype must cost the counts, not the map.
        expect(probe).toContain('catch');
    });
});
