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
