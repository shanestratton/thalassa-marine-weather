import { describe, expect, it } from 'vitest';
import type { ShipLogEntry } from '../types';
import { mergeCompleteRecordingEvidence } from '../services/shiplog/completeRecordingEvidence';

const entry: ShipLogEntry = {
    id: 'offline_capture-1',
    userId: 'owner',
    voyageId: 'voyage_1790124398484_local',
    timestamp: '2026-09-25T00:00:00.000Z',
    latitude: -20,
    longitude: 148,
    positionFormatted: '20 S 148 E',
    distanceNM: 0,
    cumulativeDistanceNM: 0,
    speedKts: 0.1,
    entryType: 'auto',
    source: 'device',
};

describe('complete recording evidence union', () => {
    it('retains the queued prefix uploaded while cloud pagination is running', () => {
        const later = { ...entry, id: 'offline_capture-2', timestamp: '2026-09-25T00:00:03Z' };
        expect(mergeCompleteRecordingEvidence([entry, later], [], [later])).toEqual([entry, later]);
    });

    it('deduplicates only a known immutable upload operation', () => {
        const cloud = {
            ...entry,
            id: 'database-id',
            clientOperationId: 'capture-1',
            timestamp: '2026-09-25T00:00:00+00:00',
        };
        expect(mergeCompleteRecordingEvidence([entry], [cloud], [])).toEqual([entry]);
    });

    it('does not deduplicate different captures at the same time or position', () => {
        const cloud = { ...entry, id: 'another-row' };
        expect(mergeCompleteRecordingEvidence([entry], [cloud])).toHaveLength(2);
    });

    it.each([
        { notes: 'Engine checked' },
        { speedKts: 3 },
        { latitude: -21 },
        { distanceNM: 1 },
        { cumulativeDistanceNM: 10 },
        { userId: 'someone-else' },
        { entryType: 'manual' as const },
        { linkedPlanId: 'plan' },
    ])('rejects conflicting evidence rather than dropping it: %j', (change) => {
        expect(mergeCompleteRecordingEvidence([entry], [{ ...entry, ...change }])).toBeNull();
    });

    it('rejects duplicate identities inside a supposedly complete source snapshot', () => {
        expect(mergeCompleteRecordingEvidence([entry, { ...entry }])).toBeNull();
    });

    it('rejects missing identities', () => {
        expect(mergeCompleteRecordingEvidence([{ ...entry, id: '' }])).toBeNull();
    });
});
