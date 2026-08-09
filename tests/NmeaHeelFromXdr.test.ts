/**
 * Heel, from a sensor that actually exists.
 *
 * The Heel Angle tile was removed on 2026-08-08 because it was wired to a
 * literal 0 with nothing behind it — a confident "0° STBD" for ever. On
 * 2026-08-09, probing Calypso's own backbone over Tailscale turned up the
 * missing source: $YDXDR streaming Yaw, Pitch and Roll in degrees at 1 Hz.
 *
 * The sentences below are verbatim from that capture. XDR is a bag of
 * arbitrary transducers, so the risk this file guards is a parser that matches
 * on the NAME alone and reads a rudder angle, a temperature or a compass
 * bearing into the heel gauge — which would put the boat on its ear on screen
 * while it sits level at the mooring.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { NmeaListenerService } from '../services/NmeaListenerService';
import type { NmeaSample } from '../types/navigation';

/** Compute the XOR checksum so the sentences are accepted as real. */
const nmea = (body: string) => {
    let x = 0;
    for (const ch of body) x ^= ch.charCodeAt(0);
    return `$${body}*${x.toString(16).toUpperCase().padStart(2, '0')}`;
};

/** Verbatim from Calypso's backbone, 2026-08-09. */
const REAL_XDR = nmea('YDXDR,A,-4.50,D,Yaw,A,0.75,D,Pitch,A,1.00,D,Roll');

describe('XDR attitude parsing', () => {
    let samples: NmeaSample[];
    let unsub: () => void;

    const feed = (...sentences: string[]) => {
        const svc = NmeaListenerService as unknown as { parseNmeaSentence: (line: string) => void };
        for (const s of sentences) svc.parseNmeaSentence(s);
    };

    beforeEach(() => {
        samples = [];
        unsub?.();
        unsub = NmeaListenerService.onSample((s) => samples.push(s));
        (NmeaListenerService as unknown as { accumulator: unknown }).accumulator = (
            NmeaListenerService as unknown as { freshAccumulator: () => unknown }
        ).freshAccumulator();
    });

    const emit = () => {
        const svc = NmeaListenerService as unknown as { status: string; emitSample: () => void };
        const prev = svc.status;
        svc.status = 'connected';
        svc.emitSample();
        svc.status = prev;
        return samples[samples.length - 1];
    };

    it('reads Roll and Pitch out of the real sentence', () => {
        feed(REAL_XDR);
        const s = emit();
        expect(s.heel).toBeCloseTo(1.0, 5);
        expect(s.pitch).toBeCloseTo(0.75, 5);
    });

    it('treats positive Roll as starboard', () => {
        feed(nmea('YDXDR,A,12.5,D,Roll'));
        expect(emit().heel).toBeCloseTo(12.5, 5);
    });

    it('carries a port heel through as negative', () => {
        feed(nmea('YDXDR,A,-8.25,D,Roll'));
        expect(emit().heel).toBeCloseTo(-8.25, 5);
    });

    it('averages within the emission window rather than taking the last gust', () => {
        feed(nmea('YDXDR,A,10.0,D,Roll'), nmea('YDXDR,A,20.0,D,Roll'), nmea('YDXDR,A,30.0,D,Roll'));
        expect(emit().heel).toBeCloseTo(20.0, 5);
    });
});

describe('XDR is a bag of arbitrary transducers — match type AND unit, never the name alone', () => {
    const parseOnly = (sentence: string) => {
        const svc = NmeaListenerService as unknown as {
            accumulator: { heel: number[]; pitch: number[]; voltage: number[] };
            freshAccumulator: () => unknown;
            parseNmeaSentence: (l: string) => void;
        };
        svc.accumulator = svc.freshAccumulator() as typeof svc.accumulator;
        svc.parseNmeaSentence(sentence);
        return svc.accumulator;
    };

    it('ignores a Roll that is not angular', () => {
        // Type 'G' generic, not 'A'. A name-only matcher would take it.
        expect(parseOnly(nmea('YDXDR,G,42.0,,Roll')).heel).toEqual([]);
    });

    it('ignores an angular Roll that is not in degrees', () => {
        // 'R' radians. Reading 1.0 radian as 1.0 degree understates a 57° heel.
        expect(parseOnly(nmea('YDXDR,A,1.0,R,Roll')).heel).toEqual([]);
    });

    it('rejects a value outside ±90 — that is not a heel', () => {
        // A compass bearing or a rudder-reference angle leaking into this
        // field would otherwise render as a knockdown.
        expect(parseOnly(nmea('YDXDR,A,375.5,D,Roll')).heel).toEqual([]);
        expect(parseOnly(nmea('YDXDR,A,-180.0,D,Roll')).heel).toEqual([]);
    });

    it('still reads battery voltage — the branch it shared before', () => {
        expect(parseOnly(nmea('YDXDR,V,12.6,V,BATTERY')).voltage).toEqual([12.6]);
    });

    it('does not mistake voltage for attitude, or attitude for voltage', () => {
        const acc = parseOnly(nmea('YDXDR,V,12.6,V,BATTERY,A,3.0,D,Roll'));
        expect(acc.voltage).toEqual([12.6]);
        expect(acc.heel).toEqual([3.0]);
    });

    it('handles the checksum being glued to the last name field', () => {
        // '...,D,Roll*53' — the name arrives with the checksum attached when
        // Roll is the final group, which is exactly how the real boat sends it.
        expect(parseOnly(REAL_XDR).heel).toEqual([1.0]);
    });
});
