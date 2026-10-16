// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseNoaaIndex } from '../services/enc/noaaCatalogueContract';

describe('real NOAA publisher metadata to phone contract', () => {
    it('accepts the exact Python-generated index from real provider metadata without inventing a source date', () => {
        // Python test_pipeline reproduces this exact object from the adjacent
        // bounded public XML, including NOAA's malformed series DateTime title.
        const value = JSON.parse(
            readFileSync(new URL('./fixtures/noaa-publisher/generated-index.json', import.meta.url), 'utf8'),
        );
        const index = parseNoaaIndex(value);
        expect(index.sourceAt).toBe('2026-10-16T04:59:07Z');
        expect(index.checkedAt).toBe('2026-10-16T06:00:00Z');
        expect(index.sourceAt).not.toBe(index.checkedAt);
        expect(index.activeCells).toBe(1);
        expect(index.shards.length).toBeGreaterThan(0);
        expect(() => parseNoaaIndex({ ...value, sourceAt: 'ENC Product Catalog' })).toThrow();
    });
});
