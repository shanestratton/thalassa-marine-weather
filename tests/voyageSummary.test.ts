/**
 * Tests for summarizeEntries — the pure client-side voyage roll-up that
 * backs the Log list (and is the contract the get_voyage_summaries RPC
 * mirrors). Pins down counts, distance, duration window, avg speed,
 * source-flag detection, and first/last coordinate extraction.
 */

import { describe, it, expect } from 'vitest';
import { summarizeEntries } from '../services/shiplog/VoyageSummary';
import type { ShipLogEntry } from '../types';

const mk = (o: Partial<ShipLogEntry>): ShipLogEntry =>
    ({
        id: o.id ?? `e-${Math.random()}`,
        userId: 'u1',
        voyageId: o.voyageId ?? 'v1',
        timestamp: o.timestamp ?? '2026-02-01T00:00:00.000Z',
        latitude: o.latitude ?? -27.5,
        longitude: o.longitude ?? 153.0,
        positionFormatted: '',
        cumulativeDistanceNM: o.cumulativeDistanceNM,
        speedKts: o.speedKts,
        entryType: o.entryType ?? 'auto',
        source: o.source,
        isOnWater: o.isOnWater,
        ...o,
    }) as ShipLogEntry;

describe('summarizeEntries', () => {
    it('groups by voyageId and counts entries', () => {
        const out = summarizeEntries([mk({ voyageId: 'a' }), mk({ voyageId: 'a' }), mk({ voyageId: 'b' })]);
        const a = out.find((s) => s.voyageId === 'a')!;
        const b = out.find((s) => s.voyageId === 'b')!;
        expect(a.entryCount).toBe(2);
        expect(b.entryCount).toBe(1);
    });

    it('uses MAX cumulative distance as the voyage total', () => {
        const out = summarizeEntries([
            mk({ voyageId: 'a', cumulativeDistanceNM: 3 }),
            mk({ voyageId: 'a', cumulativeDistanceNM: 17.4 }),
            mk({ voyageId: 'a', cumulativeDistanceNM: 12 }),
        ]);
        expect(out[0].totalDistanceNM).toBeCloseTo(17.4);
    });

    it('captures the start/end window from earliest + latest timestamps', () => {
        const out = summarizeEntries([
            mk({ voyageId: 'a', timestamp: '2026-02-01T08:00:00.000Z' }),
            mk({ voyageId: 'a', timestamp: '2026-02-01T06:00:00.000Z' }),
            mk({ voyageId: 'a', timestamp: '2026-02-01T10:30:00.000Z' }),
        ]);
        expect(out[0].startedAt).toBe('2026-02-01T06:00:00.000Z');
        expect(out[0].endedAt).toBe('2026-02-01T10:30:00.000Z');
    });

    it('extracts first/last coordinates by timestamp order', () => {
        const out = summarizeEntries([
            mk({ voyageId: 'a', timestamp: '2026-02-01T10:00:00.000Z', latitude: -20, longitude: 148 }),
            mk({ voyageId: 'a', timestamp: '2026-02-01T06:00:00.000Z', latitude: -27.5, longitude: 153 }),
        ]);
        expect(out[0].firstLat).toBe(-27.5);
        expect(out[0].firstLon).toBe(153);
        expect(out[0].lastLat).toBe(-20);
        expect(out[0].lastLon).toBe(148);
    });

    it('averages only moving entries (speed > 0)', () => {
        const out = summarizeEntries([
            mk({ voyageId: 'a', speedKts: 0 }),
            mk({ voyageId: 'a', speedKts: 6 }),
            mk({ voyageId: 'a', speedKts: 4 }),
            mk({ voyageId: 'a', speedKts: undefined }),
        ]);
        expect(out[0].avgSpeedKts).toBeCloseTo(5); // (6+4)/2, zeros + undefined excluded
    });

    it('reports avgSpeed 0 when nothing moved', () => {
        const out = summarizeEntries([mk({ voyageId: 'a', speedKts: 0 }), mk({ voyageId: 'a' })]);
        expect(out[0].avgSpeedKts).toBe(0);
    });

    it('detects manual entries', () => {
        const out = summarizeEntries([
            mk({ voyageId: 'a', entryType: 'auto' }),
            mk({ voyageId: 'a', entryType: 'manual' }),
        ]);
        expect(out[0].hasManual).toBe(true);
    });

    it('flags planned routes and imports distinctly', () => {
        const planned = summarizeEntries([mk({ voyageId: 'p', source: 'planned_route' })])[0];
        expect(planned.isPlannedRoute).toBe(true);
        expect(planned.isImported).toBe(false);

        const imported = summarizeEntries([mk({ voyageId: 'i', source: 'gpx_import' })])[0];
        expect(imported.isImported).toBe(true);
        expect(imported.isPlannedRoute).toBe(false);

        const device = summarizeEntries([mk({ voyageId: 'd', source: 'device' })])[0];
        expect(device.isImported).toBe(false);
        expect(device.isPlannedRoute).toBe(false);
    });

    it('carries the first entry is_on_water flag', () => {
        const out = summarizeEntries([
            mk({ voyageId: 'a', timestamp: '2026-02-01T06:00:00.000Z', isOnWater: true }),
            mk({ voyageId: 'a', timestamp: '2026-02-01T10:00:00.000Z', isOnWater: false }),
        ]);
        expect(out[0].firstIsOnWater).toBe(true);
    });

    it('returns voyages newest-first by latest entry', () => {
        const out = summarizeEntries([
            mk({ voyageId: 'old', timestamp: '2026-01-01T00:00:00.000Z' }),
            mk({ voyageId: 'new', timestamp: '2026-03-01T00:00:00.000Z' }),
            mk({ voyageId: 'mid', timestamp: '2026-02-01T00:00:00.000Z' }),
        ]);
        expect(out.map((s) => s.voyageId)).toEqual(['new', 'mid', 'old']);
    });

    it('handles an empty list', () => {
        expect(summarizeEntries([])).toEqual([]);
    });

    it('falls back to default_voyage bucket for entries with no voyageId', () => {
        const out = summarizeEntries([mk({ voyageId: undefined as unknown as string })]);
        expect(out[0].voyageId).toBe('default_voyage');
    });
});
