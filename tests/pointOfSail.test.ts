/**
 * "In irons" and "wing and wing" — Shane 2026-09-06: "show 'In Irons' so we
 * know when to tack. it should change by boat type of course. so my tayana,
 * cant really sail any closer than 45 degrees" / "when we are running square,
 * we should have the option of sailing wing and wing".
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    CLOSE_HAULED_MAX_DEG,
    DEFAULT_CLOSE_HAULED_DEG,
    closeHauledDegFor,
    offBowFrom,
    pointOfSail,
} from '../services/sailing/pointOfSail';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');
const at = (windFromDeg: number, sogKts: number | null = 6, closeHauledDeg = 45) =>
    pointOfSail({ windFromDeg, sogKts, closeHauledDeg })!;

describe('how close she will sail', () => {
    it('is the skipper’s number when set, else a default by hull and rig', () => {
        expect(closeHauledDegFor({ closeHauledTwa: 47 })).toBe(47);
        expect(closeHauledDegFor({ riggingType: 'Cutter' })).toBe(45); // Serene Summer
        expect(closeHauledDegFor({ riggingType: 'Ketch' })).toBe(45);
        expect(closeHauledDegFor({ riggingType: 'Sloop' })).toBe(40);
        expect(closeHauledDegFor({ hullType: 'catamaran', riggingType: 'Sloop' })).toBe(50);
        expect(closeHauledDegFor(undefined)).toBe(DEFAULT_CLOSE_HAULED_DEG);
        expect(closeHauledDegFor({ closeHauledTwa: CLOSE_HAULED_MAX_DEG + 20, riggingType: 'Sloop' })).toBe(40); // nonsense ignored
    });
});

describe('the point of sail', () => {
    it('folds a where-from angle either side of the bow to degrees off it', () => {
        expect(offBowFrom(30)).toBe(30);
        expect(offBowFrom(330)).toBe(30);
        expect(offBowFrom(-30)).toBe(30);
        expect(offBowFrom(180)).toBe(180);
        expect(offBowFrom(null)).toBeNull();
        expect(pointOfSail({ windFromDeg: null, sogKts: 5, closeHauledDeg: 45 })).toBeNull();
    });

    it('under her limit by more than five degrees she is in irons — tack, or bear away', () => {
        const p = at(35);
        expect(p.state).toBe('in-irons');
        expect(p.tack).toBe(true);
        expect(p.level).toBe('serious');
        expect(p.detail).toContain('45°');
        expect(p.detail).toContain('Tack');
    });

    it('with no way on the call is to build speed first, not to tack', () => {
        const p = at(20, 0.4);
        expect(p.state).toBe('in-irons');
        expect(p.tack).toBe(false);
        expect(p.detail).toContain('No way on');
    });

    it('just inside her limit she is pinching', () => {
        expect(at(42).state).toBe('pinching');
        expect(at(42).level).toBe('warning');
        expect(at(45).state).toBe('close-hauled');
    });

    it('the limit moves with the boat', () => {
        expect(at(42, 6, 40).state).toBe('close-hauled'); // a sloop is fine at 42
        expect(at(48, 6, 50).state).toBe('pinching'); // a cat is pinching at 48
    });

    it('sailing free says little; running square offers wing and wing; dead square warns of the lee', () => {
        expect(at(70).state).toBe('close-reach');
        expect(at(95).state).toBe('beam-reach');
        expect(at(140).state).toBe('broad-reach');
        expect(at(140).wingAndWing).toBe(false);
        const square = at(168);
        expect(square.state).toBe('running-square');
        expect(square.wingAndWing).toBe(true);
        expect(square.level).toBe('good');
        const dead = at(176);
        expect(dead.label).toBe('Dead square');
        expect(dead.level).toBe('warning');
        expect(dead.detail).toContain('by the lee');
    });
});

describe('the panel shows it', () => {
    const page = read('components/nmea/TheGlassPage.tsx');
    it('reads her limit from the vessel profile and shows the strip only when it has something to say', () => {
        expect(page).toContain('const closeHauledDeg = closeHauledDegFor(vesselProfile);');
        expect(page).toContain('pointOfSail({ windFromDeg: roseTrueAngle, sogKts: sog.value, closeHauledDeg })');
        expect(page).toContain("pointing !== null && (pointing.level !== 'good' || pointing.wingAndWing)");
        expect(page).toContain('data-testid="point-of-sail-strip"');
    });
    it('running offers wing and wing or gybing down, defaulting to the pole under 20 kn gusts', () => {
        expect(page).toContain("recentGust != null && recentGust >= 20 ? 'gybe' : 'wing'");
        expect(page).toContain('Square · wing and wing');
        expect(page).toContain('Gybe down · 145–165°');
        expect(page).toMatch(/plan\.band\.band === 'Running' && downwind === 'gybe'\s*\?\s*'Broad reach'/);
    });
    it('the profile carries the number', () => {
        expect(read('types/vessel.ts')).toContain('closeHauledTwa?: number;');
    });
});
