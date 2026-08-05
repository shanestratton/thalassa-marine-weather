import { describe, expect, it } from 'vitest';
import { processAisSentence } from '../services/AisDecoder';
import { NmeaListenerService } from '../services/NmeaListenerService';
import {
    nmeaDepthReferenceLabel,
    parseNmeaDepth,
    parseNmeaNumber,
    validateNmeaSentence,
} from '../services/nmea/nmeaSentence';
import { reconcileNmeaMetricFreshness, type TimestampedMetric } from '../services/NmeaStore';
import type { NmeaSample } from '../types';

function withChecksum(raw: string): string {
    let checksum = 0;
    for (let i = 1; i < raw.length; i++) checksum ^= raw.charCodeAt(i);
    return `${raw}*${checksum.toString(16).toUpperCase().padStart(2, '0')}`;
}

describe('NMEA sentence ingress safety', () => {
    it('accepts a valid checksum and verifies it before exposing the body', () => {
        const raw = '$GPRMC,123456,A,2730.000,S,15300.000,E,5.0,45.0,050826,,';
        expect(validateNmeaSentence(withChecksum(raw))).toEqual({
            raw,
            type: 'RMC',
            kind: 'instrument',
            hasChecksum: true,
        });
        expect(validateNmeaSentence(`${raw}*00`)).toBeNull();
    });

    it('never downgrades a present but malformed checksum to checksum-absent compatibility', () => {
        const raw = '$SDDBT,8.1,f,2.4,M,1.3,F';
        for (const suffix of ['*', '*0', '*GG', '*000', '*0B trailing', '*0B*0B']) {
            expect(validateNmeaSentence(`${raw}${suffix}`)).toBeNull();
        }
    });

    it('allows checksum-less input only for supported, structurally valid $ instrument sentences', () => {
        expect(validateNmeaSentence('$SDDBT,8.1,f,2.4,M,1.3,F')).toMatchObject({
            type: 'DBT',
            kind: 'instrument',
            hasChecksum: false,
        });
        expect(validateNmeaSentence('$GPXYZ,1,2,3')).toBeNull();
        expect(validateNmeaSentence('$GPRMCBROKEN')).toBeNull();
        expect(validateNmeaSentence(' $GPRMC,1,A')).toBeNull();
    });

    it('does not coerce partial, infinite, or whitespace-padded numeric fields', () => {
        expect(parseNmeaNumber('12.4')).toBe(12.4);
        expect(parseNmeaNumber('-1.2')).toBe(-1.2);
        for (const malformed of ['', '12.4garbage', 'Infinity', ' 12.4', '12.4 ']) {
            expect(parseNmeaNumber(malformed)).toBeNull();
        }
    });

    it('requires verified checksums for AIS and rejects corrupt AIS at the decoder boundary', () => {
        const valid = '!AIVDM,1,1,,B,15MwkT1P05Fo;H`EKP8a8:R`0@Fv,0*0D';
        const noChecksum = valid.split('*')[0];
        const corrupt = `${noChecksum}*00`;

        expect(validateNmeaSentence(valid)).toMatchObject({ kind: 'ais', type: 'VDM', hasChecksum: true });
        expect(validateNmeaSentence(noChecksum)).toBeNull();
        expect(processAisSentence(corrupt)).toBeNull();
        expect(processAisSentence(valid)).not.toBeNull();
    });
});

describe('NMEA listener depth-only pipeline', () => {
    interface ListenerHarness {
        status: 'disconnected' | 'connecting' | 'connected' | 'error';
        accumulator: unknown;
        freshAccumulator(): unknown;
        parseNmeaSentence(sentence: string): void;
        emitSample(): void;
    }

    it('emits a depth-only sample, prefers DPT, and carries its applied datum offset', () => {
        const harness = NmeaListenerService as unknown as ListenerHarness;
        const originalStatus = harness.status;
        const samples: NmeaSample[] = [];
        const unsubscribe = NmeaListenerService.onSample((sample) => samples.push(sample));

        try {
            harness.status = 'connected';
            harness.accumulator = harness.freshAccumulator();
            harness.parseNmeaSentence(withChecksum('$SDDBT,32.8,f,10.0,M,5.5,F'));
            harness.parseNmeaSentence(withChecksum('$SDDPT,10.0,-1.8,100'));
            harness.emitSample();

            expect(samples).toHaveLength(1);
            expect(samples[0]).toMatchObject({
                depth: 8.2,
                depthSource: 'DPT',
                depthReference: 'below-keel',
                depthOffsetM: -1.8,
            });
        } finally {
            unsubscribe();
            harness.accumulator = harness.freshAccumulator();
            harness.status = originalStatus;
        }
    });

    it('does not emit malformed numeric depth or checksum-invalid data', () => {
        const harness = NmeaListenerService as unknown as ListenerHarness;
        const originalStatus = harness.status;
        const samples: NmeaSample[] = [];
        const unsubscribe = NmeaListenerService.onSample((sample) => samples.push(sample));

        try {
            harness.status = 'connected';
            harness.accumulator = harness.freshAccumulator();
            harness.parseNmeaSentence(withChecksum('$SDDPT,10.0garbage,-1.8,100'));
            harness.parseNmeaSentence('$SDDBT,32.8,f,10.0,M,5.5,F*00');
            harness.emitSample();
            expect(samples).toEqual([]);
        } finally {
            unsubscribe();
            harness.accumulator = harness.freshAccumulator();
            harness.status = originalStatus;
        }
    });
});

describe('NMEA depth datum handling', () => {
    it('keeps DBT explicitly below the transducer', () => {
        expect(parseNmeaDepth('$SDDBT,8.1,f,2.4,M,1.3,F', 'DBT')).toEqual({
            depthM: 2.4,
            rawDepthM: 2.4,
            source: 'DBT',
            reference: 'below-transducer',
            offsetM: null,
        });
    });

    it('applies a positive DPT offset once and labels the waterline reference', () => {
        expect(parseNmeaDepth('$SDDPT,10.0,1.2,100', 'DPT')).toEqual({
            depthM: 11.2,
            rawDepthM: 10,
            source: 'DPT',
            reference: 'below-waterline',
            offsetM: 1.2,
        });
        expect(nmeaDepthReferenceLabel('below-waterline')).toBe('Below waterline');
    });

    it('applies a negative DPT offset once and labels the keel reference', () => {
        expect(parseNmeaDepth('$SDDPT,10.0,-1.8,100', 'DPT')).toEqual({
            depthM: 8.2,
            rawDepthM: 10,
            source: 'DPT',
            reference: 'below-keel',
            offsetM: -1.8,
        });
        expect(nmeaDepthReferenceLabel('below-keel')).toBe('Below keel');
    });

    it('does not invent a datum when DPT omits or zeroes its offset', () => {
        expect(parseNmeaDepth('$SDDPT,2.4,,100', 'DPT')).toMatchObject({
            depthM: 2.4,
            reference: 'below-transducer',
            offsetM: null,
        });
        expect(parseNmeaDepth('$SDDPT,2.4,0.0,100', 'DPT')).toMatchObject({
            depthM: 2.4,
            reference: 'below-transducer',
            offsetM: 0,
        });
        expect(parseNmeaDepth('$SDDPT,2.4,not-a-number,100', 'DPT')).toBeNull();
    });
});

describe('NMEA metric retirement', () => {
    it('retains a stale value for an explicitly stale UI, then clears it once dead', () => {
        const metric: TimestampedMetric = { value: 7.2, lastUpdated: 1_000, freshness: 'live' };

        expect(reconcileNmeaMetricFreshness(metric, 7_501)).toBe(true);
        expect(metric).toEqual({ value: 7.2, lastUpdated: 1_000, freshness: 'stale' });

        expect(reconcileNmeaMetricFreshness(metric, 14_001)).toBe(true);
        expect(metric).toEqual({ value: null, lastUpdated: 1_000, freshness: 'dead' });
    });

    it('stays live across continuous five-second emissions and survives one missed window as stale', () => {
        const metric: TimestampedMetric = { value: 6.8, lastUpdated: 1_000, freshness: 'live' };

        expect(reconcileNmeaMetricFreshness(metric, 6_999)).toBe(false);
        metric.lastUpdated = 6_000; // next healthy 5 s aggregate
        expect(reconcileNmeaMetricFreshness(metric, 11_999)).toBe(false);

        // One 5 s window missed: keep the last value, but label it stale.
        expect(reconcileNmeaMetricFreshness(metric, 13_001)).toBe(true);
        expect(metric).toEqual({ value: 6.8, lastUpdated: 6_000, freshness: 'stale' });
        // More than two windows: retire it rather than acting on old data.
        expect(reconcileNmeaMetricFreshness(metric, 19_001)).toBe(true);
        expect(metric).toEqual({ value: null, lastUpdated: 6_000, freshness: 'dead' });
    });
});
