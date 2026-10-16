import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
    cataloguePath,
    parseManifest,
    parseShard,
    validMarinePlace,
    type MarinePlace,
} from '../services/marineCatalogue/schema';

describe('separate facilities catalogue compatibility', () => {
    it('accepts the real local Python builder output through the app parser, with cumulative source clocks', () => {
        const run = spawnSync(
            process.platform === 'win32' ? 'python' : 'python3',
            ['scripts/marine-catalogue/test_facilities.py', '--emit-fixture'],
            { encoding: 'utf8', timeout: 30000, maxBuffer: 65536 },
        );
        expect(run.status, run.stderr).toBe(0);
        const actual = JSON.parse(run.stdout);
        const manifest = parseManifest(actual.manifest, 'facilities');
        const rows: MarinePlace[] = actual.shards.flatMap((part: { key: string }) =>
            parseShard(part, manifest, part.key),
        );
        expect(rows).toHaveLength(2);
        expect(rows.find((p) => p.id === 'osm-node1')?.facilityKinds).toEqual(['marina', 'fuel']);
        expect(manifest.cohorts).toHaveLength(2);
        expect(manifest.sourceAt).toBe(manifest.cohorts![0].sourceAt);
        expect(rows.every((p) => validMarinePlace(p, 'osm'))).toBe(false);
        expect(() => parseManifest(actual.manifest, 'osm')).toThrow();
        expect(JSON.stringify(rows)).not.toContain('must-not-copy');
        const invalid = structuredClone(actual.manifest);
        invalid.cohorts[0].sourceAt = '2026-02-31T00:00:00Z';
        expect(() => parseManifest(invalid, 'facilities')).toThrow();
    });
    it('keeps exact namespace paths and refuses unversioned unknown facility roles', () => {
        expect(cataloguePath('facilities/manifest.json')).toBe(true);
        expect(cataloguePath('facilities/../osm/manifest.json')).toBe(false);
        const point: MarinePlace = {
            id: 'osm-node1',
            name: 'Fictional marine fuel',
            kind: 'fuel',
            facilityKinds: ['fuel'],
            lat: 0,
            lon: 0,
            country: '',
            aliases: [],
            approximate: false,
        };
        expect(validMarinePlace(point, 'facilities')).toBe(true);
        expect(validMarinePlace({ ...point, facilityKinds: undefined }, 'facilities')).toBe(false);
        expect(validMarinePlace({ ...point, facilityKinds: ['fuel', 'fuel'] }, 'facilities')).toBe(false);
        expect(validMarinePlace({ ...point, kind: 'anchorage' }, 'facilities')).toBe(false);
        expect(validMarinePlace(point, 'places')).toBe(false);
    });
});
