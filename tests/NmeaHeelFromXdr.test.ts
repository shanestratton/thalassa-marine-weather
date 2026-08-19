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

    /**
     * THE FAULT MARKER, verbatim off Serene Summer's bus on 2026-08-18 with
     * the boat on the hard. Every XDR sentence read this for eighteen minutes
     * — 118 in a row — while the sensor dropped off the bus and came back:
     *
     *   $YDXDR,A,63.75,D,Yaw,A,63.75,D,Pitch,A,63.75,D,Roll*4B
     *
     * No orientation gives all three axes one value. The YDWG encodes
     * attitude in quarter-degree steps, and 63.75 × 4 = 255 = 0xFF, N2K's
     * "not available" byte. It slipped the > 90 range guard, was ingested as
     * a genuine 63.75° heel — a boat on her side — and Shane reported the app
     * "crashing every 13 minutes or so". A sensor that stops reporting must
     * read as NO DATA, never as a knockdown.
     */
    describe('the sensor-not-available marker', () => {
        const FAULT = nmea('YDXDR,A,63.75,D,Yaw,A,63.75,D,Pitch,A,63.75,D,Roll');

        it('is not a heel', () => {
            // A window holding only the fault carries no attitude at all —
            // there is nothing to emit — and a window that also has other
            // data emits with heel and pitch empty. Both are "no data".
            feed(FAULT);
            const alone = emit();
            expect(alone?.heel ?? null).toBeNull();
            expect(alone?.pitch ?? null).toBeNull();
        });

        it('does not poison an otherwise good window', () => {
            // A real reading either side of the fault must survive it, and the
            // fault must not drag the average toward 63.75.
            feed(REAL_XDR, FAULT, FAULT, REAL_XDR);
            const s = emit();
            expect(s.heel).toBeCloseTo(1.0, 5);
            expect(s.pitch).toBeCloseTo(0.75, 5);
        });

        it('is recognised by three identical axes, not only by 63.75', () => {
            // A different gateway, a different marker — the SHAPE is the tell.
            feed(nmea('YDXDR,A,12.25,D,Yaw,A,12.25,D,Pitch,A,12.25,D,Roll'));
            expect(emit()?.heel ?? null).toBeNull();
        });

        it('still believes a genuine knockdown at 63.75° of ROLL alone', () => {
            // The marker must not become a hole a real reading falls through.
            // Roll 63.75 with a sane pitch is a boat on her ear, and the app
            // must say so.
            feed(nmea('YDXDR,A,30.0,D,Yaw,A,2.0,D,Pitch,A,63.75,D,Roll'));
            expect(emit().heel).toBeCloseTo(63.75, 5);
        });
    });

    /**
     * THE PARTIAL MARKER, verbatim off Serene Summer's bus on 2026-08-19 at
     * 16:21:11 — a Garmin GPS 24xd (a GPS puck with a compass and a tilt
     * sensor, no gyro) filling the axes it cannot measure with 0xFF while
     * sending the one it can:
     *
     *   $YDXDR,A,63.75,D,Yaw,A,63.75,D,Pitch,A,1,D,Roll
     *
     * The all-identical shape guard cannot see this, and the mirror case —
     * garbage in the ROLL slot beside valid companions — would have painted a
     * knockdown. Two or more axes at the sentinel mark those axes as no-data;
     * the valid axes are kept.
     */
    describe('the partial not-available marker', () => {
        it('keeps the valid axis and drops the sentinel axes', () => {
            feed(nmea('YDXDR,A,63.75,D,Yaw,A,63.75,D,Pitch,A,1,D,Roll'));
            const s = emit();
            expect(s.heel).toBeCloseTo(1.0, 5);
            expect(s.pitch ?? null).toBeNull();
        });

        it('does not read the mirror case as a knockdown', () => {
            // Roll carrying the sentinel beside a sentinel yaw: two marked
            // axes, so the 63.75 "heel" is a marker, not a boat on her side.
            feed(nmea('YDXDR,A,63.75,D,Yaw,A,2.0,D,Pitch,A,63.75,D,Roll'));
            const s = emit();
            expect(s.heel ?? null).toBeNull();
            expect(s.pitch).toBeCloseTo(2.0, 5);
        });

        it('a single sentinel-valued axis still passes — the knockdown rule wins', () => {
            // One 63.75 beside two sane companions is indistinguishable from a
            // real reading and must be believed (same rule as the suite above).
            feed(nmea('YDXDR,A,30.0,D,Yaw,A,2.0,D,Pitch,A,63.75,D,Roll'));
            expect(emit().heel).toBeCloseTo(63.75, 5);
        });
    });
});

/**
 * Heading sentinels. The YDWG scales N2K "error/not available" heading
 * (0xFFFE) like any other number: 6.5534 rad = 375.5° on the wire — seen
 * verbatim from a factory-fresh GPS 24xd on 2026-08-18/19, and in the
 * 2026-08-09 capture whose "un-normalised VHW headings" (375.5, agreeing with
 * HDT exactly) were this sentinel all along, not wraparound. circularMean's
 * sin/cos silently folds 375.5 into a confident 15.5° — a wrong heading, not
 * a harmless one, whenever a real compass is also on the bus. Out of range is
 * rejected at the parse site, never normalised.
 */
describe('heading and course range guard', () => {
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

    it('rejects the 375.5° sentinel from HDT/HDG/VHW instead of folding it to 15.5', () => {
        feed(nmea('YDHDT,375.5,T'), nmea('YDHDG,375.5,,,11.0,E'), nmea('YDVHW,375.5,T,364.5,M,0.0,N,0.0,K'));
        expect(emit()?.heading ?? null).toBeNull();
    });

    it('a sentinel beside a real compass does not drag the mean', () => {
        // The live failure: EV-1 at 27° and a sentinel 375.5 interleaved.
        // Folding the sentinel in pulls the displayed heading toward 15.5.
        feed(nmea('YDHDT,27.0,T'), nmea('YDHDT,375.5,T'), nmea('YDHDT,27.0,T'));
        expect(emit().heading).toBeCloseTo(27.0, 3);
    });

    it('still accepts the full legal range, edges included', () => {
        feed(nmea('YDHDT,0.0,T'));
        expect(emit().heading).toBeCloseTo(0.0, 3);
        feed(nmea('YDHDT,359.9,T'));
        expect(emit().heading).toBeCloseTo(359.9, 3);
    });

    it('rejects an out-of-range COG without touching SOG', () => {
        feed(nmea('YDRMC,015442,A,2712.3148,S,15305.5824,E,0.1,375.5,180826,11.0,E'));
        const s = emit();
        expect(s.cog ?? null).toBeNull();
        expect(s.sog).toBeCloseTo(0.1, 5);
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
