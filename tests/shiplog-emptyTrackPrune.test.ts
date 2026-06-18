/**
 * Tests for selectEmptyVoyagesToPrune — the guards that decide which
 * zero-distance tracks are safe to auto-delete. The guards ARE the
 * safety story, so they're pinned here.
 */
import { describe, it, expect } from 'vitest';
import { selectEmptyVoyagesToPrune, EMPTY_TRACK_NM, RECENT_ACTIVE_MS } from '../services/shiplog/VoyageSummary';
import type { VoyageSummary } from '../services/shiplog/VoyageSummary';

const NOW = Date.parse('2026-06-17T12:00:00Z');
const OLD = new Date(NOW - 60 * 60 * 1000).toISOString(); // 1h ago — not recently active

function summary(over: Partial<VoyageSummary> = {}): VoyageSummary {
    return {
        voyageId: 'v1',
        entryCount: 5,
        startedAt: OLD,
        endedAt: OLD,
        totalDistanceNM: 0,
        avgSpeedKts: 0,
        hasManual: false,
        isPlannedRoute: false,
        isImported: false,
        firstLat: -27.5,
        firstLon: 153,
        lastLat: -27.5,
        lastLon: 153,
        firstIsOnWater: true,
        landFraction: 0,
        ...over,
    };
}

const opts = { activeVoyageId: null, nowMs: NOW };

describe('selectEmptyVoyagesToPrune', () => {
    it('prunes a plain zero-distance device track', () => {
        expect(selectEmptyVoyagesToPrune([summary()], opts)).toEqual(['v1']);
    });

    it('keeps a voyage that actually moved (>= EMPTY_TRACK_NM)', () => {
        expect(selectEmptyVoyagesToPrune([summary({ totalDistanceNM: EMPTY_TRACK_NM })], opts)).toEqual([]);
        expect(selectEmptyVoyagesToPrune([summary({ totalDistanceNM: 3.2 })], opts)).toEqual([]);
    });

    it('keeps the active voyage on THIS device even at 0.0 NM', () => {
        expect(
            selectEmptyVoyagesToPrune([summary({ voyageId: 'cur' })], { activeVoyageId: 'cur', nowMs: NOW }),
        ).toEqual([]);
    });

    it('keeps a voyage touched within RECENT_ACTIVE_MS (maybe live on another device)', () => {
        const fresh = new Date(NOW - (RECENT_ACTIVE_MS - 1000)).toISOString();
        expect(selectEmptyVoyagesToPrune([summary({ endedAt: fresh })], opts)).toEqual([]);
    });

    it('keeps planned routes and imported tracks', () => {
        expect(selectEmptyVoyagesToPrune([summary({ isPlannedRoute: true })], opts)).toEqual([]);
        expect(selectEmptyVoyagesToPrune([summary({ isImported: true })], opts)).toEqual([]);
    });

    it('keeps a voyage with a manual entry (deliberate content)', () => {
        expect(selectEmptyVoyagesToPrune([summary({ hasManual: true })], opts)).toEqual([]);
    });

    it('selects only the empties from a mixed list', () => {
        const list = [
            summary({ voyageId: 'empty1' }),
            summary({ voyageId: 'sailed', totalDistanceNM: 12 }),
            summary({ voyageId: 'noted', hasManual: true }),
            summary({ voyageId: 'empty2' }),
            summary({ voyageId: 'planned', isPlannedRoute: true }),
        ];
        expect(selectEmptyVoyagesToPrune(list, opts)).toEqual(['empty1', 'empty2']);
    });

    it('handles an unparseable endedAt as not-recent (prunes)', () => {
        expect(selectEmptyVoyagesToPrune([summary({ endedAt: 'not-a-date' })], opts)).toEqual(['v1']);
    });
});

import { mergeSummariesWithLive } from '../services/shiplog/VoyageSummary';
import type { ShipLogEntry } from '../types';

describe('offline-only empty voyage reachability (the real bug)', () => {
    // The card surfaces an offline-only voyage via mergeSummariesWithLive;
    // the prune must be fed that SAME merged list, not the cloud-only
    // summaries, or it can never see (and never delete) the empty track.
    function pt(voyageId: string, tsISO: string, cum = 0): ShipLogEntry {
        return {
            id: `${voyageId}_${tsISO}`,
            voyageId,
            timestamp: tsISO,
            latitude: -27.5,
            longitude: 153.0,
            entryType: 'auto',
            cumulativeDistanceNM: cum,
        } as ShipLogEntry;
    }

    const cloudSummaries: VoyageSummary[] = []; // nothing synced yet
    const offlineEntries = [
        pt('offline_empty', new Date(NOW - 60 * 60 * 1000).toISOString(), 0),
        pt('offline_empty', new Date(NOW - 59 * 60 * 1000).toISOString(), 0),
    ];

    it('cloud-only summaries miss it (reproduces the bug)', () => {
        expect(selectEmptyVoyagesToPrune(cloudSummaries, { activeVoyageId: null, nowMs: NOW })).toEqual([]);
    });

    it('the merged list surfaces it and the prune selects it', () => {
        const merged = mergeSummariesWithLive(cloudSummaries, offlineEntries);
        expect(merged.some((s) => s.voyageId === 'offline_empty')).toBe(true);
        expect(selectEmptyVoyagesToPrune(merged, { activeVoyageId: null, nowMs: NOW })).toEqual(['offline_empty']);
    });

    it('still respects the active-voyage guard on the merged list', () => {
        const merged = mergeSummariesWithLive(cloudSummaries, offlineEntries);
        expect(selectEmptyVoyagesToPrune(merged, { activeVoyageId: 'offline_empty', nowMs: NOW })).toEqual([]);
    });
});
