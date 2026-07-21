/**
 * findSavedAt — "is this tapped point somewhere I already saved?"
 *
 * Drives the map inspect popup's ✓ Saved state. Too tight and a fat
 * finger re-tapping an anchorage is offered a duplicate save; too loose
 * and it claims the next bay along. ~200 m is the line.
 */
import { describe, expect, it } from 'vitest';

import { buildSaveLocationPatch, disambiguateSavedName, findSavedAt, toPlannerString } from '../utils/savedLocations';

const AIRLIE = { lat: -20.267, lon: 148.718 };

/** Offset a point by metres, north and east. */
function offset(p: { lat: number; lon: number }, north: number, east: number) {
    const dLat = north / 110_540;
    const dLon = east / (110_540 * Math.cos((p.lat * Math.PI) / 180));
    return { lat: p.lat + dLat, lon: p.lon + dLon };
}

describe('findSavedAt', () => {
    it('returns null with no saved coords at all', () => {
        expect(findSavedAt(undefined, AIRLIE.lat, AIRLIE.lon)).toBeNull();
        expect(findSavedAt({}, AIRLIE.lat, AIRLIE.lon)).toBeNull();
    });

    it('matches an exact re-tap', () => {
        const saved = { 'Airlie Beach': AIRLIE };
        expect(findSavedAt(saved, AIRLIE.lat, AIRLIE.lon)).toBe('Airlie Beach');
    });

    it('matches a fat-finger tap ~150 m away', () => {
        const saved = { 'Airlie Beach': AIRLIE };
        const near = offset(AIRLIE, 100, 100); // ~141 m
        expect(findSavedAt(saved, near.lat, near.lon)).toBe('Airlie Beach');
    });

    it('does NOT match the next bay ~500 m away', () => {
        const saved = { 'Airlie Beach': AIRLIE };
        const far = offset(AIRLIE, 500, 0);
        expect(findSavedAt(saved, far.lat, far.lon)).toBeNull();
    });

    it('picks the NEAREST when two saved spots are both in range', () => {
        const saved = {
            Far: offset(AIRLIE, 180, 0),
            Near: offset(AIRLIE, 20, 0),
        };
        expect(findSavedAt(saved, AIRLIE.lat, AIRLIE.lon)).toBe('Near');
    });

    it('scales longitude by latitude — a high-latitude tolerance stays ~200 m', () => {
        // At 60°S a degree of longitude is half its equatorial width. An
        // unscaled comparison would match ~400 m of real distance here.
        const south = { lat: -60, lon: 148.718 };
        const saved = { Deep: south };
        const east300 = offset(south, 0, 300);
        expect(findSavedAt(saved, east300.lat, east300.lon)).toBeNull();

        const east100 = offset(south, 0, 100);
        expect(findSavedAt(saved, east100.lat, east100.lon)).toBe('Deep');
    });

    it('skips malformed entries instead of throwing', () => {
        const saved = {
            Bad: { lat: NaN, lon: 148.7 },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            Missing: undefined as any,
            Good: AIRLIE,
        };
        expect(findSavedAt(saved, AIRLIE.lat, AIRLIE.lon)).toBe('Good');
    });

    it('handles the antimeridian without false-matching (documents the limit)', () => {
        // (see below for the disambiguation suite that depends on this)
        // A spot at 179.999°E and a tap at -179.999°E are ~200 m apart in
        // reality, but this comparator works in raw degrees so it will NOT
        // match. Acceptable: saving the same spot twice near the dateline
        // is a far smaller harm than a wrong-side match, and no AU/NZ user
        // hits it. Locked in so the behaviour is a decision, not a surprise.
        const saved = { Dateline: { lat: 0, lon: 179.999 } };
        expect(findSavedAt(saved, 0, -179.999)).toBeNull();
    });
});

/**
 * The store is keyed by NAME; the map popup asks by COORDS. Reverse
 * geocoding is locality-level, so several anchorages in one bay share a
 * name. Without disambiguation, saving the second silently moved the
 * first — the exact case this feature exists to serve.
 */
describe('disambiguateSavedName', () => {
    const NAME = 'Airlie Beach, QLD, AU';

    it('uses the name as-is when nothing holds it', () => {
        expect(disambiguateSavedName([], {}, NAME, AIRLIE.lat, AIRLIE.lon)).toBe(NAME);
        expect(disambiguateSavedName(undefined, undefined, NAME, AIRLIE.lat, AIRLIE.lon)).toBe(NAME);
    });

    it('reuses the name when the SAME spot already holds it (re-save)', () => {
        const names = [NAME];
        const coords = { [NAME]: AIRLIE };
        expect(disambiguateSavedName(names, coords, NAME, AIRLIE.lat, AIRLIE.lon)).toBe(NAME);
    });

    it('suffixes when a DIFFERENT spot holds the name — the data-loss case', () => {
        const names = [NAME];
        const coords = { [NAME]: AIRLIE };
        const nextBay = offset(AIRLIE, 500, 0);
        expect(disambiguateSavedName(names, coords, NAME, nextBay.lat, nextBay.lon)).toBe(`${NAME} (2)`);
    });

    it('keeps counting past an existing suffix', () => {
        const names = [NAME, `${NAME} (2)`];
        const coords = { [NAME]: AIRLIE, [`${NAME} (2)`]: offset(AIRLIE, 500, 0) };
        const third = offset(AIRLIE, 1000, 0);
        expect(disambiguateSavedName(names, coords, NAME, third.lat, third.lon)).toBe(`${NAME} (3)`);
    });

    it('matches case-insensitively, like the write path does', () => {
        const names = ['airlie beach, qld, au'];
        const coords = { 'airlie beach, qld, au': AIRLIE };
        const nextBay = offset(AIRLIE, 500, 0);
        expect(disambiguateSavedName(names, coords, NAME, nextBay.lat, nextBay.lon)).toBe(`${NAME} (2)`);
    });

    it('suffixes when the holder has no coords at all (name-only save)', () => {
        // Can't prove it's the same spot, so don't risk overwriting it.
        expect(disambiguateSavedName([NAME], {}, NAME, AIRLIE.lat, AIRLIE.lon)).toBe(`${NAME} (2)`);
    });

    it('END TO END: two anchorages in one bay both survive', () => {
        const bayA = AIRLIE;
        const bayB = offset(AIRLIE, 500, 0);

        // Save A under the geocoded locality name.
        const nameA = disambiguateSavedName([], {}, NAME, bayA.lat, bayA.lon);
        const patchA = buildSaveLocationPatch([], {}, toPlannerString({ name: nameA, ...bayA }))!;

        // Save B — same geocoded name, different spot.
        const nameB = disambiguateSavedName(
            patchA.savedLocations,
            patchA.savedLocationCoords,
            NAME,
            bayB.lat,
            bayB.lon,
        );
        const patchB = buildSaveLocationPatch(
            patchA.savedLocations,
            patchA.savedLocationCoords,
            toPlannerString({ name: nameB, ...bayB }),
        )!;

        // Both entries kept, each with its OWN coords.
        expect(patchB.savedLocations).toHaveLength(2);
        expect(patchB.savedLocationCoords[nameA].lat).toBeCloseTo(bayA.lat, 4);
        expect(patchB.savedLocationCoords[nameB].lat).toBeCloseTo(bayB.lat, 4);
        expect(nameA).not.toBe(nameB);

        // And each point still resolves to its own entry.
        expect(findSavedAt(patchB.savedLocationCoords, bayA.lat, bayA.lon)).toBe(nameA);
        expect(findSavedAt(patchB.savedLocationCoords, bayB.lat, bayB.lon)).toBe(nameB);
    });

    it('the " (2)" suffix survives the planner-string round-trip', () => {
        // extractDisplayName only strips a trailing "(num, num)" — no comma
        // in "(2)", so the suffix must come back intact.
        const suffixed = `${NAME} (2)`;
        const patch = buildSaveLocationPatch([], {}, toPlannerString({ name: suffixed, ...AIRLIE }))!;
        expect(patch.savedLocations[0]).toBe(suffixed);
        expect(patch.savedLocationCoords[suffixed].lat).toBeCloseTo(AIRLIE.lat, 4);
    });
});
