/**
 * derivedContourCache — the LRU of worker-computed contours, lifted out of the
 * EncHazardService god-module so its eviction + refresh semantics are tested
 * in isolation.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { Feature } from 'geojson';

import {
    getDerivedContours,
    putDerivedContours,
    clearDerivedContours,
    derivedContourCacheSize,
} from '../../services/enc/derivedContourCache';

const line = (id: number): Feature[] => [
    {
        type: 'Feature',
        geometry: {
            type: 'LineString',
            coordinates: [
                [id, id],
                [id + 1, id + 1],
            ],
        },
        properties: { id },
    },
];

describe('derivedContourCache', () => {
    beforeEach(() => clearDerivedContours());

    it('stores and returns contours by key', () => {
        putDerivedContours('a', line(1));
        expect(getDerivedContours('a')).toEqual(line(1));
        expect(getDerivedContours('missing')).toBeUndefined();
    });

    it('evicts the OLDEST beyond 12 entries', () => {
        for (let i = 0; i < 13; i++) putDerivedContours(`k${i}`, line(i));
        expect(derivedContourCacheSize()).toBe(12);
        expect(getDerivedContours('k0')).toBeUndefined(); // oldest evicted
        expect(getDerivedContours('k12')).toBeDefined(); // newest kept
    });

    it('re-putting a key refreshes it to newest (survives the next eviction)', () => {
        for (let i = 0; i < 12; i++) putDerivedContours(`k${i}`, line(i));
        putDerivedContours('k0', line(100)); // refresh k0 → now newest
        putDerivedContours('k12', line(12)); // pushes size to 13 → evict oldest (k1, not k0)
        expect(getDerivedContours('k0')).toEqual(line(100)); // survived
        expect(getDerivedContours('k1')).toBeUndefined(); // it was the oldest now
    });
});
