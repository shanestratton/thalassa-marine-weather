/**
 * Tests for the voyage share-card pure helpers — summary model and the
 * aspect-preserving track projection. (Rasterise + native share are thin
 * DOM/Capacitor wrappers, not unit-tested here.)
 */
import { describe, it, expect } from 'vitest';
import {
    buildSummaryCardModel,
    normaliseTrackToViewBox,
    buildVoyageCardSvg,
} from '../services/shiplog/voyageShareCard';
import type { ShipLogEntry } from '../types';

function e(over: Partial<ShipLogEntry>): ShipLogEntry {
    return {
        id: Math.random().toString(36),
        voyageId: 'v1',
        timestamp: '2026-06-17T00:00:00Z',
        latitude: -27.5,
        longitude: 153.0,
        entryType: 'auto',
        ...over,
    } as ShipLogEntry;
}

describe('buildSummaryCardModel', () => {
    it('computes distance, duration, avg speed, max wind and point count', () => {
        const entries = [
            e({ timestamp: '2026-06-17T00:00:00Z', cumulativeDistanceNM: 0, speedKts: 0, windSpeed: 10 }),
            e({
                timestamp: '2026-06-17T02:00:00Z',
                cumulativeDistanceNM: 6,
                speedKts: 4,
                windSpeed: 22,
                latitude: -27.4,
            }),
            e({
                timestamp: '2026-06-17T04:00:00Z',
                cumulativeDistanceNM: 12,
                speedKts: 6,
                windSpeed: 15,
                latitude: -27.3,
            }),
        ];
        const m = buildSummaryCardModel(entries, { title: 'Newport → Mooloolaba' });
        expect(m.title).toBe('Newport → Mooloolaba');
        expect(m.distanceNM).toBe(12);
        expect(m.durationLabel).toBe('4h 0m');
        expect(m.avgKts).toBeCloseTo(5); // mean of 4 and 6
        expect(m.maxWindKt).toBe(22);
        expect(m.pointCount).toBe(3);
        expect(m.track).toHaveLength(3);
    });

    it('falls back to a haversine sum when cumulative is all zero', () => {
        const entries = [
            e({ timestamp: '2026-06-17T00:00:00Z', latitude: -27.5, longitude: 153.0, cumulativeDistanceNM: 0 }),
            e({ timestamp: '2026-06-17T01:00:00Z', latitude: -27.4, longitude: 153.0, cumulativeDistanceNM: 0 }),
        ];
        const m = buildSummaryCardModel(entries);
        // ~6 NM per 0.1° latitude → distance should be clearly > 0.
        expect(m.distanceNM).toBeGreaterThan(5);
    });

    it('excludes turn pins and manual entries from the track + stats', () => {
        const entries = [
            e({ timestamp: '2026-06-17T00:00:00Z' }),
            e({ timestamp: '2026-06-17T01:00:00Z', entryType: 'waypoint', waypointName: 'COG N → E' }),
            e({ timestamp: '2026-06-17T02:00:00Z', entryType: 'manual' }),
            e({ timestamp: '2026-06-17T03:00:00Z', latitude: -27.4 }),
        ];
        expect(buildSummaryCardModel(entries).pointCount).toBe(2);
    });

    it('null max wind when no point carried wind', () => {
        const m = buildSummaryCardModel([e({}), e({ latitude: -27.4, timestamp: '2026-06-17T01:00:00Z' })]);
        expect(m.maxWindKt).toBeNull();
    });
});

describe('normaliseTrackToViewBox', () => {
    it('keeps all projected points within the padded box', () => {
        const pts = [
            { lat: -27.5, lon: 153.0 },
            { lat: -27.3, lon: 153.2 },
            { lat: -27.4, lon: 153.1 },
        ];
        const proj = normaliseTrackToViewBox(pts, 1000, 500, 50);
        for (const p of proj) {
            expect(p.x).toBeGreaterThanOrEqual(49);
            expect(p.x).toBeLessThanOrEqual(951);
            expect(p.y).toBeGreaterThanOrEqual(49);
            expect(p.y).toBeLessThanOrEqual(451);
        }
    });

    it('puts north at the top (higher lat → smaller y)', () => {
        const proj = normaliseTrackToViewBox(
            [
                { lat: -27.5, lon: 153.0 }, // south
                { lat: -27.3, lon: 153.0 }, // north
            ],
            400,
            400,
            20,
        );
        expect(proj[1].y).toBeLessThan(proj[0].y);
    });

    it('handles empty input', () => {
        expect(normaliseTrackToViewBox([], 100, 100)).toEqual([]);
    });
});

describe('buildVoyageCardSvg', () => {
    it('produces a self-contained svg with the stats and no external refs', () => {
        const m = buildSummaryCardModel(
            [
                e({ timestamp: '2026-06-17T00:00:00Z', cumulativeDistanceNM: 0 }),
                e({ timestamp: '2026-06-17T03:00:00Z', cumulativeDistanceNM: 18, latitude: -27.3 }),
            ],
            { title: 'Test Run' },
        );
        const svg = buildVoyageCardSvg(m, 1080);
        expect(svg.startsWith('<svg')).toBe(true);
        expect(svg).toContain('Test Run');
        expect(svg).toContain('18.0');
        expect(svg).toContain('THALASSA');
        // No FETCHED resources that would taint the canvas (the xmlns
        // namespace URI is fine — it's not a network request).
        expect(svg).not.toContain('<image');
        expect(svg).not.toContain('xlink:href');
        expect(svg).not.toContain('url(http');
        expect(svg).not.toMatch(/href\s*=\s*"https?:/);
    });

    it('escapes the title so it cannot break the markup', () => {
        const m = buildSummaryCardModel([e({}), e({ latitude: -27.4, timestamp: '2026-06-17T01:00:00Z' })], {
            title: 'A & B <hack>',
        });
        const svg = buildVoyageCardSvg(m);
        expect(svg).toContain('A &amp; B &lt;hack&gt;');
        expect(svg).not.toContain('<hack>');
    });
});
