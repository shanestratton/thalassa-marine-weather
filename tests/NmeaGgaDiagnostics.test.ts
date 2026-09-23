import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NmeaSample } from '../types';

vi.mock('@capacitor/core', () => ({
    Capacitor: { isNativePlatform: () => false, getPlatform: () => 'web' },
    registerPlugin: () => ({}),
}));

class FakeWebSocket {
    static last: FakeWebSocket | null = null;
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: (() => void) | null = null;
    close = vi.fn();
    constructor(public url: string) {
        FakeWebSocket.last = this;
    }
    feed(...bodies: string[]) {
        this.onmessage?.({ data: bodies.map(nmea).join('\r\n') });
    }
}
vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket);

import { NmeaListenerService } from '../services/NmeaListenerService';
import { NMEA_SAMPLE_INTERVAL_MS } from '../services/nmea/nmeaCadence';

const NOW = Date.parse('2026-09-21T01:00:00Z');
const GOOD_GGA = 'YDGGA,010000.00,2712.3137,S,15305.5836,E,2,32,0.47,0,M,0,M,,';
const NO_FIX_GGA = 'YDGGA,010005.00,2800.0000,S,15400.0000,E,0,00,99.9,0,M,0,M,,';
const DEPTH = 'YDDPT,3.04,-1.79,';

function nmea(body: string): string {
    let checksum = 0;
    for (const char of body) checksum ^= char.charCodeAt(0);
    return `$${body}*${checksum.toString(16).toUpperCase().padStart(2, '0')}`;
}

let samples: NmeaSample[];
let unsubscribe: () => void;

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    samples = [];
    unsubscribe = NmeaListenerService.onSample((sample) => samples.push(sample));
    NmeaListenerService.configure('192.168.1.151', 1456);
    NmeaListenerService.start();
    FakeWebSocket.last!.onopen?.();
});

afterEach(() => {
    unsubscribe();
    NmeaListenerService.stop();
    vi.useRealTimers();
});

describe('GGA diagnostics through the real sentence parser', () => {
    it('publishes loss of fix and zero satellites without accepting invalid coordinates', async () => {
        FakeWebSocket.last!.feed(GOOD_GGA);
        await vi.advanceTimersByTimeAsync(NMEA_SAMPLE_INTERVAL_MS);
        expect(samples[0]).toMatchObject({ gpsFixQuality: 2, satellites: 32, hdop: 0.47 });
        expect(samples[0].latitude).toBeCloseTo(-27.2052283333);

        // No depth/wind/RMC companion: no-fix diagnostics must emit by themselves.
        FakeWebSocket.last!.feed(NO_FIX_GGA);
        await vi.advanceTimersByTimeAsync(NMEA_SAMPLE_INTERVAL_MS);
        expect(samples).toHaveLength(2);
        expect(samples[1]).toMatchObject({
            gpsFixQuality: 0,
            satellites: 0,
            hdop: 99.9,
            gpsDiagnosticsAt: NOW + NMEA_SAMPLE_INTERVAL_MS,
            latitude: null,
            longitude: null,
        });
    });

    it('keeps the GGA observation time when unrelated sentences arrive before publication', async () => {
        FakeWebSocket.last!.feed(GOOD_GGA);
        await vi.advanceTimersByTimeAsync(4_000);
        FakeWebSocket.last!.feed(DEPTH);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(samples[0]).toMatchObject({ gpsDiagnosticsAt: NOW, gpsFixQuality: 2, hdop: 0.47, depth: 1.25 });
        expect(samples[0].timestamp).toBeGreaterThan(samples[0].gpsDiagnosticsAt!);

        FakeWebSocket.last!.feed(DEPTH);
        await vi.advanceTimersByTimeAsync(NMEA_SAMPLE_INTERVAL_MS);
        expect(samples[1]).toMatchObject({
            gpsFixQuality: null,
            satellites: null,
            hdop: null,
            gpsDiagnosticsAt: null,
        });
    });

    it('does not freshen an earlier diagnostic tuple from a later partial GGA', async () => {
        FakeWebSocket.last!.feed(GOOD_GGA);
        await vi.advanceTimersByTimeAsync(4_000);
        FakeWebSocket.last!.feed('YDGGA,010004.00,,,,,0,,,0,M,0,M,,');
        await vi.advanceTimersByTimeAsync(1_000);
        expect(samples[0]).toMatchObject({
            gpsFixQuality: 0,
            satellites: null,
            hdop: null,
            gpsDiagnosticsAt: NOW + 4_000,
        });
        // A no-fix sentence does not overwrite a valid position already seen.
        expect(samples[0].latitude).toBeCloseTo(-27.2052283333);
        expect(samples[0].longitude).toBeCloseTo(153.09306);
    });

    it('preserves a valid RMC position alongside a current GGA no-fix report', async () => {
        FakeWebSocket.last!.feed('YDRMC,010000.00,A,2712.3137,S,15305.5836,E,5.0,90.0,210926,11.0,E,A,C', NO_FIX_GGA);
        await vi.advanceTimersByTimeAsync(NMEA_SAMPLE_INTERVAL_MS);
        expect(samples[0]).toMatchObject({ gpsFixQuality: 0, satellites: 0, sog: 5, cog: 90 });
        expect(samples[0].latitude).toBeCloseTo(-27.2052283333);
        expect(samples[0].longitude).toBeCloseTo(153.09306);
    });

    it.each(['', '-1', '1.5', '9'])('rejects malformed/out-of-range quality %j', async (quality) => {
        FakeWebSocket.last!.feed(`YDGGA,010000.00,2712.3137,S,15305.5836,E,${quality},32,0.47,0,M,0,M,,`, DEPTH);
        await vi.advanceTimersByTimeAsync(NMEA_SAMPLE_INTERVAL_MS);
        expect(samples[0]).toMatchObject({
            gpsFixQuality: null,
            satellites: null,
            hdop: null,
            gpsDiagnosticsAt: null,
            latitude: null,
            longitude: null,
        });
    });

    it('rejects invalid satellite/HDOP numbers without discarding a valid position', async () => {
        FakeWebSocket.last!.feed('YDGGA,010000.00,2712.3137,S,15305.5836,E,2,999,-1,0,M,0,M,,');
        await vi.advanceTimersByTimeAsync(NMEA_SAMPLE_INTERVAL_MS);
        expect(samples[0]).toMatchObject({ gpsFixQuality: 2, satellites: null, hdop: null, gpsDiagnosticsAt: NOW });
        expect(samples[0].latitude).toBeCloseTo(-27.2052283333);
    });
});
