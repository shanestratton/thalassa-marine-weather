import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NmeaSample } from '../types';

vi.mock('../services/NmeaGpsProvider', () => ({ NmeaGpsProvider: { start: vi.fn(), stop: vi.fn() } }));
vi.mock('../services/AisStore', () => ({ AisStore: { start: vi.fn(), stop: vi.fn() } }));
vi.mock('../services/AisHubService', () => ({ AisHubService: { init: vi.fn(), destroy: vi.fn() } }));
vi.mock('../services/AisShareService', () => ({ offer: vi.fn(), reportLink: vi.fn() }));

import { NmeaListenerService } from '../services/NmeaListenerService';
import { NmeaStore, NMEA_USABLE_MAX_AGE_MS } from '../services/NmeaStore';
import { snapshotFromWire } from '../services/telemetryWire';

const NOW = Date.parse('2026-09-24T06:00:00Z');
interface ListenerHarness {
    status: 'disconnected' | 'connected';
    accumulator: unknown;
    freshAccumulator(): unknown;
    parseNmeaSentence(sentence: string): void;
    emitSample(): void;
    setStatus(status: 'disconnected' | 'connected'): void;
}
const listener = NmeaListenerService as unknown as ListenerHarness;
const sentence = (body: string): string => {
    let sum = 0;
    for (const ch of body) sum ^= ch.charCodeAt(0);
    return `$${body}*${sum.toString(16).toUpperCase().padStart(2, '0')}`;
};
const feed = (...bodies: string[]) => bodies.forEach((body) => listener.parseNmeaSentence(sentence(body)));
const wire = (extra: Record<string, unknown> = {}, via: 'lan' | 'cloud' = 'lan') =>
    snapshotFromWire({ source: 'pi', reported_at: new Date(Date.now()).toISOString(), heading_deg: 88, extra }, via)!
        .snapshot;

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    listener.status = 'disconnected';
    listener.accumulator = listener.freshAccumulator();
    NmeaStore.stop();
});
afterEach(() => {
    NmeaStore.stop();
    listener.status = 'disconnected';
    listener.accumulator = listener.freshAccumulator();
    vi.useRealTimers();
});

describe('qualified true heading on the direct NMEA feed', () => {
    const startDirect = () => {
        listener.status = 'connected';
        NmeaStore.start();
    };

    it('keeps HDT/VHW true bearings separate from magnetic HDG and HDM', () => {
        startDirect();
        feed('YDHDT,0.0,T', 'YDVHW,0.0,T,349.0,M,0.0,N,0.0,K', 'YDHDG,180.0,,,,', 'YDHDM,180.0,M');
        listener.emitSample();
        expect(NmeaStore.getState().headingTrue).toEqual({ value: 0, lastUpdated: NOW, freshness: 'live' });
        // The legacy gauge accumulator remains available, but is never the
        // source of the true-north map heading.
        expect(NmeaStore.getState().headingTrue.value).not.toBe(180);
    });

    it('retains the heading sentence time when newer depth arrives before emission', () => {
        startDirect();
        feed('YDHDT,91.0,T');
        vi.setSystemTime(NOW + 4_000);
        feed('YDDPT,10.0,0.0,');
        listener.emitSample();
        expect(NmeaStore.getState().headingTrue).toMatchObject({ value: 91, lastUpdated: NOW });
        expect(NmeaStore.getState().depth.value).toBe(10);
    });

    it('averages only qualified headings circularly and accepts north at 360', () => {
        startDirect();
        feed('YDHDT,359.0,T', 'YDHDT,1.0,T', 'YDHDM,90.0,M');
        listener.emitSample();
        expect(NmeaStore.getState().headingTrue.value).toBeCloseTo(0, 5);
        feed('YDHDT,360.0,T');
        listener.emitSample();
        expect(NmeaStore.getState().headingTrue.value).toBe(0);
    });

    it.each(['YDHDT,45.0,M', 'YDHDT,45.0,', 'YDHDT,375.5,T', 'YDHDT,,T', 'YDVHW,,T,45.0,M,0.0,N,0.0,K'])(
        'explicit unknown/invalid true reading %s clears an earlier value',
        (invalid) => {
            startDirect();
            feed('YDHDT,45.0,T');
            listener.emitSample();
            feed(invalid);
            listener.emitSample();
            expect(NmeaStore.getState().headingTrue.value).toBeNull();
        },
    );

    it('an invalid later sentence cannot re-age an earlier true heading within one window', () => {
        startDirect();
        feed('YDHDT,45.0,T');
        vi.setSystemTime(NOW + 4_000);
        feed('YDHDT,,T');
        listener.emitSample();
        expect(NmeaStore.getState().headingTrue.value).toBeNull();
    });

    it('a magnetic-only sample never borrows the previous true heading', () => {
        startDirect();
        feed('YDHDT,45.0,T');
        listener.emitSample();
        feed('YDHDG,110.0,,,,');
        listener.emitSample();
        expect(NmeaStore.getState().heading.value).toBe(110);
        expect(NmeaStore.getState().headingTrue.value).toBeNull();
    });

    it('publishes an explicitly invalid true reading even without another instrument', () => {
        startDirect();
        const samples: NmeaSample[] = [];
        const unsubscribe = NmeaListenerService.onSample((sample) => samples.push(sample));
        feed('YDHDT,,T');
        listener.emitSample();
        unsubscribe();
        expect(samples).toHaveLength(1);
        expect(samples[0]).toMatchObject({ headingTrue: null, headingTrueAt: NOW });
    });
});

describe('qualified true heading across Pi LAN/cloud snapshots', () => {
    it('uses only explicit true metadata and preserves the original sensor time', () => {
        const snapshot = wire({ heading_true_deg: 0, heading_true_at_ms: NOW - 4_000 });
        expect(snapshot).toMatchObject({ headingDeg: 88, headingTrueDeg: 0, headingTrueAt: NOW - 4_000 });
        NmeaStore.ingestRemote(snapshot);
        expect(NmeaStore.getState().headingTrue).toEqual({ value: 0, lastUpdated: NOW - 4_000, freshness: 'live' });
    });

    it('does not substitute the row/receipt time for a missing heading timestamp', () => {
        NmeaStore.ingestRemote(wire({ heading_true_deg: 94 }));
        expect(NmeaStore.getState().heading.value).toBe(88);
        expect(NmeaStore.getState().headingTrue.value).toBeNull();
        NmeaStore.ingestRemote(wire());
        expect(NmeaStore.getState().headingTrue.value).toBeNull();
    });

    it.each([
        { heading_true_deg: 360, heading_true_at_ms: NOW },
        { heading_true_deg: -1, heading_true_at_ms: NOW },
        { heading_true_deg: Number.NaN, heading_true_at_ms: NOW },
        { heading_true_deg: '90', heading_true_at_ms: NOW },
        { heading_true_deg: 90, heading_true_at_ms: NOW + 60_000 },
        { heading_true_deg: 90, heading_true_at_ms: 0 },
        { heading_true_deg: 90, heading_true_at_ms: NOW - NMEA_USABLE_MAX_AGE_MS - 1 },
    ])('rejects invalid/out-of-budget qualified metadata %j', (extra) => {
        NmeaStore.ingestRemote(wire(extra));
        expect(NmeaStore.getState().headingTrue.value).toBeNull();
    });

    it('repeated cached snapshots age out instead of becoming fresh on each poll', () => {
        const extra = { heading_true_deg: 120, heading_true_at_ms: NOW };
        NmeaStore.ingestRemote(wire(extra));
        vi.setSystemTime(NOW + 8_000);
        NmeaStore.ingestRemote(wire(extra));
        expect(NmeaStore.getState().headingTrue).toEqual({ value: 120, lastUpdated: NOW, freshness: 'stale' });
        vi.setSystemTime(NOW + 14_000);
        NmeaStore.ingestRemote(wire(extra));
        expect(NmeaStore.getState().headingTrue.value).toBeNull();
    });

    it('expires through the watchdog even if no more snapshots arrive', async () => {
        NmeaStore.start();
        NmeaStore.ingestRemote(wire({ heading_true_deg: 120, heading_true_at_ms: NOW }));
        await vi.advanceTimersByTimeAsync(14_000);
        expect(NmeaStore.getState().headingTrue.value).toBeNull();
        expect(NmeaStore.getState().headingTrue.freshness).toBe('dead');
    });

    it('switching cloud to LAN without qualified metadata clears the cloud heading', () => {
        NmeaStore.ingestRemote(wire({ heading_true_deg: 120, heading_true_at_ms: NOW }, 'cloud'));
        NmeaStore.ingestRemote(wire({}, 'lan'));
        expect(NmeaStore.getState().headingTrue.value).toBeNull();
    });

    it('direct takeover clears remote heading before the first direct sentence', () => {
        NmeaStore.start();
        NmeaStore.ingestRemote(wire({ heading_true_deg: 120, heading_true_at_ms: NOW }));
        listener.setStatus('connected');
        expect(NmeaStore.getState().headingTrue.value).toBeNull();
    });

    it('clearing the feed retires its qualified heading', () => {
        NmeaStore.ingestRemote(wire({ heading_true_deg: 120, heading_true_at_ms: NOW }));
        NmeaStore.clearRemote('lan');
        expect(NmeaStore.getState().headingTrue).toEqual({ value: null, lastUpdated: 0, freshness: 'dead' });
    });
});
