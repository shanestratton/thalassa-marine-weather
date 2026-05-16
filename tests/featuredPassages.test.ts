import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
    consumeFeaturedPassagePrefill,
    setFeaturedPassagePrefill,
    FEATURED_PASSAGE_PREFILL_KEY,
    _resetFeaturedPassageCacheForTests,
    type FeaturedPassage,
} from '../utils/featuredPassages';

// Featured-passage selection is covered indirectly by the locale
// tests (region → passage is a 1:1 table); the meat here is the
// prefill round-trip used by the Glass chip ↔ RoutePlanner handoff.

describe('Featured Passage prefill round-trip', () => {
    beforeEach(() => {
        sessionStorage.clear();
        _resetFeaturedPassageCacheForTests();
    });

    const samplePassage: FeaturedPassage = {
        id: 'test-newport-block',
        region: 'US_EAST',
        origin: { name: 'Newport, RI, USA', coords: { lat: 41.4901, lon: -71.3128 } },
        destination: { name: 'Block Island, RI, USA', coords: { lat: 41.1717, lon: -71.5589 } },
        distanceNm: 18,
        story: 'Test passage',
    };

    it('round-trips origin + destination via sessionStorage', () => {
        setFeaturedPassagePrefill(samplePassage);
        const consumed = consumeFeaturedPassagePrefill();
        expect(consumed).not.toBeNull();
        expect(consumed?.origin).toBe('Newport, RI, USA');
        expect(consumed?.destination).toBe('Block Island, RI, USA');
        expect(consumed?.passageId).toBe('test-newport-block');
    });

    it('consume() clears the key — second read returns null', () => {
        setFeaturedPassagePrefill(samplePassage);
        consumeFeaturedPassagePrefill();
        // The chip handoff is one-shot; a returning user who lands
        // on the planner days later must NOT get stale prefill.
        expect(sessionStorage.getItem(FEATURED_PASSAGE_PREFILL_KEY)).toBeNull();
        expect(consumeFeaturedPassagePrefill()).toBeNull();
    });

    it('consume() returns null when nothing was set', () => {
        expect(consumeFeaturedPassagePrefill()).toBeNull();
    });

    it('consume() returns null for malformed JSON', () => {
        sessionStorage.setItem(FEATURED_PASSAGE_PREFILL_KEY, '{not valid json');
        expect(consumeFeaturedPassagePrefill()).toBeNull();
    });

    it('consume() returns null when origin/destination missing', () => {
        sessionStorage.setItem(FEATURED_PASSAGE_PREFILL_KEY, JSON.stringify({ origin: 'only origin' }));
        expect(consumeFeaturedPassagePrefill()).toBeNull();
    });

    it('set() silently no-ops when sessionStorage throws', () => {
        const original = sessionStorage.setItem;
        sessionStorage.setItem = vi.fn(() => {
            throw new Error('quota exceeded');
        });
        // Must not throw — the chip path should never crash the app
        // because storage is misbehaving in a private window.
        expect(() => setFeaturedPassagePrefill(samplePassage)).not.toThrow();
        sessionStorage.setItem = original;
    });
});
