/**
 * Skipper's Reference content integrity — the cards are static authored data folded in from the
 * Passage Weather Pack. No logic to test, but this guards against a typo dropping a field or a card,
 * and pins the four expected card ids so a rename is a conscious change.
 */
import { describe, it, expect } from 'vitest';
import { SKIPPER_REFERENCE_CARDS } from '../services/reference/skipperReferenceCards';

describe('SKIPPER_REFERENCE_CARDS', () => {
    it('carries exactly the four reference cards (Go/No-Go ships as the scorer, not here)', () => {
        expect(SKIPPER_REFERENCE_CARDS.map((c) => c.id)).toEqual([
            'grib-60s',
            'synoptic',
            'forecast-decoder',
            'squall-cyclone',
        ]);
    });

    it('every card has the fields the UI renders, all non-empty', () => {
        for (const card of SKIPPER_REFERENCE_CARDS) {
            expect(card.emoji, card.id).toBeTruthy();
            expect(card.title, card.id).toBeTruthy();
            expect(card.subtitle, card.id).toBeTruthy();
            expect(card.pullquote, card.id).toBeTruthy();
            expect(card.sources, card.id).toBeTruthy();
            expect(card.steps.length, `${card.id} steps`).toBeGreaterThanOrEqual(6);
            for (const step of card.steps) {
                expect(step.num, card.id).toBeTruthy();
                expect(step.heading, card.id).toBeTruthy();
                expect(step.bodyHtml, card.id).toBeTruthy();
            }
            expect(card.callout.label, `${card.id} callout`).toBeTruthy();
            expect(card.callout.items.length, `${card.id} callout items`).toBeGreaterThanOrEqual(3);
        }
    });

    it('card ids are unique', () => {
        const ids = SKIPPER_REFERENCE_CARDS.map((c) => c.id);
        expect(new Set(ids).size).toBe(ids.length);
    });
});

/**
 * The wording of four rules, pinned (binder audit 2026-10-09, SR-1 and SR-2).
 * Each was wrong in a card that claimed a fact-check, and a skipper reads them
 * to decide whether to go. They must hold in both hemispheres.
 */
describe('the rules the cards teach', () => {
    const step = (cardId: string, num: string) => {
        const card = SKIPPER_REFERENCE_CARDS.find((c) => c.id === cardId);
        const found = card?.steps.find((s) => s.num === num);
        if (!found) throw new Error(`${cardId} step ${num} is missing`);
        return found.bodyHtml.replace(/<[^>]+>/g, '');
    };

    it('the same isobar spacing blows harder toward the equator, where Coriolis is weaker', () => {
        // Geostrophic wind is the gradient over (density x f), f = 2 Omega sin(latitude):
        // 4 hPa over 300 km is about 9.5 m/s at 50 degrees and 21 m/s at 20 degrees.
        const body = step('synoptic', '1');
        expect(body).toContain('harder toward the equator');
        expect(body).not.toContain('nearer the pole');
        expect(body).toMatch(/wide tropical isobars can still mean a fresh trade/);
        // f is zero at the equator: there the isobars stop working.
        expect(body).toMatch(/equator isobars stop working/);
    });

    it('a southern-hemisphere southerly change backs; a northern cold front veers', () => {
        // NW -> W -> SW -> S is 315 -> 180 degrees: anticlockwise, which the Met
        // Office marine glossary calls backing.
        const body = step('synoptic', '5');
        expect(body).toContain('backs');
        expect(body).toMatch(/anticlockwise/);
        expect(body).not.toContain('clockwise in the SH');
        expect(body).not.toContain('opposite-handed');
        expect(body).toMatch(/NH cold fronts mirror this.*veers \(turns clockwise\)/);
    });

    it("'tending' is a change of direction, not a build", () => {
        const body = step('forecast-decoder', '4');
        expect(body).not.toMatch(/Tending\s*\/\s*freshening/);
        expect(body).toMatch(/Freshening = building/);
        expect(body).toMatch(/tending.*direction/i);
    });

    it("a barb's shaft points to where the wind is coming from", () => {
        const body = step('grib-60s', '3');
        expect(body).toContain('coming from');
        expect(body).not.toContain('going from');
    });
});
