import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NmeaSample } from '../types';

const listener = vi.hoisted(() => ({
    sample: null as ((sample: NmeaSample) => void) | null,
    status: 'disconnected',
}));
vi.mock('../services/NmeaListenerService', () => ({
    NmeaListenerService: {
        getStatus: () => listener.status,
        getSavedConfig: () => null,
        onSample: (cb: (sample: NmeaSample) => void) => {
            listener.sample = cb;
            return vi.fn();
        },
        onStatusChange: () => vi.fn(),
    },
}));
vi.mock('../services/NmeaGpsProvider', () => ({ NmeaGpsProvider: { start: vi.fn(), stop: vi.fn() } }));
vi.mock('../services/AisStore', () => ({ AisStore: { start: vi.fn(), stop: vi.fn() } }));
vi.mock('../services/AisHubService', () => ({ AisHubService: { init: vi.fn(), destroy: vi.fn() } }));

import { NmeaStore } from '../services/NmeaStore';
import { snapshotFromWire } from '../services/telemetryWire';
import { setAuthIdentityScope } from '../services/authIdentityScope';

const now = Date.parse('2026-09-21T00:19:40Z');
const extra = {
    gnss_source: 'ydwg-tcp.YD',
    gnss_satellites: 32,
    gnss_satellites_at_ms: now - 1_000,
    gnss_hdop: 0.47,
    gnss_hdop_at_ms: now - 2_000,
    gnss_fix_quality: 2,
    gnss_fix_quality_at_ms: now - 3_000,
};
const snapshot = (fields: Record<string, unknown> = extra, via: 'lan' | 'cloud' = 'lan') =>
    snapshotFromWire(
        {
            source: 'pi',
            reported_at: new Date(Date.now()).toISOString(),
            lat: -27.2,
            lon: 153.1,
            extra: fields,
        },
        via,
    )!.snapshot;

describe('GNSS diagnostics across the Pi wire and store', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(now);
        listener.status = 'disconnected';
        NmeaStore.stop();
        NmeaStore.clearRemote();
        setAuthIdentityScope('gnss-owner');
        NmeaStore.start();
    });
    afterEach(() => {
        NmeaStore.stop();
        vi.useRealTimers();
    });

    it('LAN and cloud parse the same real values with separate original timestamps', () => {
        expect(snapshot().gnss).toEqual(snapshot(extra, 'cloud').gnss);
        NmeaStore.ingestRemote(snapshot());
        expect(NmeaStore.getState()).toMatchObject({
            satellites: { value: 32, lastUpdated: now - 1_000 },
            hdop: { value: 0.47, lastUpdated: now - 2_000 },
            gpsFixQuality: 2,
            gpsFixQualityUpdatedAt: now - 3_000,
            gpsSource: 'ydwg-tcp.YD',
            gpsAccuracyM: { value: null },
        });
    });

    it('keeps stale position time separate from a fresh row/ZDA clock without changing operational GPS timestamps', () => {
        const positionSampleAt = now - 120_000;
        for (const via of ['lan', 'cloud'] as const) {
            const reading = snapshot({ ...extra, position_at: positionSampleAt }, via);
            expect(reading.positionSampleAt).toBe(positionSampleAt);
            NmeaStore.clearRemote();
            NmeaStore.ingestRemote(reading);
            expect(NmeaStore.getState().remote).toMatchObject({ reportedAt: now, positionSampleAt });
            // This task changes diagnostic provenance only, not GPS provider policy.
            expect(NmeaStore.getState().latitude.lastUpdated).toBe(now);
            expect(NmeaStore.getState().latitude.freshness).toBe('live');
        }
    });

    it('never substitutes reported/receipt time for absent or invalid position metadata', () => {
        NmeaStore.ingestRemote(snapshot({ ...extra, position_at: now - 120_000 }));
        for (const position_at of [undefined, null, '2026-09-21T00:19:40Z', 0, -1, NaN, Infinity, now + 1_001]) {
            const reading = snapshot({ ...extra, position_at });
            expect(reading.positionSampleAt).toBeUndefined();
            NmeaStore.ingestRemote(reading);
            expect(NmeaStore.getState().remote?.reportedAt).toBe(now);
            expect(NmeaStore.getState().remote?.positionSampleAt).toBeUndefined();
        }
        NmeaStore.ingestRemote({ ...snapshot(), positionSampleAt: now + 2_000 });
        expect(NmeaStore.getState().remote?.positionSampleAt).toBeUndefined();
        NmeaStore.ingestRemote({ ...snapshot(), lat: null, lon: null, positionSampleAt: now });
        expect(NmeaStore.getState().remote?.positionSampleAt).toBeUndefined();
        expect(
            snapshotFromWire({ reported_at: new Date(now).toISOString(), extra: { position_at: now } }, 'lan')?.snapshot
                .positionSampleAt,
        ).toBeUndefined();
    });

    it('repeated fresh rows cannot freshen old GNSS diagnostics', () => {
        NmeaStore.ingestRemote(snapshot());
        vi.advanceTimersByTime(8_000);
        NmeaStore.ingestRemote(snapshot());
        expect(NmeaStore.getState().satellites.freshness).toBe('stale');
        expect(NmeaStore.getState().gpsFixQualityUpdatedAt).toBe(now - 3_000);
        vi.advanceTimersByTime(5_001);
        NmeaStore.ingestRemote(snapshot());
        expect(NmeaStore.getState().satellites.value).toBeNull();
        expect(NmeaStore.getState().gpsFixQuality).toBeNull();
    });

    it('never inherits omitted metrics when switching receiver or using an old Pi payload', () => {
        NmeaStore.ingestRemote(snapshot());
        NmeaStore.ingestRemote(
            snapshot({ gnss_source: 'ublox-gps.GP', gnss_satellites: 11, gnss_satellites_at_ms: now }),
        );
        expect(NmeaStore.getState().gpsSource).toBe('ublox-gps.GP');
        expect(NmeaStore.getState().hdop.value).toBeNull();
        expect(NmeaStore.getState().gpsFixQuality).toBeNull();
        NmeaStore.ingestRemote(snapshot({}));
        expect(NmeaStore.getState().gpsSource).toBeNull();
        expect(NmeaStore.getState().satellites.value).toBeNull();
    });

    it('ages direct GGA quality on its own even while other GPS samples keep arriving', () => {
        listener.sample?.({
            timestamp: now,
            latitude: -27.2,
            longitude: 153.1,
            gpsFixQuality: 2,
            satellites: 32,
            hdop: 0.47,
        } as NmeaSample);
        vi.advanceTimersByTime(10_000);
        listener.sample?.({
            timestamp: now + 10_000,
            latitude: -27.2,
            longitude: 153.1,
            gpsFixQuality: null,
            satellites: 30,
            hdop: null,
        } as NmeaSample);
        vi.advanceTimersByTime(4_000);
        expect(NmeaStore.getState().gpsFixQuality).toBeNull();
        expect(NmeaStore.getState().satellites.value).toBe(30);
        NmeaStore.ingestRemote(snapshot({}));
        expect(NmeaStore.getState().satellites.value).toBeNull();
    });

    it('retains direct GGA time instead of the aggregate time advanced by another instrument', () => {
        listener.sample?.({
            timestamp: now,
            gpsDiagnosticsAt: now - 4_000,
            gpsFixQuality: 2,
            satellites: 32,
            hdop: 0.47,
        } as NmeaSample);
        expect(NmeaStore.getState()).toMatchObject({
            gpsFixQualityUpdatedAt: now - 4_000,
            satellites: { lastUpdated: now - 4_000 },
            hdop: { lastUpdated: now - 4_000 },
        });
    });

    it('keeps an actual no-fix GGA diagnostic without coordinates until its own time expires', () => {
        listener.sample?.({
            timestamp: now,
            gpsDiagnosticsAt: now,
            latitude: null,
            longitude: null,
            gpsFixQuality: 0,
            satellites: 0,
            hdop: 99.9,
        } as NmeaSample);
        vi.advanceTimersByTime(1_000);
        expect(NmeaStore.getState().gpsFixQuality).toBe(0);
        expect(NmeaStore.getState().gpsFixQualityUpdatedAt).toBe(now);
        expect(NmeaStore.getState().latitude.value).toBeNull();
        vi.advanceTimersByTime(13_000);
        expect(NmeaStore.getState().gpsFixQuality).toBeNull();
    });

    it('rejects invalid/future values and accepts real zero without inventing metre accuracy', () => {
        NmeaStore.ingestRemote(snapshot({ ...extra, gnss_satellites: 0, gnss_fix_quality: 0, gnss_hdop: -1 }));
        expect(NmeaStore.getState().satellites.value).toBe(0);
        expect(NmeaStore.getState().gpsFixQuality).toBe(0);
        expect(NmeaStore.getState().hdop.value).toBeNull();
        NmeaStore.ingestRemote(
            snapshot({
                ...extra,
                gnss_satellites_at_ms: now + 1_001,
                gnss_accuracy_m: 2.4,
                gnss_accuracy_m_at_ms: now,
            }),
        );
        expect(NmeaStore.getState().satellites.value).toBeNull();
        expect(NmeaStore.getState().gpsAccuracyM.value).toBe(2.4);
        expect(snapshot({ ...extra, gnss_source: '' }).gnss).toBeUndefined();
        expect(snapshot({ ...extra, gnss_fix_quality: 9 }).gnss?.fixQuality).toBeUndefined();
    });

    it('respects LAN precedence and clears diagnostics on account transition or feed loss', () => {
        NmeaStore.ingestRemote(snapshot());
        expect(NmeaStore.ingestRemote(snapshot({ ...extra, gnss_satellites: 11 }, 'cloud'))).toBe(false);
        expect(NmeaStore.getState().satellites.value).toBe(32);
        setAuthIdentityScope('other-gnss-owner');
        expect(NmeaStore.getState().gpsSource).toBeNull();
        expect(NmeaStore.getState().gpsFixQuality).toBeNull();
        NmeaStore.ingestRemote(snapshot());
        NmeaStore.clearRemote('lan');
        expect(NmeaStore.getState().satellites.value).toBeNull();
    });
});
