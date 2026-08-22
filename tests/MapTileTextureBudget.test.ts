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

describe('the census can see tiles at all', () => {
    const src = readFileSync('services/memoryCensus.ts', 'utf8');

    it('counts retained tiles and estimates their texture cost', () => {
        expect(src).toContain('function countMapTiles()');
        // @2x 512 raster is the 4 MB case — the one that matters at z14.
        expect(src).toContain("src.tileSize === 512 || (src.tiles ?? []).some((u) => u.includes('@2x'))");
        expect(src).toContain('retina ? 4 : 1');
    });

    it('degrades to zero rather than throwing when mapbox internals move', () => {
        // There is no public API for this. An instrument that throws during a
        // crash is worse than one that reports nothing.
        const fn = src.slice(src.indexOf('function countMapTiles()'), src.indexOf('function persist('));
        expect(fn).toContain('if (!caches) return out;');
        expect(fn).toMatch(/\?\./);
    });

    it('reports tiles in the crash line, with the heaviest source named', () => {
        expect(src).toContain('tiles ${c.tiles ?? 0} across ${c.tileSources ?? 0} srcs');
        expect(src).toContain('top ${c.topTileSource}');
    });
});
