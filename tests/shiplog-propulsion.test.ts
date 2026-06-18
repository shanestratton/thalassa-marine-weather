/**
 * Tests for the sail-vs-motor heuristic estimator and the estimate-filled
 * propulsion split. The estimator must be CONSERVATIVE — 'unknown' over a
 * wrong guess — and never claim certainty it doesn't have.
 */
import { describe, it, expect } from 'vitest';
import { estimatePropulsion, cardinalToDegrees, evaluatePropulsionConflict } from '../services/shiplog/propulsion';
import { computePropulsionSplit } from '../utils/voyageData';
import type { ShipLogEntry } from '../types';

describe('cardinalToDegrees', () => {
    it('maps the 16-point compass to from-degrees', () => {
        expect(cardinalToDegrees('N')).toBe(0);
        expect(cardinalToDegrees('E')).toBe(90);
        expect(cardinalToDegrees('S')).toBe(180);
        expect(cardinalToDegrees('W')).toBe(270);
        expect(cardinalToDegrees('NNE')).toBe(22.5);
        expect(cardinalToDegrees('nw')).toBe(315); // case-insensitive
    });
    it('returns null for junk / missing', () => {
        expect(cardinalToDegrees(undefined)).toBeNull();
        expect(cardinalToDegrees('')).toBeNull();
        expect(cardinalToDegrees('XYZ')).toBeNull();
    });
});

describe('estimatePropulsion', () => {
    it('unknown when not really moving', () => {
        expect(estimatePropulsion({ speedKts: 0.3, windSpeed: 12, windDirection: 'S', courseDeg: 0 })).toBe('unknown');
    });

    it('unknown when there is no wind data (common offshore)', () => {
        expect(estimatePropulsion({ speedKts: 6, windSpeed: undefined, windDirection: undefined, courseDeg: 90 })).toBe(
            'unknown',
        );
    });

    it('motor when calm but making way', () => {
        expect(estimatePropulsion({ speedKts: 5, windSpeed: 1, windDirection: 'N', courseDeg: 200 })).toBe('motor');
    });

    it('motor in the no-go zone — heading into the wind', () => {
        // Wind from N (0°), heading 010° → 10° off the wind, can't sail it.
        expect(estimatePropulsion({ speedKts: 5, windSpeed: 14, windDirection: 'N', courseDeg: 10 })).toBe('motor');
    });

    it('sail when off the wind with adequate breeze and plausible speed', () => {
        // Wind from N (0°), heading 120° (broad reach), 6 kt in 14 kt wind.
        expect(estimatePropulsion({ speedKts: 6, windSpeed: 14, windDirection: 'N', courseDeg: 120 })).toBe('sail');
    });

    it('motor when clearly outrunning the wind', () => {
        // 8 kt in 4 kt wind, off the wind — a heavy cruiser can't sail that.
        expect(estimatePropulsion({ speedKts: 8, windSpeed: 4, windDirection: 'N', courseDeg: 150 })).toBe('motor');
    });

    it('unknown in a genuinely ambiguous light-air reach', () => {
        // 2 kt in 4 kt wind, off the wind — below the sail-confidence floor,
        // no clear motor signal → honest unknown.
        expect(estimatePropulsion({ speedKts: 2, windSpeed: 4, windDirection: 'N', courseDeg: 150 })).toBe('unknown');
    });
});

function e(over: Partial<ShipLogEntry>): ShipLogEntry {
    return {
        id: Math.random().toString(36),
        voyageId: 'v1',
        timestamp: '2026-06-17T00:00:00Z',
        latitude: -27,
        longitude: 153,
        entryType: 'auto',
        ...over,
    } as ShipLogEntry;
}

describe('computePropulsionSplit with estimate fill', () => {
    it('declared engine state is authoritative; estimatedMs stays 0', () => {
        const split = computePropulsionSplit([
            e({ timestamp: '2026-06-17T00:00:00Z', engineStatus: 'running' }),
            e({ timestamp: '2026-06-17T01:00:00Z', engineStatus: 'stopped' }),
            e({ timestamp: '2026-06-17T02:00:00Z', engineStatus: 'stopped' }),
        ]);
        expect(split.motorMs).toBe(3600000);
        expect(split.sailMs).toBe(3600000);
        expect(split.estimatedMs).toBe(0);
    });

    it('fills undeclared spans from the heuristic and counts them as estimated', () => {
        const split = computePropulsionSplit([
            // Undeclared, calm + moving → estimated motor.
            e({ timestamp: '2026-06-17T00:00:00Z', speedKts: 5, windSpeed: 1, windDirection: 'N', courseDeg: 180 }),
            // Undeclared, broad reach in breeze → estimated sail.
            e({ timestamp: '2026-06-17T01:00:00Z', speedKts: 6, windSpeed: 14, windDirection: 'N', courseDeg: 120 }),
            e({ timestamp: '2026-06-17T02:00:00Z', speedKts: 6, windSpeed: 14, windDirection: 'N', courseDeg: 120 }),
        ]);
        expect(split.motorMs).toBe(3600000); // first span
        expect(split.sailMs).toBe(3600000); // second span
        expect(split.estimatedMs).toBe(7200000); // both were estimated
    });

    it('leaves genuinely-unknown spans in unknownMs', () => {
        const split = computePropulsionSplit([
            e({ timestamp: '2026-06-17T00:00:00Z', speedKts: 6, windSpeed: undefined }),
            e({ timestamp: '2026-06-17T01:00:00Z', speedKts: 6, windSpeed: undefined }),
        ]);
        expect(split.unknownMs).toBe(3600000);
        expect(split.motorMs).toBe(0);
        expect(split.sailMs).toBe(0);
    });
});

describe('evaluatePropulsionConflict', () => {
    // Conditions that the heuristic reads as SAIL (broad reach, good breeze).
    const sailish = { speedKts: 6, windSpeed: 14, windDirection: 'N', courseDeg: 120 };
    // Conditions that read as MOTOR (calm but moving).
    const motorish = { speedKts: 5, windSpeed: 1, windDirection: 'N', courseDeg: 180 };

    it('no nudge when nothing is declared', () => {
        const r = evaluatePropulsionConflict(Array(10).fill(sailish), undefined);
        expect(r.conflict).toBe(false);
        expect(r.suggested).toBeNull();
    });

    it('nudges to switch to sailing when declared MOTOR but it reads as sail', () => {
        const r = evaluatePropulsionConflict(Array(10).fill(sailish), true);
        expect(r.conflict).toBe(true);
        expect(r.suggested).toBe('sail');
    });

    it('nudges to switch to motoring when declared SAIL but it reads as motor', () => {
        const r = evaluatePropulsionConflict(Array(10).fill(motorish), false);
        expect(r.conflict).toBe(true);
        expect(r.suggested).toBe('motor');
    });

    it('no nudge when the declaration AGREES with the estimate', () => {
        expect(evaluatePropulsionConflict(Array(10).fill(sailish), false).conflict).toBe(false);
        expect(evaluatePropulsionConflict(Array(10).fill(motorish), true).conflict).toBe(false);
    });

    it('hysteresis: too few confident samples → no nudge', () => {
        // Only 3 confident estimates (< default minSamples 6).
        expect(evaluatePropulsionConflict(Array(3).fill(sailish), true).conflict).toBe(false);
    });

    it('hysteresis: a minority of conflicting fixes does not fire', () => {
        // 7 agree (sail, declared sail) + 3 disagree → 30% opposite < 70%.
        const mixed = [...Array(3).fill(motorish), ...Array(7).fill(sailish)];
        expect(evaluatePropulsionConflict(mixed, false).conflict).toBe(false);
    });

    it('ignores unknown estimates when counting confidence', () => {
        const unknown = { speedKts: 6, windSpeed: undefined, windDirection: undefined, courseDeg: 90 };
        // 8 unknown + 6 sail; declared motor → 6 confident, all opposite → nudge.
        const r = evaluatePropulsionConflict([...Array(8).fill(unknown), ...Array(6).fill(sailish)], true);
        expect(r.confidentSamples).toBe(6);
        expect(r.conflict).toBe(true);
        expect(r.suggested).toBe('sail');
    });
});
