/**
 * Shane 2026-08-28: "quite often the wind goes stale and then says no data."
 *
 * The gateway was innocent. Measured the same hour on Serene Summer's YDWG:
 * 452 MWV sentences in 130 s, largest gap 0.64 s, not one gap over the 6.5 s
 * live threshold. 3.5 wind sentences a second, and the panel still said no
 * data.
 *
 * The cause was the clock, not the wind. emitSample runs on a 5 s
 * setInterval and stamped the sample `Date.now()` — the PUBLISH time. The
 * store stamps every metric's lastUpdated from that, and freshness is live
 * <= 6.5 s. So the whole panel's liveness rode on a JS timer with 1.5 s of
 * headroom: one coalesced tick and everything read "stale", two and it said
 * "no data".
 *
 * And it was self-inflicted — the Glass page draws SVG gauges, two wind roses
 * and the sail diagram on every sample, so a render that held the main thread
 * for 1.5 s delayed the next tick past the threshold. The panel could make
 * itself stale by drawing itself.
 *
 * The tiers claim to describe the instruments, so they must be measured from
 * the instruments.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { getNmeaFreshness, NMEA_LIVE_MAX_AGE_MS, NMEA_USABLE_MAX_AGE_MS } from '../services/NmeaStore';
import { NMEA_SAMPLE_INTERVAL_MS } from '../services/nmea/nmeaCadence';

const listener = readFileSync('services/NmeaListenerService.ts', 'utf8');
const store = readFileSync('services/NmeaStore.ts', 'utf8');

describe('what the sample timestamp means', () => {
    it('is when the data arrived, not when we published it', () => {
        expect(listener).toContain('timestamp: this.lastSentenceAt || Date.now(),');
    });

    it('falls back rather than stamping zero if nothing has arrived', () => {
        // lastSentenceAt is 0 before the first sentence. A 0 timestamp reads
        // as "dead" to getNmeaFreshness, which would be a lie about a socket
        // that has simply not spoken yet.
        expect(getNmeaFreshness(0, Date.now())).toBe('dead');
        expect(listener).toContain('|| Date.now()');
    });

    it('still ages each metric on its own, so a quiet transducer still dies', () => {
        // The honesty check on the fix: ingestSample only stamps fields that
        // are non-null, so wind going quiet while GPS streams leaves
        // sample.tws null and the wind metric ages out correctly.
        const from = store.indexOf('private ingestSample');
        const ingest = store.slice(from, store.indexOf('this.notify();', from));
        expect(ingest).toContain('if (sample.tws !== null) this.updateMetric(this.state.tws, sample.tws, now);');
        expect(ingest).toContain('const now = sample.timestamp;');
    });
});

describe('the headroom that caused it', () => {
    it('records how little there was: one publish interval, 1.5 s of slack', () => {
        // Not a rule — a note on why this was fragile. If anyone tightens
        // NMEA_LIVE_MAX_AGE_MS toward the publish interval again, this says
        // what that costs.
        expect(NMEA_LIVE_MAX_AGE_MS - NMEA_SAMPLE_INTERVAL_MS).toBe(1_500);
    });

    it('leaves the tiers themselves alone', () => {
        // The fix is what the clock measures, not where the lines are.
        expect(NMEA_LIVE_MAX_AGE_MS).toBe(6_500);
        expect(NMEA_USABLE_MAX_AGE_MS).toBe(13_000);
    });

    it('still calls a genuinely silent feed dead', () => {
        const now = 1_000_000;
        expect(getNmeaFreshness(now - 1_000, now)).toBe('live');
        expect(getNmeaFreshness(now - 10_000, now)).toBe('stale');
        expect(getNmeaFreshness(now - 20_000, now)).toBe('dead');
    });
});
