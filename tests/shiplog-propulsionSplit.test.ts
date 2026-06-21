/**
 * Tests for computePropulsionSplit — sail vs motor time from the
 * user-declared engineStatus stamped on auto track points.
 */
import { describe, it, expect } from 'vitest';
import { computePropulsionSplit } from '../utils/voyageData';
import type { ShipLogEntry } from '../types';

const H = 3600000;

function e(hourOffset: number, engineStatus?: ShipLogEntry['engineStatus']): ShipLogEntry {
    const ts = new Date(Date.UTC(2026, 5, 17, hourOffset, 0, 0)).toISOString();
    return {
        id: ts,
        voyageId: 'v1',
        timestamp: ts,
        latitude: -27,
        longitude: 153,
        entryType: 'auto',
        engineStatus,
    } as ShipLogEntry;
}

describe('computePropulsionSplit', () => {
    it('attributes each interval to the engine state at its start', () => {
        // 0h running, 1h running, 2h stopped, 3h stopped → 2h motor, 1h sail
        const s = computePropulsionSplit([e(0, 'running'), e(1, 'running'), e(2, 'stopped'), e(3, 'stopped')]);
        expect(s.motorMs).toBe(2 * H);
        expect(s.sailMs).toBe(1 * H);
        expect(s.unknownMs).toBe(0);
    });

    it('counts pre-declaration spans as unknown', () => {
        const s = computePropulsionSplit([e(0, undefined), e(1, undefined), e(2, 'running'), e(3, 'running')]);
        expect(s.unknownMs).toBe(2 * H);
        expect(s.motorMs).toBe(1 * H);
        expect(s.sailMs).toBe(0);
    });

    it('treats maneuvering as motor', () => {
        const s = computePropulsionSplit([e(0, 'maneuvering'), e(1, 'stopped')]);
        expect(s.motorMs).toBe(1 * H);
        expect(s.sailMs).toBe(0);
    });

    it('handles out-of-order input (sorts first) and ignores zero/negative gaps', () => {
        const s = computePropulsionSplit([e(2, 'stopped'), e(0, 'running'), e(1, 'running')]);
        expect(s.motorMs).toBe(2 * H);
        expect(s.sailMs).toBe(0);
    });

    it('a single point or empty list yields all zeros', () => {
        expect(computePropulsionSplit([])).toEqual({ motorMs: 0, sailMs: 0, unknownMs: 0, estimatedMs: 0 });
        expect(computePropulsionSplit([e(0, 'running')])).toEqual({
            motorMs: 0,
            sailMs: 0,
            unknownMs: 0,
            estimatedMs: 0,
        });
    });
});
