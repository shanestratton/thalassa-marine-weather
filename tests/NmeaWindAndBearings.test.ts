/**
 * Wind and bearings, driven through the real transport.
 *
 * Every sentence here is copied verbatim off Serene Summer's YDWG-02
 * (2026-08-08). All three faults these pin were live on the boat:
 *
 *   - apparent wind was read off the wire and discarded, so the panel's
 *     APPARENT WINDS tile was permanently blank;
 *   - MWD — the only sentence that gives wind as a compass bearing — was not
 *     in the supported set, so there was no wind direction at all;
 *   - bearings were averaged arithmetically, which is wrong everywhere and
 *     catastrophically wrong at north, exactly where the boat was moored.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { NmeaSample } from '../types';

vi.mock('@capacitor/core', () => ({
    Capacitor: { isNativePlatform: () => false, getPlatform: () => 'web' },
    registerPlugin: () => ({}),
}));

class FakeWebSocket {
    static last: FakeWebSocket | null = null;
    onopen: (() => void) | null = null;
    onmessage: ((e: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: (() => void) | null = null;
    close = vi.fn();
    constructor(public url: string) {
        FakeWebSocket.last = this;
    }
    feed(sentences: string[]) {
        this.onmessage?.({ data: sentences.join('\r\n') });
    }
}
vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket);

import { NmeaListenerService } from '../services/NmeaListenerService';
import { NMEA_SAMPLE_INTERVAL_MS } from '../services/nmea/nmeaCadence';

/**
 * Build a sentence with a CORRECT checksum. The validator rejects a malformed
 * one outright (rightly — a bad checksum is never treated as an absent one),
 * so hand-written hex in a fixture silently tests nothing at all.
 */
const nmea = (body: string): string => {
    let sum = 0;
    for (const ch of body) sum ^= ch.charCodeAt(0);
    return `$${body}*${sum.toString(16).toUpperCase().padStart(2, '0')}`;
};

/** Feed sentences, run the emit tick, return the sample the service produced. */
async function sampleFrom(sentences: string[]): Promise<NmeaSample> {
    const received: NmeaSample[] = [];
    const unsub = NmeaListenerService.onSample((s) => received.push(s));
    NmeaListenerService.configure('192.168.1.151', 1456);
    NmeaListenerService.start();
    FakeWebSocket.last!.onopen?.();
    FakeWebSocket.last!.feed(sentences);
    await vi.advanceTimersByTimeAsync(NMEA_SAMPLE_INTERVAL_MS + 50);
    unsub();
    expect(received.length).toBeGreaterThan(0);
    return received[received.length - 1];
}

beforeEach(() => {
    vi.useFakeTimers();
});
afterEach(() => {
    NmeaListenerService.stop();
    vi.useRealTimers();
});

describe('apparent wind', () => {
    it('captures MWV,R instead of dropping it on the floor', async () => {
        const s = await sampleFrom([nmea('YDMWV,112.1,R,2.9,M,A')]);
        expect(s.aws).toBeCloseTo(2.9 * 1.94384, 2); // m/s → knots
        expect(s.awa).toBeCloseTo(112.1, 1);
    });

    it('signs the angle to port so the rose can draw a side', async () => {
        const s = await sampleFrom([nmea('YDMWV,285.0,R,10.0,N,A')]);
        // 285 off the bow is 75 degrees to PORT, not 285 clockwise.
        expect(s.awa).toBeCloseTo(-75, 1);
        expect(s.aws).toBeCloseTo(10, 2);
    });

    it('ignores an invalid-status sentence', async () => {
        // Paired with a good depth sentence on purpose: an invalid MWV alone
        // accumulates nothing, so no sample is emitted at all — correct, but it
        // leaves nothing to assert against. This proves the wind fields stay
        // null while the rest of the sample still arrives.
        const s = await sampleFrom([nmea('YDMWV,112.1,R,2.9,M,V'), nmea('YDDPT,3.04,-1.79,')]);
        expect(s.depth).not.toBeNull();
        expect(s.aws).toBeNull();
        expect(s.awa).toBeNull();
    });
});

describe('true wind', () => {
    it('keeps twa an unsigned magnitude for the polars, and signs twaSigned', async () => {
        const s = await sampleFrom([nmea('YDMWV,300.0,T,12.0,N,A')]);
        // SmartPolarStore buckets on `twa`; polars are symmetric, so it must
        // stay 0-180 or every learned bucket silently moves.
        expect(s.twa).toBeCloseTo(60, 1);
        expect(s.twaSigned).toBeCloseTo(-60, 1);
        expect(s.tws).toBeCloseTo(12, 2);
    });

    it('reads wind DIRECTION out of MWD', async () => {
        const s = await sampleFrom([nmea('YDMWD,128.1,T,117.1,M,5.7,N,2.9,M')]);
        expect(s.twd).toBeCloseTo(128.1, 1);
    });

    it('does not let MWD speed fight MWV,T speed when a boat sends both', async () => {
        const s = await sampleFrom([nmea('YDMWV,90.0,T,12.0,N,A'), nmea('YDMWD,128.1,T,117.1,M,5.7,N,2.9,M')]);
        expect(s.twd).toBeCloseTo(128.1, 1);
        expect(s.tws).toBeCloseTo(12, 2); // MWV's 12, not averaged with MWD's 5.7
    });

    it('falls back to MWD speed when MWV,T is absent', async () => {
        const s = await sampleFrom([nmea('YDMWD,128.1,T,117.1,M,5.7,N,2.9,M')]);
        expect(s.tws).toBeCloseTo(5.7, 2);
    });
});

describe('bearings are averaged circularly', () => {
    it('averages a heading straddling north to north, not south', async () => {
        // THE bug: the arithmetic mean of 359 and 001 is 180. Serene Summer was
        // moored on 004 degrees magnetic when the compass was reported wrong.
        const s = await sampleFrom([nmea('YDHDT,359.0,T'), nmea('YDHDT,1.0,T'), nmea('YDHDT,359.5,T')]);
        expect(s.heading).not.toBeNull();
        const h = s.heading!;
        // Within a couple of degrees of north, from either side of the wrap.
        expect(Math.min(h, 360 - h)).toBeLessThan(3);
    });

    it('still averages an ordinary heading the obvious way', async () => {
        const s = await sampleFrom([nmea('YDHDT,090.0,T'), nmea('YDHDT,094.0,T')]);
        expect(s.heading).toBeCloseTo(92, 0);
    });

    it('averages COG across the wrap too', async () => {
        const s = await sampleFrom([
            nmea('YDRMC,041153.00,A,2712.3137,S,15305.5836,E,5.0,358.0,080826,11.0,E,A,C'),
            nmea('YDRMC,041154.00,A,2712.3137,S,15305.5836,E,5.0,002.0,080826,11.0,E,A,C'),
        ]);
        expect(s.cog).not.toBeNull();
        const c = s.cog!;
        expect(Math.min(c, 360 - c)).toBeLessThan(3);
    });
});
