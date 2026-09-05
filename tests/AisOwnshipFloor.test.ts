/**
 * The boat's own neighbourhood never goes stale, wherever the chart is.
 *
 * Shane asked the right question on 2026-09-05 — "so do the ais targets move
 * as you do?" — and the honest answer was: the internet ones follow the MAP.
 * useAisStreamLayer fetches around map.getCenter(), so pan ahead to look at
 * something and leave the chart there, and the water around the boat stops
 * being fetched. AisStore then expires those targets after ten minutes and the
 * screen goes quiet while the sea has not.
 *
 * It was a DISPLAY gap rather than a safety one — the boat's own VHF receiver
 * keeps hearing everything in range, and AisGuardWatch watches ownship through
 * resolveOwnshipPosition whatever the map is doing. A screen that looks
 * emptier than the water is still its own kind of wrong.
 *
 * So a second fetch is pinned to the boat. It is deliberately a FLOOR, not a
 * second viewport: small radius, low rate, and it stands down entirely when
 * the chart already covers the boat — which is the common case, so most of the
 * time it costs nothing at all.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const src = readFileSync('components/map/useAisStreamLayer.ts', 'utf8');
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const RADIUS_NM = 12;
const INTERVAL_MS = 90_000;
const COVERED = 0.5;
/** AisStore's expiry — the thing this floor exists to stay inside. */
const TARGET_EXPIRY_MS = 10 * 60_000;

/** The stand-down decision, restated independently of the hook. */
function needsOwnshipFetch(distanceToCentreNm: number, viewportRadiusNm: number): boolean {
    return distanceToCentreNm + RADIUS_NM > viewportRadiusNm * COVERED;
}

describe('the ownship floor', () => {
    it('refreshes well inside the window it is defending', () => {
        // A floor that ticked slower than the expiry would let the gap open
        // anyway, just less often.
        expect(INTERVAL_MS).toBeLessThan(TARGET_EXPIRY_MS / 3);
    });

    it('stands down when the chart is already looking at the boat', () => {
        // Boat at the centre of a 50 nm viewport: covered many times over.
        expect(needsOwnshipFetch(0, 50)).toBe(false);
        expect(needsOwnshipFetch(5, 50)).toBe(false);
    });

    it('fires once the chart has been dragged off the boat', () => {
        // 40 nm off the centre of a 50 nm viewport — the boat is at the ragged
        // edge of what is being fetched, which is exactly the case that used
        // to go quiet.
        expect(needsOwnshipFetch(40, 50)).toBe(true);
        // And a tight zoom anywhere but on the boat.
        expect(needsOwnshipFetch(3, 8)).toBe(true);
    });

    it('is a floor, not a second viewport', () => {
        // A large radius here would double the cost of every fetch cycle for
        // water the viewport usually already covers.
        expect(RADIUS_NM).toBeLessThanOrEqual(15);
        expect(INTERVAL_MS).toBeGreaterThanOrEqual(60_000);
    });
});

/**
 * The ownship-floor effect's body.
 *
 * resolveOwnshipPosition is called in THREE places in this file — the guard
 * ring and the CPA maths use it too — so anchoring on the first occurrence
 * lands in someone else's code. This picks the call that is followed by this
 * feature's own constant.
 */
function ownshipEffect(): string {
    // The CALL, with its paren — the bare name also matches the import line,
    // whose forward window reaches the constants block and looked like a hit.
    const needle = 'resolveOwnshipPosition(';
    for (let at = code.indexOf(needle); at > -1; at = code.indexOf(needle, at + 1)) {
        const window = code.slice(at, at + 2500);
        if (window.includes('OWNSHIP_FETCH_RADIUS_NM')) return window;
    }
    throw new Error('the ownship floor effect was not found');
}

describe('the hook wires it that way', () => {
    it('centres on OWNSHIP, not on the map', () => {
        const effect = ownshipEffect();
        expect(effect).toMatch(/resolveOwnshipPosition\(NmeaStore\.getState\(\), LocationStore\.getState\(\)\)/);
        expect(effect).toMatch(/lat: own\.lat,\s*lon: own\.lon,/);
    });

    it('keeps its results in a SEPARATE cache from the viewport fetch', () => {
        // One cache would mean each fetch clobbering the other's answer every
        // time it landed, which is worse than the bug.
        expect(code).toMatch(/const cachedOwnshipFeatures = useRef<GeoJSON\.Feature\[\]>\(\[\]\);/);
        expect(code).toMatch(/const cachedServerFeatures = useRef<GeoJSON\.Feature\[\]>\(\[\]\);/);
        expect(code).not.toMatch(/cachedServerFeatures\.current = .*ownship/i);
    });

    it('dedupes the two windows against each other, and the receiver wins', () => {
        // They overlap whenever the chart is near the boat.
        expect(code).toMatch(/\[\.\.\.cachedServerFeatures\.current, \.\.\.cachedOwnshipFeatures\.current\]/);
        expect(code).toMatch(/seenInternet\.has\(mmsi\)/);
        expect(code).toMatch(/localMmsis\.has\(mmsi\)/);
    });

    it('drops nothing on the map when there is no fix to pin to', () => {
        // No position is not an empty sea — it just means this floor has
        // nothing to stand on. The viewport fetch carries on.
        expect(ownshipEffect()).toMatch(/if \(!own\) \{[\s\S]{0,200}cachedOwnshipFeatures\.current = \[\];/);
    });

    it('clears its cache on teardown, so a disabled layer leaves no ghosts', () => {
        expect(code).toMatch(/cancelled = true;\s*cachedOwnshipFeatures\.current = \[\];/);
    });
});
