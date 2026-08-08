/**
 * The blind-watch alarm has to name the CAUSE.
 *
 * Shane, 2026-08-08, testing indoors: "i am getting a lot of GPS lost". The
 * alarm was correct — an iPhone inside a house produces fixes at ±100 m or
 * worse, every one refused as too coarse to resolve a swing circle — but it
 * said "No GPS fix is arriving", which is not what was happening and points at
 * the wrong remedy. Fixes were arriving constantly.
 *
 * Two situations hide behind that one sentence and they need opposite actions:
 * get the phone under sky, or go and look at the gateway. These tests pin that
 * the wording separates them.
 */
import { describe, expect, it } from 'vitest';
import { describeBlindGps, type BlindGpsFacts } from '../services/anchorGpsWatchdog';

const NOW = 1_754_600_000_000;

const facts = (over: Partial<BlindGpsFacts> = {}): BlindGpsFacts => ({
    nowMs: NOW,
    lastUsableFixAt: { native: null, nmea: null },
    lastRejection: null,
    nmeaFeedStatus: 'unavailable',
    swingRadiusM: 35,
    accuracyLimitM: 50,
    ...over,
});

describe('describeBlindGps', () => {
    it('says the fixes are too COARSE when that is what is happening', () => {
        const msg = describeBlindGps(
            facts({ lastRejection: { source: 'native', reason: 'accuracy', accuracy: 137.4, at: NOW - 2_000 } }),
        );
        expect(msg).toContain('±137 m');
        expect(msg).toContain('35 m swing circle');
        expect(msg).toContain('±50 m');
        // The actionable half — and never the misleading claim.
        expect(msg).toMatch(/see sky|clear view of the sky/i);
        expect(msg).not.toMatch(/no gps fix is arriving/i);
    });

    it('names which receiver produced the coarse fix', () => {
        expect(
            describeBlindGps(facts({ lastRejection: { source: 'native', reason: 'accuracy', accuracy: 90, at: NOW } })),
        ).toContain('this phone');
        expect(
            describeBlindGps(facts({ lastRejection: { source: 'nmea', reason: 'accuracy', accuracy: 90, at: NOW } })),
        ).toContain('boat’s GPS');
    });

    it('points at the gateway when a working NMEA feed stops', () => {
        const msg = describeBlindGps(
            facts({ nmeaFeedStatus: 'unavailable', lastUsableFixAt: { native: null, nmea: NOW - 240_000 } }),
        );
        expect(msg).toMatch(/boat’s GPS feed stopped/i);
        expect(msg).toContain('4 min ago');
        expect(msg).toMatch(/gateway/i);
    });

    it('distinguishes a quiet feed from a dead one', () => {
        const msg = describeBlindGps(
            facts({ nmeaFeedStatus: 'stale', lastUsableFixAt: { native: null, nmea: NOW - 30_000 } }),
        );
        expect(msg).toMatch(/gone quiet/i);
        expect(msg).toContain('30s ago');
    });

    it('handles the cold case — armed, and nothing usable ever arrived', () => {
        const msg = describeBlindGps(facts());
        expect(msg).toMatch(/No NMEA feed/i);
        expect(msg).toMatch(/since the watch was armed/i);
    });

    it('never blames the boat when the phone is the one being refused', () => {
        // The whole point: an indoors phone must not send the skipper to the
        // gateway, which is fine.
        const msg = describeBlindGps(
            facts({
                nmeaFeedStatus: 'unavailable',
                lastRejection: { source: 'native', reason: 'accuracy', accuracy: 120, at: NOW },
            }),
        );
        expect(msg).not.toMatch(/gateway/i);
        expect(msg).toContain('this phone');
    });
});

// ── Cross-source handover ───────────────────────────────────────────────

import { checkSourceHandover, SOURCE_HANDOVER_WINDOW_MS } from '../services/anchorGpsWatchdog';

/** Metres between two points, good enough at these distances. */
const metres = (aLat: number, aLon: number, bLat: number, bLon: number): number => {
    const R = 6_371_000;
    const dLat = ((bLat - aLat) * Math.PI) / 180;
    const dLon = ((bLon - aLon) * Math.PI) / 180;
    const mLat = ((aLat + bLat) / 2) * (Math.PI / 180);
    const x = dLon * Math.cos(mLat);
    return Math.sqrt(dLat * dLat + x * x) * R;
};

const ANCHORAGE = { latitude: -27.2085, longitude: 153.0875 };
/** Roughly 3 km away — a house ashore. */
const ASHORE = { latitude: -27.2355, longitude: 153.0875 };

const handover = (over: Partial<Parameters<typeof checkSourceHandover>[0]> = {}) =>
    checkSourceHandover({
        nowMs: NOW,
        lastNmea: { ...ANCHORAGE, at: NOW - 20_000 },
        candidate: { ...ANCHORAGE, accuracy: 8 },
        swingRadiusM: 35,
        distanceM: metres,
        ...over,
    });

describe('checkSourceHandover', () => {
    it('allows the phone to take over when it is on the boat', () => {
        expect(handover()).toBeNull();
    });

    it('refuses a phone sitting ashore, kilometres from the vessel', () => {
        // THE case this exists for: the socket dies when the screen locks, and
        // twelve seconds later the watch would be measuring the house.
        const result = handover({ candidate: { ...ASHORE, accuracy: 8 } });
        expect(result).not.toBeNull();
        expect(result!.separationM).toBeGreaterThan(2_000);
    });

    it('refuses a phone NEAR the anchorage but outside the plausible circle', () => {
        // The dangerous one — close enough to look reasonable, far enough that
        // it would mask a drag rather than report one.
        const nearby = { latitude: -27.2095, longitude: 153.0875, accuracy: 8 }; // ~110 m
        expect(handover({ candidate: nearby })).not.toBeNull();
    });

    it('never blocks a phone-only watch, which has no boat GPS to compare with', () => {
        expect(handover({ lastNmea: null, candidate: { ...ASHORE, accuracy: 8 } })).toBeNull();
    });

    it('widens the allowance while the feed was dark, so a real drag is not refused', () => {
        // Five minutes dark at up to 6 kt is ~900 m of possible movement.
        const drifted = { latitude: -27.2125, longitude: 153.0875, accuracy: 8 }; // ~445 m
        expect(handover({ lastNmea: { ...ANCHORAGE, at: NOW - 300_000 }, candidate: drifted })).toBeNull();
    });

    it('stops calling it a failover once the boat has been dark too long', () => {
        // Beyond the window the phone is evidence about the phone, even if it
        // happens to be sitting right where the boat last was.
        const result = handover({ lastNmea: { ...ANCHORAGE, at: NOW - SOURCE_HANDOVER_WINDOW_MS - 1_000 } });
        expect(result).not.toBeNull();
        expect(result!.allowanceM).toBe(0);
    });
});

describe('describeBlindGps — refused handover', () => {
    it('explains that the fix was refused on purpose, and why', () => {
        const msg = describeBlindGps(
            facts({
                lastRejection: {
                    source: 'native',
                    reason: 'source-mismatch',
                    accuracy: 8,
                    at: NOW,
                    separationM: 3_020,
                },
            }),
        );
        expect(msg).toContain('3.0 km');
        expect(msg).toMatch(/not being used/i);
        expect(msg).toMatch(/where YOU are, not the boat/);
    });
});
