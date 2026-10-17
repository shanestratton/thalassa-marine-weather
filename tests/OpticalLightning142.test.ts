import fs from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
    decodeOpticalPointer,
    decodeOpticalIndex,
    decodeOpticalTile,
    opticalViewportTiles,
    OPTICAL_WARNING,
} from '../services/weather/api/opticalLightningContract';
import { parseLicensedLightning } from '../services/weather/api/licensedLightningContract';
const fixture = JSON.parse(fs.readFileSync('tests/fixtures/optical142/fictional-packet.json', 'utf8'));
const resources = fixture.resources as Record<string, string>,
    now = fixture.now as number;
const pointer = () => decodeOpticalPointer(JSON.parse(resources['latest.json']), now);
const raw = () => JSON.parse(resources[`generations/${pointer().generation}/index.json`]);
const index = () => decodeOpticalIndex(raw(), pointer(), now);
const tile = () => Object.keys(index().tiles)[0];
const body = () => JSON.parse(resources[`generations/${pointer().generation}/tile-${tile()}.json`]);
describe('142 genuine optical product display contract', () => {
    it('accepts Python-sealed immutable fixture and preserves all original UTC/source identities', () => {
        const value = index(),
            rows = decodeOpticalTile(body(), tile(), value, now);
        expect(rows).toHaveLength(6);
        expect(new Set(rows.map((r) => r[4])).size).toBe(3);
        expect(value.sources.map((s) => s.platform)).toEqual(['GOES-18', 'GOES-19', 'MTI1']);
        expect(rows[0][2]).toBe(now - 4000);
        expect(OPTICAL_WARNING).toMatch(/not ground-strike/);
    });
    it('refuses stale, duplicate-shape and renewed pointers', () => {
        for (const edit of [
            { expiresAt: now },
            { generatedAt: now + 1 },
            { expiresAt: now + 60001 },
            { extra: true },
            { generation: 'not-a-hash' },
        ])
            expect(() => decodeOpticalPointer({ ...JSON.parse(resources['latest.json']), ...edit }, now)).toThrow();
    });
    it('cannot relabel groups, accumulated imagery, network types or guessed QC as flashes', () => {
        for (const edit of [
            { product: 'LI-2-LGR' },
            { product: 'LI-2-AF' },
            { provider: 'xweather' },
            { qc: 'good' },
            { platform: 'GOES-16' },
            { licence: 'unknown' },
        ]) {
            const value = raw();
            value.sources[0] = { ...value.sources[0], ...edit };
            expect(() => decodeOpticalIndex(value, pointer(), now)).toThrow();
        }
        const value = raw();
        value.representation = 'ground-strike';
        expect(() => decodeOpticalIndex(value, pointer(), now)).toThrow();
    });
    it('refuses missing native admission, contradictory original UTC and duplicated source originals', () => {
        for (const mutate of [
            (v: ReturnType<typeof raw>) => {
                delete v.admission;
            },
            (v: ReturnType<typeof raw>) => {
                v.sources[0].observedEnd = now + 1;
            },
            (v: ReturnType<typeof raw>) => {
                v.sources[0].processedAt = v.sources[0].observedEnd - 1;
            },
            (v: ReturnType<typeof raw>) => {
                v.sources[1].rawSha256 = v.sources[0].rawSha256;
            },
        ]) {
            const value = raw();
            mutate(value);
            expect(() => decodeOpticalIndex(value, pointer(), now)).toThrow();
        }
    });
    it('does not repair invalid centroid/source/clock or duplicate product flash identity', () => {
        for (const [field, value] of [
            [0, 180],
            [1, 91],
            [2, now + 1],
            [4, 8],
            [5, 'private-identifier'],
            [5, '9999999999'],
            [5, '00'],
        ] as const) {
            const v = body();
            v.rows[0][field] = value;
            expect(() => decodeOpticalTile(v, tile(), index(), now)).toThrow();
        }
        const v = body();
        v.rows[1] = v.rows[0];
        expect(() => decodeOpticalTile(v, tile(), index(), now)).toThrow();
    });
    it('expires each original observation and keeps an empty region explicitly distinct from clear weather', () => {
        expect(decodeOpticalTile(body(), tile(), index(), now + 300000)).toEqual([]);
        const value = raw();
        value.tiles = {};
        expect(decodeOpticalIndex(value, pointer(), now).sources).toHaveLength(3);
    });
    it('refuses world reads and permits only bounded actual dateline tiles', () => {
        expect(() => opticalViewportTiles([-180, -80, 180, 80])).toThrow(/Zoom in/);
        expect(opticalViewportTiles([179, 0, -179, 4])).toEqual(['0-18', '71-18']);
        expect(() => opticalViewportTiles([0, 0, 15, 15.1])).toThrow();
    });
    it('optical packet cannot be adopted as licensed network pulse or push authority', () => {
        expect(parseLicensedLightning(raw(), -70, 10, now)).toBeNull();
        for (const file of [
            'supabase/functions/licensed-lightning-watch/handler.ts',
            'supabase/functions/send-push/lightning-delivery.ts',
        ])
            expect(fs.readFileSync(file, 'utf8')).not.toMatch(/opticalLightning|optical-lightning\/v1/);
    });
});
