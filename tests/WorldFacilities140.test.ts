import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
    parseManifest,
    parseShard,
    cataloguePath,
    LICENCES,
    WORLD_FACILITY_COHORTS,
    type CatalogueManifest,
    type MarinePlace,
    type FacilityKind,
} from '../services/marineCatalogue/schema';
import {
    facilityDistanceNM,
    facilityDisplayLongitude,
    facilityPopupContent,
    facilityPopupLayout,
    selectWorldFacilities,
    WORLD_FACILITY_LIMIT,
    worldFacilitiesSummary,
    worldFacilitiesWarning,
} from '../services/marineCatalogue/worldFacilities';
const time = '2026-10-01T00:00:00Z';
function manifest(): CatalogueManifest {
    return {
        schema: 1,
        dataset: 'facilities-world',
        generation: 'world-fixture',
        builtAt: time,
        sourceAt: time,
        count: 4,
        coverage: 'Fictional eight-cohort extract only',
        licence: LICENCES['facilities-world'].url,
        sourceUrl: 'https://download.geofabrik.de/',
        cohorts: WORLD_FACILITY_COHORTS.map((id) => ({ id, sourceAt: time, sha256: 'a'.repeat(64) })),
        shards: ['areas/45_90'],
    };
}
function point(kind: FacilityKind = 'marina', id = 'osm-node1'): MarinePlace {
    return {
        id,
        kind,
        facilityKinds: [kind],
        name: 'Fictional facility',
        lat: 0.1,
        lon: 0.1,
        country: '',
        aliases: [],
        approximate: false,
    };
}
describe('14001 world facilities public contracts', () => {
    it('anchors the exact OSM point in its visible dateline world copy without changing its identity', () => {
        expect(facilityDisplayLongitude(-179.9, 179.9)).toBeCloseTo(180.1);
        expect(facilityDisplayLongitude(179.9, -179.9)).toBeCloseTo(-180.1);
        expect(facilityDisplayLongitude(0.1, 360.2)).toBeCloseTo(360.1);
        expect(facilityDisplayLongitude(0.1, 0.2)).toBe(0.1);
    });
    it('keeps the popup on the roomy side of markers at every edge without moving the marker arrow', () => {
        for (const width of [300, 375, 1024])
            for (const x of [8, width / 2, width - 8])
                for (const y of [8, 333, 659]) {
                    const layout = facilityPopupLayout({ x, y }, { width, height: 667 });
                    const left = layout.anchor.endsWith('right') ? x - layout.maxWidth : x;
                    expect(left).toBeGreaterThanOrEqual(0);
                    expect(left + layout.maxWidth).toBeLessThanOrEqual(width);
                    expect(layout.contentMaxHeight + 50).toBeLessThanOrEqual(667 / 2);
                }
    });
    it('matches the reviewed eight continent plan without broadening regional138 or other records', () => {
        const plan = JSON.parse(readFileSync('scripts/marine-catalogue/facilities-world.plan.json', 'utf8'));
        expect(plan.dataset).toBe('facilities-world');
        expect(plan.sources.map((s: { url: string }) => s.url.replace(/-latest\.osm\.pbf$/, '')).sort()).toEqual(
            [...WORLD_FACILITY_COHORTS].sort(),
        );
        const m = parseManifest(manifest(), 'facilities-world');
        for (const kind of ['marina', 'fuel', 'boat_ramp', 'pump_out'] as const) {
            const shard = {
                schema: 1,
                dataset: 'facilities-world',
                generation: m.generation,
                key: 'areas/45_90',
                records: [point(kind)],
            };
            expect(parseShard(shard, m, shard.key)).toHaveLength(1);
            if (kind === 'boat_ramp' || kind === 'pump_out')
                expect(() =>
                    parseShard({ ...shard, dataset: 'facilities' }, { ...m, dataset: 'facilities' }, shard.key),
                ).toThrow();
            expect(() => parseShard({ ...shard, dataset: 'osm' }, { ...m, dataset: 'osm' }, shard.key)).toThrow();
        }
        expect(cataloguePath('facilities-world/world-fixture/areas/45_90.json')).toBe(true);
        expect(cataloguePath('facilities-world/../../charts.json')).toBe(false);
    });
    it('refuses omitted/duplicate/invented cohorts, reset source clocks and unexpected private payloads', () => {
        const m = manifest();
        expect(() => parseManifest({ ...m, cohorts: m.cohorts!.slice(1) }, 'facilities-world')).toThrow();
        expect(() =>
            parseManifest(
                { ...m, cohorts: m.cohorts!.map((c) => ({ ...c, id: m.cohorts![0].id })) },
                'facilities-world',
            ),
        ).toThrow();
        expect(() =>
            parseManifest(
                { ...m, cohorts: m.cohorts!.map((c) => ({ ...c, id: c.id.replace('africa', 'invented') })) },
                'facilities-world',
            ),
        ).toThrow();
        expect(() => parseManifest({ ...m, sourceAt: '2026-10-02T00:00:00Z' }, 'facilities-world')).toThrow();
        expect(() =>
            parseShard(
                {
                    schema: 1,
                    dataset: m.dataset,
                    generation: m.generation,
                    key: m.shards[0],
                    records: [{ ...point(), ownerId: 'private' }],
                },
                m,
                m.shards[0],
            ),
        ).toThrow();
    });
    it('bounds nearest display at2000/50NM, keeps exact object identities and never fuzzy merges neighbors', () => {
        const m = manifest(),
            points = Array.from({ length: WORLD_FACILITY_LIMIT + 2 }, (_, i) => point('fuel', `osm-node${i + 1}`));
        const selected = selectWorldFacilities(
            {
                records: [...points, { ...point('marina', 'osm-way99'), lat: 3 }],
                manifests: [m],
                partial: false,
                cachedOnly: false,
            },
            { lat: 0, lon: 0 },
        );
        expect(selected.records).toHaveLength(WORLD_FACILITY_LIMIT);
        expect(selected.status.partial).toBe(true);
        expect(selected.records.some((p) => p.id === 'osm-way99')).toBe(false);
        const a = point(),
            b = { ...a, id: 'osm-node2', lon: a.lon + 0.000001 };
        expect(
            selectWorldFacilities({ records: [a, b], manifests: [m], partial: false, cachedOnly: false }, a).records,
        ).toHaveLength(2);
        expect(facilityDistanceNM({ lat: 0, lon: 179.9 }, { lat: 0, lon: -179.9 })).toBeLessThan(13);
    });
    it('keeps unpublished, partial, saved, empty and old sources truthful', () => {
        const missing = selectWorldFacilities(
            { records: [], manifests: [], partial: true, cachedOnly: false },
            { lat: 0, lon: 0 },
        );
        expect(missing.status.state).toBe('unavailable');
        expect(worldFacilitiesSummary(missing.status)).toContain('may not be published');
        const ready = selectWorldFacilities(
            { records: [], manifests: [manifest()], partial: true, cachedOnly: true },
            { lat: 0, lon: 0 },
        ).status;
        const text = worldFacilitiesSummary(ready, Date.parse('2026-12-01'));
        expect(text).toContain('absence does not establish');
        expect(text).toContain('Saved data');
        expect(text).toContain('Partial area');
        expect(text).toContain('older than');
        expect(worldFacilitiesWarning(ready, Date.parse('2026-12-01'))).toBe(true);
    });
    it('builds safe original-object popups with explicit unknowns and no routing or permission verdict', () => {
        const p = {
            ...point('pump_out', 'osm-way99'),
            approximate: true,
            name: '<img src=x onerror=bad()>',
            access: '<script>bad()</script>',
            facilityKinds: ['marina', 'fuel', 'boat_ramp', 'pump_out'] as FacilityKind[],
        };
        const status = selectWorldFacilities(
            { records: [p], manifests: [manifest()], partial: false, cachedOnly: false },
            p,
        ).status;
        const dom = facilityPopupContent(p, status);
        expect(dom.querySelector('img,script')).toBeNull();
        expect(dom.textContent).toContain(p.name);
        expect(dom.textContent).toContain('Marina · Fuel dock · Boat ramp · Pump-out');
        expect(dom.textContent).toContain('Community data, may be incomplete');
        expect(dom.textContent).toContain('Representative area centre');
        expect(dom.textContent).toContain('approach depth are unverified');
        expect(dom.querySelector('a')?.href).toBe('https://www.openstreetmap.org/way/99');
        expect(dom.querySelector('a')?.style.minHeight).toBe('44px');
    });
    it('offers the supplied review action only for an explicitly mapped marina, including a combined facility', () => {
        const review = vi.fn(),
            status = { state: 'ready' as const, count: 1, partial: false, cachedOnly: false };
        expect(facilityPopupContent(point('fuel'), status, review).querySelector('button')).toBeNull();
        const combined = { ...point('fuel'), facilityKinds: ['fuel', 'marina'] as FacilityKind[] };
        const dom = facilityPopupContent(combined, status, review),
            button = dom.querySelector('button')!;
        expect(button.textContent).toBe('Skipper notes');
        expect(button.style.minHeight).toBe('44px');
        button.click();
        expect(review).toHaveBeenCalledOnce();
    });
});
