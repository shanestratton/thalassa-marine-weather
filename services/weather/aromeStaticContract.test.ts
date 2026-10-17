// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { aromeStaticFixture } from '../../tests/fixtures/aromeStatic142';
import {
    aromePointFromTile,
    aromeRunCurrent,
    aromeTileAt,
    aromeTileShape,
    parseAromeManifest,
    parseAromeSlot,
} from './aromeStaticContract';
import { AROME_DOMAINS } from './aromeDomains';
import { AROME_TEST_RUN as run } from '../../tests/fixtures/arome142';

describe('14206 immutable original-grid storage contract', () => {
    it('keeps every native f64 value, original clock and honest unknown field', async () => {
        const f = await aromeStaticFixture();
        expect(parseAromeSlot(f.slot, f.model, run)).toBe(f.slot);
        expect(parseAromeManifest(f.manifest, f.slot, run)).toBe(f.manifest);
        expect(aromeTileAt(f.manifest, f.point)).toBe(f.tile);
        const point = aromePointFromTile(f.raw, f.manifest, f.slot, f.tile, f.point, run)!;
        expect(point.seaCell).toMatchObject({ i: 400, j: 400, latitude: -20, longitude: 166, landFraction: 0 });
        expect(point.hourly.wind_speed_10m).toEqual(Array(49).fill(10));
        expect(point.hourly.wind_direction_10m).toEqual(Array(49).fill(90));
        expect(point.hourly.pressure_msl[0]).toBe(101234.567891 / 100);
        expect(point.hourly.temperature_2m[0]).toBe(290.123456789 - 273.15);
        expect(point.hourly.relative_humidity_2m[0]).toBe(72.3456789);
        expect(point.hourly.wind_gusts_10m).toEqual(Array(49).fill(null));
        expect(point.hourly.precipitation).toEqual(Array(49).fill(null));
        expect(point.hourly.time[48]).toBe(run / 1000 + 48 * 3600);
        expect(point.cohortSha256).toBe(f.slot.manifestSha256);
    });

    it('keeps missing and calm distinct; no farther cell borrowed for a missing nearest forecast', async () => {
        const f = await aromeStaticFixture({
            sample: (field, hour) => (field < 2 ? (hour === 0 ? 0 : Number.NaN) : Number.NaN),
        });
        const point = aromePointFromTile(f.raw, f.manifest, f.slot, f.tile, f.point, run)!;
        expect(point.hourly.wind_speed_10m).toEqual([0, ...Array(48).fill(null)]);
        expect(point.hourly.wind_direction_10m).toEqual(Array(49).fill(null));
        const missing = await aromeStaticFixture({
            mask: () => 0,
            sample: (_field, _hour, i, j) => (i === 400 && j === 400 ? Number.NaN : 1),
        });
        expect(
            aromePointFromTile(missing.raw, missing.manifest, missing.slot, missing.tile, missing.point, run),
        ).toBeNull();
    });

    it.each([1, 0.01, Number.NaN, Infinity, -0.01])('never admits land, unknown or invalid mask %s', async (mask) => {
        const f = await aromeStaticFixture({ mask: () => mask });
        expect(aromePointFromTile(f.raw, f.manifest, f.slot, f.tile, f.point, run)).toBeNull();
    });

    it('searches a bounded three-original-interval halo and refuses a distant sea cell', async () => {
        const near = await aromeStaticFixture({ mask: (i, j) => (i === 403 && j === 400 ? 0 : 1) });
        expect(aromePointFromTile(near.raw, near.manifest, near.slot, near.tile, near.point, run)?.seaCell.i).toBe(403);
        const far = await aromeStaticFixture({ mask: (i, j) => (i === 404 && j === 400 ? 0 : 1) });
        expect(aromePointFromTile(far.raw, far.manifest, far.slot, far.tile, far.point, run)).toBeNull();
    });

    it('has exact edge/halo geometry for all three original domains', () => {
        for (const d of AROME_DOMAINS) {
            expect(aromeTileShape(d.id, 0, 0)).toMatchObject({ i0: 0, j0: 0, width: 35, height: 35 });
            const x = Math.ceil(d.width / 32) - 1,
                y = Math.ceil(d.height / 32) - 1;
            const last = aromeTileShape(d.id, x, y)!;
            expect(last.i0 + last.width).toBe(d.width);
            expect(last.j0 + last.height).toBe(d.height);
            expect(aromeTileShape(d.id, x + 1, y)).toBeNull();
        }
    });

    it('refuses mismatched source/unit/grid/cohort/full-tile inventory and byte ceilings', async () => {
        const f = await aromeStaticFixture();
        for (const patch of [
            { provider: 'ECMWF' },
            { licence: '' },
            { width: 720 },
            { stepDegrees: 0.25 },
            { hours: 48 },
            { encoding: 'f32' },
            { units: ['kn', 'kn', 'Pa', 'K', '%'] },
            { maskSha256: '' },
            { nativeProofSha256: '' },
            { catalogueSha256: '' },
            { runUtc: '2026-10-16T00:00:00Z' },
            { packets: f.manifest.packets.slice(1) },
            { tiles: f.manifest.tiles.slice(1) },
            { tiles: [...f.manifest.tiles, f.tile] },
        ]) {
            expect(parseAromeManifest({ ...f.manifest, ...patch }, f.slot, run)).toBeNull();
        }
        for (const patch of [
            { bytes: 3 * 1024 * 1024 + 1 },
            { rawBytes: 3 * 1024 * 1024 + 1 },
            { id: '999-999' },
            { width: 37 },
        ]) {
            const manifest = structuredClone(f.manifest);
            Object.assign(manifest.tiles[0], patch);
            expect(parseAromeManifest(manifest, f.slot, run)).toBeNull();
        }
    });

    it('rejects expired/future/invalid dates and Polynesia unpublished six-hour cycles', () => {
        expect(aromeRunCurrent('2026-10-17T00:00:00Z', AROME_DOMAINS[0].id, run + 18 * 3600_000)).toBe(true);
        for (const now of [run - 1, run + 18 * 3600_000 + 1, NaN])
            expect(aromeRunCurrent('2026-10-17T00:00:00Z', AROME_DOMAINS[0].id, now)).toBe(false);
        expect(aromeRunCurrent('2026-02-30T00:00:00Z', AROME_DOMAINS[0].id, run)).toBe(false);
        expect(aromeRunCurrent('2026-10-17T06:00:00Z', AROME_DOMAINS[1].id, run + 6 * 3600_000)).toBe(false);
    });

    it('refuses truncated/extra data, bad header bindings and nonphysical selected values', async () => {
        const f = await aromeStaticFixture();
        for (const raw of [f.raw.slice(0, -1), new Uint8Array(f.raw.length + 1), new Uint8Array(f.raw.length)]) {
            expect(aromePointFromTile(raw, f.manifest, f.slot, f.tile, f.point, run)).toBeNull();
        }
        const wrong = { ...f.manifest, nativeProofSha256: '9'.repeat(64) };
        expect(aromePointFromTile(f.raw, wrong, f.slot, f.tile, f.point, run)).toBeNull();
        for (const value of [Infinity, -Infinity, 1000]) {
            const invalid = await aromeStaticFixture({ sample: () => value });
            expect(
                aromePointFromTile(invalid.raw, invalid.manifest, invalid.slot, invalid.tile, invalid.point, run),
            ).toBeNull();
        }
    });
});
