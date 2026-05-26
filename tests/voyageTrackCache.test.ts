import { describe, it, expect } from 'vitest';
import { shouldCacheTrack } from '../services/shiplog/VoyageTrackCache';

describe('VoyageTrackCache.shouldCacheTrack', () => {
    it('caches a normal multi-point track', () => {
        expect(shouldCacheTrack(986, 1_200_000)).toBe(true);
    });

    it('skips a degenerate <2-point "track" (not a line)', () => {
        expect(shouldCacheTrack(1, 500)).toBe(false);
        expect(shouldCacheTrack(0, 0)).toBe(false);
    });

    it('skips an oversized track to protect Preferences', () => {
        expect(shouldCacheTrack(50_000, 5_000_000)).toBe(false);
    });

    it('caches right up to the byte guard but not past it', () => {
        expect(shouldCacheTrack(2, 4_000_000)).toBe(true);
        expect(shouldCacheTrack(2, 4_000_001)).toBe(false);
    });
});
