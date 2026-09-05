/**
 * The phone does not cut in unless the vessel's GPS is dead.
 *
 * Shane, 2026-09-05, standing 2.3 km from Serene Summer and watching the log
 * reject his own handset twice — "position spike 2321m in 3.5s = 1276kn
 * implied", then again at 3.4s. Identical to the metre both times, because it
 * was never drift: it was two real receivers in two real places, and the only
 * thing between them and one joined-up track was a spike guard. His rule:
 * "we need to ensure that the phone does not cut in unless we have a dead gps.
 * killed, murdered. dead."
 *
 * WHY THE OLD RULE LOOKED FINE. A selected source yielded after a silence of
 * min(max(profile, nearshore), 15s). That is the right shape for two receivers
 * bolted to the same boat 10–50 m apart, which is what it was written for — it
 * stops them alternating into a sawtooth. The phone is the one receiver that
 * leaves, so the same rule let a fifteen-second gateway hiccup hand the voyage
 * to a handset in a car park.
 *
 * THE FIX IS ASYMMETRY. The boat always wins, immediately. The phone waits for
 * a feed that is not merely quiet but dead — 'unavailable' by the app's own
 * shared definition, and STAYING that way, because 'unavailable' arrives 13 s
 * after the last fix and instantly on a dropped connection, which a reconnect
 * ladder or a gateway reboot both clear.
 *
 * The branch that matters as much as the rule: a phone with NO GATEWAY
 * CONFIGURED has no vessel GPS to wait for. Every punter without a boat lives
 * there, and must never serve out a dwell before logging their own trip.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const src = readFileSync('services/shiplog/GpsSubscriptionManager.ts', 'utf8');
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const DWELL_MS = 180_000;
const UNAVAILABLE_AFTER_MS = 13_000; // NMEA_USABLE_MAX_AGE_MS

/** The decision, restated independently of the manager. */
function makeArbiter({ gatewayConfigured }: { gatewayConfigured: boolean }) {
    let deadSince: number | null = null;
    return {
        /** feedStatus: 'live' | 'stale' | 'unavailable' */
        vesselGpsDead(now: number, feedStatus: string): boolean {
            if (!gatewayConfigured) return true;
            if (feedStatus !== 'unavailable') {
                deadSince = null;
                return false;
            }
            if (deadSince === null) deadSince = now;
            return now - deadSince >= DWELL_MS;
        },
    };
}

describe('phone cut-in requires a dead vessel GPS', () => {
    it('never blocks the boat GPS — it wins immediately, in every state', () => {
        // Asserted on the source because it is an early return with no
        // conditions to model: `if (source === 'nmea') return true;`
        const fn = code.slice(code.indexOf('private sourceCanContribute'));
        const body = fn.slice(0, fn.indexOf('private isVesselGpsDead'));
        expect(body).toMatch(/if \(source === 'nmea'\) return true;/);
        // And that return comes FIRST, before any silence arithmetic.
        expect(body.indexOf("source === 'nmea'")).toBeLessThan(body.indexOf('fallbackAfterMs'));
    });

    it('blocks the phone while the boat feed is live or merely stale', () => {
        const a = makeArbiter({ gatewayConfigured: true });
        expect(a.vesselGpsDead(0, 'live')).toBe(false);
        expect(a.vesselGpsDead(10_000, 'stale')).toBe(false);
        // Stale is NOT dead. A 10-second chartplotter is a working chartplotter.
        expect(a.vesselGpsDead(60_000, 'stale')).toBe(false);
    });

    it('does not hand over on a hiccup the reconnect ladder would have cleared', () => {
        const a = makeArbiter({ gatewayConfigured: true });
        expect(a.vesselGpsDead(0, 'unavailable')).toBe(false);
        // A dropped TCP connection reads 'unavailable' instantly. Fifteen
        // seconds — the whole of the old window — is not nearly enough.
        expect(a.vesselGpsDead(15_000, 'unavailable')).toBe(false);
        expect(a.vesselGpsDead(60_000, 'unavailable')).toBe(false);
        expect(a.vesselGpsDead(DWELL_MS - 1, 'unavailable')).toBe(false);
    });

    it('hands over once it has been dead for the full dwell', () => {
        const a = makeArbiter({ gatewayConfigured: true });
        a.vesselGpsDead(0, 'unavailable');
        expect(a.vesselGpsDead(DWELL_MS, 'unavailable')).toBe(true);
        expect(a.vesselGpsDead(DWELL_MS + 60_000, 'unavailable')).toBe(true);
    });

    it('restarts the clock the moment the boat comes back', () => {
        const a = makeArbiter({ gatewayConfigured: true });
        a.vesselGpsDead(0, 'unavailable');
        expect(a.vesselGpsDead(DWELL_MS - 1_000, 'unavailable')).toBe(false);
        // One good fix, and the whole dwell must be served again.
        expect(a.vesselGpsDead(DWELL_MS - 500, 'live')).toBe(false);
        expect(a.vesselGpsDead(DWELL_MS + 10_000, 'unavailable')).toBe(false);
        expect(a.vesselGpsDead(DWELL_MS * 2, 'unavailable')).toBe(false);
        expect(a.vesselGpsDead(DWELL_MS * 2 + 10_000, 'unavailable')).toBe(true);
    });

    it('never makes a phone-only punter wait — there is no vessel GPS to be dead', () => {
        const a = makeArbiter({ gatewayConfigured: false });
        expect(a.vesselGpsDead(0, 'unavailable')).toBe(true);
        expect(a.vesselGpsDead(1, 'unavailable')).toBe(true);
    });

    it('is longer than any hiccup and shorter than losing a passage', () => {
        expect(DWELL_MS).toBeGreaterThan(UNAVAILABLE_AFTER_MS * 10);
        expect(DWELL_MS).toBeLessThanOrEqual(5 * 60_000);
    });

    it('the manager wires exactly this, and resets it per session', () => {
        expect(code).toMatch(/const VESSEL_GPS_DEAD_DWELL_MS = 180_000;/);
        expect(code).toMatch(/private vesselGpsDeadSince: number \| null = null;/);
        expect(code).toMatch(/if \(!NmeaListenerService\.getSavedConfig\(\)\) return true;/);
        expect(code).toMatch(/NmeaGpsProvider\.getFeedStatus\(now\) !== 'unavailable'/);
        // A stale dead-clock must not survive into the next voyage.
        const reset = code.slice(code.indexOf('this.selectedTrackSource = null;'));
        expect(reset.slice(0, 200)).toContain('this.vesselGpsDeadSince = null;');
    });

    it('keeps the sawtooth guard for the phone, rather than replacing it', () => {
        // The 15-second window still does its original job once the phone is
        // legitimately in play. Removing it would trade one bug for another.
        const fn = code.slice(code.indexOf('private sourceCanContribute'));
        const body = fn.slice(0, fn.indexOf('private isVesselGpsDead'));
        expect(body).toContain('SOURCE_FALLBACK_MAX_SILENCE_MS');
        expect(body.indexOf('isVesselGpsDead')).toBeLessThan(body.indexOf('fallbackAfterMs'));
    });
});
