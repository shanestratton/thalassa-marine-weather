/**
 * The cache cannot be pinned for ever by a caller-supplied ttl.
 *
 * /api/passthrough and /api/passthrough-tile take `ttl` as a bare parseInt from
 * the query string, and purgeExpired only deletes rows whose expiry has ALREADY
 * passed — with no LRU behind it. So one request naming a far-future ttl wrote
 * an entry that could never be collected, into the cache the boat depends on
 * offshore. Found by an adversarial review on 2026-08-30.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_CACHE_TTL_MS, clampTtl } from './cache.js';

test('a century-long ttl is cut to the ceiling', () => {
    const century = 100 * 365 * 24 * 60 * 60 * 1000;
    assert.equal(clampTtl(century), MAX_CACHE_TTL_MS);
    assert.equal(clampTtl(Number.MAX_SAFE_INTEGER), MAX_CACHE_TTL_MS);
});

test('ordinary ttls pass through untouched', () => {
    assert.equal(clampTtl(900_000), 900_000); // the passthrough default
    assert.equal(clampTtl(1_800_000), 1_800_000); // the tile default
    assert.equal(clampTtl(30 * 24 * 60 * 60 * 1000), 30 * 24 * 60 * 60 * 1000); // offline tiles
});

test('a hostile or malformed ttl expires immediately rather than never', () => {
    // parseInt('abc') is NaN, and NaN must not become "forever".
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1, -Number.MAX_SAFE_INTEGER, 0]) {
        assert.equal(clampTtl(bad), 0, `${bad} should be treated as already expired`);
    }
});

test('the ceiling is a horizon, not a century', () => {
    const days = MAX_CACHE_TTL_MS / (24 * 60 * 60 * 1000);
    assert.equal(days, 90);
});
