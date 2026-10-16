import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NmeaListenerService } from '../services/NmeaListenerService';
import {
    parseGll,
    parseMdaPressure,
    parsePcdin,
    parseVlw,
    parseVtg,
    parseXdrPressure,
} from '../services/nmea/additionalSentences';
import { clearGatewayPressure, gatewayPressure, recordGatewayPressure } from '../services/nmea/gatewayPressure';
import { setAuthIdentityScope } from '../services/authIdentityScope';
import { validateNmeaSentence } from '../services/nmea/nmeaSentence';
import type { NmeaSample } from '../types';

const NOW = 1_800_000_000_000;
function checksum(body: string): string {
    const sum = [...body.slice(1)].reduce((sum, char) => sum ^ char.charCodeAt(0), 0);
    return `${body}*${sum.toString(16).padStart(2, '0').toUpperCase()}`;
}
const parts = (body: string) => body.split(',');
const pcdin = (pgn: number, bytes: number[], source = '03') =>
    checksum(
        `$PCDIN,${pgn.toString(16).padStart(6, '0')},00000001,${source},${bytes.map((b) => b.toString(16).padStart(2, '0')).join('')}`,
    );

beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    clearGatewayPressure();
});
afterEach(() => {
    clearGatewayPressure();
    setAuthIdentityScope(null);
    vi.restoreAllMocks();
});

describe('additional NMEA measurements', () => {
    it('accepts measured GLL fixes including equator/Greenwich, rejects invalid status/mode/minutes/hemisphere', () => {
        expect(parseGll(parts('$GPGLL,0000.000,N,00000.000,E,120000,A,D'))).toEqual({ lat: 0, lon: 0 });
        expect(parseGll(parts('$GPGLL,2730.0,S,15300.0,E,120000,A'))).toEqual({ lat: -27.5, lon: 153 });
        for (const body of [
            '$GPGLL,2730.0,S,15300.0,E,120000,V,D',
            '$GPGLL,2730.0,S,15300.0,E,120000,A,S',
            '$GPGLL,2760.0,S,15300.0,E,120000,A,D',
            '$GPGLL,2730.0,W,15300.0,E,120000,A,D',
        ])
            expect(parseGll(parts(body))).toBeNull();
    });
    it('honours VTG true reference and independent units; never uses magnetic/estimated course as true', () => {
        expect(parseVtg(parts('$GPVTG,45,T,33,M,5,N,9.26,K,D'))).toEqual({ sogKts: 5, cogTrue: 45 });
        expect(parseVtg(parts('$GPVTG,,T,33,M,,N,9.26,K,A'))).toEqual({ sogKts: 5, cogTrue: null });
        expect(parseVtg(parts('$GPVTG,45,M,33,M,5,N,,K,A'))).toEqual({ sogKts: 5, cogTrue: null });
        for (const mode of ['N', 'E', 'M', 'S', '?'])
            expect(parseVtg(parts(`$GPVTG,45,T,,M,5,N,9.26,K,${mode}`))).toBeNull();
        expect(parseVtg(parts('$GPVTG,45,T,,M,5,N,40,K,A'))).toBeNull();
        expect(parseVtg(parts('$GPVTG,375.5,T,,M,-1,N,,K,A'))).toBeNull();
    });
    it('keeps water log/trip separate from ground-distance extension, preserves real zero', () => {
        expect(parseVlw(parts('$IIVLW,1200.5,N,0,N,3000,N,2,N'))).toEqual({
            totalNm: 1200.5,
            tripNm: 0,
            reference: 'water',
        });
        expect(parseVlw(parts('$IIVLW,,N,2.5,N'))).toEqual({ totalNm: null, tripNm: 2.5, reference: 'water' });
        expect(parseVlw(parts('$IIVLW,-1,N,garbage,N'))).toBeNull();
        expect(parseVlw(parts('$IIVLW,20,K,5,K'))).toBeNull();
    });
    it('converts bar/inHg/Pa pressure without asserting sea-level correction or accepting fuel pressure', () => {
        expect(parseMdaPressure(parts('$WIMDA,29.92,I,1.0132,B'))).toMatchObject({ hpa: 1013.2, reference: 'sensor' });
        expect(parseMdaPressure(parts('$WIMDA,29.92,I,,B'))?.hpa).toBeCloseTo(1013.207, 2);
        expect(parseMdaPressure(parts('$WIMDA,28,I,1.1,B'))).toBeNull();
        expect(parseXdrPressure(parts('$YDXDR,P,99930,P,Baro'))).toMatchObject({ hpa: 999.3, reference: 'sensor' });
        expect(parseXdrPressure(parts('$IIXDR,P,1.02481,B,Barometer'))?.hpa).toBeCloseTo(1024.81);
        expect(parseXdrPressure(parts('$YXXDR,P,1.023880,B,USB-BAR20-N'))?.hpa).toBeCloseTo(1023.88);
        for (const body of [
            '$IIXDR,P,100000,P,FUEL',
            '$IIXDR,P,100000,P,EngineOil',
            '$IIXDR,V,1.01,B,Baro',
            '$IIXDR,P,1.01,?,Baro',
            '$IIXDR,P,,B,Baro',
            '$IIXDR,P,0,B,Baro',
        ])
            expect(parseXdrPressure(parts(body))).toBeNull();
    });
});

describe('SeaSmart ingress', () => {
    it('requires checksum, complete bounded payload, fixed hex shape and allowlisted read-only PGN', () => {
        const sentence = pcdin(127488, [0, 0x80, 0x0c, 0xff, 0xff, 0xff, 0xff, 0xff]);
        expect(parsePcdin(sentence)).toMatchObject({
            sourceAddress: 3,
            deviceTick: '00000001',
            message: { pgn: 127488, instance: 0, rpm: 800 },
        });
        expect(validateNmeaSentence(sentence)?.type).toBe('PCDIN');
        for (const bad of [
            sentence.split('*')[0],
            `${sentence.slice(0, -2)}00`,
            pcdin(127237, new Array(8).fill(0)),
            pcdin(127488, [0]),
            checksum('$PCDIN,01F200,1,03,0000000000000000'),
            checksum('$PCDIN,01F200,00000001,03,000000000000000G'),
        ])
            expect(parsePcdin(bad)).toBeNull();
    });
    it('preserves N2K not-available sentinels as unknown, never zero', () => {
        expect(parsePcdin(pcdin(127488, new Array(8).fill(255)))?.message).toMatchObject({ rpm: null });
        expect(parsePcdin(pcdin(129025, [255, 255, 255, 127, 255, 255, 255, 127]))?.message).toMatchObject({
            latitude: null,
            longitude: null,
        });
    });
});

describe('real listener and bounded pressure history', () => {
    const h = NmeaListenerService as unknown as {
        status: string;
        freshAccumulator(): unknown;
        accumulator: unknown;
        instrumentEngines: Map<string, unknown>;
        parseNmeaSentence(s: string, at?: number): void;
        emitSample(): void;
        setStatus(s: string): void;
    };
    function samplesFor(bodies: string[], at = NOW - 3000): NmeaSample[] {
        const output: NmeaSample[] = [],
            off = NmeaListenerService.onSample((sample) => output.push(sample));
        const status = h.status;
        try {
            h.status = 'connected';
            h.accumulator = h.freshAccumulator();
            h.instrumentEngines.clear();
            for (const body of bodies) h.parseNmeaSentence(body.includes('*') ? body : checksum(body), at);
            h.emitSample();
            return output;
        } finally {
            off();
            h.status = status;
            h.accumulator = h.freshAccumulator();
            h.instrumentEngines.clear();
        }
    }
    it('publishes standalone VTG/GLL/VLW with their actual receipt clock', () => {
        const [sample] = samplesFor([
            '$GPVTG,45,T,,M,5,N,9.26,K,D',
            '$GPGLL,2730.0,S,15300.0,E,120000,A,D',
            '$IIVLW,1200,N,5,N',
        ]);
        expect(sample).toMatchObject({
            sog: 5,
            cog: 45,
            latitude: -27.5,
            longitude: 153,
            distanceLog: { totalNm: 1200, tripNm: 5, at: NOW - 3000 },
            measurementTimes: { sog: NOW - 3000, cogTrue: NOW - 3000, position: NOW - 3000 },
        });
        expect(samplesFor(['$IIVLW,0,N,0,N'])).toHaveLength(1);
    });
    it('does not qualify simulated RMC/VTG/GLL as measured boat motion', () => {
        expect(
            samplesFor([
                '$GPRMC,120000,A,2730.0,S,15300.0,E,5,45,010126,,,S',
                '$GPVTG,45,T,,M,5,N,9.26,K,E',
                '$GPGLL,2730.0,S,15300.0,E,120000,A,N',
            ]),
        ).toEqual([]);
    });
    it('makes PCDIN RPM available for sailing suppression without inventing engine count', () => {
        const [sample] = samplesFor([pcdin(127488, [0, 0x80, 0x0c, 255, 255, 255, 255, 255])]);
        expect(sample.rpm).toBe(800);
        expect(sample.instrumentReadings?.rpm).toMatchObject({ value: 800, at: NOW - 3000, engineId: 'N2K-3-0' });
        expect(sample.instrumentReadings?.rpm?.engineCount).toBeUndefined();
    });
    it('retains PCDIN transducer depth without silently applying an offset', () => {
        const bytes = new Uint8Array(8).fill(255),
            view = new DataView(bytes.buffer);
        view.setUint32(1, 1234, true);
        view.setInt16(5, -1800, true);
        expect(samplesFor([pcdin(128267, [...bytes])])[0]).toMatchObject({
            depth: 12.34,
            depthSource: 'PCDIN',
            depthReference: 'below-transducer',
            depthOffsetM: null,
        });
    });
    it('passes identified dynamic engine meters in seconds, Celsius and kPa with the packet clock', () => {
        const bytes = new Uint8Array(26).fill(255),
            view = new DataView(bytes.buffer);
        bytes[0] = 2;
        view.setUint16(1, 3500, true);
        view.setUint16(5, 36315, true);
        view.setUint32(11, 360000, true);
        const engine = samplesFor([pcdin(127489, [...bytes])])[0].engineTelemetry!;
        expect(engine.engineId).toBe('N2K-3-2');
        expect(engine.runTime).toEqual({ value: 360000, at: NOW - 3000 });
        expect(engine.oilPressure).toEqual({ value: 350, at: NOW - 3000 });
        expect(engine.coolant!.value).toBeCloseTo(90);
        expect(engine.coolant!.at).toBe(NOW - 3000);
    });
    it('does not turn a magnetic PCDIN heading into true heading evidence', () => {
        const bytes = new Uint8Array(8).fill(255),
            view = new DataView(bytes.buffer);
        bytes[7] = 1;
        view.setUint16(1, 10000, true);
        const [sample] = samplesFor([pcdin(127250, [...bytes])]);
        expect(sample.heading).toBeCloseTo(180 / Math.PI);
        expect(sample.headingTrue).toBeNull();
        expect(sample.instrumentReadings?.headingTrue?.value).toBeNull();
    });
    it('feeds pressure to the real source seam and clears it on disconnect', () => {
        samplesFor(['$WIMDA,,I,1.013,B']);
        expect(gatewayPressure()?.samples.at(-1)?.t).toBe(NOW - 3000);
        expect(gatewayPressure()?.samples.at(-1)?.hpa).toBeCloseTo(1013);
        h.setStatus('disconnected');
        expect(gatewayPressure()).toBeNull();
    });
    it('bounds six-hour history, prevents sensor/account splicing, expires silent readings', () => {
        for (let i = 0; i < 500; i++) {
            const at = NOW + i * 60_000;
            vi.mocked(Date.now).mockReturnValue(at);
            recordGatewayPressure({ hpa: 1013, reference: 'sensor', source: 'Baro' }, at, 'gateway-A');
        }
        const end = NOW + 499 * 60_000;
        expect(gatewayPressure(end)?.samples).toHaveLength(361);
        expect(gatewayPressure(end + 13_001)).toBeNull();
        recordGatewayPressure({ hpa: 1000, reference: 'sensor', source: 'Other barometer' }, end + 1, 'gateway-A');
        expect(gatewayPressure(end + 1)?.samples).toHaveLength(1);
        setAuthIdentityScope('fictional-pressure-test');
        expect(gatewayPressure()).toBeNull();
    });
    it('retains distinct minute buckets on a continuously transmitting sensor', () => {
        for (let second = 0; second < 180; second++) {
            const at = NOW + second * 1000;
            vi.mocked(Date.now).mockReturnValue(at);
            recordGatewayPressure({ hpa: 1000 + second / 100, reference: 'sensor', source: 'Baro' }, at, 'gateway');
        }
        const history = gatewayPressure(NOW + 179_000)!.samples;
        expect(history).toHaveLength(3);
        expect(history[0].t).toBe(NOW + 59_000);
        expect(history[2].t).toBe(NOW + 179_000);
    });
});
