/**
 * Distress beacons in the decoder and the store (build 125, package 125-02):
 *
 *  - AIS message 14 (safety-related broadcast) is decoded and its text kept
 *    against the MMSI, WITHOUT creating a positioned target: no 0,0 position
 *    reaches the chart or the guard.
 *  - AisStore.evictOldest and the 10-minute sweep never drop a beacon (a
 *    970/972/974 MMSI, or a target reporting status 14). It stays, its age
 *    shown wherever it is drawn.
 *
 * Real checksummed !AIVDM sentences built with the injector's encoder, so the
 * decoder's bit layout is what is tested. Fictional MMSIs only (970/972/974
 * with manufacturer 00, and MID 123, which is unallocated).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { processAisSentence } from '../services/AisDecoder';
import { AisStore } from '../services/AisStore';
import { encodeAisPositionReport, encodeAisSafetyText } from '../services/debug/aisInjector';

const SART = 970_000_201;
const MOB = 972_000_202;
const T0 = Date.UTC(2026, 9, 9, 6, 0, 0);

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    AisStore.stop();
    AisStore.start();
});

afterEach(() => {
    AisStore.stop();
    vi.useRealTimers();
});

describe('message 14', () => {
    it("decodes a SART's text against its MMSI, with no position at all", () => {
        const decoded = processAisSentence(encodeAisSafetyText(SART, 'SART ACTIVE'));
        expect(decoded).toMatchObject({ mmsi: SART, safetyText: 'SART ACTIVE' });
        expect(decoded).not.toHaveProperty('lat');
        expect(decoded).not.toHaveProperty('lon');
    });

    it('decodes a long text and a lower-case one as AIS sends them (upper case, 6-bit)', () => {
        const long = 'MOB TEST FROM A FICTIONAL CREW BEACON SERIAL 0202';
        expect(processAisSentence(encodeAisSafetyText(MOB, long))?.safetyText).toBe(long);
        expect(processAisSentence(encodeAisSafetyText(MOB, 'mob active'))?.safetyText).toBe('MOB ACTIVE');
    });

    it('keeps the text in the store but creates no target, so nothing is drawn at 0,0', () => {
        AisStore.update(processAisSentence(encodeAisSafetyText(SART, 'SART ACTIVE'))!);
        expect(AisStore.getTargets().has(SART)).toBe(false);
        expect(AisStore.toGeoJSON().features).toEqual([]);
        expect(AisStore.getSafetyText(SART)).toEqual({ text: 'SART ACTIVE', at: T0 });
        expect(AisStore.getLastHeardAt()).toBe(T0);
    });

    it("tells the store's listeners, so the distress watch hears it at once", () => {
        const listener = vi.fn();
        const unsubscribe = AisStore.subscribe(listener);
        AisStore.update(processAisSentence(encodeAisSafetyText(SART, 'SART ACTIVE'))!);
        expect(listener).toHaveBeenCalledTimes(1);
        unsubscribe();
    });

    it('joins the position report that follows, and carries the text on its chart feature', () => {
        AisStore.update(processAisSentence(encodeAisSafetyText(SART, 'SART ACTIVE'))!);
        vi.setSystemTime(T0 + 4_000);
        AisStore.update(
            processAisSentence(
                encodeAisPositionReport({
                    mmsi: SART,
                    navStatus: 14,
                    sogKn: 0.8,
                    lat: 57.15,
                    lon: -2.09,
                    cogDeg: 100,
                    headingDeg: null,
                }),
            )!,
        );
        const [feature] = AisStore.toGeoJSON().features;
        expect(feature.geometry.coordinates[0]).toBeCloseTo(-2.09, 4);
        expect(feature.properties).toMatchObject({
            mmsi: SART,
            navStatus: 14,
            safetyText: 'SART ACTIVE',
            safetyTextAt: T0,
        });
    });

    it('a newer text replaces the older one (test, then active)', () => {
        AisStore.update(processAisSentence(encodeAisSafetyText(SART, 'SART TEST'))!);
        vi.setSystemTime(T0 + 60_000);
        AisStore.update(processAisSentence(encodeAisSafetyText(SART, 'SART ACTIVE'))!);
        expect(AisStore.getSafetyText(SART)).toEqual({ text: 'SART ACTIVE', at: T0 + 60_000 });
    });
});

describe('a beacon is never dropped', () => {
    function position(mmsi: number, navStatus: number, lat = -17.75, lon = 177.4) {
        return processAisSentence(
            encodeAisPositionReport({ mmsi, navStatus, sogKn: 0.5, lat, lon, cogDeg: 90, headingDeg: null }),
        )!;
    }

    it('the 10-minute sweep drops a silent ship but keeps a silent beacon, test or active', () => {
        AisStore.update(position(SART, 15));
        AisStore.update(position(MOB, 14));
        AisStore.update(position(123_400_210, 0));
        AisStore.update(position(123_400_211, 14)); // status 14 from an unexpected MMSI: still a beacon
        AisStore.update(processAisSentence(encodeAisSafetyText(SART, 'SART TEST'))!);
        vi.advanceTimersByTime(11 * 60_000);
        expect([...AisStore.getTargets().keys()].sort()).toEqual([123_400_211, SART, MOB].sort());
        // Its text stays with it.
        expect(AisStore.getSafetyText(SART)?.text).toBe('SART TEST');
    });

    it("keeps a beacon's message 14 heard before any position, however long it waits", () => {
        AisStore.update(processAisSentence(encodeAisSafetyText(MOB, 'MOB ACTIVE'))!);
        vi.advanceTimersByTime(30 * 60_000);
        expect(AisStore.getSafetyText(MOB)?.text).toBe('MOB ACTIVE');
    });

    it("sweeps an ordinary station's safety text with its other stale reports", () => {
        AisStore.update(processAisSentence(encodeAisSafetyText(123_400_212, 'FIRING RANGE ACTIVE'))!);
        vi.advanceTimersByTime(11 * 60_000);
        expect(AisStore.getSafetyText(123_400_212)).toBeNull();
    });

    it('a full store evicts its oldest ship, never an older beacon', () => {
        AisStore.update(position(SART, 14));
        vi.setSystemTime(T0 + 1_000);
        for (let i = 0; i < 499; i++) AisStore.update(position(123_410_000 + i, 0, -17.7, 177.4 + i / 1000));
        expect(AisStore.getCount()).toBe(500);
        vi.setSystemTime(T0 + 2_000);
        AisStore.update(position(123_420_000, 0));
        expect(AisStore.getCount()).toBe(500);
        expect(AisStore.getTargets().has(SART)).toBe(true);
        expect(AisStore.getTargets().has(123_410_000)).toBe(false);
        expect(AisStore.getTargets().has(123_420_000)).toBe(true);
    });
});
