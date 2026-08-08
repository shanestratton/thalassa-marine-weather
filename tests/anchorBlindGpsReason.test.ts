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
